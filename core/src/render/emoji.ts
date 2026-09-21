/**
 * Emoji as pictures. The engine's atlases are single-channel coverage and the
 * faces carry no colour glyphs, so an emoji in the clipboard becomes an
 * `Image` node inline with the text: a 128x128 PNG from Noto Emoji at a
 * pinned tag (so the bytes are the same on every machine), drawn at the
 * line's font size and measured as one advance of that size when wrapping.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Noto Emoji at a fixed release; `png/128/emoji_u<cp>[_<cp>...].png`. */
const NOTO_TAG = "v2.047";
const NOTO_URL = (key: string) => `https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@${NOTO_TAG}/png/128/emoji_u${key}.png`;

/** An RGI-ish emoji sequence: a pictograph or keycap, with VS16, skin tones and ZWJ joins. */
export const EMOJI = /(?:\p{Extended_Pictographic}|[0-9#*]️?⃣)(?:️|[\u{1F3FB}-\u{1F3FF}]|‍\p{Extended_Pictographic}️?)*/gu;

export type Run = { readonly text: string } | { readonly emoji: string; readonly key: string };

/** Noto's file key: codepoints in lowercase hex, at least four digits, joined by `_`, VS16 dropped. */
export function notoKey(emoji: string): string {
  return [...emoji].map((c) => c.codePointAt(0)!).filter((cp) => cp !== 0xfe0f).map((cp) => cp.toString(16).padStart(4, "0")).join("_");
}

/** Split a line into text runs and emoji runs, in order. */
export function splitEmoji(line: string): Run[] {
  const runs: Run[] = [];
  let last = 0;
  for (const m of line.matchAll(EMOJI)) {
    if (m.index! > last) runs.push({ text: line.slice(last, m.index) });
    runs.push({ emoji: m[0], key: notoKey(m[0]) });
    last = m.index! + m[0].length;
  }
  if (last < line.length) runs.push({ text: line.slice(last) });
  return runs;
}

export const stripEmoji = (s: string): string => s.replace(EMOJI, "");
export const countEmoji = (s: string): number => (s.match(EMOJI) ?? []).length;

/**
 * Stage every distinct emoji's PNG beside the composition as `e_<key>.png`
 * and return the file names, for images.json. The picture comes from, in
 * order: a bundled set (`bundleDir/emoji_u<key>.png`, the whole of Noto
 * Emoji 128 px as `scripts/fetch-emoji.ts` lays it out — the app ships it),
 * the per-user cache (`cacheDir/<key>.png`), or a fetch from the CDN into
 * that cache. Offline with nothing bundled or cached, the error names the
 * emoji. A key Noto does not ship (a brand-new emoji) is reported, not
 * guessed.
 */
export async function stageEmoji(keys: Iterable<string>, cacheDir: string, compositionDir: string, bundleDir?: string): Promise<string[]> {
  await mkdir(cacheDir, { recursive: true });
  const names: string[] = [];
  for (const key of new Set(keys)) {
    const bundled = bundleDir ? join(bundleDir, `emoji_u${key}.png`) : undefined;
    const cached = join(cacheDir, `${key}.png`);
    let source = bundled && existsSync(bundled) ? bundled : cached;
    if (!existsSync(source)) {
      let res: Response;
      try { res = await fetch(NOTO_URL(key)); } catch (e) { throw new Error(`paste: emoji U+${key.toUpperCase().replaceAll("_", " U+")} is not bundled or cached and could not be fetched (${(e as Error).message})`); }
      if (!res.ok) throw new Error(`paste: Noto Emoji ${NOTO_TAG} has no png/128/emoji_u${key}.png (HTTP ${res.status})`);
      await Bun.write(cached, await res.arrayBuffer());
      source = cached;
    }
    const name = `e_${key}.png`;
    await copyFile(source, join(compositionDir, name));
    names.push(name);
  }
  return names;
}
