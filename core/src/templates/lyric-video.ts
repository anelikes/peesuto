/**
 * Lyric motion, the video: cuts planned and laid out. Every cut is one
 * composition drawn from a vocabulary of about twenty (LYRIC_LAYOUTS): a
 * centred block, a giant word filling the frame, stacked words whose sizes
 * jump, a tilted band, split colour fields, vertical and horizontal CJK
 * together, hollow ghost repeats, a glyph that jumps in size, ink plates,
 * underline sweeps, a big numeral, an editorial corner caption, a word
 * cascade, a frame, tickers, a spaced line, a wave. A seeded planner draws the
 * layout, entrance, hold, transition and chromatic ghosts for each cut by the
 * style's weights (LYRICS_MOTION), the cut's length, its emphasis and what the
 * cuts before it used, so the same text always gives the same video and no
 * two neighbouring cuts look alike.
 *
 * Every layout keeps the guarantees of the other templates: the lyric is drawn
 * exactly once and verbatim (ghost repeats, tickers and numerals are
 * `decorative`: traceable but never counted), at or above the readability
 * floor, in colours that keep 4.5:1 against the ground under them; a layout
 * that cannot meet them for a cut is not used for it.
 *
 * Type the engine cannot draw (above ~176 px, turned, or growing) is set as a
 * type plate (type-raster.ts): the line keeps its place in the layout like any
 * other and is drawn as an image.
 */
import { join } from "node:path";
import { ComposeError, normalizeText } from "../render/compose.ts";
import { checkLayout, fidelityViolations, type CheckViolation } from "./checks.ts";
import { CODE_FONT_DIR, TEMPLATE_FACES, TEXT_FONT, type TemplateLayout, type TemplateLine, type TemplateMeasure, type TemplateRect } from "./compose.ts";
import { loadFace, missingGlyphs, plateMetrics, plateWidth, type Face } from "./type-raster.ts";
import {
  CORNER, cutSpecs, emphasisPaint, faceOf, fitDurations, generator, glyphsOf, graphemes, KANA, LYRIC_LAYOUTS, LYRICS_MOTION, LYRICS_TIMING, lyricsMaxMs, NO_LINE_START,
  pairCuts, seedOf, snapUp, Typesetter, verticalSafe, WIDE, cornerPunctuation,
  type Box, type CutSpec, type LyricDecorMotion, type LyricEntrance, type LyricHold, type LyricLayout, type LyricPalette, type LyricsContext, type LyricsCut,
  type LyricShapeMotion, type LyricShapeRole, type LyricsProgram, type LyricsResult, type LyricsStyle, type LyricTransition, type LyricDecor, type Row,
} from "./lyrics.ts";

type MotionStyle = LyricsStyle["motion"];
type Vocab = (typeof LYRICS_MOTION)[keyof typeof LYRICS_MOTION];

/* ───────────── Weighted choice ───────────── */
function weighted<K extends string>(random: () => number, weights: readonly (readonly [K, number])[]): K | undefined {
  const total = weights.reduce((n, [, w]) => n + Math.max(0, w), 0);
  if (total <= 0) return;
  let r = random() * total;
  for (const [key, w] of weights) { r -= Math.max(0, w); if (r <= 0) return key; }
  return weights.at(-1)![0];
}

export const unionBox = (boxes: readonly Box[]): Box => {
  const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width)), y1 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
};
const boxOf = (lines: readonly TemplateLine[]): Box => unionBox(lines.map((l) => ({ x: l.x, y: l.y, width: l.width, height: l.height })));

/** Visible length in "units": a CJK character is one, anything else a little over half. */
const units = (text: string) => graphemes(text).reduce((n, g) => n + (!g.trim() ? 0 : WIDE.test(g) ? 1 : 0.55), 0);

/* ───────────── The cut environment ───────────── */
interface Env {
  readonly ctx: LyricsContext;
  readonly t: Typesetter;
  readonly spec: CutSpec;
  readonly pal: LyricPalette;
  /** A second scheme with a different ground (split fields). */
  readonly pal2: LyricPalette;
  /** Where the lyric may go (inside the margins, clear of labels, notes and the footer). */
  readonly box: Box;
  readonly W: number; readonly H: number; readonly margin: number;
  readonly M: MotionStyle; readonly V: Vocab;
  /** The display face (engine name), and the face plates are drawn from. */
  readonly face?: string;
  readonly plate?: { readonly face: Face; readonly name?: string; readonly bold: boolean };
  /** Lyric weight when set in the card's pair (display faces have one weight). */
  readonly bold: boolean;
  readonly random: () => number;
  /** 1-based cut number. */
  readonly number: number;
  readonly sizes: readonly number[];
  /** Sizes above the engine's, set as plates (largest first); empty when plates cannot draw this cut. */
  readonly plateSizes: readonly number[];
}

/** Rows measured in the plate face, the baseline 0.96 em below the row top. (An instance, not a subclass: lyrics.ts and this module import each other.) */
export function plateSetter(face: Face, leading: number): Typesetter {
  const t = new Typesetter(plateMeasure(face), leading);
  t.base = (size: number) => Math.round(size * 0.96);
  return t;
}
const plateMeasure = (face: Face): TemplateMeasure => ({ width: (text, size) => plateWidth(face, text, size), lineHeight: (size) => Math.round(size * 1.12) });
/** Engine runs set by a PlateSetter, as one plate line per grapheme (gradient and outline paint kept; a glow is the engine's only). */
function toPlates(env: Env, lines: readonly TemplateLine[], setter: Typesetter): TemplateLine[] {
  return platesFrom(env.plate!, lines, setter);
}
/** The same, from a plate face alone (the poster). */
export function platesFrom(plate: NonNullable<Env["plate"]>, lines: readonly TemplateLine[], setter: Typesetter): TemplateLine[] {
  const env = { plate } as Env;
  const out: TemplateLine[] = [];
  for (const l of lines) {
    const baseline = l.y + setter.base(l.size);
    let pen = l.x;
    const paint = l.paint && (l.paint.gradient || l.paint.stroke) ? { ...(l.paint.gradient ? { gradient: l.paint.gradient } : {}), ...(l.paint.stroke && !l.paint.stroke.hollow ? { stroke: l.paint.stroke } : {}) } : undefined;
    for (const g of graphemes(l.text)) {
      const w = plateWidth(env.plate!.face, g, l.size);
      if (g.trim()) out.push(plateLine(env, g, pen, baseline, l.size, l.color, { group: l.group, ...(l.emphasis ? { emphasis: true } : {}), ...(paint && Object.keys(paint).length ? { paint } : {}), ...(l.secondary ? { secondary: true } : {}) }));
      pen += w;
    }
  }
  return out;
}

/** Grapheme ranges shifted into a slice [lo, hi) of a text. */
const shiftRanges = (ranges: readonly (readonly [number, number])[], lo: number, hi: number) =>
  ranges.map(([a, b]) => [Math.max(a, lo) - lo, Math.min(b, hi) - lo] as const).filter(([a, b]) => b > a);

/** A block of rows: the largest size that fits `box` in at most `maxRows` rows, arranged. */
interface Block { lines: TemplateLine[]; box: Box; size: number; align: "left" | "center" }
type Arrangement = "center" | "left" | "stack" | "top";
function setBlock(env: Env, spec: CutSpec, pal: LyricPalette, box: Box, arrangement: Arrangement, opts: { maxSize?: number; only?: number; strict?: boolean; maxRows?: number; plateInk?: boolean; plates?: boolean } = {}): Block | undefined {
  const { ctx, M } = env;
  const strict = opts.strict ?? true;
  const bold = env.face ? false : spec.kind === "title" || env.bold;
  const maxRows = opts.maxRows ?? M.maxRows;
  const drawable = env.plate && spec.segments.every((seg) => !missingGlyphs(env.plate!.face, normalizeText(seg.text, "plain")).length);
  const plateSizes = opts.plates === false || !drawable ? [] : env.plateSizes;
  const all = [...plateSizes, ...(spec.kind === "title" ? M.sizes.filter((n) => n <= M.title.size) : M.sizes)]
    .filter((n) => n >= ctx.minBody && n <= (opts.maxSize ?? Infinity) && (opts.only === undefined || n === opts.only));
  const stack = arrangement === "stack";
  const ink = opts.plateInk ? pal.plateInk : pal.ink, accent = opts.plateInk ? pal.plateInk : pal.accent;
  const setter = env.plate ? plateSetter(env.plate.face, M.leading) : undefined;
  for (const size of all) {
    const plate = plateSizes.includes(size);
    const t = plate ? setter! : env.t;
    const emph = plate || env.face ? size : snapUp(ctx.sizes, size * 1.2);
    const paint = opts.plateInk ? undefined : emphasisPaint(ctx.style.engine, pal, emph, ctx.width, ctx.format);
    const segments = spec.segments.map((seg) => t.tokens(glyphsOf(seg.text, seg.emphasis, size, emph, bold, ink, accent, paint, env.face)));
    const wrapAll = (width: number, split = true): Row[] | undefined => {
      const rows: Row[] = [];
      for (const tokens of segments) { const r = t.wrap(tokens, width, split); if (!r) return; rows.push(...r); }
      return rows;
    };
    let rows = wrapAll(stack ? Math.min(box.width, Math.max(box.width * 0.6, ...segments.flat().map((tk) => tk.width - tk.trail))) : box.width);
    if (!rows || rows.length > maxRows) continue;
    const height = rows.reduce((h, r) => h + r.height, 0);
    if (height > box.height) continue;
    if (stack && rows.length < 2) return setBlock(env, spec, pal, box, "center", opts);
    if (rows.length > segments.length) {
      let lo = Math.floor(box.width * 0.3), hi = Math.ceil(Math.max(...rows.map((r) => r.width)));
      while (hi - lo > 6) { const mid = Math.floor((lo + hi) / 2); const trial = wrapAll(mid, false); if (trial && trial.length <= rows.length) hi = mid; else lo = mid; }
      const balanced = wrapAll(hi, false);
      if (balanced && balanced.length === rows.length) rows = balanced;
    }
    const widest = Math.max(...rows.map((r) => r.width));
    if (strict && rows.length > 1 && rows.some((r) => r.width < widest * 0.3)) {
      if (stack) { const centred = setBlock(env, spec, pal, box, "center", { ...opts, only: size }); if (centred?.size === size) return centred; }
      continue;
    }
    const lines: TemplateLine[] = [];
    const top = arrangement === "left" ? box.y + Math.round((box.height - height) * 0.72) : arrangement === "top" ? box.y : box.y + Math.round((box.height - height) / 2);
    let y = top;
    for (const [k, row] of rows.entries()) {
      const x = arrangement === "center" ? box.x + Math.round((box.width - row.width) / 2)
        : stack ? Math.max(box.x, Math.min(box.x + box.width - row.width, k % 2 ? box.x + box.width - row.width - Math.round(box.width * 0.04 * (rows.length - k)) : box.x + Math.round(box.width * 0.04 * k)))
          : box.x;
      lines.push(...t.emit(row, x, y));
      y += row.height;
    }
    const x0 = Math.min(...lines.map((l) => l.x)), x1 = Math.max(...lines.map((l) => l.x + l.width));
    return { lines: plate ? toPlates(env, lines, t) : lines, box: { x: x0, y: top, width: Math.max(x1 - x0, arrangement === "center" ? widest : 0), height }, size, align: arrangement === "center" ? "center" : "left" };
  }
  return strict && opts.only === undefined ? setBlock(env, spec, pal, box, arrangement === "stack" ? "center" : arrangement, { ...opts, strict: false }) : undefined;
}

/** A cut's lyric in columns, right to left, centred in `box`; a phrase mark ends a column when one falls late enough. */
function setColumns(env: Env, spec: CutSpec, pal: LyricPalette, box: Box, maxColumns = 4): Block | undefined {
  const { ctx, M } = env;
  const glyphs = spec.segments.map((seg) => graphemes(normalizeText(seg.text, "plain")));
  const ranges = spec.segments.map((seg) => seg.emphasis);
  const phrases = glyphs.map((g) => {
    const out: { glyphs: string[]; from: number }[] = [];
    let from = 0;
    for (let i = 0; i < g.length; i++) if (/[，。、！？]/u.test(g[i]!) && !/[，。、！？]/u.test(g[i + 1] ?? "")) { out.push({ glyphs: g.slice(from, i + 1), from }); from = i + 1; }
    if (from < g.length) out.push({ glyphs: g.slice(from), from });
    return out;
  });
  const cells = (g: readonly string[]) => g.length - (CORNER.test(g.at(-1) ?? "") ? 0.5 : 0);
  const longest = Math.max(...phrases.flat().map((p) => cells(p.glyphs)));
  const drawable = env.plate && spec.segments.every((seg) => !missingGlyphs(env.plate!.face, normalizeText(seg.text, "plain")).length);
  const plates = drawable ? env.plateSizes : [];
  const sizes = [...plates, ...M.sizes.filter((n) => n >= ctx.minBody)];
  const bold = env.face ? false : env.bold;
  const whole = sizes.find((n) => longest * Math.round(n * 1.12) <= box.height);
  for (const size of whole !== undefined ? [whole, ...sizes.filter((n) => n < whole)] : sizes) {
    const plate = plates.includes(size);
    const pitch = Math.round(size * 1.12), advance = Math.round(size * 1.6);
    const per = Math.floor(box.height / pitch);
    if (per < 2) continue;
    const columns: { glyphs: string[]; from: number; seg: number }[] = [];
    for (const [s, list] of phrases.entries()) for (const phrase of list) {
      let rest = phrase.glyphs, from = phrase.from;
      if (cells(rest) * pitch <= box.height) { columns.push({ glyphs: rest, from, seg: s }); continue; }
      while (rest.length > per) {
        let cut = per;
        while (cut > 1 && NO_LINE_START.test(rest[cut]!)) cut--;
        columns.push({ glyphs: rest.slice(0, cut), from, seg: s }); rest = rest.slice(cut); from += cut;
      }
      if (rest.length) columns.push({ glyphs: rest, from, seg: s });
    }
    const width = columns.length * advance - (advance - size);
    if (width > box.width || columns.length > maxColumns) continue;
    const tallest = Math.ceil(Math.max(...columns.map((c) => cells(c.glyphs))) * pitch);
    const top = box.y + Math.round((box.height - tallest) / 2);
    let x = box.x + Math.round((box.width + width) / 2);
    const lines: TemplateLine[] = [];
    for (const column of columns) {
      const cx = x - size / 2;
      for (const [k, glyph] of column.glyphs.entries()) {
        if (!glyph.trim()) continue;
        const i = column.from + k, emph = ranges[column.seg]!.some(([a, b]) => i >= a && i < b);
        if (plate) {
          // A plate glyph centred in its cell; a comma or full stop in the cell's top-right quarter.
          const pw = plateWidth(env.plate!.face, glyph, size), cellTop = top + k * pitch;
          const corner = CORNER.test(glyph);
          lines.push(plateLine(env, glyph, corner ? cx + size * 0.08 : cx - pw / 2, Math.round(cellTop + (corner ? size * 0.32 : size * 0.9)), size, emph ? pal.accent : pal.ink, emph ? { emphasis: true } : {}));
          continue;
        }
        const w = ctx.measure.width(glyph, size, bold, env.face);
        const paint = emph ? emphasisPaint(ctx.style.engine, pal, size, ctx.width, ctx.format) : undefined;
        const line: TemplateLine = { text: glyph, x: cx - w / 2, y: top + k * pitch, width: w, size, height: pitch, bold, color: emph ? pal.accent : pal.ink, group: 0, boldAt: [bold],
          ...(emph ? { emphasis: true } : {}), ...(paint ? { paint } : {}), ...(env.face ? { face: env.face } : {}) };
        if (CORNER.test(glyph)) cornerPunctuation(line, cx, top + k * pitch, size);
        lines.push(line);
      }
      x -= advance;
    }
    return { lines, box: { x: box.x + Math.round((box.width - width) / 2), y: top, width, height: tallest }, size, align: "center" };
  }
  return;
}

/* ───────────── Plates ───────────── */
/** Lyric sizes above the engine's largest (1080 reference, scaled with the width): drawn as plates. */
export const PLATE_SIZES = [360, 312, 272, 240, 208, 184];
/** A plate line's box: the em box (0.88 em above the baseline, 0.12 below), where the ink of CJK and capitals sits. */
const PLATE_ASCENT = 0.88;
function plateLine(env: Env, text: string, x: number, baseline: number, size: number, color: string, extra: Partial<TemplateLine> = {}): TemplateLine {
  const p = env.plate!;
  const width = plateWidth(p.face, text, size);
  return { text, x, y: baseline - size * PLATE_ASCENT, width, size, height: size, bold: p.bold, color, group: 0, boldAt: graphemes(text).map(() => p.bold),
    ...(p.name ? { face: p.name } : {}), plate: {}, ...extra };
}
/** Per grapheme plate lines of `text` (spaces skipped), pen from x on `baseline`, colours by emphasis. */
function plateGlyphs(env: Env, text: string, ranges: readonly (readonly [number, number])[], x: number, baseline: number, size: (i: number) => number, color: (i: number, emph: boolean) => string,
  lift: (i: number) => number = () => 0): { lines: TemplateLine[]; end: number } {
  const lines: TemplateLine[] = [];
  let pen = x;
  graphemes(normalizeText(text, "plain")).forEach((g, i) => {
    const s = size(i), emph = ranges.some(([a, b]) => i >= a && i < b);
    const w = plateWidth(env.plate!.face, g, s);
    if (g.trim()) lines.push(plateLine(env, g, pen, baseline - lift(i), s, color(i, emph), emph ? { emphasis: true } : {}));
    pen += w;
  });
  return { lines, end: pen };
}

/* ───────────── Layouts ───────────── */
interface DraftShape { rect: TemplateRect; role: LyricShapeRole; motion: LyricShapeMotion; delay: number; rotate?: number; over?: boolean }
interface Draft {
  lines: TemplateLine[];
  decor?: { line: TemplateLine; motion: LyricDecorMotion; delay: number }[];
  shapes?: DraftShape[];
  size: number;
  box?: Box;
  align: "left" | "center";
  /** Entrances that suit it (intersected with the style's). */
  entrances?: readonly LyricEntrance[];
  holds?: readonly LyricHold[];
  /** The signature's colour when the ground under the footer is not the cut's. */
  signature?: string;
  /** Fills the frame: no ambient decor. */
  busy?: boolean;
}
type LayoutFn = (env: Env) => Draft | undefined;

const single = (env: Env) => env.spec.segments.length === 1 ? env.spec.segments[0]! : undefined;
const GLYPH_ENTRANCES: readonly LyricEntrance[] = ["rise", "drop", "slide", "pop", "focus", "flicker", "type", "wipe", "slice"];
const PLATE_ENTRANCES: readonly LyricEntrance[] = ["zoom", "pop", "rise", "drop", "flicker", "type", "wipe", "slice"];
const u = (env: Env) => env.W / 1080;

/** A spec holding `text` (a slice of the cut's one segment) and its emphasis. */
const sub = (env: Env, lo: number, hi: number): CutSpec => {
  const seg = single(env)!;
  const g = graphemes(normalizeText(seg.text, "plain"));
  while (lo < hi && !g[lo]!.trim()) lo++;
  while (hi > lo && !g[hi - 1]!.trim()) hi--;
  return { ...env.spec, segments: [{ text: g.slice(lo, hi).join(""), emphasis: shiftRanges(seg.emphasis, lo, hi) }] };
};
/** Word boundaries (grapheme offsets) of the cut's one segment. */
function wordStarts(env: Env): number[] {
  const seg = single(env)!;
  const tokens = env.t.tokens(glyphsOf(seg.text, seg.emphasis, 64, 64, env.face ? false : env.bold, "#000000", "#000000", undefined, env.face));
  const starts: number[] = [];
  let at = 0;
  for (const token of tokens) { starts.push(at); at += token.glyphs.length; }
  return starts;
}
/** Word boundaries that break the cut's one segment into `n` parts of about equal units. */
function breaksFor(env: Env, n: number): number[] {
  const seg = single(env)!;
  const g = graphemes(normalizeText(seg.text, "plain"));
  const starts = wordStarts(env).filter((s) => s > 0);
  const total = units(seg.text), out: number[] = [];
  for (let k = 1; k < n; k++) {
    let best: number | undefined, bestD = Infinity;
    for (const s of starts) { if (s <= (out.at(-1) ?? 0)) continue; const d = Math.abs(units(g.slice(0, s).join("")) - (total * k) / n); if (d < bestD) { bestD = d; best = s; } }
    if (best === undefined) break;
    out.push(best);
  }
  return out;
}
/** The word boundary nearest the middle of the text (by units), or undefined for one word. */
function middleBreak(env: Env): number | undefined {
  const seg = single(env)!;
  const g = graphemes(normalizeText(seg.text, "plain"));
  const starts = wordStarts(env).filter((s) => s > 0);
  if (!starts.length) return;
  const total = units(seg.text);
  let best: number | undefined, bestD = Infinity;
  for (const s of starts) { const d = Math.abs(units(g.slice(0, s).join("")) - total / 2); if (d < bestD) { bestD = d; best = s; } }
  return best;
}

const center: LayoutFn = (env) => {
  const b = setBlock(env, env.spec, env.pal, env.box, "center");
  return b && { lines: b.lines, size: b.size, box: b.box, align: "center", entrances: GLYPH_ENTRANCES };
};
const low: LayoutFn = (env) => {
  const b = setBlock(env, env.spec, env.pal, env.box, "left");
  if (!b) return;
  const k = Math.max(4, Math.round(env.M.rule.thickness * 2 * u(env)));
  const rule: DraftShape = { rect: { x: b.box.x, y: b.box.y - Math.round(b.size * 0.45), width: Math.round(env.W * 0.14), height: k, color: env.pal.accent, radius: 0 }, role: "rule", motion: "grow-x", delay: 0 };
  return { lines: b.lines, size: b.size, box: b.box, align: "left", shapes: rule.rect.y > env.margin * 0.4 ? [rule] : [], entrances: GLYPH_ENTRANCES };
};
const stack: LayoutFn = (env) => {
  const b = setBlock(env, env.spec, env.pal, env.box, "stack");
  return b && b.lines.length > 1 ? { lines: b.lines, size: b.size, box: b.box, align: b.align, entrances: GLYPH_ENTRANCES } : undefined;
};

/** Sizes a layout may set its words at: plates first (when they can draw the cut), then the engine's. */
const allSizes = (env: Env, text: string, max = Infinity) =>
  [...(env.plate && !missingGlyphs(env.plate.face, text).length ? env.plateSizes : []), ...env.sizes].filter((n) => n <= max);
/** One row of `text` at `size` (engine or plate), or undefined when it breaks. */
function oneRow(env: Env, text: string, ranges: readonly (readonly [number, number])[], size: number, ink: string, accent: string, paint = true): { row: Row; t: Typesetter; plate: boolean } | undefined {
  const plate = env.plateSizes.includes(size) && Boolean(env.plate);
  const t = plate ? plateSetter(env.plate!.face, env.M.leading) : env.t;
  const bold = env.face ? false : env.bold;
  const p = paint ? emphasisPaint(env.ctx.style.engine, env.pal, size, env.ctx.width, env.ctx.format) : undefined;
  const r = t.wrap(t.tokens(glyphsOf(text, ranges, size, size, bold, ink, accent, p, env.face)), Infinity);
  return r && r.length === 1 ? { row: r[0]!, t, plate } : undefined;
}
const emitRow = (env: Env, r: { row: Row; t: Typesetter; plate: boolean }, x: number, y: number): TemplateLine[] => {
  const lines = r.t.emit(r.row, x, y);
  return r.plate ? toPlates(env, lines, r.t) : lines;
};
/** Main type smaller than this reads as a caption: impact layouts refuse it. */
const minImpact = (env: Env) => Math.max(env.ctx.minBody, Math.round(64 * env.W / 1080));

/** Stacked words whose sizes jump: big, small, big. */
const steps: LayoutFn = (env) => {
  const seg = single(env);
  if (!seg) return;
  const g = graphemes(normalizeText(seg.text, "plain"));
  const starts = wordStarts(env);
  if (starts.length < 2 || starts.length > 9) return;
  // Rows of one or two words: a short word joins the next, a short last row joins the one before.
  const bounds: number[] = [0];
  for (let k = 1; k < starts.length; k++) if (units(g.slice(bounds.at(-1)!, starts[k]).join("")) >= 2.5) bounds.push(starts[k]!);
  if (bounds.length > 1 && units(g.slice(bounds.at(-1)!).join("")) < 2.5) bounds.pop();
  if (bounds.length < 2 || bounds.length > 4) return;
  const rows = bounds.map((a, k) => [a, bounds[k + 1] ?? g.length] as const);
  const emph = rows.map(([a, b]) => seg.emphasis.some(([x, y]) => x < b && y > a));
  const bigFirst = emph[0] || (!emph[1] && env.random() < 0.6);
  const big = rows.map((_, k) => emph[k] || (k % 2 === 0) === bigFirst);
  if (big.every(Boolean) || big.every((b) => !b)) return;
  const text = (k: number) => g.slice(rows[k]![0], rows[k]![1]).join("").trim();
  const ranges = (k: number) => shiftRanges(seg.emphasis, rows[k]![0] + (g.slice(rows[k]![0], rows[k]![1]).join("").length - g.slice(rows[k]![0], rows[k]![1]).join("").trimStart().length), rows[k]![1]);
  const sizes = allSizes(env, seg.text);
  for (const B of sizes) {
    const S = sizes.find((s) => s <= Math.max(env.ctx.minBody, B * 0.5)) ?? env.ctx.minBody;
    if (S > B * 0.66 || B < minImpact(env) * 1.4) continue;
    const set = rows.map((_, k) => oneRow(env, text(k), ranges(k), big[k] ? B : S, env.pal.ink, env.pal.accent));
    if (set.some((r) => !r || r.row.width > env.box.width)) continue;
    const pitch = (r: { row: Row }) => Math.round(r.row.height * 0.92);
    const height = set.reduce((h, r) => h + pitch(r!), 0);
    if (height > env.box.height) continue;
    let y = env.box.y + Math.round((env.box.height - height) / 2);
    const widest = Math.max(...set.map((r) => r!.row.width));
    const x0 = env.box.x + Math.round((env.box.width - widest) * (env.random() < 0.5 ? 0 : 0.5));
    const lines: TemplateLine[] = [];
    for (const [k, r] of set.entries()) {
      const indent = big[k] ? 0 : Math.round(Math.min(env.box.width - r!.row.width, widest - r!.row.width) * (k % 2 ? 1 : 0.15));
      // Rows set tight: each line's box is its pitch (the ink of display type sits well inside it).
      for (const l of emitRow(env, r!, x0 + Math.max(0, indent), y)) { if (!l.plate) l.height = Math.min(l.height, pitch(r!)); lines.push(l); }
      y += pitch(r!);
    }
    return { lines, size: B, align: "left", entrances: ["rise", "drop", "slide", "pop", "flicker", "slice", "zoom"] };
  }
  return;
};
/** A short line as giant plates filling the frame (one or two rows, each as wide as the frame allows). */
const giant: LayoutFn = (env) => {
  const seg = single(env);
  if (!seg || !env.plate || missingGlyphs(env.plate.face, seg.text).length) return;
  const total = units(seg.text);
  if (total > 12) return;
  const g = graphemes(normalizeText(seg.text, "plain"));
  const face = env.plate.face;
  const inner = { width: env.W - 2 * Math.round(env.W * 0.06), height: env.box.height };
  // One, two or (in a tall frame) three rows, broken between words: the count that sets the smallest row largest wins.
  const portrait = env.H > env.W * 1.2;
  let best: { parts: (readonly [number, number])[]; final: number[] } | undefined;
  for (const n of portrait ? [1, 2, 3] : [1, 2]) {
    if (n === 1 && total > 6.5) continue;
    const cuts = n === 1 ? [] : breaksFor(env, n);
    if (cuts.length !== n - 1) continue;
    const bounds = [0, ...cuts, g.length];
    const parts = bounds.slice(0, -1).map((a, k) => [a, bounds[k + 1]!] as const);
    const rowsH = inner.height * (n === 1 ? 0.62 : 0.88);
    const sizes = parts.map(([a, b]) => Math.floor(Math.min(inner.width / plateWidth(face, g.slice(a, b).join("").trim(), 1), rowsH / n / 1.02)));
    const cap = Math.min(...sizes) * 1.7;
    const final = sizes.map((x) => Math.min(x, Math.floor(cap)));
    if (!best || Math.min(...final) > Math.min(...best.final) * 1.08) best = { parts, final };
  }
  if (!best || Math.min(...best.final) < env.ctx.minBody * 1.6) return;
  const { parts, final } = best;
  const height = final.reduce((h, x) => h + x * 1.02, 0);
  let base = env.box.y + (env.box.height - height) / 2;
  const centred = env.V === LYRICS_MOTION.pop || parts.length === 1;
  const lines: TemplateLine[] = [];
  const accentRow = parts.length > 1 && !seg.emphasis.length ? Math.floor(env.random() * parts.length) : -1;
  for (const [r, [a, b]] of parts.entries()) {
    const size = final[r]!;
    const text = g.slice(a, b).join("");
    const lead = text.length - text.trimStart().length;
    const trimmed = text.trim();
    const w = plateWidth(face, trimmed, size);
    const x = centred ? (env.W - w) / 2 : r % 2 && parts.length > 2 ? env.W - Math.round(env.W * 0.06) - w : Math.round(env.W * 0.06);
    base += size * PLATE_ASCENT;
    const set = plateGlyphs(env, trimmed, shiftRanges(seg.emphasis, a + lead, b), x, Math.round(base), () => size, (_, emph) => emph || r === accentRow ? env.pal.accent : env.pal.ink);
    lines.push(...set.lines);
    base += size * (1.02 - PLATE_ASCENT);
  }
  return { lines, size: Math.min(...final), align: centred ? "center" : "left", entrances: PLATE_ENTRANCES, holds: ["breathe", "drift", "still"], busy: true };
};

/** One glyph of the line as a giant ghost behind it; the line itself medium over it. */
const focus: LayoutFn = (env) => {
  if (!env.plate) return;
  const b = setBlock(env, env.spec, env.pal, env.box, env.random() < 0.5 ? "center" : "left", { maxSize: Math.round(200 * u(env)) });
  if (!b) return;
  const text = env.spec.segments.map((s) => s.text).join("");
  const g = graphemes(normalizeText(text, "plain"));
  const emphAt = env.spec.segments[0]?.emphasis[0]?.[0];
  const keyIndex = emphAt ?? Math.max(0, g.findIndex((c) => /[\p{Script=Han}\p{Script=Katakana}]/u.test(c)), g.findIndex((c) => /\p{L}/u.test(c)));
  const key = g[keyIndex];
  if (!key || !key.trim() || missingGlyphs(env.plate.face, key).length) return;
  const size = Math.round(Math.min(env.W, env.H) * 0.94);
  const w = plateWidth(env.plate.face, key, size);
  const hollow = env.V === LYRICS_MOTION.night || env.random() < 0.35;
  const x = Math.round(env.W / 2 - w / 2 + (env.random() - 0.5) * env.W * 0.25);
  const ghost = plateLine(env, key, x, Math.round(env.H / 2 + size * 0.38), size, hollow ? env.pal.sub : env.pal.tint,
    { decorative: true, plate: hollow ? { stroke: { width: Math.max(2, Math.round(size * 0.006)), color: env.pal.sub, hollow: true }, alpha: 0.55 } : {} });
  return { lines: b.lines, size: b.size, box: b.box, align: b.align, decor: [{ line: ghost, motion: "settle", delay: 0 }], entrances: GLYPH_ENTRANCES, busy: true };
};

/** The line as one tilted plate on a band across the frame. */
const diagonal: LayoutFn = (env) => {
  const seg = single(env);
  if (!seg || !env.plate || units(seg.text) > 16) return;
  const text = normalizeText(seg.text, "plain");
  const angle = -(8 + Math.round(env.random() * 5));
  const rad = (Math.abs(angle) * Math.PI) / 180;
  const L = plateWidth(env.plate.face, text, 1);
  const size = Math.floor(Math.min((env.W * 0.88) / (L * Math.cos(rad) + Math.sin(rad)), env.H * 0.24));
  if (size < env.ctx.minBody * 1.4) return;
  const cx = env.W / 2, cy = env.box.y + env.box.height / 2 + (env.random() - 0.5) * env.box.height * 0.2;
  const w = L * size, h = size;
  const bw = w * Math.cos(rad) + h * Math.sin(rad), bh = w * Math.sin(rad) + h * Math.cos(rad);
  const line: TemplateLine = { ...plateLine(env, text, 0, 0, size, env.pal.plateInk), x: Math.round(cx - bw / 2), y: Math.round(cy - bh / 2), width: Math.round(bw), height: Math.round(bh),
    plate: { rotate: angle, ground: env.pal.plate } };
  const bandH = Math.round(size * 1.5), bandW = Math.round(env.W * 1.9);
  const band: DraftShape = { rect: { x: Math.round(cx - bandW / 2), y: Math.round(cy - bandH / 2), width: bandW, height: bandH, color: env.pal.plate, radius: 0 }, role: "band", motion: "grow-x-c", delay: 0, rotate: angle };
  const thin: DraftShape = { rect: { x: Math.round(cx - bandW / 2), y: Math.round(cy + bandH / 2 + size * 0.35), width: bandW, height: Math.max(4, Math.round(size * 0.06)), color: env.pal.accent, radius: 0 }, role: "band", motion: "grow-x", delay: 90, rotate: angle };
  return { lines: [line], size, align: "center", shapes: [band, thin], entrances: ["wipe", "slice", "zoom", "flicker"], holds: ["drift", "still", "breathe"], busy: true };
};

/** Two colour fields, the line broken across them. */
const split: LayoutFn = (env) => {
  const seg = single(env);
  if (!seg || env.pal2 === env.pal) return;
  const k = middleBreak(env);
  if (k === undefined) return;
  const g = graphemes(normalizeText(seg.text, "plain"));
  const gap = Math.round(env.H * 0.03), half = Math.round(env.H / 2);
  const footer = env.ctx.footerRoom();
  const topBox = { x: env.box.x, y: env.box.y, width: env.box.width, height: half - gap - env.box.y };
  const botBox = { x: env.box.x, y: half + gap, width: env.box.width, height: env.H - env.margin - footer - (half + gap) };
  if (topBox.height < env.ctx.minBody * 1.5 || botBox.height < env.ctx.minBody * 1.5) return;
  const a = sub(env, 0, k), b = sub(env, k, g.length);
  const ta = setBlock(env, a, env.pal, topBox, "left", { maxRows: 2 }), tb = setBlock(env, b, env.pal2, botBox, "top", { maxRows: 2 });
  if (!ta || !tb) return;
  const size = Math.min(ta.size, tb.size);
  const A = ta.size === size ? ta : setBlock(env, a, env.pal, topBox, "left", { only: size, maxRows: 2, strict: false });
  const B = tb.size === size ? tb : setBlock(env, b, env.pal2, botBox, "top", { only: size, maxRows: 2, strict: false });
  if (!A || !B) return;
  // The top part sits on the seam, the bottom one hangs from it at the right.
  const dyA = half - gap - (A.box.y + A.box.height);
  for (const l of A.lines) l.y += dyA;
  const dxB = env.box.x + env.box.width - (B.box.x + B.box.width);
  for (const l of B.lines) l.x += dxB;
  const field: DraftShape = { rect: { x: 0, y: half, width: env.W, height: env.H - half, color: env.pal2.bg, radius: 0 }, role: "field", motion: env.random() < 0.5 ? "slide-r" : "slide-l", delay: 0 };
  const seam: DraftShape = { rect: { x: 0, y: half - Math.round(3 * u(env)), width: env.W, height: Math.max(3, Math.round(6 * u(env))), color: env.pal.accent, radius: 0 }, role: "rule", motion: "grow-x", delay: 120 };
  return { lines: [...A.lines, ...B.lines], size, align: "left", shapes: [field, seam], signature: env.pal2.sub, entrances: ["rise", "slide", "drop", "flicker", "slice"], busy: true };
};

/** CJK: the first phrase in a tall column at the right, the rest across the bottom left. */
const mix: LayoutFn = (env) => {
  const seg = single(env);
  if (!seg || !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(seg.text)) return;
  const g = graphemes(normalizeText(seg.text, "plain"));
  let k = g.findIndex((c, i) => i >= 2 && /[，、。！？]/u.test(g[i - 1]!));
  if (k < 0) k = middleBreak(env) ?? -1;
  if (k < 2 || k >= g.length) return;
  const a = sub(env, 0, k), b = sub(env, k, g.length);
  if (!verticalSafe(a.segments[0]!.text) || graphemes(a.segments[0]!.text).length > 9) return;
  const colBox = { x: env.box.x + Math.round(env.box.width * 0.58), y: env.box.y, width: Math.round(env.box.width * 0.42), height: env.box.height };
  const col = setColumns(env, a, env.pal, colBox, 2);
  if (!col) return;
  const rowBox = { x: env.box.x, y: env.box.y + Math.round(env.box.height * 0.45), width: col.box.x - env.box.x - Math.round(env.W * 0.04), height: Math.round(env.box.height * 0.55) };
  if (rowBox.width < env.W * 0.3) return;
  const row = setBlock(env, b, env.pal, rowBox, "left", { maxSize: Math.max(env.ctx.minBody, Math.round(col.size * 0.8)), maxRows: 3 });
  if (!row) return;
  const rule: DraftShape = { rect: { x: col.box.x - Math.round(env.W * 0.03), y: col.box.y, width: Math.max(2, Math.round(3 * u(env))), height: col.box.height, color: env.pal.accent, radius: 0 }, role: "rule", motion: "grow-y", delay: 60 };
  return { lines: [...col.lines, ...row.lines], size: row.size, align: "left", shapes: [rule], entrances: ["drop", "focus", "rise", "flicker", "type"] };
};

const vertical: LayoutFn = (env) => {
  if (!env.spec.segments.every((s) => verticalSafe(s.text)) || env.spec.notes.length || env.spec.label || env.spec.credit) return;
  const b = setColumns(env, env.spec, env.pal, env.box);
  return b && { lines: b.lines, size: b.size, box: b.box, align: "center", entrances: ["drop", "focus", "rise", "flicker", "type"] };
};

/** The line with hollow ghost repeats above and below. */
const echo: LayoutFn = (env) => {
  const b = setBlock(env, env.spec, env.pal, env.box, "center", { maxSize: Math.round(184 * u(env)), maxRows: 2 });
  if (!b) return;
  const pitch = b.box.height + Math.round(b.size * 0.18);
  const decor: Draft["decor"] = [];
  const hollow = env.V !== LYRICS_MOTION.editorial;
  const colour = hollow ? env.pal.sub : env.pal.tint;
  for (let k = 1; k <= 4; k++) for (const dir of [-1, 1]) {
    const dy = dir * k * pitch;
    if (b.box.y + dy + b.box.height < -pitch * 0.2 || b.box.y + dy > env.H + pitch * 0.2) continue;
    const dx = Math.round((k % 2 ? 1 : -1) * dir * env.W * 0.035);
    for (const l of b.lines) {
      const width = Math.max(1.5, Math.round(l.size * 0.02 * 2) / 2);
      const copy: TemplateLine = { ...l, x: l.x + dx, y: l.y + dy, color: colour, decorative: true };
      delete copy.emphasis; delete copy.paint;
      if (l.plate) copy.plate = hollow ? { stroke: { width: Math.max(2, Math.round(width)), color: colour, hollow: true }, alpha: 0.85 - k * 0.15 } : { alpha: 1 };
      else if (hollow) copy.paint = { stroke: { width, color: withAlphaHex(colour, 0.85 - k * 0.15), position: "center", hollow: true } };
      decor.push({ line: copy, motion: "rise", delay: 60 * k });
    }
  }
  return { lines: b.lines, size: b.size, box: b.box, align: "center", decor, entrances: ["rise", "focus", "flicker", "slice", "wipe"], busy: true };
};
const withAlphaHex = (color: string, alpha: number) => `${color.slice(0, 7)}${Math.round(Math.min(1, Math.max(0, alpha)) * 255).toString(16).padStart(2, "0")}`;

/** The line in plates with its key word jumping up to twice the size, on one baseline. */
const jump: LayoutFn = (env) => {
  const seg = single(env);
  if (!seg || !env.plate || units(seg.text) > 7) return;
  const g = graphemes(normalizeText(seg.text, "plain"));
  let key = seg.emphasis[0];
  if (!key) {
    const starts = wordStarts(env);
    let best: [number, number] | undefined;
    starts.forEach((s, k) => { const e = starts[k + 1] ?? g.length; const word = g.slice(s, e).join("").trim(); if (graphemes(word).length >= 2 && (!best || units(word) > units(g.slice(best[0], best[1]).join("")))) best = [s, s + graphemes(word).length]; });
    key = best;
  }
  if (!key || key[1] - key[0] >= g.length) return;
  const face = env.plate.face;
  const inKey = (i: number) => i >= key![0] && i < key![1];
  const ratio = 2.1;
  const unitW = g.reduce((w, c, i) => w + plateWidth(face, c, 1) * (inKey(i) ? ratio : 1), 0);
  const base = Math.floor(Math.min(env.box.width / unitW, (env.box.height * 0.8) / ratio, 150 * u(env)));
  if (base < minImpact(env)) return;
  const total = unitW * base;
  const x = env.box.x + (env.box.width - total) / 2;
  const baseline = Math.round(env.box.y + env.box.height / 2 + base * ratio * 0.38);
  const set = plateGlyphs(env, g.join(""), [key], x, baseline, (i) => (inKey(i) ? Math.round(base * ratio) : base), (i) => (inKey(i) ? env.pal.accent : env.pal.ink));
  for (const l of set.lines) if (l.size > base) l.emphasis = true;
  return { lines: set.lines, size: base, align: "center", entrances: ["pop", "drop", "rise", "zoom", "flicker"], holds: ["breathe", "float", "still"] };
};

/** Each word on its own ink plate. */
const labels: LayoutFn = (env) => {
  const seg = single(env);
  if (!seg) return;
  const g = graphemes(normalizeText(seg.text, "plain"));
  const starts = wordStarts(env);
  if (starts.length < 2 || starts.length > 8) return;
  for (const size of allSizes(env, seg.text, 240 * u(env))) {
    if (size < minImpact(env)) break;
    const padX = Math.round(size * 0.22), padY = Math.round(size * 0.04), gap = Math.round(size * 0.16);
    const words = starts.map((s, k) => oneRow(env, g.slice(s, starts[k + 1] ?? g.length).join("").trim(), [], size, env.pal.plateInk, env.pal.plateInk, false));
    if (words.some((w) => !w || w.row.width + 2 * padX > env.box.width)) continue;
    const rows: (typeof words)[] = [[]];
    let width = 0;
    for (const w of words) {
      const need = w!.row.width + 2 * padX + (rows.at(-1)!.length ? gap : 0);
      if (rows.at(-1)!.length && width + need > env.box.width) { rows.push([w]); width = w!.row.width + 2 * padX; } else { rows.at(-1)!.push(w); width += need; }
    }
    if (rows.length > 4) continue;
    const rowH = Math.max(...words.map((w) => w!.row.height)) + 2 * padY;
    const pitch = rowH + gap;
    const height = rows.length * pitch - gap;
    if (height > env.box.height) continue;
    let y = env.box.y + Math.round((env.box.height - height) / 2);
    const lines: TemplateLine[] = [], shapes: DraftShape[] = [];
    let order = 0;
    for (const [k, row] of rows.entries()) {
      const rowW = row.reduce((n, w) => n + w!.row.width + 2 * padX, 0) + gap * (row.length - 1);
      let x = env.box.x + Math.round((env.box.width - rowW) * (rows.length === 1 ? 0.5 : k % 2 ? 0.85 : 0.1));
      for (const w of row) {
        shapes.push({ rect: { x, y, width: Math.round(w!.row.width + 2 * padX), height: rowH, color: env.pal.plate, radius: Math.round(size * (env.V === LYRICS_MOTION.pop ? 0.2 : 0.03)) }, role: "plate", motion: "grow-x", delay: order * 90 });
        lines.push(...emitRow(env, w!, x + padX, y + padY));
        x += Math.round(w!.row.width + 2 * padX + gap);
        order++;
      }
      y += pitch;
    }
    return { lines, size, align: "left", shapes, entrances: ["pop", "rise", "drop"] };
  }
  return;
};
/** Left-set rows with a thick bar sweeping under each; an emphasised word on a marker. */
const sweep: LayoutFn = (env) => {
  const b = setBlock(env, env.spec, env.pal, env.box, "left", { maxRows: 3 });
  if (!b) return;
  const shapes: DraftShape[] = [];
  const rows = [...new Set(b.lines.map((l) => l.y))];
  const k = Math.max(6, Math.round(b.size * 0.09));
  rows.forEach((y, i) => {
    const row = b.lines.filter((l) => l.y === y);
    const x0 = Math.min(...row.map((l) => l.x)), x1 = Math.max(...row.map((l) => l.x + l.width)), h = Math.max(...row.map((l) => l.height));
    shapes.push({ rect: { x: x0, y: Math.round(y + h * 0.9), width: Math.round(x1 - x0), height: k, color: env.pal.accent, radius: 0 }, role: "rule", motion: "grow-x", delay: 60 + i * 110 });
  });
  // One marker per run of emphasised lines on a row.
  const marked = b.lines.filter((l) => l.emphasis);
  const runs: TemplateLine[][] = [];
  for (const l of marked) { const run = runs.at(-1); if (run && run.at(-1)!.y === l.y && Math.abs(run.at(-1)!.x + run.at(-1)!.width - l.x) < l.size * 0.6) run.push(l); else runs.push([l]); }
  for (const run of runs) {
    const x0 = run[0]!.x, x1 = run.at(-1)!.x + run.at(-1)!.width, l = run[0]!;
    shapes.push({ rect: { x: Math.round(x0 - l.size * 0.08), y: Math.round(l.y + l.height * 0.04), width: Math.round(x1 - x0 + l.size * 0.16), height: Math.round(l.height * 0.92), color: env.pal.plate, radius: 0 }, role: "marker", motion: "grow-x", delay: 220 });
    for (const m of run) { m.color = env.pal.plateInk; delete m.paint; }
  }
  return { lines: b.lines, size: b.size, box: b.box, align: "left", shapes, entrances: ["rise", "slide", "wipe", "focus", "flicker"] };
};

/** A giant cut number as a graphic, the line set against it. */
const numeral: LayoutFn = (env) => {
  if (!env.plate || missingGlyphs(env.plate.face, "0123456789").length) return;
  const text = String(env.number).padStart(2, "0");
  const b = setBlock(env, env.spec, env.pal, { ...env.box, width: Math.round(env.box.width * 0.86) }, "left", { maxSize: Math.round(240 * u(env)) });
  if (!b) return;
  const size = Math.round(env.H * 0.66);
  const w = plateWidth(env.plate.face, text, size);
  const right = b.box.x + b.box.width / 2 < env.W / 2;
  const x = right ? env.W - w - Math.round(env.W * 0.02) : Math.round(env.W * 0.02);
  const n = plateLine(env, text, x, Math.round(env.H * 0.5 + size * 0.36), size, env.pal.tint, { decorative: true, generated: true });
  return { lines: b.lines, size: b.size, box: b.box, align: "left", decor: [{ line: n, motion: "settle", delay: 0 }], entrances: GLYPH_ENTRANCES, busy: true };
};

/** Editorial: the line smaller, in the lower left corner under a hairline, the cut number at the rule's end. */
const caption: LayoutFn = (env) => {
  const box = { x: env.box.x, y: env.box.y + Math.round(env.box.height * 0.4), width: Math.round(env.box.width * 0.9), height: Math.round(env.box.height * 0.6) };
  const b = setBlock(env, env.spec, env.pal, box, "left", { maxSize: Math.max(env.ctx.minBody, Math.round(112 * u(env))), maxRows: 4 });
  if (!b || b.size < Math.round(56 * u(env))) return;
  const k = Math.max(2, Math.round(env.M.rule.thickness * u(env)));
  const ruleY = b.box.y - Math.round(b.size * 0.8);
  const shapes: DraftShape[] = [{ rect: { x: env.box.x, y: ruleY, width: env.box.width, height: k, color: env.pal.ink, radius: 0 }, role: "rule", motion: "grow-x", delay: 0 }];
  const decor: Draft["decor"] = [];
  const small = Math.max(env.ctx.minSecondary, Math.round(env.M.small.size));
  const num = String(env.number).padStart(2, "0");
  const nw = env.ctx.measure.width(num, small, false);
  decor.push({ line: { text: num, x: env.box.x + env.box.width - nw, y: ruleY - Math.round(small * 1.5), width: nw, size: small, height: Math.round(small * 1.3), bold: false, color: env.pal.accent, group: 0, boldAt: [false, false], generated: true, decorative: true }, motion: "fade", delay: 80 });
  // Paper: a vermilion seal in the empty corner.
  const r = Math.round(Math.min(env.W, env.H) * 0.11);
  if (env.V === LYRICS_MOTION.editorial) {
    shapes.push({ rect: { x: env.W - env.margin - 2 * r, y: env.margin, width: 2 * r, height: 2 * r, color: env.pal.accent, radius: r }, role: "decor", motion: "pop", delay: 160 });
    if (b.box.y < env.margin + 2 * r + env.margin * 0.3 && b.box.x + b.box.width > env.W - env.margin - 2 * r) shapes.pop();
  }
  return { lines: b.lines, size: b.size, box: b.box, align: "left", shapes, decor, entrances: ["focus", "rise", "type", "slide"], busy: true };
};

/** Words stepping down the frame, each on its own row. */
const cascade: LayoutFn = (env) => {
  const seg = single(env);
  if (!seg) return;
  const g = graphemes(normalizeText(seg.text, "plain"));
  const starts = wordStarts(env);
  const bounds: number[] = [0];
  for (let k = 1; k < starts.length; k++) if (units(g.slice(bounds.at(-1)!, starts[k]).join("")) >= 1.5) bounds.push(starts[k]!);
  if (bounds.length < 3 || bounds.length > 5) return;
  for (const size of allSizes(env, seg.text)) {
    if (size < minImpact(env)) break;
    const rows = bounds.map((a, k) => {
      const b = bounds[k + 1] ?? g.length, text = g.slice(a, b).join("");
      const lead = text.length - text.trimStart().length;
      return oneRow(env, text.trim(), shiftRanges(seg.emphasis, a + lead, b), size, env.pal.ink, env.pal.accent);
    });
    if (rows.some((r) => !r)) continue;
    const widest = Math.max(...rows.map((r) => r!.row.width));
    if (widest > env.box.width) continue;
    const pitch = Math.round(Math.max(...rows.map((r) => r!.row.height)) * 0.94);
    if (pitch * rows.length > env.box.height) continue;
    const step = Math.max(0, Math.min(env.W * 0.16, (env.box.width - rows.at(-1)!.row.width) / (rows.length - 1)));
    const lines: TemplateLine[] = [];
    let y = env.box.y + Math.round((env.box.height - pitch * rows.length) / 2);
    rows.forEach((r, k) => {
      const x = Math.min(env.box.x + Math.round(k * step), env.box.x + env.box.width - r!.row.width);
      for (const l of emitRow(env, r!, x, y)) { if (!l.plate) l.height = Math.min(l.height, pitch); lines.push(l); }
      y += pitch;
    });
    return { lines, size, align: "left", entrances: ["drop", "slide", "rise", "pop", "flicker", "zoom"] };
  }
  return;
};
/** A thick frame drawn round the screen, the line centred inside. */
const frame: LayoutFn = (env) => {
  const inset = Math.round(env.M.frame.inset * 1.2), k = Math.max(4, Math.round(env.M.frame.thickness * 1.4));
  const inner = { x: env.box.x + k, y: env.box.y + k, width: env.box.width - 2 * k, height: env.box.height - 2 * k };
  const b = setBlock(env, env.spec, env.pal, inner, "center", { maxSize: Math.round(240 * u(env)) });
  if (!b) return;
  const H = env.H - env.ctx.footerRoom();
  const c = env.V === LYRICS_MOTION.editorial ? env.pal.ink : env.pal.accent;
  const shapes: DraftShape[] = [
    { rect: { x: inset, y: inset, width: env.W - 2 * inset, height: k, color: c, radius: 0 }, role: "frame", motion: "grow-x", delay: 0 },
    { rect: { x: env.W - inset - k, y: inset, width: k, height: H - 2 * inset, color: c, radius: 0 }, role: "frame", motion: "grow-y", delay: 80 },
    { rect: { x: inset, y: H - inset - k, width: env.W - 2 * inset, height: k, color: c, radius: 0 }, role: "frame", motion: "grow-x-r", delay: 160 },
    { rect: { x: inset, y: inset, width: k, height: H - 2 * inset, color: c, radius: 0 }, role: "frame", motion: "grow-y", delay: 240 },
  ];
  return { lines: b.lines, size: b.size, box: b.box, align: "center", shapes, entrances: ["rise", "pop", "focus", "flicker", "type"], busy: true };
};

/** The line centred, with two ticker bands of it running above and below. */
const ticker: LayoutFn = (env) => {
  const seg = single(env);
  if (!seg) return;
  const small = Math.max(env.ctx.minSecondary, Math.round(env.M.small.size));
  const bandH = Math.round(small * 1.55);
  const top = Math.round(env.margin * 0.45), bottom = env.H - Math.round(env.margin * 0.45) - bandH - env.ctx.footerRoom();
  const box = { ...env.box, y: top + bandH + Math.round(env.margin * 0.35), height: bottom - top - bandH - Math.round(env.margin * 0.7) };
  const b = setBlock(env, env.spec, env.pal, box, "center", { maxSize: Math.round(208 * u(env)), maxRows: 3 });
  if (!b) return;
  const text = normalizeText(seg.text, "plain");
  const w = env.ctx.measure.width(text, small, false);
  const gapW = Math.round(small * 1.4);
  const decor: Draft["decor"] = [];
  const shapes: DraftShape[] = [];
  for (const [k, y] of [top, bottom].entries()) {
    shapes.push({ rect: { x: 0, y, width: env.W, height: bandH, color: env.pal.plate, radius: 0 }, role: "band", motion: k ? "slide-r" : "slide-l", delay: 0 });
    for (let x = -(w + gapW) * (k ? 1.3 : 0.4); x < env.W * 2 + w; x += w + gapW) {
      decor.push({ line: { text, x: Math.round(x), y: y + Math.round((bandH - small * 1.3) / 2), width: w, size: small, height: Math.round(small * 1.3), bold: false, color: env.pal.plateInk, group: 0, boldAt: graphemes(text).map(() => false), decorative: true },
        motion: k ? "scroll-r" : "scroll-l", delay: 0 });
    }
  }
  return { lines: b.lines, size: b.size, box: b.box, align: "center", shapes, decor, entrances: ["zoom", "rise", "flicker", "slice", "wipe"], busy: true };
};

/** One spaced-out row between hairlines. */
const wide: LayoutFn = (env) => {
  const seg = single(env);
  if (!seg) return;
  const text = normalizeText(seg.text, "plain");
  const g = graphemes(text);
  if (g.length < 2 || units(text) > 14) return;
  const tracking = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) ? 0.3 : 0.16;
  const bold = env.face ? false : env.bold;
  for (const size of env.sizes) {
    if (size < minImpact(env)) break;
    const w = env.ctx.measure.width(text, size, bold, env.face) + tracking * size * (g.length - 1);
    if (w > env.box.width * 0.96) continue;
    const h = env.t.lh(size, bold, 1.2, env.face);
    const x = Math.round((env.W - w) / 2), y = Math.round(env.box.y + (env.box.height - h) / 2);
    const glyphs = glyphsOf(text, seg.emphasis, size, size, bold, env.pal.ink, env.pal.accent, emphasisPaint(env.ctx.style.engine, env.pal, size, env.ctx.width, env.ctx.format), env.face);
    const lines: TemplateLine[] = [];
    let pen = x;
    // One line per run of the same colour, each carrying the tracking.
    let run: typeof glyphs = [];
    const flush = () => {
      if (!run.length) return;
      const t = run.map((r) => r.text).join("");
      const width = env.ctx.measure.width(t, size, bold, env.face) + tracking * size * (run.length - 1);
      if (t.trim()) lines.push({ text: t, x: pen, y, width, size, height: h, bold, color: run[0]!.color, group: 0, boldAt: run.map(() => bold), tracking, ...(run[0]!.emph ? { emphasis: true } : {}), ...(run[0]!.paint ? { paint: run[0]!.paint } : {}), ...(env.face ? { face: env.face } : {}) });
      pen += width + tracking * size;
      run = [];
    };
    for (const gl of glyphs) { if (run.length && (run[0]!.color !== gl.color)) flush(); run.push(gl); }
    flush();
    const k = Math.max(2, Math.round(env.M.rule.thickness * u(env)));
    const shapes: DraftShape[] = [y - Math.round(size * 0.5), y + h + Math.round(size * 0.5) - k].map((ry, i) => ({ rect: { x: x - Math.round(size * 0.4), y: ry, width: Math.round(w + size * 0.8), height: k, color: env.pal.accent, radius: 0 }, role: "rule" as const, motion: "grow-x-c" as const, delay: i * 90 }));
    return { lines, size, align: "center", shapes, entrances: ["focus", "flicker", "rise", "type", "wipe"] };
  }
  return;
};

/** Plates on a wave: sizes that jump from glyph to glyph, the baseline rising and falling. */
const wave: LayoutFn = (env) => {
  const seg = single(env);
  if (!seg || !env.plate || units(seg.text) > 8) return;
  const g = graphemes(normalizeText(seg.text, "plain"));
  if (g.filter((c) => c.trim()).length < 3) return;
  const pattern = [1, 0.68, 0.88, 0.6, 1.08, 0.74];
  const shift = Math.floor(env.random() * pattern.length);
  const f = (i: number) => pattern[(i + shift) % pattern.length]!;
  const face = env.plate.face;
  const unitW = g.reduce((w, c, i) => w + plateWidth(face, c, 1) * f(i), 0);
  const base = Math.floor(Math.min(env.box.width / unitW, env.box.height * 0.5, 170 * u(env)));
  if (base * 0.6 < env.ctx.minBody || base < minImpact(env) * 1.2) return;
  const x = env.box.x + (env.box.width - unitW * base) / 2;
  const baseline = Math.round(env.box.y + env.box.height / 2 + base * 0.4);
  const amp = base * 0.14, phase = env.random() * Math.PI;
  const set = plateGlyphs(env, g.join(""), seg.emphasis, x, baseline, (i) => Math.round(base * f(i)), (i, emph) => (emph || i % 5 === 2 ? env.pal.accent : env.pal.ink), (i) => Math.round(Math.sin(i * 0.9 + phase) * amp));
  return { lines: set.lines, size: Math.round(base * 0.6), align: "center", entrances: ["pop", "drop", "rise", "flicker"], holds: ["float", "breathe"] };
};

/** Glyphs as plates each turned a little, alternately left and right, on a jittered baseline (one or two rows). */
const tilt: LayoutFn = (env) => {
  const seg = single(env);
  if (!seg || !env.plate || units(seg.text) > 10 || missingGlyphs(env.plate.face, seg.text).length) return;
  const g = graphemes(normalizeText(seg.text, "plain"));
  if (g.filter((c) => c.trim()).length < 3) return;
  const face = env.plate.face;
  const angle = (i: number) => (i % 2 ? -1 : 1) * (6 + ((i * 7) % 5) * 2);
  // A turned glyph's box: its em box turned.
  const boxOf1 = (c: string, size: number, deg: number) => {
    const w = plateWidth(face, c, size), h = size, r = (Math.abs(deg) * Math.PI) / 180;
    return { w: w * Math.cos(r) + h * Math.sin(r), h: w * Math.sin(r) + h * Math.cos(r), adv: w };
  };
  const rows = units(seg.text) > 6 ? (() => { const k = middleBreak(env); return k === undefined ? undefined : [[0, k], [k, g.length]] as const; })() : [[0, g.length]] as const;
  if (!rows) return;
  // The size that fits: measured at 100 px, scaled (turned boxes scale with the size).
  const probe = (size: number) => rows.map(([a, b]) => g.slice(a, b).map((c, k) => boxOf1(c, size, angle(a + k))).filter((_, k) => g[rows[0]![0] + k] !== undefined).reduce((n, x) => n + x.w + size * 0.02, 0));
  const fitted = Math.floor(Math.min(100 * env.box.width / Math.max(...probe(100)), env.box.height / (1.25 * rows.length), 360 * u(env)));
  for (const size of [fitted]) {
    if (size < minImpact(env) * 1.3) break;
    const laid: { c: string; i: number; w: number; h: number }[][] = rows.map(([a, b]) => g.slice(a, b).map((c, k) => ({ c, i: a + k, ...boxOf1(c, size, angle(a + k)) })).filter((x) => x.c.trim()));
    const gap = size * 0.02;
    const widths = laid.map((row) => row.reduce((n, x) => n + x.w + gap, -gap));
    const rowH = size * 1.25;
    if (Math.max(...widths) > env.box.width || rowH * laid.length > env.box.height) continue;
    const lines: TemplateLine[] = [];
    let cy = env.box.y + (env.box.height - rowH * laid.length) / 2 + rowH / 2;
    for (const [r, row] of laid.entries()) {
      let x = env.box.x + (env.box.width - widths[r]!) / 2;
      for (const item of row) {
        const lift = ((item.i * 5) % 3 - 1) * size * 0.06;
        const emph = seg.emphasis.some(([a, b]) => item.i >= a && item.i < b);
        const line = plateLine(env, item.c, 0, 0, size, emph || item.i % 4 === 1 ? env.pal.accent : env.pal.ink, emph ? { emphasis: true } : {});
        lines.push({ ...line, x: Math.round(x), y: Math.round(cy - item.h / 2 + lift), width: Math.round(item.w), height: Math.round(item.h), plate: { rotate: angle(item.i) } });
        x += item.w + gap;
      }
      cy += rowH;
    }
    return { lines, size, align: "center", entrances: ["pop", "drop", "zoom", "flicker"], holds: ["float", "breathe", "jitter"] };
  }
  return;
};

const LAYOUTS: Record<LyricLayout, LayoutFn> = { center, low, stack, steps, giant, focus, diagonal, split, mix, vertical, echo, jump, labels, sweep, numeral, caption, cascade, frame, ticker, wide, wave, tilt };

/* ───────────── Ambient decor ───────────── */
/** Decor shapes for one cut, kept clear of everything the cut writes. Returns the rects. */
export function decorate(kind: LyricDecor, W: number, H: number, margin: number, text: Box, palette: LyricPalette, M: MotionStyle, shapes: TemplateRect[], soft = 0): number[] {
  const out: number[] = [];
  const add = (rect: TemplateRect) => { out.push(shapes.length); shapes.push(rect); };
  const pad = Math.round(margin * 0.3);
  const clear = (r: { x: number; y: number; width: number; height: number }) =>
    r.x + r.width + pad <= text.x || r.x >= text.x + text.width + pad || r.y + r.height + pad <= text.y || r.y >= text.y + text.height + pad;
  const s = W / 1080;
  switch (kind) {
    case "bars": {
      const above = text.y - margin * 0.4, below = H - (text.y + text.height) - margin * 0.9;
      const h = Math.round(18 * s), gap = Math.round(14 * s);
      const band = 3 * h + 2 * gap;
      const useTop = above >= below;
      if (Math.max(above, below) < band + pad) return out;
      const y0 = useTop ? Math.round(margin * 0.45) : Math.round(H - margin * 0.9 - band);
      [0.42, 0.26, 0.34].forEach((f, k) => { const r = { x: k % 2 ? Math.round(W - margin * 0.5 - W * f) : Math.round(margin * 0.5), y: y0 + k * (h + gap), width: Math.round(W * f), height: h, color: palette.accent, radius: h / 2 }; if (clear(r)) add(r); });
      return out;
    }
    case "orb": {
      const cx = text.x + text.width / 2 < W / 2 ? W : 0, cy = text.y + text.height / 2 < H / 2 ? H : 0;
      for (let r = Math.round(Math.min(W, H) * 0.42); r >= Math.round(Math.min(W, H) * 0.12); r -= Math.round(20 * s)) {
        const rect: TemplateRect = { x: cx - r, y: cy - r, width: 2 * r, height: 2 * r, color: palette.tint, radius: r };
        if (clear(rect)) { if (soft) rect.soft = soft; add(rect); return out; }
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
      const r = Math.round(13 * s), gap = Math.round(22 * s), n = 5;
      const top = text.y > H / 2;
      const y = top ? Math.round(margin * 0.55) : Math.round(H - margin * 0.55 - 2 * r);
      const x0 = text.x + text.width / 2 > W / 2 ? Math.round(margin * 0.55) : Math.round(W - margin * 0.55 - n * 2 * r - (n - 1) * gap);
      for (let k = 0; k < n; k++) { const d = { x: x0 + k * (2 * r + gap), y, width: 2 * r, height: 2 * r, color: palette.accent, radius: r }; if (clear(d)) add(d); }
      return out;
    }
    case "rules": {
      const k = Math.max(2, Math.round(3 * s)), gap = Math.round(36 * s), extra = Math.round(40 * s);
      const x = Math.max(margin * 0.5, text.x - extra), w = Math.min(W - margin, text.width + 2 * extra);
      for (const y of [text.y - gap - k, text.y + text.height + gap]) if (y > margin * 0.3 && y + k < H - margin * 0.3) add({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: k, color: palette.ink, radius: 0 });
      return out;
    }
    case "sun": {
      const r = Math.round(46 * s);
      const x = text.x + text.width / 2 > W / 2 ? Math.round(margin * 0.9) : Math.round(W - margin * 0.9 - 2 * r);
      const y = text.y > H / 2 ? Math.round(margin * 0.8) : Math.round(H - margin * 1.2 - 2 * r);
      const disc = { x, y, width: 2 * r, height: 2 * r, color: palette.accent, radius: r };
      if (clear(disc)) add(disc);
      return out;
    }
    case "none": return out;
  }
}

/* ───────────── The planner ───────────── */
const BUSY_PENALTY: Partial<Record<LyricLayout, number>> = {};
/** How well each layout suits a cut, before the style's weights. */
function suitability(env: Env, layout: LyricLayout): number {
  const spec = env.spec;
  const text = spec.segments.map((s) => s.text).join("");
  const n = units(text);
  const emph = spec.segments.some((s) => s.emphasis.length) || spec.bang;
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
  const portrait = env.H > env.W * 1.2, landscape = env.W > env.H * 1.2;
  let w = 1;
  switch (layout) {
    case "giant": w = n <= 5 ? 2.2 : n <= 8 ? 1.2 : 0.6; if (emph) w *= 1.3; break;
    case "jump": w = emph ? 2 : 0.8; break;
    case "focus": w = emph ? 1.4 : 1; if (n > 24) w *= 0.5; break;
    case "diagonal": w = n <= 10 ? 1.2 : 0.7; if (landscape) w *= 1.3; break;
    case "wide": w = n <= 8 ? 1.3 : 0.6; if (landscape) w *= 1.3; break;
    case "vertical": case "mix": w = cjk ? (portrait ? 1.6 : 1) : 0; break;
    case "ticker": w = landscape ? 1.3 : 1; if (n > 20) w *= 0.6; break;
    case "caption": w = n > 12 ? 1.3 : n > 8 ? 0.6 : 0; break;
    case "center": case "low": w = n > 20 ? 1.6 : 1; break;
    case "steps": case "cascade": case "labels": w = n >= 4 && n <= 16 ? 1.2 : 0.6; break;
    case "wave": w = n <= 8 ? 1.3 : 0.7; break;
    case "tilt": w = n <= 7 ? 1.3 : 0.7; if (emph) w *= 1.2; break;
    default: w = 1;
  }
  if (spec.bang && (layout === "giant" || layout === "jump" || layout === "split")) w *= 1.5;
  return w * (BUSY_PENALTY[layout] ?? 1);
}

/* ───────────── Chunks ───────────── */
/** Chunks never shorter than this, nor faster than prose reading speed. */
const CHUNK_FLOOR_MS = 650;
/**
 * Lines broken into chunks of whole words, each its own cut (the pace of a
 * lyric video: a line lands in two or three hits). A seeded share of the
 * lines of six units or more; never inside an emphasised run; each chunk
 * keeps at least 2.5 units. The line's reading (or LRC) time is shared by
 * length; notes go with the last chunk, a label with the first.
 */
export function chunked(specs: readonly CutSpec[], t: Typesetter, random: () => number, share: number): CutSpec[] {
  const out: CutSpec[] = [];
  for (const spec of specs) {
    const seg = spec.segments[0];
    if (spec.kind !== "line" || spec.segments.length !== 1 || !seg || random() >= share) { out.push(spec); continue; }
    const g = graphemes(normalizeText(seg.text, "plain"));
    const n = units(seg.text);
    if (n < 6) { out.push(spec); continue; }
    const tokens = t.tokens(glyphsOf(seg.text, seg.emphasis, 64, 64, false, "#000000", "#000000"));
    const starts: number[] = [];
    let at = 0;
    for (const token of tokens) { starts.push(at); at += token.glyphs.length; }
    const count = n >= 12 ? 3 : 2;
    const cuts: number[] = [];
    for (let k = 1; k < count; k++) {
      const target = (n * k) / count;
      let best: number | undefined, bestD = Infinity;
      for (const s of starts) {
        if (s <= (cuts.at(-1) ?? 0) || seg.emphasis.some(([a, b]) => s > a && s < b)) continue;
        const d = Math.abs(units(g.slice(0, s).join("")) - target);
        if (d < bestD) { bestD = d; best = s; }
      }
      if (best !== undefined) cuts.push(best);
    }
    const bounds = [0, ...cuts, g.length];
    const pieces = bounds.slice(0, -1).map((a, k) => [a, bounds[k + 1]!] as const).filter(([a, b]) => units(g.slice(a, b).join("")) >= 2.5);
    if (pieces.length < 2 || pieces.length !== bounds.length - 1) { out.push(spec); continue; }
    pieces.forEach(([a, b], k) => {
      let lo = a, hi = b;
      while (lo < hi && !g[lo]!.trim()) lo++;
      while (hi > lo && !g[hi - 1]!.trim()) hi--;
      const text = g.slice(lo, hi).join("");
      const share = units(text) / n;
      const last = k === pieces.length - 1;
      const floor = Math.max(CHUNK_FLOOR_MS, graphemes(text).reduce((ms, c) => ms + (!c.trim() ? 0 : WIDE.test(c) ? LYRICS_TIMING.proseCjkMs : LYRICS_TIMING.proseLatinMs), 0));
      out.push({ kind: "line", segments: [{ text, emphasis: shiftRanges(seg.emphasis, lo, hi) }], notes: last ? spec.notes : [], ...(k === 0 && spec.label ? { label: spec.label } : {}),
        bang: last && spec.bang, readMs: Math.round(spec.readMs * share), ...(spec.timedMs !== undefined ? { timedMs: Math.round(spec.timedMs * share) } : {}), stanza: spec.stanza,
        floorMs: floor, part: k, parts: pieces.length });
    });
  }
  return out;
}

/* ───────────── The video ───────────── */
/** The face plates are drawn from: the display face, else the card's own pair (Peesuto Text); none when the card fell back to Noto. */
export function plateFaceOf(ctx: LyricsContext, face: string | undefined, bold: boolean): Env["plate"] {
  if (face && TEMPLATE_FACES[face]) return { face: loadFace(join(CODE_FONT_DIR, TEMPLATE_FACES[face]!.regular)), name: face, bold: false };
  if (ctx.font === "noto-sans-sc") return;
  return { face: loadFace(join(CODE_FONT_DIR, bold ? TEXT_FONT.bold : TEXT_FONT.regular)), bold };
}

export function video(ctx: LyricsContext): LyricsResult {
  const { content, style, width: W, variant } = ctx;
  const H = ctx.plan.aspect === "auto" ? ctx.fit : ctx.height;
  const M = style.motion, V: Vocab = LYRICS_MOTION[variant], T = LYRICS_TIMING;
  const random = generator(seedOf(`${ctx.plan.sourceText}\u0000${variant}`));
  const cap = lyricsMaxMs(W, H, ctx.format);
  const beatMs = 60000 / V.bpm;
  const typewriter = ctx.plan.motion === "typewriter";
  // Transitions first: their lengths come out of the time budget.
  const transitionLength = (tr: LyricTransition) => tr === "none" || tr === "cut" ? 0 : tr === "flash" ? 90 : tr === "glitch" || tr === "swap" ? 170 : V.transitionMs;
  const planTransitions = (list: readonly CutSpec[]): LyricTransition[] => {
    const out: LyricTransition[] = [];
    for (let i = 0; i < list.length; i++) {
      if (i === 0) { out.push("none"); continue; }
      // Within a line the chunks cut hard (now and then a flash); lines change by the style's transitions.
      if (list[i]!.part) { const r = random(); out.push(V.transitions.fade && V.koma === 0 && r < 0.5 ? "fade" : r < 0.8 ? "cut" : "flash"); continue; }
      const prev = out[i - 1];
      out.push(weighted(random, Object.entries(V.transitions).map(([k, w]) => [k as LyricTransition, (w as number) * (k === prev ? 0.25 : 1)] as const)) ?? "cut");
    }
    return out;
  };
  const fit = (specs: CutSpec[], transitions: LyricTransition[]) => {
    const floors = specs.map((c) => (c.kind === "title" ? T.titleMs : c.floorMs));
    // Reading time (or LRC timing), clamped, then snapped up to whole beats unless timed.
    const wanted = specs.map((c, i) => {
      const d = c.kind === "title" ? T.titleMs : Math.max(floors[i]!, Math.min(T.maxCutMs, Math.max(c.parts ? 0 : T.minCutMs, c.timedMs ?? c.readMs)));
      return c.timedMs !== undefined ? d : Math.ceil(d / beatMs - 0.15) * beatMs;
    });
    const last = wanted.length - 1;
    const tail = Math.max(0, T.finalHoldMs + 600 - wanted[last]!);
    const available = cap - T.introMs - transitions.reduce((n, tr) => n + transitionLength(tr), 0) - tail;
    const durations = fitDurations(wanted, floors, available);
    return durations && { durations, tail };
  };
  const whole = cutSpecs(content);
  let specs = chunked(whole, new Typesetter(ctx.measure, M.leading), random, V.chunk);
  let transitions = planTransitions(specs);
  let fitted = fit(specs, transitions);
  // Too long: lines whole again, then two lines a screen.
  if (!fitted && specs.length !== whole.length) { specs = whole; transitions = planTransitions(specs); fitted = fit(specs, transitions); }
  if (!fitted) { specs = pairCuts(specs, Boolean(content.prose)); transitions = planTransitions(specs); fitted = fit(specs, transitions); }
  if (!fitted) {
    const screens = specs.length, most = Math.floor((cap - T.introMs - T.finalHoldMs) / (T.minCutMs + V.transitionMs / 2));
    throw new ComposeError("lyric-too-long", `This text needs ${screens} screens even two cuts at a time; a ${(cap / 1000).toFixed(1)} s lyric-motion ${ctx.format === "gif" ? "GIF" : "video"} holds about ${most}${content.prose ? " at a readable pace" : ""}. Copy a shorter passage, or use PNG for a poster of all of it. No content was dropped.`);
  }
  const { durations, tail } = fitted;
  const margin = M.margin;
  const t = new Typesetter(ctx.measure, M.leading);
  const face = faceOf(ctx, "display");
  const plate = plateFaceOf(ctx, face, M.bold);
  const result: LyricsResult = { background: M.palette[0]!.bg, margin, lines: [], shapes: [], backdrop: [], pinned: [], bottom: H - margin, signatureColor: M.palette[0]!.sub, signatureAlign: "left" };
  const cuts: LyricsCut[] = [];
  const sizes = M.sizes.filter((n) => n >= ctx.minBody);
  const secondary = (n: number) => Math.max(ctx.minSecondary, n);
  const recent: LyricLayout[] = [];
  let at: number = T.introMs;
  let prevPalette = -1, prevEntrance: LyricEntrance | undefined, prevHold: LyricHold | undefined, prevDecor: LyricDecor | undefined;
  const starts: number[] = [];
  // Cut start times first (transitions and durations are known).
  { let clock: number = T.introMs; for (const [i] of specs.entries()) { clock += transitionLength(transitions[i]!); starts.push(clock); clock += durations[i]!; } }
  for (const [i, spec] of specs.entries()) {
    const duration = durations[i]!;
    const keep = Boolean(spec.part) && random() < 0.8;
    const index = i === 0 ? 0 : keep ? prevPalette : (() => { const k = Math.floor(random() * (M.palette.length - 1)); return k >= prevPalette ? k + 1 : k; })();
    const pal = M.palette[index]!;
    const pal2 = M.palette[(index + 1 + Math.floor(random() * (M.palette.length - 1))) % M.palette.length]!;
    prevPalette = index;
    const firstLine = result.lines.length;
    const ground = result.shapes.length;
    result.shapes.push({ x: 0, y: 0, width: W, height: H, color: pal.bg, radius: 0 });
    // Room for the label on top and the notes and credit underneath.
    const quietSize = secondary(M.note.size);
    const labelRoom = spec.label ? t.lh(secondary(M.label.size), false, 1.2) + Math.round(M.note.gap / 2) : 0;
    const noteRows = (text: string) => t.wrap(t.tokens(glyphsOf(text, undefined, quietSize, quietSize, false, pal.sub, pal.accent)), W - 2 * margin) ?? [];
    const notes = spec.notes.map(noteRows);
    const creditSize = secondary(M.title.creditSize);
    const credit = spec.credit ? t.wrap(t.tokens(glyphsOf(spec.credit, undefined, creditSize, creditSize, false, pal.sub, pal.accent)), W - 2 * margin) ?? [] : [];
    const quietH = [...notes.flat(), ...credit].reduce((h, r) => h + r.height, 0) + (notes.length || credit.length ? M.note.gap : 0);
    const box = { x: margin, y: margin + labelRoom, width: W - 2 * margin, height: H - 2 * margin - ctx.footerRoom() - labelRoom - quietH };
    const env: Env = { ctx, t, spec, pal, pal2: pal2.bg === pal.bg ? pal : pal2, box, W, H, margin, M, V, ...(face ? { face } : {}), ...(plate ? { plate } : {}), bold: M.bold, random, number: i + 1, sizes,
      plateSizes: plate ? PLATE_SIZES.map((n) => Math.round(n * W / 1080)).filter((n) => n > Math.max(...sizes)) : [] };
    // The layout: weighted by style, suitability and novelty; the first that fits wins.
    let draft: Draft | undefined, layout: LyricLayout = "center";
    if (spec.kind === "title") {
      for (const l of ["giant", "center"] as const) { draft = LAYOUTS[l](env); if (draft) { layout = l; break; } }
    } else {
      const pool = LYRIC_LAYOUTS.map((l) => {
        const base = (V.layouts as Partial<Record<LyricLayout, number>>)[l] ?? 0;
        const novelty = recent.slice(-2).includes(l) ? 0.1 : recent.slice(-6).includes(l) ? 0.35 : recent.includes(l) ? 0.8 : 1;
        return [l, base * suitability(env, l) * novelty] as const;
      }).filter(([, w]) => w > 0);
      const tried = new Set<LyricLayout>();
      while (!draft && tried.size < pool.length) {
        const l = weighted(random, pool.filter(([k]) => !tried.has(k)));
        if (!l) break;
        tried.add(l);
        draft = LAYOUTS[l](env);
        if (draft) layout = l;
      }
      if (!draft) { draft = center(env); layout = "center"; }
    }
    if (!draft) throw new ComposeError("overflow", "A lyric line is too long for one screen of this frame even at the smallest size. Use PNG, a wider frame, or break the line with `/`. No content was dropped.");
    recent.push(layout);
    // Entrance, hold and ghosts.
    const allowed = draft.entrances ?? GLYPH_ENTRANCES;
    const entrance: LyricEntrance = typewriter ? "type" : spec.kind === "title" ? (allowed.includes("zoom") ? "zoom" : "rise")
      : weighted(random, allowed.map((e) => [e, ((V.entrances as Partial<Record<LyricEntrance, number>>)[e] ?? 0.05) * (e === prevEntrance ? 0.3 : 1)] as const)) ?? allowed[0]!;
    prevEntrance = entrance;
    const holds = draft.holds ?? (Object.keys(V.holds) as LyricHold[]);
    const motion: LyricHold = weighted(random, holds.map((h) => [h, ((V.holds as Partial<Record<LyricHold, number>>)[h] ?? 0.2) * (h === prevHold ? 0.5 : 1)] as const)) ?? "still";
    prevHold = motion;
    const chroma = V.ghosts.share > 0 && random() < V.ghosts.share && layout !== "labels";
    // Lines: the lyric, its decorative companions, then shapes.
    const textStart = result.lines.length;
    result.lines.push(...draft.lines);
    const textIndices = draft.lines.map((_, k) => textStart + k);
    const decorEntries = (draft.decor ?? []).map((d) => { result.lines.push(d.line); return { line: result.lines.length - 1, motion: d.motion, delay: d.delay }; });
    const block = draft.box ?? boxOf(draft.lines);
    // Notes and the credit under the block, the label above it.
    const quiet: number[] = [];
    let qy = Math.min(block.y + block.height + (quietH ? M.note.gap : 0), H - margin - ctx.footerRoom() - quietH + (quietH ? M.note.gap : 0));
    for (const row of [...credit, ...notes.flat()]) {
      const x = draft.align === "center" ? Math.round((W - row.width) / 2) : Math.max(margin, Math.min(block.x, W - margin - row.width));
      for (const line of t.emit(row, x, qy, { secondary: true })) { quiet.push(result.lines.length); result.lines.push(line); }
      qy += row.height;
    }
    if (spec.label) {
      const rows = t.wrap(t.tokens(glyphsOf(spec.label, undefined, secondary(M.label.size), secondary(M.label.size), false, pal.sub, pal.accent)), W - 2 * margin) ?? [];
      let ly = margin;
      for (const row of rows) { for (const line of t.emit(row, margin, ly, { secondary: true })) { quiet.push(result.lines.length); result.lines.push(line); } ly += row.height; }
    }
    const shapes: LyricsCut["shapes"][number][] = [];
    for (const s of draft.shapes ?? []) { shapes.push({ shape: result.shapes.length, role: s.role, motion: s.motion, delay: s.delay, ...(s.rotate ? { rotate: s.rotate } : {}), ...(s.over ? { over: true } : {}) }); result.shapes.push(s.rect); }
    const main = result.lines.slice(firstLine).filter((l) => !l.decorative);
    const outer = unionBox([block, ...main.map((l) => ({ x: l.x, y: l.y, width: l.width, height: l.height }))]);
    // Ambient decor on quiet layouts.
    if (!draft.busy) {
      const decor = (M.decor as readonly LyricDecor[]).filter((d) => d !== prevDecor);
      const kind = decor[Math.floor(random() * decor.length)] ?? "none";
      prevDecor = kind;
      for (const k of decorate(kind, W, H, margin, outer, pal, M, result.shapes, style.engine.blur?.decor ?? 0)) shapes.push({ shape: k, role: "decor", motion: kind === "orb" ? "pop" : kind === "frame" || kind === "rules" ? "grow-x" : "pop", delay: 80 + shapes.length * 50 });
      // Micro-copy: the cut's own words, small and spaced, in an empty band with a short accent bar (editorial texture; decorative).
      const seg = spec.segments.length === 1 ? spec.segments[0] : undefined;
      if (seg && V.micro > 0 && random() < V.micro && graphemes(seg.text).length <= 48) {
        const small = Math.max(ctx.minSecondary, Math.round(M.small.size * 0.8));
        const text = normalizeText(seg.text, "plain"), n = graphemes(text).length, track = 0.14;
        const w = ctx.measure.width(text, small, false) + track * small * (n - 1), h = Math.round(small * 1.3);
        const bar = { w: Math.round(small * 1.1), h: Math.max(3, Math.round(small * 0.18)) };
        const top = outer.y > margin + h * 2, x = margin, y = top ? Math.round(margin * 0.55) : Math.round(H - margin * 0.55 - h - ctx.footerRoom());
        const clear = top ? y + h + margin * 0.3 < outer.y : y > outer.y + outer.height + margin * 0.3;
        if (clear && x + bar.w * 1.6 + w < W - margin) {
          result.lines.push({ text, x: x + Math.round(bar.w * 1.6), y, width: Math.round(w), size: small, height: h, bold: false, color: pal.sub, group: 0, boldAt: graphemes(text).map(() => false), tracking: track, decorative: true, secondary: true });
          decorEntries.push({ line: result.lines.length - 1, motion: "fade", delay: 140 });
          shapes.push({ shape: result.shapes.length, role: "decor", motion: "grow-x", delay: 100 });
          result.shapes.push({ x, y: y + Math.round((h - bar.h) / 2), width: bar.w, height: bar.h, color: pal.accent, radius: 0 });
        }
      }
    }
    // Night: a camera HUD round the frame (corner brackets and the cut counter) on every cut.
    if (V.hud) {
      const k = Math.max(3, Math.round(4 * W / 1080)), arm = Math.round(Math.min(W, H) * 0.06), inset = Math.round(margin * 0.32);
      const Hf = H - ctx.footerRoom();
      for (const [cx, cy, sx, sy] of [[inset, inset, 1, 1], [W - inset, inset, -1, 1], [inset, Hf - inset, 1, -1], [W - inset, Hf - inset, -1, -1]] as const) {
        for (const r of [{ x: sx > 0 ? cx : cx - arm, y: sy > 0 ? cy : cy - k, width: arm, height: k }, { x: sx > 0 ? cx : cx - k, y: sy > 0 ? cy : cy - arm, width: k, height: arm }]) {
          shapes.push({ shape: result.shapes.length, role: "decor", motion: "fade", delay: 0 });
          result.shapes.push({ ...r, color: pal.sub, radius: 0 });
        }
      }
      const small = secondary(M.small.size);
      const count = String(i + 1).padStart(2, "0"), total = String(specs.length).padStart(2, "0");
      const cw = ctx.measure.width(count, small, false), tw = ctx.measure.width(total, small, false);
      const y = inset + k * 2 + Math.round(small * 0.2), x1 = W - inset - k * 2;
      const slash = Math.round(small * 0.7);
      const tx = x1 - tw, sx = tx - slash, cx = sx - cw;
      for (const [text, x, w, color] of [[count, cx, cw, pal.accent], [total, tx, tw, pal.sub]] as const) {
        result.lines.push({ text, x, y, width: w, size: small, height: Math.round(small * 1.3), bold: false, color, group: 0, boldAt: [...text].map(() => false), generated: true, decorative: true, secondary: true });
        decorEntries.push({ line: result.lines.length - 1, motion: "fade", delay: 0 });
      }
      shapes.push({ shape: result.shapes.length, role: "decor", motion: "fade", delay: 0, rotate: 24 });
      result.shapes.push({ x: sx + Math.round(slash * 0.45), y: y + Math.round(small * 0.15), width: Math.max(2, Math.round(k * 0.7)), height: Math.round(small * 1.0), color: pal.sub, radius: 0 });
    }
    const start = starts[i]!;
    const inAt = start - transitionLength(transitions[i]!);
    const next = starts[i + 1];
    const end = next !== undefined ? next : start + duration + tail;
    cuts.push({ inAt, start, hold: duration, end, palette: pal, layout, entrance, motion, transition: transitions[i]!, bang: spec.bang,
      text: textIndices, quiet, decor: decorEntries, ground, shapes, box: block, outer, glyphSize: draft.size, chroma, signature: draft.signature ?? pal.sub, ...(spec.part !== undefined ? { part: spec.part } : {}) });
    at = end;
  }
  for (const shape of result.shapes) result.pinned.push(shape);
  result.program = { durationMs: at, frameHeight: H, cuts, koma: V.koma, beatMs, texture: ctx.format === "gif" ? { grain: 0, scanlines: 0, vignette: 0, paper: 0 } : V.texture };
  result.bottom = H - margin;
  return result;
}

/* ───────────── Checks ───────────── */
/** The quality gate for a lyric video: source fidelity over the whole
 * layout, and every other check per cut, against that cut's own ground (the
 * cuts share the canvas but are never on screen together). A tilted plate is
 * checked against the band it lies on. */
export function lyricsViolations(layout: TemplateLayout, program: LyricsProgram, plan: Parameters<typeof fidelityViolations>[1]): CheckViolation[] {
  const out = fidelityViolations(layout, plan);
  const signature = layout.lines.filter((l) => l.signature);
  for (const [i, cut] of program.cuts.entries()) {
    const lines = [...cut.text, ...cut.quiet].map((k) => layout.lines[k]!);
    const shapes = [cut.ground, ...cut.shapes.filter((s) => !s.rotate && s.role !== "decor").map((s) => s.shape)].map((k) => layout.shapes[k]!);
    // A tilted plate lies on its band: its ground is the band's colour.
    for (const l of lines) if (l.plate?.rotate && l.plate.ground) shapes.push({ x: l.x, y: l.y, width: l.width, height: l.height, color: l.plate.ground, radius: 0 });
    const sub = { width: layout.width, height: program.frameHeight, background: cut.palette.bg, lines: [...lines, ...signature.map((l) => ({ ...l, color: cut.signature }))], shapes };
    for (const v of checkLayout(sub)) out.push({ kind: v.kind, message: `cut ${i} (${cut.layout}): ${v.message}` });
  }
  return out;
}
