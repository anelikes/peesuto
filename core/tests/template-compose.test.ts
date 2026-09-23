import { describe, expect, test } from "bun:test";
import { layoutTemplate, scrollTiming, scrolls, templateTiming, wrapTemplateText, TEMPLATE_LIMITS, TEMPLATE_SCROLL, type TemplateMeasure } from "../src/templates/compose.ts";
import type { TemplateContent, TemplatePlan } from "../src/templates/types.ts";
import { templateGifWidth, TEMPLATE_GIF_FRAME_BUDGET } from "../src/templates/render.ts";
import { documentBlocks } from "../src/templates/parse.ts";

import { TEMPLATE_SAMPLES, samplePlan } from "./fixtures/templates.ts";
const metrics: TemplateMeasure = {
  width: (text, size) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].reduce((n, { segment }) => n + size * (/^[\x00-\x7f]+$/.test(segment) ? 0.55 : 1), 0),
  lineHeight: (size) => size * 1.2,
};

describe("structured template layouts", () => {
  test("every template has two geometrically distinct complete variants", () => {
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

describe("text template", () => {
  const text = (paragraphs: string[]): TemplateContent => ({ kind: "text", paragraphs });
  const visible = (layout: ReturnType<typeof layoutTemplate>) => layout.lines.map((line) => line.text).join("").replace(/\s/g, "");
  test("type size follows length: a line is poster-sized, a paragraph smaller", () => {
    const short = layoutTemplate(samplePlan(text(["少即是多。"])), metrics);
    const long = layoutTemplate(samplePlan(text(["把复杂的想法讲得简单，需要先把它想清楚，再删掉所有不必要的部分，最后留下的每一句话都应该有它存在的理由。".repeat(2)])), metrics);
    expect(short.lines[0]!.size).toBeGreaterThan(long.lines[0]!.size);
    expect(short.lines[0]!.size).toBe(96);
  });
  test("nothing but the source is drawn; the block is vertically centered", () => {
    for (const variant of ["classic", "editorial", "poster"] as const) {
      const layout = layoutTemplate(samplePlan(text(["好的设计，是把复杂留给自己。", "Keep it simple."]), variant), metrics);
      expect(visible(layout)).toBe("好的设计，是把复杂留给自己。Keepitsimple.");
      const top = layout.lines[0]!.y, last = layout.lines.at(-1)!;
      const bottomGap = layout.height - (last.y + last.size * 1.2);
      expect(Math.abs(top - bottomGap)).toBeLessThan(layout.height * 0.12);
    }
  });
  test("lines are balanced: the last line is not a stub", () => {
    const layout = layoutTemplate(samplePlan(text(["The quick brown fox jumps over the lazy dog, then naps in the warm afternoon sun."])), metrics);
    const widths = layout.lines.map((line) => line.width);
    expect(widths.length).toBeGreaterThan(1);
    expect(widths.at(-1)!).toBeGreaterThan(Math.max(...widths) * 0.45);
  });
  test("closing punctuation never starts a line and opening never ends one, in every template", () => {
    const tight: TemplateMeasure = { width: (t, size) => [...t].length * size, lineHeight: (size) => size * 1.2 };
    const lines = wrapTemplateText("一二三四五六七八，九十", 8 * 32, 32, false, tight);
    expect(lines.every((line) => !/^[，。、]/.test(line))).toBe(true);
    const doc = layoutTemplate(samplePlan({ kind: "document", paragraphs: ["x"], blocks: [{ kind: "paragraph", text: "把复杂的想法，讲得简单简单简单简单简单简单简单简单简单简单简单简单。" }] }, "editorial"), tight);
    for (const line of doc.lines) expect(/^[，。、；：？！）」』”]/.test(line.text)).toBe(false);
    for (const line of doc.lines) expect(/[（「『“]$/.test(line.text)).toBe(false);
  });
  test("an accent colors exactly the chosen source word; an absent word changes nothing", () => {
    const content = text(["Good design leaves the complexity to itself."]);
    const accented = layoutTemplate(samplePlan(content, "editorial", "none", "complexity"), metrics);
    const colored = accented.lines.flatMap((line) => [...line.text].filter((_, i) => line.colorAt?.[i])).join("");
    expect(colored).toBe("complexity");
    const plain = layoutTemplate(samplePlan(content, "editorial", "none", "simplicity"), metrics);
    expect(plain.lines.every((line) => !line.colorAt)).toBe(true);
  });
  test("an unknown style for the template is refused", () => {
    expect(() => layoutTemplate(samplePlan({ kind: "quote", text: "x" }, "poster"), metrics)).toThrow();
  });
});

describe("tall animations scroll", () => {
  test("only animated layouts clearly taller than the canvas scroll", () => {
    expect(scrolls("none", 3000, 1080)).toBe(false);
    expect(scrolls("reveal", 1200, 1080)).toBe(false);
    expect(scrolls("reveal", 1300, 1080)).toBe(true);
    expect(scrolls("typewriter", 1300, 1080)).toBe(true);
  });
  test("scroll timing: reading speed, clamped, with still start and end", () => {
    const mid = scrollTiming(600);
    expect(mid.scrollMs).toBe(5000);
    expect(mid.frames).toBe(Math.ceil((TEMPLATE_SCROLL.startMs + 5000 + TEMPLATE_SCROLL.endMs) / 1000 * TEMPLATE_LIMITS.fps) + 1);
    expect(scrollTiming(10).scrollMs).toBe(TEMPLATE_SCROLL.minMs);
    expect(scrollTiming(100_000).scrollMs).toBe(TEMPLATE_SCROLL.maxMs);
  });
  test("the longest scroll still fits the GIF frame budget", () => {
    expect(templateGifWidth(1080, 1080, scrollTiming(100_000).frames)).toBeGreaterThanOrEqual(360);
  });
  test("chat turns show their copied time as small text", () => {
    const layout = layoutTemplate(samplePlan({ kind: "chat", turns: [{ speaker: "nok", time: "22:10", text: "你好" }, { speaker: "shybee", time: "0:10", text: "全聚德" }] }), metrics);
    const texts = layout.lines.map((line) => line.text);
    expect(texts).toContain("22:10");
    expect(texts).toContain("0:10");
    const time = layout.lines.find((line) => line.text === "22:10")!, name = layout.lines.find((line) => line.text === "nok")!;
    expect(time.size).toBeLessThanOrEqual(name.size);
    expect(time.y).toBeGreaterThan(name.y);
  });
});

test("a far-back space in mixed Chinese and Latin text does not strand a stub line", () => {
  const tight: TemplateMeasure = { width: (t, size) => [...t].length * size, lineHeight: (size) => size * 1.2 };
  const lines = wrapTemplateText("第 1 段。把复杂的想法讲清楚，需要先把它想清楚，再删掉所有不必要的部分。", 20 * 32, 32, false, tight);
  expect(lines[0]!.length).toBeGreaterThan(10);
  // English still breaks between words.
  expect(wrapTemplateText("Make it work, make it right", 14 * 32, 32, false, tight)).toEqual(["Make it work, ", "make it right"]);
});

