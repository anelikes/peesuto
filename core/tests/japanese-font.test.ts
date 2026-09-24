/** Japanese text is set in Peesuto Text/Code (JIS X 0208 kanji, kana, half-width
 * katakana), not the Noto Sans SC fallback. The engine half runs only with
 * PEESUTO_TEMPLATE_ENGINE=<prepared engine copy>, like template-engine.test.ts. */
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { CODE_FONT, CODE_FONT_DIR, TEXT_FONT, chooseTemplateFont } from "../src/templates/compose.ts";
import { renderTemplate } from "../src/templates/render.ts";
import { samplePlan } from "./fixtures/templates.ts";

const SAMPLE = "今日は良い天気ですね。込む・働く・峠・辻、々〆ヶゝゞヽヾ「カタカナ」ｶﾞｷﾞｸﾞ、ＡＢＣ１２３、塡剝頰";

/** Code points of the font's Windows Unicode BMP cmap (format 4, the only one Peesuto fonts carry). */
async function cmap(file: string): Promise<Set<number>> {
  const view = new DataView(await Bun.file(join(CODE_FONT_DIR, file)).arrayBuffer());
  const tables = view.getUint16(4);
  let cmapOffset = 0;
  for (let i = 0; i < tables; i++) {
    const record = 12 + i * 16;
    if (String.fromCharCode(...[0, 1, 2, 3].map((k) => view.getUint8(record + k))) === "cmap") cmapOffset = view.getUint32(record + 8);
  }
  const out = new Set<number>();
  for (let i = 0; i < view.getUint16(cmapOffset + 2); i++) {
    const record = cmapOffset + 4 + i * 8;
    if (view.getUint16(record) !== 3 || view.getUint16(record + 2) !== 1) continue;
    const sub = cmapOffset + view.getUint32(record + 4);
    expect(view.getUint16(sub)).toBe(4);
    const segments = view.getUint16(sub + 6) / 2;
    const ends = sub + 14, starts = ends + segments * 2 + 2, deltas = starts + segments * 2, ranges = deltas + segments * 2;
    for (let s = 0; s < segments; s++) {
      const end = view.getUint16(ends + s * 2), start = view.getUint16(starts + s * 2);
      const delta = view.getInt16(deltas + s * 2), rangeOffset = view.getUint16(ranges + s * 2);
      for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
        const glyph = rangeOffset === 0 ? (cp + delta) & 0xffff : view.getUint16(ranges + s * 2 + rangeOffset + (cp - start) * 2);
        if (glyph !== 0) out.add(cp);
      }
    }
  }
  return out;
}

describe("Japanese in the Maple cuts", () => {
  test("Peesuto Text and Code map every character of a Japanese sample", async () => {
    for (const file of [TEXT_FONT.regular, TEXT_FONT.bold, CODE_FONT.regular, CODE_FONT.bold]) {
      const have = await cmap(file);
      const missing = [...SAMPLE].filter((c) => !have.has(c.codePointAt(0)!));
      expect({ file, missing }).toEqual({ file, missing: [] });
      // GB2312 and the JetBrains Mono symbols are still there.
      expect([..."简体中文⌘⌥"].every((c) => have.has(c.codePointAt(0)!))).toBe(true);
    }
  });

  test("so a Japanese card is set in Peesuto Text, and Japanese code in Peesuto Code", () => {
    expect(chooseTemplateFont("text", [])).toBe("peesuto-text");
    expect(chooseTemplateFont("chat", [])).toBe("peesuto-text");
    expect(chooseTemplateFont("code", [])).toBe("peesuto-code");
  });
});

const engine = process.env.PEESUTO_TEMPLATE_ENGINE ? resolve(process.env.PEESUTO_TEMPLATE_ENGINE) : undefined;
const output = resolve(process.env.PEESUTO_TEMPLATE_OUTPUT ?? ".work/template-samples");
const options = { engine: engine ?? "", work: join(output, "work"), emojiCache: join(output, "emoji"), emojiBundle: resolve(".work/emoji-all") };
(engine ? test : test.skip)("a Japanese card renders in Peesuto Text, not the Noto Sans SC fallback", async () => {
  const layoutFont = async () => (JSON.parse(await Bun.file(join(options.work, "compositions/paste/template-layout.json")).text()) as { font: string }).font;
  const text = "今日は良い天気ですね。込む・働く・峠・辻";
  const rendered = await renderTemplate({ ...samplePlan({ kind: "text", paragraphs: [text] }), sourceText: text }, { ...options, format: "png", out: join(output, "japanese-text.png") });
  expect(rendered.truncated).toBe(false);
  expect(await layoutFont()).toBe("peesuto-text");
  const code = "# 天気を取得する（ｶﾀｶﾅ）\ndef 天気(都市):\n    return 取得(都市)";
  await renderTemplate({ ...samplePlan({ kind: "code", code, language: "python" }), sourceText: code }, { ...options, format: "png", out: join(output, "japanese-code.png") });
  expect(await layoutFont()).toBe("peesuto-code");
}, 120_000);
