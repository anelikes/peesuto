/**
 * Who a font file says it is: family, weight and style from its `name` and
 * `OS/2` tables. Reads TrueType/OpenType (.ttf/.otf), collections (.ttc),
 * WOFF and WOFF2 without any dependency (zlib and brotli come with Bun).
 *
 * The family is the typographic family (name ID 16) when the font has one,
 * else name ID 1, which is what a canvas matches `ctx.font` against: a
 * static "Noto Sans JP Black" names itself "Noto Sans JP" (ID 16) at weight
 * 900 (usWeightClass).
 */
import { brotliDecompressSync, inflateSync } from "node:zlib";

export interface FontFace {
  /** English typographic family (ID 16), else English ID 1, else the same in any language. */
  readonly family: string;
  /** Every family name the font declares (IDs 1 and 16, all languages). */
  readonly names: readonly string[];
  readonly weight: number;
  readonly style: "normal" | "italic";
}

export class FontParseError extends Error {}

const bad = (m: string): never => { throw new FontParseError(m); };

/** Every face in a font file (one, or several for a collection). Throws FontParseError when it is not a font. */
export function fontFaces(data: Uint8Array): FontFace[] {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < 12) bad("too short to be a font");
  const sig = buf.toString("latin1", 0, 4);
  if (sig === "wOF2") return [woff2Face(buf)];
  if (sig === "wOFF") return [woffFace(buf)];
  if (sig === "ttcf") {
    const n = buf.readUInt32BE(8);
    if (n > 256 || 12 + 4 * n > buf.length) bad("bad collection header");
    return Array.from({ length: n }, (_, i) => faceFrom((tag) => sfntTable(buf, buf.readUInt32BE(12 + 4 * i), tag)));
  }
  if (sig === "\0\x01\0\0" || sig === "OTTO" || sig === "true") return [faceFrom((tag) => sfntTable(buf, 0, tag))];
  return bad("not a TrueType, OpenType, WOFF or WOFF2 font");
}

function sfntTable(buf: Buffer, off: number, want: string): Buffer | null {
  if (off + 12 > buf.length) bad("bad table directory");
  const n = buf.readUInt16BE(off + 4);
  for (let i = 0; i < n; i++) {
    const r = off + 12 + 16 * i;
    if (r + 16 > buf.length) bad("bad table directory");
    if (buf.toString("latin1", r, r + 4) !== want) continue;
    const at = buf.readUInt32BE(r + 8), len = buf.readUInt32BE(r + 12);
    if (at + len > buf.length) bad(`table ${want} out of range`);
    return buf.subarray(at, at + len);
  }
  return null;
}

function woffFace(buf: Buffer): FontFace {
  const n = buf.readUInt16BE(12);
  const table = (want: string): Buffer | null => {
    for (let i = 0; i < n; i++) {
      const r = 44 + 20 * i;
      if (r + 20 > buf.length) bad("bad WOFF directory");
      if (buf.toString("latin1", r, r + 4) !== want) continue;
      const at = buf.readUInt32BE(r + 4), comp = buf.readUInt32BE(r + 8), orig = buf.readUInt32BE(r + 12);
      if (at + comp > buf.length) bad(`table ${want} out of range`);
      const raw = buf.subarray(at, at + comp);
      return comp < orig ? inflateSync(raw) : raw;
    }
    return null;
  };
  return faceFrom(table);
}

// WOFF2 known-table tags, by the index a directory entry's flags carry.
const WOFF2_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT",
  "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH",
  "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar",
  "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
];

function woff2Face(buf: Buffer): FontFace {
  if (buf.toString("latin1", 4, 8) === "ttcf") bad("WOFF2 collections are not supported");
  const n = buf.readUInt16BE(12), compressed = buf.readUInt32BE(20);
  let p = 48;
  const base128 = (): number => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      if (p >= buf.length) bad("bad WOFF2 directory");
      const b = buf[p++]!;
      if (i === 0 && b === 0x80) bad("bad WOFF2 number");
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    return bad("bad WOFF2 number");
  };
  const dir: { tag: string; len: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (p >= buf.length) bad("bad WOFF2 directory");
    const flags = buf[p++]!;
    let tag: string;
    if ((flags & 0x3f) === 0x3f) { tag = buf.toString("latin1", p, p + 4); p += 4; }
    else tag = WOFF2_TAGS[flags & 0x3f] ?? bad("bad WOFF2 table tag");
    const version = (flags >> 6) & 3;
    const orig = base128();
    const transformed = tag === "glyf" || tag === "loca" ? version === 0 : version !== 0;
    dir.push({ tag, len: transformed ? base128() : orig });
  }
  if (p + compressed > buf.length) bad("WOFF2 data out of range");
  const data = brotliDecompressSync(buf.subarray(p, p + compressed));
  const offsets = new Map<string, Buffer>();
  let at = 0;
  for (const t of dir) { offsets.set(t.tag, data.subarray(at, at + t.len)); at += t.len; }
  if (at > data.length) bad("WOFF2 tables out of range");
  return faceFrom((tag) => offsets.get(tag) ?? null);
}

function faceFrom(table: (tag: string) => Buffer | null): FontFace {
  const name = table("name") ?? bad("no name table");
  const recs = nameRecords(name, [16, 1]);
  const pick = (rank: number) => recs.find((r) => r.id === 16 && r.rank === rank) ?? recs.find((r) => r.id === 1 && r.rank === rank);
  const family = (pick(0) ?? pick(1) ?? pick(2) ?? pick(3))?.text ?? bad("no family name");
  const os2 = table("OS/2");
  const weight = os2 && os2.length >= 6 ? os2.readUInt16BE(4) : 400;
  const sel = os2 && os2.length >= 64 ? os2.readUInt16BE(62) : 0;
  return { family, names: [...new Set(recs.map((r) => r.text))], weight, style: sel & 0x201 ? "italic" : "normal" };
}

/** Name records with these IDs; rank 0 = Windows English, 1 = other Windows, 2 = Unicode, 3 = Macintosh Roman. */
function nameRecords(t: Buffer, ids: readonly number[]): { id: number; rank: number; text: string }[] {
  if (t.length < 6) return [];
  const count = t.readUInt16BE(2), strings = t.readUInt16BE(4);
  const out: { id: number; rank: number; text: string }[] = [];
  for (let i = 0; i < count; i++) {
    const r = 6 + 12 * i;
    if (r + 12 > t.length) break;
    const id = t.readUInt16BE(r + 6);
    if (!ids.includes(id)) continue;
    const platform = t.readUInt16BE(r), encoding = t.readUInt16BE(r + 2), lang = t.readUInt16BE(r + 4), len = t.readUInt16BE(r + 8), off = strings + t.readUInt16BE(r + 10);
    if (off + len > t.length) continue;
    const raw = t.subarray(off, off + len);
    let rank: number, text: string;
    if (platform === 3 || platform === 0) { rank = platform === 3 && lang === 0x409 ? 0 : platform === 3 ? 1 : 2; text = utf16be(raw); }
    else if (platform === 1 && encoding === 0) { rank = 3; text = raw.toString("latin1"); }
    else continue;
    text = text.trim();
    if (text) out.push({ id, rank, text });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

function utf16be(b: Buffer): string {
  const s = Buffer.alloc(b.length - (b.length % 2));
  for (let i = 0; i + 1 < b.length; i += 2) { s[i] = b[i + 1]!; s[i + 1] = b[i]!; }
  return s.toString("utf16le");
}
