/** Opt-in real-engine acceptance. Use an isolated prepared engine copy because
 * Pocket Motion writes build caches into its own vendor tree.
 * PEESUTO_TEMPLATE_ENGINE=/tmp/prepared-copy bun test core/tests/template-engine.test.ts
 */
import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { prepareTemplate, renderTemplate } from "../src/templates/render.ts";
import { frameCard } from "../src/render/card.ts";
import { TEMPLATE_SAMPLES, samplePlan } from "./fixtures/templates.ts";
import { templateRegistration } from "../src/templates/registry.ts";
import { documentBlocks } from "../src/templates/parse.ts";

const engine = process.env.PEESUTO_TEMPLATE_ENGINE ? resolve(process.env.PEESUTO_TEMPLATE_ENGINE) : undefined;
const integration = engine ? test : test.skip;
const output = resolve(process.env.PEESUTO_TEMPLATE_OUTPUT ?? ".work/template-samples");
const options = { engine: engine ?? "", work: join(output, "work"), emojiCache: join(output, "emoji"), emojiBundle: resolve(".work/emoji-all") };
const digest = async (path: string) => createHash("sha256").update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex");

integration("every registered design renders a complete PNG in the actual engine", async () => {
  await mkdir(output, { recursive: true });
  const samples: string[] = [];
  for (const content of TEMPLATE_SAMPLES) for (const variant of templateRegistration(content.kind).variants.map((v) => v.id)) {
    const path = join(output, `${content.kind}-${variant}.png`);
    const rendered = await renderTemplate(samplePlan(content, variant), { ...options, format: "png", out: path });
    expect(rendered.truncated).toBe(false);
    expect(rendered.frames).toBe(1);
    expect(await Bun.file(path).size).toBeGreaterThan(100);
    samples.push(path);
  }
  await Bun.write(join(output, "samples.json"), JSON.stringify(samples, null, 2));
  console.log(`Template PNG samples: ${output}/samples.json`);
}, 240_000);

integration("typewriter uses distinct intermediate frames, a full final hold, and complete PNG export", async () => {
  const plan = samplePlan({ kind: "chat", turns: [{ speaker: "小林", text: "你好，世界！🎉" }, { speaker: "Alex", text: "Type one character at a time." }] }, "classic", "typewriter");
  const prepared = await prepareTemplate(plan, options);
  const first = join(output, "typewriter-first.png"), middle = join(output, "typewriter-middle.png"), last = join(output, "typewriter-last.png"), held = join(output, "typewriter-held.png");
  await frameCard(options, 0, first);
  await frameCard(options, 20, middle);
  await frameCard(options, prepared.frames - 1, last);
  await frameCard(options, prepared.frames - 24, held);
  expect(await digest(first)).not.toBe(await digest(middle));
  expect(await digest(middle)).not.toBe(await digest(last));
  expect(await digest(last)).toBe(await digest(held));
  const png = await renderTemplate(plan, { ...options, format: "png", out: join(output, "typewriter-static.png") });
  expect(png.frames).toBe(1);
  expect(await digest(png.path)).toBe(await digest(last));
  const gif = await renderTemplate(plan, { ...options, format: "gif", out: join(output, "typewriter.gif") });
  expect(gif.frames).toBeGreaterThan(1);
  expect(gif.frames / 30).toBeLessThanOrEqual(6);
}, 180_000);

integration("Markdown document retains headings, lists, code and strong text as layout", async () => {
  const source = "# 一个清晰的想法\n\n保留 **重要内容**，让结构帮助阅读。\n\n- 第一个要点\n- A second point\n\n```ts\nconst value = 42;\nconsole.log(value);\n```";
  const plan = samplePlan({ kind: "document", paragraphs: [source], blocks: documentBlocks(source) });
  const rendered = await renderTemplate({ ...plan, sourceText: source }, { ...options, format: "png", out: join(output, "document-markdown.png") });
  expect(rendered.truncated).toBe(false);
  const generated = await Bun.file(join(options.work, "compositions/paste/main.tsx")).text();
  expect(generated).not.toContain('{"#"}');
  expect(generated).not.toContain('{"*"}');
}, 60_000);

integration("a tall GIF scrolls through a fixed canvas and ends on the last message", async () => {
  const turns = Array.from({ length: 12 }, (_, i) => ({ speaker: i % 2 ? "shybee" : "nok", time: `2026年09月23日 8:${String(i).padStart(2, "0")}`, text: `第 ${i + 1} 条消息` }));
  const plan = samplePlan({ kind: "chat", turns }, "classic", "reveal");
  const gif = await renderTemplate(plan, { ...options, format: "gif", out: join(output, "scroll.gif") });
  expect(gif.scroll).toBe(true);
  expect(gif.height).toBe(1080);
  const prepared = await prepareTemplate(plan, options);
  const first = join(output, "scroll-first.png"), last = join(output, "scroll-last.png"), held = join(output, "scroll-held.png");
  await frameCard(options, 0, first);
  await frameCard(options, prepared.frames - 1, last);
  await frameCard(options, prepared.frames - 20, held);
  expect(await digest(first)).not.toBe(await digest(last));
  expect(await digest(last)).toBe(await digest(held));
  const png = await renderTemplate(plan, { ...options, format: "png", out: join(output, "scroll-static.png") });
  expect(png.scroll).toBe(false);
  expect(png.height).toBeGreaterThan(1080);
}, 240_000);


integration("code cards are set in Peesuto Code, and fall back to Noto Sans SC for a glyph it lacks", async () => {
  const sidecar = async () => JSON.parse(await Bun.file(join(options.work, "compositions/paste/pocket-motion.json")).text()) as { fonts: { regular: string; bold: string } };
  const layoutFont = async () => (JSON.parse(await Bun.file(join(options.work, "compositions/paste/template-layout.json")).text()) as { font: string }).font;
  const code = "def 求和(a, b):\n    # 计算两个数的和 🎉\n    return a + b";
  const mono = await renderTemplate({ ...samplePlan({ kind: "code", code, language: "python" }, "classic"), sourceText: code }, { ...options, format: "png", out: join(output, "code-mono.png") });
  expect(mono.truncated).toBe(false);
  const fonts = (await sidecar()).fonts;
  expect(fonts).toEqual({ regular: "compositions/paste/fonts/PeesutoCode-Regular.ttf", bold: "compositions/paste/fonts/PeesutoCode-Bold.ttf" });
  for (const path of Object.values(fonts)) expect(await Bun.file(join(options.work, path)).exists()).toBe(true);
  expect(await layoutFont()).toBe("peesuto-code");
  // 體 is outside GB2312, so outside the Peesuto Code subset.
  const traditional = "# 繁體註解\nprint(1)";
  await renderTemplate({ ...samplePlan({ kind: "code", code: traditional, language: "python" }, "editorial"), sourceText: traditional }, { ...options, format: "png", out: join(output, "code-fallback.png") });
  expect((await sidecar()).fonts.regular).toBe("assets/fonts/NotoSansSC-Regular.otf");
  expect(await layoutFont()).toBe("noto-sans-sc");
  // Other templates keep Noto Sans SC, document code blocks included.
  const source = "说明\n\n```py\nprint(1)\n```";
  await renderTemplate({ ...samplePlan({ kind: "document", paragraphs: [source], blocks: documentBlocks(source) }), sourceText: source }, { ...options, format: "png", out: join(output, "document-code.png") });
  expect((await sidecar()).fonts.regular).toBe("assets/fonts/NotoSansSC-Regular.otf");
}, 240_000);
