/** Pocket Motion owns frame rendering and MP4 encoding; this module supplies
 * its ffmpeg dependency without relying on a GUI app inheriting a shell PATH. */
import { accessSync, constants, statSync } from "node:fs";
import { mkdir, readlink, rm, symlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { bunOnPath, EngineError } from "../engine.ts";

export class VideoUnavailableError extends EngineError {}

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

export function resolveFFmpeg(o: FFmpegDiscovery = {}): string {
  const env = o.env ?? process.env;
  const explicit = o.executable ?? env.PEESUTO_FFMPEG_PATH;
  if (explicit !== undefined) {
    if (isAbsolute(explicit) && isExecutable(explicit)) return explicit;
    throw new VideoUnavailableError("Video export needs ffmpeg. The configured ffmpeg path must point to an executable file. PNG and GIF export are still available.");
  }
  const fromPath = Bun.which("ffmpeg", { PATH: env.PATH ?? "" });
  if (fromPath && isExecutable(fromPath)) return fromPath;
  const fallbacks = o.fallbackPaths ?? (process.platform === "darwin" ? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"] : []);
  for (const path of fallbacks) if (isExecutable(path)) return path;
  throw new VideoUnavailableError("Video export needs ffmpeg. Install ffmpeg, or set PEESUTO_FFMPEG_PATH to its executable. PNG and GIF export are still available.");
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
