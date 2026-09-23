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
import { documentBlocks } from "../src/templates/parse.ts";

const engine = process.env.PEESUTO_TEMPLATE_ENGINE;
const integration = engine ? test : test.skip;
const output = resolve(process.env.PEESUTO_TEMPLATE_OUTPUT ?? ".work/template-samples");
const options = { engine: engine ?? "", work: join(output, "work"), emojiCache: join(output, "emoji"), emojiBundle: resolve(".work/emoji-all") };
const digest = async (path: string) => createHash("sha256").update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex");

integration("all 16 designs render complete PNGs in the actual engine", async () => {
  await mkdir(output, { recursive: true });
  const samples: string[] = [];
  for (const content of TEMPLATE_SAMPLES) for (const variant of ["classic", "editorial"] as const) {
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
