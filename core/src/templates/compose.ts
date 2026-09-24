/** Native engine compositions for structured templates. Legacy DSL composition stays unchanged. */
import { copyFile, link, mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ComposeError, normalizeText, unsupportedScript, type ComposeOptions, type ComposeResult } from "../render/compose.ts";
import { splitEmoji, stageEmoji, stripEmoji } from "../render/emoji.ts";
import { templateHasVariant } from "./registry.ts";
import { layoutDiagram, type DiagramNode } from "./diagram.ts";
import { encodeQr, qrRuns } from "./qr.ts";
import { highlight, type CodePalette } from "./highlight.ts";
import { FRAMES, TEMPLATE_MAX_GRAPHEMES, type TemplateId, type TemplateMotion, type TemplatePlan } from "./types.ts";
import { sampleArc, type HueArc } from "./gradient.ts";

export const TEMPLATE_LIMITS = { maxHeight: 4096, maxGraphemes: TEMPLATE_MAX_GRAPHEMES, fps: 30, typingMaxMs: 4200, holdMs: 1200 } as const;
/** GIF/MP4 content taller than the frame scrolls through it (the frame never
 * grows): a still start, an eased scroll at
 * `pxPerS` (faster when it would exceed `maxMs`), and a still end. */
export const TEMPLATE_SCROLL = { pxPerS: 120, startMs: 900, minMs: 1500, maxMs: 12000, endMs: 1500 } as const;
/** The measurer's baked font sizes; every drawn line uses one of them. */
export const SIZES = [24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 80, 96, 112, 128, 144, 160] as const;
/** The only glyphs a layout draws that are not in the source: ordered-list
 * numbers (document and list). The measurer is warmed with them. */
export const LAYOUT_GLYPHS = "0123456789";
/** A layout's canvas: `height` is the minimum canvas height (content may grow
 * it); `fit` is the height templates size their type against. Fixed frames use
 * the frame height for both; the automatic frame fits against a square and
 * starts the canvas at a per-template minimum so it hugs the content. */
interface View { width: number; height: number; fit: number }
/* ───────────── Style tokens ─────────────
 * Every colour, size and spacing a template uses lives in these tables;
 * layoutAt() reads only them, so a redesign changes numbers here, not layout
 * code. Font sizes must be SIZES members (the measurer's baked sizes);
 * `grown()` snaps scaled sizes back to SIZES.
 *
 * Palette: one neutral paper + one night, and one signature hue per template.
 *   paper #f4f1ea  page #fbfaf6  ink #18181b  ink-2 #5a5750  rule #dcd6ca
 *   night #121316  night-ink #f2f0ea
 *   text/poster vermilion #e5482e · document/diagram/qr cobalt #2d4fd0 · quote sienna #b5652a / amber #f0a53a
 *   code green #2f9e5f · stat yellow #f4c430 · list violet #6a4fd6 · chat teal #0f7a70
 *   table forest #1f5f47 · comparison rose #c93d6a
 */

/** The automatic image frame, as tokens. */
export const AUTO_FRAME = {
  widths: [1080, 1440, 1920],
  /** Minimum height / width, so a short text is not a thin strip. */
  minRatio: { text: 0.75, stat: 0.75, quote: 0.75, qr: 1, comparison: 0.6 } as Partial<Record<TemplateId, number>>,
  defaultMinRatio: 0.5,
  /** Content that starts wider: tables with this many columns, code lines this long. */
  wideTableColumns: 4,
  /** Code: pick the narrowest width whose panel holds the longest line at the
   * floor size without wrapping. Columns are counted in half-width cells (CJK
   * and full-width count 2); `codeCell` is a cell's advance in em (Peesuto Code
   * Latin is 0.6 em) and `codeChrome` the horizontal space outside the text. */
  codeCell: 0.6, codeFloor: 28, codeChrome: 272,
} as const;

/** Type steps tried largest-first for content that would otherwise leave a
 * fixed frame half empty. The first step whose layout fits the frame (no
 * growth) wins; step 1 is the fallback and may grow the canvas / scroll. */
export const TEMPLATE_GROW: Partial<Record<TemplateId, readonly number[]>> = {
  document: [1.4, 1.2, 1.1, 1], list: [1.45, 1.3, 1.15, 1], chat: [1.3, 1.15, 1], comparison: [1.4, 1.25, 1.1, 1], table: [1.3, 1.15, 1], info: [1.3, 1.15, 1],
};

/** The text template: sizes are clamped to SIZES between minSize and maxSize. */
export const TEXT_STYLES = {
  /** Paper: warm page, left, regular; a vermilion square marks the top-left. */
  classic: { background: "#f4f1ea", ink: "#18181b", accent: "#e5482e", accentBold: true, bold: false, align: "left", margin: 104, minSize: 40, maxSize: 96, leading: 1.24,
    rule: null, mark: { size: 24, gap: 40, color: "#e5482e" }, band: null },
  /** Ink: night ground, centred bold, a yellow rule under the text. */
  editorial: { background: "#121316", ink: "#f2f0ea", accent: "#f4c430", accentBold: false, bold: true, align: "center", margin: 112, minSize: 40, maxSize: 128, leading: 1.16,
    rule: { width: 96, height: 8, color: "#f4c430" }, mark: null, band: null },
  /** Poster: vermilion field, huge tight type, an ink band pinned to the bottom edge. */
  poster: { background: "#e5482e", ink: "#fff8ee", accent: "#18181b", accentBold: false, bold: true, align: "left", margin: 88, minSize: 48, maxSize: 160, leading: 1.02,
    rule: null, mark: null, band: { height: 28, color: "#18181b" } },
} as const;

export const DOCUMENT_STYLES = {
  /** Reading page: full-bleed white page, a cobalt masthead bar. */
  classic: { background: "#fbfaf6", margin: 104, measure: 9999, masthead: { width: 56, height: 10, gap: 56, color: "#2d4fd0" }, rail: null,
    h1: { size: 64, color: "#18181b", leading: 1.1 }, h2: { size: 48, color: "#2d4fd0", leading: 1.1 }, h3: { size: 40, color: "#18181b", leading: 1.1 },
    body: { size: 40, bold: false, color: "#26262b", leading: 1.14 }, lede: null, gap: 32, headingGap: 48, afterHeading: 0,
    list: { indent: 56, gap: 16, dot: 12, color: "#2d4fd0" }, code: { fill: "#18191d", ink: "#e9e7e0", size: 32, leading: 1.02, radius: 16, pad: 32 } },
  /** Editorial column: cobalt rail down the left, narrow measure, bold lede. */
  editorial: { background: "#efebe2", margin: 96, measure: 800, masthead: null, rail: { width: 12, gap: 56, color: "#2d4fd0" },
    h1: { size: 80, color: "#18181b", leading: 1.04 }, h2: { size: 40, color: "#2d4fd0", leading: 1.1 }, h3: { size: 36, color: "#2d4fd0", leading: 1.1 },
    body: { size: 40, bold: false, color: "#2a2a2f", leading: 1.14 }, lede: { size: 52, bold: true, color: "#18181b", leading: 1.1 }, gap: 36, headingGap: 56, afterHeading: 4,
    list: { indent: 56, gap: 16, dot: 12, color: "#2d4fd0" }, code: { fill: "#1b2a6b", ink: "#eef1ff", size: 32, leading: 1.02, radius: 0, pad: 32 } },
} as const;

export const QUOTE_STYLES = {
  /** Book excerpt: cream page, side rule, regular text, small sienna mark (an SVG, not a glyph). */
  classic: { background: "#efe6d3", ink: "#2a2118", bold: false, margin: 112, sizes: [64, 56, 52, 48, 44, 40], leading: 1.2,
    mark: { size: 64, gap: 36, color: "#b5652a" }, rule: { width: 6, gap: 48, color: "#cdb58f" },
    author: { size: 36, bold: false, color: "#8a5a2e", gap: 48, ruleWidth: 40, ruleHeight: 4 } },
  /** Statement: espresso ground, big bold text, large amber mark; the author after an amber dash shape. */
  editorial: { background: "#1a1511", ink: "#fbf3e4", bold: true, margin: 96, sizes: [96, 80, 72, 64, 56, 48, 44], leading: 1.1,
    mark: { size: 128, gap: 40, color: "#f0a53a" }, rule: null,
    author: { size: 36, bold: true, color: "#f0a53a", gap: 64, ruleWidth: 64, ruleHeight: 6 } },
} as const;

/** Code styles. The whole card is set in Peesuto Code (CODE_FONT). `syntax`
 * colours highlight.js token classes (see templates/highlight.ts):
 * keyword, string, number, comment, function (function and other titles),
 * type (types, classes, built-ins), property (attributes, properties,
 * variables, parameters), literal (true/false/null, symbols), meta (tags,
 * selectors, decorators, headings, diff deletions), punct (operators). */
/** A full-bleed backdrop layer: one two-stop gradient, or a hue arc drawn as segments (gradient.ts). */
type BackdropLayer = { readonly dir: "t" | "b" | "l" | "r"; readonly from: string; readonly to: string } | { readonly arc: HueArc; readonly segments: number };

export const CODE_STYLES = {
  /** Terminal: night panel, three dots, the language (from the fence only) at top right. */
  classic: { background: "#312e81",
    /** Full-bleed layers behind the window: one hue arc left to right (indigo, violet, magenta,
     * coral, amber), saturated all the way, never grey in the middle. No overlay: any tint laid
     * across different hues (even black over orange, which turns brown) muddies them again. */
    backdrop: [{ arc: { from: { l: 0.34, c: 0.16, h: 272 }, to: { l: 0.76, c: 0.16, h: 62 }, turn: 150 }, segments: 8 }],
    panel: { fill: "#1a1d23", radius: 24, pad: 48, header: 80, shadow: "shadow-lg", dots: { size: 22, gap: 14, colors: ["#ff5f57", "#febc2e", "#28c840"] } },
    lineNumbers: { color: "#5b6272", gap: 32 },
    outer: 88, gutter: null, zebra: null, ink: "#e8e6df", sizes: [52, 48, 44, 40, 36, 32, 28], floor: 32, leading: 1.0,
    lang: { size: 24, bold: false, color: "#6e7482", gap: 0 },
    syntax: { keyword: "#7cb7ff", string: "#9fdc8a", comment: "#7d8494", number: "#f4c430", function: "#f5a45d", type: "#5fd0c5",
      property: "#eaa3c9", literal: "#f4c430", meta: "#ff7b72", punct: "#a7adb9" } },
  /** Notebook: light page, green gutter bar, zebra rows. */
  editorial: { background: "#f3f1ea", backdrop: null, panel: null, outer: 88, gutter: { width: 6, gap: 40, color: "#2f9e5f" }, zebra: { color: "#e9e6dc", pad: 16, radius: 6 },
    lineNumbers: { color: "#a8a397", gap: 28 },
    ink: "#1d1d20", sizes: [52, 48, 44, 40, 36, 32, 28], floor: 32, leading: 1.1,
    lang: { size: 28, bold: true, color: "#2f9e5f", gap: 28 },
    syntax: { keyword: "#2447c9", string: "#1d7a45", comment: "#77736a", number: "#b0501a", function: "#7a3fb0", type: "#0e7282",
      property: "#a3365f", literal: "#b0501a", meta: "#c0392b", punct: "#6a675f" } },
} as const;

export const STAT_STYLES = {
  /** Big number: yellow field, left-aligned value, ink bar, label. */
  classic: { background: "#f4c430", margin: 96, band: null, valueSizes: [160, 144, 128, 112, 96, 80], valueColor: "#18181b", valueLeading: 0.92,
    bar: { width: 120, height: 12, gap: 48, color: "#18181b" }, labelSize: 56, labelColor: "#18181b", labelLeading: 1.14, labelMeasure: 820 },
  /** Metric strip: night ground crossed by a full-bleed yellow band holding the value. */
  editorial: { background: "#121316", margin: 96, band: { color: "#f4c430", pad: 56, gap: 56 }, valueSizes: [144, 128, 112, 96, 80, 72], valueColor: "#18181b", valueLeading: 0.92,
    bar: null, labelSize: 52, labelColor: "#f2f0ea", labelLeading: 1.16, labelMeasure: 860 },
} as const;

export const LIST_STYLES = {
  /** Checklist: page, violet numbers (ordered) or outlined boxes (unordered), hairlines. */
  classic: { background: "#fbfaf6", margin: 96, card: null, size: 44, leading: 1.14, ink: "#18181b", indent: 88, gap: 30,
    rule: "#e4dfd4", number: { size: 44, color: "#6a4fd6" }, box: { size: 36, border: 5, radius: 9, color: "#6a4fd6" }, dot: null },
  /** Stacked steps: lavender ground, white cards, big violet numbers or a dot. */
  editorial: { background: "#e9e5f6", margin: 80, card: { fill: "#ffffff", radius: 24, pad: 36, gap: 20 }, size: 44, leading: 1.14, ink: "#18181b", indent: 128, gap: 0,
    rule: null, number: { size: 64, color: "#6a4fd6" }, box: null, dot: { size: 20, color: "#6a4fd6" } },
} as const;

export const CHAT_STYLES = {
  /** Bubbles hug their text (at most maxRatio of the width); name and time sit above the bubble. */
  classic: { background: "#e8ecf1", margin: 72, layout: "bubbles", size: 40, leading: 1.12, maxRatio: 0.78, radius: 32, padX: 32, padY: 22, gap: 36,
    left: { fill: "#ffffff", ink: "#18181b" }, right: { fill: "#0f7a70", ink: "#ffffff" },
    name: { size: 28, bold: true, color: "#56606e", gap: 10 }, time: { size: 24, color: "#8a919c" } },
  /** Transcript: speaker column coloured per speaker, hairlines between turns. */
  editorial: { background: "#f6f2ea", margin: 88, layout: "transcript", size: 40, leading: 1.14, ink: "#18181b", nameCol: 300, gap: 36, rule: "#dcd6ca",
    speakers: ["#0f7a70", "#d23f25", "#2d4fd0", "#9a5a12"], name: { size: 32, bold: true }, time: { size: 24, color: "#8c887f" } },
} as const;

export const TABLE_STYLES = {
  /** Data grid: white card, forest header, content-proportional columns, the largest size with ≤ maxLines lines per cell. */
  classic: { background: "#eef0ec", margin: 72, layout: "grid", sizes: [56, 52, 48, 44, 40, 36, 32, 28], maxLines: 2, leading: 1.1, padX: 28, padY: 24,
    card: { fill: "#ffffff", radius: 20 }, head: { fill: "#1f5f47", ink: "#ffffff" }, zebra: "#f2f5f1", ink: "#18181b", divider: "#e1e6df" },
  /** Ledger: one record per row — the first cell as title, the other cells as label/value fields, up to perRow side by side. */
  editorial: { background: "#f2efe6", margin: 88, layout: "ledger", titleSize: 48, labelSize: 28, valueSize: 40, leading: 1.12, perRow: 3,
    marker: { size: 16, color: "#1f5f47" }, ink: "#18181b", label: "#7d786d", rule: "#d6cfbf", gap: 40, fieldGap: 16 },
} as const;

export const COMPARISON_STYLES = {
  /** Side by side: muted "before" panel, rose "after" panel, both stretched to the frame. */
  classic: { background: "#f4f1ea", margin: 72, layout: "columns", gap: 24, radius: 28, pad: 44, titleSize: 52, itemSize: 40, leading: 1.14, titleGap: 36, itemGap: 24, bullet: 12, titleCol: 0,
    panels: [{ fill: "#e4dfd3", title: "#4a4740", ink: "#4a4740", bullet: "#9a958a" }, { fill: "#c93d6a", title: "#ffffff", ink: "#ffffff", bullet: "#ffd3e0" }] },
  /** Split bands: two full-bleed horizontal bands (ink / rose), a title column + items. */
  editorial: { background: "#18181b", margin: 88, layout: "bands", gap: 0, radius: 0, pad: 0, titleSize: 56, itemSize: 40, leading: 1.14, titleGap: 0, itemGap: 22, bullet: 12, titleCol: 0.3,
    panels: [{ fill: "#18181b", title: "#ff8fb0", ink: "#f2f0ea", bullet: "#ff8fb0" }, { fill: "#c93d6a", title: "#ffffff", ink: "#ffffff", bullet: "#ffffff" }] },
} as const;

/** Diagram styles. Pills (Mermaid `([ ])`, `(( ))`) take the accent; diamonds are decisions. */
export const DIAGRAM_STYLES = {
  /** Flow: paper, white boxes with ink borders, ink pills, amber decisions. */
  classic: { background: "#f4f1ea", nodeFill: "#ffffff", border: "#18181b", borderWidth: 3, radius: 16, text: "#18181b",
    decisionFill: "#fff1c7", decisionBorder: "#c98a12", accentFill: "#18181b", accentText: "#ffffff",
    line: "#55534e", lineWidth: 3, labelFill: "#f4f1ea", labelText: "#18181b", pad: 1, square: false },
  /** Blueprint: cobalt ground, pale-blue lines, white pills, yellow labels. */
  editorial: { background: "#14307f", nodeFill: "#1b3c96", border: "#bcd0ff", borderWidth: 3, radius: 16, text: "#ffffff",
    decisionFill: "#20449f", decisionBorder: "#ffd166", accentFill: "#ffffff", accentText: "#14307f",
    line: "#bcd0ff", lineWidth: 3, labelFill: "#14307f", labelText: "#ffd166", pad: 1.35, square: true },
} as const;
/** Diagram size tiers tried in order until the diagram fits the card's width. */
export const DIAGRAM_TIERS = [
  { size: 56, labelSize: 36, nodeWidth: 440, padX: 40, padY: 26, minWidth: 160, rankGap: 96, nodeGap: 72, arrow: 30 },
  { size: 48, labelSize: 32, nodeWidth: 400, padX: 34, padY: 22, minWidth: 140, rankGap: 88, nodeGap: 64, arrow: 28 },
  { size: 40, labelSize: 28, nodeWidth: 360, padX: 30, padY: 20, minWidth: 120, rankGap: 80, nodeGap: 56, arrow: 26 },
  { size: 32, labelSize: 24, nodeWidth: 320, padX: 26, padY: 18, minWidth: 100, rankGap: 72, nodeGap: 48, arrow: 22 },
  { size: 28, labelSize: 24, nodeWidth: 260, padX: 22, padY: 16, minWidth: 84, rankGap: 64, nodeGap: 36, arrow: 20 },
  { size: 24, labelSize: 24, nodeWidth: 200, padX: 16, padY: 12, minWidth: 64, rankGap: 56, nodeGap: 24, arrow: 18 },
] as const;

/** QR styles. Modules stay dark on light whatever the style: scanners expect
 * it. `card` puts the code (quiet zone included) on a light card over a coloured ground. */
/** Info cards: fields on a card. Labels sit in a left column when the widest fits
 * `labelMax` of the card, else above their values. Values keep their text; the
 * type only styles it: phone digits grouped by space, an email's domain and a
 * URL's scheme muted, secrets in a pill behind a lock. */
export const INFO_STYLES = {
  /** Field list: warm page, white card, ink values, blue links, red secrets. */
  classic: { background: "#efece4", margin: 72, card: { fill: "#ffffff", radius: 28, pad: 56, shadow: "shadow-md" },
    title: { size: 52, color: "#18181b", gap: 36 }, rule: "#ece8df", label: { size: 28, color: "#8a857a" }, labelMax: 0.34, labelGap: 40,
    value: { size: 40, color: "#18181b" }, leading: 1.2, rowGap: 26, muted: "#9b968b", link: "#2f5bd3", phoneGap: 14,
    secret: { fill: "#fdeceb", ink: "#c62828", icon: "#d63b3b", padX: 18, padY: 8, radius: 12, iconSize: 32, iconGap: 12 } },
  /** Credentials: night page, graphite card, each label above its value, pale values, coral secrets. */
  editorial: { background: "#0e1014", margin: 72, card: { fill: "#1b1e24", radius: 28, pad: 56, shadow: "shadow-lg" },
    title: { size: 52, color: "#f2f0ea", gap: 36 }, rule: "#2a2e36", label: { size: 28, color: "#7d8494" }, labelMax: 0, labelGap: 40,
    value: { size: 40, color: "#e8e6df" }, leading: 1.2, rowGap: 26, muted: "#7d8494", link: "#7cb7ff", phoneGap: 14,
    secret: { fill: "#3a1d22", ink: "#ff8a80", icon: "#ff7b72", padX: 18, padY: 8, radius: 12, iconSize: 32, iconGap: 12 } },
} as const;

/** A padlock on a 64 box: fill only, lines and cubic curves (the engine's rasteriser draws no arcs). */
const LOCK_PATH = "M20 28 L20 20 C20 13.4 25.4 8 32 8 C38.6 8 44 13.4 44 20 L44 28 L38 28 L38 20 C38 16.7 35.3 14 32 14 C28.7 14 26 16.7 26 20 L26 28 Z "
  + "M14 26 L50 26 C52.2 26 54 27.8 54 30 L54 54 C54 56.2 52.2 58 50 58 L14 58 C11.8 58 10 56.2 10 54 L10 30 C10 27.8 11.8 26 14 26 Z";

/** Where a phone number splits for display: a Chinese mobile as 3-4-4 (after an optional +86); anything else stays whole. */
export function phoneGroups(value: string): string[] {
  const m = value.match(/^(\+86)?(1\d{2})(\d{4})(\d{4})$/);
  return m ? m.slice(1).filter((g): g is string => Boolean(g)) : [value];
}

export const QR_STYLES = {
  /** Plain: white page, black modules. */
  classic: { background: "#ffffff", light: "#ffffff", dark: "#111111", card: false, cardRadius: 0, cardPad: 0, caption: "#55595e", captionSize: 28 },
  /** Card: cobalt ground, a white card holding the code, white caption. */
  editorial: { background: "#2d4fd0", light: "#ffffff", dark: "#111320", card: true, cardRadius: 32, cardPad: 48, caption: "#ffffff", captionSize: 32 },
} as const;
/** Quiet zone around the code, in modules (the QR specification asks for 4). */
const QR_QUIET = 4;
/** The caption under a QR code: the data itself when it is one short line (a URL, a word), never anything else. */
export function qrCaption(content: { data: string; caption?: boolean }): string | undefined {
  if (content.caption === false || content.data.includes("\n") || graphemes(content.data).length > 60) return;
  return content.data;
}

/** True for each grapheme of `source` inside the first verbatim occurrence of `emphasis`. */
function accentMask(source: string, emphasis: string | undefined): boolean[] {
  const glyphs = graphemes(normalizeText(source, "plain"));
  const mask = glyphs.map(() => false);
  if (!emphasis?.trim()) return mask;
  const target = graphemes(emphasis);
  outer: for (let i = 0; i + target.length <= glyphs.length; i++) {
    for (let j = 0; j < target.length; j++) if (glyphs[i + j] !== target[j]) continue outer;
    for (let j = 0; j < target.length; j++) mask[i + j] = true;
    break;
  }
  return mask;
}

export interface TemplateMeasure {
  width(text: string, size: number, bold: boolean): number;
  lineHeight(size: number, bold: boolean): number;
}
export interface TemplateLine {
  text: string; x: number; y: number; width: number; size: number; height: number; bold: boolean; color: string; group: number;
  /** Per-grapheme weight after Markdown markers are interpreted. */
  boldAt: boolean[];
  /** Per-grapheme color where it differs from `color` (an accented word). */
  colorAt?: (string | undefined)[];
}
export interface TemplateRect { x: number; y: number; width: number; height: number; color: string; radius: number;
  /** A two-stop linear gradient instead of the flat colour (the engine draws 4 directions; colours may carry alpha). */
  gradient?: { dir: "t" | "b" | "l" | "r"; from: string; to: string };
  /** The engine's drop shadow. */
  shadow?: "shadow" | "shadow-md" | "shadow-lg";
  /** Reveal group; shapes without one are drawn from the first frame. */
  group?: number }
/** A small SVG drawn scaled (arrowheads, diamonds). `src` names a file in `assets`. */
export interface TemplateImage { x: number; y: number; width: number; height: number; src: string; group?: number }
export interface TemplateLayout {
  width: number; height: number; background: string; lines: TemplateLine[]; shapes: TemplateRect[];
  images: TemplateImage[];
  /** SVG sources by file name, written beside the composition. */
  assets: Record<string, string>;
}
export interface TemplateComposeResult extends ComposeResult {
  readonly width: number;
  readonly height: number;
  readonly template: string;
  readonly variant: string;
  readonly motion: TemplateMotion;
  /** The animation scrolls tall content through a fixed canvas. */
  readonly scroll: boolean;
}
const graphemes = (text: string): string[] => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
interface StyledGlyph { text: string; bold: boolean; color?: string }
function styledGlyphs(text: string, bold: boolean, markdown: boolean): StyledGlyph[] {
  const output: StyledGlyph[] = [];
  const append = (part: string, weight: boolean) => output.push(...graphemes(part).map((text) => ({ text, bold: weight })));
  if (!markdown) { append(text, bold); return output; }
  let cursor = 0;
  for (const match of text.matchAll(/\*\*([^*\n]+)\*\*/g)) {
    append(text.slice(cursor, match.index), bold); append(match[1]!, true); cursor = match.index! + match[0].length;
  }
  append(text.slice(cursor), bold);
  return output;
}
function styledWidth(glyphs: readonly StyledGlyph[], size: number, measure: TemplateMeasure): number {
  let width = 0, run = "", bold = glyphs[0]?.bold ?? false;
  for (const glyph of glyphs) {
    if (glyph.bold !== bold) { width += measure.width(run, size, bold); run = ""; bold = glyph.bold; }
    run += glyph.text;
  }
  return width + measure.width(run, size, bold);
}
/** Glyph indices where a new word begins (ICU word segmentation, which also
 * splits Chinese and Japanese into words). Breaking there keeps 复杂 whole. */
function wordStarts(glyphs: readonly StyledGlyph[]): Set<number> {
  const starts = new Set<number>();
  const offsets: number[] = [];
  let text = "";
  for (const glyph of glyphs) { offsets.push(text.length); text += glyph.text; }
  const byOffset = new Map(offsets.map((offset, index) => [offset, index]));
  for (const part of new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)) {
    const index = byOffset.get(part.index);
    if (index !== undefined) starts.add(index);
  }
  return starts;
}
/** Lines broken inside a Latin word since the last reset; grownLayout rejects
 * a larger type step that needs one (layout is synchronous, so this is safe). */
let brokenWords = 0;
const LETTER = /^[\p{L}\p{N}]$/u;
const CJK = /[\u2e80-\u9fff\uac00-\ud7a3\uf900-\ufaff\uff00-\uffef]/u;

function wrapStyled(glyphs: readonly StyledGlyph[], width: number, size: number, measure: TemplateMeasure): StyledGlyph[][] {
  const result: StyledGlyph[][] = [];
  const starts = wordStarts(glyphs);
  // One explicit line is glyphs[start, end). Work with indices instead of
  // re-slicing, and measure incrementally: finished same-weight runs keep
  // their width, only the open run is re-measured (identical to styledWidth).
  const wrapRange = (start: number, end: number) => {
    if (start === end) { result.push([]); return; }
    while (start < end) {
      let done = 0, run = "", bold = glyphs[start]!.bold, count = 0;
      while (start + count < end) {
        const glyph = glyphs[start + count]!;
        let nextDone = done, nextRun = run + glyph.text;
        if (glyph.bold !== bold && run) { nextDone = done + measure.width(run, size, bold); nextRun = glyph.text; }
        if (nextDone + measure.width(nextRun, size, glyph.bold) > width + 0.01) break;
        done = nextDone; run = nextRun; bold = glyph.bold; count++;
      }
      if (!count) throw new ComposeError("overflow", "A character cannot fit in this template column. Choose a wider frame.");
      if (start + count < end) {
        let firstVisible = -1;
        for (let i = start; i < start + count; i++) if (glyphs[i]!.text.trim()) { firstVisible = i; break; }
        // The break closest to the line's end among (a) just after a space and
        // (b) a word start (ICU words, so Chinese breaks between words),
        // giving up at most half the line. Latin text is unchanged: its word
        // starts follow its spaces. Mixed text no longer strands "Gatekeeper"
        // when the Chinese after it could stay on the line.
        const full = count, floor = start + Math.ceil(full / 2);
        // A word start is no break when kinsoku would move it back into the
        // word (English "crop," must not become "cro" + "p,").
        const breakable = (i: number) => starts.has(i) && !NO_LINE_START.test(glyphs[i]!.text);
        if (!breakable(start + full) && !/\s/u.test(glyphs[start + full - 1]!.text)) {
          let best = -1;
          for (let i = start + full - 1; i >= floor; i--) {
            if (/\s/u.test(glyphs[i]!.text) && firstVisible >= 0 && firstVisible < i) { best = Math.max(best, i + 1); break; }
          }
          for (let i = start + full - 1; i >= floor; i--) {
            if (breakable(i) && !/\s/u.test(glyphs[i]!.text)) { best = Math.max(best, i); break; }
          }
          // Splitting a Latin word is worse than a short line: look past the
          // half-line floor for the last space before it.
          const b = glyphs[start + full - 1]!.text, a = glyphs[start + full]!.text;
          if (best <= start && LETTER.test(b) && LETTER.test(a) && !CJK.test(b + a)) {
            for (let i = floor - 1; i > start; i--) {
              if (/\s/u.test(glyphs[i]!.text) && firstVisible >= 0 && firstVisible < i) { best = i + 1; break; }
            }
          }
          if (best > start) count = best - start;
        }
      }
      if (start + count < end) {
        count = kinsoku(glyphs, start, count);
        // Spaces at a break hang at the end of the line instead of indenting the next one.
        while (start + count < end && /^[ \t]$/u.test(glyphs[start + count]!.text)) count++;
        if (start + count >= end) { result.push(glyphs.slice(start, end)); break; }
        const before = glyphs[start + count - 1]!.text, after = glyphs[start + count]!.text;
        if (LETTER.test(before) && LETTER.test(after) && !CJK.test(before + after)) brokenWords++;
      }
      result.push(glyphs.slice(start, start + count)); start += count;
    }
  };
  let lineStart = 0;
  for (let i = 0; i < glyphs.length; i++) if (glyphs[i]!.text === "\n") { wrapRange(lineStart, i); lineStart = i + 1; }
  wrapRange(lineStart, glyphs.length);
  return result;
}

/** Closing punctuation that must not begin a line, and opening punctuation
 * that must not end one (CJK line-breaking rules, plus their Latin cousins). */
const NO_LINE_START = /^[，。、；：？！）」』”’》〉】〕…—·,.;:?!)\]}%％‰]$/u;
const NO_LINE_END = /^[（「『“‘《〈【〔(\[{$¥￥£€]$/u;
/** Move the break so a line neither starts with closing nor ends with opening
 * punctuation: pull the last glyph(s) down to the next line. Never empties a line. */
function kinsoku(glyphs: readonly StyledGlyph[], start: number, count: number): number {
  let n = count;
  while (n > 1 && NO_LINE_START.test(glyphs[start + n]?.text ?? "")) n--;
  while (n > 1 && NO_LINE_END.test(glyphs[start + n - 1]!.text)) n--;
  return n > 0 ? n : count;
}

/** Wrap all content without deleting words. A too-wide glyph is an explicit
 * error. Same breaking rules as the layouts use (word boundaries, kinsoku). */
export function wrapTemplateText(text: string, width: number, size: number, bold: boolean, measure: TemplateMeasure): string[] {
  return wrapStyled(styledGlyphs(text, bold, false), width, size, measure).map((line) => line.map((glyph) => glyph.text).join(""));
}

/** Largest baked size not above n (the smallest baked size below that). */
const snap = (n: number): number => [...SIZES].reverse().find((s) => s <= n) ?? SIZES[0];
/** Objects whose `size` is a shape's side, not a font size. */
const SHAPE_KEYS = new Set(["dot", "box", "marker", "dots", "mark", "masthead", "rail", "card", "bar", "band", "gutter", "zebra", "panel", "rule"]);
/** Ratios and shape details that stay as they are when type grows. */
const KEEP_KEYS = new Set(["margin", "leading", "maxRatio", "titleCol", "labelMax", "perRow", "maxLines", "border", "radius"]);
/** A style `k` type steps larger: font sizes (keys ending in "size", members
 * of "…sizes" arrays) snap to SIZES, spacing scales, ratios stay. */
export function grown<T>(style: T, k: number, parent = ""): T {
  if (k === 1 || style === null || typeof style !== "object") return style;
  const out: Record<string, unknown> | unknown[] = Array.isArray(style) ? [] : {};
  for (const [key, val] of Object.entries(style as Record<string, unknown>)) {
    let next: unknown;
    if (val && typeof val === "object") next = grown(val, k, key);
    else if (typeof val !== "number" || KEEP_KEYS.has(key)) next = val;
    else if ((/size$/i.test(key) && !SHAPE_KEYS.has(parent)) || /sizes$/i.test(parent)) next = snap(val * k);
    else next = Math.round(val * k);
    (out as Record<string, unknown>)[key] = next;
  }
  return out as T;
}
const pickStyle = <S extends Record<string, unknown>>(table: S, variant: string): S[keyof S] => (table[variant as keyof S] ?? table.classic) as S[keyof S];

/** Syntax colour per grapheme of one code line. Colour only: the text is untouched. */
const KEYWORDS = /^(const|let|var|function|return|if|else|for|while|class|import|from|export|default|async|await|new|def|fn|pub|mut|impl|struct|true|false|null|undefined|None|True|False|SELECT|FROM|WHERE|AND|OR|type|interface|extends|self)$/;
interface SyntaxPalette { keyword: string; string: string; comment: string; number: string; punct: string }
export function syntaxColors(line: string, palette: SyntaxPalette): (string | undefined)[] {
  const glyphs = graphemes(line), offsets: number[] = [];
  let offset = 0;
  for (const glyph of glyphs) { offsets.push(offset); offset += glyph.length; }
  const colors: (string | undefined)[] = glyphs.map(() => undefined);
  const paint = (start: number, end: number, color: string) => { for (let i = 0; i < glyphs.length; i++) if (offsets[i]! >= start && offsets[i]! < end) colors[i] = color; };
  const tokens = /(\/\/.*$|#\s.*$|^\s*#.*$)|(`[^`]*`?|"[^"]*"?|'[^']*'?)|(\b\d[\d_.]*\b)|([A-Za-z_]\w*)|([{}()[\];,.=<>+\-*/:!?&|$]+)/g;
  for (const match of line.matchAll(tokens)) {
    const start = match.index!, end = start + match[0].length;
    if (match[1]) paint(start, end, palette.comment);
    else if (match[2]) paint(start, end, palette.string);
    else if (match[3]) paint(start, end, palette.number);
    else if (match[4]) { if (KEYWORDS.test(match[4])) paint(start, end, palette.keyword); }
    else if (match[5]) paint(start, end, palette.punct);
  }
  return colors;
}
/** Syntax colour per grapheme of every line of `source` (normalized code):
 * highlight.js when it knows or detects the language and reproduces the text
 * exactly, else syntaxColors() line by line. Colour only. */
export function codeColors(source: string, language: string | undefined, palette: CodePalette): (string | undefined)[][] {
  const highlighted = highlight(source, language);
  if (!highlighted) return source.split("\n").map((line) => syntaxColors(line, palette));
  return highlighted.keys.map((keys) => keys.map((key) => key && palette[key]));
}
/** The quote mark, drawn as a shape so no glyph is added to the source. */
const QUOTE_MARK_PATH = "M4 60 L4 38 C4 20 12 8 28 2 L30 10 C20 15 16 22 16 30 L28 30 L28 60 Z M36 60 L36 38 C36 20 44 8 60 2 L62 10 C52 15 48 22 48 30 L60 30 L60 60 Z";

/** Try the template's TEMPLATE_GROW steps largest-first; keep the first that
 * fits the frame, else the step-1 layout (which may grow the canvas). */
function grownLayout(plan: TemplatePlan, measure: TemplateMeasure, view: View): TemplateLayout {
  const steps = TEMPLATE_GROW[plan.template] ?? [1];
  let layout: TemplateLayout | undefined;
  for (const k of steps) {
    brokenWords = 0;
    try { layout = layoutAt(plan, measure, view, k); }
    catch (error) { if (k === 1) throw error; continue; }
    // Larger type is only worth it if no word has to be split to fit.
    if (k !== 1 && brokenWords) continue;
    if (layout.height <= view.height) return layout;
  }
  return layout ?? layoutAt(plan, measure, view, 1);
}

/** Pure layout: fonts supply real advances in production, a metric fixture in unit tests. */
export function layoutTemplate(plan: TemplatePlan, measure: TemplateMeasure): TemplateLayout {
  if (plan.template !== plan.content.kind) throw new ComposeError("catalog", "Template and structured content do not match.");
  if (!templateHasVariant(plan.template, plan.variant)) throw new ComposeError("catalog", "Unknown template variant.");
  if (plan.aspect !== "auto") {
    const frame = FRAMES[plan.aspect];
    if (!frame) throw new ComposeError("catalog", "Unknown card frame.");
    return grownLayout(plan, measure, { ...frame, fit: frame.height });
  }
  // Automatic: the narrowest width tier the content allows, trying wider ones
  // when it overflows; the canvas starts at the template's minimum height.
  const widths = AUTO_FRAME.widths.filter((w) => w >= autoWidth(plan));
  let last: unknown;
  for (const width of widths) {
    const minRatio = AUTO_FRAME.minRatio[plan.template] ?? AUTO_FRAME.defaultMinRatio;
    try { return grownLayout(plan, measure, { width, height: Math.round(width * minRatio / 2) * 2, fit: width }); }
    catch (error) {
      if (!(error instanceof ComposeError) || error.code !== "overflow") throw error;
      last = error;
    }
  }
  throw last;
}

/** Where the automatic frame starts: wide tables, long code lines and
 * sideways diagrams begin at the second width tier. */
function autoWidth(plan: TemplatePlan): number {
  const content = plan.content;
  if (content.kind === "code") {
    const cells = (line: string) => graphemes(line.replace(/\t/g, "    ")).reduce((n, g) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(g) ? 2 : 1), 0);
    const longest = Math.max(0, ...content.code.split("\n").map(cells));
    const numberCells = String(Math.max(1, content.code.split("\n").length)).length + 2; // line numbers and their gap
    const needed = (longest + numberCells) * AUTO_FRAME.codeCell * AUTO_FRAME.codeFloor + AUTO_FRAME.codeChrome;
    return AUTO_FRAME.widths.find((w) => w >= needed) ?? AUTO_FRAME.widths.at(-1)!;
  }
  const wide = (content.kind === "table" && content.headers.length >= AUTO_FRAME.wideTableColumns)
    || (content.kind === "diagram" && (content.direction === "LR" || content.direction === "RL"));
  return AUTO_FRAME.widths[wide ? 1 : 0]!;
}

interface BlockOptions { align?: "left" | "center" | "right"; leading?: number; groupID?: number; markdown?: boolean; code?: boolean; colors?: readonly (string | undefined)[] }

/** One layout at type step `k` (TEMPLATE_GROW). */
function layoutAt(plan: TemplatePlan, measure: TemplateMeasure, view: View, k = 1): TemplateLayout {
  const W = view.width;
  /** Per style; qr and diagram keep the default. */
  let margin = 88;
  const innerW = () => W - margin * 2;
  const layout: TemplateLayout = { width: W, height: view.height, background: "#f4f1ea", lines: [], shapes: [], images: [], assets: {} };
  let bottom = margin, group = 0;
  /** Shapes that settle() leaves in place (full-bleed bands). */
  const pinned = new Set<object>();
  let pinBottom: TemplateRect | undefined;
  /** Full-bleed backdrop layers, stretched to the final canvas height. */
  let backdropRects: TemplateRect[] = [];
  const rect = (x: number, y: number, width: number, height: number, color: string, radius = 0): TemplateRect => {
    const value = { x, y, width, height, color, radius }; layout.shapes.push(value); return value;
  };
  const glyphsOf = (text: string, bold: boolean, o: BlockOptions = {}): StyledGlyph[] => {
    const glyphs = styledGlyphs(normalizeText(text, o.code ? "code" : "plain"), bold, o.markdown ?? plan.template === "document");
    if (o.colors) glyphs.forEach((glyph, i) => { const color = o.colors![i]; if (color) glyph.color = color; });
    return glyphs;
  };
  const place = (glyphs: StyledGlyph[], x: number, y: number, width: number, size: number, bold: boolean, color: string, o: BlockOptions = {}): number => {
    const { align = "left", leading = 1.3, groupID = group++ } = o;
    const lines = wrapStyled(glyphs, width, size, measure);
    const height = Math.ceil(measure.lineHeight(size, bold) * leading);
    for (const [index, line] of lines.entries()) {
      const advance = styledWidth(line, size, measure);
      const dx = align === "center" ? (width - advance) / 2 : align === "right" ? width - advance : 0;
      layout.lines.push({ text: line.map((g) => g.text).join(""), x: x + dx, y: y + index * height, width: advance, size, height, bold, color, group: groupID,
        boldAt: line.map((g) => g.bold), ...(line.some((g) => g.color) ? { colorAt: line.map((g) => g.color) } : {}) });
    }
    bottom = Math.max(bottom, y + lines.length * height);
    return lines.length * height;
  };
  const block = (text: string, x: number, y: number, width: number, size: number, bold: boolean, color: string, o: BlockOptions = {}) => place(glyphsOf(text, bold, o), x, y, width, size, bold, color, o);
  const count = (text: string, width: number, size: number, bold: boolean) => wrapStyled(glyphsOf(text, bold), width, size, measure).length;
  const lh = (size: number, leading: number, bold = false) => Math.ceil(measure.lineHeight(size, bold) * leading);
  // Text is drawn top-aligned in its line box, the baseline at ~1.16 × size
  // (Noto Sans SC's ascender); these are offsets from a line's top.
  /** Where a marker beside the first line of `size` text is optically centred
   * (between the CJK centre and the Latin x-height centre). */
  const mid = (size: number) => Math.round(size * 0.8);
  /** The first line's baseline: text beside text of another size aligns on it. */
  const base = (size: number) => Math.round(size * 1.16);
  const svg = (name: string, path: string, color: string, box = 64) => {
    const file = `${name}-${color.slice(1)}.svg`;
    layout.assets[file] ??= `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}" viewBox="0 0 ${box} ${box}"><path d="${path}" fill="${color}"/></svg>`;
    return file;
  };
  /** Centre everything unpinned when the content is shorter than the frame. */
  const settle = (top: number, end: number): number => {
    const dy = Math.round((view.height - (end - top)) / 2) - top;
    if (dy <= 0) return end;
    for (const item of [...layout.lines, ...layout.shapes, ...layout.images]) if (!pinned.has(item)) item.y += dy;
    return end + dy;
  };
  const content = plan.content;
  switch (content.kind) {
    case "info": {
      const s = grown(pickStyle(INFO_STYLES, plan.variant), k);
      layout.background = s.background; margin = s.margin;
      const C = s.card, cardX = margin, cardW = innerW(), innerX = cardX + C.pad, inner = cardW - 2 * C.pad;
      let y = margin; const top = y;
      const card = rect(cardX, y, cardW, 0, C.fill, C.radius); card.shadow = C.shadow;
      y += C.pad;
      if (content.title) y += block(content.title, innerX, y, inner, s.title.size, true, s.title.color, { leading: 1.15 }) + s.title.gap;
      const widest = Math.max(0, ...content.fields.map((f) => f.label ? Math.ceil(measure.width(f.label, s.label.size, false)) : 0));
      const side = widest > 0 && widest + s.labelGap <= inner * s.labelMax;
      const valueX = side ? innerX + widest + s.labelGap : innerX, valueW = inner - (valueX - innerX);
      for (const [index, field] of content.fields.entries()) {
        if (index || content.title) { rect(innerX, y, inner, 2, s.rule); y += 2 + s.rowGap; }
        const g = group++;
        let vy = y;
        if (field.label) {
          // Beside the value: the label's baseline on the value's first baseline. Above it: its own line.
          const ly = side ? y + base(s.value.size) - base(s.label.size) : y;
          const h = block(field.label, innerX, ly, side ? widest : inner, s.label.size, false, s.label.color, { leading: 1.2, groupID: g });
          if (!side) vy = y + h + 6;
        }
        let end = vy;
        if (field.type === "secret") {
          const S = s.secret, textX = valueX + S.padX + S.iconSize + S.iconGap, maxW = valueW - 2 * S.padX - S.iconSize - S.iconGap;
          const pill = rect(valueX, vy - S.padY, 0, 0, S.fill, S.radius);
          const first = layout.lines.length;
          const h = block(field.value, textX, vy, maxW, s.value.size, false, S.ink, { leading: s.leading, groupID: g });
          const textW = Math.max(...layout.lines.slice(first).map((line) => line.width));
          pill.width = Math.ceil(textW + 2 * S.padX + S.iconSize + S.iconGap); pill.height = h + 2 * S.padY;
          layout.images.push({ x: valueX + S.padX, y: vy + mid(s.value.size) - S.iconSize / 2, width: S.iconSize, height: S.iconSize, src: svg("lock", LOCK_PATH, S.icon), group: g });
          end = vy + h + S.padY;
        } else if (field.type === "phone" && phoneGroups(field.value).length > 1) {
          let x = valueX;
          for (const part of phoneGroups(field.value)) {
            block(part, x, vy, valueW, s.value.size, false, s.value.color, { leading: s.leading, groupID: g });
            x += Math.ceil(measure.width(part, s.value.size, false)) + s.phoneGap;
          }
          end = vy + lh(s.value.size, s.leading);
        } else {
          const chars = graphemes(field.value);
          const at = field.type === "email" ? chars.indexOf("@") : -1;
          const scheme = field.type === "url" ? graphemes(field.value.match(/^(?:https?:\/\/)?(?:www\.)?/i)![0]).length : 0;
          const colors = field.type === "email" ? chars.map((_, i) => (i >= at ? s.muted : undefined))
            : field.type === "url" ? chars.map((_, i) => (i < scheme ? s.muted : s.link)) : undefined;
          end = vy + block(field.value, valueX, vy, valueW, s.value.size, false, s.value.color, { leading: s.leading, groupID: g, ...(colors ? { colors } : {}) });
        }
        y = end + s.rowGap;
      }
      y += C.pad - s.rowGap;
      card.height = y - card.y;
      bottom = settle(top, y);
      break;
    }
    case "qr": {
      const inner = innerW();
      const style = pickStyle(QR_STYLES, plan.variant);
      layout.background = style.background;
      const matrix = encodeQr(content.data);
      const cells = matrix.size + QR_QUIET * 2;
      const captionText = qrCaption(content);
      let captionLines: StyledGlyph[][] = [];
      if (captionText) {
        captionLines = wrapStyled(styledGlyphs(normalizeText(captionText, "plain"), false, false), inner, style.captionSize, measure);
        if (captionLines.length > 2) captionLines = [];
      }
      const lineH = Math.ceil(measure.lineHeight(style.captionSize, false) * 1.3);
      const captionH = captionLines.length ? 32 + captionLines.length * lineH : 0;
      const pad = style.card ? style.cardPad : 0;
      const room = Math.min(inner - pad * 2, view.fit - margin * 2 - captionH - pad * 2);
      // Whole pixels per module keep every edge sharp.
      const module = Math.max(2, Math.floor(room / cells));
      const side = module * cells;
      const total = side + pad * 2 + captionH;
      const top = Math.max(margin, Math.round((view.height - total) / 2));
      const x0 = Math.round((W - side) / 2), y0 = top + pad;
      if (style.card) rect(x0 - pad, top, side + pad * 2, side + pad * 2, style.light, style.cardRadius);
      else rect(x0, y0, side, side, style.light);
      const bands = 12;
      for (const run of qrRuns(matrix)) {
        rect(x0 + (QR_QUIET + run.col) * module, y0 + (QR_QUIET + run.row) * module, run.length * module, module, style.dark).group = Math.floor(run.row * bands / matrix.size);
      }
      let y = top + side + pad * 2 + 32;
      for (const line of captionLines) {
        const advance = styledWidth(line, style.captionSize, measure);
        layout.lines.push({ text: line.map((g) => g.text).join(""), x: (W - advance) / 2, y, width: advance, size: style.captionSize, height: lineH,
          bold: false, color: style.caption, group: bands, boldAt: line.map(() => false) });
        y += lineH;
      }
      bottom = top + total;
      break;
    }
    case "text": {
      const style = pickStyle(TEXT_STYLES, plan.variant);
      layout.background = style.background; margin = style.margin;
      const source = content.paragraphs.join("\n\n");
      const accentAt = accentMask(source, plan.emphasis);
      const glyphs = graphemes(normalizeText(source, "plain")).map((text, i) => ({ text, bold: style.bold || (accentAt[i] === true && style.accentBold), ...(accentAt[i] ? { color: style.accent } : {}) }));
      const band = style.band?.height ?? 0;
      const markRoom = style.mark ? style.mark.size + style.mark.gap : 0;
      const boxW = W - margin * 2, boxH = view.fit - margin * 2 - band - markRoom;
      const lineH = (size: number) => Math.ceil(measure.lineHeight(size, style.bold) * style.leading);
      const heightAt = (lines: StyledGlyph[][], size: number) => lines.length * lineH(size) - (lineH(size) - measure.lineHeight(size, style.bold));
      const ruleExtra = (size: number) => style.rule ? Math.round(size * 0.6) + style.rule.height : 0;
      // The largest size whose wrapped text fits the box; smaller text may grow the canvas.
      let size: number = style.minSize, lines = wrapStyled(glyphs, boxW, size, measure);
      for (const candidate of [...SIZES].reverse()) {
        if (candidate > style.maxSize || candidate < style.minSize) continue;
        const wrapped = wrapStyled(glyphs, boxW, candidate, measure);
        if (heightAt(wrapped, candidate) + ruleExtra(candidate) <= boxH) { size = candidate; lines = wrapped; break; }
      }
      // Balance: the narrowest measure that keeps the same number of lines.
      let lo = Math.floor(boxW * 0.5), hi = boxW;
      while (hi - lo > 8) {
        const midW = Math.floor((lo + hi) / 2);
        let trial: StyledGlyph[][] | undefined;
        try { trial = wrapStyled(glyphs, midW, size, measure); } catch { trial = undefined; }
        if (trial && trial.length <= lines.length) hi = midW; else lo = midW;
      }
      lines = wrapStyled(glyphs, hi, size, measure);
      const total = heightAt(lines, size);
      const top = Math.max(margin + markRoom, Math.round((view.height - band - total - ruleExtra(size)) / 2 - size * 0.08));
      const left = style.align === "center" ? (W - hi) / 2 : margin;
      for (const [index, line] of lines.entries()) {
        const advance = styledWidth(line, size, measure);
        layout.lines.push({ text: line.map((g) => g.text).join(""), x: style.align === "center" ? (W - advance) / 2 : left, y: top + index * lineH(size), width: advance, size, height: lineH(size),
          bold: style.bold, color: style.ink, group: group++, boldAt: line.map((g) => g.bold), ...(line.some((g) => g.color) ? { colorAt: line.map((g) => g.color) } : {}) });
      }
      if (style.mark) rect(left, top - style.mark.gap - style.mark.size, style.mark.size, style.mark.size, style.mark.color);
      if (style.rule) rect(style.align === "center" ? W / 2 - style.rule.width / 2 : left, top + total + Math.round(size * 0.6), style.rule.width, style.rule.height, style.rule.color);
      bottom = top + total + ruleExtra(size) + band;
      if (style.band) { const b = rect(0, 0, W, band, style.band.color); pinned.add(b); pinBottom = b; }
      break;
    }
    case "diagram": {
      const style = pickStyle(DIAGRAM_STYLES, plan.variant);
      layout.background = style.background;
      const horizontal = content.direction === "LR" || content.direction === "RL";
      const avail = W - margin * 2;
      type Pick = { geometry: ReturnType<typeof layoutDiagram>; tier: (typeof DIAGRAM_TIERS)[number]; boxes: Map<string, { width: number; height: number; lines: StyledGlyph[][] }> };
      let chosen: Pick | undefined, widest: Pick | undefined;
      for (const tier of DIAGRAM_TIERS) {
        const boxes = new Map<string, { width: number; height: number; lines: StyledGlyph[][] }>();
        const boxFor = (node: DiagramNode) => {
          const cap = node.shape === "diamond" ? tier.nodeWidth * 0.6 : tier.nodeWidth;
          const lines = wrapStyled(styledGlyphs(normalizeText(node.label, "plain"), false, false), cap, tier.size, measure);
          const tw = Math.max(...lines.map((line) => styledWidth(line, tier.size, measure)));
          const th = lines.length * Math.ceil(measure.lineHeight(tier.size, false) * 1.25);
          const padX = tier.padX * style.pad, padY = tier.padY * style.pad;
          let w = tw + padX * 2, h = th + padY * 2;
          if (node.shape === "pill") w += h * 0.5;
          if (node.shape === "diamond") { w = tw * 2 + padX * 2; h = th * 2 + padY * 2; }
          w = Math.max(w, tier.minWidth);
          boxes.set(node.id, { width: w, height: h, lines });
          return { width: w, height: h };
        };
        const labelBox = (label: string) => {
          const lines = wrapStyled(styledGlyphs(normalizeText(label, "plain"), false, false), tier.nodeWidth * 0.8, tier.labelSize, measure);
          return { width: Math.max(...lines.map((line) => styledWidth(line, tier.labelSize, measure))) + 20,
            height: lines.length * Math.ceil(measure.lineHeight(tier.labelSize, false) * 1.2) + 10 };
        };
        // Sideways, the rank gap only has to hold an arrow.
        const geometry = layoutDiagram(content, boxFor, { rankGap: Math.round(tier.rankGap * (horizontal ? 0.7 : 1)), nodeGap: tier.nodeGap, labelGap: 12, dummyWidth: 8, arrow: tier.arrow }, labelBox);
        // The largest tier that fits the whole card. Height alone never pushes
        // text below 32 px: from there the card grows (animations scroll).
        const fitsWidth = geometry.width <= avail, fitsCard = fitsWidth && geometry.height <= view.fit - margin * 2;
        chosen = { geometry, tier, boxes };
        if (fitsCard || (fitsWidth && tier.size <= 32)) break;
        if (fitsWidth && !widest) widest = chosen;
      }
      if (chosen!.geometry.width > avail && widest) chosen = widest;
      const { geometry, tier, boxes } = chosen!;
      if (geometry.width > avail) throw new ComposeError("overflow", `This diagram is ${Math.round(geometry.width)}px wide at its smallest size; the card has ${avail}px. ${horizontal ? "Try a top-down (graph TD) layout or" : "Use"} fewer nodes side by side. No content was dropped.`);
      const ox = margin + (avail - geometry.width) / 2;
      const oy = Math.max(margin, Math.round((view.height - geometry.height) / 2));
      const lineGroup = (rank: number) => rank * 2, nodeGroup = (rank: number) => rank * 2 + 1;
      // Edges first so boxes cover their ends.
      const arrow = (dir: "down" | "up" | "left" | "right") => {
        const name = `arrow-${dir}-${style.line.slice(1)}.svg`;
        const d = { down: "M4 8 L60 8 L32 60 Z", up: "M4 56 L60 56 L32 4 Z", right: "M8 4 L8 60 L60 32 Z", left: "M56 4 L56 60 L4 32 Z" }[dir];
        layout.assets[name] ??= `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><path d="${d}" fill="${style.line}"/></svg>`;
        return name;
      };
      for (const routed of geometry.edges) {
        const pts = routed.points.map((p) => ({ x: ox + p.x, y: oy + p.y }));
        const thick = routed.edge.line === "thick" ? style.lineWidth * 2 : style.lineWidth;
        const group = lineGroup(routed.rank);
        const A = tier.arrow;
        if (routed.edge.arrow && pts.length >= 2) {
          // Stop the line where the arrowhead begins.
          const a = pts[pts.length - 2]!, b = pts[pts.length - 1]!;
          const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
          const dir = dy > 0 ? "down" : dy < 0 ? "up" : dx > 0 ? "right" : "left";
          layout.images.push({ x: b.x - A / 2 - (dx > 0 ? A / 2 : dx < 0 ? -A / 2 : 0), y: b.y - A / 2 - (dy > 0 ? A / 2 : dy < 0 ? -A / 2 : 0), width: A, height: A, src: arrow(dir), group });
          pts[pts.length - 1] = { x: b.x - dx * (A - 2), y: b.y - dy * (A - 2) };
        }
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1]!, b = pts[i]!;
          const x = Math.min(a.x, b.x) - thick / 2, y = Math.min(a.y, b.y) - thick / 2;
          const w = Math.abs(b.x - a.x) + thick, h = Math.abs(b.y - a.y) + thick;
          if (routed.edge.line !== "dotted") { rect(x, y, w, h, style.line, thick / 2).group = group; continue; }
          const len = Math.max(w, h), along = w >= h;
          for (let t = 0; t < len; t += 18) {
            const seg = Math.min(10, len - t);
            rect(along ? x + t : x, along ? y : y + t, along ? seg : w, along ? h : seg, style.line, thick / 2).group = group;
          }
        }
        if (routed.label && routed.edge.label) {
          const lines = wrapStyled(styledGlyphs(normalizeText(routed.edge.label, "plain"), false, false), tier.nodeWidth * 0.8, tier.labelSize, measure);
          const lineH = Math.ceil(measure.lineHeight(tier.labelSize, false) * 1.2);
          const lw = Math.max(...lines.map((line) => styledWidth(line, tier.labelSize, measure)));
          const cx = ox + routed.label.x, cy = oy + routed.label.y;
          // The layout gives the label box's centre, whatever rule placed it.
          const bx = cx - (lw + 20) / 2, by = cy - (lines.length * lineH + 10) / 2;
          rect(bx, by, lw + 20, lines.length * lineH + 10, style.labelFill, 8).group = group;
          lines.forEach((line, i) => {
            const advance = styledWidth(line, tier.labelSize, measure);
            layout.lines.push({ text: line.map((g) => g.text).join(""), x: bx + 10 + (lw - advance) / 2, y: by + 5 + i * lineH, width: advance, size: tier.labelSize, height: lineH,
              bold: false, color: style.labelText, group, boldAt: line.map(() => false) });
          });
        }
      }
      const byId = new Map(content.nodes.map((node) => [node.id, node]));
      for (const placed of geometry.nodes) {
        const node = byId.get(placed.id)!, box = boxes.get(placed.id)!;
        const x = ox + placed.x, y = oy + placed.y, w = placed.width, h = placed.height;
        const group = nodeGroup(placed.rank);
        const accent = node.shape === "pill";
        const fill = accent ? style.accentFill : node.shape === "diamond" ? style.decisionFill : style.nodeFill;
        const border = node.shape === "diamond" ? style.decisionBorder : style.border;
        const ink = accent ? style.accentText : style.text;
        if (node.shape === "diamond") {
          const outer = `diamond-${border.slice(1)}.svg`, inner = `diamond-${fill.slice(1)}.svg`;
          const shape = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><path d="M128 0 L256 128 L128 256 L0 128 Z" fill="${color}"/></svg>`;
          layout.assets[outer] ??= shape(border); layout.assets[inner] ??= shape(fill);
          const bw = style.borderWidth * 1.6;
          layout.images.push({ x, y, width: w, height: h, src: outer, group });
          layout.images.push({ x: x + bw * w / h, y: y + bw, width: w - 2 * bw * w / h, height: h - 2 * bw, src: inner, group });
        } else {
          const radius = node.shape === "pill" ? h / 2 : node.shape === "round" && !style.square ? style.radius : style.square ? 2 : 4;
          if (!accent) rect(x, y, w, h, border, radius).group = group;
          const bw = accent ? 0 : style.borderWidth;
          rect(x + bw, y + bw, w - bw * 2, h - bw * 2, fill, Math.max(0, radius - bw)).group = group;
        }
        const lineH = Math.ceil(measure.lineHeight(tier.size, false) * 1.25);
        const top = y + (h - box.lines.length * lineH) / 2;
        box.lines.forEach((line, i) => {
          const advance = styledWidth(line, tier.size, measure);
          layout.lines.push({ text: line.map((g) => g.text).join(""), x: x + (w - advance) / 2, y: top + i * lineH, width: advance, size: tier.size, height: lineH,
            bold: accent, color: ink, group, boldAt: line.map(() => accent) });
        });
      }
      group = nodeGroup(geometry.ranks) + 1;
      // Reading and typing order follow the ranks, labels just before their targets.
      layout.lines.sort((a, b) => a.group - b.group);
      bottom = oy + geometry.height;
      break;
    }
    case "document": {
      const s = grown(pickStyle(DOCUMENT_STYLES, plan.variant), k);
      layout.background = s.background; margin = s.margin;
      let x = margin, width = innerW(), y = margin;
      if (s.rail) { x = margin + s.rail.width + s.rail.gap; width = Math.min(W - margin - x, s.measure); }
      const top = y;
      if (s.masthead) { rect(x, y, s.masthead.width, s.masthead.height, s.masthead.color); y += s.masthead.height + s.masthead.gap; }
      const blocks = content.blocks ?? content.paragraphs.map((text) => ({ kind: "paragraph" as const, text }));
      // The lede sets off an opening paragraph from what follows: a lone or long
      // paragraph (a whole note, a config dump) stays body text.
      let firstParagraph = blocks.length > 1 && blocks[0]!.kind === "paragraph" && graphemes(blocks[0]!.text).length <= 140;
      for (const [index, item] of blocks.entries()) {
        if (index) y += item.kind === "heading" ? s.headingGap : s.gap;
        if (item.kind === "heading") {
          const h = s[`h${item.level}`];
          y += block(item.text, x, y, width, h.size, true, h.color, { leading: h.leading }) + s.afterHeading;
        } else if (item.kind === "code") {
          const c = s.code;
          const h = block(item.code, x + c.pad, y + c.pad, width - c.pad * 2, c.size, false, c.ink, { code: true, markdown: false, leading: c.leading });
          rect(x, y, width, h + c.pad * 2, c.fill, c.radius); y += h + c.pad * 2;
        } else if (item.kind === "list") {
          for (const [i, entry] of item.items.entries()) {
            if (i) y += s.list.gap;
            // Ordered numbers restate the source's own markers: digits only, nothing added.
            if (item.ordered) block(String(i + 1), x, y, s.list.indent, s.body.size, true, s.list.color, { leading: s.body.leading });
            else rect(x + 4, y + mid(s.body.size) - s.list.dot / 2, s.list.dot, s.list.dot, s.list.color, s.list.dot / 2);
            y += block(entry, x + s.list.indent, y, width - s.list.indent, s.body.size, false, s.body.color, { leading: s.body.leading });
          }
        } else {
          const t = s.lede && firstParagraph ? s.lede : s.body; firstParagraph = false;
          y += block(item.text, x, y, width, t.size, t.bold, t.color, { leading: t.leading });
        }
      }
      if (s.rail) rect(margin, top, s.rail.width, y - top, s.rail.color);
      bottom = settle(top, y);
      break;
    }
    case "quote": {
      const s = pickStyle(QUOTE_STYLES, plan.variant);
      layout.background = s.background; margin = s.margin;
      const x0 = margin + (s.rule ? s.rule.width + s.rule.gap : 0), width = W - margin - x0;
      const authorH = content.author ? s.author.gap + lh(s.author.size, 1.2, s.author.bold) : 0;
      const avail = view.fit - margin * 2 - s.mark.size - s.mark.gap - authorH;
      const sizes: readonly number[] = s.sizes;
      const size = sizes.find((sz) => count(content.text, width, sz, s.bold) * lh(sz, s.leading, s.bold) <= avail) ?? sizes[sizes.length - 1]!;
      let y = margin; const top = y;
      layout.images.push({ x: x0, y, width: s.mark.size, height: s.mark.size, src: svg("quote", QUOTE_MARK_PATH, s.mark.color), group: 0 });
      y += s.mark.size + s.mark.gap;
      y += block(content.text, x0, y, width, size, s.bold, s.ink, { leading: s.leading });
      if (content.author) {
        const a = s.author; y += a.gap;
        // The dash before the author is a shape, not a "—" glyph.
        rect(x0, y + mid(a.size) - a.ruleHeight / 2, a.ruleWidth, a.ruleHeight, a.color);
        y += block(content.author, x0 + a.ruleWidth + 20, y, width - a.ruleWidth - 20, a.size, a.bold, a.color, { leading: 1.2 });
      }
      if (s.rule) rect(margin, top, s.rule.width, y - top, s.rule.color);
      bottom = settle(top, y);
      break;
    }
    case "code": {
      const s = pickStyle(CODE_STYLES, plan.variant);
      layout.background = s.background; margin = s.outer;
      const source = normalizeText(content.code, "code").split("\n");
      const P = s.panel, G = s.gutter, LN = s.lineNumbers;
      // Line numbers count from 1 (a clipboard does not carry the original ones).
      const digits = String(Math.max(1, source.length)).length;
      const gutterW = (sz: number) => LN ? Math.ceil(measure.width("0".repeat(digits), sz, false)) + LN.gap : 0;
      const textX = P ? margin + P.pad : margin + (G?.width ?? 0) + (G?.gap ?? 0);
      const textW = P ? W - 2 * margin - 2 * P.pad : W - margin - textX - (s.zebra?.pad ?? 0);
      const langH = content.language && !P ? lh(s.lang.size, 1.2, s.lang.bold) + s.lang.gap : 0;
      const availH = view.fit - 2 * margin - (P ? 2 * P.pad + P.header : langH);
      const fits = (sz: number) => source.every((line) => measure.width(line, sz, false) <= textW - gutterW(sz));
      // The largest size that fits without wrapping and within the frame; else
      // the largest unwrapped size at or below the floor (the canvas grows / scrolls).
      const sizes: readonly number[] = s.sizes;
      const size = sizes.find((sz) => fits(sz) && source.length * lh(sz, s.leading) <= availH)
        ?? sizes.find((sz) => sz <= s.floor && fits(sz)) ?? sizes[sizes.length - 1]!;
      const codeX = textX + gutterW(size), codeW = textW - gutterW(size);
      const backdrop: TemplateRect[] = [];
      for (const layer of (s.backdrop ?? []) as readonly BackdropLayer[]) {
        if ("arc" in layer) {
          // A hue arc as adjacent left-to-right segments on whole pixels, so the seams meet exactly.
          const colors = sampleArc(layer.arc, layer.segments);
          for (let i = 0; i < layer.segments; i++) {
            const x0 = Math.round((W * i) / layer.segments), x1 = Math.round((W * (i + 1)) / layer.segments);
            const r = rect(x0, 0, x1 - x0, 0, colors[i + 1]!); r.gradient = { dir: "r", from: colors[i]!, to: colors[i + 1]! };
            pinned.add(r); backdrop.push(r);
          }
          continue;
        }
        const r = rect(0, 0, W, 0, layer.to); r.gradient = layer; pinned.add(r); backdrop.push(r);
      }
      let y = margin; const top = y;
      let panel: TemplateRect | undefined;
      if (P) {
        panel = rect(margin, y, W - 2 * margin, 0, P.fill, P.radius);
        panel.shadow = P.shadow;
        const dotY = y + (P.header - P.dots.size) / 2 + P.pad / 4;
        P.dots.colors.forEach((color, i) => rect(margin + P.pad + i * (P.dots.size + P.dots.gap), dotY, P.dots.size, P.dots.size, color, P.dots.size / 2));
        if (content.language) block(content.language, textX, dotY + P.dots.size / 2 - lh(s.lang.size, 1) / 2, textW, s.lang.size, s.lang.bold, s.lang.color, { align: "right", leading: 1 });
        y += P.pad / 2 + P.header;
      } else if (content.language) y += block(content.language, textX, y, textW, s.lang.size, s.lang.bold, s.lang.color, { leading: 1.2 }) + s.lang.gap;
      const codeTop = y;
      const colors = codeColors(source.join("\n"), content.language, s.syntax);
      for (const [index, line] of source.entries()) {
        const start = y;
        if (LN) block(String(index + 1), textX, y, gutterW(size) - LN.gap, size, false, LN.color, { align: "right", leading: s.leading, code: true, markdown: false });
        const h = place(glyphsOf(line, false, { code: true, markdown: false, colors: colors[index] }), codeX, y, codeW, size, false, s.ink, { leading: s.leading });
        if (s.zebra && index % 2 === 1) rect(textX - s.zebra.pad, start, textW + 2 * s.zebra.pad, h, s.zebra.color, s.zebra.radius);
        y += h;
      }
      backdropRects = backdrop;
      if (G) rect(margin, codeTop, G.width, y - codeTop, G.color);
      if (panel && P) { y += P.pad; panel.height = y - panel.y; }
      bottom = settle(top, y);
      break;
    }
    case "stat": {
      const s = pickStyle(STAT_STYLES, plan.variant);
      layout.background = s.background; margin = s.margin;
      const sizes: readonly number[] = s.valueSizes;
      const size = sizes.find((sz) => measure.width(content.value, sz, true) <= innerW()) ?? sizes[sizes.length - 1]!;
      let y = margin; const top = y;
      if (s.band) {
        const band = rect(0, y, W, 0, s.band.color);
        // Figures sit high in a top-aligned line box (cap height ~0.73, no descent):
        // lift them so their ink centres in the band.
        band.height = block(content.value, margin, y + s.band.pad - Math.round(size * 0.13), innerW(), size, true, s.valueColor, { leading: s.valueLeading }) + s.band.pad * 2;
        y += band.height + s.band.gap;
      } else {
        y += block(content.value, margin, y, innerW(), size, true, s.valueColor, { leading: s.valueLeading });
        if (s.bar) { y += s.bar.gap; rect(margin, y, s.bar.width, s.bar.height, s.bar.color); y += s.bar.height + s.bar.gap; }
      }
      y += block(content.label, margin, y, Math.min(innerW(), s.labelMeasure), s.labelSize, false, s.labelColor, { leading: s.labelLeading });
      bottom = settle(top, y);
      break;
    }
    case "list": {
      const s = grown(pickStyle(LIST_STYLES, plan.variant), k);
      layout.background = s.background; margin = s.margin;
      let y = margin; const top = y;
      for (const [index, item] of content.items.entries()) {
        if (s.card) {
          if (index) y += s.card.gap;
          const card = rect(margin, y, innerW(), 0, s.card.fill, s.card.radius);
          const ty = y + s.card.pad;
          const h = block(item, margin + s.indent, ty, innerW() - s.indent - s.card.pad, s.size, false, s.ink, { leading: s.leading });
          if (content.ordered) block(String(index + 1), margin + s.card.pad, ty + base(s.size) - base(s.number.size), s.indent - s.card.pad, s.number.size, true, s.number.color, { leading: 1 });
          else if (s.dot) rect(margin + s.card.pad + 8, ty + mid(s.size) - s.dot.size / 2, s.dot.size, s.dot.size, s.dot.color, s.dot.size / 2);
          card.height = h + s.card.pad * 2; y += card.height;
        } else {
          if (index) { y += s.gap; if (s.rule) rect(margin + s.indent, y, innerW() - s.indent, 2, s.rule); y += 2 + s.gap; }
          if (content.ordered) block(String(index + 1), margin, y, s.indent, s.number.size, true, s.number.color, { leading: s.leading });
          else if (s.box) {
            const b = s.box, by = y + mid(s.size) - b.size / 2;
            rect(margin, by, b.size, b.size, b.color, b.radius);
            rect(margin + b.border, by + b.border, b.size - b.border * 2, b.size - b.border * 2, s.background, b.radius - b.border);
          }
          y += block(item, margin + s.indent, y, innerW() - s.indent, s.size, false, s.ink, { leading: s.leading });
        }
      }
      bottom = settle(top, y);
      break;
    }
    case "chat": {
      const s = grown(pickStyle(CHAT_STYLES, plan.variant), k);
      layout.background = s.background; margin = s.margin;
      const speakers = [...new Set(content.turns.map((turn) => turn.speaker))];
      let y = margin; const top = y;
      for (const [index, turn] of content.turns.entries()) {
        const who = speakers.indexOf(turn.speaker);
        if ("left" in s) {
          if (index) y += s.gap;
          const right = who % 2 === 1, maxW = Math.round(innerW() * s.maxRatio), side = right ? s.right : s.left;
          const nameW = Math.min(measure.width(turn.speaker, s.name.size, true), maxW);
          const timeW = turn.time ? measure.width(turn.time, s.time.size, false) : 0;
          // Name and time share a row when both fit on one; otherwise the time goes under the name.
          const inline = !!turn.time && count(turn.speaker, maxW, s.name.size, true) === 1 && nameW + 16 + timeW <= maxW;
          const edge = right ? W - margin - 8 : margin + 8;
          const nx = right ? edge - (inline ? nameW + 16 + timeW : maxW) : edge;
          let nameH = block(turn.speaker, nx, y, inline ? Math.ceil(nameW) + 1 : maxW, s.name.size, true, s.name.color, { leading: 1.2, align: right && !inline ? "right" : "left" });
          if (turn.time) {
            if (inline) block(turn.time, nx + nameW + 16, y + base(s.name.size) - base(s.time.size), Math.ceil(timeW) + 1, s.time.size, false, s.time.color, { leading: 1.2 });
            else nameH += block(turn.time, right ? edge - maxW : edge, y + nameH, maxW, s.time.size, false, s.time.color, { leading: 1.2, align: right ? "right" : "left" });
          }
          y += nameH + s.name.gap;
          const glyphs = glyphsOf(turn.text, false);
          const textW = Math.max(s.size, ...wrapStyled(glyphs, maxW - 2 * s.padX, s.size, measure).map((line) => styledWidth(line, s.size, measure)));
          const bubbleW = Math.ceil(textW + 2 * s.padX), bx = right ? W - margin - bubbleW : margin;
          const bubble = rect(bx, y, bubbleW, 0, side.fill, s.radius);
          bubble.height = place(glyphs, bx + s.padX, y + s.padY, maxW - 2 * s.padX, s.size, false, side.ink, { leading: s.leading }) + s.padY * 2 - Math.round(s.size * 0.12);
          y += bubble.height;
        } else {
          if (index) { y += s.gap; rect(margin, y, innerW(), 2, s.rule); y += 2 + s.gap; }
          const color = s.speakers[who % s.speakers.length]!;
          // The name's first line centres on the text's first line; the time goes under it.
          const nameTop = y + base(s.size) - base(s.name.size);
          let nameH = nameTop - y + block(turn.speaker, margin, nameTop, s.nameCol - 32, s.name.size, true, color, { leading: 1.2 });
          if (turn.time) nameH += 6 + block(turn.time, margin, y + nameH + 6, s.nameCol - 32, s.time.size, false, s.time.color, { leading: 1.2 });
          y += Math.max(nameH, block(turn.text, margin + s.nameCol, y, innerW() - s.nameCol, s.size, false, s.ink, { leading: s.leading }));
        }
      }
      bottom = settle(top, y);
      break;
    }
    case "table": {
      if (!content.headers.length || content.headers.length > 6 || content.rows.some((row) => row.length !== content.headers.length)) {
        throw new ComposeError("overflow", "A table needs 1–6 columns and the same number of cells in every row.");
      }
      const s = grown(pickStyle(TABLE_STYLES, plan.variant), k);
      layout.background = s.background; margin = s.margin;
      const cols = content.headers.length, all = [content.headers, ...content.rows];
      let y = margin; const top = y;
      if ("sizes" in s) {
        const inner = innerW();
        let pick: { size: number; widths: number[] } | undefined;
        for (const size of s.sizes as readonly number[]) {
          // Columns take their natural width; spare room is shared in proportion.
          const natural = content.headers.map((_, c) => Math.max(...all.map((row, r) => measure.width(row[c]!, size, r === 0))) + 2 * s.padX);
          const sum = natural.reduce((a, b) => a + b, 0);
          const raw = sum <= inner ? natural.map((n) => n + (inner - sum) * n / sum) : natural.map((n) => Math.max(inner / cols * 0.6, n * inner / sum));
          const scale = inner / raw.reduce((a, b) => a + b, 0), widths = raw.map((w) => w * scale);
          const lines = all.map((row, r) => Math.max(...row.map((cell, c) => count(cell, widths[c]! - 2 * s.padX, size, r === 0))));
          const height = lines.reduce((a, n) => a + n * lh(size, s.leading) + 2 * s.padY, 0);
          pick = { size, widths };
          if (Math.max(...lines) <= s.maxLines && height <= view.fit - 2 * margin) break;
        }
        const { size, widths } = pick!;
        const card = rect(margin, y, inner, 0, s.card.fill, s.card.radius);
        for (const [r, row] of all.entries()) {
          const rowY = y;
          const n = Math.max(...row.map((cell, c) => count(cell, widths[c]! - 2 * s.padX, size, r === 0)));
          const rowH = n * lh(size, s.leading, r === 0) + 2 * s.padY;
          // Rects have one radius: a square-cornered half covers the inner corners.
          if (r === 0) { rect(margin, rowY, inner, rowH, s.head.fill, s.card.radius); rect(margin, rowY + rowH / 2, inner, rowH / 2, s.head.fill); }
          else if (r % 2 === 0) {
            if (r === all.length - 1) { rect(margin, rowY, inner, rowH, s.zebra, s.card.radius); rect(margin, rowY, inner, rowH / 2, s.zebra); }
            else rect(margin, rowY, inner, rowH, s.zebra);
          }
          let x = margin;
          for (const [c, cell] of row.entries()) {
            if (c && r) rect(x, rowY, 2, rowH, s.divider);
            block(cell, x + s.padX, rowY + s.padY, widths[c]! - 2 * s.padX, size, r === 0, r === 0 ? s.head.ink : s.ink, { leading: s.leading, markdown: false });
            x += widths[c]!;
          }
          y += rowH;
        }
        card.height = y - card.y;
      } else {
        // Ledger: header[0] labels each record's title; every header is drawn with its value, so nothing is dropped.
        const fields = cols - 1, per = Math.min(s.perRow, Math.max(1, fields));
        const x0 = margin + s.marker.size + 24, fieldW = (W - margin - x0) / per;
        for (const [r, row] of content.rows.entries()) {
          if (r) { y += s.gap; rect(margin, y, innerW(), 2, s.rule); y += 2 + s.gap; }
          y += block(content.headers[0]!, x0, y, W - margin - x0, s.labelSize, true, s.label, { leading: 1.2, markdown: false }) + 4;
          rect(margin, y + mid(s.titleSize) - s.marker.size / 2, s.marker.size, s.marker.size, s.marker.color);
          y += block(row[0]!, x0, y, W - margin - x0, s.titleSize, true, s.ink, { leading: s.leading, markdown: false }) + 20;
          let rowMax = 0;
          for (let c = 1; c < cols; c++) {
            const slot = (c - 1) % per;
            if (slot === 0 && c > 1) { y += rowMax + s.fieldGap; rowMax = 0; }
            const fx = x0 + slot * fieldW;
            const a = block(content.headers[c]!, fx, y, fieldW - 24, s.labelSize, true, s.label, { leading: 1.2, markdown: false });
            const b = block(row[c]!, fx, y + a + 2, fieldW - 24, s.valueSize, false, s.ink, { leading: s.leading, markdown: false });
            rowMax = Math.max(rowMax, a + 2 + b);
          }
          y += rowMax;
        }
      }
      bottom = settle(top, y);
      break;
    }
    case "comparison": {
      if (content.columns.length !== 2) throw new ComposeError("catalog", "Comparison templates require exactly two columns.");
      const s = grown(pickStyle(COMPARISON_STYLES, plan.variant), k);
      layout.background = s.background; margin = s.margin;
      const items = (x: number, y: number, width: number, column: { items: readonly string[] }, p: { ink: string; bullet: string }) => {
        for (const [j, item] of column.items.entries()) {
          if (j) y += s.itemGap;
          rect(x, y + mid(s.itemSize) - s.bullet / 2, s.bullet, s.bullet, p.bullet, 2);
          y += block(item, x + s.bullet + 20, y, width - s.bullet - 20, s.itemSize, false, p.ink, { leading: s.leading });
        }
        return y;
      };
      if (s.layout === "columns") {
        const cw = (innerW() - s.gap) / 2, panels: TemplateRect[] = [];
        for (const [i, column] of content.columns.entries()) {
          const x = margin + i * (cw + s.gap), p = s.panels[i]!;
          const panel = rect(x, margin, cw, 0, p.fill, s.radius); panels.push(panel);
          let y = margin + s.pad;
          y += block(column.title, x + s.pad, y, cw - 2 * s.pad, s.titleSize, true, p.title, { leading: 1.1 }) + s.titleGap;
          y = items(x + s.pad, y, cw - 2 * s.pad, column, p);
          panel.height = y + s.pad - margin;
        }
        // Both panels fill the frame height (never less than their content).
        const h = Math.max(view.height - 2 * margin, ...panels.map((p) => p.height));
        for (const p of panels) p.height = h;
        bottom = margin + h;
      } else {
        // The title column holds the longest title on one line when it can (up to 45% of the width).
        const widest = Math.max(...content.columns.map((c) => Math.ceil(measure.width(c.title, s.titleSize, true))));
        const titleCol = Math.min(Math.round(W * 0.45), Math.max(Math.round(W * s.titleCol), margin + widest + 48));
        let y = 0;
        for (const [i, column] of content.columns.entries()) {
          const p = s.panels[i]!, band = rect(0, y, W, 0, p.fill); pinned.add(band);
          const firstLine = layout.lines.length, firstShape = layout.shapes.length;
          const titleH = block(column.title, margin, y + margin, titleCol - margin - 48, s.titleSize, true, p.title, { leading: 1.1 });
          const end = items(titleCol, y + margin, W - margin - titleCol, column, p);
          const contentH = Math.max(titleH, end - y - margin) + 2 * margin;
          // Two full-bleed bands: the first takes at least half the frame, the second the rest.
          const target = i === 0 ? Math.max(contentH, Math.round(view.height / 2)) : Math.max(contentH, view.height - y);
          const dy = Math.round((target - contentH) / 2);
          for (const line of layout.lines.slice(firstLine)) line.y += dy;
          for (const shape of layout.shapes.slice(firstShape)) shape.y += dy;
          band.height = target; y += target;
        }
        bottom = y - margin;
      }
      break;
    }
  }
  const glyphCount = layout.lines.reduce((total, line) => total + graphemes(line.text).length, 0);
  if ((!glyphCount && plan.content.kind !== "qr") || !plan.sourceText.trim()) throw new ComposeError("empty", "There is no text to render.");
  if (glyphCount > TEMPLATE_LIMITS.maxGraphemes) throw new ComposeError("overflow", `This template contains ${glyphCount} characters; the supported maximum is ${TEMPLATE_LIMITS.maxGraphemes}. Split the source into smaller cards. No content was truncated.`);
  layout.height = Math.ceil(Math.max(view.height, bottom + margin) / 2) * 2;
  if (layout.height > TEMPLATE_LIMITS.maxHeight) throw new ComposeError("overflow", `The complete content needs ${layout.height}px of height (maximum ${TEMPLATE_LIMITS.maxHeight}px). Choose a wider aspect or split the source. No content was truncated.`);
  if (pinBottom) pinBottom.y = layout.height - pinBottom.height;
  for (const r of backdropRects) r.height = layout.height;
  return layout;
}

export interface TemplateTiming { frames: number; revealMs: number; holdMs: number; delay(index: number, total: number): number }
export function templateTiming(motion: TemplateMotion, count: number): TemplateTiming {
  if (motion === "none") return { frames: 1, revealMs: 0, holdMs: 0, delay: () => 0 };
  const revealMs = motion === "typewriter" ? Math.min(TEMPLATE_LIMITS.typingMaxMs, Math.max(700, count * 35)) : 1400;
  return { frames: Math.ceil((revealMs + TEMPLATE_LIMITS.holdMs + 250) / 1000 * TEMPLATE_LIMITS.fps) + 1,
    revealMs, holdMs: TEMPLATE_LIMITS.holdMs,
    delay: (index, total) => Math.round(index / Math.max(1, total - 1) * revealMs) };
}

export interface ScrollTiming extends TemplateTiming { scrollMs: number; startMs: number; distance: number }
export function scrollTiming(distance: number): ScrollTiming {
  const scrollMs = Math.round(Math.min(TEMPLATE_SCROLL.maxMs, Math.max(TEMPLATE_SCROLL.minMs, distance / TEMPLATE_SCROLL.pxPerS * 1000)));
  const total = TEMPLATE_SCROLL.startMs + scrollMs + TEMPLATE_SCROLL.endMs;
  return { frames: Math.ceil(total / 1000 * TEMPLATE_LIMITS.fps) + 1, revealMs: 0, holdMs: TEMPLATE_SCROLL.endMs, delay: () => 0,
    scrollMs, startMs: TEMPLATE_SCROLL.startMs, distance };
}
/** Whether an animated layout scrolls rather than growing the canvas. */
export function scrolls(motion: TemplateMotion, layoutHeight: number, viewHeight: number): boolean {
  return motion !== "none" && layoutHeight > viewHeight;
}

/** The one font pair a template composition is set in. */
export type TemplateFont = "noto-sans-sc" | "peesuto-code";
/** Peesuto Code (Maple Mono NL CN v7.9 subset, SIL OFL 1.1; see render/fonts/README.md) ships with core. */
export const CODE_FONT_DIR = fileURLToPath(new URL("../render/fonts/", import.meta.url));
export const CODE_FONT = { regular: "PeesutoCode-Regular.ttf", bold: "PeesutoCode-Bold.ttf" } as const;
/** Where a staged code font sits in the composition, relative to the work tree root. */
const CODE_FONT_STAGE = "compositions/paste/fonts";

/** Code cards use Peesuto Code unless it lacks a (non-emoji) glyph of the
 * content: then the whole card falls back to Noto Sans SC, without an error.
 * Every other template keeps Noto Sans SC. */
export function chooseTemplateFont(template: TemplateId, missingInCodeFont: readonly string[]): TemplateFont {
  return template === "code" && missingInCodeFont.length === 0 ? "peesuto-code" : "noto-sans-sc";
}

/** Face files for the measurer (absolute) and the composition (work-tree relative, no ".."). */
export function fontFaces(font: TemplateFont, engine: string): { measure: { regular: string; bold: string }; composition: { regular: string; bold: string } } {
  if (font === "peesuto-code") return {
    measure: { regular: join(CODE_FONT_DIR, CODE_FONT.regular), bold: join(CODE_FONT_DIR, CODE_FONT.bold) },
    composition: { regular: `${CODE_FONT_STAGE}/${CODE_FONT.regular}`, bold: `${CODE_FONT_STAGE}/${CODE_FONT.bold}` },
  };
  return {
    measure: { regular: `${engine}/assets/fonts/NotoSansSC-Regular.otf`, bold: `${engine}/assets/fonts/NotoSansSC-Bold.otf` },
    composition: { regular: "assets/fonts/NotoSansSC-Regular.otf", bold: "assets/fonts/NotoSansSC-Bold.otf" },
  };
}

/** Put the code font inside the composition (`<dir>/fonts/`): the engine only
 * takes font paths inside the work tree, and never gets written into. A hard
 * link when the volume allows it, else a copy; an up-to-date file is kept. */
async function stageFont(font: TemplateFont, dir: string): Promise<void> {
  if (font !== "peesuto-code") return;
  await mkdir(join(dir, "fonts"), { recursive: true });
  for (const name of Object.values(CODE_FONT)) {
    const from = join(CODE_FONT_DIR, name), to = join(dir, "fonts", name);
    const source = await stat(from);
    const current = await stat(to).catch(() => undefined);
    if (current && (current.ino === source.ino || (current.size === source.size && current.mtimeMs >= source.mtimeMs))) continue;
    await rm(to, { force: true });
    try { await link(from, to); } catch { await copyFile(from, to); }
  }
}

interface EngineMeasurer {
  measure(size: number, bold?: boolean): (text: string) => number;
  lineHeight(size: number, bold?: boolean): number;
  unmapped(text: string, size: number, bold?: boolean): string[];
  close(): Promise<void>;
}

export async function composeTemplate(plan: TemplatePlan, options: ComposeOptions): Promise<TemplateComposeResult> {
  // A QR code carries any script; only its optional caption needs glyphs.
  const qr = plan.content.kind === "qr" ? plan.content : undefined;
  const script = qr ? undefined : unsupportedScript(plan.sourceText);
  if (script) throw new ComposeError("unsupported-script", `The card font does not support ${script}; no content was rendered or truncated.`);
  const work = resolve(options.work), dir = `${work}/compositions/paste`;
  await mkdir(dir, { recursive: true });
  const api = await import(`${options.engine}/src/text/measure.ts`) as { openMeasurer(options: unknown): Promise<EngineMeasurer> };
  const serialized = JSON.stringify(plan.content);
  const caption = qr ? qrCaption(qr) : undefined;
  const texts = qr ? ["0", ...(caption && !unsupportedScript(caption) ? [stripEmoji(caption)] : [])] : [stripEmoji(serialized), LAYOUT_GLYPHS];
  if (qr && caption && unsupportedScript(caption)) plan = { ...plan, content: { ...qr, caption: false } };
  const charset = await Bun.file(new URL("../render/charset.txt", import.meta.url)).text();
  // The measure cache is keyed by the face files' content (and charset, sizes),
  // so Noto and Peesuto Code metrics live in separate cache directories.
  const open = (font: TemplateFont) => api.openMeasurer({
    face: fontFaces(font, options.engine).measure,
    sizes: SIZES.flatMap((px) => [{ px, bold: false }, { px, bold: true }]), texts, density: 1,
    cache: { charset, dir: `${work}/dist/.measure` },
  });
  let font: TemplateFont = plan.template === "code" ? "peesuto-code" : "noto-sans-sc";
  let m = await open(font);
  if (font === "peesuto-code") {
    // A glyph the code font lacks (emoji aside) sets the whole card in Noto Sans SC instead.
    const chosen = chooseTemplateFont(plan.template, texts.flatMap((text) => m.unmapped(text, 40, false)));
    if (chosen !== font) { await m.close(); font = chosen; m = await open(font); }
  }
  try {
    for (const text of texts) {
      const missing = m.unmapped(text, 40, false);
      if (missing.length && qr) { plan = { ...plan, content: { ...qr, caption: false } }; continue; }
      if (missing.length) {
        const shown = [...new Set(missing)].slice(0, 8);
        const names = shown.map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}${/\S/u.test(c) && !/\p{C}/u.test(c) ? ` ${c}` : ""}`);
        throw new ComposeError("unsupported-script", `The font cannot draw ${names.join(", ")}. No content was truncated.`, shown);
      }
    }
    const metrics: TemplateMeasure = {
      width: (text, size, bold) => splitEmoji(text).reduce((width, run) => width + ("emoji" in run ? size : m.measure(size, bold)(run.text)), 0),
      lineHeight: (size, bold) => m.lineHeight(size, bold),
    };
    const layout = layoutTemplate(plan, metrics);
    const count = layout.lines.reduce((total, line) => total + graphemes(line.text).length, 0);
    // GIF/MP4 keep their frame strictly: taller content scrolls through it.
    const frame = plan.aspect === "auto" ? undefined : FRAMES[plan.aspect];
    const scroll = frame !== undefined && scrolls(plan.motion, layout.height, frame.height);
    const frameHeight = scroll ? frame!.height : layout.height;
    const timing = scroll ? scrollTiming(layout.height - frame!.height) : templateTiming(plan.motion, count);
    const groups = Math.max(1, ...layout.lines.map((line) => line.group + 1), ...layout.shapes.map((shape) => (shape.group ?? -1) + 1), ...layout.images.map((image) => (image.group ?? -1) + 1));
    // Grouped shapes and images appear with their group: in reading order, or
    // when the typewriter reaches the group's first character.
    const glyphStart = new Map<number, number>();
    { let at = 0; for (const line of layout.lines) { if (!glyphStart.has(line.group)) glyphStart.set(line.group, at); at += graphemes(line.text).length; } }
    const startOf = (g: number) => { for (let k = g; k < groups; k++) if (glyphStart.has(k)) return glyphStart.get(k)!; return Math.max(0, count - 1); };
    const shapeAnimation = (name: string, g: number | undefined): string => {
      if (g === undefined || plan.motion === "none" || scroll) return "";
      keyframes.fade ??= { from: { opacity: "0" }, to: { opacity: "1" } };
      const delay = plan.motion === "typewriter" ? timing.delay(startOf(g), count) : timing.delay(g, groups);
      animations[name] = { value: `fade 240ms ease-out ${delay}ms both` };
      return ` animate-${name}`;
    };
    const animations: Record<string, { value: string }> = {};
    const keyframes: Record<string, unknown> = {};
    const emojiKeys = new Set<string>();
    const nodes: string[] = [];
    let glyphIndex = 0;
    for (const [i, shape] of layout.shapes.entries()) {
      const fill = shape.gradient ? `bg-gradient-to-${shape.gradient.dir} from-[${shape.gradient.from}] to-[${shape.gradient.to}]` : `bg-[${shape.color}]`;
      nodes.push(`<View class="absolute left-[${shape.x}px] top-[${shape.y}px] w-[${shape.width}px] h-[${shape.height}px] ${fill} rounded-[${shape.radius}px]${shape.shadow ? ` ${shape.shadow}` : ""}${shapeAnimation(`s${i}`, shape.group)}" />`);
    }
    for (const [i, image] of layout.images.entries()) nodes.push(`<Image class="absolute left-[${image.x}px] top-[${image.y}px] w-[${image.width}px] h-[${image.height}px]${shapeAnimation(`i${i}`, image.group)}" src="${image.src}" />`);
    for (const [name, svg] of Object.entries(layout.assets)) await Bun.write(`${dir}/${name}`, svg);
    for (const line of layout.lines) {
      const prefix: StyledGlyph[] = [];
      for (const [glyphPosition, glyph] of graphemes(line.text).entries()) {
        const bold = line.boldAt[glyphPosition] ?? line.bold;
        const x = line.x + styledWidth(prefix, line.size, metrics);
        prefix.push({ text: glyph, bold });
        const index = glyphIndex++;
        if (!glyph.trim()) continue;
        let animation = "";
        if (plan.motion !== "none" && !scroll) {
          const name = `t${index}`;
          const typewriter = plan.motion === "typewriter";
          keyframes[typewriter ? "appear" : "reveal"] ??= typewriter
            ? { from: { opacity: "0" }, to: { opacity: "1" } }
            : { from: { opacity: "0", translateY: "10px" }, to: { opacity: "1", translateY: "0px" } };
          animations[name] = { value: `${typewriter ? "appear 1ms linear" : "reveal 240ms ease-out"} ${timing.delay(typewriter ? index : line.group, typewriter ? count : groups)}ms both` };
          animation = ` animate-${name}`;
        }
        const emoji = splitEmoji(glyph).find((run) => "emoji" in run);
        if (emoji && "emoji" in emoji) {
          emojiKeys.add(emoji.key);
          nodes.push(`<Image class="absolute left-[${x}px] top-[${line.y + (line.height - line.size) / 2}px] w-[${line.size}px] h-[${line.size}px]${animation}" src="e_${emoji.key}.png" />`);
        } else {
          const color = line.colorAt?.[glyphPosition] ?? line.color;
          nodes.push(`<Text class="absolute left-[${x}px] top-[${line.y}px] text-[${line.size}px] ${bold ? "font-bold" : ""} text-[${color}] h-[${line.height}px]${animation}">{${JSON.stringify(glyph)}}</Text>`);
        }
      }
    }
    const emoji = await stageEmoji(emojiKeys, options.emojiCache, dir, options.emojiBundle);
    await Bun.write(`${dir}/images.json`, JSON.stringify(Object.fromEntries([...emoji, ...Object.keys(layout.assets)].map((file) => [file, { linear: true }]))) + "\n");
    let body = nodes.join("\n");
    if (scroll) {
      const t = timing as ScrollTiming;
      keyframes.scroll = { from: { translateY: "0px" }, to: { translateY: `-${t.distance}px` } };
      animations.scroll = { value: `scroll ${t.scrollMs}ms ease-in-out ${t.startMs}ms both` };
      body = `<View class="absolute left-[0px] top-[0px] w-[${layout.width}px] h-[${layout.height}px] animate-scroll">\n${body}\n</View>`;
    }
    await Bun.write(`${dir}/main.tsx`, `// GENERATED template ${plan.template}/${plan.variant}; text positions are fixed across frames.\nimport { mount } from "@pocketjs/framework";\nimport { View, Text${emoji.length || layout.images.length ? ", Image" : ""} } from "@pocketjs/framework/components";\nmount(() => (<View class="w-full h-full bg-[${layout.background}]">\n${body}\n</View>));\n`);
    await Bun.write(`${dir}/pocket.config.ts`, `import { definePocketConfig } from "../../vendor/pocketjs/framework/src/config.ts";\nexport default definePocketConfig({theme:{keyframes:${JSON.stringify(keyframes)},animation:${JSON.stringify(animations)}}});\n`);
    await stageFont(font, dir);
    await Bun.write(`${dir}/pocket-motion.json`, JSON.stringify({ motion: 1, durationFrames: timing.frames, fps: TEMPLATE_LIMITS.fps, supersample: 1,
      fonts: fontFaces(font, options.engine).composition }, null, 2));
    await Bun.write(`${dir}/pocket.json`, JSON.stringify({ $schema: "https://pocketjs.dev/schema/pocket-2.json", pocket: 2,
      id: "dev.pocket-stack.motion-paste", name: "pocketjs-motion-paste", title: `${plan.template} ${plan.variant}`, version: "0.0.0",
      engine: { capabilities: { requires: ["text.glyphs.baked"] } },
      app: { entry: "compositions/paste/main.tsx", output: "motion-paste", framework: "solid", viewport: { fixed: { logical: [layout.width, frameHeight], presentation: "native" } } } }, null, 2));
    await Bun.write(`${dir}/template-layout.json`, JSON.stringify({ template: plan.template, variant: plan.variant, font, width: layout.width, height: layout.height, frameHeight, scroll,
      lines: layout.lines.map(({ text: _text, ...geometry }) => geometry), timing: { frames: timing.frames, revealMs: timing.revealMs, holdMs: timing.holdMs } }, null, 2));
    return { dir, lines: layout.lines.length, size: Math.max(...layout.lines.map((line) => line.size)), frames: timing.frames,
      emoji: emoji.length, truncated: false, width: layout.width, height: frameHeight, template: plan.template, variant: plan.variant, motion: plan.motion, scroll };
  } finally { await m.close(); }
}
