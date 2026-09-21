/**
 * The pure half of the GIF path — box downscale and gifenc encoding — on
 * synthetic RGBA frames. No engine, no ffmpeg; runs in milliseconds.
 */
import { describe, expect, test } from "bun:test";
import { downscaleBox, encodeGif } from "../src/render/gif.ts";

/** A gradient with a square that moves with `t`: thousands of distinct colours per frame. */
function frame(w: number, h: number, t: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inBox = x >= 20 + t * 30 && x < 60 + t * 30 && y >= 30 && y < 70;
      rgba[i] = inBox ? 240 : (x * 255) / (w - 1);
      rgba[i + 1] = inBox ? 60 : (y * 255) / (h - 1);
      rgba[i + 2] = inBox ? 60 : 128;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function solid(w: number, h: number, r: number, g: number, b: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255; }
  return rgba;
}

/** Walk the GIF block structure: enough to count frames and read the timing. */
function parseGif(b: Uint8Array) {
  const header = String.fromCharCode(...b.subarray(0, 6));
  const width = b[6]! | (b[7]! << 8);
  const height = b[8]! | (b[9]! << 8);
  const packed = b[10]!;
  const gctColors = packed & 0x80 ? 1 << ((packed & 7) + 1) : 0;
  let p = 13 + gctColors * 3;
  const delays: number[] = [], transparent: boolean[] = [], disposals: number[] = [];
  let images = 0, localTables = 0, loop: number | undefined, trailer = false;
  const skipSubBlocks = () => { while (b[p] !== 0) p += 1 + b[p]!; p++; };
  while (p < b.length) {
    const tag = b[p++]!;
    if (tag === 0x3b) { trailer = true; break; }
    if (tag === 0x21) {
      const label = b[p++]!;
      if (label === 0xf9) { delays.push(b[p + 2]! | (b[p + 3]! << 8)); transparent.push((b[p + 1]! & 1) === 1); disposals.push((b[p + 1]! >> 2) & 7); }
      if (label === 0xff && String.fromCharCode(...b.subarray(p + 1, p + 12)) === "NETSCAPE2.0") loop = b[p + 14]! | (b[p + 15]! << 8);
      skipSubBlocks();
    } else if (tag === 0x2c) {
      images++;
      const flags = b[p + 8]!;
      p += 9;
      if (flags & 0x80) { localTables++; p += 3 * (1 << ((flags & 7) + 1)); }
      p++; // LZW minimum code size
      skipSubBlocks();
    } else {
      throw new Error(`unknown block 0x${tag.toString(16)} at ${p - 1}`);
    }
  }
  return { header, width, height, gctColors, images, localTables, delays, transparent, disposals, loop, trailer };
}

describe("downscaleBox", () => {
  test("halves 200x100 to 100x50 and keeps a solid colour exact", () => {
    const r = downscaleBox(solid(200, 100, 10, 200, 30), 200, 100, 100);
    expect([r.width, r.height]).toEqual([100, 50]);
    expect(r.rgba.length).toBe(100 * 50 * 4);
    for (let i = 0; i < r.rgba.length; i += 4) {
      expect([r.rgba[i], r.rgba[i + 1], r.rgba[i + 2], r.rgba[i + 3]]).toEqual([10, 200, 30, 255]);
    }
  });

  test("averages the area it covers", () => {
    // 2x2 checkerboard of black and white → one grey pixel.
    const src = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
    const r = downscaleBox(src, 2, 2, 1);
    expect([r.width, r.height]).toEqual([1, 1]);
    expect([...r.rgba]).toEqual([128, 128, 128, 255]);
  });

  test("a non-integer ratio still sums each pixel's weights to one", () => {
    const r = downscaleBox(solid(7, 3, 77, 88, 99), 7, 3, 3);
    expect([r.width, r.height]).toEqual([3, 1]);
    for (let i = 0; i < r.rgba.length; i += 4) expect([r.rgba[i], r.rgba[i + 1], r.rgba[i + 2]]).toEqual([77, 88, 99]);
  });

  test("drops alpha", () => {
    const src = new Uint8Array([200, 100, 50, 0]);
    expect([...downscaleBox(src, 1, 1, 1).rgba]).toEqual([200, 100, 50, 255]);
  });

  test("refuses a buffer that is not the stated size", () => {
    expect(() => downscaleBox(new Uint8Array(10), 2, 2, 1)).toThrow(RangeError);
  });
});

describe("encodeGif", () => {
  test("4 frames 200x100 → a looping GIF89a at the requested width, one global 128-colour palette", () => {
    const scaled = [0, 1, 2, 3].map((t) => downscaleBox(frame(200, 100, t), 200, 100, 100));
    const t0 = performance.now();
    const gif = encodeGif(scaled.map((s) => s.rgba), 100, 50, { fps: 15 });
    const ms = performance.now() - t0;
    const g = parseGif(gif);
    expect(g.header).toBe("GIF89a");
    expect(g.width).toBe(100);
    expect(g.height).toBe(50);
    expect(g.images).toBe(4);
    expect(g.localTables).toBe(0);
    expect(g.gctColors).toBeGreaterThanOrEqual(2);
    expect(g.gctColors).toBeLessThanOrEqual(128);
    expect(g.loop).toBe(0);
    expect(g.trailer).toBe(true);
    // 15 fps is 6.67 cs per frame: 7, 6, 7, 7 — four frames end at round(400/15) = 27 cs.
    expect(g.delays).toEqual([7, 6, 7, 7]);
    // Deltas: the first frame is whole and opaque, the rest are transparent over it, all left in place.
    expect(g.transparent).toEqual([false, true, true, true]);
    expect(g.disposals).toEqual([1, 1, 1, 1]);
    expect(ms).toBeLessThan(1000);
  });

  test("deltas make a static sequence cheap; delta: false writes every frame whole", () => {
    const frames = Array.from({ length: 20 }, () => frame(200, 100, 0));
    const withDelta = encodeGif(frames, 200, 100, { fps: 15 });
    const whole = encodeGif(frames, 200, 100, { fps: 15, delta: false });
    expect(parseGif(withDelta).images).toBe(20);
    expect(parseGif(whole).images).toBe(20);
    expect(parseGif(whole).transparent.every((t) => !t)).toBe(true);
    expect(withDelta.length * 4).toBeLessThan(whole.length);
  });

  test("the reserved index is never used by an opaque pixel", () => {
    // Black pixels are nearest to palette[0]; the reserved slot copies that colour and must not attract them.
    const black = solid(16, 16, 0, 0, 0);
    const g = parseGif(encodeGif([black, black], 16, 16, { fps: 15, colors: 4 }));
    expect(g.images).toBe(2);
    expect(g.transparent).toEqual([false, true]);
  });

  test("delays keep the running clock on the rate", () => {
    const frames = Array.from({ length: 30 }, () => solid(8, 8, 1, 2, 3));
    const g = parseGif(encodeGif(frames, 8, 8, { fps: 15 }));
    expect(g.images).toBe(30);
    expect(g.delays.reduce((a, b) => a + b, 0)).toBe(200);
    expect(new Set(g.delays)).toEqual(new Set([6, 7]));
  });

  test("odd sizes and counts (a fractional capacity estimate) still encode", () => {
    const frames = [0, 1, 2].map((t) => frame(11, 11, t));
    const g = parseGif(encodeGif(frames, 11, 11, { fps: 15 }));
    expect([g.width, g.height, g.images]).toEqual([11, 11, 3]);
  });

  test("refuses no frames and a frame of the wrong size", () => {
    expect(() => encodeGif([], 1, 1, { fps: 15 })).toThrow(RangeError);
    expect(() => encodeGif([new Uint8Array(4)], 2, 1, { fps: 15 })).toThrow(RangeError);
  });
});
