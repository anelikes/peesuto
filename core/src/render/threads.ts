/**
 * How many threads draw a GIF's or a video's frames (frames.ts).
 *
 * Rasterising is single-threaded per wasm world and nearly all of a lyric
 * video's cost, so frames are drawn by worker threads, each with a world of
 * its own. Measured on a Mac mini M4 (4 performance + 6 efficiency cores,
 * 32 GB), a 24 s Stage video: 4 threads 6.5 s, 6 threads 5.8 s, 8 threads
 * 5.8 s. So the CPU share is one and a half threads per performance core (the
 * efficiency cores add a little; the encoder and this thread need some), and
 * the count is capped where the gain stopped.
 *
 * Each thread holds its own world and its frames in flight. Measured with
 * pocket-motion v0.5.0 (which hands the pak to the sandbox as a latin1
 * string), a whole render's peak is about 0.2–0.4 GB plus 0.39–0.52 GB a
 * thread (the most for 9:16); v0.4.0 took 1.3–1.5 GB a thread. Budgeted at
 * 0.6 GB a thread, rendering may take a quarter of physical memory, so an
 * 8 GB Mac gets 3 threads and keeps 6 GB for everything else.
 *
 * PEESUTO_RENDER_THREADS sets the count (1 draws in the calling thread, the
 * serial path). Background work (precompose) draws in one thread.
 */
import { availableParallelism, totalmem } from "node:os";

export interface RenderHost {
  /** Performance cores (`sysctl hw.perflevel0.physicalcpu`), when the machine reports them. */
  readonly performanceCores?: number;
  /** Logical CPUs (`os.availableParallelism()`). */
  readonly logicalCores: number;
  /** Physical memory in bytes (`os.totalmem()`). */
  readonly memoryBytes: number;
}

export const RENDER_THREADS = {
  /** Where the measured gain stopped. */
  max: 6,
  /** Threads per performance core. */
  perPerformanceCore: 1.5,
  /** Without a performance-core count: logical CPUs less this many (the encoder, this thread). */
  reservedCores: 2,
  /** Memory budgeted per thread (measured 0.39–0.52 GB with pocket-motion v0.5.0). */
  bytesPerThread: 0.6 * 2 ** 30,
  /** The share of physical memory rendering may take. */
  memoryShare: 0.25,
  /** An explicit PEESUTO_RENDER_THREADS is capped here (a typo must not start a thousand threads). */
  ceiling: 32,
  /** JIZURA's frame threads (core/src/jizura): each holds Skia canvases, an engine realm per chunk and a chunk of frames.
   * Measured 0.35 GB a thread at 1:1 and 16:9 MP4 (peak 0.61 GB with one thread, 2.33–2.38 GB with six). */
  jizura: { max: 6, bytesPerThread: 0.5 * 2 ** 30 },
} as const;

/** What the threads draw: Pocket Motion frames (the default) or a JIZURA film, which has its own memory budget. */
export type RenderKind = "engine" | "jizura";

/** Threads for one render on `host`. Pure: env and host are arguments. */
export function renderThreads(host: RenderHost, env: Record<string, string | undefined> = process.env, o: { readonly lowPriority?: boolean; readonly kind?: RenderKind } = {}): number {
  const set = env.PEESUTO_RENDER_THREADS?.trim();
  if (set) {
    const n = Number(set);
    if (Number.isInteger(n) && n >= 1) return Math.min(n, RENDER_THREADS.ceiling);
  }
  if (o.lowPriority) return 1;
  const T = RENDER_THREADS;
  const cpu = host.performanceCores !== undefined && host.performanceCores > 0
    ? Math.round(host.performanceCores * T.perPerformanceCore)
    : host.logicalCores - T.reservedCores;
  const perThread = o.kind === "jizura" ? T.jizura.bytesPerThread : T.bytesPerThread;
  const memory = Math.floor((host.memoryBytes * T.memoryShare) / perThread);
  return Math.max(1, Math.min(o.kind === "jizura" ? T.jizura.max : T.max, cpu, memory));
}

let host: RenderHost | undefined;
/** This machine, read once per process. */
export function renderHost(): RenderHost {
  if (host) return host;
  let performanceCores: number | undefined;
  if (process.platform === "darwin") {
    try {
      const out = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "hw.perflevel0.physicalcpu"], { stdout: "pipe", stderr: "ignore" });
      const n = Number(out.stdout.toString().trim());
      if (out.exitCode === 0 && Number.isInteger(n) && n > 0) performanceCores = n;
    } catch { /* no sysctl: fall back to the logical count */ }
  }
  host = { ...(performanceCores ? { performanceCores } : {}), logicalCores: availableParallelism(), memoryBytes: totalmem() };
  return host;
}

/** Threads for a render on this machine (PEESUTO_RENDER_THREADS, else the policy above). */
export const defaultRenderThreads = (o: { readonly lowPriority?: boolean; readonly kind?: RenderKind } = {}): number => renderThreads(renderHost(), process.env, o);
