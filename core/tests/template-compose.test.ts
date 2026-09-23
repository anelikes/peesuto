import { describe, expect, test } from "bun:test";
import { layoutTemplate, templateTiming, wrapTemplateText, TEMPLATE_LIMITS, type TemplateMeasure } from "../src/templates/compose.ts";
import type { TemplateContent, TemplatePlan } from "../src/templates/types.ts";
import { templateGifWidth, TEMPLATE_GIF_FRAME_BUDGET } from "../src/templates/render.ts";
import { documentBlocks } from "../src/templates/parse.ts";

import { TEMPLATE_SAMPLES, samplePlan } from "./fixtures/templates.ts";
const metrics: TemplateMeasure = {
  width: (text, size) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].reduce((n, { segment }) => n + size * (/^[\x00-\x7f]+$/.test(segment) ? 0.55 : 1), 0),
  lineHeight: (size) => size * 1.2,
};

describe("structured template layouts", () => {
  test("all eight templates have two geometrically distinct complete variants", () => {
    for (const content of TEMPLATE_SAMPLES) {
      const classic = layoutTemplate(samplePlan(content), metrics);
      const editorial = layoutTemplate(samplePlan(content, "editorial"), metrics);
      expect(classic.lines.length).toBeGreaterThan(0);
      expect(editorial.lines.length).toBeGreaterThan(0);
      expect(classic.lines.map(({ x, y, size }) => [x, y, size])).not.toEqual(editorial.lines.map(({ x, y, size }) => [x, y, size]));
      for (const layout of [classic, editorial]) {
        for (const line of layout.lines) {
          expect(line.x).toBeGreaterThanOrEqual(0);
          expect(line.y + line.height).toBeLessThanOrEqual(layout.height);
          expect(line.x + line.width).toBeLessThanOrEqual(layout.width + 0.1);
        }
        expect(layout.height).toBeLessThanOrEqual(TEMPLATE_LIMITS.maxHeight);
      }
    }
  });
  test("word wrapping preserves all non-whitespace content and graphemes", () => {
    const text = "Hello 世界 👨‍👩‍👧 🎉 supercalifragilisticexpialidocious";
    const wrapped = wrapTemplateText(text, 160, 32, false, metrics);
    expect(wrapped.join("")).toBe(text);
    expect(wrapped.some((line) => line.includes("👨‍👩‍👧"))).toBe(true);
    for (const line of wrapped) expect(metrics.width(line, 32, false)).toBeLessThanOrEqual(160);
  });
  test("motion never changes final text layout, and typewriter has a bounded final hold", () => {
    const content = TEMPLATE_SAMPLES[5]!;
    expect(layoutTemplate(samplePlan(content, "classic", "typewriter"), metrics)).toEqual(layoutTemplate(samplePlan(content, "classic", "none"), metrics));
    const t = templateTiming("typewriter", 2300);
    expect(t.frames / TEMPLATE_LIMITS.fps).toBeLessThanOrEqual(6);
    expect(t.delay(2299, 2300)).toBe(t.revealMs);
    expect(t.frames / TEMPLATE_LIMITS.fps * 1000 - t.revealMs).toBeGreaterThanOrEqual(1200);
    expect(t.delay(1, 10)).toBeGreaterThan(t.delay(0, 10));
    expect(templateTiming("none", 100).frames).toBe(1);
  });
  test("long text grows the canvas, and an overfull card fails explicitly", () => {
    const content: TemplateContent = { kind: "document", paragraphs: Array(14).fill("完整保留每个段落，不用省略号隐藏内容。") };
    expect(layoutTemplate(samplePlan(content), metrics).height).toBeGreaterThan(1080);
    expect(() => layoutTemplate(samplePlan({ kind: "document", paragraphs: ["太长的内容。".repeat(1000)] }), metrics)).toThrow("No content was truncated");
  });
  test("long chat speaker labels reserve space before bubble text", () => {
    const layout = layoutTemplate(samplePlan({ kind: "chat", turns: [{ speaker: "A speaker with a long explicit name that spans several lines of the card", text: "Body starts below the full speaker label." }] }), metrics);
    const body = layout.lines.find((line) => line.text.startsWith("Body"))!;
    const speaker = layout.lines.filter((line) => line.group === 0);
    expect(body.y).toBeGreaterThanOrEqual(Math.max(...speaker.map((line) => line.y + line.height)));
  });
  test("invalid table structure cannot drop cells", () => {
    expect(() => layoutTemplate(samplePlan({ kind: "table", headers: ["one"], rows: [["first", "lost?"]] }), metrics)).toThrow("same number of cells");
  });
  test("Markdown blocks change typography while preserving code indentation and emphasis", () => {
    const source = "# Heading\n\nKeep **important** words.\n\n- one\n- two\n\n```ts\n\tconst value = 42;\n```";
    const layout = layoutTemplate(samplePlan({ kind: "document", paragraphs: [source], blocks: documentBlocks(source) }), metrics);
    expect(layout.lines.find((line) => line.text === "Heading")?.size).toBe(56);
    const strong = layout.lines.find((line) => line.text.includes("important"))!;
    expect(strong.text).toBe("Keep important words.");
    expect(strong.boldAt.slice(5, 14).every(Boolean)).toBe(true);
    expect(layout.lines.some((line) => line.text === "    const value = 42;")).toBe(true);
    expect(layout.lines.some((line) => line.text.includes("```"))).toBe(false);
  });
  test("template GIF frame allocation is bounded without tiny unreadable output", () => {
    const width = templateGifWidth(1080, 1920, 171);
    expect(width).toBeGreaterThanOrEqual(360);
    expect(width).toBeLessThanOrEqual(540);
    expect(width * Math.round(1920 * width / 1080) * Math.ceil(171 / 2) * 4).toBeLessThanOrEqual(TEMPLATE_GIF_FRAME_BUDGET);
    expect(() => templateGifWidth(1080, 4096, 171)).toThrow("No content was truncated");
  });
});
