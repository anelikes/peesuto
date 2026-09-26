/**
 * A prepared composition's frames, drawn and delivered in order: the frame
 * stream both the GIF encoder (gif.ts) and the native MP4 path (video.ts)
 * consume.
 *
 * Rasterising is single-threaded per wasm world and nearly all of the cost,
 * while stepping the animation without drawing is about 0.03 ms a frame. So
 * with more than one thread (threads.ts), worker threads (frame-worker.ts)
 * each boot their own world over the same built bundle, and the frames are
 * cut into chunks of FRAME_CHUNK handed out round-robin: a worker draws its
 * chunks and folds through everyone else's. The consumer takes frames
 * strictly in order; at most AHEAD_PER_THREAD chunks per thread are out past
 * the one it is waiting for, which bounds the frames held here to about that
 * many chunks. Every world runs the same deterministic core, so the pixels
 * are the one-thread path's exactly (core/tests/frames.test.ts hashes them).
 * Nothing is written anywhere: workers only read the bundle and the pak.
 *
 * Held frames (prepared.ts, FrameDrawer): a frame whose draw list equals the
 * frame shown before it is not rasterised; the stream repeats the previous
 * pixels. PEESUTO_FRAME_REUSE=0 turns that off.
 *
 * With one thread, or when the workers cannot start (the worker module or
 * the engine fails to load in a thread, a world fails to boot), frames are
 * drawn in this thread, from wherever the stream had got to.
 *
 * Stopping: leaving the loop (break, return, an exception), aborting the
 * signal or passing the deadline terminates every worker. A worker yields a
 * macrotask turn after each frame, which is where terminate() takes effect,
 * so a busy one stops within a frame.
 */
import { EngineAbortedError, EngineError, EngineTimeoutError, throwIfAborted } from "../engine.ts";
import { FrameDrawer, frameComposition, type DrawOptions, type Drawer, type FrameComposition, type ResolvedComposition } from "./prepared.ts";

/** Frames a worker draws per chunk. */
export const FRAME_CHUNK = 6;
/** Chunks out past the one being delivered, per thread. */
const AHEAD_PER_THREAD = 2;

export interface FramesOptions {
  readonly engine: string;
  readonly composition: ResolvedComposition;
  /** Draw every `step`-th frame of the composition (a GIF at half its rate: 2). Default 1. */
  readonly step?: number;
  /** Box-downscale every frame to this width (GIF). Absent: the composition's size. */
  readonly width?: number;
  /** Threads drawing (threads.ts); 1 draws in this thread. */
  readonly threads: number;
  /** Repeat held frames instead of drawing them (default: on unless PEESUTO_FRAME_REUSE=0). */
  readonly reuse?: boolean;
  readonly signal?: AbortSignal;
  /** performance.now() deadline. */
  readonly deadline?: number;
  /** Names the output in errors: "gif", "MP4". */
  readonly label: string;
  /** Filled in as the stream runs. */
  readonly stats?: FrameStats;
  /** Substitutes for tests: the worker module (a URL), and how this thread opens its drawer. */
  readonly worker?: string;
  readonly openDrawer?: (engine: string, c: FrameComposition, o: DrawOptions) => Promise<Drawer>;
}

export interface Frame {
  /** The composition frame. */
  readonly index: number;
  /** RGBA; a held frame repeats the previous frame's buffer. Owned by the consumer from here on (never written to again). */
  readonly rgba: Uint8Array;
  readonly held: boolean;
}

export interface FrameStats {
  /** Threads that drew (1: this thread). */
  threads: number;
  drawn: number;
  held: number;
  /** Why the workers were given up for this thread, when they were. */
  fallback?: string;
}

/* ---- the worker protocol (frame-worker.ts) --------------------------------- */
export type WorkerRequest =
  | { readonly type: "init"; readonly engine: string; readonly composition: FrameComposition; readonly width?: number; readonly reuse: boolean }
  /** Draw `frames` (increasing); `before` is the frame shown before the first (-1: none). */
  | { readonly type: "chunk"; readonly frames: readonly number[]; readonly before: number };
export type WorkerReply =
  | { readonly type: "ready" }
  /** No `rgba`: held, the same picture as the frame before it. */
  | { readonly type: "frame"; readonly index: number; readonly rgba?: ArrayBuffer }
  | { readonly type: "error"; readonly phase: "init" | "render"; readonly message: string };

const WORKER_URL = new URL("./frame-worker.ts", import.meta.url).href;

/** Workers alive in this process (tests: none may outlive a render). */
const live = new Set<Worker>();
export const liveFrameWorkers = (): number => live.size;

/** The workers could not start; the stream draws in this thread instead. */
class WorkersDidNotStart extends Error {}

const timedOut = (label: string) => new EngineTimeoutError(`${label} encoding timed out and was stopped. Try a shorter text, PNG, or set PASTE_RENDER_TIMEOUT_MS.`);
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The frames of `o.composition`, in order. Start is lazy: nothing boots until the first `next()`. */
export async function* renderFrames(o: FramesOptions): AsyncGenerator<Frame, void, undefined> {
  const c = frameComposition(o.composition);
  const step = Math.max(1, Math.floor(o.step ?? 1));
  const list: number[] = [];
  for (let f = 0; f < c.durationFrames; f += step) list.push(f);
  const reuse = o.reuse ?? process.env.PEESUTO_FRAME_REUSE !== "0";
  const stats: FrameStats = o.stats ?? { threads: 1, drawn: 0, held: 0 };
  stats.threads = 1;
  let next = 0; // index into `list` of the next frame to deliver
  let shown: Uint8Array | undefined;
  const deliver = (rgba: Uint8Array | null): Frame => {
    if (rgba) { shown = rgba; stats.drawn++; }
    else if (!shown) throw new EngineError(`${o.label}: frame ${list[next]} repeats a frame that was never drawn`);
    else stats.held++;
    return { index: list[next]!, rgba: shown, held: !rgba };
  };

  const chunks: number[][] = [];
  for (let i = 0; i < list.length; i += FRAME_CHUNK) chunks.push(list.slice(i, i + FRAME_CHUNK));
  // Two chunks a thread at least: fewer, and the boots cost more than they save.
  const threads = Math.max(1, Math.min(Math.floor(o.threads), Math.floor(chunks.length / 2)));
  if (threads > 1) {
    let crew: FrameCrew | undefined;
    try {
      crew = new FrameCrew(o, c, reuse, chunks, threads);
      stats.threads = threads;
      const ahead = AHEAD_PER_THREAD * threads;
      crew.dispatch(ahead);
      for (let ci = 0; ci < chunks.length; ci++) {
        for (const frame of chunks[ci]!) {
          const got = await crew.take(frame);
          yield deliver(got === "held" ? null : new Uint8Array(got));
          next++;
        }
        crew.dispatch(ci + 1 + ahead);
      }
      return;
    } catch (e) {
      if (!(e instanceof WorkersDidNotStart)) throw e;
      stats.threads = 1;
      stats.fallback = e.message;
      console.error(`frames: ${e.message}; drawing in one thread`);
    } finally {
      crew?.stop();
    }
  }

  throwIfAborted(o.signal);
  const drawer = await (o.openDrawer ?? FrameDrawer.open)(o.engine, c, { width: o.width, reuse });
  try {
    for (; next < list.length; next++) {
      throwIfAborted(o.signal);
      if (o.deadline !== undefined && performance.now() > o.deadline) throw timedOut(o.label);
      yield deliver(await drawer.draw(list[next]!, next > 0 ? list[next - 1]! : -1));
      // A turn of the event loop between frames drawn in this thread: the daemon keeps answering, an abort can land.
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    await drawer.dispose();
  }
}

/** The worker threads of one stream, and the frames they have sent that were not taken yet. */
class FrameCrew {
  readonly #workers: Worker[] = [];
  readonly #ready: boolean[] = [];
  readonly #frames = new Map<number, ArrayBuffer | "held">();
  #sent = 0;
  #failure: Error | undefined;
  #startFailure: string | undefined;
  #stopped = false;
  #wake: (() => void) | undefined;
  readonly #onAbort = () => { this.stop(); this.#notify(); };

  constructor(private readonly o: FramesOptions, composition: FrameComposition, reuse: boolean, private readonly chunks: readonly (readonly number[])[], threads: number) {
    o.signal?.addEventListener("abort", this.#onAbort, { once: true });
    const init: WorkerRequest = { type: "init", engine: o.engine, composition, ...(o.width !== undefined ? { width: o.width } : {}), reuse };
    try {
      for (let k = 0; k < threads; k++) {
        const worker = new Worker(o.worker ?? WORKER_URL);
        live.add(worker);
        worker.addEventListener("close", () => {
          live.delete(worker);
          // Only stop() terminates a worker; one that ends by itself took its frames with it.
          this.#fail(k, "the thread ended");
        });
        this.#workers.push(worker);
        this.#ready.push(false);
        worker.onmessage = (event: MessageEvent<WorkerReply>) => this.#receive(k, event.data);
        worker.onerror = (event: ErrorEvent) => {
          event.preventDefault();
          this.#fail(k, event.message || "a frame worker failed");
        };
        worker.postMessage(init);
      }
    } catch (e) {
      this.stop();
      throw new WorkersDidNotStart(`frame workers could not start: ${messageOf(e)}`);
    }
  }

  #receive(k: number, m: WorkerReply): void {
    if (this.#stopped) return;
    if (m.type === "ready") { this.#ready[k] = true; return; }
    if (m.type === "frame") this.#frames.set(m.index, m.rgba ?? "held");
    else if (m.phase === "init") this.#startFailure ??= `frame worker ${k + 1} could not start: ${m.message}`;
    else this.#failure ??= new EngineError(`${this.o.label}: ${m.message}`);
    this.#notify();
  }

  #fail(k: number, message: string): void {
    if (this.#stopped) return;
    if (!this.#ready[k]) this.#startFailure ??= `frame worker ${k + 1} could not start: ${message}`;
    else this.#failure ??= new EngineError(`${this.o.label}: a frame worker failed: ${message}`);
    this.#notify();
  }

  #notify(): void { const wake = this.#wake; this.#wake = undefined; wake?.(); }

  /** Hand out every chunk up to index `upTo`, round-robin. */
  dispatch(upTo: number): void {
    for (; this.#sent < this.chunks.length && this.#sent <= upTo; this.#sent++) {
      const i = this.#sent;
      const request: WorkerRequest = { type: "chunk", frames: this.chunks[i]!, before: i === 0 ? -1 : this.chunks[i - 1]!.at(-1)! };
      this.#workers[i % this.#workers.length]!.postMessage(request);
    }
  }

  /** Frame `frame`'s pixels (or "held"), once a worker has sent them. */
  async take(frame: number): Promise<ArrayBuffer | "held"> {
    for (;;) {
      throwIfAborted(this.o.signal);
      if (this.#stopped) throw new EngineAbortedError();
      if (this.#startFailure !== undefined) throw new WorkersDidNotStart(this.#startFailure);
      if (this.#failure) throw this.#failure;
      const got = this.#frames.get(frame);
      if (got !== undefined) { this.#frames.delete(frame); return got; }
      if (this.o.deadline !== undefined && performance.now() > this.o.deadline) throw timedOut(this.o.label);
      await new Promise<void>((resolve) => {
        const timer = this.o.deadline !== undefined ? setTimeout(resolve, Math.max(0, this.o.deadline - performance.now()) + 1) : undefined;
        this.#wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  }

  /** Terminate every worker (idempotent). A worker mid-frame stops at the end of that frame. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.o.signal?.removeEventListener("abort", this.#onAbort);
    for (const worker of this.#workers) worker.terminate();
    this.#frames.clear();
  }
}
