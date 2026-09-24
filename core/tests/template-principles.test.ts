/** The template design's hard rules: only source text is drawn (ordered-list
 * numbers aside), nothing is truncated, sizes stay on the measurer's baked
 * steps, QR stays scannable, fixed frames grow (PNG) or scroll (GIF/MP4). */
import { describe, expect, test } from "bun:test";
import {
  CHAT_STYLES, COMPARISON_STYLES, DOCUMENT_STYLES, LAYOUT_GLYPHS, LIST_STYLES, SIZES, TABLE_STYLES, TEMPLATE_GROW,
  grown, layoutTemplate, scrolls, syntaxColors, CODE_STYLES, QR_STYLES, type TemplateLayout, type TemplateMeasure,
} from "../src/templates/compose.ts";
import { normalizeText } from "../src/render/compose.ts";
import { documentBlocks } from "../src/templates/parse.ts";
import { templateRegistration } from "../src/templates/registry.ts";
import type { TemplateAspect, TemplateContent } from "../src/templates/types.ts";
import { TEMPLATE_SAMPLES, samplePlan } from "./fixtures/templates.ts";

const metrics: TemplateMeasure = {
  width: (text, size) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].reduce((n, { segment }) => n + size * (/^[\x00-\x7f]+$/.test(segment) ? 0.55 : 1), 0),
  lineHeight: (size) => size * 1.2,
};
const graphemes = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((p) => p.segment);

const markdown = "# 周报\n\n本周完成了 **模板重做**。\n\n1. 先写清楚问题\n2. 一次只改一个变量\n\n- 无序一\n- 无序二\n\n```ts\nconst x = 1;\n```";
const EXTRA: readonly TemplateContent[] = [
  { kind: "document", paragraphs: [markdown], blocks: documentBlocks(markdown) },
  { kind: "list", ordered: false, items: ["买牛奶", "Write the weekly report", "回电话"] },
  { kind: "chat", turns: [{ speaker: "nok", time: "22:10", text: "你好" }, { speaker: "shybee", time: "2026年09月23日 0:10", text: "全聚德见。" }] },
  { kind: "quote", text: "Simplicity is prerequisite for reliability." },
  { kind: "code", code: "def add(a, b):\n    # sum\n    return a + b" },
  { kind: "table", headers: ["名称", "状态", "负责人", "截止", "备注"], rows: [["模板", "完成", "nok", "9/23", "—"], ["引擎", "进行中", "shybee", "9/30", "字体"]] },
  { kind: "table", headers: ["项"], rows: [["一"], ["二"]] },
  { kind: "stat", value: "1,284", label: "Weekly active users" },
  { kind: "qr", data: "https://peesuto.com" },
  { kind: "info", title: "张三", fields: [{ value: "13800138000", type: "phone" }, { value: "zhangsan@example.com", type: "email" }, { value: "杭州市西湖区文三路 90 号", type: "address" }] },
];
const ALL = [...TEMPLATE_SAMPLES, ...EXTRA];
const FRAMES: readonly TemplateAspect[] = ["1:1", "auto", "4:5", "16:9", "9:16"];

/** Every string of the content that may be drawn, as the layout normalizes it. */
function sourceStrings(content: TemplateContent): string[] {
  const clean = (text: string, code = false) => normalizeText(text, code ? "code" : "plain").replace(/\*\*([^*\n]+)\*\*/g, "$1");
  switch (content.kind) {
    case "text": return content.paragraphs.map((p) => clean(p));
    case "document": return content.blocks
      ? content.blocks.flatMap((b) => b.kind === "list" ? b.items.map((i) => clean(i)) : b.kind === "code" ? [clean(b.code, true)] : [clean(b.text)])
      : content.paragraphs.map((p) => clean(p));
    case "quote": return [content.text, ...(content.author ? [content.author] : [])].map((s) => clean(s));
    case "code": return [clean(content.code, true), ...(content.language ? [content.language] : [])];
    case "stat": return [content.value, content.label].map((s) => clean(s));
    case "list": return content.items.map((s) => clean(s));
    case "chat": return content.turns.flatMap((t) => [t.speaker, t.text, ...(t.time ? [t.time] : [])]).map((s) => clean(s));
    case "table": return [...content.headers, ...content.rows.flat()].map((s) => clean(s));
    case "comparison": return content.columns.flatMap((c) => [c.title, ...c.items]).map((s) => clean(s));
    case "diagram": return [...content.nodes.map((n) => n.label), ...content.edges.flatMap((e) => e.label ? [e.label] : [])].map((s) => clean(s));
    case "info": return [...(content.title ? [content.title] : []), ...content.fields.flatMap((f) => [...(f.label ? [f.label] : []), f.value])].map((s) => clean(s));
    case "qr": return [content.data];
  }
}
/** Ordered lists the layout numbers: the largest number each may show. */
function orderedCount(content: TemplateContent): number {
  if (content.kind === "list") return content.ordered ? content.items.length : 0;
  if (content.kind === "document") return Math.max(0, ...(content.blocks ?? []).map((b) => b.kind === "list" && b.ordered ? b.items.length : 0));
  // Code cards number their lines from 1 (the user asked for line numbers).
  if (content.kind === "code") return content.code.split("\n").length;
  return 0;
}
const isNumber = (text: string, max: number) => /^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= max;

function eachLayout(visit: (layout: TemplateLayout, content: TemplateContent, label: string) => void) {
  for (const content of ALL) for (const variant of templateRegistration(content.kind).variants.map((v) => v.id)) for (const aspect of FRAMES) {
    visit(layoutTemplate({ ...samplePlan(content, variant), aspect }, metrics), content, `${content.kind}/${variant}/${aspect}`);
  }
}

describe("template principles", () => {
  test("every drawn character comes from the source, except ordered-list numbers and code line numbers", () => {
    eachLayout((layout, content, label) => {
      const sources = sourceStrings(content), max = orderedCount(content);
      for (const line of layout.lines) {
        const text = line.text.trim();
        if (!text) continue;
        if (isNumber(text, max)) {
          for (const glyph of graphemes(text)) expect(LAYOUT_GLYPHS).toContain(glyph);
          continue;
        }
        if (!sources.some((source) => source.includes(text))) throw new Error(`${label}: "${text}" is not in the source`);
      }
    });
  });
  test("no added labels: nothing like NOTES, CODE or 01 is drawn", () => {
    eachLayout((layout, _content, label) => {
      for (const line of layout.lines) if (/^(NOTES|CODE|0\d|“)$/.test(line.text.trim())) throw new Error(`${label}: added label "${line.text}"`);
    });
  });
  test("nothing is truncated: every source character is drawn at least once", () => {
    eachLayout((layout, content, label) => {
      const drawn = new Map<string, number>();
      for (const line of layout.lines) {
        if (content.kind === "code" && /^\d+$/.test(line.text.trim()) && line.color !== undefined && [CODE_STYLES.classic.lineNumbers.color, CODE_STYLES.editorial.lineNumbers.color].includes(line.color as never)) continue;
        for (const glyph of graphemes(line.text)) if (glyph.trim()) drawn.set(glyph, (drawn.get(glyph) ?? 0) + 1);
      }
      const needed = new Map<string, number>();
      for (const source of sourceStrings(content)) for (const glyph of graphemes(source)) if (glyph.trim()) needed.set(glyph, (needed.get(glyph) ?? 0) + 1);
      if (content.kind === "qr") return; // the caption is optional by design
      for (const [glyph, n] of needed) if ((drawn.get(glyph) ?? 0) < n) throw new Error(`${label}: "${glyph}" drawn ${drawn.get(glyph) ?? 0}× of ${n}`);
    });
  });
  test("every line uses a baked size, at every grow step", () => {
    const sizes = new Set<number>(SIZES);
    eachLayout((layout, _content, label) => { for (const line of layout.lines) if (!sizes.has(line.size)) throw new Error(`${label}: size ${line.size}`); });
    const fontSizes = (value: unknown, parent = "", out: number[] = []): number[] => {
      if (!value || typeof value !== "object") return out;
      for (const [key, v] of Object.entries(value)) {
        if (typeof v === "number" && ((/size$/i.test(key) && !["dot", "box", "marker", "dots", "mark", "masthead", "rail", "card", "bar", "band", "gutter", "zebra", "panel", "rule"].includes(parent)) || /sizes$/i.test(parent))) out.push(v);
        else fontSizes(v, key, out);
      }
      return out;
    };
    const tables = [DOCUMENT_STYLES, LIST_STYLES, CHAT_STYLES, TABLE_STYLES, COMPARISON_STYLES, CODE_STYLES];
    for (const k of [1, ...Object.values(TEMPLATE_GROW).flat(), 2, 3.7, 0.3]) for (const table of tables) for (const style of Object.values(table)) {
      for (const size of fontSizes(grown(style, k!))) expect(sizes.has(size)).toBe(true);
    }
  });
  test("short content fills a fixed frame: type grows a step and the block is centred", () => {
    const list = layoutTemplate(samplePlan({ kind: "list", ordered: true, items: ["一", "二"] }), metrics);
    expect(list.lines.find((l) => l.text === "一")!.size).toBeGreaterThan(LIST_STYLES.classic.size);
    const top = Math.min(...list.lines.map((l) => l.y)), end = Math.max(...list.lines.map((l) => l.y + l.height));
    expect(Math.abs(top - (list.height - end))).toBeLessThan(40);
  });
  test("QR stays dark on light with a 4-module quiet zone, in both styles", () => {
    const luminance = (hex: string) => { const n = parseInt(hex.slice(1), 16); return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255; };
    for (const variant of ["classic", "editorial"] as const) {
      const style = QR_STYLES[variant];
      expect(luminance(style.light) - luminance(style.dark)).toBeGreaterThan(0.7);
      const layout = layoutTemplate({ ...samplePlan({ kind: "qr", data: "https://peesuto.com" }, variant), aspect: "1:1" }, metrics);
      const plate = layout.shapes[0]!, modules = layout.shapes.slice(1);
      expect(plate.color).toBe(style.light);
      for (const m of modules) expect(m.color).toBe(style.dark);
      const unit = Math.min(...modules.map((r) => r.height));
      expect(Math.min(...modules.map((r) => r.x)) - plate.x).toBeGreaterThanOrEqual(4 * unit);
      expect(Math.min(...modules.map((r) => r.y)) - plate.y).toBeGreaterThanOrEqual(4 * unit);
      expect(plate.x + plate.width - Math.max(...modules.map((r) => r.x + r.width))).toBeGreaterThanOrEqual(4 * unit);
    }
  });
  test("fixed frames: a PNG grows to hold everything, an animation scrolls", () => {
    const long: TemplateContent[] = [
      // (text is capped at TEXT_MAX_GRAPHEMES and always fits its frame at the minimum size)
      { kind: "document", paragraphs: Array(14).fill("完整保留每个段落，不用省略号隐藏内容。") },
      { kind: "quote", text: "一个人只拥有此生此世是不够的，他还应该拥有诗意的世界。".repeat(11), author: "王小波" },
      { kind: "code", code: Array.from({ length: 40 }, (_, i) => `const value${i} = ${i};`).join("\n") },
      { kind: "stat", value: "37%", label: "本季度活跃用户增长。".repeat(40) },
      { kind: "list", ordered: true, items: Array.from({ length: 24 }, (_, i) => `第 ${i + 1} 项`) },
      { kind: "chat", turns: Array.from({ length: 14 }, (_, i) => ({ speaker: i % 2 ? "Alex" : "小林", text: `第 ${i + 1} 条消息` })) },
      { kind: "table", headers: ["项目", "状态"], rows: Array.from({ length: 9 }, (_, i) => [`项目 ${i + 1}`, "完成，一段较长的说明文字需要换行才能完整显示在单元格里"]) },
      { kind: "comparison", columns: [{ title: "Before", items: Array(12).fill("许多零散入口") }, { title: "After", items: Array(12).fill("一个明确动作") }] },
    ];
    for (const content of long) for (const variant of ["classic", "editorial"] as const) {
      let layout: TemplateLayout;
      try { layout = layoutTemplate(samplePlan(content, variant), metrics); } catch (error) { throw new Error(`${content.kind}/${variant}: ${error}`); }
      if (layout.height <= 1080) throw new Error(`${content.kind}/${variant} did not grow (${layout.height})`);
      expect(layout.width).toBe(1080);
      for (const line of layout.lines) expect(line.y + line.height).toBeLessThanOrEqual(layout.height);
      expect(scrolls("reveal", layout.height, 1080)).toBe(true);
      expect(scrolls("none", layout.height, 1080)).toBe(false);
    }
  });
  test("syntax colour changes colour only, never the text", () => {
    const line = 'const greet = (name) => `Hello, ${name}!`; // 你好';
    const colors = syntaxColors(line, CODE_STYLES.classic.syntax);
    expect(colors).toHaveLength(graphemes(line).length);
    const layout = layoutTemplate(samplePlan({ kind: "code", code: line }), metrics);
    const code = layout.lines.filter((l) => l.color !== CODE_STYLES.classic.lineNumbers.color);
    expect(code.map((l) => l.text).join("")).toBe(line);
    expect(code.some((l) => l.colorAt?.some(Boolean))).toBe(true);
    expect(layout.lines.filter((l) => l.color === CODE_STYLES.classic.lineNumbers.color).map((l) => l.text)).toEqual(["1"]);
  });
});
