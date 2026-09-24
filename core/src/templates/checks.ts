/**
 * Automated quality checks on a composed template layout: the publish gate a
 * future declarative template format would have to pass (docs/template-spec.md).
 *
 * - `size`: text below the phone readability floor (READABILITY).
 * - `overflow`: a line outside the canvas.
 * - `overlap`: two text lines drawn over each other.
 * - `contrast`: text against the ground or shape beneath it below WCAG AA
 *   (over a colour-field backdrop: the field's colour at the top, middle and
 *   bottom of the line, so the lightest part under it counts).
 * - `untraceable`: drawn text that is not in the source (generated numbers
 *   and the user's signature aside).
 * - `missing`: a source grapheme that is never drawn (a truncation).
 *
 * Pure: it reads the layout and the plan and never draws or throws.
 * composeTemplate throws on the fatal kinds and logs the others.
 */
import { normalizeText } from "../render/compose.ts";
import { READABILITY, type TemplateContent, type TemplatePlan } from "./types.ts";
import { fieldColorAt, type ColourField } from "./backdrop.ts";

/** Every threshold the checks use. */
export const CHECK_THRESHOLDS = {
  /** Effective px (size × phoneWidth / canvas width) for body and secondary text. */
  readability: READABILITY,
  /** WCAG 2.x AA: 4.5:1 for body text, 3:1 for large text (≥ `largeSize` px at the reference width). */
  contrast: { body: 4.5, large: 3, largeSize: 48 },
  /** Pixels a line may cross the canvas edge (sub-pixel centring). */
  overflowTolerance: 0.5,
  /** Pixels two line boxes may share before they overlap. */
  overlapTolerance: 1,
} as const;

export type CheckKind = "size" | "overflow" | "overlap" | "contrast" | "untraceable" | "missing";
/** Overflow, text the source did not say and source text left out never ship; the rest is logged. */
export const FATAL_CHECKS: readonly CheckKind[] = ["overflow", "untraceable", "missing"];

export interface CheckViolation {
  readonly kind: CheckKind;
  /** Index into layout.lines, when the violation is about one line. */
  readonly line?: number;
  /** A description without source text (it may be logged). */
  readonly message: string;
}

/** The subset of a layout the checks read (compose.ts's TemplateLayout satisfies it). */
export interface CheckedLine {
  readonly text: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly size: number;
  readonly color: string; readonly colorAt?: readonly (string | undefined)[];
  readonly secondary?: boolean; readonly signature?: boolean; readonly generated?: boolean;
}
export interface CheckedShape {
  readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly color: string;
  readonly gradient?: { readonly from: string; readonly to: string };
}
/** An image; only colour-field backdrops take part (they are ground, never text). */
export interface CheckedImage { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly field?: ColourField }
export interface CheckedLayout {
  readonly width: number; readonly height: number; readonly background: string;
  readonly lines: readonly CheckedLine[]; readonly shapes: readonly CheckedShape[];
  /** Colour-field backdrops lie under every shape (compose.ts draws them first). */
  readonly images?: readonly CheckedImage[];
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text: string): string[] => [...segmenter.segment(text)].map((part) => part.segment);
/** Document text is Markdown: the layout draws `**bold**` without its markers. */
const stripBold = (text: string) => text.replace(/\*\*([^*\n]+)\*\*/g, "$1");

/** Every string of the content a layout may draw, normalized as the layout draws it. */
export function contentStrings(content: TemplateContent): string[] {
  const plain = (text: string) => normalizeText(text, "plain");
  switch (content.kind) {
    case "text": return content.paragraphs.map(plain);
    case "document": return content.blocks
      ? content.blocks.flatMap((b) => b.kind === "list" ? b.items.map((i) => stripBold(plain(i))) : b.kind === "code" ? [normalizeText(b.code, "code")] : [stripBold(plain(b.text))])
      : content.paragraphs.map((p) => stripBold(plain(p)));
    case "quote": return [content.text, ...(content.author ? [content.author] : [])].map(plain);
    case "code": return [normalizeText(content.code, "code"), ...(content.language ? [plain(content.language)] : [])];
    case "stat": return [content.value, content.label].map(plain);
    case "list": return content.items.map(plain);
    case "chat": return content.turns.flatMap((t) => [t.speaker, t.text, ...(t.time ? [t.time] : [])]).map(plain);
    case "table": return [...content.headers, ...content.rows.flat()].map(plain);
    case "comparison": return content.columns.flatMap((c) => [c.title, ...c.items]).map(plain);
    case "diagram": return [...content.nodes.map((n) => n.label), ...content.edges.flatMap((e) => (e.label ? [e.label] : []))].map(plain);
    case "info": return [...(content.title ? [content.title] : []), ...content.fields.flatMap((f) => [...(f.label ? [f.label] : []), f.value])].map(plain);
    case "changelog": return [...(content.title ? [content.title] : []), ...content.releases.flatMap((r) => [r.version, ...(r.date ? [r.date] : []),
      ...r.sections.flatMap((s) => [...(s.title ? [s.title] : []), ...s.items.map((i) => stripBold(i))])])].map(plain);
    case "terminal": return content.lines.map((line) => normalizeText(line.kind === "prompt" ? line.prompt + line.command : line.text, "code"));
    case "diff": return content.files.flatMap((f) => [...(f.path ? [f.path] : []), ...(f.oldPath ? [f.oldPath] : []), ...f.meta,
      ...f.hunks.flatMap((h) => [h.header, ...h.lines.map((l) => l.text)])]).map((text) => normalizeText(text, "code"));
    case "error": return [...[content.lead, content.type, content.message].filter((t): t is string => Boolean(t)), ...content.trace.map((l) => l.text)].map((text) => normalizeText(text, "code"));
    case "timeline": return [...(content.title ? [content.title] : []), ...content.events.flatMap((e) => [e.time, e.text])].map(plain);
    case "stats": return [...(content.title ? [content.title] : []), ...content.metrics.flatMap((m) => [m.label, m.value, ...(m.delta ? [m.delta] : [])])].map(plain);
    case "qr": return [plain(content.data)];
  }
}

/** The largest number a layout may draw on its own: ordered-list numbers and code line numbers count from 1; a diff counts its lines. */
export function generatedNumberLimit(content: TemplateContent): number {
  if (content.kind === "list") return content.ordered ? content.items.length : 0;
  if (content.kind === "document") return Math.max(0, ...(content.blocks ?? []).map((b) => (b.kind === "list" && b.ordered ? b.items.length : 0)));
  if (content.kind === "code") return normalizeText(content.code, "code").split("\n").length;
  // A diff's "+N −M" summary: the counted added and removed lines.
  if (content.kind === "diff") return Math.max(...(["add", "del"] as const).map((type) => diffCount(content, type)));
  return 0;
}

/** Added or removed lines of a diff, over all its files. */
export function diffCount(content: Extract<TemplateContent, { kind: "diff" }>, type: "add" | "del"): number {
  return content.files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.filter((l) => l.type === type).length, 0), 0);
}

/** Source fidelity alone: nothing drawn that the source did not say, and
 * every non-whitespace grapheme of it drawn at least as often as it occurs
 * (QR's caption is optional). Lines marked `generated` must be numbers in
 * range; `signature` lines are the user's and exempt. */
export function fidelityViolations(layout: CheckedLayout, plan: Pick<TemplatePlan, "content">): CheckViolation[] {
  const out: CheckViolation[] = [];
  const sources = contentStrings(plan.content), limit = generatedNumberLimit(plan.content);
  const drawn = new Map<string, number>();
  layout.lines.forEach((line, index) => {
    if (line.signature) return;
    const text = line.text.trim();
    if (line.generated) {
      if (text && !(/^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= limit)) out.push({ kind: "untraceable", line: index, message: `line ${index} is a generated label that is not a number from 1 to ${limit}` });
      return;
    }
    if (text && !sources.some((source) => source.includes(text))) out.push({ kind: "untraceable", line: index, message: `line ${index} (${graphemes(text).length} characters) is not in the source` });
    for (const glyph of graphemes(line.text)) if (glyph.trim()) drawn.set(glyph, (drawn.get(glyph) ?? 0) + 1);
  });
  if (plan.content.kind === "qr") return out;
  const needed = new Map<string, number>();
  for (const source of sources) for (const glyph of graphemes(source)) if (glyph.trim()) needed.set(glyph, (needed.get(glyph) ?? 0) + 1);
  let missing = 0;
  for (const [glyph, n] of needed) missing += Math.max(0, n - (drawn.get(glyph) ?? 0));
  if (missing) out.push({ kind: "missing", message: `${missing} source character${missing === 1 ? " is" : "s are"} not drawn` });
  return out;
}

/** WCAG relative luminance of #rgb, #rrggbb or #rrggbbaa (alpha ignored). */
export function luminance(color: string): number {
  let hex = color.replace(/^#/, "");
  if (hex.length === 3 || hex.length === 4) hex = [...hex.slice(0, 3)].map((c) => c + c).join("");
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The colours under a point: the topmost shape containing it (both ends of a gradient), else a
 * colour-field backdrop (sampled at y and `reach` above and below it), else the ground. */
function groundAt(layout: CheckedLayout, x: number, y: number, reach = 0): string[] {
  for (let i = layout.shapes.length - 1; i >= 0; i--) {
    const s = layout.shapes[i]!;
    if (x >= s.x && x <= s.x + s.width && y >= s.y && y <= s.y + s.height && s.height > 0 && s.width > 0) return s.gradient ? [s.gradient.from, s.gradient.to] : [s.color];
  }
  const images = layout.images ?? [];
  for (let i = images.length - 1; i >= 0; i--) {
    const f = images[i]!;
    if (!f.field || !(x >= f.x && x <= f.x + f.width && y >= f.y && y <= f.y + f.height && f.height > 0 && f.width > 0)) continue;
    const canvas = { width: f.width, height: f.height };
    return [y - reach, y, y + reach].map((py) => fieldColorAt(f.field!, canvas, x - f.x, Math.min(f.height, Math.max(0, py - f.y))));
  }
  return [layout.background];
}

/** Every check over one layout; `plan` enables the fidelity checks. */
export function checkLayout(layout: CheckedLayout, plan?: Pick<TemplatePlan, "content">): CheckViolation[] {
  const T = CHECK_THRESHOLDS, W = layout.width;
  const out: CheckViolation[] = [];
  const reference = T.readability.referenceWidth;
  layout.lines.forEach((line, index) => {
    if (!line.text.trim()) return;
    const effective = line.size * T.readability.phoneWidth / W, floor = line.secondary ? T.readability.secondary : T.readability.body;
    if (effective < floor - 1e-9) out.push({ kind: "size", line: index, message: `line ${index} is ${line.size}px on a ${W}px canvas, ${effective.toFixed(1)}px on a phone (floor ${floor})` });
    const tol = T.overflowTolerance;
    if (line.x < -tol || line.y < -tol || line.x + line.width > W + tol || line.y + line.height > layout.height + tol) {
      out.push({ kind: "overflow", line: index, message: `line ${index} runs outside the ${W}×${layout.height} canvas` });
    }
    const required = line.size * reference / W >= T.contrast.largeSize ? T.contrast.large : T.contrast.body;
    const colors = new Set([line.color, ...(line.colorAt ?? []).filter((c): c is string => Boolean(c))]);
    const mid = line.y + line.height / 2;
    const grounds = new Set([line.x + 1, line.x + line.width / 2, line.x + line.width - 1].flatMap((x) => groundAt(layout, x, mid, line.height / 2)));
    let worst = Infinity;
    for (const color of colors) for (const ground of grounds) worst = Math.min(worst, contrastRatio(color, ground));
    if (worst < required) out.push({ kind: "contrast", line: index, message: `line ${index} has ${worst.toFixed(2)}:1 against its ground (needs ${required}:1)` });
  });
  // Overlap: line boxes sorted by top; only neighbours that start above a box's bottom can meet it.
  const order = layout.lines.map((line, index) => ({ line, index })).filter(({ line }) => line.text.trim()).sort((a, b) => a.line.y - b.line.y);
  const tol = T.overlapTolerance;
  for (let i = 0; i < order.length; i++) {
    const a = order[i]!.line;
    for (let j = i + 1; j < order.length && order[j]!.line.y < a.y + a.height - tol; j++) {
      const b = order[j]!.line;
      const across = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const down = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (across > tol && down > tol) out.push({ kind: "overlap", line: order[j]!.index, message: `lines ${order[i]!.index} and ${order[j]!.index} overlap` });
    }
  }
  if (plan) out.push(...fidelityViolations(layout, plan));
  return out;
}
