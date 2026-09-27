/**
 * JIZURA's film grain and scanlines: a faster way to draw them (opt-in), and
 * the GIF's grain left out.
 *
 * Every frame JIZURA lays its grain over the whole picture (src/09_render.js
 * post(): a 256 px noise tile as a repeating pattern, offset by a fraction of
 * a pixel that changes every drawing, filled twice, overlay and normal) and,
 * in some styles, scanlines (a 1×4 tile, scaled, multiplied). Skia fills a
 * rect with a repeating image pattern through its general shader pipeline,
 * sampling every pixel of the frame: most of a frame's time.
 *
 * But the filled layer repeats: under a transform that only scales by s and
 * translates, with s times the tile size a whole number of pixels, the
 * layer's pixels repeat every s·tile pixels of the canvas. So one period is
 * sampled by the same pattern fill with the same fractional offset, on a
 * small canvas, and that patch is laid over the frame by whole-pixel copies
 * with the same blend and alpha (PRESAMPLED). The pattern's own sampling is
 * kept exactly; what remains is Skia blending an image in 8 bits where its
 * shader blends in float: up to 4 of 255, 0.3–0.6 on average, spread evenly.
 * Under any other transform (9:16 and 4:5 frames scale the grain by a
 * fraction)
 * the tiles are drawn as one pre-tiled image under the same transform
 * (SHEETS), which samples bilinearly in 8 bits: up to 10 of 255 at some
 * offsets, a grain of a slightly different texture (and MP4s about a third
 * larger). docs/templates.md has the measurements; `bun run jizura-gallery`
 * the crops.
 *
 * Off by default (PEESUTO_JIZURA_GRAIN=presampled turns it on): a 21 s
 * 1080² MP4 drew in 15.6 s instead of 21.9 s on six threads (CPU 67 s
 * instead of 104 s), but came out 24.6 MB instead of 20.0 MB, because the
 * blend's rounding is a faint noise of its own that the encoder pays for
 * (noir +23%, mint +11%, paper +22%; the old SHEETS path +20–32%). The
 * pictures are JIZURA's exactly without it; the cost is the time.
 * Only the grain of a GIF is dropped by default (below).
 *
 * Nothing in JIZURA changes: this wraps the one context the frames are drawn
 * into (own properties on that instance, as JIZURA's own alpha guard does),
 * and only for the renderer's grain and scanline tiles; every other pattern,
 * and a pattern given a transform of its own, is filled as before.
 *
 * A GIF leaves the grain out, as classic Lyric motion does: noise that
 * changes with every drawing is dithering in a 128-colour palette and about
 * two thirds of the file (a 14 s GIF: 5.3 MB with it, 1.7 MB without any
 * texture); the paper, the scanlines and the vignette stay.
 */
import type { CanvasContext2D, CanvasElement, CanvasModule } from "./canvas.ts";

interface Tile { readonly src: CanvasElement; transformed: boolean; key?: string }

/** Sheets per thread, by tile content and size: every realm's renderer makes the same tiles (the same seed). */
const sheets = new Map<string, CanvasElement>();
const SHEETS_MAX = 16;

function sheetOf(canvas: CanvasModule, t: Tile, sw: number, sh: number): CanvasElement {
  const tile = t.src;
  if (!t.key) { const h = new Bun.CryptoHasher("sha1"); h.update(tile.data()); t.key = `${tile.width}x${tile.height}:${h.digest("hex")}`; }
  const key = `${t.key}:${sw}x${sh}`;
  let sheet = sheets.get(key);
  if (sheet) return sheet;
  // One tile, then the sheet doubled onto itself across and down: whole-pixel copies, exact.
  sheet = canvas.createCanvas(sw, sh);
  const sx = sheet.getContext("2d") as unknown as { drawImage(img: unknown, ...a: number[]): void };
  sx.drawImage(tile, 0, 0);
  for (let w = tile.width; w < sw; w *= 2) sx.drawImage(sheet, 0, 0, w, tile.height, w, 0, w, tile.height);
  for (let hh = tile.height; hh < sh; hh *= 2) sx.drawImage(sheet, 0, 0, sw, hh, 0, hh, sw, hh);
  if (sheets.size >= SHEETS_MAX) sheets.delete(sheets.keys().next().value!);
  sheets.set(key, sheet);
  return sheet;
}

/** The last presampled layer per thread (the grain's two fills of a frame share one). */
let presampled: { key: string; sheet: CanvasElement } | undefined;
const whole = (n: number) => Math.abs(n - Math.round(n)) < 1e-6;

/**
 * The layer a pattern of `tile` fills under the device transform
 * (s, 0, 0, s, e, f), as a sheet of at least `cw`×`ch` pixels with its
 * origin at device (dx, dy), or undefined when the transform does not repeat
 * on whole pixels. One period (s·tile) is filled by the pattern itself with
 * the transform's fractional offset, then copied across and down.
 */
function presample(canvas: CanvasModule, tile: Tile, t: { a: number; b: number; c: number; d: number; e: number; f: number }, cw: number, ch: number,
  pattern: (ctx: CanvasContext2D) => unknown): { sheet: CanvasElement; dx: number; dy: number } | undefined {
  if (t.b !== 0 || t.c !== 0 || t.a !== t.d || !(t.a > 0)) return;
  const pw = t.a * tile.src.width, ph = t.a * tile.src.height;
  if (!whole(pw) || !whole(ph)) return;
  const PW = Math.round(pw), PH = Math.round(ph);
  const ie = Math.floor(t.e), jf = Math.floor(t.f), fe = t.e - ie, ff = t.f - jf;
  // Device pixel q holds patch pixel (q - ie) mod PW, so the sheet starts at the last period boundary at or before 0.
  const dx = (((ie % PW) + PW) % PW) - PW, dy = (((jf % PH) + PH) % PH) - PH;
  const sw = Math.ceil((cw - dx) / PW) * PW, sh = Math.ceil((ch - dy) / PH) * PH;
  if (!tile.key) { const h = new Bun.CryptoHasher("sha1"); h.update(tile.src.data()); tile.key = `${tile.src.width}x${tile.src.height}:${h.digest("hex")}`; }
  const key = `${tile.key}:${t.a}:${fe}:${ff}:${sw}x${sh}`;
  if (presampled?.key === key) return { sheet: presampled.sheet, dx, dy };
  const patch = canvas.createCanvas(PW, PH);
  const px = patch.getContext("2d") as unknown as CanvasContext2D & { setTransform(...a: number[]): void; fillStyle: unknown; fillRect(x: number, y: number, w: number, h: number): void };
  px.setTransform(t.a, 0, 0, t.a, fe, ff);
  px.fillStyle = pattern(px);
  px.fillRect(-1, -1, PW / t.a + 2, PH / t.a + 2);
  const sheet = canvas.createCanvas(sw, sh);
  const sx = sheet.getContext("2d") as unknown as { drawImage(img: unknown, ...a: number[]): void };
  sx.drawImage(patch, 0, 0);
  for (let w = PW; w < sw; w *= 2) sx.drawImage(sheet, 0, 0, w, PH, w, 0, w, PH);
  for (let hh = PH; hh < sh; hh *= 2) sx.drawImage(sheet, 0, 0, sw, hh, 0, hh, sw, hh);
  patch.width = 1; patch.height = 1;
  if (presampled && !presampled.key.endsWith(`:${sw}x${sh}`)) { presampled.sheet.width = 1; presampled.sheet.height = 1; }
  presampled = { key, sheet };
  return { sheet, dx, dy };
}

export interface GrainShim { readonly hits: () => number }

/**
 * Draw `tiles` (the renderer's grain and scanline canvases) as pre-tiled
 * sheets when `ctx` fills a rect with them (`sheets: false` keeps Skia's
 * pattern fill); tiles in `skip` are not drawn at all (the grain of a GIF).
 */
export function shimGrain(canvas: CanvasModule, ctx: CanvasContext2D, tiles: readonly unknown[], o: { readonly skip?: readonly unknown[]; readonly sheets?: boolean } = {}): GrainShim {
  const own = new Set(tiles), skip = new Set(o.skip ?? []), sheets = o.sheets ?? true;
  const proto = Object.getPrototypeOf(ctx) as Record<string, unknown>;
  const native = {
    createPattern: proto.createPattern as (this: CanvasContext2D, src: unknown, rep: string | null) => { setTransform?: (...a: unknown[]) => void } | null,
    fillRect: proto.fillRect as (this: CanvasContext2D, x: number, y: number, w: number, h: number) => void,
    save: proto.save as (this: CanvasContext2D) => void,
    restore: proto.restore as (this: CanvasContext2D) => void,
    drawImage: proto.drawImage as (this: CanvasContext2D, img: unknown, x: number, y: number) => void,
  };
  const fillStyle = Object.getOwnPropertyDescriptor(proto, "fillStyle");
  if (!fillStyle?.get || !fillStyle.set) return { hits: () => 0 };
  const meta = new WeakMap<object, Tile>();
  let current: unknown;
  const stack: unknown[] = [];
  let hits = 0;
  const target = ctx as unknown as Record<string, unknown>;
  target.createPattern = function (this: CanvasContext2D, src: unknown, rep: string | null) {
    const p = native.createPattern.call(this, src, rep);
    if (p && own.has(src) && (rep === "repeat" || rep === null || rep === "")) {
      const tile: Tile = { src: src as CanvasElement, transformed: false };
      meta.set(p, tile);
      const set = p.setTransform;
      if (typeof set === "function") p.setTransform = function (...a: unknown[]) { tile.transformed = true; return set.apply(this, a); };
    }
    return p;
  };
  Object.defineProperty(ctx, "fillStyle", {
    configurable: true, enumerable: fillStyle.enumerable ?? true,
    get(this: CanvasContext2D) { return fillStyle.get!.call(this); },
    set(this: CanvasContext2D, v: unknown) { current = v; fillStyle.set!.call(this, v); },
  });
  target.save = function (this: CanvasContext2D) { stack.push(current); native.save.call(this); };
  target.restore = function (this: CanvasContext2D) { if (stack.length) current = stack.pop(); native.restore.call(this); };
  target.fillRect = function (this: CanvasContext2D, x: number, y: number, w: number, h: number) {
    const tile = current !== null && typeof current === "object" ? meta.get(current) : undefined;
    if (tile && skip.has(tile.src)) return;
    if (!tile || tile.transformed || !sheets || !(w > 0 && h > 0)) return native.fillRect.call(this, x, y, w, h);
    const c = this as unknown as { beginPath(): void; rect(a: number, b: number, c: number, d: number): void; clip(): void; imageSmoothingEnabled: boolean; imageSmoothingQuality: string;
      getTransform(): { a: number; b: number; c: number; d: number; e: number; f: number }; setTransform(...a: number[]): void; canvas: CanvasElement };
    hits++;
    const t = c.getTransform();
    const pre = presample(canvas, tile, t, c.canvas.width, c.canvas.height, (pc) => native.createPattern.call(pc, tile.src, "repeat"));
    native.save.call(this);
    c.beginPath(); c.rect(x, y, w, h); c.clip();
    if (pre) {
      // Whole-pixel copies in device space: nothing is resampled.
      c.setTransform(1, 0, 0, 1, 0, 0);
      native.drawImage.call(this, pre.sheet, pre.dx, pre.dy);
    } else {
      const tw = tile.src.width, th = tile.src.height;
      // The pattern's tiles sit on multiples of the tile size in the current user space.
      const x0 = Math.floor(x / tw) * tw, y0 = Math.floor(y / th) * th;
      const sw = Math.ceil((x + w - x0) / tw) * tw, sh = Math.ceil((y + h - y0) / th) * th;
      c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "low";
      native.drawImage.call(this, sheetOf(canvas, tile, sw, sh), x0, y0);
    }
    native.restore.call(this);
  };
  return { hits: () => hits };
}
