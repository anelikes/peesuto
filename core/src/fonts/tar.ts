/**
 * The font-pack container: a plain POSIX (ustar) tar of flat, regular files.
 * WOFF2 is already compressed, so the tar is not. The writer is
 * deterministic (mode 0644, owner 0, mtime 0, names in the order given) so a
 * rebuild from the same fonts gives the same bytes and the same SHA-256.
 *
 * The reader is strict on purpose: only regular files with plain names
 * (letters, digits, dot, dash, underscore; no directories, links or paths)
 * are accepted, and it streams each file to disk without holding the pack
 * in memory. A pack is only read after its SHA-256 matched the manifest.
 */
import { open } from "node:fs/promises";
import { join } from "node:path";

export class TarError extends Error {}

export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const BLOCK = 512;

/** A tar of `files`, in order. */
export function writeTar(files: readonly { name: string; data: Uint8Array }[]): Uint8Array {
  let total = 2 * BLOCK;
  for (const f of files) total += BLOCK + Math.ceil(f.data.length / BLOCK) * BLOCK;
  const out = new Uint8Array(total);
  let p = 0;
  const seen = new Set<string>();
  for (const f of files) {
    if (!SAFE_NAME.test(f.name) || f.name.endsWith(".")) throw new TarError(`unsafe file name ${JSON.stringify(f.name)}`);
    if (seen.has(f.name)) throw new TarError(`duplicate file ${f.name}`);
    seen.add(f.name);
    const h = out.subarray(p, p + BLOCK);
    const put = (at: number, s: string) => { for (let i = 0; i < s.length; i++) h[at + i] = s.charCodeAt(i); };
    put(0, f.name);
    put(100, "0000644\0");
    put(108, "0000000\0");
    put(116, "0000000\0");
    put(124, f.data.length.toString(8).padStart(11, "0") + "\0");
    put(136, "00000000000\0");
    put(148, "        ");
    h[156] = 0x30; // '0': regular file
    put(257, "ustar\0");
    put(263, "00");
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += h[i]!;
    put(148, sum.toString(8).padStart(6, "0") + "\0 ");
    out.set(f.data, p + BLOCK);
    p += BLOCK + Math.ceil(f.data.length / BLOCK) * BLOCK;
  }
  return out;
}

export interface TarEntry { readonly name: string; readonly size: number }

/** Extract every file of the tar at `tarPath` into the existing directory `dir`. Returns the entries in order. */
export async function extractTar(tarPath: string, dir: string): Promise<TarEntry[]> {
  const fh = await open(tarPath, "r");
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  try {
    const size = (await fh.stat()).size;
    const h = Buffer.alloc(BLOCK);
    const chunk = Buffer.alloc(1 << 20);
    let p = 0;
    for (;;) {
      if (p + BLOCK > size) throw new TarError("tar ends without its end-of-archive blocks");
      await readFully(fh, h, p);
      if (h.every((b) => b === 0)) break;
      let sum = 0;
      for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
      const stored = parseInt(h.toString("latin1", 148, 156).replace(/[\0 ]+$/g, "").trim(), 8);
      if (stored !== sum) throw new TarError(`bad header checksum at byte ${p}`);
      const name = cstr(h, 0, 100);
      const prefix = h.toString("latin1", 257, 262) === "ustar" ? cstr(h, 345, 155) : "";
      if (prefix) throw new TarError(`unexpected path ${prefix}/${name}`);
      const type = h[156]!;
      if (type !== 0x30 && type !== 0) throw new TarError(`${name}: only regular files are allowed`);
      if (!SAFE_NAME.test(name) || name.endsWith(".")) throw new TarError(`unsafe file name ${JSON.stringify(name)}`);
      if (seen.has(name)) throw new TarError(`duplicate file ${name}`);
      seen.add(name);
      const len = parseInt(cstr(h, 124, 12).trim() || "0", 8);
      if (!Number.isSafeInteger(len) || len < 0) throw new TarError(`${name}: bad size`);
      p += BLOCK;
      if (p + len > size) throw new TarError(`${name}: truncated`);
      const out = await open(join(dir, name), "wx");
      try {
        let left = len, at = p;
        while (left > 0) {
          const n = Math.min(left, chunk.length);
          await readFully(fh, chunk.subarray(0, n), at);
          await out.write(chunk.subarray(0, n));
          left -= n; at += n;
        }
      } finally { await out.close(); }
      entries.push({ name, size: len });
      p += Math.ceil(len / BLOCK) * BLOCK;
    }
    return entries;
  } finally { await fh.close(); }
}

async function readFully(fh: Awaited<ReturnType<typeof open>>, into: Uint8Array, at: number): Promise<void> {
  let got = 0;
  while (got < into.length) {
    const { bytesRead } = await fh.read(into, got, into.length - got, at + got);
    if (!bytesRead) throw new TarError("unexpected end of tar");
    got += bytesRead;
  }
}

function cstr(b: Buffer, at: number, len: number): string {
  const end = b.indexOf(0, at);
  return b.toString("utf8", at, end >= 0 && end < at + len ? end : at + len);
}
