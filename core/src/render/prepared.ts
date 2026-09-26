/**
 * A prepared composition (`<work>/compositions/paste` after `build`) opened
 * for frame reads in this thread, through the engine's own modules.
 *
 * `resolveComposition` (src/cli/resolve.ts) finds the bundle, pak, viewport,
 * fps, duration and build record, so the paths and refusals are exactly the
 * ones the engine's `frame` and `render` apply. `WasmFrameSource`
 * (src/runtime/frame-source.ts) boots the wasm world. Both are imported by
 * absolute path from the engine checkout, the way compose.ts imports the text
 * modules: no compile-time dependency on where the engine is.
 *
 * FrameDrawer is the one place frames are drawn, used by the ordered frame
 * stream in this thread and by each frame worker (frames.ts).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EngineError } from "../engine.ts";
import { downscaleBox, scaledSize } from "./raster.ts";

/* ---- the engine surface ---------------------------------------------------- */
export interface ResolvedComposition {
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
export interface FrameSource {
  audit(): unknown;
  seekFrame(frame: number): Promise<void>;
  /** RGBA at physical size. Treated as valid only until the next seek. */
  read(): Uint8Array;
  dispose(): Promise<void>;
  /** The booted world; its exports include `ui_draw_hash` on every pinned engine. */
  readonly world?: { readonly exports?: Record<string, unknown> };
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

/** What a frame source needs of a resolved composition; plain data, so it crosses to a worker. */
export type FrameComposition = Pick<ResolvedComposition, "compositionId" | "bundlePath" | "width" | "height" | "fps" | "durationFrames" | "supersample" | "buildCommand"> & {
  /** Absent when the composition has no pak. */
  readonly pakPath?: string;
};
export const frameComposition = (c: ResolvedComposition): FrameComposition => ({
  compositionId: c.compositionId, bundlePath: c.bundlePath, ...(existsSync(c.pakPath) ? { pakPath: c.pakPath } : {}),
  width: c.width, height: c.height, fps: c.fps, durationFrames: c.durationFrames, supersample: c.supersample, buildCommand: c.buildCommand,
});

/** The prepared composition at `<work>/compositions/paste`, resolved by the engine without opening it. `label` prefixes errors. */
export async function resolvePrepared(engine: string, work: string, label: string): Promise<ResolvedComposition> {
  const { resolveComposition } = (await import(`${engine}/src/cli/resolve.ts`)) as ResolveApi;
  const resolved = await resolveComposition({ dir: join(work, "compositions/paste"), flags: { json: false }, requireBundle: true });
  if (!resolved.ok) {
    const detail = (resolved.diagnostics ?? []).map((d) => `\n  ${d.path || "/"}: ${d.code}: ${d.message}`).join("");
    throw new EngineError(`${label}: ${resolved.message}${detail}`);
  }
  const c = resolved.value;
  if ((c.sidecar.footage?.length ?? 0) > 0) throw new EngineError(`${label}: the card composition declares footage; this path renders none`);
  return c;
}

/** A booted, audited frame source over `c`. The caller disposes it. */
export async function openFrameSource(engine: string, c: FrameComposition): Promise<FrameSource> {
  const { WasmFrameSource } = (await import(`${engine}/src/runtime/frame-source.ts`)) as FrameSourceApi;
  const source = await WasmFrameSource.create({
    compositionId: c.compositionId,
    bundlePath: c.bundlePath,
    pakPath: c.pakPath,
    width: c.width,
    height: c.height,
    hz: c.fps,
    durationFrames: c.durationFrames,
    renderScale: c.supersample,
    buildCommand: c.buildCommand,
  });
  try { source.audit(); }
  catch (e) { await source.dispose(); throw e; }
  return source;
}

/** The size of the frames drawn from `c`: `width` px wide (the height keeping the aspect), else the composition's own size. */
export function frameSize(c: Pick<FrameComposition, "width" | "height" | "supersample">, width?: number): { readonly width: number; readonly height: number } {
  if (width === undefined) return { width: c.width, height: c.height };
  return scaledSize(c.width * c.supersample, c.height * c.supersample, width);
}

export interface DrawOptions {
  /** Box-downscale to this width (GIF). Absent: the composition's size (a supersampled frame is area-averaged to it). */
  readonly width?: number;
  /** Skip rasterising a frame whose draw list equals the one shown before it (see FrameDrawer). */
  readonly reuse: boolean;
}

/** Draws frames in increasing order (FrameDrawer; tests substitute synthetic ones). */
export interface Drawer {
  /** Frame `frame`, shown after `before` (-1: nothing before it): its RGBA, or null when it is the same picture as `before`. */
  draw(frame: number, before: number): Promise<Uint8Array | null>;
  dispose(): Promise<void>;
}

/**
 * Draws frames of one composition in increasing order, in the calling
 * thread. The frame source folds forward (`seekFrame`: a guest turn and core
 * ticks, about 0.03 ms a frame); rasterising is nearly all of the cost.
 *
 * Held frames: many frames repeat the one before them. The koma-uchi styles
 * hold each drawing for two or three frames, and every style holds a line
 * still once it has landed. `ui_draw_hash` (the host's dirty signal) hashes
 * the frame's draw list without rasterising, and the framebuffer is a
 * function of that list alone for these compositions: they have no footage
 * (resolvePrepared refuses it) and their images are fixed. So a frame whose
 * hash equals the one shown before it is the same picture, and is reported
 * as held instead of drawn. An engine without the export draws every frame.
 */
export class FrameDrawer implements Drawer {
  #hashed: bigint | undefined;
  #hashedFrame = -1;
  private constructor(
    private readonly source: FrameSource,
    private readonly hash: (() => bigint) | undefined,
    private readonly finish: (rgba: Uint8Array) => Uint8Array,
  ) {}

  static async open(engine: string, c: FrameComposition, o: DrawOptions): Promise<FrameDrawer> {
    const source = await openFrameSource(engine, c);
    const exported = source.world?.exports?.ui_draw_hash;
    const hash = o.reuse && typeof exported === "function" ? (exported as () => bigint) : undefined;
    const physW = c.width * c.supersample, physH = c.height * c.supersample;
    const finish = o.width !== undefined ? (px: Uint8Array) => downscaleBox(px, physW, physH, o.width!).rgba
      // Supersampled compositions are area-averaged to the declared size, as the engine's ffmpeg leg does.
      : c.supersample > 1 ? (px: Uint8Array) => downscaleBox(px, physW, physH, c.width).rgba
        // A copy: read() is a view of wasm memory that the next frame overwrites.
        : (px: Uint8Array) => px.slice();
    return new FrameDrawer(source, hash, finish);
  }

  /**
   * Frame `frame`, shown after `before` (-1: nothing before it): its RGBA,
   * or null when it is held (the same picture as `before`). Frames must come
   * in increasing order; `before` may be a frame this drawer never drew.
   */
  async draw(frame: number, before: number): Promise<Uint8Array | null> {
    if (this.hash) {
      let previous: bigint | undefined;
      if (before >= 0) {
        if (this.#hashedFrame !== before) { await this.source.seekFrame(before); this.#hashed = this.hash(); this.#hashedFrame = before; }
        previous = this.#hashed;
      }
      await this.source.seekFrame(frame);
      this.#hashed = this.hash();
      this.#hashedFrame = frame;
      if (this.#hashed === previous) return null;
    } else {
      await this.source.seekFrame(frame);
    }
    return this.finish(this.source.read());
  }

  dispose(): Promise<void> { return this.source.dispose(); }
}
