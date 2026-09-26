/**
 * Pixel work on RGBA rasters, pure: no engine, no encoder. Shared by the
 * frame path in this thread (prepared.ts) and the frame workers
 * (frame-worker.ts), which must not load the GIF encoder.
 */

export interface Raster {
  readonly rgba: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * Area-average (box) resample of an RGBA raster to `dstWidth` px wide, the
 * height following the aspect. Each destination pixel is the exact mean of
 * the source area it covers, partial source pixels weighted by their overlap:
 * 1080 → 540 is a plain 2×2 mean, 1920 → 540 (3.56×) has no phase drift.
 * Separable, rows first into a float buffer, then columns. Alpha is dropped;
 * the output alpha is 255.
 */
export function downscaleBox(src: Uint8Array, srcWidth: number, srcHeight: number, dstWidth: number): Raster {
  if (src.length !== srcWidth * srcHeight * 4) {
    throw new RangeError(`downscaleBox: ${src.length} bytes is not ${srcWidth}x${srcHeight} RGBA`);
  }
  const { width: dw, height: dh } = scaledSize(srcWidth, srcHeight, dstWidth);
  const wx = axisWeights(srcWidth, dw);
  const wy = axisWeights(srcHeight, dh);

  // Rows: srcHeight × dw × RGB.
  const tmp = new Float32Array(srcHeight * dw * 3);
  for (let y = 0; y < srcHeight; y++) {
    const srow = y * srcWidth * 4;
    const trow = y * dw * 3;
    for (let x = 0; x < dw; x++) {
      const { start, weights } = wx[x]!;
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < weights.length; k++) {
        const wt = weights[k]!;
        const s = srow + (start + k) * 4;
        r += src[s]! * wt; g += src[s + 1]! * wt; b += src[s + 2]! * wt;
      }
      const t = trow + x * 3;
      tmp[t] = r; tmp[t + 1] = g; tmp[t + 2] = b;
    }
  }
  // Columns: dh × dw × RGBA.
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const { start, weights } = wy[y]!;
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < weights.length; k++) {
        const wt = weights[k]!;
        const t = ((start + k) * dw + x) * 3;
        r += tmp[t]! * wt; g += tmp[t + 1]! * wt; b += tmp[t + 2]! * wt;
      }
      const d = (y * dw + x) * 4;
      out[d] = clamp8(r); out[d + 1] = clamp8(g); out[d + 2] = clamp8(b); out[d + 3] = 255;
    }
  }
  return { rgba: out, width: dw, height: dh };
}

/**
 * For each destination index along one axis: the first source index it
 * touches and the weight of every source pixel it covers, summing to 1.
 * Destination pixel i spans source [i·s, (i+1)·s) with s = src/dst.
 */
function axisWeights(srcN: number, dstN: number): { start: number; weights: number[] }[] {
  const s = srcN / dstN;
  const table: { start: number; weights: number[] }[] = [];
  for (let i = 0; i < dstN; i++) {
    const a = i * s;
    const b = Math.min(srcN, (i + 1) * s);
    const start = Math.min(srcN - 1, Math.floor(a));
    const end = Math.max(start + 1, Math.min(srcN, Math.ceil(b)));
    const weights: number[] = [];
    let sum = 0;
    for (let j = start; j < end; j++) {
      const w = Math.max(0, Math.min(b, j + 1) - Math.max(a, j));
      weights.push(w);
      sum += w;
    }
    table.push({ start, weights: weights.map((w) => w / sum) });
  }
  return table;
}

const clamp8 = (v: number): number => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

/** The size `downscaleBox` produces for a `srcWidth`×`srcHeight` raster brought to `dstWidth` px wide. */
export function scaledSize(srcWidth: number, srcHeight: number, dstWidth: number): { readonly width: number; readonly height: number } {
  const width = Math.max(1, Math.round(dstWidth));
  return { width, height: Math.max(1, Math.round((srcHeight * width) / srcWidth)) };
}
