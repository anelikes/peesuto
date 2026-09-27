#!/usr/bin/env bun
/**
 * Render every template from a BUNDLED copy of Core and the engine subset, so a
 * file pruned from the sidecar that a render really needs fails the build.
 * scripts/bundle-sidecar.ts runs it with the bundled Bun and `--no-install`
 * against a scratch copy of its output (the engine copy stands in for the one
 * the app installs into Application Support; renders write into it).
 *
 *   paste --no-install scripts/bundle-render-probe.ts --core <core> --engine <engine> --out <dir> [--emoji <dir>] [--encoder <PeesutoEncoder>] [--jizura-fonts <dir>]
 *
 * Covers: every registered template × variant as PNG and as GIF (samples from
 * core/tests/fixtures/templates.ts, plus QR), the Noto card font, a character
 * only Noto Sans SC has, emoji, the DSL card path (PNG and GIF) and, with
 * --encoder, MP4 through the app's own encoder with ffmpeg ruled out (a text
 * card and a Lyric motion video, each checked for H.264 and moov-before-mdat),
 * and Lyric motion drawn by JIZURA (the vendored engine, the Skia addon from
 * the bundle's node_modules, on frame threads): an English GIF and MP4 with
 * the fonts the bundle carries, and with --jizura-fonts (a directory of
 * JIZURA's faces standing in for downloaded packs) a Chinese GIF too.
 * This script imports nothing but Core's own modules by absolute path, so
 * every package resolves from the bundled node_modules.
 * It never uses the network: fetch throws, and without --emoji (no bundled
 * emoji set) samples containing emoji are left out rather than fetched.
 */
import { join, resolve } from "node:path";
import type { TemplateContent, TemplatePlan, TemplateId, VariantId } from "../core/src/templates/types.ts";
import { TEMPLATE_SAMPLES, samplePlan } from "../core/tests/fixtures/templates.ts";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const need = (n: string) => { const v = flag(n); if (!v) throw new Error(`bundle-render-probe: --${n} is required`); return resolve(v); };
const core = need("core"), engine = need("engine"), out = need("out");
const emoji = flag("emoji") ? resolve(flag("emoji")!) : undefined;
const encoder = flag("encoder") ? resolve(flag("encoder")!) : undefined;
const jizuraFonts = flag("jizura-fonts") ? resolve(flag("jizura-fonts")!) : undefined;
globalThis.fetch = (async (input: unknown) => { throw new Error(`bundle-render-probe: no network (${String(input)})`); }) as unknown as typeof fetch;
const hasEmoji = (x: unknown) => /\p{Extended_Pictographic}/u.test(JSON.stringify(x));

const { renderTemplate } = await import(join(core, "templates/render.ts")) as typeof import("../core/src/templates/render.ts");
const { TEMPLATE_REGISTRY } = await import(join(core, "templates/registry.ts")) as typeof import("../core/src/templates/registry.ts");
const { renderCard } = await import(join(core, "render/card.ts")) as typeof import("../core/src/render/card.ts");
const { fallbackDsl } = await import(join(core, "questions.ts")) as typeof import("../core/src/questions.ts");

const options = { engine, work: join(out, "work"), emojiCache: join(out, "emoji-cache"), ...(emoji ? { emojiBundle: emoji } : {}) };
const samples: TemplateContent[] = [...TEMPLATE_SAMPLES, { kind: "qr", data: "https://peesuto.com/?probe=1", caption: true }];
const done: string[] = [];
const t0 = performance.now();

async function one(name: string, plan: TemplatePlan, format: "png" | "gif" | "mp4"): Promise<void> {
  if (!emoji && hasEmoji(plan.content)) { console.warn(`bundle-render-probe: ${name}.${format} skipped (no bundled emoji set)`); return; }
  const path = join(out, `${name}.${format}`);
  // MP4: the native encoder only; "native" makes a missing one an error instead of an ffmpeg fallback.
  const r = await renderTemplate(plan, { ...options, format, out: path, ...(format === "mp4" ? { videoEncoder: "native" as const, nativeEncoder: encoder } : {}) });
  if (r.frames < 1 || (await Bun.file(path).size) < 100) throw new Error(`bundle-render-probe: ${name}.${format} is empty`);
  if (format !== "png" && r.frames < 2) throw new Error(`bundle-render-probe: ${name}.${format} did not animate`);
  if (format === "mp4") {
    const bytes = await Bun.file(path).bytes();
    const at = (box: string) => Buffer.from(bytes).indexOf(box);
    if (r.encoder !== "native") throw new Error(`bundle-render-probe: ${name}.mp4 was not made by PeesutoEncoder`);
    if (at("avc1") < 0 || at("moov") < 0 || at("moov") > at("mdat")) throw new Error(`bundle-render-probe: ${name}.mp4 is not faststart H.264`);
  }
  done.push(`${name}.${format}`);
}

const seen = new Set<TemplateId>();
for (const content of samples) {
  // The fixtures may run ahead of the Core that was bundled.
  const registration = TEMPLATE_REGISTRY.find((r) => r.id === content.kind);
  if (!registration) { console.warn(`bundle-render-probe: bundled Core has no ${content.kind} template; skipped`); continue; }
  seen.add(content.kind);
  for (const { id } of registration.variants) {
    const variant = id as VariantId;
    await one(`${content.kind}-${variant}`, samplePlan(content, variant), "png");
    await one(`${content.kind}-${variant}`, samplePlan(content, variant, content.kind === "chat" || content.kind === "text" ? "typewriter" : "reveal"), "gif");
  }
}
// The other card font, a glyph only Noto Sans SC has (說), and emoji.
const noto = (p: TemplatePlan): TemplatePlan => ({ ...p, font: "noto" });
const text = (t: string): TemplateContent => ({ kind: "text", paragraphs: [t] });
await one("text-noto", noto(samplePlan(text("好的设计 Noto 🎉"))), "png");
await one("text-noto", noto(samplePlan(text("好的设计 Noto 🎉"), "classic", "reveal")), "gif");
await one("text-fallback", samplePlan(text("他說：嗎？✨")), "png");
await one("text-fallback", samplePlan(text("他說：嗎？✨"), "classic", "reveal"), "gif");
if (encoder) {
  await one("text-video", samplePlan(text("Peesuto 视频 🎬"), "classic", "reveal"), "mp4");
  const lyric = TEMPLATE_SAMPLES.find((c) => c.kind === "lyrics");
  if (lyric && TEMPLATE_REGISTRY.some((r) => r.id === "lyrics")) await one("lyrics-video", samplePlan(lyric, "classic", "reveal"), "mp4");
}
// Lyric motion by JIZURA: the engine, the canvas addon and its worker threads, from the bundle.
{
  const { renderLyrics } = await import(join(core, "templates/lyrics-route.ts")) as typeof import("../core/src/templates/lyrics-route.ts");
  const { parseTemplates } = await import(join(core, "templates/parse.ts")) as typeof import("../core/src/templates/parse.ts");
  const film = async (name: string, text: string, format: "gif" | "mp4", style: string) => {
    const plan: TemplatePlan = { version: 1, template: "lyrics", variant: "classic", motion: "reveal", sourceText: text, content: parseTemplates(text).candidates.get("lyrics")!, aspect: "1:1" };
    const path = join(out, `${name}.${format}`);
    const r = await renderLyrics(plan, { ...options, format, out: path, ...(format === "mp4" ? { videoEncoder: "native" as const, nativeEncoder: encoder } : {}) }, { style });
    if (r.lyric.engine !== "jizura") throw new Error(`bundle-render-probe: ${name}.${format} was not drawn by JIZURA: ${"message" in r.lyric ? r.lyric.message : r.lyric.reason}`);
    if (r.frames < 2 || (await Bun.file(path).size) < 1000) throw new Error(`bundle-render-probe: ${name}.${format} is empty`);
    done.push(`${name}.${format}`);
  };
  const en = "Rain on the window\nI remember *you*\nNight is falling\nHold on to me!";
  await film("jizura-en", en, "gif", "noir");
  if (encoder) await film("jizura-en", en, "mp4", "candy");
  if (jizuraFonts) {
    process.env.PEESUTO_JIZURA_FONTS_DIR = jizuraFonts;
    await film("jizura-zh", "晚风吹亮*月光*\n我们慢慢走回家\n路灯一盏盏醒来\n把影子拉得很长", "gif", "auto");
    delete process.env.PEESUTO_JIZURA_FONTS_DIR;
  }
}
// The DSL card (CLI and fallback path).
for (const format of ["png", "gif"] as const) {
  const dsl = fallbackDsl(`把复杂留给自己，把简单留给别人。\nKeep it simple.${emoji ? " 🙂" : ""}`, "chat");
  const path = join(out, `dsl-card.${format}`);
  await renderCard({ ...dsl, animate: format === "gif" }, { ...options, format, out: path });
  if ((await Bun.file(path).size) < 100) throw new Error(`bundle-render-probe: dsl-card.${format} is empty`);
  done.push(`dsl-card.${format}`);
}

const unsampled = TEMPLATE_REGISTRY.map((r) => r.id).filter((id) => !seen.has(id));
if (unsampled.length) console.warn(`bundle-render-probe: no sample for ${unsampled.join(", ")} (add one to core/tests/fixtures/templates.ts)`);
console.log(`ok ${done.length} renders in ${Math.round((performance.now() - t0) / 1000)} s`);
