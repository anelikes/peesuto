/**
 * DSL → card. compose → engine build → PNG, GIF, or an MP4 through ffmpeg.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Catalog } from "../catalog.ts";
import type { Dsl } from "../dsl.ts";
import { EngineError, ensureWorkTree, runEngine } from "../engine.ts";
import { composeCard, type ComposeResult } from "./compose.ts";
import { encodeCardGif } from "./gif.ts";
import { resolveFFmpeg, videoEnvironment } from "./video.ts";

export interface RenderOptions {
  readonly engine: string;
  readonly work: string;
  readonly emojiCache: string;
  readonly emojiBundle?: string;
  /** The catalog with style packs merged in; the base one when absent. */
  readonly catalog?: Catalog;
  /** Explicit output format; by default animated compositions produce GIF. */
  readonly format?: "png" | "gif" | "mp4";
  /** Optional absolute ffmpeg executable override, used only for MP4. */
  readonly ffmpeg?: string;
  /** Output path; defaults to a unique file under outDir so earlier results remain valid. */
  readonly out?: string;
  readonly outDir?: string;
}

export interface RenderResult extends ComposeResult {
  readonly path: string;
  readonly format: "png" | "gif" | "mp4";
  readonly ms: { readonly compose: number; readonly build: number; readonly frame: number };
}

/** compose + build; the composition is then ready for `frame` or `render`. */
export async function prepareCard(dsl: Dsl, o: RenderOptions): Promise<ComposeResult & { readonly ms: { compose: number; build: number } }> {
  await ensureWorkTree(o.engine, o.work);
  await mkdir(join(o.work, "compositions/paste"), { recursive: true });
  const t0 = performance.now();
  const composed = await composeCard(dsl, { engine: o.engine, work: o.work, emojiCache: o.emojiCache, emojiBundle: o.emojiBundle, catalog: o.catalog });
  const t1 = performance.now();
  await runEngine(o.work, ["build", "compositions/paste"]);
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
  const ffmpeg = o.format === "mp4" ? resolveFFmpeg({ executable: o.ffmpeg }) : undefined;
  const prepared = await prepareCard(dsl, o);
  const format = o.format ?? (prepared.frames > 1 ? "gif" : "png");
  const path = o.out ? resolve(o.out) : join(o.outDir ?? o.work, `card-${randomUUID()}.${format}`);
  await mkdir(dirname(path), { recursive: true });
  const t0 = performance.now();
  if (format === "mp4") {
    try {
      await runEngine(o.work, ["render", "compositions/paste", "--format", "mp4", "--out", path], await videoEnvironment(o.work, ffmpeg!));
      if ((await stat(path)).size === 0) throw new EngineError("Video export produced an empty MP4 file.");
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  } else if (format === "gif") {
    await encodeCardGif({ engine: o.engine, work: o.work, out: path });
  } else {
    await runEngine(o.work, ["frame", "compositions/paste", "--at", "0", "--out", path]);
  }
  return { ...prepared, path, format, ms: { ...prepared.ms, frame: Math.round(performance.now() - t0) } };
}
