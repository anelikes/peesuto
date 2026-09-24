/**
 * Texture images for lyric motion, generated (seeded, so identical every
 * time) and cached: film grain, scanlines and a paper tooth. They lie over the
 * whole picture at a low alpha; none is drawn in a GIF (a 256-colour palette
 * turns grain into dither noise).
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodePng } from "./backdrop.ts";
import { generator } from "./lyrics.ts";

export type TextureKind = "grain" | "scanlines" | "paper";
/** Bumped when the drawing changes, so cached files are redrawn. */
const TEXTURE_VERSION = 3;

/**
 * RGBA pixels of one texture. The engine's rasteriser pays for every pixel
 * that is not fully transparent (a full-canvas image costs more than all the
 * type), so each texture is sparse: grain is specks on one pixel in forty,
 * scanlines one row in six, the paper tooth specks and short fibres.
 */
export function renderTexture(kind: TextureKind, width: number, height: number, alpha: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  const random = generator(0x5eed + width * 31 + height * 17 + kind.length);
  const a = Math.min(1, Math.max(0, alpha));
  const put = (i: number, v: number, al: number) => { rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = Math.round(Math.min(1, al) * 255); };
  switch (kind) {
    case "grain":
      // Light and dark specks at random strength: film grain on any ground.
      for (let i = 0; i < width * height; i++) if (random() < 1 / 40) put(i, random() < 0.5 ? 255 : 0, a * (2 + 3 * random()));
      break;
    case "scanlines":
      for (let y = 0; y < height; y += 6) for (let x = 0; x < width; x++) put(y * width + x, 0, a);
      break;
    case "paper": {
      // Warm dark specks, denser in soft blotches (value noise on a coarse grid), and short fibres.
      const cell = 24, gw = Math.ceil(width / cell) + 2, gh = Math.ceil(height / cell) + 2;
      const grid = Float32Array.from({ length: gw * gh }, () => random());
      const smooth = (t: number) => t * t * (3 - 2 * t);
      const tone = (i: number, al: number) => { rgba[i * 4] = 70; rgba[i * 4 + 1] = 55; rgba[i * 4 + 2] = 40; rgba[i * 4 + 3] = Math.round(Math.min(1, al) * 255); };
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const gx = x / cell, gy = y / cell, x0 = Math.floor(gx), y0 = Math.floor(gy), tx = smooth(gx - x0), ty = smooth(gy - y0);
        const v00 = grid[y0 * gw + x0]!, v10 = grid[y0 * gw + x0 + 1]!, v01 = grid[(y0 + 1) * gw + x0]!, v11 = grid[(y0 + 1) * gw + x0 + 1]!;
        const blotch = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
        if (random() < 0.015 + 0.035 * blotch) tone(y * width + x, a * (2 + 3 * random()));
      }
      for (let f = 0; f < (width * height) / 2400; f++) {
        let x = random() * width, y = random() * height;
        const angle = random() * Math.PI * 2, length = 4 + random() * 10;
        for (let k = 0; k < length; k++) { x += Math.cos(angle); y += Math.sin(angle); if (x >= 0 && y >= 0 && x < width && y < height) tone(Math.floor(y) * width + Math.floor(x), a * 2.5); }
      }
      break;
    }
  }
  return rgba;
}

/** Write the texture into the composition (a cached copy under `cacheDir`). */
export async function stageTexture(kind: TextureKind, width: number, height: number, alpha: number, file: string, cacheDir: string, compositionDir: string): Promise<void> {
  const key = `${kind}-${width}x${height}-${Math.round(alpha * 1000)}-v${TEXTURE_VERSION}.png`;
  const cached = join(cacheDir, key);
  if (!existsSync(cached)) {
    await mkdir(cacheDir, { recursive: true });
    const partial = `${cached}.${process.pid}.partial`;
    await writeFile(partial, encodePng(width, height, renderTexture(kind, width, height, alpha), 6, 4));
    await rename(partial, cached);
  }
  await copyFile(cached, join(compositionDir, file));
}
