/**
 * GIF encoding, in process: the prepared composition's frames (frames.ts:
 * drawn by the engine's frame source, box-downscaled, on several threads when
 * the machine has them) → one 128-colour palette → gifenc. ffmpeg is not
 * involved.
 *
 * Why in-process rather than a subprocess streaming raw RGBA: every helper
 * the frame path needs is an ordinary engine module — `src/cli/resolve.ts`
 * and `src/runtime/frame-source.ts` (prepared.ts); only the argv wrapper
 * lives in `src/cli/commands/`. And compose.ts already boots a wasm world in
 * this process for measurement (`src/text/measure.ts`), so booting more is
 * the same kind of thing the process does already. A subprocess would add a
 * byte protocol over a pipe and a second Bun start-up for nothing.
 *
 * Output policy mirrors the ffmpeg pass this replaces: 15 fps (every other
 * frame of the 30 fps composition), 540 px wide with an area-average (box)
 * filter, one 128-colour palette computed over a sample of the kept frames so
 * the colours cannot flicker between frames, no transparency, loops forever.
 * The alpha channel is dropped: cards are opaque, and the mp4 route dropped
 * it too. Frames after the first carry only the pixels that changed — the
 * rest are a reserved palette index the frame flags transparent over the
 * previous frame (dispose 1), which is what ffmpeg's GIF muxer does by
 * default (transdiff); the composite stays fully opaque and a static
 * background costs almost nothing per frame.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { applyPalette, GIFEncoder, quantize } from "gifenc";
import { EngineError, EngineTimeoutError, throwIfAborted } from "../engine.ts";
import { renderFrames, type FrameStats } from "./frames.ts";
import { frameSize, resolvePrepared } from "./prepared.ts";
import { defaultRenderThreads } from "./threads.ts";

export const GIF_DEFAULTS = { fps: 15, width: 540, colors: 128, sampleEvery: 4 } as const;

export interface CardGifOptions {
  readonly engine: string;
  readonly work: string;
  readonly out: string;
  /** Target frame rate. Realised as the composition's rate over an integer step (30 → 15 by default). */
  readonly fps?: number;
  /** Output width in px; the height keeps the aspect. */
  readonly width?: number;
  /** Palette size, at most 256 (default 128). */
  readonly colors?: number;
  /** Inter-frame deltas (default true); false writes every frame whole. */
  readonly delta?: boolean;
  /** performance.now() deadline, checked between frames (rendering is in-process). */
  readonly deadline?: number;
  /** Checked between frames: aborting stops the encoder (and its frame threads) with EngineAbortedError. */
  readonly signal?: AbortSignal;
  /** Threads drawing frames (threads.ts); default: this machine's, one for background work. */
  readonly threads?: number;
  /** Background work: one frame thread. */
  readonly lowPriority?: boolean;
}

export interface CardGifResult {
  /** Frames written to the GIF. */
  readonly frames: number;
  readonly bytes: number;
  /** How the frames were drawn: threads, and frames drawn vs held. */
  readonly draw: FrameStats;
}

/** The prepared composition at `<work>/compositions/paste` → an animated GIF at `out`. */
export async function encodeCardGif(o: CardGifOptions): Promise<CardGifResult> {
  const fps = o.fps ?? GIF_DEFAULTS.fps;
  const width = o.width ?? GIF_DEFAULTS.width;
  const frames: Uint8Array[] = [];
  const draw: FrameStats = { threads: 1, drawn: 0, held: 0 };
  let size = { width: 0, height: 0 };
  let step = 1;
  let compositionFps = 30;
  try {
    const c = await resolvePrepared(o.engine, o.work, "gif");
    compositionFps = c.fps;
    step = Math.max(1, Math.round(c.fps / fps));
    size = frameSize(c, width);
    const threads = o.threads ?? defaultRenderThreads({ lowPriority: o.lowPriority });
    for await (const frame of renderFrames({ engine: o.engine, composition: c, step, width, threads, signal: o.signal, deadline: o.deadline, label: "gif", stats: draw })) {
      if (o.deadline !== undefined && performance.now() > o.deadline) throw new EngineTimeoutError("gif encoding timed out and was stopped. Try a shorter text, PNG, or set PASTE_RENDER_TIMEOUT_MS.");
      throwIfAborted(o.signal);
      frames.push(frame.rgba);
    }
  } catch (e) {
    if (e instanceof EngineError) throw e;
    throw new EngineError(`gif: ${e instanceof Error ? e.message : String(e)}`);
  }

  throwIfAborted(o.signal);
  const gif = encodeGif(frames, size.width, size.height, { fps: compositionFps / step, colors: o.colors, delta: o.delta });
  await mkdir(dirname(o.out), { recursive: true });
  await Bun.write(o.out, gif);
  return { frames: frames.length, bytes: gif.byteLength, draw };
}

/* ---- pure half: encode --------------------------------------------------- */

export interface EncodeOptions {
  /** Playback rate; realised as centisecond delays whose running sum stays on this clock. */
  readonly fps: number;
  /** Palette size, at most 256; with deltas one slot of it is the reserved index. */
  readonly colors?: number;
  /** Every Nth frame (and the last) feeds the palette. */
  readonly sampleEvery?: number;
  /**
   * Write frames after the first as deltas: a pixel whose palette index did
   * not change since the previous frame becomes a reserved index the frame
   * flags transparent, and the frame is disposed in place. Default true.
   */
  readonly delta?: boolean;
}

/**
 * Frames, all `width`×`height` RGBA, → GIF bytes. One global palette from a
 * sample of the frames, so colours do not shift between frames. Per-frame
 * delays are the centisecond ticks that keep the running clock on `fps`: at
 * 15 fps a frame is 6.67 cs, so the delays go 7, 6, 7, 7, 6, … and fifteen
 * of them sum to 100. Loops forever. The source alpha is ignored; the only
 * transparency written is the delta marker (see `EncodeOptions.delta`), so
 * what a viewer composites is opaque.
 */
export function encodeGif(frames: readonly Uint8Array[], width: number, height: number, o: EncodeOptions): Uint8Array {
  if (frames.length === 0) throw new RangeError("encodeGif: no frames");
  if (!(o.fps > 0)) throw new RangeError(`encodeGif: fps must be positive; got ${o.fps}`);
  const colors = Math.min(256, Math.max(3, o.colors ?? GIF_DEFAULTS.colors));
  const every = Math.max(1, o.sampleEvery ?? GIF_DEFAULTS.sampleEvery);
  const delta = o.delta ?? true;
  const bytesPerFrame = width * height * 4;
  frames.forEach((f, i) => {
    if (f.length !== bytesPerFrame) throw new RangeError(`encodeGif: frame ${i} is ${f.length} bytes, not ${width}x${height} RGBA`);
  });

  const sampled = frames.map((_, i) => i).filter((i) => i % every === 0 || i === frames.length - 1);
  const sample = new Uint8Array(sampled.length * bytesPerFrame);
  sampled.forEach((i, k) => sample.set(frames[i]!, k * bytesPerFrame));
  // applyPalette only ever picks from `palette`; the reserved slot is appended
  // to the table that is written, so no opaque pixel can land on it.
  const palette = quantize(sample, delta ? colors - 1 : colors, { format: "rgb565" });
  const table = delta ? [...palette, [...palette[0]!]] : palette;
  const reserved = table.length - 1;

  const gif = GIFEncoder({ initialCapacity: Math.ceil(Math.min(1 << 24, (bytesPerFrame * frames.length) / 8)) });
  let clock = 0; // centiseconds scheduled so far
  let prev: Uint8Array | undefined;
  frames.forEach((rgba, i) => {
    const next = Math.round(((i + 1) * 100) / o.fps);
    const delay = (next - clock) * 10;
    clock = next;
    const index = applyPalette(rgba, palette, "rgb565");
    let written = index;
    if (prev) {
      written = new Uint8Array(index.length);
      for (let p = 0; p < index.length; p++) written[p] = index[p] === prev[p] ? reserved : index[p]!;
    }
    gif.writeFrame(written, width, height, {
      ...(i === 0 ? { palette: table, repeat: 0 } : {}),
      delay,
      dispose: 1,
      transparent: prev !== undefined,
      transparentIndex: reserved,
    });
    if (delta) prev = index;
  });
  gif.finish();
  return gif.bytes();
}
