/**
 * Type plates: a line of text set in a TrueType face and drawn into an RGBA
 * PNG by Peesuto itself, for type the engine cannot draw. Pocket Motion bakes
 * text into glyph atlases whose cell metrics are bytes, so its largest size is
 * about 176 px, and a Text node never turns or grows with `rotate`/`scale`;
 * an Image does both. Lyric motion uses plates for giant words, tilted lines,
 * glyphs that jump in size and outlined ghosts.
 *
 * The reader handles the `glyf` outlines of the faces Peesuto ships
 * (simple and composite glyphs, cmap formats 4 and 12, hmtx). Advances only:
 * no kerning, as the engine sets text. The rasteriser is an exact-area
 * accumulation scan (signed coverage per cell, summed along each row, the
 * magnitude clamped to 1), so overlapping contours of the same direction do
 * not double. An outline (stroke) is a Euclidean distance transform of the
 * filled shape; hollow text keeps the ring outside the fill.
 *
 * Pure apart from reading the font files (cached per path).
 */
import { readFileSync } from "node:fs";
import { encodePng } from "./backdrop.ts";

interface Contour { readonly points: readonly { x: number; y: number; on: boolean }[] }
export interface Face {
  readonly path: string;
  readonly upm: number;
  readonly ascender: number;
  readonly descender: number;
  cmap: Map<number, number>;
  advance(glyph: number): number;
  contours(glyph: number): Contour[];
}

const faces = new Map<string, Face>();

/** Parse (once) the TrueType face at `path`. */
export function loadFace(path: string): Face {
  const cached = faces.get(path);
  if (cached) return cached;
  const bytes = readFileSync(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = new Map<string, number>();
  const count = view.getUint16(4);
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    tables.set(String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!), view.getUint32(at + 8));
  }
  const table = (tag: string) => { const at = tables.get(tag); if (at === undefined) throw new Error(`${path}: no ${tag} table (a TrueType face with glyf outlines is required)`); return at; };
  const head = table("head"), hhea = table("hhea"), maxp = table("maxp"), hmtx = table("hmtx"), loca = table("loca"), glyf = table("glyf"), cmapAt = table("cmap");
  const upm = view.getUint16(head + 18), longLoca = view.getInt16(head + 50) === 1;
  const ascender = view.getInt16(hhea + 4), descender = view.getInt16(hhea + 6), metrics = view.getUint16(hhea + 34);
  const glyphs = view.getUint16(maxp + 4);
  const offset = (g: number) => longLoca ? view.getUint32(loca + g * 4) : view.getUint16(loca + g * 2) * 2;
  // cmap: the Unicode subtable with the widest coverage (format 12, else 4).
  const cmap = new Map<number, number>();
  const subtables = view.getUint16(cmapAt + 2);
  let best: { at: number; format: number } | undefined;
  for (let i = 0; i < subtables; i++) {
    const platform = view.getUint16(cmapAt + 4 + i * 8), encoding = view.getUint16(cmapAt + 6 + i * 8);
    const at = cmapAt + view.getUint32(cmapAt + 8 + i * 8), format = view.getUint16(at);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (unicode && (format === 12 || (format === 4 && best?.format !== 12))) best = { at, format };
  }
  if (!best) throw new Error(`${path}: no Unicode cmap`);
  if (best.format === 12) {
    const groups = view.getUint32(best.at + 12);
    for (let i = 0; i < groups; i++) {
      const g = best.at + 16 + i * 12, start = view.getUint32(g), end = view.getUint32(g + 4), id = view.getUint32(g + 8);
      for (let c = start; c <= end; c++) cmap.set(c, id + c - start);
    }
  } else {
    const segs = view.getUint16(best.at + 6) / 2;
    const ends = best.at + 14, starts = ends + segs * 2 + 2, deltas = starts + segs * 2, ranges = deltas + segs * 2;
    for (let s = 0; s < segs; s++) {
      const end = view.getUint16(ends + s * 2), start = view.getUint16(starts + s * 2), delta = view.getInt16(deltas + s * 2), range = view.getUint16(ranges + s * 2);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let id: number;
        if (range === 0) id = (c + delta) & 0xffff;
        else { id = view.getUint16(ranges + s * 2 + range + (c - start) * 2); if (id) id = (id + delta) & 0xffff; }
        if (id) cmap.set(c, id);
      }
    }
  }
  const advance = (g: number) => view.getUint16(hmtx + Math.min(g, metrics - 1) * 4);
  const contours = (g: number, depth = 0): Contour[] => {
    if (g >= glyphs || depth > 8) return [];
    const at = glyf + offset(g);
    if (offset(g + 1) === offset(g)) return [];
    const n = view.getInt16(at);
    if (n >= 0) {
      const endPts: number[] = [];
      for (let i = 0; i < n; i++) endPts.push(view.getUint16(at + 10 + i * 2));
      const total = n ? endPts[n - 1]! + 1 : 0;
      let p = at + 10 + n * 2;
      p += 2 + view.getUint16(p);
      const flags: number[] = [];
      while (flags.length < total) {
        const f = bytes[p++]!;
        flags.push(f);
        if (f & 8) { let r = bytes[p++]!; while (r-- > 0) flags.push(f); }
      }
      const xs: number[] = [], ys: number[] = [];
      let v = 0;
      for (const f of flags) { if (f & 2) { const d = bytes[p++]!; v += f & 16 ? d : -d; } else if (!(f & 16)) { v += view.getInt16(p); p += 2; } xs.push(v); }
      v = 0;
      for (const f of flags) { if (f & 4) { const d = bytes[p++]!; v += f & 32 ? d : -d; } else if (!(f & 32)) { v += view.getInt16(p); p += 2; } ys.push(v); }
      const out: Contour[] = [];
      let start = 0;
      for (const end of endPts) {
        const points = [];
        for (let i = start; i <= end; i++) points.push({ x: xs[i]!, y: ys[i]!, on: (flags[i]! & 1) === 1 });
        out.push({ points });
        start = end + 1;
      }
      return out;
    }
    // Composite: components placed by offsets (point matching is not used by these faces), scaled when asked.
    const out: Contour[] = [];
    let p = at + 10, more = true;
    while (more) {
      const flags = view.getUint16(p), component = view.getUint16(p + 2);
      p += 4;
      let dx: number, dy: number;
      if (flags & 1) { dx = view.getInt16(p); dy = view.getInt16(p + 2); p += 4; } else { dx = view.getInt8(p); dy = view.getInt8(p + 1); p += 2; }
      if (!(flags & 2)) { dx = 0; dy = 0; }
      let a = 1, b = 0, c = 0, d = 1;
      const f2 = (o: number) => view.getInt16(o) / 16384;
      if (flags & 8) { a = d = f2(p); p += 2; } else if (flags & 0x40) { a = f2(p); d = f2(p + 2); p += 4; } else if (flags & 0x80) { a = f2(p); b = f2(p + 2); c = f2(p + 4); d = f2(p + 6); p += 8; }
      for (const contour of contours(component, depth + 1)) out.push({ points: contour.points.map((q) => ({ x: a * q.x + c * q.y + dx, y: b * q.x + d * q.y + dy, on: q.on })) });
      more = (flags & 0x20) !== 0;
    }
    return out;
  };
  const face: Face = { path, upm, ascender, descender, cmap, advance, contours };
  faces.set(path, face);
  return face;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const glyphOf = (face: Face, grapheme: string): number => face.cmap.get(grapheme.codePointAt(0)!) ?? 0;

/** Characters of `text` the face cannot draw (spaces aside). */
export function missingGlyphs(face: Face, text: string): string[] {
  return [...graphemeSegmenter.segment(text)].map((s) => s.segment).filter((g) => g.trim() && !face.cmap.has(g.codePointAt(0)!));
}
/** The advance of `text` at `size` px (tracking in em added after every grapheme but the last). */
export function plateWidth(face: Face, text: string, size: number, trackingEm = 0): number {
  const parts = [...graphemeSegmenter.segment(text)].map((s) => s.segment);
  const units = parts.reduce((w, g) => w + face.advance(glyphOf(face, g)), 0);
  return (units * size) / face.upm + Math.max(0, parts.length - 1) * trackingEm * size;
}
/** Ascent, descent and line height at `size` px (hhea). */
export function plateMetrics(face: Face, size: number): { ascent: number; descent: number; height: number } {
  const ascent = (face.ascender * size) / face.upm, descent = (-face.descender * size) / face.upm;
  return { ascent, descent, height: ascent + descent };
}

/* ───────────── Rasteriser ───────────── */
type Point = { x: number; y: number };

/** Outline segments (device px, y down) of `text`, pen at (0, baseline 0), turned by `rotate` degrees about the line box's centre. */
function outline(face: Face, text: string, size: number, trackingEm: number, rotate: number): { lines: [Point, Point][]; box: { x0: number; y0: number; x1: number; y1: number } } {
  const s = size / face.upm;
  const m = plateMetrics(face, size), width = plateWidth(face, text, size, trackingEm);
  const cx = width / 2, cy = (m.descent - m.ascent) / 2;
  const rad = (rotate * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const place = (x: number, y: number): Point => rotate ? { x: cx + (x - cx) * cos - (y - cy) * sin, y: cy + (x - cx) * sin + (y - cy) * cos } : { x, y };
  const lines: [Point, Point][] = [];
  let pen = 0;
  for (const g of [...graphemeSegmenter.segment(text)].map((p) => p.segment)) {
    const id = glyphOf(face, g);
    for (const contour of face.contours(id)) {
      const pts = contour.points;
      if (pts.length < 2) continue;
      // Expand implied on-curve points, then walk quadratic segments.
      const full: { x: number; y: number; on: boolean }[] = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
        full.push(a);
        if (!a.on && !b.on) full.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
      }
      let first = full.findIndex((p) => p.on);
      if (first < 0) continue;
      const seq = [...full.slice(first), ...full.slice(0, first)];
      const dev = (p: { x: number; y: number }) => place(pen + p.x * s, -p.y * s);
      let prev = dev(seq[0]!);
      for (let i = 1; i <= seq.length; i++) {
        const p = seq[i % seq.length]!;
        if (p.on) { const q = dev(p); lines.push([prev, q]); prev = q; continue; }
        const ctrl = dev(p), end = dev(seq[(i + 1) % seq.length]!);
        const ddx = prev.x - 2 * ctrl.x + end.x, ddy = prev.y - 2 * ctrl.y + end.y;
        const n = Math.max(1, Math.ceil(Math.sqrt(Math.sqrt(ddx * ddx + ddy * ddy) * 3)));
        for (let k = 1; k <= n; k++) {
          const t = k / n, u = 1 - t;
          const q = { x: u * u * prev.x + 2 * u * t * ctrl.x + t * t * end.x, y: u * u * prev.y + 2 * u * t * ctrl.y + t * t * end.y };
          lines.push([k === 1 ? prev : lines[lines.length - 1]![1], q]);
        }
        prev = end;
        i++;
      }
    }
    pen += face.advance(id) * s + trackingEm * size;
  }
  // The box: the line box (advance × ascent+descent) turned, so layout boxes are stable whatever the ink.
  const corners = [place(0, -m.ascent), place(width, -m.ascent), place(0, m.descent), place(width, m.descent)];
  const xs = [...corners.map((c) => c.x), ...lines.flatMap(([a]) => [a.x])], ys = [...corners.map((c) => c.y), ...lines.flatMap(([a]) => [a.y])];
  return { lines, box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } };
}

/** Coverage 0..1 of the filled outline on a width × height grid, the outline shifted by (ox, oy). */
function coverage(lines: readonly [Point, Point][], width: number, height: number, ox: number, oy: number): Float32Array {
  const w = width + 2, acc = new Float32Array(w * height + 2);
  for (const [a, b] of lines) {
    const p0 = { x: a.x + ox, y: a.y + oy }, p1 = { x: b.x + ox, y: b.y + oy };
    if (p0.y === p1.y) continue;
    const dir = p0.y < p1.y ? 1 : -1;
    const [lo, hi] = p0.y < p1.y ? [p0, p1] : [p1, p0];
    const dxdy = (hi.x - lo.x) / (hi.y - lo.y);
    let x = lo.x;
    if (lo.y < 0) x -= lo.y * dxdy;
    for (let y = Math.max(0, Math.floor(lo.y)); y < Math.min(height, Math.ceil(hi.y)); y++) {
      const row = y * w;
      const dy = Math.min(y + 1, hi.y) - Math.max(y, lo.y);
      const xnext = x + dxdy * dy, d = dy * dir;
      const x0 = Math.max(0, Math.min(x, xnext)), x1 = Math.max(0, Math.max(x, xnext));
      const x0f = Math.floor(x0), x0i = x0f, x1c = Math.ceil(x1), x1i = x1c;
      if (x1i <= x0i + 1) {
        const xm = 0.5 * (x + xnext) - x0f;
        acc[row + x0i] = acc[row + x0i]! + d - d * xm;
        acc[row + x0i + 1] = acc[row + x0i + 1]! + d * xm;
      } else {
        const inv = 1 / (x1 - x0), fx0 = x0 - x0f;
        const a0 = 0.5 * inv * (1 - fx0) * (1 - fx0);
        const fx1 = x1 - x1c + 1, am = 0.5 * inv * fx1 * fx1;
        acc[row + x0i] = acc[row + x0i]! + d * a0;
        if (x1i === x0i + 2) acc[row + x0i + 1] = acc[row + x0i + 1]! + d * (1 - a0 - am);
        else {
          const a1 = inv * (1.5 - fx0);
          acc[row + x0i + 1] = acc[row + x0i + 1]! + d * (a1 - a0);
          for (let xi = x0i + 2; xi < x1i - 1; xi++) acc[row + xi] = acc[row + xi]! + d * inv;
          const a2 = a1 + (x1i - x0i - 3) * inv;
          acc[row + x1i - 1] = acc[row + x1i - 1]! + d * (1 - a2 - am);
        }
        acc[row + x1i] = acc[row + x1i]! + d * am;
      }
      x = xnext;
    }
  }
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) { sum += acc[y * w + x]!; out[y * width + x] = Math.min(1, Math.abs(sum)); }
  }
  return out;
}

/** Euclidean distance (px) from every pixel to the nearest pixel at least half covered (Felzenszwalb & Huttenlocher). */
function distanceToInk(cov: Float32Array, width: number, height: number): Float32Array {
  const INF = 1e20, grid = new Float64Array(width * height);
  for (let i = 0; i < grid.length; i++) grid[i] = cov[i]! >= 0.5 ? 0 : INF;
  const n = Math.max(width, height), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const pass = (len: number, get: (i: number) => number, set: (i: number, value: number) => void) => {
    for (let i = 0; i < len; i++) f[i] = get(i);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) { k--; s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1]! < q) k++; d[q] = (q - v[k]!) * (q - v[k]!) + f[v[k]!]!; set(q, d[q]!); }
  };
  for (let x = 0; x < width; x++) pass(height, (i) => grid[i * width + x]!, (i, value) => { grid[i * width + x] = value; });
  for (let y = 0; y < height; y++) pass(width, (i) => grid[y * width + i]!, (i, value) => { grid[y * width + i] = value; });
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(grid[i]!);
  return out;
}

export interface PlateStyle {
  /** Fill colour (#rrggbb); omitted with `stroke.hollow`. */
  readonly color: string;
  /** Opacity of the whole plate (0..1), baked into the alpha. */
  readonly alpha?: number;
  /** An outline `width` px outside the fill, in `color`; `hollow` keeps the ring alone. */
  readonly stroke?: { readonly width: number; readonly color: string; readonly hollow?: boolean };
  readonly trackingEm?: number;
  /** A vertical gradient fill instead of `color`, from the em box's top (`fromAt` of its height) to `toAt`. Unturned plates only. */
  readonly gradient?: { readonly from: string; readonly to: string; readonly fromAt: number; readonly toAt: number };
  /** Degrees, clockwise, about the line box's centre. */
  readonly rotate?: number;
}
export interface PlateGeometry {
  readonly width: number;
  readonly height: number;
  /** The pen's origin (left end of the baseline) in the image, for an unturned plate. */
  readonly ox: number;
  readonly oy: number;
  /** The line box's centre in the image: a turned plate turns about it. */
  readonly cx: number;
  readonly cy: number;
}
export interface Plate extends PlateGeometry { readonly png: Uint8Array }

function geometry(face: Face, text: string, size: number, style: Omit<PlateStyle, "color">) {
  const tracking = style.trackingEm ?? 0, rotate = style.rotate ?? 0;
  const { lines, box } = outline(face, text, size, tracking, rotate);
  const stroke = style.stroke?.width ?? 0;
  const pad = Math.ceil(stroke + 2);
  const ox = pad - Math.floor(box.x0), oy = pad - Math.floor(box.y0);
  const width = Math.min(2048, Math.ceil(box.x1 - box.x0) + 2 * pad + 1), height = Math.min(2048, Math.ceil(box.y1 - box.y0) + 2 * pad + 1);
  const m = plateMetrics(face, size), lineWidth = plateWidth(face, text, size, tracking);
  return { lines, stroke, geometry: { width, height, ox, oy, cx: ox + lineWidth / 2, cy: oy + (m.descent - m.ascent) / 2 } };
}
/** Where a plate's pixels will sit, without drawing them. */
export function plateGeometry(face: Face, text: string, size: number, style: Omit<PlateStyle, "color">): PlateGeometry {
  return geometry(face, text, size, style).geometry;
}

/** Draw `text` at `size` px as an RGBA plate. */
export function renderPlate(face: Face, text: string, size: number, style: PlateStyle): Plate {
  const { lines, stroke, geometry: g } = geometry(face, text, size, style);
  const { width, height } = g;
  const cov = coverage(lines, width, height, g.ox, g.oy);
  const rgba = new Uint8Array(width * height * 4);
  const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const flat = hex(style.color), ring = style.stroke ? hex(style.stroke.color) : flat;
  // Gradient ink: the colour per row, across the em box (0.88 em above the baseline, 0.12 below).
  const grad = style.gradient && !style.rotate ? { a: hex(style.gradient.from), b: hex(style.gradient.to), y0: g.oy - 0.88 * size + style.gradient.fromAt * size, y1: g.oy - 0.88 * size + style.gradient.toAt * size } : undefined;
  const rowFill = (y: number) => { if (!grad) return flat; const t = Math.min(1, Math.max(0, (y - grad.y0) / Math.max(1, grad.y1 - grad.y0))); return grad.a.map((v, k) => v + (grad.b[k]! - v) * t); };
  const alpha = style.alpha ?? 1;
  const dist = stroke ? distanceToInk(cov, width, height) : undefined;
  for (let i = 0; i < width * height; i++) {
    const c = cov[i]!;
    const fill = rowFill(Math.floor(i / width));
    // The ring: 1 within `stroke` px of the ink, feathered over one pixel.
    const r = dist ? Math.max(0, Math.min(1, stroke + 0.5 - dist[i]!)) : 0;
    let a: number, col: number[];
    if (style.stroke?.hollow) { a = Math.max(0, Math.min(1, Math.max(r, c) - c)); col = ring; }
    else if (dist) { a = Math.max(c, r); col = a > 0 ? ring.map((v, k) => (v * (a - c) + fill[k]! * c) / a) : fill; }
    else { a = c; col = fill; }
    rgba[i * 4] = Math.round(col[0]!); rgba[i * 4 + 1] = Math.round(col[1]!); rgba[i * 4 + 2] = Math.round(col[2]!); rgba[i * 4 + 3] = Math.round(a * alpha * 255);
  }
  return { ...g, png: encodePng(width, height, rgba, 6, 4) };
}
