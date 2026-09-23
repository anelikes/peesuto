/** Native engine compositions for structured templates. Legacy DSL composition stays unchanged. */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ComposeError, normalizeText, unsupportedScript, type ComposeOptions, type ComposeResult } from "../render/compose.ts";
import { splitEmoji, stageEmoji, stripEmoji } from "../render/emoji.ts";
import { templateHasVariant } from "./registry.ts";
import { layoutDiagram, type DiagramNode } from "./diagram.ts";
import { FRAMES, TEMPLATE_MAX_GRAPHEMES, type TemplateId, type TemplateMotion, type TemplatePlan } from "./types.ts";

export const TEMPLATE_LIMITS = { maxHeight: 4096, maxGraphemes: TEMPLATE_MAX_GRAPHEMES, fps: 30, typingMaxMs: 4200, holdMs: 1200 } as const;
/** GIF/MP4 content taller than the frame scrolls through it (the frame never
 * grows): a still start, an eased scroll at
 * `pxPerS` (faster when it would exceed `maxMs`), and a still end. */
export const TEMPLATE_SCROLL = { pxPerS: 120, startMs: 900, minMs: 1500, maxMs: 12000, endMs: 1500 } as const;
const SIZES = [24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 80, 96, 112, 128, 144, 160] as const;
/** A layout's canvas: `height` is the minimum canvas height (content may grow
 * it); `fit` is the height templates size their type against. Fixed frames use
 * the frame height for both; the automatic frame fits against a square and
 * starts the canvas at a per-template minimum so it hugs the content. */
interface View { width: number; height: number; fit: number }
/** The automatic image frame, as tokens. */
export const AUTO_FRAME = {
  widths: [1080, 1440, 1920],
  /** Minimum height / width, so a short text is not a thin strip. */
  minRatio: { text: 0.75, stat: 0.75, quote: 0.6 } as Partial<Record<TemplateId, number>>,
  defaultMinRatio: 0.5,
  /** Content that starts wider: tables with this many columns, code lines this long. */
  wideTableColumns: 4, wideCodeLine: 56,
} as const;
/** The text template's styles as tokens, so a redesign changes numbers here,
 * not layout code. Sizes are clamped to SIZES (the measurer's baked sizes). */
export const TEXT_STYLES = {
  /** Paper: quiet page, left-aligned, regular weight. */
  classic: { background: "#f3efe6", ink: "#27241f", accent: "#b4532f", accentBold: true, bold: false, align: "left", margin: 104, minSize: 36, maxSize: 96, leading: 1.42, rule: false },
  /** Ink: dark ground, centered, bold. */
  editorial: { background: "#17201e", ink: "#f2ede1", accent: "#e7c06d", accentBold: false, bold: true, align: "center", margin: 112, minSize: 36, maxSize: 112, leading: 1.36, rule: true },
  /** Poster: loud color, big tight type. */
  poster: { background: "#e5482e", ink: "#fff6e8", accent: "#1d1a16", accentBold: false, bold: true, align: "left", margin: 96, minSize: 40, maxSize: 160, leading: 1.14, rule: false },
} as const;

/** Diagram styles as tokens, like TEXT_STYLES. Pills (Mermaid `([ ])`, `(( ))`,
 * arrow-chain ends are not special) take the accent; diamonds are decisions. */
export const DIAGRAM_STYLES = {
  /** Flow: light page, outlined white boxes, dark lines. */
  classic: { background: "#f3f1ec", nodeFill: "#ffffff", border: "#2f5d52", borderWidth: 3, radius: 16, text: "#1f2a28",
    decisionFill: "#fff6e3", decisionBorder: "#b8862f", accentFill: "#2f5d52", accentText: "#ffffff",
    line: "#5b6b66", lineWidth: 3, labelFill: "#f3f1ec", labelText: "#56645f", pad: 1, square: false },
  /** Blueprint: navy ground, light lines. */
  editorial: { background: "#13233a", nodeFill: "#1b3150", border: "#7fb3e6", borderWidth: 3, radius: 16, text: "#e8f1fb",
    decisionFill: "#243a5c", decisionBorder: "#f0c36a", accentFill: "#7fb3e6", accentText: "#10213a",
    line: "#7fb3e6", lineWidth: 3, labelFill: "#13233a", labelText: "#a9c7e6", pad: 1.35, square: true },
} as const;
/** Size tiers tried in order until the diagram fits the card's width. */
const DIAGRAM_TIERS = [
  { size: 56, labelSize: 36, nodeWidth: 440, padX: 40, padY: 26, minWidth: 160, rankGap: 96, nodeGap: 72, arrow: 30 },
  { size: 48, labelSize: 32, nodeWidth: 400, padX: 34, padY: 22, minWidth: 140, rankGap: 88, nodeGap: 64, arrow: 28 },
  { size: 40, labelSize: 28, nodeWidth: 360, padX: 30, padY: 20, minWidth: 120, rankGap: 80, nodeGap: 56, arrow: 26 },
  { size: 32, labelSize: 24, nodeWidth: 320, padX: 26, padY: 18, minWidth: 100, rankGap: 72, nodeGap: 48, arrow: 22 },
  { size: 28, labelSize: 24, nodeWidth: 260, padX: 22, padY: 16, minWidth: 84, rankGap: 64, nodeGap: 36, arrow: 20 },
  { size: 24, labelSize: 24, nodeWidth: 200, padX: 16, padY: 12, minWidth: 64, rankGap: 56, nodeGap: 24, arrow: 18 },
] as const;

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
        // Break after a space, but never give up more than half the line for
        // one: in mixed Chinese and Latin text the last space can be far back.
        const floor = start + Math.ceil(count / 2) - 1;
        for (let i = start + count - 1; i > start && i >= floor; i--) {
          if (/\s/u.test(glyphs[i]!.text) && firstVisible >= 0 && firstVisible < i) { count = i - start + 1; break; }
        }
        // Still inside a word (unspaced scripts): back up to the nearest word
        // start, keeping at least half the line.
        if (!starts.has(start + count) && !/\s/u.test(glyphs[start + count - 1]!.text)) {
          for (let i = start + count - 1; i >= start + Math.ceil(count / 2); i--) {
            if (starts.has(i)) { count = i - start; break; }
          }
        }
      }
      if (start + count < end) count = kinsoku(glyphs, start, count);
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

/** Pure layout: fonts supply real advances in production, a metric fixture in unit tests. */
export function layoutTemplate(plan: TemplatePlan, measure: TemplateMeasure): TemplateLayout {
  if (plan.template !== plan.content.kind) throw new ComposeError("catalog", "Template and structured content do not match.");
  if (!templateHasVariant(plan.template, plan.variant)) throw new ComposeError("catalog", "Unknown template variant.");
  if (plan.aspect !== "auto") {
    const frame = FRAMES[plan.aspect];
    if (!frame) throw new ComposeError("catalog", "Unknown card frame.");
    return layoutAt(plan, measure, { ...frame, fit: frame.height });
  }
  // Automatic: the narrowest width tier the content allows, trying wider ones
  // when it overflows; the canvas starts at the template's minimum height.
  const widths = AUTO_FRAME.widths.filter((w) => w >= autoWidth(plan));
  let last: unknown;
  for (const width of widths) {
    const minRatio = AUTO_FRAME.minRatio[plan.template] ?? AUTO_FRAME.defaultMinRatio;
    try { return layoutAt(plan, measure, { width, height: Math.round(width * minRatio / 2) * 2, fit: width }); }
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
  const wide = (content.kind === "table" && content.headers.length >= AUTO_FRAME.wideTableColumns)
    || (content.kind === "code" && content.code.split("\n").some((line) => graphemes(line).length > AUTO_FRAME.wideCodeLine))
    || (content.kind === "diagram" && (content.direction === "LR" || content.direction === "RL"));
  return AUTO_FRAME.widths[wide ? 1 : 0]!;
}

function layoutAt(plan: TemplatePlan, measure: TemplateMeasure, view: View): TemplateLayout {
  const editorial = plan.variant === "editorial";
  const W = view.width, margin = 88, inner = W - margin * 2;
  const layout: TemplateLayout = { width: W, height: view.height, background: "#f1eee7", lines: [], shapes: [], images: [], assets: {} };
  let bottom = margin, group = 0;
  const rect = (x: number, y: number, width: number, height: number, color: string, radius = 0): TemplateRect => {
    const value = { x, y, width, height, color, radius }; layout.shapes.push(value); return value;
  };
  const block = (text: string, x: number, y: number, width: number, size = 40, bold = false, color = "#20272b", align: "left" | "center" = "left", groupID = group++, markdown = plan.template === "document", code = plan.template === "code"): number => {
    const normalized = normalizeText(text, code ? "code" : "plain");
    const lines = wrapStyled(styledGlyphs(normalized, bold, markdown), width, size, measure);
    const height = Math.ceil(measure.lineHeight(size, bold) * 1.30);
    for (const [index, line] of lines.entries()) {
      const advance = styledWidth(line, size, measure);
      layout.lines.push({ text: line.map((g) => g.text).join(""), x: x + (align === "center" ? (width - advance) / 2 : 0), y: y + index * height,
        width: advance, size, height, bold, color, group: groupID, boldAt: line.map((g) => g.bold),
        ...(line.some((g) => g.color) ? { colorAt: line.map((g) => g.color) } : {}) });
    }
    bottom = Math.max(bottom, y + lines.length * height);
    return lines.length * height;
  };
  const rule = (x: number, y: number, width: number, color = "#d9d4c9") => rect(x, y, width, 2, color);
  const content = plan.content;
  switch (content.kind) {
    case "text": {
      const style = TEXT_STYLES[plan.variant as keyof typeof TEXT_STYLES] ?? TEXT_STYLES.classic;
      layout.background = style.background;
      const source = content.paragraphs.join("\n\n");
      const accentAt = accentMask(source, plan.emphasis);
      const glyphs = graphemes(normalizeText(source, "plain")).map((text, i) => ({ text, bold: style.bold || (accentAt[i] === true && style.accentBold), ...(accentAt[i] ? { color: style.accent } : {}) }));
      const boxW = W - style.margin * 2, boxH = view.fit - style.margin * 2;
      const lineH = (size: number) => Math.ceil(measure.lineHeight(size, style.bold) * style.leading);
      const heightAt = (lines: StyledGlyph[][], size: number) => lines.length * lineH(size) - (lineH(size) - measure.lineHeight(size, style.bold));
      // The largest size whose wrapped text fits the box; smaller text may grow the canvas.
      let size: number = style.minSize, lines = wrapStyled(glyphs, boxW, size, measure);
      for (const candidate of [...SIZES].reverse()) {
        if (candidate > style.maxSize || candidate < style.minSize) continue;
        const wrapped = wrapStyled(glyphs, boxW, candidate, measure);
        if (heightAt(wrapped, candidate) <= boxH) { size = candidate; lines = wrapped; break; }
      }
      // Balance: the narrowest measure that keeps the same number of lines.
      let lo = Math.floor(boxW * 0.5), hi = boxW;
      while (hi - lo > 8) {
        const mid = Math.floor((lo + hi) / 2);
        let trial: StyledGlyph[][] | undefined;
        try { trial = wrapStyled(glyphs, mid, size, measure); } catch { trial = undefined; }
        if (trial && trial.length <= lines.length) hi = mid; else lo = mid;
      }
      const measureW = hi;
      lines = wrapStyled(glyphs, measureW, size, measure);
      const total = heightAt(lines, size);
      const top = Math.max(style.margin, Math.round((view.height - total) / 2 - size * 0.08));
      const left = style.align === "center" ? (W - measureW) / 2 : style.margin;
      for (const [index, line] of lines.entries()) {
        const advance = styledWidth(line, size, measure);
        const x = style.align === "center" ? (W - advance) / 2 : left;
        layout.lines.push({ text: line.map((g) => g.text).join(""), x, y: top + index * lineH(size), width: advance, size, height: lineH(size),
          bold: style.bold, color: style.ink, group: group++, boldAt: line.map((g) => g.bold),
          ...(line.some((g) => g.color) ? { colorAt: line.map((g) => g.color) } : {}) });
      }
      if (style.rule) rect(style.align === "center" ? W / 2 - 40 : left, top + total + Math.round(size * 0.6), 80, 6, style.accent);
      bottom = top + total + (style.rule ? Math.round(size * 0.6) + 6 : 0);
      break;
    }
    case "diagram": {
      const style = DIAGRAM_STYLES[plan.variant as keyof typeof DIAGRAM_STYLES] ?? DIAGRAM_STYLES.classic;
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
        const geometry = layoutDiagram(content, boxFor, { rankGap: Math.round(tier.rankGap * (horizontal ? 0.7 : 1)), nodeGap: tier.nodeGap, labelGap: 12, dummyWidth: 8 }, labelBox);
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
          const lh = Math.ceil(measure.lineHeight(tier.labelSize, false) * 1.2);
          const lw = Math.max(...lines.map((line) => styledWidth(line, tier.labelSize, measure)));
          const cx = ox + routed.label.x, cy = oy + routed.label.y;
          const verticalRun = routed.points.length > 1 && routed.points[0]!.x === routed.points[1]!.x;
          const bx = routed.label.beside ? (verticalRun ? cx + 12 : cx - (lw + 20) / 2) : cx - (lw + 20) / 2;
          const by = routed.label.beside ? (verticalRun ? cy - (lines.length * lh + 10) / 2 : cy - lines.length * lh - 18) : cy - (lines.length * lh + 10) / 2;
          rect(bx, by, lw + 20, lines.length * lh + 10, style.labelFill, 8).group = group;
          lines.forEach((line, i) => {
            const advance = styledWidth(line, tier.labelSize, measure);
            layout.lines.push({ text: line.map((g) => g.text).join(""), x: bx + 10 + (lw - advance) / 2, y: by + 5 + i * lh, width: advance, size: tier.labelSize, height: lh,
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
        const lh = Math.ceil(measure.lineHeight(tier.size, false) * 1.25);
        const top = y + (h - box.lines.length * lh) / 2;
        box.lines.forEach((line, i) => {
          const advance = styledWidth(line, tier.size, measure);
          layout.lines.push({ text: line.map((g) => g.text).join(""), x: x + (w - advance) / 2, y: top + i * lh, width: advance, size: tier.size, height: lh,
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
      layout.background = editorial ? "#e9edf0" : "#ede9df";
      const paper = rect(margin - 24, margin - 24, inner + 48, 0, "#fffdf8", 8);
      let x = margin + 24, width = inner - 48, y = margin + 32;
      if (editorial) {
        rect(margin + 12, margin + 28, 9, 140, "#31584d");
        block("01", margin + 40, margin + 16, 150, 80, true, "#31584d");
        block("NOTES", margin + 40, margin + 132, 150, 24, true, "#697870");
        x = margin + 236; width = inner - 260;
      } else {
        block("NOTES", x, y, width, 24, true, "#687068");
        y += 62; rule(x, y, width); y += 40;
      }
      const blocks = content.blocks ?? content.paragraphs.map((text) => ({ kind: "paragraph" as const, text }));
      for (const [index, item] of blocks.entries()) {
        if (item.kind === "heading") {
          y += block(item.text, x, y, width, item.level === 1 ? 56 : item.level === 2 ? 48 : 40, true, "#253e35");
        } else if (item.kind === "code") {
          const h = block(item.code, x + 24, y + 24, width - 48, 28, false, "#dde8f1", "left", group++, false, true);
          rect(x, y, width, h + 48, "#243440", 8); y += h + 48;
        } else if (item.kind === "list") {
          for (const [i, entry] of item.items.entries()) {
            block(item.ordered ? `${i + 1}.` : "·", x + 4, y, 52, 36, true, "#447061");
            y += block(entry, x + 62, y, width - 62, 36) + 16;
          }
        } else y += block(item.text, x, y, width, editorial && index === 0 ? 56 : 40, editorial && index === 0);
        y += editorial ? 38 : 30;
      }
      paper.height = Math.max(view.height - margin * 2 + 48, y - paper.y + 20);
      bottom = Math.max(bottom, paper.y + paper.height - margin);
      break;
    }
    case "quote": {
      layout.background = editorial ? "#182c2b" : "#eee9de";
      const ink = editorial ? "#fcf5df" : "#302d27";
      let y = margin + (editorial ? 34 : 96);
      if (editorial) {
        block("“", margin, y - 34, 180, 160, true, "#badc9a");
        y += 170;
        y += block(content.text, margin + 12, y, inner - 24, 72, true, ink);
        y += 56; rect(margin + 12, y, 112, 8, "#badc9a"); y += 38;
      } else {
        rect(margin, margin, 8, Math.max(300, view.height - margin * 2), "#b7a789");
        block("“", margin + 40, margin - 8, 130, 128, false, "#a38962");
        y += block(content.text, margin + 64, y, inner - 100, 48, false, ink);
        y += 48;
      }
      if (content.author) y += block("— " + content.author, margin + (editorial ? 12 : 64), y, inner - 100, 28, false, editorial ? "#badc9a" : "#7a6d56");
      bottom = y;
      break;
    }
    case "code": {
      layout.background = editorial ? "#edf0eb" : "#121c28";
      const panel = rect(margin - 24, margin - 24, inner + 48, 0, editorial ? "#fffefa" : "#202d3d", 18);
      let y = margin + 32;
      if (!editorial) {
        ["#d47d79", "#d9b86f", "#80b19a"].forEach((color, i) => rect(margin + 12 + i * 30, y, 14, 14, color, 7));
        y += 55;
      } else {
        block(content.language || "CODE", margin + 20, y, inner - 40, 28, true, "#447061");
        y += 62; rule(margin + 20, y, inner - 40); y += 28;
      }
      const sourceLines = normalizeText(content.code, "code").split("\n");
      for (const [index, line] of sourceLines.entries()) {
        const start = y;
        if (editorial) block(String(index + 1).padStart(2, "0"), margin + 16, y, 70, 28, false, "#8b9890");
        y += block(line, margin + (editorial ? 112 : 24), y, inner - (editorial ? 144 : 48), 32, false, editorial ? "#253e35" : "#dce7f1");
        if (editorial && index % 2 === 0) rect(margin + 100, start, inner - 120, y - start, "#f0f3ed", 4);
        y += 8;
      }
      panel.height = Math.max(260, y - panel.y + 34);
      bottom = panel.y + panel.height;
      break;
    }
    case "stat": {
      layout.background = editorial ? "#e7edeb" : "#f4f0e4";
      if (editorial) {
        const valueWidth = Math.round(inner * 0.42);
        const panel = rect(margin - 12, margin + 72, valueWidth + 36, 0, "#264e44", 12);
        const vh = block(content.value, margin + 12, margin + 110, valueWidth - 12, 128, true, "#d9edb5");
        const lh = block(content.label, margin + valueWidth + 64, margin + 114, inner - valueWidth - 64, 44, false, "#29453c");
        panel.height = Math.max(360, vh + 100, lh + 100);
        bottom = panel.y + panel.height;
      } else {
        let size = 160;
        for (const candidate of [160, 144, 128, 112, 96, 80]) { size = candidate; if (measure.width(content.value, size, true) <= inner) break; }
        let y = margin + 130;
        y += block(content.value, margin, y, inner, size, true, "#285b49", "center");
        y += 50; rect(W / 2 - 48, y, 96, 6, "#c4a66a"); y += 52;
        y += block(content.label, margin + 72, y, inner - 144, 44, false, "#4b5145", "center");
        bottom = y;
      }
      break;
    }
    case "list": {
      layout.background = editorial ? "#e9eef1" : "#faf7ef";
      let y = margin + 24;
      for (const [index, item] of content.items.entries()) {
        if (editorial) {
          const h = block(item, margin + 144, y + 30, inner - 184, 40, index === 0, "#243840");
          rect(margin, y, inner, h + 60, "#ffffff", 14);
          block(String(index + 1).padStart(2, "0"), margin + 28, y + 22, 94, 56, true, "#4c7980");
          y += h + 84;
        } else {
          if (content.ordered) block(String(index + 1) + ".", margin + 4, y + 4, 80, 40, true, "#aa7f4b");
          else { rect(margin + 4, y + 14, 26, 26, "#ad9470", 5); rect(margin + 9, y + 19, 16, 16, "#faf7ef", 2); }
          y += block(item, margin + 88, y, inner - 100, 44);
          y += 24; rule(margin + 88, y, inner - 100); y += 30;
        }
      }
      bottom = y;
      break;
    }
    case "chat": {
      layout.background = editorial ? "#fbf7ef" : "#e9eff0";
      let y = margin;
      const speakers = [...new Set(content.turns.map((turn) => turn.speaker))];
      for (const turn of content.turns) {
        if (editorial) {
          let speakerHeight = block(turn.speaker, margin, y + 20, 200, 28, true, "#547b70");
          if (turn.time) speakerHeight += 6 + block(turn.time, margin, y + 26 + speakerHeight, 200, 24, false, "#8a9a93");
          const textHeight = block(turn.text, margin + 242, y + 18, inner - 242, 40);
          rule(margin, y, inner, "#b9c6ba");
          y += Math.max(speakerHeight, textHeight) + 60;
        } else {
          const right = speakers.indexOf(turn.speaker) % 2 === 1;
          const bubbleW = Math.round(inner * 0.83), x = right ? W - margin - bubbleW : margin;
          const bubble = rect(x, y, bubbleW, 0, right ? "#244c44" : "#ffffff", 26);
          let top = y + 24;
          top += block(turn.speaker, x + 28, top, bubbleW - 56, 24, true, right ? "#b3d4c4" : "#6c837e");
          if (turn.time) top += 2 + block(turn.time, x + 28, top + 2, bubbleW - 56, 24, false, right ? "#8fb3a3" : "#95a5a1");
          top += 12;
          top += block(turn.text, x + 28, top, bubbleW - 56, 40, false, right ? "#ffffff" : "#263c3a");
          bubble.height = top - y + 26; y = top + 48;
        }
      }
      bottom = y;
      break;
    }
    case "table": {
      if (!content.headers.length || content.headers.length > 6 || content.rows.some((row) => row.length !== content.headers.length)) {
        throw new ComposeError("overflow", "A table needs 1–6 columns and the same number of cells in every row.");
      }
      layout.background = editorial ? "#f2ede2" : "#e8eff0";
      let y = margin;
      if (editorial) {
        for (const [rowIndex, row] of content.rows.entries()) {
          block(String(rowIndex + 1).padStart(2, "0"), margin, y + 8, 100, 48, true, "#ad8260");
          let rowY = y + 10;
          for (const [index, cell] of row.entries()) {
            const hh = block(content.headers[index]!, margin + 130, rowY, Math.round(inner * 0.28), 28, true, "#7a705f");
            const vh = block(cell, margin + Math.round(inner * 0.43), rowY, Math.round(inner * 0.57), 36);
            rowY += Math.max(hh, vh) + 22;
          }
          y = rowY + 12; rule(margin, y, inner, "#c5bda9"); y += 36;
        }
      } else {
        const col = inner / content.headers.length;
        for (const [rowIndex, row] of [content.headers, ...content.rows].entries()) {
          let rowHeight = 0;
          const rowY = y;
          for (const [index, cell] of row.entries()) rowHeight = Math.max(rowHeight,
            block(cell, margin + index * col + 20, y + 24, col - 40, rowIndex === 0 ? 32 : 28, rowIndex === 0, rowIndex === 0 ? "#ffffff" : "#263c3b"));
          rowHeight += 48;
          rect(margin, y, inner, rowHeight, rowIndex === 0 ? "#315c59" : rowIndex % 2 ? "#ffffff" : "#f3f7f5");
          for (let i = 1; i < content.headers.length; i++) rect(margin + i * col, rowY, 1, rowHeight, "#d5dfda");
          y += rowHeight;
        }
      }
      bottom = y;
      break;
    }
    case "comparison": {
      if (content.columns.length !== 2) throw new ComposeError("catalog", "Comparison templates require exactly two columns.");
      layout.background = editorial ? "#f5f1e8" : "#e9eef0";
      let y = margin;
      const width = editorial ? inner : (inner - 32) / 2;
      const heights: number[] = [];
      for (const [index, column] of content.columns.entries()) {
        const x = editorial ? margin : margin + index * (width + 32);
        const top = editorial ? y : margin;
        const panel = rect(x, top, width, 0, index === 0 ? "#ffffff" : "#244c44", 16);
        const color = index === 0 ? "#253e35" : "#f0f7e9";
        let cy = top + 32;
        if (editorial) {
          const titleH = block(column.title, x + 28, cy, 220, 44, true, color);
          let bodyY = cy;
          for (const item of column.items) { bodyY += block(item, x + 300, bodyY, width - 332, 36, false, color) + 24; }
          cy += Math.max(titleH, bodyY - cy);
        } else {
          cy += block(column.title, x + 30, cy, width - 60, 44, true, color) + 32;
          for (const item of column.items) { cy += block(item, x + 30, cy, width - 60, 36, false, color) + 30; }
        }
        panel.height = Math.max(230, cy - top + 20); heights.push(panel.height);
        if (editorial) y = top + panel.height + 28;
      }
      if (!editorial) {
        const maxH = Math.max(...heights);
        // The two panels align at the bottom while retaining independent text.
        layout.shapes.slice(-2).forEach((shape) => { shape.height = maxH; });
        bottom = margin + maxH;
      } else bottom = y;
      break;
    }
  }
  const count = layout.lines.reduce((total, line) => total + graphemes(line.text).length, 0);
  if (!count || !plan.sourceText.trim()) throw new ComposeError("empty", "There is no text to render.");
  if (count > TEMPLATE_LIMITS.maxGraphemes) throw new ComposeError("overflow", `This template contains ${count} characters; the supported maximum is ${TEMPLATE_LIMITS.maxGraphemes}. Split the source into smaller cards. No content was truncated.`);
  layout.height = Math.ceil(Math.max(view.height, bottom + margin) / 2) * 2;
  if (layout.height > TEMPLATE_LIMITS.maxHeight) throw new ComposeError("overflow", `The complete content needs ${layout.height}px of height (maximum ${TEMPLATE_LIMITS.maxHeight}px). Choose a wider aspect or split the source. No content was truncated.`);
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

interface EngineMeasurer {
  measure(size: number, bold?: boolean): (text: string) => number;
  lineHeight(size: number, bold?: boolean): number;
  unmapped(text: string, size: number, bold?: boolean): string[];
  close(): Promise<void>;
}

export async function composeTemplate(plan: TemplatePlan, options: ComposeOptions): Promise<TemplateComposeResult> {
  const script = unsupportedScript(plan.sourceText);
  if (script) throw new ComposeError("unsupported-script", `The card font does not support ${script}; no content was rendered or truncated.`);
  const work = resolve(options.work), dir = `${work}/compositions/paste`;
  await mkdir(dir, { recursive: true });
  const api = await import(`${options.engine}/src/text/measure.ts`) as { openMeasurer(options: unknown): Promise<EngineMeasurer> };
  const serialized = JSON.stringify(plan.content);
  const texts = [stripEmoji(serialized), "NOTES CODE 0123456789.—“·"];
  const m = await api.openMeasurer({
    face: { regular: `${options.engine}/assets/fonts/NotoSansSC-Regular.otf`, bold: `${options.engine}/assets/fonts/NotoSansSC-Bold.otf` },
    sizes: SIZES.flatMap((px) => [{ px, bold: false }, { px, bold: true }]), texts, density: 1,
    cache: { charset: await Bun.file(new URL("../render/charset.txt", import.meta.url)).text(), dir: `${work}/dist/.measure` },
  });
  try {
    for (const text of texts) {
      const missing = m.unmapped(text, 40, false);
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
    for (const [i, shape] of layout.shapes.entries()) nodes.push(`<View class="absolute left-[${shape.x}px] top-[${shape.y}px] w-[${shape.width}px] h-[${shape.height}px] bg-[${shape.color}] rounded-[${shape.radius}px]${shapeAnimation(`s${i}`, shape.group)}" />`);
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
    await Bun.write(`${dir}/pocket-motion.json`, JSON.stringify({ motion: 1, durationFrames: timing.frames, fps: TEMPLATE_LIMITS.fps, supersample: 1,
      fonts: { regular: "assets/fonts/NotoSansSC-Regular.otf", bold: "assets/fonts/NotoSansSC-Bold.otf" } }, null, 2));
    await Bun.write(`${dir}/pocket.json`, JSON.stringify({ $schema: "https://pocketjs.dev/schema/pocket-2.json", pocket: 2,
      id: "dev.pocket-stack.motion-paste", name: "pocketjs-motion-paste", title: `${plan.template} ${plan.variant}`, version: "0.0.0",
      engine: { capabilities: { requires: ["text.glyphs.baked"] } },
      app: { entry: "compositions/paste/main.tsx", output: "motion-paste", framework: "solid", viewport: { fixed: { logical: [layout.width, frameHeight], presentation: "native" } } } }, null, 2));
    await Bun.write(`${dir}/template-layout.json`, JSON.stringify({ template: plan.template, variant: plan.variant, width: layout.width, height: layout.height, frameHeight, scroll,
      lines: layout.lines.map(({ text: _text, ...geometry }) => geometry), timing: { frames: timing.frames, revealMs: timing.revealMs, holdMs: timing.holdMs } }, null, 2));
    return { dir, lines: layout.lines.length, size: Math.max(...layout.lines.map((line) => line.size)), frames: timing.frames,
      emoji: emoji.length, truncated: false, width: layout.width, height: frameHeight, template: plan.template, variant: plan.variant, motion: plan.motion, scroll };
  } finally { await m.close(); }
}
