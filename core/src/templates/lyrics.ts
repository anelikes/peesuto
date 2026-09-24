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
 * Engine notes (Pocket Motion as pinned): one font pair per composition,
 * keyframes on translate/rotate/scale/opacity/colour, `scale` and `rotate`
 * move glyphs but never resize or turn them (so "scale" and "rotate"
 * entrances move a line's glyphs together: they gather in, or the line swings
 * down into place), shapes are fill-only, two-stop gradients, no blur or text
 * stroke. The style tables carry typed `null` slots for what the engine will
 * gain (faces, stroke, gradient text, blur); search for `TODO(engine` below.
 */
import { splitEmoji } from "../render/emoji.ts";
import { ComposeError, normalizeText } from "../render/compose.ts";
import { checkLayout, fidelityViolations, type CheckViolation } from "./checks.ts";
import type { LyricLine, TemplateContent, TemplatePlan } from "./types.ts";
import type { TemplateFormat, TemplateLayout, TemplateLine, TemplateMeasure, TemplateRect } from "./compose.ts";

type LyricsContent = Extract<TemplateContent, { kind: "lyrics" }>;

/** One cut's colours: ground, lyric ink, the accent (emphasis, decor), secondary text (notes, labels, credit, signature), a quiet tint for big decor. */
export interface LyricPalette { readonly bg: string; readonly ink: string; readonly accent: string; readonly sub: string; readonly tint: string }
export type LyricEntrance = "rise" | "drop" | "slide" | "scale" | "rotate" | "type";
export type LyricArrangement = "center" | "left" | "stack" | "vertical";
export type LyricDecor = "bars" | "orb" | "frame" | "dots" | "rules" | "sun" | "none";

/** Slots for engine features that do not exist yet. Each is null in every
 * style today; when Pocket Motion gains the feature, setting the slot in a
 * style switches it on without touching the layout (the layout already
 * computes every box these would need). */
interface EngineSlots {
  /** TODO(engine: faces): a display face for lyric lines and a text face for notes, once a composition can load more than one font pair. */
  readonly faces: { readonly display: string; readonly text: string } | null;
  /** TODO(engine: stroke): outlined type, e.g. the emphasised word drawn as an outline over its fill. */
  readonly stroke: { readonly width: number; readonly color: string } | null;
  /** TODO(engine: gradient text): lyric ink as a two-stop gradient. */
  readonly gradientText: { readonly from: string; readonly to: string } | null;
  /** TODO(engine: blur): a motion blur on entrances and a soft blur on big decor. */
  readonly blur: { readonly entrance: number; readonly decor: number } | null;
}

/* Style tokens, drawn for the 1080 reference width and scaled with the
 * canvas (compose.ts scaledTo): lengths scale, `sizes` snap to the baked
 * sizes, `…Leading` ratios stay. Timing lives in LYRICS_MOTION (never scaled). */
export const LYRICS_STYLES = {
  /** Stage: night ground, bold display type, a colour per cut, wipes and punchy decor. */
  classic: {
    background: "#16141f", signature: "#b3adc4",
    /** The poster takes its colours from the motion palette (one entry, picked by the lyrics); `gradient` shades the ground toward the entry's tint. */
    poster: { gradient: true, orb: true, bold: true, align: "left" as "left" | "center", vertical: false,
      /** Stacked: every line takes its own size, the largest that fits the measure, so the block reads as one justified slab. */
      stacked: true, stackRatio: 1.9,
      sizes: [160, 144, 128, 112, 96, 80, 72, 64, 56, 52, 48, 44, 40], leading: 1.02, stanzaLeading: 0.45, margin: 88,
      title: { size: 44, gap: 16 }, credit: { size: 32, gap: 56 }, note: { size: 32, gap: 6 }, label: { size: 32, gap: 12 } },
    motion: {
      palette: [
        { bg: "#16141f", ink: "#f7f3ea", accent: "#ffd23f", sub: "#b3adc4", tint: "#262238" },
        { bg: "#b8281a", ink: "#fff8ee", accent: "#ffe866", sub: "#ffffff", tint: "#9a1f13" },
        { bg: "#2334b8", ink: "#f7f3ea", accent: "#ffd23f", sub: "#dfe2ff", tint: "#1b2a98" },
        { bg: "#ffd23f", ink: "#16141f", accent: "#b01f14", sub: "#3a3328", tint: "#ffe070" },
        { bg: "#085c4f", ink: "#f7f3ea", accent: "#ffe14d", sub: "#d6f0e9", tint: "#064a40" },
      ] as readonly LyricPalette[],
      sizes: [160, 144, 128, 112, 96, 80, 72, 64, 56, 48, 44, 40], leading: 1.06, margin: 96, bold: true, maxRows: 4,
      arrangements: ["center", "left", "stack"] as readonly LyricArrangement[],
      entrances: ["rise", "drop", "slide", "scale", "rotate", "type"] as readonly LyricEntrance[],
      decor: ["bars", "orb", "frame", "dots"] as readonly LyricDecor[],
      title: { size: 144, creditSize: 48, gap: 28 }, note: { size: 36, gap: 28 }, label: { size: 32 },
      underline: { thickness: 10, gap: 4 }, cursor: { thickness: 10 }, frame: { inset: 36, thickness: 8 },
    },
    engine: { faces: null, stroke: null, gradientText: null, blur: null } as EngineSlots,
  },
  /** Paper: warm paper tints, regular editorial type, crossfades, hairline decor; CJK verse set vertically. */
  editorial: {
    background: "#f4efe4", signature: "#6b645a",
    poster: { gradient: false, orb: false, bold: false, align: "center" as "left" | "center", vertical: true, stacked: false, stackRatio: 1,
      sizes: [96, 80, 72, 64, 56, 52, 48, 44, 40], leading: 1.5, stanzaLeading: 0.9, margin: 112,
      title: { size: 48, gap: 16 }, credit: { size: 32, gap: 64 }, note: { size: 32, gap: 4 }, label: { size: 32, gap: 16 } },
    motion: {
      palette: [
        { bg: "#f4efe4", ink: "#1f1c18", accent: "#b8321e", sub: "#6b645a", tint: "#e9e2d2" },
        { bg: "#e6ebee", ink: "#1b2226", accent: "#b0301d", sub: "#59636a", tint: "#d8dfe3" },
        { bg: "#f2e3db", ink: "#231a17", accent: "#a52c1c", sub: "#6a5750", tint: "#e8d3c8" },
        { bg: "#e3e8da", ink: "#1d2119", accent: "#a92f1d", sub: "#59624f", tint: "#d4dbc8" },
      ] as readonly LyricPalette[],
      sizes: [144, 128, 112, 96, 80, 72, 64, 56, 48, 44, 40], leading: 1.3, margin: 112, bold: false, maxRows: 4,
      arrangements: ["center", "left"] as readonly LyricArrangement[],
      entrances: ["rise", "slide", "scale", "rotate", "type"] as readonly LyricEntrance[],
      decor: ["rules", "sun", "frame", "none"] as readonly LyricDecor[],
      title: { size: 128, creditSize: 48, gap: 36 }, note: { size: 36, gap: 32 }, label: { size: 32 },
      underline: { thickness: 4, gap: 10 }, cursor: { thickness: 4 }, frame: { inset: 40, thickness: 3 },
    },
    engine: { faces: null, stroke: null, gradientText: null, blur: null } as EngineSlots,
  },
} as const;
export type LyricsStyle = (typeof LYRICS_STYLES)[keyof typeof LYRICS_STYLES];

/** Motion timing per style (ms, and lengths in em of the glyph size). Not scaled with the canvas. */
export const LYRICS_MOTION = {
  classic: { enterMs: 440, staggerMs: 60, maxStaggerMs: 760, typeMs: 55, exitMs: 260, transitionMs: 360, punchMs: 560, driftEm: 0.12, riseEm: 0.55, slideEm: 0.7, scaleFrom: 1.7, rotateFrom: -11, exitEm: 0.35, transition: "wipe" as "wipe" | "fade" },
  editorial: { enterMs: 680, staggerMs: 80, maxStaggerMs: 900, typeMs: 70, exitMs: 320, transitionMs: 460, punchMs: 640, driftEm: 0.06, riseEm: 0.3, slideEm: 0.4, scaleFrom: 1.3, rotateFrom: -5, exitEm: 0, transition: "fade" as "wipe" | "fade" },
} as const;

/** How long a cut stays: reading time per character, clamped per cut; the
 * whole video is capped by the longest animation other templates make (a
 * scroll: TEMPLATE_SCROLL start + max + end, 14.4 s), and for GIF also by the
 * frame-memory budget (render.ts TEMPLATE_GIF_FRAME_BUDGET at the narrowest
 * 360 px width). Too many cuts first share screens (two lines per cut); if
 * that is still too long the render stops with an explicit error. */
export const LYRICS_TIMING = {
  cjkMs: 350, latinMs: 180, minCutMs: 1100, maxCutMs: 3600, titleMs: 1800, introMs: 200, finalHoldMs: 1200,
  maxMs: 14_400, fps: 30, gifFrameBudget: 128 * 1024 * 1024, gifMinWidth: 360,
} as const;

/* ───────────── Randomness ───────────── */
function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** mulberry32: a small deterministic generator. */
function generator(seed: number): () => number {
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
const graphemes = (text: string): string[] => [...graphemeSegmenter.segment(text)].map((part) => part.segment);
const NO_LINE_START = /^[，。、；：？！）」』”’》〉】〕…—·,.;:?!)\]}%％‰~～]$/u;
const NO_LINE_END = /^[（「『“‘《〈【〔(\[{]$/u;
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HIRAGANA = /^[\p{Script=Hiragana}ー]$/u;
/** Chinese particles that stay with the word before them. */
const PARTICLE = /^[的地得了着过吗呢吧啊呀么嘛哦]$/u;
/** Glyphs that stand upright in a vertical column (no Latin, no brackets or ー that would have to turn). */
const VERTICAL_SAFE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々〆〇，。、！？・\s]$/u;
/** Punctuation set in the top-right corner of its cell in a vertical column. */
const CORNER = /^[，。、．]$/u;

interface Glyph { text: string; size: number; bold: boolean; color: string; emph: boolean }
interface Token { glyphs: Glyph[]; width: number; trail: number }
interface Row { tokens: Token[]; width: number; height: number; base: number }

class Typesetter {
  constructor(private readonly m: TemplateMeasure, private readonly leading: number) {}
  lh(size: number, bold: boolean, leading = this.leading): number { return Math.ceil(this.m.lineHeight(size, bold) * leading); }
  /** Where a glyph's baseline sits below the top of its line box (Noto's ascender). */
  base(size: number): number { return Math.round(size * 1.16); }
  width(glyphs: readonly Glyph[]): number {
    let width = 0, run = "", size = glyphs[0]?.size ?? 0, bold = glyphs[0]?.bold ?? false;
    for (const g of glyphs) {
      if (g.size !== size || g.bold !== bold) { width += this.m.width(run, size, bold); run = ""; size = g.size; bold = g.bold; }
      run += g.text;
    }
    return width + (run ? this.m.width(run, size, bold) : 0);
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
    return groups.map((group) => {
      let cut = group.length;
      while (cut > 0 && !group[cut - 1]!.text.trim()) cut--;
      const width = this.width(group);
      return { glyphs: group, width, trail: width - this.width(group.slice(0, cut)) };
    });
  }
  /** Greedy rows no wider than `max`; a CJK word too wide splits into its characters, a Latin one means it does not fit (undefined). */
  wrap(tokens: readonly Token[], max: number, split = true): Row[] | undefined {
    const rows: Token[][] = [[]];
    let width = 0;
    const queue = [...tokens];
    while (queue.length) {
      const token = queue.shift()!;
      if (token.width - token.trail > max + 0.01) {
        if (!split || !token.glyphs.every((g) => WIDE.test(g.text) || NO_LINE_START.test(g.text) || !g.text.trim())) return;
        if (token.glyphs.length === 1) return;
        queue.unshift(...token.glyphs.map((g) => { const w = this.width([g]); return { glyphs: [g], width: w, trail: g.text.trim() ? 0 : w }; }));
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
    return { tokens, width, height: Math.max(...glyphs.map((g) => this.lh(g.size, g.bold))), base: Math.max(...glyphs.map((g) => this.base(g.size))) };
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
      out.push({ text, x: cx, y: top + row.base - this.base(g.size), width, size: g.size, height: this.lh(g.size, g.bold), bold: g.bold, color: g.color, group: 0,
        boldAt: run.map(() => g.bold), ...extra, ...(g.emph ? { emphasis: true } : {}) });
      cx += width; run = [];
    };
    for (const g of glyphs) {
      const r = run[0];
      if (r && (r.size !== g.size || r.bold !== g.bold || r.color !== g.color || r.emph !== g.emph)) flush();
      run.push(g);
    }
    flush();
    return out;
  }
}

/** Glyphs of `text` (normalized as drawn), emphasised ranges at `emphSize` in `accent`. */
function glyphsOf(text: string, ranges: readonly (readonly [number, number])[] | undefined, size: number, emphSize: number, bold: boolean, ink: string, accent: string): Glyph[] {
  return graphemes(normalizeText(text, "plain")).map((g, i) => {
    const emph = Boolean(ranges?.some(([a, b]) => i >= a && i < b)) && g.trim() !== "";
    return { text: g, size: emph ? emphSize : size, bold, color: emph ? accent : ink, emph };
  });
}

/* ───────────── Context and result ───────────── */
export interface LyricsContext {
  readonly plan: TemplatePlan;
  readonly content: LyricsContent;
  readonly measure: TemplateMeasure;
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
  readonly variant: keyof typeof LYRICS_STYLES;
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
}
export interface LyricsCut {
  /** When the cut's ground starts coming in, when its text starts entering, when it is covered (the next cut's start; the duration for the last). */
  readonly inAt: number; readonly start: number; readonly hold: number; readonly end: number;
  readonly palette: LyricPalette;
  readonly entrance: LyricEntrance; readonly arrangement: LyricArrangement; readonly decor: LyricDecor;
  readonly transition: "wipe-l" | "wipe-r" | "wipe-u" | "wipe-d" | "fade" | "none";
  readonly bang: boolean;
  /** Lyric runs (entering glyph by glyph), in reading order. */
  readonly text: readonly number[];
  /** Notes, labels and the credit: fade in with the cut. */
  readonly quiet: readonly number[];
  /** The ground, then decor, then emphasis underlines. */
  readonly ground: number;
  readonly decorShapes: readonly number[];
  readonly underlines: readonly { readonly shape: number; readonly line: number }[];
  /** The lyric block's box (the centre scale and rotation turn about) and the box of everything the cut writes. */
  readonly box: Box; readonly outer: Box;
  /** The lyric's type size (entrance distances, drift and shake scale with it). */
  readonly glyphSize: number;
}
interface Box { x: number; y: number; width: number; height: number }

/* ───────────── Entry point ───────────── */
export function layoutLyrics(ctx: LyricsContext): LyricsResult {
  return ctx.plan.motion === "none" ? poster(ctx) : video(ctx);
}

/** Every character upright-safe for a vertical column. */
const verticalSafe = (text: string) => graphemes(text).every((g) => VERTICAL_SAFE.test(g));
const snapUp = (sizes: readonly number[], n: number) => sizes.find((s) => s >= n) ?? sizes.at(-1)!;

/* ───────────── Poster ───────────── */
function poster(ctx: LyricsContext): LyricsResult {
  const { content, style, width: W } = ctx;
  const s = style.poster;
  const margin = s.margin, inner = W - 2 * margin;
  const t = new Typesetter(ctx.measure, s.leading);
  const secondary = (n: number) => Math.max(ctx.minSecondary, n);
  const allLines = content.stanzas.flatMap((stanza) => stanza.lines);
  const boxH = ctx.fit - 2 * margin - ctx.footerRoom();
  // The poster's colours: one of the style's palette, picked by the lyrics (the same lyrics, the same poster).
  const pal = style.motion.palette[seedOf(`${ctx.plan.sourceText}\u0000poster`) % style.motion.palette.length]!;
  const result: LyricsResult = { background: pal.bg, margin, lines: [], shapes: [], backdrop: [], pinned: [], bottom: margin,
    signatureColor: pal.sub, signatureAlign: s.align === "center" ? "center" : "left" };
  if (s.gradient) {
    // TODO(engine: gradient text / blur): a soft glow behind the slab when the engine blurs.
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
  const sizes = s.sizes.filter((size) => size >= ctx.minBody);
  /** A lyric line at `size`: at most `maxRows` rows, balanced when it wraps. */
  const tokenCache = new Map<string, Token[]>(), rowCache = new Map<string, Row[] | undefined>();
  const rowsFor = (u: Unit, size: number, emph: number, width: number, maxRows: number): Row[] | undefined => {
    const key = `${units.indexOf(u)}|${size}|${emph}|${width}|${maxRows}`;
    if (rowCache.has(key)) return rowCache.get(key);
    const tokenKey = `${units.indexOf(u)}|${size}|${emph}`;
    const tokens = tokenCache.get(tokenKey) ?? t.tokens(glyphsOf(u.text, u.ranges, size, emph, s.bold, pal.ink, pal.accent));
    tokenCache.set(tokenKey, tokens);
    const result = balancedRows(tokens, width, maxRows);
    rowCache.set(key, result);
    return result;
  };
  const balancedRows = (tokens: Token[], width: number, maxRows: number): Row[] | undefined => {
    let rows = t.wrap(tokens, width);
    if (!rows || rows.length > maxRows) return;
    if (rows.length > 1) {
      let lo = Math.floor(width * 0.4), hi = width;
      while (hi - lo > 6) { const mid = Math.floor((lo + hi) / 2); const trial = t.wrap(tokens, mid, false); if (trial && trial.length <= rows.length) hi = mid; else lo = mid; }
      rows = t.wrap(tokens, hi, false) ?? rows;
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
    return t.wrap(t.tokens(glyphsOf(u.text, undefined, size, size, u.kind === "title", u.kind === "title" ? pal.accent : pal.sub, pal.accent)), inner);
  };
  type Set = { rows: Row[][]; gaps: number[]; height: number; widest: number };
  /** Everything set with `line(u)` giving a lyric unit's rows; undefined when a unit does not fit. */
  const setAll = (line: (u: Unit) => Row[] | undefined, base: number): Set | undefined => {
    const rows: Row[][] = [];
    for (const u of units) { const r = u.kind === "line" ? line(u) : quiet(u); if (!r) return; rows.push(r); }
    const lh = t.lh(base, s.bold);
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
      result.lines.push(...t.emit(row, x, y, { group: group++, ...(u.kind === "line" || u.kind === "title" ? {} : { secondary: true }) }));
      y += row.height;
    }
  }
  result.bottom = y;
  // Stage: a quiet disc in the emptiest corner, when the poster keeps its frame.
  if (s.orb && y + margin <= ctx.height) {
    const text = unionBox(result.lines.map((l) => ({ x: l.x, y: l.y, width: l.width, height: l.height })));
    const index = result.shapes.length;
    decorate("orb", W, ctx.height, margin, text, pal, style.motion, result.shapes);
    for (const shape of result.shapes.slice(index)) result.pinned.push(shape);
  }
  return result;
}

/** CJK verse in columns, right to left: the title and author first, a wider gap between stanzas. Undefined when the columns do not fit the frame at a readable size. */
function verticalPoster(ctx: LyricsContext, result: LyricsResult, margin: number, boxH: number, pal: LyricPalette): LyricsResult | undefined {
  const { content, style, width: W } = ctx;
  const s = style.poster;
  const inner = W - 2 * margin;
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
    if (content.title) for (const g of split(content.title)) columns.push({ glyphs: g, size: titleSize, bold: true, color: pal.accent, secondary: false, emph: [], gapBefore: 0, offset: 0 });
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
          columns.push({ glyphs: g, size, bold: s.bold, color: pal.ink, secondary: false, emph: ranges, gapBefore: j === 0 && at === 0 && (i > 0 || columns.length) ? Math.round(advance * (i > 0 ? 0.9 : 0.6)) : 0, offset: 0 });
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
        const w = ctx.measure.width(glyph, column.size, column.bold);
        const y = top + column.offset + k * p;
        const line: TemplateLine = { text: glyph, x: cx - w / 2, y, width: w, size: column.size, height: p, bold: column.bold, color: emph ? pal.accent : column.color, group: group++, boldAt: [column.bold],
          ...(column.secondary ? { secondary: true } : {}) };
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
function cornerPunctuation(line: TemplateLine, cx: number, cellTop: number, size: number): void {
  const drawX = cx - line.width / 2 + size * 0.52, drawY = cellTop - size * 0.72;
  line.x = cx; line.y = cellTop; line.width = size / 2; line.height = Math.round(size * 0.5);
  line.offset = { x: drawX - line.x, y: drawY - line.y };
}

/* ───────────── Video ───────────── */
interface CutSpec {
  kind: "title" | "line";
  segments: { text: string; emphasis: (readonly [number, number])[] }[];
  notes: string[]; label?: string; credit?: string;
  bang: boolean; readMs: number; timedMs?: number; stanza: number;
}

/** Reading time: per CJK character and per other visible character. */
const readingMs = (text: string) => graphemes(text).reduce((ms, g) => ms + (!g.trim() ? 0 : WIDE.test(g) ? LYRICS_TIMING.cjkMs : LYRICS_TIMING.latinMs), 0);

function cutSpecs(content: LyricsContent): CutSpec[] {
  const cuts: CutSpec[] = [];
  if (content.title || content.credit) cuts.push({ kind: "title", segments: content.title ? [{ text: content.title, emphasis: [] }] : [], notes: [], ...(content.credit ? { credit: content.credit } : {}),
    bang: false, readMs: LYRICS_TIMING.titleMs, stanza: -1 });
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
          bang: /[!！]$/.test(text), readMs: readingMs(text), ...(share !== undefined ? { timedMs: share } : {}), stanza: s });
      }
    }
  }
  return cuts;
}

/** Two consecutive line cuts of one stanza on one screen. */
function pairCuts(cuts: readonly CutSpec[]): CutSpec[] {
  const out: CutSpec[] = [];
  for (let i = 0; i < cuts.length; i++) {
    const a = cuts[i]!, b = cuts[i + 1];
    if (a.kind === "line" && b?.kind === "line" && b.stanza === a.stanza && !b.label) {
      out.push({ ...a, segments: [...a.segments, ...b.segments], notes: [...a.notes, ...b.notes], bang: b.bang, readMs: a.readMs + b.readMs,
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
  return Math.min(T.maxMs, Math.floor(((sampled * 2 - 2) / T.fps) * 1000));
}

/** Per-cut durations fitted into `available` ms: shrink proportionally, never below the minimum. */
function fitDurations(wanted: readonly number[], fixed: readonly boolean[], available: number): number[] | undefined {
  const T = LYRICS_TIMING;
  let durations = [...wanted];
  for (let pass = 0; pass < 6; pass++) {
    const total = durations.reduce((a, b) => a + b, 0);
    if (total <= available) return durations.map(Math.floor);
    const flexible = durations.reduce((n, d, i) => n + (fixed[i] || d <= T.minCutMs ? 0 : d - T.minCutMs), 0);
    const over = total - available;
    if (flexible <= 0) return;
    durations = durations.map((d, i) => (fixed[i] || d <= T.minCutMs ? d : Math.max(T.minCutMs, d - (d - T.minCutMs) * Math.min(1, over / flexible))));
  }
  return durations.reduce((a, b) => a + b, 0) <= available + 1 ? durations.map(Math.floor) : undefined;
}

function video(ctx: LyricsContext): LyricsResult {
  const { content, style, width: W, variant } = ctx;
  const H = ctx.plan.aspect === "auto" ? ctx.fit : ctx.height;
  const M = style.motion, timing = LYRICS_MOTION[variant], T = LYRICS_TIMING;
  const random = generator(seedOf(`${ctx.plan.sourceText}\u0000${variant}`));
  const cap = lyricsMaxMs(W, H, ctx.format);
  // Durations: LRC timing when given, else reading time; clamped per cut, then fitted.
  const plan = (specs: CutSpec[]) => {
    const wanted = specs.map((c) => c.kind === "title" ? T.titleMs : Math.min(T.maxCutMs, Math.max(T.minCutMs, c.timedMs ?? c.readMs)));
    const last = wanted.length - 1;
    const tail = Math.max(0, T.finalHoldMs + 600 - wanted[last]!);
    const available = cap - T.introMs - last * timing.transitionMs - tail;
    const durations = fitDurations(wanted, specs.map((c) => c.kind === "title"), available);
    return durations && { durations, tail };
  };
  let specs = cutSpecs(content);
  let fitted = plan(specs);
  if (!fitted) { specs = pairCuts(specs); fitted = plan(specs); }
  if (!fitted) {
    const screens = specs.length, most = Math.floor((cap - T.introMs - T.finalHoldMs) / (T.minCutMs + timing.transitionMs));
    throw new ComposeError("overflow", `These lyrics need ${screens} screens even two lines at a time; a ${(cap / 1000).toFixed(1)} s lyric ${ctx.format === "gif" ? "GIF" : "video"} holds about ${most}. Use PNG for a poster of all of it, or copy fewer lines. No content was dropped.`);
  }
  const { durations, tail } = fitted;
  const margin = M.margin;
  const t = new Typesetter(ctx.measure, M.leading);
  const result: LyricsResult = { background: M.palette[0]!.bg, margin, lines: [], shapes: [], backdrop: [], pinned: [], bottom: H - margin,
    signatureColor: M.palette[0]!.sub, signatureAlign: "left" };
  const cuts: LyricsCut[] = [];
  let at: number = T.introMs;
  let previous: { entrance?: LyricEntrance; arrangement?: LyricArrangement; decor?: LyricDecor; transition?: LyricsCut["transition"]; palette?: number } = {};
  const secondary = (n: number) => Math.max(ctx.minSecondary, n);
  for (const [i, spec] of specs.entries()) {
    const duration = durations[i]!;
    // The first cut takes the style's own ground; later cuts move round the palette, never the same colour twice running.
    const index = i === 0 ? 0 : (() => { const k = Math.floor(random() * (M.palette.length - 1)); return k >= previous.palette! ? k + 1 : k; })();
    const palette = M.palette[index]!;
    const vertical = style.poster.vertical && spec.segments.every((seg) => verticalSafe(seg.text)) && !spec.notes.length && !spec.label && !spec.credit;
    const arrangement: LyricArrangement = spec.kind === "title" ? "center" : vertical && (content.poem || random() < 0.5) ? "vertical" : pick(random, M.arrangements, previous.arrangement);
    const entrance: LyricEntrance = ctx.plan.motion === "typewriter" ? "type" : spec.kind === "title" ? "rise" : pick(random, M.entrances, previous.entrance);
    const decor = pick(random, M.decor, previous.decor);
    const transition: LyricsCut["transition"] = i === 0 ? "none" : timing.transition === "fade" ? "fade" : pick(random, ["wipe-l", "wipe-r", "wipe-u", "wipe-d"] as const, previous.transition as never);
    previous = { entrance, arrangement, decor, transition, palette: index };
    const firstLine = result.lines.length, firstShape = result.shapes.length;
    // Ground.
    const ground = result.shapes.length;
    result.shapes.push({ x: 0, y: 0, width: W, height: H, color: palette.bg, radius: 0 });
    // Room for the label on top and the notes and credit underneath.
    const quietSize = secondary(M.note.size);
    const labelRoom = spec.label ? t.lh(secondary(M.label.size), false, 1.2) + Math.round(M.note.gap / 2) : 0;
    const noteRows = (text: string) => t.wrap(t.tokens(glyphsOf(text, undefined, quietSize, quietSize, false, palette.sub, palette.accent)), W - 2 * margin) ?? [];
    const notes = spec.notes.map(noteRows);
    const creditSize = secondary(M.title.creditSize);
    const credit = spec.credit ? t.wrap(t.tokens(glyphsOf(spec.credit, undefined, creditSize, creditSize, false, palette.sub, palette.accent)), W - 2 * margin) ?? [] : [];
    const quietH = [...notes.flat(), ...credit].reduce((h, r) => h + r.height, 0) + (notes.length || credit.length ? M.note.gap : 0);
    const box = { x: margin, y: margin + labelRoom, width: W - 2 * margin, height: H - 2 * margin - ctx.footerRoom() - labelRoom - quietH };
    const block = arrangement === "vertical"
      ? verticalCut(ctx, spec, palette, box, M) ?? horizontalCut(ctx, t, spec, palette, box, "center", M)
      : horizontalCut(ctx, t, spec, palette, box, arrangement, M);
    if (!block) throw new ComposeError("overflow", "A lyric line is too long for one screen of this frame even at the smallest size. Use PNG, a wider frame, or break the line with `/`. No content was dropped.");
    const textStart = result.lines.length;
    result.lines.push(...block.lines);
    const textIndices = block.lines.map((_, k) => textStart + k);
    // Notes and the credit under the block, the label above it.
    const quiet: number[] = [];
    let qy = block.box.y + block.box.height + (quietH ? M.note.gap : 0);
    for (const row of [...credit, ...notes.flat()]) {
      const x = block.align === "center" ? Math.round((W - row.width) / 2) : block.box.x;
      for (const line of t.emit(row, x, qy, { secondary: true })) { quiet.push(result.lines.length); result.lines.push(line); }
      qy += row.height;
    }
    if (spec.label) {
      const rows = t.wrap(t.tokens(glyphsOf(spec.label, undefined, secondary(M.label.size), secondary(M.label.size), false, palette.sub, palette.accent)), W - 2 * margin) ?? [];
      let ly = margin;
      for (const row of rows) { for (const line of t.emit(row, margin, ly, { secondary: true })) { quiet.push(result.lines.length); result.lines.push(line); } ly += row.height; }
    }
    // Underlines under emphasised runs (horizontal cuts only).
    const underlines: { shape: number; line: number }[] = [];
    if (arrangement !== "vertical") for (const index of textIndices) {
      const line = result.lines[index]!;
      if (!line.emphasis) continue;
      const u = M.underline;
      underlines.push({ shape: result.shapes.length, line: index });
      result.shapes.push({ x: line.x, y: line.y + t.base(line.size) + u.gap, width: line.width, height: u.thickness, color: palette.accent, radius: u.thickness / 2 });
    }
    const outer = unionBox([block.box, ...result.lines.slice(firstLine).map((l) => ({ x: l.x, y: l.y, width: l.width, height: l.height }))]);
    const decorShapes = decorate(decor, W, H, margin, outer, palette, M, result.shapes);
    // Timing: the cut's ground comes in during the transition before `start`.
    const start = at;
    const inAt = i === 0 ? 0 : start - timing.transitionMs;
    const end = i === specs.length - 1 ? start + duration + tail : start + duration + timing.transitionMs;
    cuts.push({ inAt, start, hold: duration, end, palette, entrance, arrangement, decor, transition, bang: spec.bang,
      text: textIndices, quiet, ground, decorShapes, underlines, box: block.box, outer, glyphSize: block.size });
    at = end;
    for (let k = firstShape; k < result.shapes.length; k++) result.pinned.push(result.shapes[k]!);
  }
  result.program = { durationMs: at, frameHeight: H, cuts };
  result.bottom = H - margin;
  return result;
}

const unionBox = (boxes: readonly Box[]): Box => {
  const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width)), y1 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
};

type MotionStyle = LyricsStyle["motion"];
interface Block { lines: TemplateLine[]; box: Box; size: number; align: "left" | "center" }

/** A cut's lyric set in rows: the largest size that fits the box in at most maxRows rows, then arranged. */
function horizontalCut(ctx: LyricsContext, t: Typesetter, spec: CutSpec, palette: LyricPalette, box: Box, arrangement: LyricArrangement, M: MotionStyle, strict = true, only?: number): Block | undefined {
  const bold = spec.kind === "title" || M.bold;
  const sizes = (spec.kind === "title" ? M.sizes.filter((n) => n <= M.title.size) : M.sizes).filter((n) => n >= ctx.minBody && (only === undefined || n === only));
  const stack = arrangement === "stack";
  for (const size of sizes) {
    const emph = snapUp(ctx.sizes, size * 1.2);
    const segments = spec.segments.map((seg) => t.tokens(glyphsOf(seg.text, seg.emphasis, size, emph, bold, palette.ink, palette.accent)));
    const wrapAll = (width: number, split = true): Row[] | undefined => {
      const rows: Row[] = [];
      for (const tokens of segments) { const r = t.wrap(tokens, width, split); if (!r) return; rows.push(...r); }
      return rows;
    };
    // Stack breaks the line into short rows of a word or two, stepping across the screen.
    let rows = wrapAll(stack ? Math.min(box.width, Math.max(box.width * 0.6, ...segments.flat().map((tk) => tk.width - tk.trail))) : box.width);
    if (!rows || rows.length > M.maxRows) continue;
    const height = rows.reduce((h, r) => h + r.height, 0);
    if (height > box.height) continue;
    if (stack && rows.length < 2) return horizontalCut(ctx, t, spec, palette, box, "center", M, strict);
    // Balance: the narrowest measure that keeps the row count, so no row is left nearly empty.
    if (rows.length > segments.length) {
      let lo = Math.floor(box.width * 0.3), hi = Math.ceil(Math.max(...rows.map((r) => r.width)));
      while (hi - lo > 6) { const mid = Math.floor((lo + hi) / 2); const trial = wrapAll(mid, false); if (trial && trial.length <= rows.length) hi = mid; else lo = mid; }
      const balanced = wrapAll(hi, false);
      if (balanced && balanced.length === rows.length) rows = balanced;
    }
    // A row holding a scrap of the line (a lone "I", one character) reads as a mistake: a smaller size instead.
    const widest = Math.max(...rows.map((r) => r.width));
    if (strict && rows.length > 1 && rows.some((r) => r.width < widest * 0.3)) {
      // A stack that leaves a scrap is set centred at this size instead.
      if (stack) { const centred = horizontalCut(ctx, t, spec, palette, box, "center", M, true, size); if (centred?.size === size) return centred; }
      continue;
    }
    const lines: TemplateLine[] = [];
    // Centre: the block in the middle. Left: left edge, low in the frame. Stack: rows alternate left and right.
    const top = arrangement === "left" ? box.y + Math.round((box.height - height) * 0.72) : box.y + Math.round((box.height - height) / 2);
    let y = top;
    for (const [k, row] of rows.entries()) {
      const x = arrangement === "center" ? box.x + Math.round((box.width - row.width) / 2)
        : arrangement === "stack" ? Math.max(box.x, Math.min(box.x + box.width - row.width, k % 2 ? box.x + box.width - row.width - Math.round(box.width * 0.04 * (rows.length - k)) : box.x + Math.round(box.width * 0.04 * k)))
          : box.x;
      lines.push(...t.emit(row, x, y));
      y += row.height;
    }
    const x0 = Math.min(...lines.map((l) => l.x)), x1 = Math.max(...lines.map((l) => l.x + l.width));
    return { lines, box: { x: x0, y: top, width: Math.max(x1 - x0, arrangement === "center" ? widest : 0), height }, size, align: arrangement === "center" ? "center" : "left" };
  }
  // Nothing without a scrap row: allow one rather than fail.
  return strict && only === undefined ? horizontalCut(ctx, t, spec, palette, box, arrangement === "stack" ? "center" : arrangement, M, false) : undefined;
}

/** A cut's lyric in columns, right to left, centred; a phrase mark ends a column when one falls late enough. */
function verticalCut(ctx: LyricsContext, spec: CutSpec, palette: LyricPalette, box: Box, M: MotionStyle): Block | undefined {
  const glyphs = spec.segments.map((seg) => graphemes(normalizeText(seg.text, "plain")));
  const ranges = spec.segments.map((seg) => seg.emphasis);
  // A line of phrases gets a column per phrase (its mark stays with it); longer phrases wrap.
  const phrases = glyphs.map((g) => {
    const out: { glyphs: string[]; from: number }[] = [];
    let from = 0;
    for (let i = 0; i < g.length; i++) if (/[，。、！？]/u.test(g[i]!) && !/[，。、！？]/u.test(g[i + 1] ?? "")) { out.push({ glyphs: g.slice(from, i + 1), from }); from = i + 1; }
    if (from < g.length) out.push({ glyphs: g.slice(from), from });
    return out;
  });
  // Cells a phrase needs: a closing mark at its end hangs in the corner of half a cell.
  const cells = (g: readonly string[]) => g.length - (CORNER.test(g.at(-1) ?? "") ? 0.5 : 0);
  const longest = Math.max(...phrases.flat().map((p) => cells(p.glyphs)));
  const sizes = M.sizes.filter((n) => n >= ctx.minBody);
  // Prefer a size at which every phrase stands in one column.
  const whole = sizes.find((n) => longest * Math.round(n * 1.12) <= box.height);
  for (const size of whole !== undefined ? [whole, ...sizes.filter((n) => n < whole)] : sizes) {
    const pitch = Math.round(size * 1.12), advance = Math.round(size * 1.6);
    const per = Math.floor(box.height / pitch);
    if (per < 2) continue;
    const columns: { glyphs: string[]; from: number; seg: number }[] = [];
    for (const [s, list] of phrases.entries()) for (const phrase of list) {
      let rest = phrase.glyphs, from = phrase.from;
      if (cells(rest) * pitch <= box.height) { columns.push({ glyphs: rest, from, seg: s }); continue; }
      while (rest.length > per) {
        let cut = per;
        // Never start a column with a closing mark.
        while (cut > 1 && NO_LINE_START.test(rest[cut]!)) cut--;
        columns.push({ glyphs: rest.slice(0, cut), from, seg: s }); rest = rest.slice(cut); from += cut;
      }
      if (rest.length) columns.push({ glyphs: rest, from, seg: s });
    }
    const width = columns.length * advance - (advance - size);
    if (width > box.width || columns.length > 4) continue;
    const tallest = Math.ceil(Math.max(...columns.map((c) => cells(c.glyphs))) * pitch);
    const top = box.y + Math.round((box.height - tallest) / 2);
    let x = box.x + Math.round((box.width + width) / 2);
    const lines: TemplateLine[] = [];
    for (const column of columns) {
      const cx = x - size / 2;
      for (const [k, glyph] of column.glyphs.entries()) {
        if (!glyph.trim()) continue;
        const i = column.from + k, emph = ranges[column.seg]!.some(([a, b]) => i >= a && i < b);
        const w = ctx.measure.width(glyph, size, M.bold);
        const line: TemplateLine = { text: glyph, x: cx - w / 2, y: top + k * pitch, width: w, size, height: pitch, bold: M.bold, color: emph ? palette.accent : palette.ink, group: 0, boldAt: [M.bold],
          ...(emph ? { emphasis: true } : {}) };
        if (CORNER.test(glyph)) cornerPunctuation(line, cx, top + k * pitch, size);
        lines.push(line);
      }
      x -= advance;
    }
    return { lines, box: { x: box.x + Math.round((box.width - width) / 2), y: top, width, height: tallest }, size, align: "center" };
  }
  return;
}

/** Decor shapes for one cut, kept clear of everything the cut writes. Returns their indices. */
function decorate(kind: LyricDecor, W: number, H: number, margin: number, text: Box, palette: LyricPalette, M: MotionStyle, shapes: TemplateRect[]): number[] {
  const out: number[] = [];
  const add = (rect: TemplateRect) => { out.push(shapes.length); shapes.push(rect); };
  const pad = Math.round(margin * 0.3);
  const clear = (r: { x: number; y: number; width: number; height: number }) =>
    r.x + r.width + pad <= text.x || r.x >= text.x + text.width + pad || r.y + r.height + pad <= text.y || r.y >= text.y + text.height + pad;
  const u = W / 1080;
  switch (kind) {
    case "bars": {
      // Three bars in the emptier band above or below the text.
      const above = text.y - margin * 0.4, below = H - (text.y + text.height) - margin * 0.9;
      const h = Math.round(18 * u), gap = Math.round(14 * u);
      const band = 3 * h + 2 * gap;
      const useTop = above >= below;
      if (Math.max(above, below) < band + pad) return out;
      const y0 = useTop ? Math.round(margin * 0.45) : Math.round(H - margin * 0.9 - band);
      const widths = [0.42, 0.26, 0.34];
      widths.forEach((f, k) => { const r = { x: k % 2 ? Math.round(W - margin * 0.5 - W * f) : Math.round(margin * 0.5), y: y0 + k * (h + gap), width: Math.round(W * f), height: h, color: palette.accent, radius: h / 2 }; if (clear(r)) add(r); });
      return out;
    }
    case "orb": {
      // A big quiet disc in the corner farthest from the text, as large as the clearance allows.
      const cx = text.x + text.width / 2 < W / 2 ? W : 0, cy = text.y + text.height / 2 < H / 2 ? H : 0;
      for (let r = Math.round(Math.min(W, H) * 0.42); r >= Math.round(Math.min(W, H) * 0.12); r -= Math.round(20 * u)) {
        const rect = { x: cx - r, y: cy - r, width: 2 * r, height: 2 * r, color: palette.tint, radius: r };
        if (clear(rect)) { add(rect); return out; }
      }
      return out;
    }
    case "frame": {
      const f = M.frame, i = f.inset, k = f.thickness;
      for (const r of [{ x: i, y: i, width: W - 2 * i, height: k }, { x: i, y: H - i - k, width: W - 2 * i, height: k }, { x: i, y: i, width: k, height: H - 2 * i }, { x: W - i - k, y: i, width: k, height: H - 2 * i }]) {
        add({ ...r, color: M.bold ? palette.accent : palette.ink, radius: 0 });
      }
      return out;
    }
    case "dots": {
      const r = Math.round(13 * u), gap = Math.round(22 * u), n = 5;
      const top = text.y > H / 2;
      const y = top ? Math.round(margin * 0.55) : Math.round(H - margin * 0.55 - 2 * r);
      const x0 = text.x + text.width / 2 > W / 2 ? Math.round(margin * 0.55) : Math.round(W - margin * 0.55 - n * 2 * r - (n - 1) * gap);
      for (let k = 0; k < n; k++) { const d = { x: x0 + k * (2 * r + gap), y, width: 2 * r, height: 2 * r, color: palette.accent, radius: r }; if (clear(d)) add(d); }
      return out;
    }
    case "rules": {
      // Hairlines above and below the text block, as wide as it is (plus a little).
      const k = Math.max(2, Math.round(3 * u)), gap = Math.round(36 * u), extra = Math.round(40 * u);
      const x = Math.max(margin * 0.5, text.x - extra), w = Math.min(W - margin, text.width + 2 * extra);
      for (const y of [text.y - gap - k, text.y + text.height + gap]) if (y > margin * 0.3 && y + k < H - margin * 0.3) add({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: k, color: palette.ink, radius: 0 });
      return out;
    }
    case "sun": {
      const r = Math.round(46 * u);
      const x = text.x + text.width / 2 > W / 2 ? Math.round(margin * 0.9) : Math.round(W - margin * 0.9 - 2 * r);
      const y = text.y > H / 2 ? Math.round(margin * 0.8) : Math.round(H - margin * 1.2 - 2 * r);
      const disc = { x, y, width: 2 * r, height: 2 * r, color: palette.accent, radius: r };
      if (clear(disc)) add(disc);
      return out;
    }
    case "none": return out;
  }
}

/* ───────────── Checks ───────────── */
/** The quality gate for a lyric video: source fidelity over the whole
 * layout, and every other check per cut, against that cut's own ground (the
 * cuts share the canvas but are never on screen together). */
export function lyricsViolations(layout: TemplateLayout, program: LyricsProgram, plan: Pick<TemplatePlan, "content">): CheckViolation[] {
  const out = fidelityViolations(layout, plan);
  const signature = layout.lines.filter((l) => l.signature);
  for (const [i, cut] of program.cuts.entries()) {
    const lines = [...cut.text, ...cut.quiet].map((k) => layout.lines[k]!);
    const shapes = [cut.ground, ...cut.decorShapes, ...cut.underlines.map((u) => u.shape)].map((k) => layout.shapes[k]!);
    const sub = { width: layout.width, height: program.frameHeight, background: cut.palette.bg, lines: [...lines, ...signature.map((l) => ({ ...l, color: cut.palette.sub }))], shapes };
    for (const v of checkLayout(sub)) out.push({ kind: v.kind, message: `cut ${i}: ${v.message}` });
  }
  return out;
}

/* ───────────── Composition ───────────── */
export interface LyricsComposition {
  readonly body: string;
  readonly keyframes: Record<string, unknown>;
  readonly animations: Record<string, { value: string }>;
  readonly frames: number;
  readonly emojiKeys: Set<string>;
}
const px = (n: number) => `${Math.round(n * 100) / 100}px`;
const ms = (n: number) => `${Math.max(0, Math.round(n))}ms`;
const hex = (color: string) => color.replace(/^#/, "");

/** The lyric video as Pocket Motion nodes and baked animations. */
export function lyricsComposition(layout: TemplateLayout, program: LyricsProgram, measure: TemplateMeasure, variant: keyof typeof LYRICS_STYLES): LyricsComposition {
  const timing = LYRICS_MOTION[variant];
  const W = layout.width, H = program.frameHeight;
  const keyframes: Record<string, unknown> = {}, animations: Record<string, { value: string }> = {};
  const emojiKeys = new Set<string>();
  let animationCount = 0;
  const animate = (value: string) => { const name = `l${animationCount++}`; animations[name] = { value }; return ` animate-${name}`; };
  const key = (name: string, frames: Record<string, Record<string, string>>) => { keyframes[name] ??= frames; return name; };
  const cubic = { out: "cubic-bezier(0.16,1,0.3,1)", back: "cubic-bezier(0.34,1.56,0.64,1)", inOut: "cubic-bezier(0.65,0,0.35,1)", in: "cubic-bezier(0.5,0,0.75,0)" };
  const view = (box: Box, extra: string, children: string[]) => `<View class="absolute left-[${px(box.x)}] top-[${px(box.y)}] w-[${px(box.width)}] h-[${px(box.height)}]${extra}">\n${children.join("\n")}\n</View>`;
  const rectNode = (r: TemplateRect, dx: number, dy: number, extra = "") => `<View class="absolute left-[${px(r.x - dx)}] top-[${px(r.y - dy)}] w-[${px(r.width)}] h-[${px(r.height)}] bg-[${r.color}] rounded-[${px(r.radius)}]${extra}" />`;
  const glyphNode = (text: string, x: number, y: number, line: TemplateLine, color: string, anim: string) => {
    const emoji = splitEmoji(text).find((run) => "emoji" in run);
    if (emoji && "emoji" in emoji) {
      emojiKeys.add(emoji.key);
      return `<Image class="absolute left-[${px(x)}] top-[${px(y + (line.height - line.size) / 2)}] w-[${line.size}px] h-[${line.size}px]${anim}" src="e_${emoji.key}.png" />`;
    }
    return `<Text class="absolute left-[${px(x)}] top-[${px(y)}] text-[${line.size}px] ${line.bold ? "font-bold" : ""} text-[${color}] h-[${px(line.height)}]${anim}">{${JSON.stringify(text)}}</Text>`;
  };
  const signature = layout.lines.filter((l) => l.signature);
  const nodes: string[] = [];
  for (const [i, cut] of program.cuts.entries()) {
    const last = i === program.cuts.length - 1;
    const p = cut.palette, S = cut.start;
    const inner: string[] = [];
    // Ground: wiped or faded in during the transition.
    const ground = layout.shapes[cut.ground]!;
    const groundAnim = cut.transition === "none" ? "" : cut.transition === "fade"
      ? animate(`${key("lfadein", { from: { opacity: "0" }, to: { opacity: "1" } })} ${ms(timing.transitionMs)} ease-in-out ${ms(cut.inAt)} both`)
      : animate(`${key(`lwipe${cut.transition.slice(5)}`, { from: cut.transition === "wipe-l" ? { translateX: px(-W) } : cut.transition === "wipe-r" ? { translateX: px(W) } : cut.transition === "wipe-u" ? { translateY: px(H) } : { translateY: px(-H) },
        to: cut.transition === "wipe-l" || cut.transition === "wipe-r" ? { translateX: "0px" } : { translateY: "0px" } })} ${ms(timing.transitionMs)} ${cubic.inOut} ${ms(cut.inAt)} both`);
    inner.push(rectNode(ground, 0, 0, groundAnim));
    // Decor: comes in with the text, then keeps moving slowly through the hold.
    const holdEnd = last ? program.durationMs : cut.end;
    for (const [k, index] of cut.decorShapes.entries()) {
      const r = layout.shapes[index]!;
      const delay = S + 80 + k * 70, life = Math.max(400, holdEnd - delay);
      let anim: string;
      switch (cut.decor) {
        case "bars": {
          const from = r.x < W / 2 ? -r.width - r.x : W - r.x;
          anim = animate(`${key(`lbar${Math.round(from)}`, { from: { translateX: px(from) }, "30%": { translateX: px(0) }, to: { translateX: px(r.x < W / 2 ? 24 : -24) } })} ${ms(Math.min(life, 2600))} ${cubic.out} ${ms(delay)} both`);
          break;
        }
        case "orb": anim = animate(`${key("lorb", { from: { scale: "0" }, "35%": { scale: "1.04" }, "50%": { scale: "1" }, to: { scale: "1.08" } })} ${ms(life)} ${cubic.out} ${ms(S)} both`); break;
        case "frame": {
          const horizontal = r.width > r.height;
          anim = animate(`${key(horizontal ? "lframeh" : "lframev", horizontal ? { from: { scaleX: "0" }, to: { scaleX: "1" } } : { from: { scaleY: "0" }, to: { scaleY: "1" } })} ${ms(520)} ${cubic.out} ${ms(S + k * 90)} both`);
          break;
        }
        case "dots": anim = animate(`${key(`ldot${Math.round(r.height)}`, { from: { scale: "0", translateY: "0px" }, "25%": { scale: "1.3", translateY: px(-r.height * 0.6) }, "40%": { scale: "1", translateY: "0px" }, to: { scale: "1", translateY: px(r.height * 0.5) } })} ${ms(Math.min(life, 3000))} ${cubic.out} ${ms(S + k * 90)} both`); break;
        case "rules": anim = animate(`${key("lrule", { from: { scaleX: "0" }, to: { scaleX: "1" } })} ${ms(700)} ${cubic.out} ${ms(S + k * 120)} both`); break;
        case "sun": anim = animate(`${key(`lsun${Math.round(r.height)}`, { from: { opacity: "0", translateY: px(r.height * 0.9) }, "40%": { opacity: "1", translateY: "0px" }, to: { opacity: "1", translateY: px(-r.height * 0.25) } })} ${ms(Math.min(life, 4000))} ${cubic.out} ${ms(S)} both`); break;
        default: anim = "";
      }
      inner.push(rectNode(r, 0, 0, anim));
    }
    // The text: an exit wrapper around everything the cut writes, a motion wrapper around the lyric block.
    const outer = cut.outer, box = cut.box;
    const n = cut.text.reduce((count, k) => count + graphemes(layout.lines[k]!.text).filter((g) => g.trim()).length, 0);
    const entrance = cut.entrance;
    const typing = entrance === "type";
    const window = typing ? 0 : Math.min(timing.maxStaggerMs, cut.hold * 0.4, timing.staggerMs * Math.max(0, n - 1));
    const enterMs = Math.max(220, Math.min(timing.enterMs, cut.hold * 0.7 - window));
    const typeStep = Math.min(timing.typeMs, (cut.hold * 0.6) / Math.max(1, n));
    const revealEnd = S + (typing ? typeStep * n : window + enterMs);
    const motionAnims: string[] = [];
    if (entrance === "scale") motionAnims.push(`${key(`lgather${Math.round(timing.scaleFrom * 100)}`, { from: { scale: String(timing.scaleFrom) }, to: { scale: "1" } })} ${ms(Math.min(900, cut.hold * 0.6))} ${cubic.out} ${ms(S)} both`);
    if (entrance === "rotate") motionAnims.push(`${key(`lswing${-timing.rotateFrom}`, { from: { rotate: `${timing.rotateFrom}deg` }, to: { rotate: "0deg" } })} ${ms(Math.min(1000, cut.hold * 0.65))} ${cubic.back} ${ms(S)} both`);
    const drift = Math.round(cut.glyphSize * timing.driftEm);
    if (drift) motionAnims.push(`${key(`ldrift${drift}`, { from: { translateY: "0px" }, to: { translateY: px(-drift) } })} ${ms(Math.max(300, (last ? program.durationMs : cut.end) - S))} ease-in-out ${ms(S)} both`);
    if (cut.bang) motionAnims.push(`${key(`lshake${Math.round(cut.glyphSize / 8)}`, (() => { const a = Math.max(6, Math.round(cut.glyphSize / 8)); return { "0%": { translateX: "0px" }, "12%": { translateX: px(-a) }, "28%": { translateX: px(a) }, "44%": { translateX: px(-a * 0.7) }, "60%": { translateX: px(a * 0.5) }, "78%": { translateX: px(-a * 0.25) }, "100%": { translateX: "0px" } }; })())} 420ms linear ${ms(revealEnd - 40)} both`);
    const textNodes: string[] = [];
    // Emphasis: an underline grows under the word, and the word pops in the accent.
    const punchAt = revealEnd + 60;
    for (const u of cut.underlines) {
      const r = layout.shapes[u.shape]!;
      textNodes.push(rectNode(r, box.x, box.y, ` origin-left${animate(`${key("lunder", { from: { scaleX: "0" }, to: { scaleX: "1" } })} 320ms ${cubic.out} ${ms(punchAt)} both`)}`));
    }
    // Glyphs in reading order, each with its own entrance delay.
    let order = 0;
    const cursorStops: { t: number; left: number; x: number; y: number; h: number }[] = [];
    for (const index of cut.text) {
      const line = layout.lines[index]!;
      const emph = Boolean(line.emphasis);
      const offset = line.offset;
      const glyphs = graphemes(line.text);
      const run: string[] = [];
      let prefix = "";
      const baseX = offset ? line.x + offset.x : line.x, baseY = offset ? line.y + offset.y : line.y;
      for (const g of glyphs) {
        const gx = baseX + (offset ? 0 : measure.width(prefix, line.size, line.bold));
        prefix += g;
        if (!g.trim()) continue;
        const k = order++;
        const delay = typing ? S + k * typeStep : S + (n > 1 ? (window * k) / (n - 1) : 0);
        const s = line.size;
        let value: string;
        switch (entrance) {
          case "rise": value = `${key(`lrise${Math.round(s * timing.riseEm)}`, { from: { opacity: "0", translateY: px(s * timing.riseEm) }, to: { opacity: "1", translateY: "0px" } })} ${ms(enterMs)} ${cubic.out} ${ms(delay)} both`; break;
          case "drop": { const d = Math.round(s * 0.7); value = `${key(`ldrop${d}`, { from: { opacity: "0", translateY: px(-d) }, "45%": { opacity: "1", translateY: px(d * 0.12) }, "72%": { opacity: "1", translateY: px(-d * 0.04) }, to: { opacity: "1", translateY: "0px" } })} ${ms(enterMs + 80)} ${cubic.out} ${ms(delay)} both`; break; }
          case "slide": value = `${key(`lslide${Math.round(s * timing.slideEm)}`, { from: { opacity: "0", translateX: px(-s * timing.slideEm) }, to: { opacity: "1", translateX: "0px" } })} ${ms(enterMs)} ${cubic.out} ${ms(delay)} both`; break;
          case "type": value = `${key("ltype", { from: { opacity: "0" }, to: { opacity: "1" } })} 17ms linear ${ms(delay)} both`; break;
          default: value = `${key("lfade", { from: { opacity: "0" }, to: { opacity: "1" } })} ${ms(Math.min(enterMs, 380))} ease-out ${ms(delay)} both`;
        }
        // The emphasised word turns from ink to the accent at the punch.
        if (emph) value += `, ${key(`lglow${hex(p.ink)}${hex(line.color)}`, { from: { color: p.ink }, to: { color: line.color } })} 260ms ease-out ${ms(punchAt)} both`;
        if (typing) cursorStops.push({ t: delay, left: gx - box.x, x: gx + measure.width(g, line.size, line.bold) - box.x, y: line.y - box.y, h: line.size });
        run.push(glyphNode(g, gx - (emph ? line.x : box.x), baseY - (emph ? line.y : box.y), line, emph ? p.ink : line.color, animate(value)));
      }
      if (emph) {
        const r = { x: line.x - box.x, y: line.y - box.y, width: line.width, height: line.height };
        const lift = Math.round(line.size * 0.2);
        textNodes.push(view(r, animate(`${key(`lpunch${lift}`, { "0%": { translateY: "0px", scale: "1" }, "35%": { translateY: px(-lift), scale: "1.18" }, "68%": { translateY: px(lift * 0.15), scale: "0.98" }, "100%": { translateY: "0px", scale: "1" } })} ${ms(timing.punchMs)} ${cubic.out} ${ms(punchAt)} both`), run));
      } else textNodes.push(...run);
    }
    // Typewriter: a caret that follows the typing, then blinks.
    if (typing && cursorStops.length) {
      const first = cursorStops[0]!, lastStop = cursorStops.at(-1)!, span = Math.max(17, lastStop.t - first.t);
      const thickness = Math.max(3, Math.round(LYRICS_STYLES[variant].motion.cursor.thickness * W / 1080));
      // The caret waits at the left of each glyph until it is typed, then jumps past it.
      const frames: Record<string, Record<string, string>> = { "0%": { translateX: px(first.left), translateY: px(first.y) } };
      for (const stop of cursorStops) {
        const at = Math.round(((stop.t - first.t) / span) * 10000) / 100;
        if (at > 0 && at < 100) frames[`${at}%`] = { translateX: px(stop.x), translateY: px(stop.y) };
      }
      frames["100%"] = { translateX: px(lastStop.x), translateY: px(lastStop.y) };
      const name = key(`lcaret${i}`, frames);
      const caret = `<View class="absolute left-[0px] top-[${px(Math.round(first.h * 0.12))}] w-[${thickness}px] h-[${px(Math.round(first.h * 1.02))}] bg-[${p.accent}]${animate(`${name} ${ms(span)} linear ${ms(first.t)} both, ${key("lblink", { "0%": { opacity: "1" }, "49%": { opacity: "1" }, "50%": { opacity: "0" }, "99%": { opacity: "0" }, "100%": { opacity: "1" } })} 900ms linear ${ms(lastStop.t + 300)} infinite`)}" />`;
      textNodes.push(caret);
    }
    const quietNodes: string[] = [];
    for (const index of cut.quiet) {
      const line = layout.lines[index]!;
      let prefix = "";
      const anim = animate(`${key(`lquiet${Math.round(line.size * 0.3)}`, { from: { opacity: "0", translateY: px(line.size * 0.3) }, to: { opacity: "1", translateY: "0px" } })} 480ms ${cubic.out} ${ms(S + (cut.text.length ? Math.min(window + enterMs, cut.hold * 0.5) * 0.6 : 0))} both`);
      const run: string[] = [];
      for (const g of graphemes(line.text)) {
        const gx = line.x + measure.width(prefix, line.size, line.bold);
        prefix += g;
        if (g.trim()) run.push(glyphNode(g, gx - outer.x, line.y - outer.y, line, line.color, ""));
      }
      quietNodes.push(view({ x: 0, y: 0, width: outer.width, height: outer.height }, anim, run));
    }
    const motion = view({ x: box.x - outer.x, y: box.y - outer.y, width: box.width, height: box.height }, motionAnims.length ? animate(motionAnims.join(", ")) : "", textNodes);
    const exitAnim = last ? "" : timing.exitEm
      ? animate(`${key(`lexit${Math.round(cut.glyphSize * timing.exitEm)}`, { from: { opacity: "1", translateY: "0px" }, to: { opacity: "0", translateY: px(-cut.glyphSize * timing.exitEm) } })} ${ms(timing.exitMs)} ${cubic.in} ${ms(S + cut.hold - timing.exitMs * 0.4)} both`)
      : animate(`${key("lfadeout", { from: { opacity: "1" }, to: { opacity: "0" } })} ${ms(timing.exitMs)} ease-in ${ms(S + cut.hold - timing.exitMs * 0.5)} both`);
    inner.push(view(outer, exitAnim, [motion, ...quietNodes]));
    // A trailing "!": a quick flash over the screen as the line lands.
    if (cut.bang) inner.push(`<View class="absolute left-[0px] top-[0px] w-[${W}px] h-[${H}px] bg-[${variant === "classic" ? p.ink : p.accent}]${animate(`${key("lflash", { "0%": { opacity: "0" }, "18%": { opacity: variant === "classic" ? "0.55" : "0.22" }, "100%": { opacity: "0" } })} 340ms ease-out ${ms(revealEnd - 60)} both`)}" />`);
    // The signature, in this cut's secondary colour.
    for (const line of signature) {
      let prefix = "";
      for (const g of graphemes(line.text)) {
        const gx = line.x + measure.width(prefix, line.size, line.bold);
        prefix += g;
        if (g.trim()) inner.push(glyphNode(g, gx, line.y, line, p.sub, i === 0 ? "" : animate(`${key("lfadein", { from: { opacity: "0" }, to: { opacity: "1" } })} ${ms(timing.transitionMs)} ease-in-out ${ms(cut.inAt)} both`)));
      }
    }
    // Gates: a cut appears when its transition starts and is hidden once the next one covers it.
    const show = i === 0 ? "" : animate(`${key("lshow", { from: { opacity: "0" }, to: { opacity: "1" } })} 17ms linear ${ms(cut.inAt)} both`);
    const hide = last ? "" : animate(`${key("lhide", { from: { opacity: "1" }, to: { opacity: "0" } })} 17ms linear ${ms(cut.end)} both`);
    const full = { x: 0, y: 0, width: W, height: H };
    nodes.push(view(full, show, [hide ? view(full, hide, inner) : inner.join("\n")]));
  }
  const frames = Math.ceil((program.durationMs / 1000) * LYRICS_TIMING.fps) + 1;
  return { body: nodes.join("\n"), keyframes, animations, frames, emojiKeys };
}
