#!/usr/bin/env bun
/**
 * Exports every promo card as glyph geometry the HTML composition can rebuild
 * and animate one character at a time, and renders the same cards with the
 * real engine (PNG / MP4) for the "many forms" scene and for side-by-side QA.
 *
 *   bun promo/scripts/export-cards.ts --engine .work/promo/engine [--only hook,chat] [--no-render]
 *
 * The engine path must be a scratch COPY of the pinned checkout (builds write
 * caches into it). Geometry comes from the same functions composeTemplate uses:
 * decideTemplate (local rules, with the sample's template forced) →
 * layoutTemplate with the engine measurer's real advances → one x per grapheme
 * from the width of the styled prefix, exactly as the engine is given it.
 *
 * Output: promo/assets/cards/<id>.json (+ backdrop PNGs and SVG assets),
 * promo/assets/cards/cards.js (all cards as one script, no fetch at render),
 * promo/assets/renders/<id>-<motion>.<ext>.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decideTemplate } from "../../core/src/templates/decide.ts";
import { chooseTemplateFont, fontFaces, layoutTemplate, LAYOUT_GLYPHS, SIZES, type TemplateMeasure } from "../../core/src/templates/compose.ts";
import { fieldPng } from "../../core/src/templates/backdrop.ts";
import { renderTemplate } from "../../core/src/templates/render.ts";
import { splitEmoji, stripEmoji } from "../../core/src/render/emoji.ts";
import { SAMPLES } from "./samples.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const REPO = resolve(import.meta.dir, "../..");
const engine = resolve(flag("engine") ?? join(REPO, ".work/promo/engine"));
const only = flag("only")?.split(",");
const noRender = argv.includes("--no-render");
const CARDS = join(REPO, "promo/assets/cards");
const RENDERS = join(REPO, "promo/assets/renders");
const WORK = join(REPO, ".work/promo/tree");
await mkdir(CARDS, { recursive: true });
await mkdir(RENDERS, { recursive: true });

interface EngineMeasurer {
  measure(size: number, bold?: boolean): (text: string) => number;
  lineHeight(size: number, bold?: boolean): number;
  unmapped(text: string, size: number, bold?: boolean): string[];
  close(): Promise<void>;
}
const api = await import(`${engine}/src/text/measure.ts`) as { openMeasurer(options: unknown): Promise<EngineMeasurer> };
const charset = await Bun.file(join(REPO, "core/src/render/charset.txt")).text();
const graphemes = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((p) => p.segment);
const r2 = (n: number) => Math.round(n * 100) / 100;

const all: Record<string, unknown> = {};
for (const sample of SAMPLES) {
  if (only && !only.includes(sample.id)) continue;
  const decision = await decideTemplate(sample.text, { aspect: sample.aspect, output: "image", decider: null, override: { id: sample.template, variant: sample.variant } });
  const plan = { ...decision.plan, motion: "none" as const };
  const font = chooseTemplateFont(plan.template, [], plan.font);
  const texts = plan.content.kind === "qr" ? ["0"] : [stripEmoji(JSON.stringify(plan.content)), LAYOUT_GLYPHS];
  const m = await api.openMeasurer({
    face: fontFaces(font, engine).measure,
    sizes: SIZES.flatMap((px) => [{ px, bold: false }, { px, bold: true }]), texts, density: 1,
    cache: { charset, dir: join(WORK, "dist/.measure") },
  });
  try {
    for (const t of texts) { const miss = m.unmapped(t, 40, false); if (miss.length) throw new Error(`${sample.id}: font lacks ${miss.join(" ")}`); }
    const metrics: TemplateMeasure = {
      width: (text, size, bold) => splitEmoji(text).reduce((w, run) => w + ("emoji" in run ? size : m.measure(size, bold)(run.text)), 0),
      lineHeight: (size, bold) => m.lineHeight(size, bold),
    };
    const layout = layoutTemplate(plan, metrics, { format: "png" });
    const glyphs: { ch: string; x: number; y: number; size: number; h: number; bold: boolean; color: string; line: number; group: number; secondary?: boolean; generated?: boolean }[] = [];
    for (const [li, line] of layout.lines.entries()) {
      let prefixWidth = 0;
      const parts = graphemes(line.text);
      // Same as composeTemplate: x = line.x + width of the styled prefix (bold runs measured apart).
      let run = "", runBold = line.boldAt[0] ?? line.bold;
      for (const [gi, ch] of parts.entries()) {
        const bold = line.boldAt[gi] ?? line.bold;
        if (bold !== runBold) { prefixWidth += metrics.width(run, line.size, runBold); run = ""; runBold = bold; }
        const x = line.x + prefixWidth + metrics.width(run, line.size, runBold);
        run += ch;
        if (!ch.trim()) continue;
        glyphs.push({ ch, x: r2(x), y: r2(line.y), size: line.size, h: r2(line.height), bold, color: line.colorAt?.[gi] ?? line.color, line: li, group: line.group,
          ...(line.secondary ? { secondary: true } : {}), ...(line.generated ? { generated: true } : {}) });
      }
    }
    const images = [];
    for (const [i, image] of layout.images.entries()) {
      if (image.field) {
        const name = `${sample.id}-field-${i}.png`;
        // Full-resolution field (the engine stretches a 512 texture; the video is sharper).
        await writeFile(join(CARDS, name), fieldPng(image.field, { width: image.width, height: image.height }));
        images.push({ x: image.x, y: image.y, w: image.width, h: image.height, src: `assets/cards/${name}`, field: true });
      } else images.push({ x: image.x, y: image.y, w: image.width, h: image.height, src: `assets/cards/${sample.id}-${image.src}`, group: image.group });
    }
    for (const [name, svg] of Object.entries(layout.assets)) await writeFile(join(CARDS, `${sample.id}-${name}`), svg);
    const card = {
      id: sample.id, template: plan.template, variant: plan.variant, font, source: sample.text,
      width: layout.width, height: layout.height, background: layout.background,
      shapes: layout.shapes.map((s) => ({ x: s.x, y: s.y, w: s.width, h: s.height, color: s.color, radius: s.radius, ...(s.gradient ? { gradient: s.gradient } : {}), ...(s.shadow ? { shadow: s.shadow } : {}), ...(s.group !== undefined ? { group: s.group } : {}) })),
      images, glyphs,
    };
    all[sample.id] = card;
    await writeFile(join(CARDS, `${sample.id}.json`), JSON.stringify(card, null, 1) + "\n");
    console.log(`${sample.id}: ${plan.template}/${plan.variant} ${layout.width}×${layout.height} ${glyphs.length} glyphs, ${layout.shapes.length} shapes, ${images.length} images (${font})`);
  } finally { await m.close(); }

  if (noRender) continue;
  for (const r of sample.renders ?? []) {
    const out = join(RENDERS, `${sample.id}-${r.motion}.${r.format}`);
    const res = await renderTemplate({ ...plan, motion: r.motion }, {
      engine, work: WORK, emojiCache: join(REPO, ".work/promo/emoji"), emojiBundle: join(REPO, ".work/emoji-all"), format: r.format, out,
    });
    console.log(`  render ${r.format}/${r.motion} → ${out} (${res.width}×${res.height}, ${res.frames} frames)`);
  }
}
if (!only) await writeFile(join(CARDS, "cards.js"), `// GENERATED by promo/scripts/export-cards.ts — card geometry from the real layout engine.\nwindow.CARDS = ${JSON.stringify(all)};\n`);
else console.log("--only: cards.js not rewritten");
