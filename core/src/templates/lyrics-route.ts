/**
 * Which engine draws a Lyric motion render, and drawing it.
 *
 * A GIF or a video is drawn by JIZURA (core/src/jizura) when it can be:
 * the engine loads here and this machine has every face the film needs and
 * every character of the text is in them. Otherwise, and for the poster
 * (PNG), Pocket Motion draws it with the classic styles (lyrics.ts), and the
 * result says why (`lyric.reason`), and for missing fonts which packs have
 * them (`lyric.packs`), so the app can offer to download them.
 * An explicit classic choice (the engine, a classic style id, or a style
 * picked from the template menu) goes to Pocket Motion directly.
 *
 * Nothing here is silent: a JIZURA film that cannot be drawn is reported;
 * an input JIZURA refuses (a horror style without the horror switch, an
 * unknown style) is an input error; a text too long is the same
 * lyric-too-long / lyric-gif-too-long error either engine gives.
 */
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { EngineError, renderDeadline, throwIfAborted } from "../engine.ts";
import { fontPacksFor, type Titles } from "../fonts/jizura-packs.ts";
import { AUTO_STYLE, isClassicLyricStyle, JizuraStyleError, prepareJizura, renderJizura, type JizuraFallbackReason, type JizuraMeta, type JizuraRequest } from "../jizura/index.ts";
import type { RenderOptions, RenderResult } from "../render/card.ts";
import { pruneOutputs, writeOutput } from "../render/outputs.ts";
import { videoEncoderFor } from "../render/video.ts";
import type { TemplateComposeResult } from "./compose.ts";
import { renderTemplate } from "./render.ts";
import { TemplateInputError, VARIANT_IDS, type TemplatePlan, type VariantId } from "./types.ts";

export type LyricEngineChoice = "auto" | "jizura" | "classic";
export const LYRIC_ENGINES: readonly LyricEngineChoice[] = ["auto", "jizura", "classic"];

export interface LyricOptions {
  /** "auto" (default): JIZURA for GIF and video when it can draw the film, else classic. */
  readonly engine?: LyricEngineChoice;
  /** "auto" (default: JIZURA's おまかせ), a JIZURA style key, or a classic style id (classic, editorial, pop, night). */
  readonly style?: string;
  /** JIZURA's horror set: its parts, its three styles and the horror mood. Default off. */
  readonly horror?: boolean;
  /** A classic style was chosen explicitly (the template menu's style): Pocket Motion draws it. */
  readonly classicVariant?: boolean;
  /** Tests: where JIZURA's font files come from (jizura/index.ts JizuraRequest.resolveFonts). */
  readonly resolveFonts?: JizuraRequest["resolveFonts"];
}

/** What drew a Lyric motion result (the action's `meta.lyric`). */
export type LyricRenderMeta =
  | (JizuraMeta & { readonly prepareMs: number })
  | {
    readonly engine: "classic";
    /** Why JIZURA did not draw it: the poster, an explicit classic choice, or what was missing. */
    readonly reason: "poster" | "chosen" | JizuraFallbackReason;
    readonly missing?: readonly string[];
    /** With `fonts-missing`: the downloadable packs that have the missing faces (the daemon's `fonts.install`). */
    readonly packs?: readonly LyricFontPack[];
    readonly characters?: readonly string[];
    readonly message?: string;
  };

/** A font pack a fallback names: its id for `fonts.install`, its name and its download size in bytes. */
export interface LyricFontPack { readonly id: string; readonly title: Titles; readonly bytes: number }

export type LyricRenderResult = RenderResult & TemplateComposeResult & { readonly lyric: LyricRenderMeta };

/** The render of a Lyric motion plan: JIZURA, or Pocket Motion with the reason. */
export async function renderLyrics(plan: TemplatePlan, options: RenderOptions, o: LyricOptions = {}, render: typeof renderTemplate = renderTemplate): Promise<LyricRenderResult> {
  if (plan.template !== "lyrics" || plan.content.kind !== "lyrics") throw new TemplateInputError("renderLyrics: not a Lyric motion plan");
  const format = options.format ?? (plan.motion === "none" ? "png" : "gif");
  const style = o.style ?? AUTO_STYLE;
  const engine = o.engine ?? "auto";
  if (!LYRIC_ENGINES.includes(engine)) throw new TemplateInputError(`Unknown lyric engine ${JSON.stringify(engine)}: auto, jizura or classic.`);
  const classic = async (reason: Extract<LyricRenderMeta, { engine: "classic" }>["reason"], extra: Partial<Extract<LyricRenderMeta, { engine: "classic" }>> = {}, variant?: VariantId) => {
    const r = await render(variant ? { ...plan, variant } : plan, { ...options, format });
    return { ...r, lyric: { engine: "classic" as const, reason, ...extra } };
  };
  if (format === "png") return classic("poster");
  if (isClassicLyricStyle(style)) {
    if (engine === "jizura") throw new TemplateInputError(`${style} is a classic style; JIZURA has its own styles.`);
    return classic("chosen", {}, VARIANT_IDS.includes(style as VariantId) ? style as VariantId : undefined);
  }
  if (engine === "classic" || o.classicVariant) return classic("chosen");

  // Refuse a missing MP4 encoder before planning, as renderTemplate does.
  const encoder = format === "mp4" ? videoEncoderFor(options) : undefined;
  const deadline = renderDeadline(format);
  throwIfAborted(options.signal);
  let prepared;
  try {
    prepared = await prepareJizura({ content: plan.content, sourceText: plan.sourceText, aspect: plan.aspect, format, style, horror: o.horror === true, ...(options.dataDir ? { dataDir: options.dataDir } : {}), ...(o.resolveFonts ? { resolveFonts: o.resolveFonts } : {}) });
  } catch (e) {
    if (e instanceof JizuraStyleError) throw new TemplateInputError(e.message);
    throw e;
  }
  if (!prepared.ok) {
    const { reason, message } = prepared;
    const extra = prepared.reason === "fonts-missing"
      ? { missing: prepared.missing, packs: fontPacksFor(prepared.missing).map((p): LyricFontPack => ({ id: p.id, title: p.title, bytes: p.bytes })) }
      : prepared.reason === "glyphs" ? { characters: prepared.characters } : {};
    return classic(reason, { message, ...extra });
  }
  const { job, meta } = prepared;
  const path = options.out ? resolve(options.out) : join(options.outDir ?? options.work, `template-${randomUUID()}.${format}`);
  await mkdir(dirname(path), { recursive: true });
  const started = performance.now();
  const r = await writeOutput(path, async (temp) => {
    const done = await renderJizura(job, { out: temp, format, ...(encoder ? { encoder } : {}), deadline, signal: options.signal, lowPriority: options.lowPriority });
    throwIfAborted(options.signal);
    if ((await stat(temp)).size === 0) throw new EngineError("Lyric motion output is empty.");
    return done;
  });
  if (!options.out) await pruneOutputs(dirname(path), path);
  return {
    dir: "", lines: meta.lines, size: 0, frames: r.frames, emoji: 0, truncated: false,
    width: r.width, height: r.height, template: "lyrics", variant: plan.variant, motion: plan.motion, scroll: false,
    path, format, ms: { compose: prepared.ms, build: 0, frame: Math.round(performance.now() - started) },
    ...(encoder ? { encoder: encoder.kind } : {}),
    lyric: { ...meta, prepareMs: prepared.ms },
  };
}
