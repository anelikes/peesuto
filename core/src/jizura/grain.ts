/**
 * JIZURA's film grain and scanlines, drawn faster.
 *
 * Every frame JIZURA lays its grain over the whole picture (src/09_render.js
 * post(): a 256 px noise tile as a repeating pattern, filled twice, overlay
 * and normal) and, in some styles, scanlines (a 1×4 tile, multiplied).
 * Skia fills a rect with a repeating image pattern through its general
 * shader pipeline: about 25 ms for one full 1080 px fill, most of a frame.
 * Drawing the same tiles as one pre-tiled image (drawImage, clipped to the
 * rect) under the same transform is four times cheaper and samples the same
 * pixels the same way (bilinear, the pattern's phase kept: the sheet starts
 * on a tile boundary of the pattern's own space); Skia's image blit rounds in
 * 8 bits where the shader rounds in float, so a pixel may differ by up to 3
 * of 255 under the overlay, 0.2 on average (docs/templates.md has the
 * measurements and the side-by-side crops).
 *
 * Nothing in JIZURA changes: this wraps the one context the frames are drawn
 * into (own properties on that instance, as JIZURA's own alpha guard does),
 * and only for the renderer's grain and scanline tiles; every other pattern,
 * and a pattern given a transform of its own, is filled as before.
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

export interface GrainShim { readonly hits: () => number }

/** Draw `tiles` (the renderer's grain and scanline canvases) as pre-tiled sheets when `ctx` fills a rect with them. */
export function shimGrain(canvas: CanvasModule, ctx: CanvasContext2D, tiles: readonly unknown[]): GrainShim {
  const own = new Set(tiles);
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
    if (!tile || tile.transformed || !(w > 0 && h > 0)) return native.fillRect.call(this, x, y, w, h);
    const tw = tile.src.width, th = tile.src.height;
    // The pattern's tiles sit on multiples of the tile size in the current user space.
    const x0 = Math.floor(x / tw) * tw, y0 = Math.floor(y / th) * th;
    const sw = Math.ceil((x + w - x0) / tw) * tw, sh = Math.ceil((y + h - y0) / th) * th;
    const sheet = sheetOf(canvas, tile, sw, sh);
    hits++;
    native.save.call(this);
    const c = this as unknown as { beginPath(): void; rect(a: number, b: number, c: number, d: number): void; clip(): void; imageSmoothingEnabled: boolean; imageSmoothingQuality: string };
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "low";
    c.beginPath(); c.rect(x, y, w, h); c.clip();
    native.drawImage.call(this, sheet, x0, y0);
    native.restore.call(this);
  };
  return { hits: () => hits };
}
