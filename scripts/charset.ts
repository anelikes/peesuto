#!/usr/bin/env bun
/**
 * charset — writes core/src/render/charset.txt, every character the
 * measurement cache bakes (compose.ts and templates/compose.ts pass it to the
 * engine's openMeasurer as `cache.charset`).
 *
 *   bun scripts/charset.ts           write the file
 *   bun scripts/charset.ts --check   exit 1 when the file is not what this writes
 *
 * A text whose characters are all in it is measured against a metrics-only
 * bake that is built once per work tree and boots in milliseconds; one
 * character outside it sends that render through a measurement build of its
 * own (3–4 s). So the set is what clipboard text is made of, in this order
 * (the order is kept so a regenerated file does not move):
 *
 *   1. ASCII 32–126 (the engine bakes it anyway).
 *   2. The common CJK punctuation, as first chosen by hand.
 *   3. GB2312 level 1: the 3755 common hanzi (rows 16–55).
 *   4. Kana: hiragana ぁ–ゖ, katakana ァ–ヺ, ー ヽ ヾ ゝ ゞ, and 々.
 *   5. JIS X 0208 level 1 kanji (rows 16–47, 2965) not already in 3.
 *   6. The punctuation, symbols and full-width forms of GB2312 rows 1–3 and
 *      JIS X 0208 rows 1–3 not already in 1–5 (「」『』・, the ideographic
 *      space, ♪ ※ ①, full-width digits and letters), and the wave dash 〜
 *      that Japanese input types (the tables decode that cell as ～).
 *
 * No newline: the file is the set, byte for byte. Changing it retires every
 * cached bake (the cache key hashes the charset); each is rebuilt once.
 */
import { join } from "node:path";
import { REPO_ROOT } from "../core/src/engine.ts";

export const CHARSET_PATH = join(REPO_ROOT, "core/src/render/charset.txt");

/** The hand-picked CJK punctuation of the first charset (part 2). */
const PUNCTUATION = "，。、；：？！“”‘’（）《》〈〉【】—…·～％";

/** One row of a 94×94 EUC table (GB2312 or JIS X 0208), cells that decode to one character. */
function row(decoder: TextDecoder, r: number, last = 94): string[] {
  const out: string[] = [];
  for (let c = 1; c <= last; c++) {
    const s = decoder.decode(new Uint8Array([0xa0 + r, 0xa0 + c]));
    if (s !== "�" && [...s].length === 1) out.push(s);
  }
  return out;
}
const rows = (decoder: TextDecoder, from: number, to: number, lastOfLast = 94) =>
  Array.from({ length: to - from + 1 }, (_, k) => row(decoder, from + k, from + k === to ? lastOfLast : 94)).flat();
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => String.fromCodePoint(from + k));

/** The charset, as written to charset.txt. */
export function charset(): string {
  const gb = new TextDecoder("gb2312"), jis = new TextDecoder("euc-jp");
  const parts: string[][] = [
    range(0x20, 0x7e),
    [...PUNCTUATION],
    rows(gb, 16, 55, 89),
    [...range(0x3041, 0x3096), ...range(0x30a1, 0x30fa), "ー", "ヽ", "ヾ", "ゝ", "ゞ", "々"],
    rows(jis, 16, 47, 51),
    [...rows(gb, 1, 3), ...rows(jis, 1, 3), "〜"],
  ];
  const seen = new Set<string>();
  let out = "";
  for (const part of parts) for (const c of part) if (!seen.has(c)) { seen.add(c); out += c; }
  return out;
}

if (import.meta.main) {
  const want = charset();
  const have = await Bun.file(CHARSET_PATH).text().catch(() => "");
  if (process.argv.includes("--check")) {
    if (have !== want) { console.error(`charset: ${CHARSET_PATH} is out of date; run bun scripts/charset.ts`); process.exit(1); }
    console.log(`charset: ${[...want].length} characters, up to date`);
  } else {
    await Bun.write(CHARSET_PATH, want);
    console.log(`charset: wrote ${[...want].length} characters (was ${[...have].length}) to ${CHARSET_PATH}`);
  }
}
