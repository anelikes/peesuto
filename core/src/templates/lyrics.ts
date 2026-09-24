/**
 * Lyrics: song lyrics and poems. A PNG is a lyric poster (the stanzas as large
 * type, `*emphasis*` larger and in the accent, CJK verse optionally set
 * vertically); a GIF or MP4 is a short lyric video: every line (or `/` piece)
 * is a cut on its own screen with a staggered per-glyph entrance, a gentle
 * hold, an exit, a background colour from the style's palette and a little
 * geometric decor that moves. Everything is deterministic: the choices are
 * seeded by the source text, so the same lyrics give the same video.
 *
 * The vocabulary (a cut = layout + entrance + hold + exit + decor; `/` cuts,
 * `*emphasis*`, a trailing `!` flash, `lyric|note`, LRC timing) follows
 * JIZURA (https://github.com/852wa/JIZURA, MIT), a browser lyric-video maker.
 * No JIZURA code or assets are used; Peesuto makes the quick version and hands
 * the lyrics to JIZURA for a full video.
 *
 * Engine notes (Pocket Motion v0.4.0): keyframes on translate/rotate/scale/
 * opacity/colour and on paint (blur, glow, gradient stops, outline colour);
 * `scale` and `rotate` move glyphs but never resize or turn them (so "scale"
 * and "rotate" entrances move a line's glyphs together: they gather in, or
 * the line swings down into place). Each style's `engine` table switches the
 * v0.4.0 paint on: emphasis drawn as gradient ink, an outline or with a glow,
 * a blur-in on entrances and a soft blur on big decor (`emphasisPaint`,
 * `entranceBlur`, `decorBlur`). `faces` stays null until the owner picks a
 * display face (compose.ts TEMPLATE_FACES); search for `TODO(engine`.
 */
import { ComposeError, normalizeText } from "../render/compose.ts";
import { CHECK_THRESHOLDS, contrastRatio, luminance } from "./checks.ts";
import { hexOklch, oklchHex } from "./gradient.ts";
import type { LyricLine, TemplateContent, TemplatePlan } from "./types.ts";
import type { TemplateFont, TemplateFormat, TemplateLine, TemplateMeasure, TemplateRect, TextPaint } from "./compose.ts";
import { decorate, PLATE_SIZES, plateFaceOf, platesFrom, plateSetter, unionBox, video } from "./lyric-video.ts";
import { missingGlyphs } from "./type-raster.ts";

type LyricsContent = Extract<TemplateContent, { kind: "lyrics" }>;

/**
 * One colour scheme of a style. Every cut takes one; a style keeps two to five
 * and moves between them from cut to cut (a colour cut), never showing the
 * same ground twice running.
 * - `bg` the ground; `ink` the lyric; `accent` emphasis and punchy decor;
 *   `sub` notes, labels, credit, the signature; `tint` a quiet colour close
 *   to the ground for big decor and ghost glyphs.
 * - `plate` an ink plate or band drawn behind words, `plateInk` the words on it.
 * - `ghostA`/`ghostB` the two chromatic ghost passes behind the lyric.
 * `ink`, `accent` and `sub` keep 4.5:1 against `bg`, `plateInk` against
 * `plate` (templates.test.ts checks every scheme).
 */
export interface LyricPalette {
  readonly bg: string; readonly ink: string; readonly accent: string; readonly sub: string; readonly tint: string;
  readonly plate: string; readonly plateInk: string; readonly ghostA: string; readonly ghostB: string;
}
/** The display face per script (compose.ts TEMPLATE_FACES names): a card with kana takes `ja`, with Han `zh`, else `latin`. */
export interface LyricFaces { readonly zh: string; readonly ja: string; readonly latin: string }

/** Pocket Motion paint, per style. In em of the glyph size (or ratios), never
 * scaled with the canvas (compose.ts scaledTo leaves `engine` alone); null
 * switches a feature off. Colours come from each cut's palette. */
interface EngineSlots {
  /** The display face lyric lines (and plates) are set in; notes, labels and the credit keep the card's pair. Null: the card's pair everywhere. */
  readonly faces: LyricFaces | null;
  /** The emphasised word outlined in the accent: width in em; `hollow` draws the outline alone. */
  readonly stroke: { readonly widthEm: number; readonly position: "outside" | "center"; readonly hollow: boolean } | null;
  /** The emphasised word's ink as a vertical gradient around the accent: OKLCH lightness added at the top and at the foot, hue turned toward the foot. */
  readonly gradientText: { readonly lightTop: number; readonly lightFoot: number; readonly hueTurn: number } | null;
  /** A soft glow of the accent behind the emphasised word: blur radius in em, peak alpha, gain. */
  readonly glow: { readonly radiusEm: number; readonly alpha: number; readonly gain: number } | null;
  /** A blur-in on glyph entrances (deviation in em, animating to 0) and a soft edge on the big decor disc (the share of its radius that fades). */
  readonly blur: { readonly entranceEm: number; readonly decor: number } | null;
}

/** Poster (PNG) settings shared by the styles; each style overrides what differs. */
const POSTER = { gradient: true, orb: true, bold: true, align: "left" as "left" | "center", vertical: false, stacked: true, stackRatio: 1.9,
  sizes: [160, 144, 128, 112, 96, 80, 72, 64, 56, 52, 48, 44, 40], leading: 1.02, stanzaLeading: 0.45, margin: 88,
  title: { size: 44, gap: 16 }, credit: { size: 32, gap: 56 }, note: { size: 32, gap: 6 }, label: { size: 32, gap: 12 } };
/** Video lengths (1080 reference, scaled with the canvas). */
const MOTION = {
  sizes: [160, 144, 128, 112, 96, 80, 72, 64, 56, 48, 44, 40], leading: 1.06, margin: 96, bold: true, maxRows: 4,
  title: { size: 144, creditSize: 48, gap: 28 }, note: { size: 36, gap: 28 }, label: { size: 32 },
  underline: { thickness: 10, gap: 4 }, cursor: { thickness: 10 }, frame: { inset: 36, thickness: 8 },
  /** Captions and cut numbers of the editorial layouts. */
  small: { size: 40, gap: 24 }, rule: { thickness: 4 },
};

/* Style tokens, drawn for the 1080 reference width and scaled with the
 * canvas (compose.ts scaledTo): lengths scale, `sizes` snap to the baked
 * sizes, `…Leading` ratios stay. The motion vocabulary (layouts, entrances,
 * holds, transitions, timing, koma, beat, textures) lives in LYRICS_MOTION
 * and is never scaled. */
export const LYRICS_STYLES = {
  /** Stage: black, red, cobalt and yellow grounds cut hard against each other; heavy display type (得意黑 / Dela Gothic / Anton), giant words, bands and plates. */
  classic: {
    background: "#121016", signature: "#aaa3b8",
    poster: { ...POSTER },
    motion: {
      ...MOTION,
      palette: [
        { bg: "#121016", ink: "#f6f1e7", accent: "#ffd23f", sub: "#aaa3b8", tint: "#231f2c", plate: "#ffd23f", plateInk: "#121016", ghostA: "#ff3b5c", ghostB: "#2ec5ff" },
        { bg: "#c8102e", ink: "#fff6ea", accent: "#ffe9a8", sub: "#ffe3e0", tint: "#b00d27", plate: "#121016", plateInk: "#fff6ea", ghostA: "#ffd23f", ghostB: "#121016" },
        { bg: "#1f3fd8", ink: "#ffffff", accent: "#ffd23f", sub: "#dfe4ff", tint: "#1a36bd", plate: "#ffffff", plateInk: "#1f3fd8", ghostA: "#ff3b5c", ghostB: "#00e0ff" },
        { bg: "#ffd23f", ink: "#121016", accent: "#1f3fd8", sub: "#3d3526", tint: "#f2c52f", plate: "#121016", plateInk: "#ffd23f", ghostA: "#ff3b5c", ghostB: "#1f3fd8" },
        { bg: "#f3ede2", ink: "#121016", accent: "#b80d29", sub: "#5c554b", tint: "#e6dece", plate: "#c8102e", plateInk: "#ffffff", ghostA: "#ff3b5c", ghostB: "#1f3fd8" },
      ] as readonly LyricPalette[],
      arrangements: ["center", "left", "stack"] as readonly LyricArrangement[],
      decor: ["bars", "orb", "dots"] as readonly LyricDecor[],
    },
    /** Emphasis: gold-leaf gradient ink with a low glow of the accent. */
    engine: { faces: { zh: "grin", ja: "dela", latin: "anton" }, stroke: null, gradientText: { lightTop: 0.09, lightFoot: -0.07, hueTurn: -14 }, glow: { radiusEm: 0.3, alpha: 0.4, gain: 1 },
      blur: { entranceEm: 0.07, decor: 0.4 } } as EngineSlots,
  },
  /** Paper: warm paper, indigo and sumi grounds; kai and mincho faces (霞鹜文楷 / Kaisei Tokumin / Instrument Serif); vertical CJK, captions, hairlines, crossfades, no stepping. */
  editorial: {
    background: "#f2ece0", signature: "#6a6259",
    poster: { ...POSTER, gradient: false, orb: false, bold: false, align: "center" as "left" | "center", vertical: true, stacked: false, stackRatio: 1,
      sizes: [96, 80, 72, 64, 56, 52, 48, 44, 40], leading: 1.5, stanzaLeading: 0.9, margin: 112,
      title: { size: 48, gap: 16 }, credit: { size: 32, gap: 64 }, note: { size: 32, gap: 4 }, label: { size: 32, gap: 16 } },
    motion: {
      ...MOTION,
      sizes: [144, 128, 112, 96, 80, 72, 64, 56, 48, 44, 40], leading: 1.3, margin: 112, bold: false,
      title: { size: 128, creditSize: 48, gap: 36 }, note: { size: 36, gap: 32 },
      underline: { thickness: 4, gap: 10 }, cursor: { thickness: 4 }, frame: { inset: 40, thickness: 3 }, rule: { thickness: 2 },
      palette: [
        { bg: "#f2ece0", ink: "#1d1a16", accent: "#b3261e", sub: "#665e55", tint: "#e6dece", plate: "#1d1a16", plateInk: "#f2ece0", ghostA: "#d9a79c", ghostB: "#9aa7c2" },
        { bg: "#1b2350", ink: "#f2ece0", accent: "#f2b8a0", sub: "#bfc3d9", tint: "#232c5e", plate: "#f2ece0", plateInk: "#1b2350", ghostA: "#b3261e", ghostB: "#5d6db8" },
        { bg: "#e4e7e3", ink: "#1b2226", accent: "#a1261a", sub: "#566064", tint: "#d6dad5", plate: "#1b2226", plateInk: "#e4e7e3", ghostA: "#d9a79c", ghostB: "#8fa3b0" },
        { bg: "#171513", ink: "#efe7d8", accent: "#e3a64a", sub: "#b1a897", tint: "#24211d", plate: "#efe7d8", plateInk: "#171513", ghostA: "#b3261e", ghostB: "#5a6a7a" },
      ] as readonly LyricPalette[],
      arrangements: ["center", "left"] as readonly LyricArrangement[],
      decor: ["rules", "sun", "frame", "none"] as readonly LyricDecor[],
    },
    /** Emphasis: the word inked heavier in vermilion (an outline of its own colour thickens it, as a pen pressed harder). */
    engine: { faces: { zh: "wenkai", ja: "tokumin", latin: "instrument" }, stroke: { widthEm: 0.012, position: "outside", hollow: false }, gradientText: null, glow: null,
      blur: { entranceEm: 0.05, decor: 0 } } as EngineSlots,
  },
  /** Pop: candy grounds (pink, lemon, sky, grape, mint); rounded heavy faces (站酷快乐体 / Zen Maru Gothic); stickers, halftone dots, bouncy stepped motion. */
  pop: {
    background: "#ff6fae", signature: "#3a0a2a",
    poster: { ...POSTER, orb: false, align: "center" as "left" | "center" },
    motion: {
      ...MOTION,
      underline: { thickness: 14, gap: 4 }, frame: { inset: 32, thickness: 12 },
      palette: [
        { bg: "#ff6fae", ink: "#1c0a26", accent: "#2d10a0", sub: "#3a0a2a", tint: "#ff86bb", plate: "#1c0a26", plateInk: "#ffe45c", ghostA: "#ffe45c", ghostB: "#3d5afe" },
        { bg: "#ffe45c", ink: "#1c0a26", accent: "#b8003f", sub: "#4a3a10", tint: "#fff08f", plate: "#b8003f", plateInk: "#ffffff", ghostA: "#ff6fae", ghostB: "#3d5afe" },
        { bg: "#6fd3ff", ink: "#10183a", accent: "#8a0046", sub: "#18325a", tint: "#8cdcff", plate: "#10183a", plateInk: "#ffe45c", ghostA: "#ff6fae", ghostB: "#ffe45c" },
        { bg: "#4b1fa8", ink: "#fff4fb", accent: "#ffe45c", sub: "#e3d6ff", tint: "#5a2cbb", plate: "#ffe45c", plateInk: "#2b0f63", ghostA: "#ff6fae", ghostB: "#6fd3ff" },
        { bg: "#86f0c8", ink: "#0f1a2b", accent: "#a3003f", sub: "#1f4a3c", tint: "#a0f5d5", plate: "#0f1a2b", plateInk: "#86f0c8", ghostA: "#ff6fae", ghostB: "#4b1fa8" },
      ] as readonly LyricPalette[],
      arrangements: ["center", "stack"] as readonly LyricArrangement[],
      decor: ["dots", "bars", "orb"] as readonly LyricDecor[],
    },
    /** Emphasis: a white or dark sticker outline round the accent word. */
    engine: { faces: { zh: "kuaile", ja: "maru", latin: "maru" }, stroke: null, gradientText: null, glow: null,
      blur: null } as EngineSlots,
  },
  /** Night: black and deep-blue grounds, acid and magenta cuts; pixel and oblique faces (DotGothic16 / 得意黑); chromatic ghosts, scanlines, grain, glitch cuts, stepped motion. */
  night: {
    background: "#07070a", signature: "#9a9aa6",
    poster: { ...POSTER, orb: false },
    motion: {
      ...MOTION,
      palette: [
        { bg: "#07070a", ink: "#f2f2f2", accent: "#c6ff00", sub: "#9a9aa6", tint: "#15151c", plate: "#c6ff00", plateInk: "#07070a", ghostA: "#ff2bd6", ghostB: "#00e5ff" },
        { bg: "#0a0f2c", ink: "#e8f0ff", accent: "#00e5ff", sub: "#a4acd0", tint: "#141a3d", plate: "#00e5ff", plateInk: "#0a0f2c", ghostA: "#ff2bd6", ghostB: "#c6ff00" },
        { bg: "#c6ff00", ink: "#07070a", accent: "#5a00c8", sub: "#2c3a00", tint: "#b4ea00", plate: "#07070a", plateInk: "#c6ff00", ghostA: "#ff2bd6", ghostB: "#00a0e9" },
        { bg: "#ff2e93", ink: "#07070a", accent: "#1b1464", sub: "#2a0418", tint: "#ff4ba3", plate: "#07070a", plateInk: "#ff2e93", ghostA: "#00e5ff", ghostB: "#c6ff00" },
      ] as readonly LyricPalette[],
      arrangements: ["left", "center"] as readonly LyricArrangement[],
      decor: ["bars", "frame", "dots"] as readonly LyricDecor[],
    },
    /** Emphasis: an accent glow (neon). */
    engine: { faces: { zh: "grin", ja: "dot", latin: "dot" }, stroke: null, gradientText: null, glow: { radiusEm: 0.28, alpha: 0.55, gain: 1.4 },
      blur: null } as EngineSlots,
  },
} as const;
export type LyricsVariant = keyof typeof LYRICS_STYLES;
export const LYRICS_VARIANTS = Object.keys(LYRICS_STYLES) as LyricsVariant[];
export type LyricsStyle = (typeof LYRICS_STYLES)[LyricsVariant];
/** The lyric style of a plan's variant (Stage for anything unknown). */
export const lyricsVariant = (variant: string): LyricsVariant => (variant in LYRICS_STYLES ? variant as LyricsVariant : "classic");
export type LyricArrangement = "center" | "left" | "stack" | "vertical";
export type LyricDecor = "bars" | "orb" | "frame" | "dots" | "rules" | "sun" | "none";

/** The script a card's display face is chosen for. */
export function lyricScript(text: string): keyof LyricFaces {
  return /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) ? "ja" : /\p{Script=Han}/u.test(text) ? "zh" : "latin";
}
/** The named face a lyric card of `variant` asks for (compose.ts opens it and checks it draws the lyric). */
export function lyricFaceNames(variant: string, sourceText: string): string[] {
  const faces = (LYRICS_STYLES[lyricsVariant(variant)].engine as EngineSlots).faces;
  return faces ? [faces[lyricScript(sourceText)]] : [];
}

/** The cut layouts (lyric-video.ts): how one cut's words sit on the screen. */
export const LYRIC_LAYOUTS = ["center", "low", "stack", "steps", "giant", "focus", "diagonal", "split", "mix", "vertical", "echo", "jump", "labels", "sweep",
  "numeral", "caption", "cascade", "frame", "ticker", "wide", "wave"] as const;
export type LyricLayout = (typeof LYRIC_LAYOUTS)[number];
/** Entrances: per glyph (rise, drop, slide, pop, focus, flicker, type), per plate (zoom, pop), or of the whole block (wipe, slice). */
export const LYRIC_ENTRANCES = ["rise", "drop", "slide", "pop", "focus", "flicker", "type", "zoom", "wipe", "slice"] as const;
export type LyricEntrance = (typeof LYRIC_ENTRANCES)[number];
/** How the block moves while it holds. */
export type LyricHold = "still" | "drift" | "float" | "breathe" | "jitter";
/** How a cut replaces the one before it. */
export type LyricTransition = "none" | "cut" | "wipe-l" | "wipe-r" | "wipe-u" | "wipe-d" | "slice" | "flash" | "swap" | "glitch" | "fade";
type Weights<K extends string> = Partial<Record<K, number>>;

/**
 * The motion vocabulary per style (never scaled with the canvas): timing in
 * ms and em of the glyph size, the weights the planner draws layouts,
 * entrances, holds and transitions with, the chromatic ghost passes, the
 * texture over the picture, `chunk` (the share of lines of six units or more
 * broken into word chunks, a cut each), `koma` (motion quantised to this many drawings a
 * second, 0 for smooth) and `bpm` (cut lengths snap to beats of this tempo;
 * decor and ghosts pulse on them).
 */
export const LYRICS_MOTION = {
  classic: {
    enterMs: 420, staggerMs: 45, maxStaggerMs: 620, typeMs: 55, exitMs: 220, transitionMs: 300, punchMs: 480,
    driftEm: 0.22, riseEm: 0.6, slideEm: 0.8, dropEm: 0.8, exitEm: 0.3, koma: 0, bpm: 120, chunk: 0.55, hud: false,
    layouts: { center: 0.5, low: 0.8, stack: 0.7, steps: 1.2, giant: 1.6, focus: 1.1, diagonal: 1.1, split: 1.1, mix: 0.9, echo: 0.8, jump: 1.1, labels: 0.9, sweep: 1, numeral: 0.8, cascade: 0.8, frame: 0.5, ticker: 0.9, wide: 0.3, wave: 0.2 } as Weights<LyricLayout>,
    entrances: { rise: 1, drop: 0.8, slide: 1, pop: 0.5, focus: 0.4, zoom: 1, wipe: 1, slice: 1.2 } as Weights<LyricEntrance>,
    holds: { still: 0.3, drift: 1, float: 0.5, breathe: 0.9 } as Weights<LyricHold>,
    transitions: { cut: 1.4, "wipe-l": 0.4, "wipe-r": 0.4, "wipe-u": 0.3, "wipe-d": 0.3, slice: 1, flash: 0.5, swap: 0.6 } as Weights<LyricTransition>,
    /** Chromatic ghosts: the share of cuts that get them, their opacity and offset (em), the offset at a spike (cut start, beats). */
    ghosts: { share: 0.45, alpha: 0.8, offsetEm: 0.03, spike: 3.2 },
    texture: { grain: 0.07, scanlines: 0, vignette: 0.28, paper: 0 },
  },
  editorial: {
    enterMs: 680, staggerMs: 70, maxStaggerMs: 900, typeMs: 70, exitMs: 320, transitionMs: 480, punchMs: 640,
    driftEm: 0.08, riseEm: 0.3, slideEm: 0.4, dropEm: 0.4, exitEm: 0, koma: 0, bpm: 84, chunk: 0.12, hud: false,
    layouts: { center: 1, low: 1, vertical: 1.4, mix: 1.1, focus: 1, caption: 1.3, wide: 1, echo: 0.5, sweep: 0.5, frame: 0.6, numeral: 0.6, cascade: 0.4, giant: 0.5 } as Weights<LyricLayout>,
    entrances: { rise: 1, focus: 1.4, slide: 0.5, type: 0.3, wipe: 0.6 } as Weights<LyricEntrance>,
    holds: { still: 0.6, drift: 1, float: 0.8, breathe: 0.4 } as Weights<LyricHold>,
    transitions: { fade: 1.6, "wipe-l": 0.4, "wipe-r": 0.3, cut: 0.4 } as Weights<LyricTransition>,
    ghosts: { share: 0, alpha: 0.6, offsetEm: 0.02, spike: 2 },
    texture: { grain: 0.05, scanlines: 0, vignette: 0.12, paper: 0.06 },
  },
  pop: {
    enterMs: 360, staggerMs: 50, maxStaggerMs: 560, typeMs: 50, exitMs: 200, transitionMs: 260, punchMs: 440,
    driftEm: 0.15, riseEm: 0.7, slideEm: 0.8, dropEm: 1.1, exitEm: 0.4, koma: 12, bpm: 128, chunk: 0.6, hud: false,
    layouts: { center: 0.4, stack: 0.7, steps: 1.2, giant: 1.3, jump: 1.5, labels: 1.5, wave: 1.5, cascade: 1, split: 1, echo: 0.6, ticker: 0.8, frame: 0.7, sweep: 0.8, diagonal: 0.7, focus: 0.5 } as Weights<LyricLayout>,
    entrances: { pop: 1.5, drop: 1.2, rise: 0.8, zoom: 1, slice: 0.5, wipe: 0.4 } as Weights<LyricEntrance>,
    holds: { float: 1.2, breathe: 1, still: 0.2 } as Weights<LyricHold>,
    transitions: { cut: 1, slice: 1, swap: 1, flash: 0.6, "wipe-l": 0.3, "wipe-r": 0.3 } as Weights<LyricTransition>,
    ghosts: { share: 0.35, alpha: 0.9, offsetEm: 0.035, spike: 2.6 },
    texture: { grain: 0.05, scanlines: 0, vignette: 0, paper: 0 },
  },
  night: {
    enterMs: 380, staggerMs: 40, maxStaggerMs: 520, typeMs: 45, exitMs: 180, transitionMs: 220, punchMs: 420,
    driftEm: 0.12, riseEm: 0.4, slideEm: 0.6, dropEm: 0.6, exitEm: 0, koma: 12, bpm: 132, chunk: 0.6, hud: true,
    layouts: { low: 1, center: 0.6, focus: 1.2, echo: 1.3, ticker: 1.2, wide: 1, numeral: 1, giant: 1.1, diagonal: 0.8, split: 0.8, sweep: 0.6, steps: 0.8, caption: 0.5, frame: 0.6 } as Weights<LyricLayout>,
    entrances: { flicker: 1.4, type: 0.8, slice: 1, wipe: 0.8, zoom: 0.6, rise: 0.5, focus: 0.3 } as Weights<LyricEntrance>,
    holds: { jitter: 1, drift: 0.6, still: 0.4 } as Weights<LyricHold>,
    transitions: { glitch: 1.6, cut: 0.8, slice: 0.6, flash: 0.5 } as Weights<LyricTransition>,
    ghosts: { share: 1, alpha: 0.85, offsetEm: 0.035, spike: 3.4 },
    texture: { grain: 0.09, scanlines: 0.2, vignette: 0.35, paper: 0 },
  },
} as const;

/** How long a cut stays: reading time per character, clamped per cut. A
 * lyric-motion MP4 is a short video in its own right and may run to `maxMs`
 * (30 s: a tweet or a short paragraph at a readable pace); a GIF is capped by
 * the longest animation other templates make (`gifMaxMs`, a scroll:
 * TEMPLATE_SCROLL start + max + end, 14.4 s) and by the frame-memory budget
 * (render.ts TEMPLATE_GIF_FRAME_BUDGET at the narrowest 360 px width). Too
 * many cuts first share screens (two cuts per screen); if that is still too
 * long the render stops with an explicit error (lyric-too-long). */
export const LYRICS_TIMING = {
  cjkMs: 350, latinMs: 180, minCutMs: 1100, maxCutMs: 3600, titleMs: 1800, introMs: 200, finalHoldMs: 1200,
  /** Prose is read, not sung: a prose cut is never squeezed below this much per character (about 7 CJK or 16 Latin characters a second). */
  proseCjkMs: 140, proseLatinMs: 60,
  maxMs: 30_000, gifMaxMs: 14_400, fps: 30, gifFrameBudget: 128 * 1024 * 1024, gifMinWidth: 360,
} as const;

/* ───────────── Randomness ───────────── */
export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** mulberry32: a small deterministic generator. */
export function generator(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(random: () => number, list: readonly T[], avoid?: T): T => {
  const pool = list.length > 1 && avoid !== undefined ? list.filter((item) => item !== avoid) : list;
  return pool[Math.floor(random() * pool.length)]!;
};

/* ───────────── Glyphs, tokens, rows ───────────── */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const graphemes = (text: string): string[] => [...graphemeSegmenter.segment(text)].map((part) => part.segment);
export const NO_LINE_START = /^[，。、；：？！）」』”’》〉】〕…—·,.;:?!)\]}%％‰~～]$/u;
const NO_LINE_END = /^[（「『“‘《〈【〔(\[{]$/u;
export const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯ー・]/u;
export const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HIRAGANA = /^[\p{Script=Hiragana}ー]$/u;
/** Chinese particles that stay with the word before them. */
const PARTICLE = /^[的地得了着过吗呢吧啊呀么嘛哦]$/u;
/** Glyphs that stand upright in a vertical column (no Latin, no brackets or ー that would have to turn). */
const VERTICAL_SAFE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々〆〇，。、！？・\s]$/u;
/** Punctuation set in the top-right corner of its cell in a vertical column. */
export const CORNER = /^[，。、．]$/u;

export interface Glyph { text: string; size: number; bold: boolean; color: string; emph: boolean; paint?: TextPaint; face?: string }
export interface Token { glyphs: Glyph[]; width: number; trail: number }
export interface Row { tokens: Token[]; width: number; height: number; base: number }

export class Typesetter {
  constructor(private readonly m: TemplateMeasure, private readonly leading: number) {}
  lh(size: number, bold: boolean, leading = this.leading, face?: string): number { return Math.ceil(this.m.lineHeight(size, bold, face) * leading); }
  /** Where a glyph's baseline sits below the top of its line box (Noto's ascender). */
  base(size: number): number { return Math.round(size * 1.16); }
  width(glyphs: readonly Glyph[]): number {
    let width = 0, run = "", size = glyphs[0]?.size ?? 0, bold = glyphs[0]?.bold ?? false, face = glyphs[0]?.face;
    for (const g of glyphs) {
      if (g.size !== size || g.bold !== bold || g.face !== face) { width += this.m.width(run, size, bold, face); run = ""; size = g.size; bold = g.bold; face = g.face; }
      run += g.text;
    }
    return width + (run ? this.m.width(run, size, bold, face) : 0);
  }
  /** Words (ICU, so CJK splits between words), closing punctuation kept with the word before, opening with the word after, spaces trailing. */
  tokens(glyphs: readonly Glyph[]): Token[] {
    const offsets: number[] = [];
    let text = "";
    for (const g of glyphs) { offsets.push(text.length); text += g.text; }
    const byOffset = new Map(offsets.map((offset, index) => [offset, index]));
    let starts: number[] = [];
    for (const part of new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)) {
      const index = byOffset.get(part.index);
      if (index !== undefined) starts.push(index);
    }
    // Japanese breaks between phrases, not inside them: a phrase ends where
    // its kana tail (okurigana, particles) meets the next kanji or katakana.
    if (glyphs.some((g) => KANA.test(g.text))) {
      starts = starts.filter((i) => {
        const before = glyphs[i - 1]?.text ?? " ", here = glyphs[i]!.text;
        return i === 0 || !before.trim() || !here.trim() || !WIDE.test(before) || !WIDE.test(here) || (HIRAGANA.test(before) && !HIRAGANA.test(here));
      });
    }
    // Chinese: runs of one-character words stay together (小|黄|花 is one unit).
    if (!glyphs.some((g) => KANA.test(g.text))) {
      const han = (i: number) => /\p{Script=Han}/u.test(glyphs[i]?.text ?? "");
      starts = starts.filter((i, k) => {
        const next = starts[k + 1] ?? glyphs.length, prev = starts[k - 1];
        return !(k > 0 && next - i === 1 && prev !== undefined && i - prev === 1 && han(i) && han(i - 1) && !PARTICLE.test(glyphs[i - 1]!.text));
      });
    }
    const groups: Glyph[][] = [];
    for (const [k, start] of starts.entries()) {
      const group = glyphs.slice(start, starts[k + 1] ?? glyphs.length);
      const last = groups.at(-1);
      const joined = group.map((g) => g.text).join("");
      if (last && (!joined.trim() || NO_LINE_START.test(group[0]!.text) || NO_LINE_END.test(last.at(-1)!.text) || PARTICLE.test(joined))) { last.push(...group); continue; }
      groups.push([...group]);
    }
    // Words that lead into the next never end a row: an article, a possessive
    // or a short preposition (the|release).
    const kana = glyphs.some((g) => KANA.test(g.text));
    const textOf = (group: readonly Glyph[]) => group.map((g) => g.text).join("");
    const han = (group: readonly Glyph[] | undefined) => Boolean(group) && /^\p{Script=Han}+$/u.test(textOf(group!));
    for (let k = groups.length - 2; k >= 0; k--) {
      if (/^(?:the|a|an|to|of|my|your|our|their|his|her|its|in|on|at|by)\s+$/i.test(textOf(groups[k]!)) && /^[\p{Script=Latin}\d'‘"“(]/u.test(groups[k + 1]![0]!.text)) groups.splice(k, 2, [...groups[k]!, ...groups[k + 1]!]);
    }
    if (!kana) {
      // Chinese: a place word stays with its noun (地铁|上), a measure word with
      // its number and a short noun after it (每一|位, 一只|猫, 那只|猫), a lone
      // character with a short word after it (新|版本, 在|周五).
      for (let k = groups.length - 1; k > 0; k--) {
        const word = textOf(groups[k]!);
        const place = /^[上里中内外]$/u.test(word) && han(groups[k - 1]);
        const measure = /^[个位只条张次件本句首场份点些种样双对版]/u.test(word) && /[一二三四五六七八九十百千万两几每这那哪半]$/u.test(textOf(groups[k - 1]!));
        if (place || (measure && word.length === 1)) groups.splice(k - 1, 2, [...groups[k - 1]!, ...groups[k]!]);
      }
      for (let k = 0; k + 1 < groups.length; k++) {
        const word = textOf(groups[k]!), next = groups[k + 1]!;
        const counted = /^[一二三四五六七八九十两几每这那哪半]?[一二三四五六七八九十两几每这那哪半][个位只条张次件本句首场份点些种样双对版]$/u.test(word);
        const lone = groups[k]!.length === 1 && han(groups[k]) && !PARTICLE.test(word);
        const nextHan = next.filter((g) => /\p{Script=Han}/u.test(g.text)).length;
        if ((counted || lone) && /^\p{Script=Han}/u.test(next[0]!.text) && nextHan >= 1 && nextHan <= 2) groups.splice(k, 2, [...groups[k]!, ...next]);
      }
    }
    return groups.map((group) => {
      let cut = group.length;
      while (cut > 0 && !group[cut - 1]!.text.trim()) cut--;
      const width = this.width(group);
      return { glyphs: group, width, trail: width - this.width(group.slice(0, cut)) };
    });
  }
  /** A CJK phrase too wide for a row, as its words (ICU): Japanese only before
   * a kanji or katakana run, a word of three kana or more (みなさん,
   * ありがとう) or a polite ending (ございます); closing marks stay attached. */
  words(token: Token): Token[] {
    const glyphs = token.glyphs, offsets: number[] = [];
    let joined = "";
    for (const g of glyphs) { offsets.push(joined.length); joined += g.text; }
    const byOffset = new Map(offsets.map((offset, index) => [offset, index]));
    const japanese = glyphs.some((g) => KANA.test(g.text));
    const cuts: number[] = [];
    // Japanese: a katakana word ends where its kana ending begins (リリース|しました).
    if (japanese) for (let i = 1; i < glyphs.length; i++) {
      if (/^[\p{Script=Katakana}ー]$/u.test(glyphs[i - 1]!.text) && /^\p{Script=Hiragana}$/u.test(glyphs[i]!.text) && glyphs.length - i >= 3) cuts.push(i);
    }
    for (const part of new Intl.Segmenter(japanese ? "ja" : "zh", { granularity: "word" }).segment(joined)) {
      const index = byOffset.get(part.index);
      if (!index || NO_LINE_START.test(glyphs[index]!.text) || NO_LINE_END.test(glyphs[index - 1]!.text)) continue;
      if (japanese && HIRAGANA.test(glyphs[index]!.text) && [...part.segment].length < 3 && !/^(?:ござい|くださ|いただ)/u.test(joined.slice(part.index))) continue;
      cuts.push(index);
    }
    const bounds = [0, ...[...new Set(cuts)].sort((x, y) => x - y), glyphs.length];
    const out: Token[] = [];
    for (let k = 0; k + 1 < bounds.length; k++) {
      const group = glyphs.slice(bounds[k], bounds[k + 1]);
      if (!group.length) continue;
      const width = this.width(group);
      let cut = group.length;
      while (cut > 0 && !group[cut - 1]!.text.trim()) cut--;
      out.push({ glyphs: group, width, trail: width - this.width(group.slice(0, cut)) });
    }
    return out;
  }
  /** Greedy rows no wider than `max`; a CJK word too wide splits into its words, then characters; a Latin one means it does not fit (undefined). */
  wrap(tokens: readonly Token[], max: number, split = true): Row[] | undefined {
    const rows: Token[][] = [[]];
    let width = 0;
    const queue = [...tokens];
    while (queue.length) {
      const token = queue.shift()!;
      if (token.width - token.trail > max + 0.01) {
        // A CJK run splits into characters; so does a long address or identifier (a URL, an e-mail, a token), never a word.
        const text = token.glyphs.map((g) => g.text).join("").trim();
        const identifier = [...text].length > 12 && /[/._@:?=&#%~+\\-]|\d/.test(text);
        if (!split || !(identifier || token.glyphs.every((g) => WIDE.test(g.text) || NO_LINE_START.test(g.text) || !g.text.trim()))) return;
        if (token.glyphs.length === 1) return;
        // Words first (a phrase breaks between its words), characters when that is not enough.
        const words = identifier ? [] : this.words(token);
        // A Japanese word is never split (a smaller size instead); a Chinese word, an address or an identifier may break between characters.
        if (words.length <= 1 && !identifier && token.glyphs.some((g) => KANA.test(g.text))) return;
        queue.unshift(...(words.length > 1 ? words : token.glyphs.map((g) => { const w = this.width([g]); return { glyphs: [g], width: w, trail: g.text.trim() ? 0 : w }; })));
        continue;
      }
      const row = rows.at(-1)!;
      if (row.length && width + token.width - token.trail > max + 0.01) { rows.push([token]); width = token.width; continue; }
      row.push(token); width += token.width;
    }
    return rows.filter((row) => row.length).map((row) => this.row(row));
  }
  row(tokens: Token[]): Row {
    const glyphs = tokens.flatMap((t) => t.glyphs);
    const width = tokens.reduce((w, t) => w + t.width, 0) - (tokens.at(-1)?.trail ?? 0);
    return { tokens, width, height: Math.max(...glyphs.map((g) => this.lh(g.size, g.bold, this.leading, g.face))), base: Math.max(...glyphs.map((g) => this.base(g.size))) };
  }
  /** One row as lines, one per run of the same size, weight, colour and emphasis. Trailing spaces are not drawn. */
  emit(row: Row, x: number, top: number, extra: Partial<TemplateLine> = {}): TemplateLine[] {
    const glyphs = row.tokens.flatMap((t) => t.glyphs);
    while (glyphs.length && !glyphs.at(-1)!.text.trim()) glyphs.pop();
    const out: TemplateLine[] = [];
    let cx = x, run: Glyph[] = [];
    const flush = () => {
      if (!run.length) return;
      const g = run[0]!, text = run.map((r) => r.text).join(""), width = this.width(run);
      out.push({ text, x: cx, y: top + row.base - this.base(g.size), width, size: g.size, height: this.lh(g.size, g.bold, this.leading, g.face), bold: g.bold, color: g.color, group: 0,
        boldAt: run.map(() => g.bold), ...extra, ...(g.emph ? { emphasis: true } : {}), ...(g.paint ? { paint: g.paint } : {}), ...(g.face ? { face: g.face } : {}) });
      cx += width; run = [];
    };
    for (const g of glyphs) {
      const r = run[0];
      if (r && (r.size !== g.size || r.bold !== g.bold || r.color !== g.color || r.emph !== g.emph || r.face !== g.face)) flush();
      run.push(g);
    }
    flush();
    return out;
  }
}

/** Glyphs of `text` (normalized as drawn), emphasised ranges at `emphSize` in `accent` (with `paint`, when the style paints emphasis). */
export function glyphsOf(text: string, ranges: readonly (readonly [number, number])[] | undefined, size: number, emphSize: number, bold: boolean, ink: string, accent: string, paint?: TextPaint, face?: string): Glyph[] {
  return graphemes(normalizeText(text, "plain")).map((g, i) => {
    const emph = Boolean(ranges?.some(([a, b]) => i >= a && i < b)) && g.trim() !== "";
    return { text: g, size: emph ? emphSize : size, bold, color: emph ? accent : ink, emph, ...(emph && paint ? { paint } : {}), ...(face ? { face } : {}) };
  });
}

/* ───────────── Paint (Pocket Motion v0.4.0) ───────────── */
/** `color` moved toward `toward` (0..1 of the way) in OKLCH lightness and chroma, keeping `toward`'s hue: used to pull a gradient stop back toward the accent. */
function mixToward(color: string, toward: string, t: number): string {
  const a = hexOklch(color), b = hexOklch(toward);
  return oklchHex({ l: a.l + (b.l - a.l) * t, c: a.c + (b.c - a.c) * t, h: a.h + (((b.h - a.h + 540) % 360) - 180) * t });
}
/** `stop` pulled toward `accent` just far enough to keep `ratio` against `ground` (the accent itself if nothing short of it does). */
function keepContrast(stop: string, accent: string, ground: string, ratio: number): string {
  if (contrastRatio(stop, ground) >= ratio) return stop;
  if (contrastRatio(accent, ground) < ratio) return accent;
  let lo = 0, hi = 1;
  for (let i = 0; i < 16; i++) { const mid = (lo + hi) / 2; if (contrastRatio(mixToward(stop, accent, mid), ground) >= ratio) hi = mid; else lo = mid; }
  return mixToward(stop, accent, hi);
}
/** Alpha appended to #rrggbb. */
export const withAlpha = (color: string, alpha: number) => `${color.slice(0, 7)}${Math.round(Math.min(1, Math.max(0, alpha)) * 255).toString(16).padStart(2, "0")}`;
/** The contrast an emphasised run needs at `size` on a `width` canvas (checks.ts: large text 3:1, body 4.5:1). */
const neededRatio = (size: number, width: number) => size * CHECK_THRESHOLDS.readability.referenceWidth / width >= CHECK_THRESHOLDS.contrast.largeSize ? CHECK_THRESHOLDS.contrast.large : CHECK_THRESHOLDS.contrast.body;

/**
 * How the style paints an emphasised run of `size` px in `palette`, or
 * undefined for a flat accent. Gradient stops are derived from the accent in
 * OKLCH and pulled back toward it until each keeps the contrast the checks
 * ask for; the outline takes the accent; the glow is the accent, translucent.
 * Hollow outlines only on type at the large size (thin rings below it do not read);
 * a glow only where the accent is lighter than the ground, and never in a GIF.
 */
export function emphasisPaint(engine: EngineSlots, palette: LyricPalette, size: number, width: number, format?: TemplateFormat): TextPaint | undefined {
  const need = neededRatio(size, width);
  const accent = hexOklch(palette.accent);
  const g = engine.gradientText, st = engine.stroke, gl = engine.glow;
  const hollow = st?.hollow && need === CHECK_THRESHOLDS.contrast.large;
  const paint: { -readonly [K in keyof TextPaint]: TextPaint[K] } = {};
  if (g) {
    const top = oklchHex({ l: Math.min(0.98, accent.l + g.lightTop), c: accent.c, h: accent.h });
    const foot = oklchHex({ l: Math.max(0.05, accent.l + g.lightFoot), c: accent.c, h: (accent.h + g.hueTurn + 360) % 360 });
    // Each stop keeps the contrast against the ground and against its tint (a poster's gradient ground runs from one to the other).
    const keep = (stop: string) => keepContrast(keepContrast(stop, palette.accent, palette.bg, need), palette.accent, palette.tint, need);
    paint.gradient = { from: keep(top), to: keep(foot), fromAt: 0.22, toAt: 0.86 };
  }
  if (st && (hollow || !st.hollow)) paint.stroke = { width: Math.max(1.5, Math.round(size * st.widthEm * 2) / 2), color: palette.accent, position: st.position, ...(hollow ? { hollow: true } : {}) };
  // A glow is light: only an accent lighter than its ground glows (on the yellow ground a red glow would be a smear).
  // Not in a GIF: 256 colours step a soft halo into a visible box.
  if (gl && format !== "gif" && luminance(palette.accent) > luminance(palette.bg)) paint.glow = { radius: Math.round(size * gl.radiusEm), color: withAlpha(palette.accent, gl.alpha), gain: gl.gain };
  return Object.keys(paint).length ? paint : undefined;
}

/* ───────────── Context and result ───────────── */
export interface LyricsContext {
  readonly plan: TemplatePlan;
  readonly content: LyricsContent;
  readonly measure: TemplateMeasure;
  /** Named faces the measurer has and that draw every glyph (compose.ts TEMPLATE_FACES); the style's face slot applies only to these. */
  readonly faces: readonly string[];
  readonly width: number;
  /** The frame height (the minimum canvas height). */
  readonly height: number;
  /** The height type is sized against. */
  readonly fit: number;
  readonly format: TemplateFormat;
  /** The measurer's baked sizes (compose.ts SIZES), ascending. */
  readonly sizes: readonly number[];
  readonly minBody: number;
  readonly minSecondary: number;
  /** Room the signature footer needs above the bottom margin. */
  footerRoom(): number;
  /** The style, already scaled to this canvas. */
  readonly style: LyricsStyle;
  readonly variant: LyricsVariant;
  /** The card's font pair (type plates are drawn from it when no display face applies; none from Noto). */
  readonly font?: TemplateFont;
}
export interface LyricsResult {
  background: string;
  margin: number;
  lines: TemplateLine[];
  shapes: TemplateRect[];
  /** Full-bleed ground layers stretched to the canvas height (pinned). */
  backdrop: TemplateRect[];
  /** Shapes that stay where they are when the canvas grows (all of them in a video). */
  pinned: TemplateRect[];
  bottom: number;
  signatureColor: string;
  signatureAlign: "left" | "center";
  program?: LyricsProgram;
}

/** A lyric video: cuts in time order, each with its lines and shapes (indices into the layout). */
export interface LyricsProgram {
  readonly durationMs: number;
  readonly frameHeight: number;
  readonly cuts: readonly LyricsCut[];
  /** Motion quantised to this many drawings a second ("koma-uchi"; 0: smooth). */
  readonly koma: number;
  /** One beat in ms: cut lengths snap to beats, ghosts and decor pulse on them. */
  readonly beatMs: number;
  /** Texture over the picture (opacities; 0 = none). */
  readonly texture: { readonly grain: number; readonly scanlines: number; readonly vignette: number; readonly paper: number };
}
/** What a shape of a cut is, and how it comes in. */
export type LyricShapeRole = "field" | "band" | "plate" | "rule" | "marker" | "frame" | "decor";
export type LyricShapeMotion = "none" | "slide-l" | "slide-r" | "slide-u" | "slide-d" | "grow-x" | "grow-x-r" | "grow-x-c" | "grow-y" | "pop" | "fade" | "pulse";
export interface LyricsShape {
  readonly shape: number; readonly role: LyricShapeRole; readonly motion: LyricShapeMotion;
  /** ms after the cut's start. */
  readonly delay: number;
  /** Degrees, clockwise (a tilted band). */
  readonly rotate?: number;
  /** Drawn over the lyric (a frame), not under it. */
  readonly over?: boolean;
}
/** Decorative text (ghost repeats, tickers, big numerals): how it moves. */
export type LyricDecorMotion = "fade" | "scroll-l" | "scroll-r" | "settle" | "rise";
export interface LyricsCut {
  /** When the cut's ground starts coming in, when its text starts entering, when it is covered (the next cut's start; the duration for the last). */
  readonly inAt: number; readonly start: number; readonly hold: number; readonly end: number;
  readonly palette: LyricPalette;
  readonly layout: LyricLayout; readonly entrance: LyricEntrance; readonly motion: LyricHold; readonly transition: LyricTransition;
  readonly bang: boolean;
  /** Lyric runs (entering glyph by glyph, or plate by plate), in reading order. */
  readonly text: readonly number[];
  /** Notes, labels and the credit: fade in with the cut. */
  readonly quiet: readonly number[];
  /** Decorative lines (never counted as the text): ghost repeats, tickers, the big numeral. */
  readonly decor: readonly { readonly line: number; readonly motion: LyricDecorMotion; readonly delay: number }[];
  readonly ground: number;
  readonly shapes: readonly LyricsShape[];
  /** The lyric block's box (holds turn about its centre) and the box of everything the cut writes. */
  readonly box: Box; readonly outer: Box;
  /** The lyric's type size (entrance distances, drift and shake scale with it). */
  readonly glyphSize: number;
  /** Chromatic ghost passes behind the lyric. */
  readonly chroma: boolean;
  /** The signature's colour on this cut (the scheme under the footer). */
  readonly signature: string;
  /** A chunk of a line (lyric-video.ts chunked): its index; absent for a whole line. */
  readonly part?: number;
}
export interface Box { x: number; y: number; width: number; height: number }

/** The named face the lyric is set in, when the style has one for the card's script and the card can use it (else the card's font pair). Notes, labels and credits keep the pair. */
export function faceOf(ctx: LyricsContext, role: "display" | "text"): string | undefined {
  if (role === "text") return undefined;
  const name = lyricFaceNames(ctx.variant, ctx.plan.sourceText)[0];
  return name && ctx.faces.includes(name) ? name : undefined;
}

/* ───────────── Entry point ───────────── */
export function layoutLyrics(ctx: LyricsContext): LyricsResult {
  return ctx.plan.motion === "none" ? poster(ctx) : video(ctx);
}

/** Every character upright-safe for a vertical column. */
export const verticalSafe = (text: string) => graphemes(text).every((g) => VERTICAL_SAFE.test(g));
export const snapUp = (sizes: readonly number[], n: number) => sizes.find((s) => s >= n) ?? sizes.at(-1)!;

/* ───────────── Poster ───────────── */
function poster(ctx: LyricsContext): LyricsResult {
  const { content, style, width: W } = ctx;
  const s = style.poster;
  const margin = s.margin, inner = W - 2 * margin;
  const t = new Typesetter(ctx.measure, s.leading);
  const secondary = (n: number) => Math.max(ctx.minSecondary, n);
  const allLines = content.stanzas.flatMap((stanza) => stanza.lines);
  // A display face has one weight: set in it, nothing is bold.
  const face = faceOf(ctx, "display"), bold = face ? false : s.bold;
  const boxH = ctx.fit - 2 * margin - ctx.footerRoom();
  // The poster's colours: one of the style's palette, picked by the lyrics (the same lyrics, the same poster).
  const pal = style.motion.palette[seedOf(`${ctx.plan.sourceText}\u0000poster`) % style.motion.palette.length]!;
  const result: LyricsResult = { background: pal.bg, margin, lines: [], shapes: [], backdrop: [], pinned: [], bottom: margin,
    signatureColor: pal.sub, signatureAlign: s.align === "center" ? "center" : "left" };
  if (s.gradient) {
    const rect: TemplateRect = { x: 0, y: 0, width: W, height: 0, color: pal.tint, radius: 0, gradient: { dir: "b", from: pal.bg, to: pal.tint } };
    result.shapes.push(rect); result.backdrop.push(rect); result.pinned.push(rect);
  }
  const vertical = s.vertical && [content.title, content.credit, ...allLines.flatMap((l) => [l.text, l.note]), ...content.stanzas.map((st) => st.label)]
    .every((text) => text === undefined || verticalSafe(text)) && !allLines.some((l) => l.note) && !content.stanzas.some((st) => st.label);
  if (vertical) {
    const done = verticalPoster(ctx, result, margin, boxH, pal);
    if (done) return done;
  }
  // What the poster sets, in order. A poem's lines are set phrase by phrase.
  type Unit = { kind: "title" | "credit" | "label" | "line" | "note"; text: string; ranges?: LyricLine["emphasis"]; gapBefore: "none" | "title" | "credit" | "stanza" | "label" | "note"; stanza: number };
  const units: Unit[] = [];
  if (content.title) units.push({ kind: "title", text: content.title, gapBefore: "none", stanza: -1 });
  if (content.credit) units.push({ kind: "credit", text: content.credit, gapBefore: content.title ? "title" : "none", stanza: -1 });
  for (const [i, stanza] of content.stanzas.entries()) {
    const head = units.length ? (i === 0 ? "credit" : "stanza") : "none";
    if (stanza.label) units.push({ kind: "label", text: stanza.label, gapBefore: head, stanza: i });
    for (const [j, line] of stanza.lines.entries()) {
      const gap = j === 0 ? (stanza.label ? "label" : head) : "none";
      const phrases = content.poem ? line.text.match(/[^，。？！、；：,.?!;:]+[，。？！、；：,.?!;:]*/gu) ?? [line.text] : [line.text];
      phrases.forEach((text, k) => units.push({ kind: "line", text, ...(line.emphasis?.length && phrases.length === 1 ? { ranges: line.emphasis } : {}), gapBefore: k === 0 ? gap : "none", stanza: i }));
      if (line.note) units.push({ kind: "note", text: line.note, gapBefore: "note", stanza: i });
    }
  }
  // Stacked posters may set lines larger than the engine can, as type plates (lyric-video.ts).
  const plate = s.stacked ? plateFaceOf(ctx, face, bold) : undefined;
  const drawable = plate && units.every((u) => u.kind !== "line" || !missingGlyphs(plate.face, normalizeText(u.text, "plain")).length);
  const plateSizes = drawable ? PLATE_SIZES.map((n) => Math.round(n * W / 1080)).filter((n) => n > Math.max(...s.sizes)) : [];
  const pt = drawable ? plateSetter(plate.face, s.leading) : undefined;
  const setterFor = (size: number) => (plateSizes.includes(size) ? pt! : t);
  const sizes = [...plateSizes, ...s.sizes.filter((size) => size >= ctx.minBody)];
  /** A lyric line at `size`: at most `maxRows` rows, balanced when it wraps. */
  const tokenCache = new Map<string, Token[]>(), rowCache = new Map<string, Row[] | undefined>();
  const rowsFor = (u: Unit, size: number, emph: number, width: number, maxRows: number): Row[] | undefined => {
    const key = `${units.indexOf(u)}|${size}|${emph}|${width}|${maxRows}`;
    if (rowCache.has(key)) return rowCache.get(key);
    const tokenKey = `${units.indexOf(u)}|${size}|${emph}`;
    const tokens = tokenCache.get(tokenKey) ?? setterFor(size).tokens(glyphsOf(u.text, u.ranges, size, face || plateSizes.includes(size) ? size : emph, bold, pal.ink, pal.accent, emphasisPaint(style.engine, pal, face || plateSizes.includes(size) ? size : emph, W, ctx.format), face));
    tokenCache.set(tokenKey, tokens);
    const result = balancedRows(tokens, width, maxRows);
    rowCache.set(key, result);
    return result;
  };
  const balancedRows = (tokens: Token[], width: number, maxRows: number): Row[] | undefined => {
    const tt = setterFor(tokens[0]?.glyphs[0]?.size ?? 0);
    let rows = tt.wrap(tokens, width);
    if (!rows || rows.length > maxRows) return;
    if (rows.length > 1) {
      let lo = Math.floor(width * 0.4), hi = width;
      while (hi - lo > 6) { const mid = Math.floor((lo + hi) / 2); const trial = tt.wrap(tokens, mid, false); if (trial && trial.length <= rows.length) hi = mid; else lo = mid; }
      rows = tt.wrap(tokens, hi, false) ?? rows;
    }
    return rows;
  };
  const quietCache = new Map<Unit, Row[] | undefined>();
  const quiet = (u: Unit): Row[] | undefined => {
    if (quietCache.has(u)) return quietCache.get(u);
    const rows = quietRows(u);
    quietCache.set(u, rows);
    return rows;
  };
  const quietRows = (u: Unit): Row[] | undefined => {
    const size = u.kind === "title" ? secondary(s.title.size) : secondary(u.kind === "credit" ? s.credit.size : u.kind === "label" ? s.label.size : s.note.size);
    return t.wrap(t.tokens(glyphsOf(u.text, undefined, size, size, u.kind === "title" && !face, u.kind === "title" ? pal.accent : pal.sub, pal.accent, undefined, u.kind === "title" ? face : undefined)), inner);
  };
  type Set = { rows: Row[][]; gaps: number[]; height: number; widest: number };
  /** Everything set with `line(u)` giving a lyric unit's rows; undefined when a unit does not fit. */
  const setAll = (line: (u: Unit) => Row[] | undefined, base: number): Set | undefined => {
    const rows: Row[][] = [];
    for (const u of units) { const r = u.kind === "line" ? line(u) : quiet(u); if (!r) return; rows.push(r); }
    const lh = setterFor(base).lh(base, bold, undefined, face);
    const gap = (g: Unit["gapBefore"]) => g === "title" ? s.title.gap : g === "credit" ? s.credit.gap : g === "stanza" ? Math.round(lh * s.stanzaLeading) : g === "label" ? s.label.gap : g === "note" ? s.note.gap : 0;
    const gaps = units.map((u) => gap(u.gapBefore));
    const height = units.reduce((h, _u, k) => h + gaps[k]! + rows[k]!.reduce((n, r) => n + r.height, 0), 0);
    return { rows, gaps, height, widest: Math.max(...rows.flat().map((r) => r.width)) };
  };
  let chosen: Set | undefined;
  if (s.stacked) {
    // Stacked: every line at the largest size that fits the measure on one row,
    // or on two when that is much larger; all under a cap lowered until the
    // slab fits the frame, and within stackRatio of the smallest line.
    // Per line, largest first: the rows at each size (one row, or two).
    const bySize = new Map<Unit, { size: number; rows: Row[] }[]>();
    for (const u of units) {
      if (u.kind !== "line") continue;
      const list: { size: number; rows: Row[] }[] = [];
      for (const size of sizes) {
        const r = rowsFor(u, size, size, inner, 2);
        if (!r) continue;
        list.push({ size, rows: r });
        if (r.length === 1) break;
      }
      bySize.set(u, list);
    }
    for (const cap of sizes) {
      const own = new Map<Unit, { size: number; rows: Row[] }>();
      const options = new Map<Unit, { one?: { size: number; rows: Row[] }; two?: { size: number; rows: Row[] } }>();
      for (const [u, list] of bySize) {
        const fits = list.filter((o) => o.size <= cap);
        let one = fits.find((o) => o.rows.length === 1);
        const two = fits.find((o) => o.rows.length === 2);
        // Below the largest one-row size, a smaller cap still sets the line on one row at the cap.
        if (!one && fits.length === 0 && list.at(-1)?.rows.length === 1 && list.at(-1)!.size > cap) one = { size: cap, rows: rowsFor(u, cap, cap, inner, 1)! };
        if (one && !one.rows) one = undefined;
        options.set(u, { ...(one ? { one } : {}), ...(two ? { two } : {}) });
      }
      // Only a line much longer than the others breaks in two (and only when that makes it much larger).
      const ones = [...options.values()].flatMap((o) => (o.one ? [o.one.size] : [])).sort((a, b) => a - b);
      const median = ones[Math.floor(ones.length / 2)] ?? 0;
      for (const [u, { one, two }] of options) {
        const best = one && (!two || two.size < one.size * 1.4 || one.size >= median * 0.75) ? one : two;
        if (best) own.set(u, best);
      }
      const floor = Math.min(...[...own.values()].map((o) => o.size));
      const limit = sizes.find((n) => n <= floor * s.stackRatio) ?? floor;
      const set = setAll((u) => { const o = own.get(u); if (!o) return; return o.size > limit ? rowsFor(u, limit, limit, inner, 2) : o.rows; }, floor);
      if (set && set.height <= boxH) { chosen = set; break; }
      chosen = set ?? chosen;
    }
  } else {
    // Uniform: the largest size at which no line wraps and everything fits; a
    // larger one that wraps some lines wins only when it is much larger.
    let flat: Set | undefined, wrapped: { set: Set; size: number } | undefined, flatSize = 0;
    for (const size of sizes) {
      const emph = snapUp(ctx.sizes, size * 1.2);
      const one = setAll((u) => rowsFor(u, size, emph, inner, 1), size);
      if (one && one.height <= boxH) { flat = one; flatSize = size; break; }
      const any = setAll((u) => rowsFor(u, size, emph, inner, 3), size);
      if (any && any.height <= boxH) wrapped ??= { set: any, size };
    }
    chosen = wrapped && (!flat || wrapped.size >= flatSize * 1.3) ? wrapped.set : flat ?? wrapped?.set;
    const smallest = sizes.at(-1) ?? ctx.minBody;
    chosen ??= setAll((u) => rowsFor(u, smallest, smallest, inner, 8), smallest);
  }
  if (!chosen) throw new ComposeError("overflow", "A word of these lyrics is too wide for the card even at the smallest size. Choose a wider frame. No content was dropped.");
  // Left-aligned styles centre the block as a whole; centred styles centre every row.
  const blockX = s.align === "center" ? margin : Math.max(margin, Math.round((W - chosen.widest) / 2));
  let y = Math.max(margin, Math.round((ctx.height - ctx.footerRoom() - chosen.height) / 2));
  const top = y;
  let group = 0;
  for (const [k, u] of units.entries()) {
    y += chosen.gaps[k]!;
    for (const row of chosen.rows[k]!) {
      const x = s.align === "center" ? Math.round((W - row.width) / 2) : blockX;
      const size = row.tokens[0]?.glyphs[0]?.size ?? 0, setter = setterFor(size);
      const lines = setter.emit(row, x, y, { group: group++, ...(u.kind === "line" || u.kind === "title" ? {} : { secondary: true }) });
      result.lines.push(...(setter === t ? lines : platesFrom(plate!, lines, setter)));
      y += row.height;
    }
  }
  result.bottom = y;
  // Stage: a quiet disc in the emptiest corner, when the poster keeps its frame.
  if (s.orb && y + margin <= ctx.height) {
    const text = unionBox(result.lines.map((l) => ({ x: l.x, y: l.y, width: l.width, height: l.height })));
    const index = result.shapes.length;
    decorate("orb", W, ctx.height, margin, text, pal, style.motion, result.shapes, style.engine.blur?.decor ?? 0);
    for (const shape of result.shapes.slice(index)) result.pinned.push(shape);
  }
  return result;
}

/** CJK verse in columns, right to left: the title and author first, a wider gap between stanzas. Undefined when the columns do not fit the frame at a readable size. */
function verticalPoster(ctx: LyricsContext, result: LyricsResult, margin: number, boxH: number, pal: LyricPalette): LyricsResult | undefined {
  const { content, style, width: W } = ctx;
  const s = style.poster;
  const inner = W - 2 * margin;
  const bold = faceOf(ctx, "display") ? false : s.bold;
  for (const size of s.sizes.filter((n) => n >= Math.max(ctx.minBody, 48))) {
    const pitch = Math.round(size * 1.12), advance = Math.round(size * 1.75);
    const perColumn = Math.floor(boxH / pitch);
    if (perColumn < 4) continue;
    type Column = { glyphs: string[]; size: number; bold: boolean; color: string; secondary: boolean; emph: readonly (readonly [number, number])[]; gapBefore: number; offset: number };
    const columns: Column[] = [];
    const split = (text: string): string[][] => {
      const g = graphemes(normalizeText(text, "plain"));
      if (g.length <= perColumn) return [g];
      // Break after a phrase mark when one falls in the second half of the column.
      const out: string[][] = [];
      let rest = g;
      while (rest.length > perColumn) {
        let cut = perColumn;
        for (let i = perColumn; i > perColumn / 2; i--) if (/[，。、！？]/u.test(rest[i - 1]!)) { cut = i; break; }
        out.push(rest.slice(0, cut)); rest = rest.slice(cut);
      }
      return [...out, rest];
    };
    const titleSize = Math.max(ctx.minBody, Math.min(size, s.title.size));
    if (content.title) for (const g of split(content.title)) columns.push({ glyphs: g, size: titleSize, bold: !faceOf(ctx, "display"), color: pal.accent, secondary: false, emph: [], gapBefore: 0, offset: 0 });
    if (content.credit) {
      // The author sits lower in the column after the title, as in a printed poem.
      for (const g of split(content.credit)) columns.push({ glyphs: g, size: Math.max(ctx.minSecondary, s.credit.size), bold: false, color: pal.sub, secondary: true, emph: [], gapBefore: 0,
        offset: content.title ? Math.max(0, Math.round(pitch * 1.5)) : 0 });
    }
    for (const [i, stanza] of content.stanzas.entries()) {
      for (const [j, line] of stanza.lines.entries()) {
        let at = 0;
        for (const g of split(line.text)) {
          const ranges = (line.emphasis ?? []).map(([a, b]) => [a - at, b - at] as const);
          columns.push({ glyphs: g, size, bold, color: pal.ink, secondary: false, emph: ranges, gapBefore: j === 0 && at === 0 && (i > 0 || columns.length) ? Math.round(advance * (i > 0 ? 0.9 : 0.6)) : 0, offset: 0 });
          at += g.length;
        }
      }
    }
    const total = columns.reduce((w, c) => w + c.gapBefore + advance, 0) - (advance - size);
    const tallest = Math.max(...columns.map((c) => c.offset + c.glyphs.length * Math.round(c.size * 1.12)));
    if (total > inner || tallest > boxH) continue;
    const top = Math.max(margin, Math.round((ctx.height - ctx.footerRoom() - tallest) / 2));
    let x = Math.round((W + total) / 2);
    let group = 0;
    for (const column of columns) {
      x -= column.gapBefore;
      const cx = x - size / 2, p = Math.round(column.size * 1.12);
      for (const [k, glyph] of column.glyphs.entries()) {
        if (!glyph.trim()) continue;
        const emph = column.emph.some(([a, b]) => k >= a && k < b);
        const face = faceOf(ctx, column.secondary ? "text" : "display");
        const w = ctx.measure.width(glyph, column.size, column.bold, face);
        const y = top + column.offset + k * p;
        const paint = emph ? emphasisPaint(style.engine, pal, column.size, W, ctx.format) : undefined;
        const line: TemplateLine = { text: glyph, x: cx - w / 2, y, width: w, size: column.size, height: p, bold: column.bold, color: emph ? pal.accent : column.color, group: group++, boldAt: [column.bold],
          ...(column.secondary ? { secondary: true } : {}), ...(paint ? { paint } : {}), ...(face ? { face } : {}) };
        if (CORNER.test(glyph)) cornerPunctuation(line, cx, y, column.size);
        result.lines.push(line);
      }
      x -= advance;
    }
    result.bottom = top + tallest;
    return result;
  }
  return;
}

/** A comma or full stop in a vertical column sits in the top-right quarter of its cell: its box is that quarter, and it is drawn offset so the mark lands there. */
export function cornerPunctuation(line: TemplateLine, cx: number, cellTop: number, size: number): void {
  const drawX = cx - line.width / 2 + size * 0.52, drawY = cellTop - size * 0.72;
  line.x = cx; line.y = cellTop; line.width = size / 2; line.height = Math.round(size * 0.5);
  line.offset = { x: drawX - line.x, y: drawY - line.y };
}

/* ───────────── Video ───────────── */
export interface CutSpec {
  kind: "title" | "line";
  segments: { text: string; emphasis: (readonly [number, number])[] }[];
  notes: string[]; label?: string; credit?: string;
  bang: boolean; readMs: number; timedMs?: number; stanza: number;
  /** The shortest this cut may be shown (prose: its reading floor). */
  floorMs: number;
  /** A chunk of a line broken into several cuts: its index (0 first) and the count. */
  part?: number; parts?: number;
}

/** Reading time: per CJK character and per other visible character. */
const readingMs = (text: string) => graphemes(text).reduce((ms, g) => ms + (!g.trim() ? 0 : WIDE.test(g) ? LYRICS_TIMING.cjkMs : LYRICS_TIMING.latinMs), 0);
/** The floor of a prose cut: the fastest it can still be read. */
const proseFloorMs = (text: string) => Math.max(LYRICS_TIMING.minCutMs, graphemes(text).reduce((ms, g) => ms + (!g.trim() ? 0 : WIDE.test(g) ? LYRICS_TIMING.proseCjkMs : LYRICS_TIMING.proseLatinMs), 0));

export function cutSpecs(content: LyricsContent): CutSpec[] {
  const cuts: CutSpec[] = [];
  if (content.title || content.credit) cuts.push({ kind: "title", segments: content.title ? [{ text: content.title, emphasis: [] }] : [], notes: [], ...(content.credit ? { credit: content.credit } : {}),
    bang: false, readMs: LYRICS_TIMING.titleMs, stanza: -1, floorMs: LYRICS_TIMING.titleMs });
  for (const [s, stanza] of content.stanzas.entries()) {
    for (const [l, line] of stanza.lines.entries()) {
      const glyphs = graphemes(normalizeText(line.text, "plain"));
      const bounds = [0, ...(line.breaks ?? []), glyphs.length];
      const timed = line.at !== undefined && line.until !== undefined ? line.until - line.at : undefined;
      for (let k = 0; k + 1 < bounds.length; k++) {
        const a = bounds[k]!, b = bounds[k + 1]!;
        // Leading and trailing spaces of a piece are not part of the cut.
        let lo = a, hi = b;
        while (lo < hi && !glyphs[lo]!.trim()) lo++;
        while (hi > lo && !glyphs[hi - 1]!.trim()) hi--;
        if (lo >= hi) continue;
        const text = glyphs.slice(lo, hi).join("");
        const emphasis = (line.emphasis ?? []).map(([x, y]) => [Math.max(x, lo) - lo, Math.min(y, hi) - lo] as const).filter(([x, y]) => y > x);
        const visible = (list: string[]) => list.filter((g) => g.trim()).length;
        const share = timed !== undefined ? Math.round(timed * visible(glyphs.slice(lo, hi)) / Math.max(1, visible(glyphs))) : undefined;
        // A poem's phrases each take a row.
        const phrases = content.poem ? text.match(/[^，。？！、；：,.?!;:]+[，。？！、；：,.?!;:]*/gu) ?? [text] : [text];
        cuts.push({ kind: "line", segments: phrases.length > 1 ? phrases.map((p) => ({ text: p, emphasis: [] })) : [{ text, emphasis }], notes: k + 2 === bounds.length && line.note ? [line.note] : [],
          ...(k === 0 && l === 0 && stanza.label ? { label: stanza.label } : {}),
          bang: /[!！]$/.test(text), readMs: readingMs(text), ...(share !== undefined ? { timedMs: share } : {}), stanza: s,
          floorMs: content.prose ? proseFloorMs(text) : LYRICS_TIMING.minCutMs });
      }
    }
  }
  return cuts;
}

/** Two consecutive line cuts of one stanza on one screen. */
export function pairCuts(cuts: readonly CutSpec[], prose = false): CutSpec[] {
  const out: CutSpec[] = [];
  for (let i = 0; i < cuts.length; i++) {
    const a = cuts[i]!, b = cuts[i + 1];
    if (a.kind === "line" && b?.kind === "line" && b.stanza === a.stanza && !b.label) {
      out.push({ ...a, segments: [...a.segments, ...b.segments], notes: [...a.notes, ...b.notes], bang: b.bang, readMs: a.readMs + b.readMs, floorMs: prose ? a.floorMs + b.floorMs : LYRICS_TIMING.minCutMs,
        ...(a.timedMs !== undefined && b.timedMs !== undefined ? { timedMs: a.timedMs + b.timedMs } : {}) });
      i++;
    } else out.push(a);
  }
  return out;
}

/** The longest video this frame allows: the shared cap, and for GIF the frame-memory budget at the narrowest GIF width. */
export function lyricsMaxMs(width: number, height: number, format: TemplateFormat): number {
  if (format !== "gif") return LYRICS_TIMING.maxMs;
  const T = LYRICS_TIMING, w = T.gifMinWidth, h = Math.round(height * w / width);
  const sampled = Math.floor(T.gifFrameBudget / (4 * w * h));
  return Math.min(T.gifMaxMs, Math.floor(((sampled * 2 - 2) / T.fps) * 1000));
}

/** Per-cut durations fitted into `available` ms: shrink proportionally, never below each cut's floor. */
export function fitDurations(wanted: readonly number[], floors: readonly number[], available: number): number[] | undefined {
  let durations = [...wanted];
  for (let pass = 0; pass < 6; pass++) {
    const total = durations.reduce((a, b) => a + b, 0);
    if (total <= available) return durations.map(Math.floor);
    const flexible = durations.reduce((n, d, i) => n + Math.max(0, d - floors[i]!), 0);
    const over = total - available;
    if (flexible <= 0) return;
    durations = durations.map((d, i) => (d <= floors[i]! ? d : Math.max(floors[i]!, d - (d - floors[i]!) * Math.min(1, over / flexible))));
  }
  return durations.reduce((a, b) => a + b, 0) <= available + 1 ? durations.map(Math.floor) : undefined;
}

export { lyricsViolations } from "./lyric-video.ts";
export { lyricsComposition, type LyricsComposition } from "./lyric-film.ts";
