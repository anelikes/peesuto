/**
 * Which characters a font file maps (its Unicode cmap), read straight from
 * the file: the table directory and the cmap table only, never the whole
 * font. TrueType and OpenType/CFF files, the first face of a collection and
 * WOFF2 (its one Brotli stream; cmap is never transformed); formats 4 and 12.
 * Results are cached per path.
 */
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";

function read(fd: number, at: number, length: number): DataView {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, at);
  if (n < length) throw new Error("truncated font");
  return new DataView(buf.buffer, buf.byteOffset, length);
}

/** A set-like view of the code points a font maps. */
export interface CodepointSet { has(codepoint: number): boolean }

class Ranges implements CodepointSet {
  constructor(private readonly starts: Uint32Array, private readonly ends: Uint32Array) {}
  has(c: number): boolean {
    let lo = 0, hi = this.starts.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (c < this.starts[m]!) hi = m - 1;
      else if (c > this.ends[m]!) lo = m + 1;
      else return true;
    }
    return false;
  }
}

const cache = new Map<string, CodepointSet | null>();

/** The Unicode ranges of a cmap table (formats 12, else 4). */
function parseCmap(cmap: DataView): CodepointSet {
  const cmapLength = cmap.byteLength;
  const subtables = cmap.getUint16(2);
  let best = -1, bestFormat = 0;
  for (let i = 0; i < subtables; i++) {
    const platform = cmap.getUint16(4 + i * 8), encoding = cmap.getUint16(6 + i * 8), offset = cmap.getUint32(8 + i * 8);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode || offset + 2 > cmapLength) continue;
    const format = cmap.getUint16(offset);
    if (format === 12 && bestFormat !== 12) { best = offset; bestFormat = 12; }
    else if (format === 4 && bestFormat === 0) { best = offset; bestFormat = 4; }
  }
  if (best < 0) throw new Error("no Unicode cmap");
  const starts: number[] = [], ends: number[] = [];
  if (bestFormat === 12) {
    const groups = cmap.getUint32(best + 12);
    for (let g = 0; g < groups; g++) {
      const at = best + 16 + g * 12;
      if (cmap.getUint32(at + 8) === 0 && cmap.getUint32(at) === cmap.getUint32(at + 4)) continue;
      starts.push(cmap.getUint32(at)); ends.push(cmap.getUint32(at + 4));
    }
  } else {
    const segments = cmap.getUint16(best + 6) / 2;
    const endAt = best + 14, startAt = endAt + segments * 2 + 2, deltaAt = startAt + segments * 2, rangeAt = deltaAt + segments * 2;
    for (let s = 0; s < segments; s++) {
      const start = cmap.getUint16(startAt + s * 2), end = cmap.getUint16(endAt + s * 2);
      if (start === 0xffff) continue;
      const delta = cmap.getUint16(deltaAt + s * 2), rangeOffset = cmap.getUint16(rangeAt + s * 2);
      // A code point maps when its glyph id is not 0 (looked up per point only for the idRangeOffset form).
      for (let c = start; c <= end; c++) {
        let glyph: number;
        if (rangeOffset === 0) glyph = (c + delta) & 0xffff;
        else {
          const at = rangeAt + s * 2 + rangeOffset + (c - start) * 2;
          glyph = at + 2 <= cmapLength ? cmap.getUint16(at) : 0;
          if (glyph) glyph = (glyph + delta) & 0xffff;
        }
        if (!glyph) continue;
        if (ends.length && ends[ends.length - 1] === c - 1) ends[ends.length - 1] = c;
        else { starts.push(c); ends.push(c); }
      }
    }
  }
  const order = starts.map((_, i) => i).sort((a, b) => starts[a]! - starts[b]!);
  return new Ranges(Uint32Array.from(order.map((i) => starts[i]!)), Uint32Array.from(order.map((i) => ends[i]!)));
}

/** WOFF2 (the whole file: its tables are one Brotli stream): the cmap table, which WOFF2 never transforms. */
function woff2Cmap(file: Uint8Array): DataView {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const tables = v.getUint16(12), compressed = v.getUint32(20);
  let at = 48;
  const base128 = () => {
    let n = 0;
    for (let i = 0; i < 5; i++) { const b = v.getUint8(at++); n = n * 128 + (b & 0x7f); if (!(b & 0x80)) return n; }
    throw new Error("bad UIntBase128");
  };
  let offset = 0, found: { offset: number; length: number } | undefined;
  for (let i = 0; i < tables; i++) {
    const flags = v.getUint8(at++), index = flags & 0x3f, version = flags >> 6;
    let tag = index;
    if (index === 63) { tag = -v.getUint32(at); at += 4; }
    const orig = base128();
    // glyf (10) and loca (11) are transformed at version 0, hmtx (3) at version 1; nothing else is.
    const transformed = (tag === 10 || tag === 11) ? version === 0 : tag === 3 ? version === 1 : false;
    const length = transformed ? base128() : orig;
    if (tag === 0) found = { offset, length };
    offset += length;
  }
  if (!found) throw new Error("no cmap");
  const stream = brotliDecompressSync(file.subarray(at, at + compressed));
  return new DataView(stream.buffer, stream.byteOffset + found.offset, found.length);
}

/** The code points `path` maps, or null when it is not a font this reader understands (WOFF 1, damaged). */
export function fontCodepoints(path: string): CodepointSet | null {
  if (cache.has(path)) return cache.get(path)!;
  let result: CodepointSet | null = null;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    let base = 0;
    const tag = read(fd, 0, 4).getUint32(0);
    if (tag === 0x774f4632) { // 'wOF2'
      result = parseCmap(woff2Cmap(readFileSync(path)));
    } else {
      if (tag === 0x74746366) base = read(fd, 12, 4).getUint32(0); // 'ttcf': the first face
      const head = read(fd, base, 12);
      const version = head.getUint32(0);
      if (version !== 0x00010000 && version !== 0x4f54544f && version !== 0x74727565) throw new Error("not an sfnt");
      const tables = head.getUint16(4);
      const dir = read(fd, base + 12, tables * 16);
      let cmapAt = -1, cmapLength = 0;
      for (let i = 0; i < tables; i++) if (dir.getUint32(i * 16) === 0x636d6170) { cmapAt = dir.getUint32(i * 16 + 8); cmapLength = dir.getUint32(i * 16 + 12); }
      if (cmapAt < 0) throw new Error("no cmap");
      result = parseCmap(read(fd, cmapAt, cmapLength));
    }
  } catch { result = null; }
  finally { if (fd !== undefined) closeSync(fd); }
  cache.set(path, result);
  return result;
}

/** Characters nothing draws: whitespace, joiners, variation selectors. */
export const invisible = (c: number): boolean =>
  c <= 0x20 || c === 0x3000 || c === 0xa0 || (c >= 0x200b && c <= 0x200f) || c === 0x2060 || c === 0xfeff || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0xe0100 && c <= 0xe01ef);
