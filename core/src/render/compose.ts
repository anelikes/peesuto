/**
 * compose — a clipboard card from an all-enumerated DSL.
 *
 * Writes a Pocket Motion composition (`main.tsx`, `pocket.config.ts`,
 * `pocket-motion.json`, `pocket.json`, `images.json`, staged emoji) into a
 * directory inside the work tree. Line breaks and sizes are measured against
 * the engine's own atlases, never guessed. The engine's text modules are
 * imported from the engine checkout at run time, so this file has no
 * compile-time dependency on where the engine is.
 *
 * What happens to text that does not fit is a policy, not an accident:
 * - a script the face has no glyphs for is REFUSED before anything is
 *   measured (`ComposeError` with code `unsupported-script`);
 * - prose that overflows every size of its ladder drops to the smallest size
 *   and is cut at a sentence or line boundary with an ellipsis
 *   (`truncated: true` in the result);
 * - code lines wider than the column at the smallest size are hard-wrapped,
 *   keeping their indentation; list items are word-wrapped under the bullet;
 * - only when not even one line fits does compose throw (code `overflow`).
 */
import { resolve } from "node:path";
import { BASE_CATALOG, type Catalog } from "../catalog.ts";
import type { Dsl, Aspect, Kind } from "../dsl.ts";
import { MAX_EMPHASIS_WORDS, segmentWords } from "../questions.ts";
import { splitEmoji, stageEmoji, stripEmoji } from "./emoji.ts";

/* ---- the engine surface this composer uses ------------------------------- */
type Measure = (s: string) => number;
interface FitApi {
  segments(text: string, locale?: string): string[];
  wrapLines(text: string, o: { maxWidth: number; measure: Measure; locale?: string; strategy?: "greedy" | "balanced" }): string[];
  fitToBox(
    text: string, box: { maxWidth: number; maxHeight: number },
    candidates: readonly { px: number; measure: Measure; lineHeight: number }[],
    locale: string, strategy: "greedy" | "balanced",
  ): { lines: string[]; px: number; overflows: boolean };
}
interface Measurer {
  measure(px: number, bold?: boolean): Measure;
  lineHeight(px: number, bold?: boolean): number;
  unmapped(text: string, px: number, bold?: boolean): string[];
  close(): Promise<void>;
}
interface MeasureApi {
  openMeasurer(o: {
    face: { regular: string; bold: string };
    sizes: readonly { px: number; bold?: boolean }[];
    texts: readonly string[];
    density?: number;
    cache?: { charset: string; dir?: string };
  }): Promise<Measurer>;
}

export interface ComposeOptions {
  /** Engine checkout root: fonts and text modules are read from here. */
  readonly engine: string;
  /** Work tree root: the composition lives under `<work>/compositions/paste`. */
  readonly work: string;
  /** Where fetched emoji PNGs are cached across pastes. */
  readonly emojiCache: string;
  /** A bundled Noto Emoji set (`emoji_u<key>.png`), consulted before the cache. */
  readonly emojiBundle?: string;
  readonly catalog?: Catalog;
}

export interface ComposeResult {
  readonly dir: string;
  readonly lines: number;
  readonly size: number;
  readonly frames: number;
  readonly emoji: number;
  /** The text was cut to fit; an ellipsis marks the cut. */
  readonly truncated: boolean;
}

/**
 * `overflow`: not even one line fits. `unsupported-script`: the face has no
 * glyphs for part of the text. `empty`: nothing is left to show once the
 * text is normalised. `catalog`: the DSL names something the catalog lacks.
 * `fidelity`: a template layout would draw text the source did not say, or
 * leave some of it out (templates/checks.ts); nothing is rendered.
 */
/** lyric-unfit: code, a table or a diagram as lyric motion; lyric-too-long: more cuts than one lyric-motion video holds;
 * lyric-gif-too-long: more than the (shorter) GIF holds — a video may still fit. */
export type ComposeErrorCode = "overflow" | "unsupported-script" | "empty" | "catalog" | "qr-too-long" | "fidelity" | "lyric-unfit" | "lyric-too-long" | "lyric-gif-too-long";

export class ComposeError extends Error {
  readonly code: ComposeErrorCode;
  /** For unsupported-script: the characters the font cannot draw. */
  readonly characters?: readonly string[];
  constructor(code: ComposeErrorCode, message: string, characters?: readonly string[]) {
    super(message);
    this.code = code;
    if (characters?.length) this.characters = characters;
  }
}

const VIEW: Record<Aspect, { w: number; h: number }> = { chat: { w: 1080, h: 1080 }, doc: { w: 1920, h: 1080 }, social: { w: 1080, h: 1920 } };
/** Noto Sans SC bakes up to 176 px (engine AGENTS.md); ladders stay under it. */
const LADDER: Record<number, readonly number[]> = { 0: [40, 36, 32], 1: [56, 48, 42, 36], 2: [80, 72, 64, 56, 48], 3: [120, 104, 96, 84, 72, 60] };
const HERO: Record<number, readonly number[]> = { 0: [120, 104], 1: [144, 128, 112], 2: [160, 144, 128], 3: [176, 160, 144, 128] };
const AMP = [0, 24, 56, 110] as const;   // translateY px by tone
const DUR = [0, 360, 480, 620] as const; // ms by tone
const EASE = ["linear", "cubic-bezier(0.33,1,0.68,1)", "cubic-bezier(0.16,1,0.3,1)", "cubic-bezier(0.34,1.56,0.64,1)"] as const;
const FPS = 30;
const STAGGER_MS = 110;
/** Vertical gap between line boxes (`gap-[6px]` on the column). */
const GAP = 6;
/** The accent rule of the split layout and the space after it. */
const SPLIT_INSET = 56;

const jsx = (s: string) => JSON.stringify(s);
const px = (v: number) => `${Math.round(v)}px`;

/* ---- pure text helpers, unit-tested without the engine ------------------- */

/**
 * Scripts refused before measuring. Noto Sans SC — the only face the card
 * bakes — has no glyphs for them, so a line in one of these would otherwise
 * reach the measurer and be refused there with an engine error naming
 * codepoints. Hangul is on the list for the same reason (probed: the face
 * maps no Hangul syllables). CJK, Latin, Greek and Cyrillic are fine; a
 * character outside the cached charset only takes the slow measuring path.
 */
const UNSUPPORTED_SCRIPTS: readonly (readonly [string, RegExp])[] = [
  ["Arabic", /\p{Script=Arabic}/u],
  ["Hebrew", /\p{Script=Hebrew}/u],
  ["Thai", /\p{Script=Thai}/u],
  ["Devanagari", /\p{Script=Devanagari}/u],
  ["Hangul", /\p{Script=Hangul}/u],
];

/** The name of the first unsupported script `text` contains, or undefined. */
export function unsupportedScript(text: string): string | undefined {
  return UNSUPPORTED_SCRIPTS.find(([, re]) => re.test(text))?.[0];
}

/**
 * Clipboard bytes the face cannot draw or the wrap cannot place: CRLF and
 * Unicode line separators become `\n`, tabs become spaces (four in code, two
 * elsewhere), NBSP a space; control characters, zero-width characters, soft
 * hyphens and lone surrogates are dropped; trailing whitespace per line goes;
 * three or more blank lines collapse to one.
 */
export function normalizeText(text: string, kind: Kind): string {
  const tab = kind === "code" ? "    " : "  ";
  return text
    .replace(/\r\n?|\p{Zl}|\p{Zp}/gu, "\n")
    .replace(/\t/g, tab)
    .replace(/\p{Zs}/gu, " ")
    .replace(/[^\P{Cc}\n]|\p{Cs}|[^\P{Cf}\p{Join_Control}]/gu, "")
    .split("\n").map((l) => l.trimEnd()).join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

const DASH = "(?:——|—|--|-)";
/** A name after the dash: one line, no further dash, no sentence end. */
const NAME = "((?:(?!--)[^\\n—。！？!?])+)";
/**
 * An attribution is a dash plus a short name at the END of the text, and the
 * dash has to be on its own line, right after a closing quote mark, or right
 * after a sentence end. A dash inside the body (`灵感——加上汗水`) is prose.
 */
const ATTRIBUTION = new RegExp(`^([\\s\\S]*?)(\\n\\s*|[”"」』’]\\s*|[。．.!?！？…]\\s*)${DASH}\\s*${NAME}$`, "u");
const MAX_NAME = 40;

/** Body and attribution of a quote; the body loses its surrounding quote marks. */
export function splitQuote(text: string): { readonly body: string; readonly attribution: string } {
  let body = text.trim(), attribution = "";
  const m = body.match(ATTRIBUTION);
  const name = m?.[3]?.trim() ?? "";
  if (m && name && [...name].length <= MAX_NAME && /[\p{L}\p{N}]/u.test(name)) {
    body = (m[1]! + (m[2]!.startsWith("\n") ? "" : m[2]!)).trim();
    attribution = name;
  }
  body = body.replace(/^[“"「『‘]/, "").replace(/[”"」』’]$/, "").trim();
  return { body, attribution };
}

/** A number with an optional currency sign and an optional unit; not part of a word or a version. */
const NUMBER = /(?<![A-Za-z0-9.])([$¥€£￥]?[+-]?\d(?:[\d,]*\d)?(?:\.\d+)?)(?:\s?(?:([%％万亿倍])|([xX×kKmM])(?![A-Za-z0-9])))?(?![0-9])/gu;

/**
 * The number a stat card makes its hero: the first one carrying a unit
 * (%, 万, 亿, 倍, x, k, M), else the largest. `rest` is the text without it.
 */
export function pickHeroNumber(text: string): { readonly hero: string; readonly rest: string } | undefined {
  const found = [...text.matchAll(NUMBER)].map((m) => ({
    start: m.index!, end: m.index! + m[0].length,
    hero: m[1]! + (m[2] ?? m[3] ?? ""),
    unit: (m[2] ?? m[3]) !== undefined,
    value: Math.abs(parseFloat(m[1]!.replace(/[$¥€£￥+,]/g, ""))),
  }));
  if (found.length === 0) return undefined;
  const pick = found.find((f) => f.unit) ?? found.reduce((a, b) => (b.value > a.value ? b : a));
  const rest = (text.slice(0, pick.start) + text.slice(pick.end)).replace(/\s{2,}/g, " ").trim();
  return { hero: pick.hero, rest };
}

/**
 * A code line broken by grapheme cluster wherever `fits` says it is too
 * wide; continuation lines repeat the original indentation (unless the
 * indentation alone does not fit). No marker is added: a card is a picture,
 * not a terminal, and a `↩` would be one more glyph to bake.
 */
export function hardWrapLine(line: string, fits: (s: string) => boolean): string[] {
  if (fits(line)) return [line];
  const indent = line.match(/^\s*/)![0];
  const pre = fits(indent + "x") ? indent : "";
  const out: string[] = [];
  let cur = indent, filled = false;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line.slice(indent.length))) {
    if (filled && !fits(cur + segment)) { out.push(cur); cur = pre; filled = false; }
    cur += segment;
    filled = true;
  }
  out.push(cur);
  return out;
}

/**
 * `text` cut to the prefix its first wrapped lines `kept` cover, pulled back
 * to the last sentence end in that prefix — or the last line break, or the
 * last word boundary, whichever still keeps at least 40 % of it — with an
 * ellipsis. The wrapped lines carry the text's characters minus the
 * whitespace dropped at breaks, so the prefix is found by counting
 * non-blank characters rather than by string matching.
 */
export function cutAtBoundary(text: string, kept: readonly string[]): string {
  const want = [...kept.join("")].filter((c) => c.trim() !== "").length;
  let prefix = "", seen = 0;
  for (const c of text) {
    if (seen >= want) break;
    prefix += c;
    if (c.trim() !== "") seen++;
  }
  const min = Math.floor(prefix.length * 0.4);
  const lastEnd = (re: RegExp): number => { let end = -1; for (const m of prefix.matchAll(re)) end = m.index! + m[0].length; return end; };
  // A full-width sentence end needs nothing after it; an ASCII one needs a
  // space or the end (a `.` inside `2.4.1` or a URL is not a boundary).
  let end = lastEnd(/(?:[。！？…]+["”」』’)）]*|[.!?]+["”」』’)）]*(?=\s|$))/g);
  if (end < min) end = lastEnd(/\n/g);
  if (end < min) {
    // Mid-word only if the character after the prefix continues the word.
    const next = text.slice(prefix.length).match(/^./u)?.[0] ?? "";
    end = /[A-Za-z0-9]/.test(next) ? prefix.replace(/[A-Za-z0-9'’-]+$/, "").length : prefix.length;
  }
  if (end < min) end = prefix.length;
  const out = prefix.slice(0, end).trimEnd().replace(/[，,、；;：:（(]+$/, "");
  return out.endsWith("…") ? out : out + "…";
}

/** The first `maxLines` of explicit lines, the last one ending in an ellipsis (its own line if it would not fit). */
export function truncateLines(lines: readonly string[], maxLines: number, fits: (s: string) => boolean): string[] {
  const kept = lines.slice(0, Math.max(1, maxLines));
  const last = kept[kept.length - 1]!.replace(/[\s，,、；;：:]+$/, "") + "…";
  kept[kept.length - 1] = fits(last) ? last : "…";
  return kept;
}

/** Markers a list item may start with; the card draws its own bullet. */
export const LIST_MARKER = /^\s*(?:[-*•·]\s*(?:\[[ xX]\])?|\d+[.、)）]|[一二三四五六七八九十]+[、.]|[（(]\d+[)）]|[①-⑳])\s*/;

let charsetCache: string | undefined;
async function charset(): Promise<string> {
  // `Bun.file` takes the URL itself: `.pathname` would percent-encode a space
  // in the path (`Application Support`).
  charsetCache ??= await Bun.file(new URL("./charset.txt", import.meta.url)).text();
  return charsetCache;
}

/** A line as drawn: continuation lines of a wrapped list item get a spacer instead of a bullet. */
interface LineItem { readonly text: string; readonly cont: boolean }

export async function composeCard(dsl: Dsl, o: ComposeOptions): Promise<ComposeResult> {
  const fitApi = (await import(`${o.engine}/src/text/fit.ts`)) as FitApi;
  const measureApi = (await import(`${o.engine}/src/text/measure.ts`)) as MeasureApi;
  const catalog = o.catalog ?? BASE_CATALOG;
  // Absolute: the engine's measurement build runs with the engine as cwd, so
  // a relative work tree would be resolved against the wrong root.
  const work = resolve(o.work);
  const dir = `${work}/compositions/paste`;
  const DIR = `${dir}/`;
  const view = VIEW[dsl.aspect];
  const palEntry = catalog.palettes[dsl.palette];
  if (!palEntry) throw new ComposeError("catalog", `palette ${dsl.palette} is not in the catalog`);
  const pal = palEntry.colors;
  const margin = Math.round(view.w * 0.09);
  const colW = view.w - 2 * margin;
  /** What the text may span: the split layout keeps an accent rule on the left. */
  const textW = dsl.layout === "split" ? colW - SPLIT_INSET : colW;

  // --- refuse what the face cannot draw, before any build ---
  const script = unsupportedScript(dsl.text);
  if (script) throw new ComposeError("unsupported-script", `the card font (Noto Sans SC) has no ${script} glyphs; this text cannot become a card`);

  // --- split the clipboard into what the kind needs ---
  let body = normalizeText(dsl.text, dsl.kind).trim(), attribution = "";
  if (dsl.kind === "quote") ({ body, attribution } = splitQuote(body));
  let heroNum = "";
  if (dsl.kind === "stat") {
    const picked = pickHeroNumber(body);
    if (picked) ({ hero: heroNum, rest: body } = picked);
  }
  if (!body.trim() && !heroNum) throw new ComposeError("empty", "nothing is left to show once the text is normalised");
  const explicitLines = dsl.kind === "code" || dsl.kind === "list";
  const bold = dsl.kind !== "code";
  const sizes = [...new Set([...(LADDER[dsl.scale]!), ...(heroNum ? HERO[dsl.scale]! : []), 28, 32])];
  const words = fitApi.segments(body, "zh-CN");
  // Emoji are pictures, not glyphs: they never reach the atlas or the
  // measurer, and they measure as one advance of the font size (below).
  const texts = [body, attribution, heroNum, ...words, ...body.split("\n"), "“", "”", "·", "…"]
    .map(stripEmoji)
    .filter(Boolean);

  // `charset.txt`: ASCII, CJK punctuation and the 3755 level-1 GB2312
  // characters. With it the measurement is a cached metrics-only bake booted
  // per paste instead of a build per paste; a clipboard with a character
  // outside it falls back to the build.
  const m = await measureApi.openMeasurer({
    face: { regular: `${o.engine}/assets/fonts/NotoSansSC-Regular.otf`, bold: `${o.engine}/assets/fonts/NotoSansSC-Bold.otf` },
    sizes: sizes.flatMap((s) => [{ px: s, bold: true }, { px: s, bold: false }]),
    texts, density: 1,
    cache: { charset: await charset(), dir: `${work}/dist/.measure` },
  });
  try {
    // A codepoint the face has no glyph for measures as the tofu cell; the
    // measurer refuses it string by string with an engine error. Refuse it
    // here once, naming what is missing.
    const missing = m.unmapped(texts.join(""), sizes[0]!, bold);
    if (missing.length > 0) {
      const named = missing.slice(0, 8).map((c) => `"${c}" (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`).join(", ");
      throw new ComposeError("unsupported-script", `the card font (Noto Sans SC) has no glyph for ${named}${missing.length > 8 ? ` and ${missing.length - 8} more` : ""}`);
    }
    /** A width function that measures text runs with the atlas and emoji as `px` each. */
    const measureWith = (px: number, isBold: boolean) => {
      const base = m.measure(px, isBold);
      return (s: string): number =>
        splitEmoji(s).reduce((w, r) => w + ("text" in r ? (r.text ? base(r.text) : 0) : px), 0);
    };
    /** The box one drawn line takes: the line View's height plus the column gap. */
    const lineBox = (s: number): number => Math.round(m.lineHeight(s, bold) * (dsl.kind === "code" ? 1.5 : 1.3)) + GAP;
    // --- fit the body ---
    let items: LineItem[], size: number, truncated = false;
    // Prose keeps to 62 % of the height; code and lists, whose lines are
    // given, may use 75 % — an eight-line function should fit a doc card.
    const maxH = Math.round(view.h * (heroNum ? 0.35 : explicitLines ? 0.75 : 0.62));
    const ladder = LADDER[dsl.scale]!;
    const smallest = ladder[ladder.length - 1]!;
    if (explicitLines) {
      const raw = body.split("\n").map((l) => (dsl.kind === "list" ? l.replace(LIST_MARKER, "") : l)).filter((l) => dsl.kind === "code" || l.trim());
      const bulletW = (s: number): number => (dsl.kind === "list" ? Math.ceil(measureWith(s, bold)("·  ")) : 0);
      const fitsW = (s: number, l: string): boolean => measureWith(s, bold)(l) <= textW - bulletW(s);
      const fitsH = (n: number, s: number): boolean => n * lineBox(s) <= maxH;
      // Shrink before wrapping: the largest size at which every line fits as it is.
      const whole = ladder.find((s) => raw.every((l) => fitsW(s, l)) && fitsH(raw.length, s));
      if (whole !== undefined) {
        size = whole;
        items = raw.map((text) => ({ text, cont: false }));
      } else if (dsl.kind === "code") {
        // Code: the smallest size, over-long lines broken at the column.
        size = smallest;
        items = raw.flatMap((l) => hardWrapLine(l, (s) => fitsW(smallest, s)).map((text, i) => ({ text, cont: i > 0 })));
      } else {
        // List: items word-wrapped under the bullet, at the largest size whose block fits.
        const wrapAt = (s: number): LineItem[] => raw.flatMap((l) =>
          fitApi.wrapLines(l, { maxWidth: textW - bulletW(s), measure: measureWith(s, bold), locale: "zh-CN" }).map((text, i) => ({ text, cont: i > 0 })));
        const found = ladder.map((s) => ({ s, items: wrapAt(s) })).find(({ s, items }) => fitsH(items.length, s));
        ({ s: size, items } = found ?? { s: smallest, items: wrapAt(smallest) });
      }
      if (!fitsH(items.length, size)) {
        const maxLines = Math.floor(maxH / lineBox(size));
        if (maxLines < 1) throw new ComposeError("overflow", `not even one line fits at ${size}px in a ${view.w}x${view.h} card`);
        const chosen = size;
        const cut = truncateLines(items.map((i) => i.text), maxLines, (s) => fitsW(chosen, s));
        items = cut.map((text, i) => ({ text, cont: items[i]!.cont }));
        truncated = true;
      }
    } else {
      const box = { maxWidth: textW, maxHeight: maxH };
      const candidate = (s: number) => ({ px: s, measure: measureWith(s, bold), lineHeight: lineBox(s) });
      let fit = fitApi.fitToBox(body, box, ladder.map(candidate), "zh-CN", "balanced");
      if (fit.overflows) {
        // The smallest size, cut at a boundary to what fits; `fit.lines` is
        // the smallest candidate's wrap, which is where the cut is read off.
        const maxLines = Math.floor(maxH / lineBox(smallest));
        if (maxLines < 1) throw new ComposeError("overflow", `not even one line fits at ${smallest}px in a ${view.w}x${view.h} card`);
        const base = fit.lines;
        let done = false;
        for (let n = Math.min(maxLines, base.length); n >= 1 && !done; n--) {
          const cut = cutAtBoundary(body, base.slice(0, n));
          if (cut === "…") break;
          const again = fitApi.fitToBox(cut, box, [candidate(smallest)], "zh-CN", "balanced");
          if (!again.overflows) { fit = again; done = true; }
        }
        if (!done) throw new ComposeError("overflow", `not even one line of this text fits at ${smallest}px in a ${view.w}x${view.h} card`);
        truncated = true;
      }
      items = fit.lines.map((text) => ({ text, cont: false }));
      size = fit.px;
    }
    const lines = items.map((i) => i.text);
    const lh = Math.round(m.lineHeight(size, bold) * (dsl.kind === "code" ? 1.5 : 1.3));

    // --- animation registry ---
    const keyframes: Record<string, unknown> = {};
    const animation: Record<string, { value: string }> = {};
    let n = 0;
    const rise = (delayMs: number) => {
      if (!dsl.animate || dsl.tone === 0) return "";
      keyframes.rise ??= { from: { translateY: `${AMP[dsl.tone]}px`, opacity: "0" }, to: { translateY: "0px", opacity: "1" } };
      const name = `r${n++}`;
      animation[name] = { value: `rise ${DUR[dsl.tone]}ms ${EASE[dsl.tone]} ${delayMs}ms both` };
      return ` animate-${name}`;
    };

    // --- emit lines; the emphasised word is its own run, once ---
    // `emphasis` indexes the word list Jev was shown (`segmentWords` over the
    // ORIGINAL text, letters and digits only, capped), never the engine's
    // segments of the trimmed body: the two disagree on every punctuation
    // mark, and a stripped quote body shifts them further.
    const jevWords = segmentWords(dsl.text).slice(0, MAX_EMPHASIS_WORDS);
    const candidate = dsl.emphasis >= 0 ? jevWords[dsl.emphasis] : undefined;
    const emphWord = candidate && /[\p{L}\p{N}]/u.test(candidate) ? candidate : undefined;
    let emphDone = false;
    const align = dsl.layout === "center" ? "items-center" : "items-start";
    const textCls = `text-[${size}px] ${bold ? "font-bold" : ""}`;
    const emojiKeys = new Set<string>();
    /** Text runs as `Text`, emoji runs as square `Image`s at the font size. */
    const plainRuns = (s: string, cls: string, color: string, name?: string): string =>
      splitEmoji(s).map((r) => {
        if ("emoji" in r) {
          emojiKeys.add(r.key);
          return `<Image class="w-[${size}px] h-[${size}px]" src="e_${r.key}.png" />`;
        }
        return r.text ? `<Text${name ? ` debugName="${name}"` : ""} class="${cls} text-[${color}]">{${jsx(r.text)}}</Text>` : "";
      }).join("");
    const runs = (line: string, cls: string): string => {
      if (!emphWord || emphDone || !line.includes(emphWord)) return plainRuns(line, cls, pal.ink);
      emphDone = true;
      const at = line.indexOf(emphWord);
      return plainRuns(line.slice(0, at), cls, pal.ink) + plainRuns(emphWord, cls, pal.accent, "emphasis") + plainRuns(line.slice(at + emphWord.length), cls, pal.ink);
    };
    const bulletW = dsl.kind === "list" ? Math.ceil(measureWith(size, bold)("·  ")) : 0;
    /** Nodes `layout` may stop reporting, with the reason next to each (`verify` reads them). */
    const layoutAllow: { node: string; allow: "occlusion" | "overflow"; reason: string }[] = [];
    const delayed = (node: string, ms: number): void => {
      if (dsl.animate && dsl.tone > 0 && ms > 0) layoutAllow.push({ node, allow: "occlusion", reason: `enters at ${ms} ms; not painted before its rise` });
    };
    const lineNodes = items.map((item, li) => {
      // A blank line is a spacer: unnamed, so no gate expects it to paint.
      if (!item.text.trim()) return `        <View class="h-[${lh}px]" />`;
      const prefix = dsl.kind !== "list" ? "" : item.cont
        ? `<View class="w-[${bulletW}px] h-[${lh}px]" />`
        : `<Text class="${textCls} text-[${pal.accent}]">{"·  "}</Text>`;
      delayed(`line-${li}`, li * STAGGER_MS);
      return `        <View debugName="line-${li}" class="flex-row h-[${lh}px] items-center${rise(li * STAGGER_MS)}">${prefix}${runs(item.text, textCls)}</View>`;
    });
    const parts: string[] = [];
    if (dsl.kind === "quote") {
      parts.push(`        <Text debugName="quote-mark" class="text-[${Math.min(176, size * 2)}px] font-bold text-[${pal.accent}] h-[${Math.round(size * 1.2)}px]${rise(0)}">{"“"}</Text>`);
      layoutAllow.push({ node: "quote-mark", allow: "overflow", reason: "set at twice the body size in a box 1.2 body heights tall; its ink hangs a few px below the box by design" });
    }
    if (heroNum) {
      const heroSizes = HERO[dsl.scale]!;
      const hs = heroSizes.find((s) => m.measure(s, true)(heroNum) <= textW) ?? heroSizes[heroSizes.length - 1]!;
      parts.push(`        <Text debugName="hero" class="text-[${hs}px] font-bold text-[${pal.accent}] h-[${Math.round(m.lineHeight(hs, true))}px]${rise(0)}">{${jsx(heroNum)}}</Text>`);
    }
    parts.push(...lineNodes);
    if (attribution) {
      delayed("attribution", lines.length * STAGGER_MS + 120);
      parts.push(`        <View class="h-[${Math.round(lh * 0.6)}px]" /><View debugName="attribution" class="flex-row items-center${rise(lines.length * STAGGER_MS + 120)}">${plainRuns("— " + attribution, "text-[32px]", pal.muted)}</View>`);
    }

    // --- emoji pictures beside the composition, declared linear for the downscale ---
    const emojiFiles = await stageEmoji(emojiKeys, o.emojiCache, dir, o.emojiBundle);
    await Bun.write(`${DIR}images.json`, JSON.stringify(Object.fromEntries(emojiFiles.map((f) => [f, { linear: true }])), null, 2) + "\n");

    const column = dsl.layout === "split"
      ? `      <View class="absolute left-[${px(margin)}] top-[${px(margin)}] w-[8px] h-[${px(view.h - 2 * margin)}] bg-[${pal.accent}] rounded-[4px]" />
      <View class="absolute left-[${px(margin + SPLIT_INSET)}] top-0 w-[${px(colW - SPLIT_INSET)}] h-[${px(view.h)}] flex-col justify-center ${align} gap-[${GAP}px]">
${parts.join("\n")}
      </View>`
      : `      <View class="absolute left-[${px(margin)}] top-0 w-[${px(colW)}] h-[${px(view.h)}] flex-col justify-center ${align} gap-[${GAP}px]">
${parts.join("\n")}
      </View>`;

    const bg = dsl.kind === "code" ? `bg-[${pal.bg2}]` : `bg-gradient-to-b from-[${pal.bg}] to-[${pal.bg2}]`;
    await Bun.write(`${DIR}main.tsx`, `// GENERATED by pocket-paste core/src/render/compose.ts — do not edit by hand.
import { mount } from "@pocketjs/framework";
import { ${emojiFiles.length > 0 ? "Image, " : ""}Text, View } from "@pocketjs/framework/components";

mount(() => (
  <View class="w-full h-full ${bg}">
    <View class="absolute left-0 top-0 w-[${view.w}px] h-[${view.h}px]">
${column}
    </View>
  </View>
));
`);
    await Bun.write(`${DIR}pocket.config.ts`, `// GENERATED by pocket-paste core/src/render/compose.ts — do not edit by hand.
import { definePocketConfig } from "../../vendor/pocketjs/framework/src/config.ts";
export default definePocketConfig({ theme: { keyframes: ${JSON.stringify(keyframes)}, animation: ${JSON.stringify(animation)} } });
`);
    const frames = dsl.animate && dsl.tone > 0 ? Math.ceil((DUR[dsl.tone] + STAGGER_MS * (lines.length + 1) + 700) / 1000 * FPS) : 1;
    await Bun.write(`${DIR}pocket-motion.json`, JSON.stringify({
      motion: 1, durationFrames: frames, fps: FPS, supersample: 1,
      fonts: { regular: "assets/fonts/NotoSansSC-Regular.otf", bold: "assets/fonts/NotoSansSC-Bold.otf" },
      // The assertion names a node that only exists when the word landed in
      // a line (it may have gone into the hero number or the attribution).
      assertions: emphDone ? [{ node: "emphasis", inPicture: [frames - 1, frames - 1] }] : [],
      ...(layoutAllow.length > 0 ? { layoutAllow } : {}),
    }, null, 2) + "\n");
    await Bun.write(`${DIR}pocket.json`, JSON.stringify({
      $schema: "https://pocketjs.dev/schema/pocket-2.json", pocket: 2, id: "dev.pocket-stack.motion-paste", name: "pocketjs-motion-paste",
      title: "paste card", version: "0.0.0", engine: { capabilities: { requires: ["text.glyphs.baked"] } },
      app: { entry: "compositions/paste/main.tsx", output: "motion-paste", framework: "solid", viewport: { fixed: { logical: [view.w, view.h], presentation: "native" } } },
    }, null, 2) + "\n");
    return { dir, lines: lines.length, size, frames, emoji: emojiFiles.length, truncated };
  } finally { await m.close(); }
}
