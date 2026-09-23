/**
 * GIF encoding, in process: the engine's frame source → box downscale → one
 * 128-colour palette → gifenc. ffmpeg is not involved.
 *
 * Frames come straight from the engine's `WasmFrameSource`, imported by
 * absolute path from the engine checkout the way compose.ts imports the text
 * modules, so there is no compile-time dependency on where the engine is. The
 * composition is resolved by the engine's own `resolveComposition` (bundle,
 * pak, viewport, fps, duration, build record), so the paths and refusals are
 * exactly the ones `frame` and `render` apply.
 *
 * Why in-process rather than a subprocess streaming raw RGBA: every helper
 * the frame path needs is an ordinary module — `src/cli/resolve.ts` and
 * `src/runtime/frame-source.ts`; only the argv wrapper lives in
 * `src/cli/commands/`. And compose.ts already boots a wasm world in this
 * process for measurement (`src/text/measure.ts`), so a second boot here is
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
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyPalette, GIFEncoder, quantize } from "gifenc";
import { EngineError, EngineTimeoutError, throwIfAborted } from "../engine.ts";

/* ---- the engine surface this encoder uses -------------------------------- */
interface ResolvedComposition {
  readonly compositionId: string;
  readonly bundlePath: string;
  readonly pakPath: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationFrames: number;
  readonly supersample: number;
  readonly buildCommand: string;
  readonly sidecar: { readonly footage?: readonly unknown[] };
}
type ResolveResult =
  | { readonly ok: true; readonly value: ResolvedComposition }
  | {
      readonly ok: false;
      readonly kind: string;
      readonly message: string;
      readonly diagnostics?: readonly { readonly path: string; readonly code: string; readonly message: string }[];
    };
interface ResolveApi {
  resolveComposition(o: { dir: string; flags: { json: boolean }; requireBundle?: boolean }): Promise<ResolveResult>;
}
interface FrameSource {
  audit(): unknown;
  seekFrame(frame: number): Promise<void>;
  /** RGBA at physical size. Treated as valid only until the next seek. */
  read(): Uint8Array;
  dispose(): Promise<void>;
}
interface FrameSourceApi {
  WasmFrameSource: {
    create(o: {
      compositionId: string;
      bundlePath: string;
      pakPath?: string;
      width: number;
      height: number;
      hz: number;
      durationFrames: number;
      renderScale?: number;
      buildCommand?: string;
    }): Promise<FrameSource>;
  };
}

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
  /** Checked between frames: aborting stops the encoder with EngineAbortedError. */
  readonly signal?: AbortSignal;
}

export interface CardGifResult {
  /** Frames written to the GIF. */
  readonly frames: number;
  readonly bytes: number;
}

/** The prepared composition at `<work>/compositions/paste` → an animated GIF at `out`. */
export async function encodeCardGif(o: CardGifOptions): Promise<CardGifResult> {
  const fps = o.fps ?? GIF_DEFAULTS.fps;
  const width = o.width ?? GIF_DEFAULTS.width;
  const { resolveComposition } = (await import(`${o.engine}/src/cli/resolve.ts`)) as ResolveApi;
  const { WasmFrameSource } = (await import(`${o.engine}/src/runtime/frame-source.ts`)) as FrameSourceApi;

  const resolved = await resolveComposition({ dir: join(o.work, "compositions/paste"), flags: { json: false }, requireBundle: true });
  if (!resolved.ok) {
    const detail = (resolved.diagnostics ?? []).map((d) => `\n  ${d.path || "/"}: ${d.code}: ${d.message}`).join("");
    throw new EngineError(`gif: ${resolved.message}${detail}`);
  }
  const c = resolved.value;
  if ((c.sidecar.footage?.length ?? 0) > 0) throw new EngineError("gif: the card composition declares footage; the GIF path renders none");

  const step = Math.max(1, Math.round(c.fps / fps));
  const physW = c.width * c.supersample;
  const physH = c.height * c.supersample;

  const frames: Uint8Array[] = [];
  let size = { width: 0, height: 0 };
  let source: FrameSource | undefined;
  try {
    source = await WasmFrameSource.create({
      compositionId: c.compositionId,
      bundlePath: c.bundlePath,
      pakPath: existsSync(c.pakPath) ? c.pakPath : undefined,
      width: c.width,
      height: c.height,
      hz: c.fps,
      durationFrames: c.durationFrames,
      renderScale: c.supersample,
      buildCommand: c.buildCommand,
    });
    source.audit();
    for (let f = 0; f < c.durationFrames; f += step) {
      // Frames render in-process; the deadline is checked between frames.
      if (o.deadline !== undefined && performance.now() > o.deadline) throw new EngineTimeoutError("gif encoding timed out and was stopped. Try a shorter text, PNG, or set PASTE_RENDER_TIMEOUT_MS.");
      throwIfAborted(o.signal);
      // Background work yields between frames so requests keep being answered.
      if (o.signal) await new Promise((r) => setImmediate(r));
      await source.seekFrame(f);
      const scaled = downscaleBox(source.read(), physW, physH, width);
      size = { width: scaled.width, height: scaled.height };
      frames.push(scaled.rgba);
    }
  } catch (e) {
    if (e instanceof EngineError) throw e;
    throw new EngineError(`gif: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await source?.dispose();
  }

  throwIfAborted(o.signal);
  const gif = encodeGif(frames, size.width, size.height, { fps: c.fps / step, colors: o.colors, delta: o.delta });
  await mkdir(dirname(o.out), { recursive: true });
  await Bun.write(o.out, gif);
  return { frames: frames.length, bytes: gif.byteLength };
}

/* ---- pure half: resample and encode -------------------------------------- */

export interface Raster {
  readonly rgba: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * Area-average (box) resample of an RGBA raster to `dstWidth` px wide, the
 * height following the aspect. Each destination pixel is the exact mean of
 * the source area it covers, partial source pixels weighted by their overlap:
 * 1080 → 540 is a plain 2×2 mean, 1920 → 540 (3.56×) has no phase drift.
 * Separable, rows first into a float buffer, then columns. Alpha is dropped;
 * the output alpha is 255.
 */
export function downscaleBox(src: Uint8Array, srcWidth: number, srcHeight: number, dstWidth: number): Raster {
  if (src.length !== srcWidth * srcHeight * 4) {
    throw new RangeError(`downscaleBox: ${src.length} bytes is not ${srcWidth}x${srcHeight} RGBA`);
  }
  const dw = Math.max(1, Math.round(dstWidth));
  const dh = Math.max(1, Math.round((srcHeight * dw) / srcWidth));
  const wx = axisWeights(srcWidth, dw);
  const wy = axisWeights(srcHeight, dh);

  // Rows: srcHeight × dw × RGB.
  const tmp = new Float32Array(srcHeight * dw * 3);
  for (let y = 0; y < srcHeight; y++) {
    const srow = y * srcWidth * 4;
    const trow = y * dw * 3;
    for (let x = 0; x < dw; x++) {
      const { start, weights } = wx[x]!;
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < weights.length; k++) {
        const wt = weights[k]!;
        const s = srow + (start + k) * 4;
        r += src[s]! * wt; g += src[s + 1]! * wt; b += src[s + 2]! * wt;
      }
      const t = trow + x * 3;
      tmp[t] = r; tmp[t + 1] = g; tmp[t + 2] = b;
    }
  }
  // Columns: dh × dw × RGBA.
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const { start, weights } = wy[y]!;
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < weights.length; k++) {
        const wt = weights[k]!;
        const t = ((start + k) * dw + x) * 3;
        r += tmp[t]! * wt; g += tmp[t + 1]! * wt; b += tmp[t + 2]! * wt;
      }
      const d = (y * dw + x) * 4;
      out[d] = clamp8(r); out[d + 1] = clamp8(g); out[d + 2] = clamp8(b); out[d + 3] = 255;
    }
  }
  return { rgba: out, width: dw, height: dh };
}

/**
 * For each destination index along one axis: the first source index it
 * touches and the weight of every source pixel it covers, summing to 1.
 * Destination pixel i spans source [i·s, (i+1)·s) with s = src/dst.
 */
function axisWeights(srcN: number, dstN: number): { start: number; weights: number[] }[] {
  const s = srcN / dstN;
  const table: { start: number; weights: number[] }[] = [];
  for (let i = 0; i < dstN; i++) {
    const a = i * s;
    const b = Math.min(srcN, (i + 1) * s);
    const start = Math.min(srcN - 1, Math.floor(a));
    const end = Math.max(start + 1, Math.min(srcN, Math.ceil(b)));
    const weights: number[] = [];
    let sum = 0;
    for (let j = start; j < end; j++) {
      const w = Math.max(0, Math.min(b, j + 1) - Math.max(a, j));
      weights.push(w);
      sum += w;
    }
    table.push({ start, weights: weights.map((w) => w / sum) });
  }
  return table;
}

const clamp8 = (v: number): number => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

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
