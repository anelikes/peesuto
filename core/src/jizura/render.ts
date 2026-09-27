/**
 * Drawing a JIZURA film's frames, in chunks that do not depend on each other.
 *
 * JIZURA draws a frame from (plan, t), but a few of its caches carry state
 * from one frame to the next: the last real lyric box per cut that decor
 * falls back on while the text is hidden or leaving, the paper texture made
 * on first use (and the order glyphs were first cut into pieces, which
 * realm.ts makes irrelevant). Drawn in order in one thread that is simply the
 * film; drawn by several threads, each starting somewhere in the middle, it
 * would differ in the odd frame. So the film is cut into fixed chunks (their
 * bounds depend on the film and the frame size, never on the thread count),
 * and every chunk is drawn the same way wherever it is drawn:
 *
 *   a fresh engine instance (realm.ts: Math.random seeded the same), the plan
 *   made again, then REPLAY: the frames of the half second before the chunk
 *   drawn with an empty clip (the engine runs everything, Skia paints
 *   nothing: about a tenth of a frame's cost), so the caches hold what they
 *   would hold there in one long run; then the chunk's frames.
 *
 * A chunk's pixels are therefore a function of the job alone, and any number
 * of threads gives the same film, frame for frame (core/tests/jizura.test.ts
 * hashes it). They are also, all but exactly, the frames of one uninterrupted
 * run: of eight 1080 px films (5,675 frames, 571 chunk starts), five were
 * identical and three differed in a few frames by specks along an edge (at
 * most 70 pixels over 8 levels; most likely JIZURA's reused offscreen layers,
 * whose unused margins keep earlier drawings that a blur or a filtered copy
 * reads); of six GIFs (1,296 frames), one frame differed, by at most 5 of 255.
 *
 * Frames are drawn straight at the output size (a GIF at its own width, not
 * downscaled), at 30 frames a second; a GIF takes every other one.
 */
import type { JizuraFontFile } from "../fonts/jizura-packs.ts";
import type { Drawer } from "../render/prepared.ts";
import { loadCanvas, type CanvasContext2D, type CanvasElement, type CanvasModule } from "./canvas.ts";
import { registerFonts } from "./fonts.ts";
import { shimGrain } from "./grain.ts";
import { createRealm, type JizuraPlan, type JizuraProject, type JizuraRenderer } from "./realm.ts";

export interface JizuraChunk {
  /** Composition frames drawn and delivered, increasing. */
  readonly frames: readonly number[];
  /** Frames replayed first (drawn with nothing painted), increasing, all before `frames`. */
  readonly replay: readonly number[];
}

/** Everything a thread needs to draw a JIZURA film's frames: plain data. */
export interface JizuraJob {
  readonly kind: "jizura";
  readonly bundlePath: string;
  readonly project: JizuraProject;
  readonly width: number;
  readonly height: number;
  /** Composition rate (30); frame f is at t = f / fps. */
  readonly fps: number;
  readonly durationFrames: number;
  /** Every `step`-th frame is delivered (a GIF: 2). */
  readonly step: number;
  readonly chunks: readonly JizuraChunk[];
  readonly fonts: readonly JizuraFontFile[];
  /** Math.random's seed in every realm. */
  readonly randomSeed: number;
  /** J.glyphs.maxRes, as JIZURA's own exporter sets it for the output height. */
  readonly maxRes: number;
  /** The grain and scanlines as pre-tiled images (grain.ts) instead of Skia's slow pattern fill. */
  readonly grainShim: boolean;
  /** Leave JIZURA's film grain out (a GIF, grain.ts). */
  readonly noGrain?: boolean;
}

/** Bytes of frames a chunk may hold (the frames in flight are about a chunk per thread): 14 frames at 1080², 8 at 1920×1080, 30 of a GIF. */
export const CHUNK_BYTES = 64 * 2 ** 20;
/** Chunk length bounds, in delivered frames. */
export const CHUNK_FRAMES = { min: 6, max: 30 } as const;
/**
 * How much of the film before a chunk is replayed: enough for a cut's exit
 * to find the lyric box it had at rest. Over eight 1080 px films (571 chunk
 * starts) half a second and a whole one gave the same frames.
 */
export const REPLAY_SECONDS = 0.5;

/** The fixed chunks of a film: the delivered frames cut by size, each with the frames of the second before it to replay. */
export function jizuraChunks(o: { readonly durationFrames: number; readonly step: number; readonly fps: number; readonly width: number; readonly height: number; readonly size?: number }): JizuraChunk[] {
  const list: number[] = [];
  for (let f = 0; f < o.durationFrames; f += o.step) list.push(f);
  const size = o.size ?? Math.max(CHUNK_FRAMES.min, Math.min(CHUNK_FRAMES.max, Math.floor(CHUNK_BYTES / (o.width * o.height * 4))));
  const back = Math.round(REPLAY_SECONDS * o.fps);
  const out: JizuraChunk[] = [];
  for (let i = 0; i < list.length; i += size) {
    const frames = list.slice(i, i + size);
    const replay = list.filter((f) => f < frames[0]! && f >= frames[0]! - back);
    out.push({ frames, replay });
  }
  return out;
}

export interface JizuraFrameStats { realms: number; replayed: number; drawn: number; worstMs: number; worstFrame: number; warnings: number }

interface ChunkState {
  readonly chunk: number;
  readonly renderer: JizuraRenderer;
  readonly plan: JizuraPlan;
  readonly canvas: CanvasElement;
  readonly ctx: CanvasContext2D;
  /** Index in the chunk's frames of the next frame to draw. */
  next: number;
  readonly warnings: () => number;
  /** Frees the chunk's canvases (its realm's and its own). */
  readonly release: () => void;
}

/** Draws a job's frames chunk by chunk, in the calling thread (a worker, or Core's own thread). */
export class JizuraDrawer implements Drawer {
  readonly stats: JizuraFrameStats = { realms: 0, replayed: 0, drawn: 0, worstMs: 0, worstFrame: -1, warnings: 0 };
  #state: ChunkState | undefined;
  readonly #chunkOf = new Map<number, number>();

  private constructor(private readonly canvas: CanvasModule, private readonly job: JizuraJob) {
    job.chunks.forEach((c, i) => { for (const f of c.frames) this.#chunkOf.set(f, i); });
  }

  static async open(job: JizuraJob): Promise<JizuraDrawer> {
    const canvas = await loadCanvas();
    const { failed } = registerFonts(canvas, job.fonts);
    if (failed.length) throw new Error(`jizura: fonts did not register: ${failed.join(", ")}`);
    return new JizuraDrawer(canvas, job);
  }

  /** A fresh realm for chunk `i`, replayed up to its frame at index `at` (the chunk's own earlier frames too, when drawing resumes inside it). */
  #begin(i: number, at: number): ChunkState {
    const job = this.job;
    const realm = createRealm(this.canvas, job.bundlePath, job.randomSeed);
    const { J } = realm;
    J.glyphs.maxRes = job.maxRes;
    const plan = J.plan(JSON.parse(JSON.stringify(job.project)) as JizuraProject, null);
    const renderer = new J.Renderer();
    const canvas = this.canvas.createCanvas(job.width, job.height);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (job.grainShim || job.noGrain) {
      const r = renderer as unknown as { grain?: unknown[]; scan?: unknown };
      shimGrain(this.canvas, ctx, [...(r.grain ?? []), ...(r.scan ? [r.scan] : [])], { sheets: job.grainShim, ...(job.noGrain ? { skip: r.grain ?? [] } : {}) });
    }
    const scale = job.width / plan.W;
    const chunk = job.chunks[i]!;
    for (const f of [...chunk.replay, ...chunk.frames.slice(0, at)]) {
      // Everything runs, nothing is painted: an empty clip around the whole frame.
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, 0, 0); ctx.clip();
      renderer.frame(ctx, plan, f / job.fps, { scale });
      ctx.restore();
      this.stats.replayed++;
    }
    this.stats.realms++;
    return { chunk: i, renderer, plan, canvas, ctx, next: at, warnings: () => realm.warnings.length,
      release: () => { realm.dispose(); canvas.width = 1; canvas.height = 1; } };
  }

  /** Frame `frame`'s RGBA (never held: JIZURA frames are drawn whole). Frames come in increasing order. */
  async draw(frame: number): Promise<Uint8Array> {
    const i = this.#chunkOf.get(frame);
    if (i === undefined) throw new Error(`jizura: frame ${frame} is in no chunk`);
    const chunk = this.job.chunks[i]!;
    let s = this.#state;
    if (!s || s.chunk !== i || chunk.frames[s.next] !== frame) {
      // A new chunk, or drawing resumes inside one (the workers gave up): the same state either way.
      if (s) { this.stats.warnings += s.warnings(); s.release(); }
      s = this.#state = this.#begin(i, chunk.frames.indexOf(frame));
    }
    const t0 = performance.now();
    s.renderer.frame(s.ctx, s.plan, frame / this.job.fps, { scale: this.job.width / s.plan.W });
    const rgba = s.canvas.data();
    const ms = performance.now() - t0;
    if (ms > this.stats.worstMs) { this.stats.worstMs = ms; this.stats.worstFrame = frame; }
    this.stats.drawn++;
    s.next++;
    return rgba;
  }

  async dispose(): Promise<void> {
    if (this.#state) { this.stats.warnings += this.#state.warnings(); this.#state.release(); }
    this.#state = undefined;
  }
}
