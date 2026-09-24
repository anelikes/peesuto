/**
 * Colour-field backdrops: a few large colour blobs, heavily blurred, like
 * light through frosted glass. Rendered here into a PNG at the canvas's own
 * size and drawn as one full-bleed image under everything else: mixing in
 * OKLab and a seeded grain are beyond the engine's gradients, and one image
 * costs a frame nothing, where a blurred layer would be paid on every frame.
 *
 * - Each blob is an anisotropic Gaussian (no edge anywhere), mixed over the
 *   ground in OKLab, so two neighbouring hues meet without going grey or
 *   muddy the way a gamma-sRGB blend does.
 * - An optional vignette darkens the corners in lightness only.
 * - A fine monochrome grain (deterministic, seeded, triangular, ~1% of full
 *   scale) breaks up 8-bit banding in the long, dark gradients.
 *
 * Pure and deterministic: the same field, canvas and raster give the same
 * bytes. `stageField` caches the PNG by a hash of those parameters.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { fitGamut, labToLinear, oklab, toGamma, type Oklch } from "./gradient.ts";

/** One blob. Position is a fraction of the canvas (0..1 on each axis); radii
 * are one standard deviation as a fraction of √(width × height), so a blob
 * covers the same share of any canvas shape. */
export interface FieldBlob {
  readonly x: number; readonly y: number;
  readonly rx: number; readonly ry: number;
  /** Rotation of the rx axis, degrees clockwise. */
  readonly angle?: number;
  readonly color: Oklch;
  /** Peak mix weight over what is below it, 0..1 (default 1). */
  readonly strength?: number;
}

export interface ColourField {
  readonly background: Oklch;
  /** Mixed in order, each over the result of the ones before. */
  readonly blobs: readonly FieldBlob[];
  /** Grain amplitude as a fraction of full scale (default 0.012; 0 = none). */
  readonly grain?: number;
  /** Corner darkening, 0..1 of lightness at the far corners (default 0). */
  readonly vignette?: number;
  /** Grain seed (default 1). */
  readonly seed?: number;
}

export interface Size { readonly width: number; readonly height: number }

/** Largest image side the engine accepts (Pocket Motion v0.4.0: any size, 1 to 2048 px per side). */
export const FIELD_TEXTURE_MAX = 2048;
/** Bumped when the rendering changes, so cached files are not reused. */
const FIELD_VERSION = 2;

/** The raster a canvas is drawn from: the canvas itself, pixel for pixel,
 * unless its long side is past FIELD_TEXTURE_MAX; then scaled down to it,
 * keeping the aspect (a tall scrolling card is the only case). */
export function fieldTexture(canvas: Size): Size {
  const long = Math.max(canvas.width, canvas.height);
  if (long <= FIELD_TEXTURE_MAX) return { width: Math.max(1, Math.round(canvas.width)), height: Math.max(1, Math.round(canvas.height)) };
  const k = FIELD_TEXTURE_MAX / long;
  return { width: Math.max(1, Math.min(FIELD_TEXTURE_MAX, Math.round(canvas.width * k))), height: Math.max(1, Math.min(FIELD_TEXTURE_MAX, Math.round(canvas.height * k))) };
}

interface Prepared {
  bg: [number, number, number];
  blobs: { cx: number; cy: number; cos: number; sin: number; ix2: number; iy2: number; s: number; lab: [number, number, number] }[];
  vignette: number; W: number; H: number;
}

function prepare(field: ColourField, canvas: Size): Prepared {
  const G = Math.sqrt(canvas.width * canvas.height);
  return {
    bg: oklab(fitGamut(field.background)),
    blobs: field.blobs.map((b) => {
      const t = ((b.angle ?? 0) * Math.PI) / 180, rx = Math.max(1e-6, b.rx * G), ry = Math.max(1e-6, b.ry * G);
      return { cx: b.x * canvas.width, cy: b.y * canvas.height, cos: Math.cos(t), sin: Math.sin(t), ix2: 0.5 / (rx * rx), iy2: 0.5 / (ry * ry),
        s: Math.min(1, Math.max(0, b.strength ?? 1)), lab: oklab(fitGamut(b.color)) };
    }),
    vignette: Math.min(1, Math.max(0, field.vignette ?? 0)), W: canvas.width, H: canvas.height,
  };
}

/** OKLab at canvas point (px, py), before grain. */
function labAt(p: Prepared, px: number, py: number, out: Float64Array): void {
  let L = p.bg[0], A = p.bg[1], B = p.bg[2];
  for (const b of p.blobs) {
    const dx = px - b.cx, dy = py - b.cy;
    const u = dx * b.cos + dy * b.sin, v = -dx * b.sin + dy * b.cos;
    const w = b.s * Math.exp(-(u * u * b.ix2 + v * v * b.iy2));
    L += (b.lab[0] - L) * w; A += (b.lab[1] - A) * w; B += (b.lab[2] - B) * w;
  }
  if (p.vignette) {
    const vx = px / p.W - 0.5, vy = py / p.H - 0.5;
    L *= 1 - p.vignette * 2 * (vx * vx + vy * vy); // 0 at the centre, `vignette` at the corners
  }
  out[0] = L; out[1] = A; out[2] = B;
}

/** The field's colour at a canvas point, #rrggbb (no grain): what text over it is checked against. */
export function fieldColorAt(field: ColourField, canvas: Size, px: number, py: number): string {
  const lab = new Float64Array(3);
  labAt(prepare(field, canvas), px, py, lab);
  return `#${labToLinear(lab[0]!, lab[1]!, lab[2]!).map((v) => Math.round(toGamma(Math.min(1, Math.max(0, v))) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** linear [0,1] → sRGB 0..255 (unrounded), fine enough that the dark end has sub-level steps. */
const GAMMA_STEPS = 16384;
let gammaLut: Float32Array | undefined;
function gamma(): Float32Array {
  if (!gammaLut) {
    gammaLut = new Float32Array(GAMMA_STEPS + 1);
    for (let i = 0; i <= GAMMA_STEPS; i++) gammaLut[i] = toGamma(i / GAMMA_STEPS) * 255;
  }
  return gammaLut;
}

/** A 32-bit integer hash (lowbias32): stateless, so every pixel's grain depends only on (x, y, seed). */
function hash(n: number): number {
  n ^= n >>> 16; n = Math.imul(n, 0x7feb352d); n ^= n >>> 15; n = Math.imul(n, 0x846ca68b); n ^= n >>> 16;
  return n >>> 0;
}

/**
 * Rasterises the field: `canvas` is the geometry the blobs are laid out on,
 * `raster` the pixel grid sampled from it (the canvas stretched onto it, pixel
 * centres mapped back). Returns 8-bit RGB, row-major.
 */
export function renderField(field: ColourField, canvas: Size, raster: Size = canvas): Uint8Array {
  const p = prepare(field, canvas), lut = gamma();
  const { width, height } = raster;
  const rgb = new Uint8Array(width * height * 3);
  const amp = Math.min(0.05, Math.max(0, field.grain ?? 0.012)) * 255, seed = hash((field.seed ?? 1) >>> 0 ^ 0x9e3779b9);
  const sx = canvas.width / width, sy = canvas.height / height;
  const lab = new Float64Array(3);
  const lin = (v: number) => lut[v <= 0 ? 0 : v >= 1 ? GAMMA_STEPS : Math.round(v * GAMMA_STEPS)]!;
  let o = 0;
  for (let j = 0; j < height; j++) {
    const py = (j + 0.5) * sy;
    for (let i = 0; i < width; i++) {
      labAt(p, (i + 0.5) * sx, py, lab);
      const L = lab[0]!, A = lab[1]!, B = lab[2]!;
      const l_ = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
      const m_ = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
      const s_ = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
      // Triangular grain, the same offset on all three channels (monochrome).
      let g = 0;
      if (amp) {
        const h = hash((j * 0x10000 + i) ^ seed);
        g = (((h & 0xffff) + (h >>> 16)) / 65535 - 1) * amp;
      }
      const r = lin(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_) + g;
      const gg = lin(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_) + g;
      const b = lin(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_) + g;
      rgb[o++] = r <= 0 ? 0 : r >= 255 ? 255 : Math.round(r);
      rgb[o++] = gg <= 0 ? 0 : gg >= 255 ? 255 : Math.round(gg);
      rgb[o++] = b <= 0 ? 0 : b >= 255 ? 255 : Math.round(b);
    }
  }
  return rgb;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(bytes: Uint8Array, crc = 0): number {
  crc = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return ~crc >>> 0;
}

/** An 8-bit RGB PNG (colour type 2, no interlace). Rows use the Sub filter: grain compresses poorly either way, and Sub is the cheapest that helps. */
export function encodePng(width: number, height: number, rgb: Uint8Array, level = 3): Uint8Array {
  if (rgb.length !== width * height * 3) throw new Error("encodePng: rgb length does not match the size");
  const stride = width * 3, raw = new Uint8Array((stride + 1) * height);
  for (let j = 0; j < height; j++) {
    const row = j * stride, at = j * (stride + 1);
    raw[at] = 1; // Sub
    for (let k = 0; k < stride; k++) raw[at + 1 + k] = (rgb[row + k]! - (k >= 3 ? rgb[row + k - 3]! : 0)) & 0xff;
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width); iv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolour
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level }))), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { png.set(p, o); o += p.length; }
  return png;
}

/** The field as a PNG of `raster` pixels (default: the canvas itself). */
export function fieldPng(field: ColourField, canvas: Size, raster: Size = canvas): Uint8Array {
  return encodePng(raster.width, raster.height, renderField(field, canvas, raster));
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;
const lch = (c: Oklch) => [round(c.l), round(c.c), round(c.h)];
/** A stable key for the rendered bytes: every parameter that changes them, in a fixed order. */
export function fieldKey(field: ColourField, canvas: Size, raster: Size = canvas): string {
  const canonical = [FIELD_VERSION, lch(field.background),
    field.blobs.map((b) => [round(b.x), round(b.y), round(b.rx), round(b.ry), round(b.angle ?? 0), lch(b.color), round(b.strength ?? 1)]),
    round(field.grain ?? 0.012), round(field.vignette ?? 0), field.seed ?? 1, canvas.width, canvas.height, raster.width, raster.height];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}

/** The field as the engine draws it from a raster stretched `stretch` times: the
 * grain shrinks by the stretch (never below one 8-bit level), since noise
 * magnified by bilinear sampling reads as a woven crosshatch, not grain. A
 * raster at canvas size (every canvas up to 2048 px) keeps the full grain. */
export function textureField(field: ColourField, canvas: Size, raster: Size): ColourField {
  const stretch = Math.max(canvas.width / raster.width, canvas.height / raster.height, 1);
  const grain = field.grain ?? 0.012;
  return { ...field, grain: grain && Math.max(1 / 255, grain / stretch) };
}

/**
 * Writes the field for `canvas` into the composition directory as
 * `bg_<key>.png` (at canvas size up to 2048 px, see fieldTexture) and returns
 * the file name. Rendered once per key into `cacheDir`, copied after that.
 */
export async function stageField(field: ColourField, canvas: Size, cacheDir: string, compositionDir: string): Promise<string> {
  const raster = fieldTexture(canvas);
  field = textureField(field, canvas, raster);
  const key = fieldKey(field, canvas, raster);
  const name = `bg_${key}.png`, cached = join(cacheDir, name);
  if (!existsSync(cached)) {
    await mkdir(cacheDir, { recursive: true });
    const temp = `${cached}.${process.pid}.tmp`;
    await writeFile(temp, fieldPng(field, canvas, raster));
    await rename(temp, cached);
  }
  await copyFile(cached, join(compositionDir, name));
  return name;
}

/**
 * Colour fields for the code template's terminal style: `indigo` is its
 * backdrop in PNG and MP4 (GIF keeps the hue arc); the others are samples. Each keeps two or three neighbouring hues on a dark ground,
 * with one light source, so the dark code window stands out from what is
 * around it and the signature (white) keeps 4.5:1 at the foot.
 */
export const CODE_FIELDS = {
  /** Indigo night: deep indigo and violet, a touch of magenta low right; light from the top left. */
  indigo: {
    background: { l: 0.23, c: 0.075, h: 278 },
    blobs: [
      { x: 0.08, y: 0.95, rx: 0.42, ry: 0.28, angle: -8, color: { l: 0.3, c: 0.12, h: 284 }, strength: 0.75 },
      { x: 0.86, y: 0.35, rx: 0.42, ry: 0.5, color: { l: 0.34, c: 0.14, h: 270 }, strength: 0.9 },
      { x: 0.8, y: 1.0, rx: 0.4, ry: 0.24, angle: -12, color: { l: 0.42, c: 0.16, h: 326 }, strength: 0.75 },
      { x: 0.14, y: 0.08, rx: 0.52, ry: 0.38, angle: 18, color: { l: 0.55, c: 0.16, h: 292 }, strength: 0.95 },
    ],
    grain: 0.012, vignette: 0.12, seed: 7,
  },
  /** Dusk: violet into rose with a little amber at the top right, kept dark. */
  dusk: {
    background: { l: 0.22, c: 0.065, h: 320 },
    blobs: [
      { x: 0.05, y: 0.75, rx: 0.46, ry: 0.5, color: { l: 0.34, c: 0.13, h: 298 }, strength: 0.9 },
      { x: 0.9, y: 1.0, rx: 0.4, ry: 0.26, angle: 10, color: { l: 0.33, c: 0.11, h: 345 }, strength: 0.75 },
      { x: 0.6, y: 0.18, rx: 0.5, ry: 0.34, angle: -10, color: { l: 0.5, c: 0.145, h: 8 }, strength: 0.9 },
      { x: 0.98, y: 0.0, rx: 0.3, ry: 0.22, angle: -25, color: { l: 0.66, c: 0.13, h: 58 }, strength: 0.75 },
    ],
    grain: 0.012, vignette: 0.12, seed: 11,
  },
  /** Aurora: cool blue into teal with a hint of green along the top, light from the top left. */
  aurora: {
    background: { l: 0.21, c: 0.05, h: 250 },
    blobs: [
      { x: 0.08, y: 0.95, rx: 0.42, ry: 0.28, angle: -8, color: { l: 0.29, c: 0.09, h: 232 }, strength: 0.75 },
      { x: 0.9, y: 0.85, rx: 0.42, ry: 0.4, color: { l: 0.33, c: 0.11, h: 262 }, strength: 0.85 },
      { x: 0.14, y: 0.1, rx: 0.5, ry: 0.36, angle: 15, color: { l: 0.5, c: 0.11, h: 238 }, strength: 0.95 },
      { x: 0.62, y: 0.05, rx: 0.4, ry: 0.22, angle: 5, color: { l: 0.54, c: 0.1, h: 198 }, strength: 0.85 },
      { x: 0.95, y: -0.04, rx: 0.26, ry: 0.16, angle: -10, color: { l: 0.62, c: 0.12, h: 160 }, strength: 0.5 },
    ],
    grain: 0.012, vignette: 0.12, seed: 13,
  },
} as const satisfies Record<string, ColourField>;
