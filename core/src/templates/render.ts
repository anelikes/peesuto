/** Structured template output uses Pocket Motion, without changing legacy DSL fixtures. */
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { EngineError, ensureWorkTree, renderDeadline, runEngine } from "../engine.ts";
import type { RenderOptions, RenderResult } from "../render/card.ts";
import { encodeCardGif } from "../render/gif.ts";
import { pruneOutputs, writeOutput } from "../render/outputs.ts";
import { resolveFFmpeg, videoEnvironment } from "../render/video.ts";
import { ComposeError } from "../render/compose.ts";
import { composeTemplate, type TemplateComposeResult } from "./compose.ts";
import type { TemplatePlan } from "./types.ts";

/** The legacy GIF encoder retains RGBA frames. Bound that allocation for
 * templates instead of allowing a tall typewriter to allocate hundreds of MB.
 * Palette sampling adds about one quarter of this; engine memory is separate. */
export const TEMPLATE_GIF_FRAME_BUDGET = 128 * 1024 * 1024;
export function templateGifWidth(width: number, height: number, frames: number): number {
  const sampledFrames = Math.max(1, Math.ceil(frames / 2)); // 30 fps composition → 15 fps GIF.
  let target = Math.min(540, Math.floor(Math.sqrt(TEMPLATE_GIF_FRAME_BUDGET / (4 * sampledFrames * (height / width)))));
  while (target * Math.round(height * target / width) * sampledFrames * 4 > TEMPLATE_GIF_FRAME_BUDGET) target--;
  if (target < 360) throw new ComposeError("overflow", "This animated card is too tall for the GIF frame-memory budget. Use PNG, a wider aspect, or split the content. No content was truncated.");
  return target;
}

export async function prepareTemplate(plan: TemplatePlan, options: RenderOptions, deadline?: number): Promise<TemplateComposeResult & { ms: { compose: number; build: number } }> {
  await ensureWorkTree(options.engine, options.work);
  const started = performance.now();
  // A still export must contain every character, never animation frame zero.
  const composed = await composeTemplate(options.format === "png" ? { ...plan, motion: "none" } : plan, options);
  if (options.format === "gif") templateGifWidth(composed.width, composed.height, composed.frames);
  const composedAt = performance.now();
  await runEngine(options.work, ["build", "compositions/paste"], {}, { deadline });
  return { ...composed, ms: { compose: Math.round(composedAt - started), build: Math.round(performance.now() - composedAt) } };
}

export async function renderTemplate(plan: TemplatePlan, options: RenderOptions): Promise<RenderResult & TemplateComposeResult> {
  const format = options.format ?? (plan.motion === "none" ? "png" : "gif");
  const ffmpeg = format === "mp4" ? resolveFFmpeg({ executable: options.ffmpeg }) : undefined;
  // One deadline for the whole render: build, frames and encoding together.
  const deadline = renderDeadline(format);
  const prepared = await prepareTemplate(plan, { ...options, format }, deadline);
  const path = options.out ? resolve(options.out) : join(options.outDir ?? options.work, `template-${randomUUID()}.${format}`);
  await mkdir(dirname(path), { recursive: true });
  const started = performance.now();
  // Written under a private name and renamed on success; a failure never
  // deletes a file the caller already had at `out`.
  await writeOutput(path, async (temp) => {
    if (format === "mp4") await runEngine(options.work, ["render", "compositions/paste", "--format", "mp4", "--out", temp], await videoEnvironment(options.work, ffmpeg!), { deadline });
    else if (format === "gif") await encodeCardGif({ engine: options.engine, work: options.work, out: temp, width: templateGifWidth(prepared.width, prepared.height, prepared.frames), deadline });
    else await runEngine(options.work, ["frame", "compositions/paste", "--at", "0", "--out", temp], {}, { deadline });
    if ((await stat(temp)).size === 0) throw new EngineError("Template output is empty.");
  });
  if (!options.out) await pruneOutputs(dirname(path), path);
  return { ...prepared, path, format, ms: { ...prepared.ms, frame: Math.round(performance.now() - started) } };
}
