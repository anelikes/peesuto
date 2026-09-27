/**
 * Lyric motion drawn by JIZURA (852wa/JIZURA, MIT, © 2026 hakoniwa): its own
 * engine, unmodified (vendor/jizura/jizura.js), run headless in Bun over
 * Skia (@napi-rs/canvas). Everything that adapts it lives in this directory:
 *
 *   canvas.ts   the Skia addon, loaded without system fonts
 *   bundle.ts   the vendored engine, compiled once per thread
 *   realm.ts    a vm realm per engine instance: browser stand-ins, seeded Math.random
 *   script.ts   Lyric motion's text and reading timing as JIZURA lines and times
 *   project.ts  a JIZURA project: style or おまかせ, part sets, frame
 *   fonts.ts    the faces a plan needs, their registration, coverage
 *   catalog.ts  the styles Core reports (JIZURA's and the classic ones)
 *   render.ts   the frames, in fixed chunks any number of threads draws alike
 *
 * prepareJizura() plans the film and checks it can be drawn here: the engine
 * loads, every face it needs is on this machine, every character is in them.
 * When not, it says which of those failed (a typed result, never an error
 * thrown into the render and never a film with boxes), and the caller draws
 * Lyric motion with Pocket Motion instead and says why.
 * renderJizura() draws a prepared film to a GIF or an MP4 through Core's
 * encoders (render/gif.ts, render/video.ts), on frame threads (render/frames.ts).
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { EngineError, EngineTimeoutError, throwIfAborted } from "../engine.ts";
import { jizuraFontFiles, type JizuraFontFile } from "../fonts/jizura-packs.ts";
import { encodeGif, GIF_DEFAULTS } from "../render/gif.ts";
import { renderFrames, type FrameStats } from "../render/frames.ts";
import { defaultRenderThreads } from "../render/threads.ts";
import { pipeFramesToEncoder, pipeFramesToFfmpeg, type VideoEncoder } from "../render/video.ts";
import { seedOf } from "../templates/lyrics.ts";
import { templateGifWidth } from "../templates/render.ts";
import { FRAMES, type TemplateAspect, type TemplateContent } from "../templates/types.ts";
import { jizuraBundlePath, jizuraSource } from "./bundle.ts";
import { JizuraUnavailableError, loadCanvas } from "./canvas.ts";
import { AUTO_STYLE, jizuraStyleOf } from "./catalog.ts";
import { planFaces, registerFonts, uncovered } from "./fonts.ts";
import { buildProject, type JizuraAspect } from "./project.ts";
import { createRealm } from "./realm.ts";
import { JizuraDrawer, jizuraChunks, type JizuraJob } from "./render.ts";
import { lyricScript } from "./script.ts";

export { lyricStyles, classicLyricStyles, isClassicLyricStyle, jizuraCatalog, AUTO_STYLE, type LyricStyle } from "./catalog.ts";
export { JizuraUnavailableError } from "./canvas.ts";
export type { JizuraJob } from "./render.ts";

type LyricsContent = Extract<TemplateContent, { kind: "lyrics" }>;

/** The composition rate JIZURA films are drawn at; a GIF takes every other frame (GIF_DEFAULTS.fps). */
export const JIZURA_FPS = 30;
/** Seeds Math.random in every realm (the grain tiles, the paper). */
const RANDOM_SEED = 0x6a697a75;

/** A style that needs the horror switch was asked for without it (an input error, not a fallback). */
export class JizuraStyleError extends Error {
  constructor(message: string) { super(message); this.name = "JizuraStyleError"; }
}

export interface JizuraRequest {
  readonly content: LyricsContent;
  /** The source text: seeds the film (the same text gives the same film). */
  readonly sourceText: string;
  readonly aspect: TemplateAspect;
  readonly format: "gif" | "mp4";
  /** "auto" (default: おまかせ from the text) or a JIZURA style key. */
  readonly style?: string;
  /** JIZURA's horror parts, styles and mood (default off). */
  readonly horror?: boolean;
  /** The app's data directory: installed font packs live under it. */
  readonly dataDir?: string;
  /** Where font files come from (default: core/src/fonts jizuraFontFiles; tests substitute their own). */
  readonly resolveFonts?: (families: readonly string[], o: { readonly dataDir?: string; readonly text: string }) => { files: JizuraFontFile[]; missing: string[] };
}

export interface JizuraMeta {
  readonly engine: "jizura";
  /** What was asked ("auto" or a key) and what JIZURA draws with. */
  readonly requestedStyle: string;
  readonly style: string;
  readonly mood: string | null;
  readonly horror: boolean;
  /** The lyric language JIZURA read (ja, zh-Hans, zh-Hant, ko, en). */
  readonly lang: string;
  readonly cuts: number;
  readonly lines: number;
  /** Two lines shared each line to fit the length cap. */
  readonly paired: boolean;
  readonly families: readonly string[];
  readonly version: string;
  readonly commit: string;
}

export type JizuraPrepared =
  | { readonly ok: true; readonly job: JizuraJob; readonly meta: JizuraMeta; readonly ms: number }
  /** Faces the film needs that this machine does not have (download them: core/src/fonts/jizura-packs.ts ensureJizuraFonts). */
  | { readonly ok: false; readonly reason: "fonts-missing"; readonly missing: readonly string[]; readonly families: readonly string[]; readonly message: string }
  /** Characters none of the film's faces has (they would draw as boxes). */
  | { readonly ok: false; readonly reason: "glyphs"; readonly characters: readonly string[]; readonly message: string }
  /** The engine did not load here (no canvas addon, no bundle). */
  | { readonly ok: false; readonly reason: "engine"; readonly message: string };

export type JizuraFallbackReason = Exclude<JizuraPrepared, { ok: true }>["reason"];

const jizuraAspect = (aspect: TemplateAspect): JizuraAspect => (aspect === "auto" ? "1:1" : aspect);
/** The text a film draws: the lyric lines (markup characters are syntax), the title and the credit. */
const drawnText = (lyrics: string, title: string, artist: string) => `${lyrics.replace(/[*/|]/g, "")}\n${title}\n${artist}`;

/** The size a film is drawn at: the frame, or for a GIF its own width (360–540 px, the frame-memory budget). */
export function jizuraSize(aspect: TemplateAspect, format: "gif" | "mp4", durationFrames: number): { width: number; height: number } {
  const frame = FRAMES[jizuraAspect(aspect)];
  if (format !== "gif") return { ...frame };
  const width = templateGifWidth(frame.width, frame.height, durationFrames);
  return { width, height: Math.round(frame.height * width / frame.width) };
}

/**
 * Plan a Lyric motion film with JIZURA and check it can be drawn here.
 * Throws only for input errors (ComposeError: too long; JizuraStyleError);
 * anything this machine lacks is a `{ ok: false }` result.
 */
export async function prepareJizura(r: JizuraRequest): Promise<JizuraPrepared> {
  const t0 = performance.now();
  const style = r.style ?? AUTO_STYLE;
  const horror = r.horror ?? false;
  if (style !== AUTO_STYLE) {
    const known = jizuraStyleOf(style);
    if (!known) throw new JizuraStyleError(`There is no JIZURA style ${JSON.stringify(style)}.`);
    if (known.horror && !horror) throw new JizuraStyleError(`${style} is a horror style; turn horror on to use it.`);
  }
  const frame = FRAMES[jizuraAspect(r.aspect)];
  // Durations and caps as Lyric motion's own (the GIF cap depends on the frame, not on the GIF width).
  const script = lyricScript(r.content, { width: frame.width, height: frame.height, format: r.format });
  let canvas, bundlePath: string;
  try { bundlePath = jizuraBundlePath(); canvas = await loadCanvas(); }
  catch (e) {
    if (e instanceof JizuraUnavailableError) return { ok: false, reason: "engine", message: e.message };
    throw e;
  }
  const seed = seedOf(r.sourceText);
  const unregistered: string[] = [];
  const plan = (files: readonly JizuraFontFile[]) => {
    const { failed } = registerFonts(canvas, files);
    for (const path of failed) unregistered.push(...files.filter((f) => f.path === path).map((f) => f.family));
    const realm = createRealm(canvas, bundlePath, RANDOM_SEED);
    const built = buildProject(realm.J, script, { style, horror, aspect: jizuraAspect(r.aspect), seed, fps: JIZURA_FPS, exclude: SLOW_PARTS });
    const p = realm.J.plan(JSON.parse(JSON.stringify(built.project)), null);
    return { built, plan: p, faces: planFaces(realm.J, p) };
  };
  const text = drawnText(script.lyrics, script.title, script.artist);
  // Plan, find the faces, register them, and plan again with them: the plan is the one the frame threads make.
  let files: JizuraFontFile[] = [];
  let planned = plan(files);
  for (let pass = 0; pass < 3; pass++) {
    const found = (r.resolveFonts ?? jizuraFontFiles)(planned.faces.families, { ...(r.dataDir ? { dataDir: r.dataDir } : {}), text });
    if (found.missing.length) {
      return { ok: false, reason: "fonts-missing", missing: found.missing, families: planned.faces.families,
        message: `JIZURA needs fonts this Mac does not have yet: ${found.missing.join(", ")}.` };
    }
    const known = new Set(files.map((f) => `${f.family}\0${f.path}`));
    const added = found.files.filter((f) => !known.has(`${f.family}\0${f.path}`));
    if (!added.length) break;
    files = [...files, ...added];
    planned = plan(files);
  }
  if (unregistered.length) {
    const missing = [...new Set(unregistered)].sort();
    return { ok: false, reason: "fonts-missing", missing, families: planned.faces.families, message: `JIZURA's fonts did not load: ${missing.join(", ")}.` };
  }
  const missingChars = uncovered(text, planned.faces, files);
  if (missingChars.length) {
    return { ok: false, reason: "glyphs", characters: missingChars,
      message: `JIZURA's fonts cannot draw ${missingChars.slice(0, 12).join(" ")}${missingChars.length > 12 ? " …" : ""}.` };
  }
  const durationFrames = Math.max(2, Math.round(planned.plan.duration * JIZURA_FPS));
  const size = jizuraSize(r.aspect, r.format, durationFrames);
  const step = r.format === "gif" ? Math.max(1, Math.round(JIZURA_FPS / GIF_DEFAULTS.fps)) : 1;
  const job: JizuraJob = {
    kind: "jizura", bundlePath, project: planned.built.project, width: size.width, height: size.height, fps: JIZURA_FPS, durationFrames, step,
    chunks: jizuraChunks({ durationFrames, step, fps: JIZURA_FPS, width: size.width, height: size.height }),
    fonts: files, randomSeed: RANDOM_SEED, maxRes: size.height >= 1000 ? 768 : 512,
    grainShim: process.env.PEESUTO_JIZURA_GRAIN !== "pattern",
    // A GIF without the film grain, as classic Lyric motion (grain.ts).
    ...(r.format === "gif" ? { noGrain: true } : {}),
  };
  const { info } = jizuraSource(bundlePath);
  return { ok: true, job, ms: Math.round(performance.now() - t0), meta: {
    engine: "jizura", requestedStyle: style, style: planned.built.style, mood: planned.built.mood, horror, lang: planned.plan.lang,
    cuts: planned.plan.cuts.length, lines: script.lines.length, paired: script.paired, families: planned.faces.families,
    version: info.version, commit: info.commit,
  } };
}

/**
 * Parts never picked at random here, because under Skia they cost most of a
 * second to seconds on every frame of their cut (JIZURA itself may still
 * use them; a line can be given one by hand in JIZURA's editor).
 *
 * Measured over 112 films (24 styles and four おまかせ seeds × four texts,
 * 79,884 frames at 1080², grain as sheets): frame CPU p50 43 ms, p99 335 ms.
 * ぼかし送り (treat focusPull) blurs every glyph by its own radius for the
 * whole cut, and Skia draws each blurred glyph through a full layer: all 15
 * of its cuts ran at 220–700 ms a frame (up to 2.1 s), six of them over a
 * second, the slowest cut of five films. Nothing else is slow on its own:
 * the other frames over a second (0.1%) come from rare pairs, such as 原稿用紙
 * (genkou) with a blur exit, or a long shadow with a staggered blur exit,
 * each fine apart (docs/templates.md).
 */
export const SLOW_PARTS: Readonly<Record<string, readonly string[]>> = { treat: ["focusPull"] };

export interface JizuraRenderOptions {
  readonly out: string;
  readonly format: "gif" | "mp4";
  /** MP4: the encoder (render/video.ts resolveVideoEncoder). */
  readonly encoder?: VideoEncoder;
  readonly signal?: AbortSignal;
  readonly deadline?: number;
  readonly threads?: number;
  readonly lowPriority?: boolean;
}

export interface JizuraRenderResult {
  readonly frames: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly draw: FrameStats;
  readonly ms: { readonly frames: number; readonly encode: number; readonly total: number };
}

/** Draw a prepared film into `out` (GIF or MP4). */
export async function renderJizura(job: JizuraJob, o: JizuraRenderOptions): Promise<JizuraRenderResult> {
  const t0 = performance.now();
  const draw: FrameStats = { threads: 1, drawn: 0, held: 0 };
  const threads = o.threads ?? defaultRenderThreads({ lowPriority: o.lowPriority, kind: "jizura" });
  const label = o.format === "gif" ? "gif" : "MP4";
  const stream = renderFrames({ jizura: job, threads, signal: o.signal, deadline: o.deadline, label, stats: draw });
  await mkdir(dirname(o.out), { recursive: true });
  try {
    if (o.format === "gif") {
      const frames: Uint8Array[] = [];
      for await (const f of stream) frames.push(f.rgba);
      const drawn = performance.now();
      throwIfAborted(o.signal);
      if (o.deadline !== undefined && performance.now() > o.deadline) throw new EngineTimeoutError("gif encoding timed out and was stopped. Try a shorter text, PNG, or set PASTE_RENDER_TIMEOUT_MS.");
      const gif = encodeGif(frames, job.width, job.height, { fps: job.fps / job.step });
      await Bun.write(o.out, gif);
      return { frames: frames.length, width: job.width, height: job.height, fps: job.fps / job.step, draw,
        ms: { frames: Math.round(drawn - t0), encode: Math.round(performance.now() - drawn), total: Math.round(performance.now() - t0) } };
    }
    if (!o.encoder) throw new EngineError("mp4: no video encoder");
    const count = Math.ceil(job.durationFrames / job.step);
    const pipe = o.encoder.kind === "native" ? pipeFramesToEncoder : pipeFramesToFfmpeg;
    const r = await pipe({ encoder: o.encoder.path, out: o.out, width: job.width, height: job.height, fps: job.fps, frames: count,
      deadline: o.deadline, signal: o.signal, lowPriority: o.lowPriority,
      frame: async (f) => {
        const next = await stream.next();
        if (next.done || next.value.index !== f * job.step) throw new EngineError(`mp4: frame ${f} came out of order`);
        return next.value.rgba;
      } });
    return { frames: r.frames, width: r.width, height: r.height, fps: job.fps, draw, ms: { frames: r.ms.render, encode: r.ms.encode, total: Math.round(performance.now() - t0) } };
  } finally {
    await stream.return(undefined);
  }
}

/**
 * The JIZURA families a Lyric motion film of `text` in `style` needs (for
 * downloading font packs before a render). Plans the film as a render would.
 */
export async function jizuraFamiliesFor(style: string, text: string, o: { readonly aspect?: TemplateAspect; readonly horror?: boolean } = {}): Promise<{ families: string[]; lang: string }> {
  const { parseTemplates } = await import("../templates/parse.ts");
  const content = parseTemplates(text).candidates.get("lyrics");
  if (content?.kind !== "lyrics" || content.unfit) return { families: [], lang: "" };
  const canvas = await loadCanvas();
  const bundlePath = jizuraBundlePath();
  const aspect = o.aspect ?? "1:1";
  const frame = FRAMES[jizuraAspect(aspect)];
  const script = lyricScript(content, { width: frame.width, height: frame.height, format: "mp4" });
  const realm = createRealm(canvas, bundlePath, RANDOM_SEED);
  const built = buildProject(realm.J, script, { style, horror: o.horror ?? false, aspect: jizuraAspect(aspect), seed: seedOf(text), fps: JIZURA_FPS, exclude: SLOW_PARTS });
  const p = realm.J.plan(built.project, null);
  return { families: [...planFaces(realm.J, p).families], lang: p.lang };
}

export { JizuraDrawer };
