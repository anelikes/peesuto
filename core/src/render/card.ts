/**
 * DSL → card. compose → engine build → PNG, GIF, or an MP4 (native encoder or ffmpeg, video.ts).
 */
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Catalog } from "../catalog.ts";
import type { Dsl } from "../dsl.ts";
import { EngineError, ensureWorkTree, renderDeadline, runEngine } from "../engine.ts";
import { composeCard, type ComposeResult } from "./compose.ts";
import { encodeCardGif } from "./gif.ts";
import { pruneOutputs, writeOutput } from "./outputs.ts";
import { encodeMp4, videoEncoderFor, type VideoEncoderPreference } from "./video.ts";

export interface RenderOptions {
  readonly engine: string;
  readonly work: string;
  readonly emojiCache: string;
  readonly emojiBundle?: string;
  /** The catalog with style packs merged in; the base one when absent. */
  readonly catalog?: Catalog;
  /** Explicit output format; by default animated compositions produce GIF. */
  readonly format?: "png" | "gif" | "mp4";
  /** MP4 encoder: "auto" (default; PEESUTO_VIDEO_ENCODER when absent) prefers the native PeesutoEncoder, else ffmpeg. */
  readonly videoEncoder?: VideoEncoderPreference;
  /** Optional absolute PeesutoEncoder path (PEESUTO_ENCODER_PATH); found next to the bundled Bun otherwise. */
  readonly nativeEncoder?: string;
  /** Optional absolute ffmpeg executable override, used only for MP4 through ffmpeg. */
  readonly ffmpeg?: string;
  /** Output path; defaults to a unique file under outDir so earlier results remain valid. */
  readonly out?: string;
  readonly outDir?: string;
  /** Background work: aborting kills the engine's process group and stops GIF encoding. */
  readonly signal?: AbortSignal;
  /** Engine children run at a lower priority (precompose). */
  readonly lowPriority?: boolean;
}

export interface RenderResult extends ComposeResult {
  readonly path: string;
  readonly format: "png" | "gif" | "mp4";
  readonly ms: { readonly compose: number; readonly build: number; readonly frame: number };
  /** MP4 only: which encoder made it. */
  readonly encoder?: "native" | "ffmpeg";
}

/** compose + build; the composition is then ready for `frame` or `render`. */
export async function prepareCard(dsl: Dsl, o: RenderOptions, deadline?: number): Promise<ComposeResult & { readonly ms: { compose: number; build: number } }> {
  await ensureWorkTree(o.engine, o.work);
  await mkdir(join(o.work, "compositions/paste"), { recursive: true });
  const t0 = performance.now();
  const composed = await composeCard(dsl, { engine: o.engine, work: o.work, emojiCache: o.emojiCache, emojiBundle: o.emojiBundle, catalog: o.catalog });
  const t1 = performance.now();
  await runEngine(o.work, ["build", "compositions/paste"], {}, { deadline });
  const t2 = performance.now();
  return { ...composed, ms: { compose: Math.round(t1 - t0), build: Math.round(t2 - t1) } };
}

/** One frame of the prepared composition as PNG. */
export async function frameCard(o: RenderOptions, at: number, out: string): Promise<number> {
  await mkdir(dirname(out), { recursive: true });
  const r = await runEngine(o.work, ["frame", "compositions/paste", "--at", String(at), "--out", out]);
  return r.ms;
}

export async function renderCard(dsl: Dsl, o: RenderOptions): Promise<RenderResult> {
  // Refuse a missing encoder before composition/build work begins.
  const encoder = o.format === "mp4" ? videoEncoderFor(o) : undefined;
  // One deadline for the whole render: build, frames and encoding together.
  const deadline = renderDeadline(o.format ?? "gif");
  const prepared = await prepareCard(dsl, o, deadline);
  const format = o.format ?? (prepared.frames > 1 ? "gif" : "png");
  const path = o.out ? resolve(o.out) : join(o.outDir ?? o.work, `card-${randomUUID()}.${format}`);
  await mkdir(dirname(path), { recursive: true });
  const t0 = performance.now();
  // Written under a private name and moved into place on success, so a
  // failure never deletes a file the caller already had at `out`.
  await writeOutput(path, async (temp) => {
    if (format === "mp4") {
      await encodeMp4(encoder!, { engine: o.engine, work: o.work, out: temp, deadline });
      if ((await stat(temp)).size === 0) throw new EngineError("Video export produced an empty MP4 file.");
    } else if (format === "gif") {
      await encodeCardGif({ engine: o.engine, work: o.work, out: temp, deadline });
    } else {
      await runEngine(o.work, ["frame", "compositions/paste", "--at", "0", "--out", temp], {}, { deadline });
    }
  });
  if (!o.out) await pruneOutputs(dirname(path), path);
  return { ...prepared, path, format, ms: { ...prepared.ms, frame: Math.round(performance.now() - t0) }, ...(encoder ? { encoder: encoder.kind } : {}) };
}
