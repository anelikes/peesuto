#!/usr/bin/env bun
/**
 * Draws the app icon and the menu-bar (template) icon without an image
 * library: every shape is a signed-distance rounded rectangle, sampled 4×4
 * per pixel and written as an RGBA PNG through node:zlib.
 *
 *   bun scripts/icons.ts          # app-icon.png, src-tauri/icons/tray.png, tray@2x.png
 *   bun tauri icon app-icon.png   # then every platform size from app-icon.png
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const APP = dirname(dirname(fileURLToPath(import.meta.url)));

type RGBA = readonly [number, number, number, number];
interface Shape { x: number; y: number; w: number; h: number; r: number; color?: RGBA; erase?: boolean }

const ACCENT: RGBA = [0x2b, 0x6c, 0xf3, 255];
const WHITE: RGBA = [255, 255, 255, 255];
const INK: RGBA = [0x1d, 0x1d, 0x1f, 255];
const INK_SOFT: RGBA = [0x1d, 0x1d, 0x1f, 120];
const BLACK: RGBA = [0, 0, 0, 255];

function sdRoundRect(px: number, py: number, s: Shape): number {
  const qx = Math.abs(px - (s.x + s.w / 2)) - (s.w / 2 - s.r);
  const qy = Math.abs(py - (s.y + s.h / 2)) - (s.h / 2 - s.r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - s.r;
}

function raster(size: number, shapes: readonly Shape[]): Uint8Array {
  const SS = 4;
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let pr = 0, pg = 0, pb = 0, pa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS;
          let r = 0, g = 0, b = 0, a = 0;
          for (const s of shapes) {
            if (sdRoundRect(fx, fy, s) > 0) continue;
            if (s.erase) { r = g = b = a = 0; continue; }
            const [cr, cg, cb, ca] = s.color ?? BLACK;
            const al = ca / 255;
            r = cr * al + r * (1 - al); g = cg * al + g * (1 - al); b = cb * al + b * (1 - al); a = al + a * (1 - al);
          }
          pr += r * a; pg += g * a; pb += b * a; pa += a;
        }
      }
      const i = (y * size + x) * 4;
      if (pa > 0) { out[i] = pr / pa; out[i + 1] = pg / pa; out[i + 2] = pb / pa; }
      out[i + 3] = (pa / (SS * SS)) * 255;
    }
  }
  return out;
}

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf: Uint8Array): number { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function png(size: number, rgba: Uint8Array): Uint8Array {
  const stride = size * 4 + 1;
  const raw = new Uint8Array(stride * size);
  for (let y = 0; y < size; y++) raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * stride + 1);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size); dv.setUint32(4, size); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}

/** A card with a title line and three text lines on the accent ground. */
function appIcon(S: number): Shape[] {
  const k = (v: number) => v * S;
  return [
    { x: k(0.06), y: k(0.06), w: k(0.88), h: k(0.88), r: k(0.2), color: ACCENT },
    { x: k(0.27), y: k(0.21), w: k(0.46), h: k(0.58), r: k(0.055), color: WHITE },
    { x: k(0.34), y: k(0.30), w: k(0.22), h: k(0.06), r: k(0.03), color: INK },
    { x: k(0.34), y: k(0.42), w: k(0.32), h: k(0.036), r: k(0.018), color: INK_SOFT },
    { x: k(0.34), y: k(0.50), w: k(0.28), h: k(0.036), r: k(0.018), color: INK_SOFT },
    { x: k(0.34), y: k(0.58), w: k(0.20), h: k(0.036), r: k(0.018), color: INK_SOFT },
  ];
}

/** The same card as a black silhouette with the lines knocked out: a macOS template image. */
function trayIcon(S: number): Shape[] {
  const k = (v: number) => (v * S) / 22;
  return [
    { x: k(3), y: k(4), w: k(16), h: k(14), r: k(2.5), color: BLACK },
    { x: k(6), y: k(7.2), w: k(7), h: k(1.7), r: k(0.85), erase: true },
    { x: k(6), y: k(10.2), w: k(10), h: k(1.7), r: k(0.85), erase: true },
    { x: k(6), y: k(13.2), w: k(8), h: k(1.7), r: k(0.85), erase: true },
  ];
}

const jobs: readonly [string, number, (s: number) => Shape[]][] = [
  ["app-icon.png", 1024, appIcon],
  ["src-tauri/icons/tray.png", 22, trayIcon],
  ["src-tauri/icons/tray@2x.png", 44, trayIcon],
];
for (const [file, size, shapes] of jobs) {
  const bytes = png(size, raster(size, shapes(size)));
  writeFileSync(join(APP, file), bytes);
  console.log(`${file}  ${size}×${size}  ${bytes.length} bytes`);
}
