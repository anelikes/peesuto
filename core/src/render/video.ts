/**
 * MP4 encoding. Two encoders, one output (H.264 High, 4:2:0, faststart, no audio):
 *
 *   native  PeesutoEncoder, the Swift helper in the app bundle (Contents/MacOS):
 *           AVFoundation + the VideoToolbox hardware encoder. Frames are
 *           rendered in this process by the engine's frame source (as the GIF
 *           path does) and piped to the helper as raw RGBA — no PNG round trip,
 *           no temp files. Preferred whenever it is present (macOS only).
 *   ffmpeg  Pocket Motion's own `render --format mp4`, which runs a locally
 *           installed ffmpeg (libx264). Used outside the app (`bun run paste`)
 *           or when forced with PEESUTO_VIDEO_ENCODER=ffmpeg for debugging.
 *
 * Neither present → VideoUnavailableError before any composition work.
 */
import { accessSync, constants, statSync } from "node:fs";
import { mkdir, readlink, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { bunOnPath, EngineError, EngineTimeoutError, runEngine, throwIfAborted } from "../engine.ts";
import { downscaleBox, openPreparedFrames, type FrameSource } from "./gif.ts";

export class VideoUnavailableError extends EngineError {}

export type VideoEncoderKind = "native" | "ffmpeg";
export interface VideoEncoder { readonly kind: VideoEncoderKind; readonly path: string }
export type VideoEncoderPreference = "auto" | VideoEncoderKind;

export interface FFmpegDiscovery {
  /** Absolute executable path; overrides automatic discovery. */
  readonly executable?: string;
  readonly env?: Record<string, string | undefined>;
  readonly fallbackPaths?: readonly string[];
}

function isExecutable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); }
  catch { return false; }
}

const NO_ENCODER = "MP4 export needs a video encoder. The Peesuto app includes one; outside the app, install ffmpeg (brew install ffmpeg) or set PEESUTO_FFMPEG_PATH. PNG and GIF export are still available.";

export function resolveFFmpeg(o: FFmpegDiscovery = {}): string {
  const env = o.env ?? process.env;
  const explicit = o.executable ?? env.PEESUTO_FFMPEG_PATH;
  if (explicit !== undefined) {
    if (isAbsolute(explicit) && isExecutable(explicit)) return explicit;
    throw new VideoUnavailableError("The configured ffmpeg path must point to an executable file (PEESUTO_FFMPEG_PATH). PNG and GIF export are still available.");
  }
  const fromPath = Bun.which("ffmpeg", { PATH: env.PATH ?? "" });
  if (fromPath && isExecutable(fromPath)) return fromPath;
  const fallbacks = o.fallbackPaths ?? (process.platform === "darwin" ? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"] : []);
  for (const path of fallbacks) if (isExecutable(path)) return path;
  throw new VideoUnavailableError(NO_ENCODER);
}

/** Where the native encoder may be: next to the bundled Bun (the app's
 * Contents/MacOS), then a development build in this checkout. */
export function nativeEncoderPaths(): string[] {
  if (process.platform !== "darwin") return [];
  const repo = resolve(import.meta.dir, "../../..");
  return [join(dirname(process.execPath), "PeesutoEncoder"), join(repo, "native/.build/release/PeesutoEncoder"), join(repo, "native/.build/debug/PeesutoEncoder")];
}

export interface VideoEncoderDiscovery {
  /** "auto" (default) prefers native; PEESUTO_VIDEO_ENCODER sets it when this is absent. */
  readonly prefer?: VideoEncoderPreference;
  /** Absolute native encoder path; PEESUTO_ENCODER_PATH sets it when this is absent. */
  readonly native?: string;
  /** Absolute ffmpeg path (see resolveFFmpeg). */
  readonly ffmpeg?: string;
  readonly env?: Record<string, string | undefined>;
  /** Native search paths; tests pass [] to hide a development build. */
  readonly nativePaths?: readonly string[];
  readonly ffmpegFallbackPaths?: readonly string[];
}

function preference(value: string | undefined): VideoEncoderPreference {
  if (value === undefined || value === "" || value === "auto") return "auto";
  if (value === "native" || value === "ffmpeg") return value;
  throw new VideoUnavailableError(`PEESUTO_VIDEO_ENCODER must be auto, native or ffmpeg (got ${JSON.stringify(value)}).`);
}

function findNative(o: VideoEncoderDiscovery, env: Record<string, string | undefined>): string | undefined {
  const explicit = o.native ?? env.PEESUTO_ENCODER_PATH;
  if (explicit !== undefined && explicit !== "") {
    if (isAbsolute(explicit) && isExecutable(explicit)) return explicit;
    throw new VideoUnavailableError("The configured video encoder path must point to an executable file (PEESUTO_ENCODER_PATH). PNG and GIF export are still available.");
  }
  return (o.nativePaths ?? nativeEncoderPaths()).find(isExecutable);
}

/** The MP4 encoder to use: native when present (unless ffmpeg is forced), else ffmpeg. */
export function resolveVideoEncoder(o: VideoEncoderDiscovery = {}): VideoEncoder {
  const env = o.env ?? process.env;
  const prefer = o.prefer ?? preference(env.PEESUTO_VIDEO_ENCODER);
  const ffmpeg = () => resolveFFmpeg({ executable: o.ffmpeg, env, fallbackPaths: o.ffmpegFallbackPaths });
  if (prefer === "ffmpeg") return { kind: "ffmpeg", path: ffmpeg() };
  const native = findNative(o, env);
  if (native) return { kind: "native", path: native };
  if (prefer === "native") throw new VideoUnavailableError("The Peesuto video encoder (PeesutoEncoder) was not found. PNG and GIF export are still available.");
  return { kind: "ffmpeg", path: ffmpeg() };
}

/** Whether any MP4 encoder is available (precompose skips video when not). */
export function videoAvailable(o: VideoEncoderDiscovery = {}): boolean {
  try { resolveVideoEncoder(o); return true; } catch { return false; }
}

/** The engine invokes `ffmpeg` by name. A work-local alias also supports an
 * explicitly configured executable whose filename is not literally ffmpeg. */
export async function videoEnvironment(work: string, ffmpeg: string): Promise<{ PATH: string }> {
  const bin = join(work, ".video-bin");
  await mkdir(bin, { recursive: true });
  const alias = join(bin, "ffmpeg");
  const current = await readlink(alias).catch(() => undefined);
  if (current !== ffmpeg) {
    await rm(alias, { force: true });
    await symlink(ffmpeg, alias);
  }
  const bun = await bunOnPath(join(work, ".bin"));
  return { PATH: `${bin}:${bun.PATH}` };
}

export interface NativeMp4Options {
  readonly engine: string;
  readonly work: string;
  readonly out: string;
  /** The PeesutoEncoder executable. */
  readonly encoder: string;
  readonly deadline?: number;
  readonly signal?: AbortSignal;
  /** Background work: the helper runs niced and frames yield between each other. */
  readonly lowPriority?: boolean;
}

export interface NativeMp4Result {
  readonly frames: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** Wall time split: rendering frames here vs. waiting on the encoder. */
  readonly ms: { readonly render: number; readonly encode: number; readonly total: number };
}

const NICE = ["/usr/bin/nice", "/bin/nice"].find(isExecutable);

export interface FramePipeOptions {
  /** The PeesutoEncoder executable. */
  readonly encoder: string;
  readonly out: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frames: number;
  /** Frame `i` as RGBA, width × height × 4 bytes; valid until the next call. */
  readonly frame: (i: number) => Promise<Uint8Array> | Uint8Array;
  readonly deadline?: number;
  readonly signal?: AbortSignal;
  readonly lowPriority?: boolean;
}

/** Frames → PeesutoEncoder's stdin → MP4. The encoder's JSON report must
 * account for every frame; its stderr becomes the error otherwise. */
export async function pipeFramesToEncoder(o: FramePipeOptions): Promise<NativeMp4Result> {
  const started = performance.now();
  let renderMs = 0;
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let stderr: Promise<string> = Promise.resolve("");
  const expected = o.width * o.height * 4;
  try {
    await mkdir(dirname(o.out), { recursive: true });
    const args = [o.encoder, "--width", String(o.width), "--height", String(o.height), "--fps", String(o.fps), "--out", o.out];
    proc = Bun.spawn(o.lowPriority && NICE ? [NICE, "-n", "10", ...args] : args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    stderr = new Response(proc.stderr as ReadableStream).text();
    const stdout = new Response(proc.stdout as ReadableStream).text();
    const stdin = proc.stdin as import("bun").FileSink;
    for (let f = 0; f < o.frames; f++) {
      if (o.deadline !== undefined && performance.now() > o.deadline) throw new EngineTimeoutError("MP4 encoding timed out and was stopped. Try a shorter text, PNG, or set PASTE_RENDER_TIMEOUT_MS.");
      throwIfAborted(o.signal);
      // Background work yields between frames so requests keep being answered.
      if (o.signal) await new Promise((r) => setImmediate(r));
      const t = performance.now();
      const rgba = await o.frame(f);
      renderMs += performance.now() - t;
      if (rgba.length !== expected) throw new EngineError(`mp4: frame ${f} has ${rgba.length} bytes, expected ${expected} (${o.width}x${o.height} RGBA)`);
      // The helper exits early only on failure; its reason is on stderr.
      if (proc.exitCode !== null) break;
      stdin.write(rgba);
      await stdin.flush();
    }
    await stdin.end();
    const code = await proc.exited;
    if (code !== 0) throw new EngineError(`mp4: the video encoder failed (exit ${code}): ${(await stderr).trim() || "no message"}`);
    let report: { ok?: boolean; frames?: number; width?: number; height?: number };
    try { report = JSON.parse((await stdout).trim().split("\n").pop() || "{}"); } catch { report = {}; }
    if (report.ok !== true || report.frames !== o.frames) throw new EngineError(`mp4: the video encoder wrote ${report.frames ?? 0} of ${o.frames} frames`);
    const total = performance.now() - started;
    return { frames: report.frames, width: report.width ?? o.width, height: report.height ?? o.height, fps: o.fps,
      ms: { render: Math.round(renderMs), encode: Math.round(total - renderMs), total: Math.round(total) } };
  } catch (e) {
    if (proc && proc.exitCode === null) { proc.kill(9); await proc.exited.catch(() => undefined); }
    if (e instanceof EngineError) throw e;
    const detail = (await stderr.catch(() => "")).trim();
    throw new EngineError(`mp4: ${e instanceof Error ? e.message : String(e)}${detail ? ` (${detail})` : ""}`);
  }
}

/** The prepared composition at `<work>/compositions/paste` → an MP4 at `out`, through PeesutoEncoder. */
export async function encodeNativeMp4(o: NativeMp4Options): Promise<NativeMp4Result> {
  let source: FrameSource | undefined;
  try {
    const opened = await openPreparedFrames(o.engine, o.work, "mp4");
    source = opened.source;
    const c = opened.composition, s = source;
    const physW = c.width * c.supersample, physH = c.height * c.supersample;
    return await pipeFramesToEncoder({ encoder: o.encoder, out: o.out, width: c.width, height: c.height, fps: c.fps, frames: c.durationFrames,
      deadline: o.deadline, signal: o.signal, lowPriority: o.lowPriority,
      frame: async (f) => {
        await s.seekFrame(f);
        // Supersampled compositions are area-averaged to the declared size, as the engine's ffmpeg leg does.
        return c.supersample > 1 ? downscaleBox(s.read(), physW, physH, c.width).rgba : s.read();
      } });
  } catch (e) {
    if (e instanceof EngineError) throw e;
    throw new EngineError(`mp4: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await source?.dispose();
  }
}

/** The prepared composition → an MP4 at `out`, with whichever encoder was resolved. */
export async function encodeMp4(encoder: VideoEncoder, o: Omit<NativeMp4Options, "encoder">): Promise<void> {
  if (encoder.kind === "native") { await encodeNativeMp4({ ...o, encoder: encoder.path }); return; }
  await runEngine(o.work, ["render", "compositions/paste", "--format", "mp4", "--out", o.out], await videoEnvironment(o.work, encoder.path),
    { deadline: o.deadline, signal: o.signal, lowPriority: o.lowPriority });
}

/** The encoder a render asks for, from its options. */
export function videoEncoderFor(o: { readonly videoEncoder?: VideoEncoderPreference; readonly nativeEncoder?: string; readonly ffmpeg?: string }): VideoEncoder {
  return resolveVideoEncoder({ prefer: o.videoEncoder, native: o.nativeEncoder, ffmpeg: o.ffmpeg });
}
