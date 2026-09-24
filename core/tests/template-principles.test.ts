/** The template design's hard rules: only source text is drawn (ordered-list
 * numbers aside), nothing is truncated, sizes stay on the measurer's baked
 * steps, QR stays scannable, fixed frames grow (PNG) or scroll (GIF/MP4). */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  CHAT_STYLES, COMPARISON_STYLES, DOCUMENT_STYLES, LAYOUT_GLYPHS, LIST_STYLES, SIZES, TABLE_STYLES, TEMPLATE_GROW,
  grown, layoutTemplate, scaledTo, scrolls, syntaxColors, CODE_STYLES, QR_STYLES, effectiveSize, minFontSize, type TemplateLayout, type TemplateMeasure,
} from "../src/templates/compose.ts";
import { normalizeText } from "../src/render/compose.ts";
import { documentBlocks } from "../src/templates/parse.ts";
import { templateRegistration } from "../src/templates/registry.ts";
import { checkLayout } from "../src/templates/checks.ts";
import { READABILITY, type TemplateAspect, type TemplateContent } from "../src/templates/types.ts";
import { TEMPLATE_SAMPLES, samplePlan } from "./fixtures/templates.ts";

// Each test lays out every sample in every style, frame and grow step: ~5 s on a CI runner, over bun's 5 s default.
setDefaultTimeout(30_000);

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
  { kind: "changelog", title: "Changelog", releases: [
    { version: "Unreleased", sections: [] },
    { version: "v2.0.0-beta.12", date: "2026年9月24日", sections: [{ title: "Breaking changes", type: "security", items: ["Settings file moved"] }] },
    { version: "1.1.0", sections: [{ type: "other", items: ["feat: warmer greys", "fix: 换行"] }] },
  ] },
  { kind: "terminal", lines: [
    { kind: "prompt", prompt: "PS C:\\Users\\nya> ", command: "npm run build -- --verbose --filter=@peesuto/core --workspace packages/core --no-cache" },
    { kind: "output", text: "npm WARN config production Use `--omit=dev` instead.", tone: "warning" }, { kind: "output", text: "" },
    { kind: "output", text: "  构建完成，用时 3.2 秒" }, { kind: "prompt", prompt: "$ ", command: "" }, { kind: "exit", text: "exit status 0", ok: true },
  ] },
  { kind: "diff", commit: [
    { text: "commit 3f2a1c9e8b7d6a5f4e3d2c1b0a99887766554433 (HEAD -> main, origin/main)", role: "commit" },
    { text: "Author: 林小雨 <lin@example.com>", role: "field" }, { text: "Date:   Wed Sep 24 10:12:03 2026 +0800", role: "field" },
    { text: "Rename the notes page and add the logo, with a subject long enough to wrap across the card", role: "subject" },
    { text: "The old name was confusing.", role: "message" },
  ], files: [
    { path: "docs/新名字.md", oldPath: "docs/old-name.md", meta: ["similarity index 90%", "rename from docs/old-name.md", "rename to docs/新名字.md"], hunks: [
      { header: "@@ -3 +3 @@", lines: [{ type: "del", text: "-旧的一行" }, { type: "add", text: "+A replaced line that is long enough to wrap across the whole width of the card, twice over at least." }, { type: "note", text: "\\ No newline at end of file" }] }] },
    { path: "assets/logo.png", meta: ["new file mode 100644", "Binary files /dev/null and b/assets/logo.png differ"], hunks: [] },
    { meta: [], hunks: [{ header: "@@ -10,3 +10,2 @@", lines: [{ type: "context", text: "" }, { type: "del", text: "-x" }, { type: "del", text: "-y" }, { type: "context", text: " z" }] }] },
  ] },
  { kind: "error", type: "KeyError", message: "'a'", trace: [
    { text: "Traceback (most recent call last):", role: "note", own: false }, { text: 'File "/srv/应用.py", line 3, in <module>', role: "frame", own: true },
    { text: "x = {}['a']", role: "code", own: true }, { text: "    ~~^^^^^", role: "code", own: true },
    { text: 'File "/usr/lib/python3.12/json/__init__.py", line 293, in load_with_a_very_long_function_name_that_wraps', role: "frame", own: false },
  ] },
  { kind: "error", lead: "PHP Fatal error: Uncaught", type: "App\\Billing\\CardDeclined", message: "Card declined", trace: [
    { text: "/srv/app/src/Billing.php:88", role: "frame", own: true }, { text: "Stack trace:", role: "note", own: false },
    { text: "#0 /srv/app/vendor/laravel/framework/src/Illuminate/Routing/Controller.php(54): App\\Billing->charge()", role: "frame", own: false },
    { text: "#1 {main}", role: "frame", own: false }, { text: "thrown in /srv/app/src/Billing.php on line 88", role: "note", own: false },
  ] },
  { kind: "error", lead: "thread 'main' panicked at src/main.rs:4:5", message: "index out of bounds: the len is 3 but the index is 5 ".repeat(4).trim(), trace: [] },
  { kind: "timeline", events: [
    { time: "Wednesday, September 24, 2026 9:30am – 11:00am", text: "A long first event whose text wraps over more than one line of the card, beside or under its date" },
    { time: "Q1 2027", text: "Windows" }, { time: "第三周", text: "测试与发布" },
  ] },
  { kind: "stats", metrics: [
    { label: "Weekly active users across every platform we ship", value: "$1,284,000,000", delta: "↑12.5% YoY" }, { label: "B", value: "3" },
    { label: "留存", value: "41%", delta: "−2pp" }, { label: "NPS", value: "61" }, { label: "Stars", value: "1,204", delta: "0" },
  ] },
  { kind: "lyrics", title: "静夜思", credit: "李白", poem: true, stanzas: [{ lines: [{ text: "床前明月光，疑是地上霜。" }, { text: "举头望明月，低头思故乡。" }] }] },
  { kind: "lyrics", stanzas: [{ lines: [{ text: "We were counting every bridge back home, one by one" }, { text: "Oh", emphasis: [[0, 2]] }, { text: "我听见心跳慢慢靠近", note: "a note under the line" }] },
    { lines: Array.from({ length: 9 }, (_, i) => ({ text: `第 ${i + 1} 行，一直唱到天亮` })) }] },
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
    case "changelog": return [...(content.title ? [content.title] : []), ...content.releases.flatMap((r) => [r.version, ...(r.date ? [r.date] : []),
      ...r.sections.flatMap((s) => [...(s.title ? [s.title] : []), ...s.items])])].map((s) => clean(s));
    case "terminal": return content.lines.map((l) => clean(l.kind === "prompt" ? l.prompt + l.command : l.text, true));
    case "diff": return [...(content.commit ?? []).map((l) => l.text), ...content.files.flatMap((f) => [...(f.path ? [f.path] : []), ...(f.oldPath ? [f.oldPath] : []), ...f.meta,
      ...f.hunks.flatMap((h) => [h.header, ...h.lines.map((l) => l.text)])])].map((s) => clean(s, true));
    case "error": return [...[content.lead, content.type, content.message].filter((t): t is string => Boolean(t)), ...content.trace.map((l) => l.text)].map((s) => clean(s, true));
    case "timeline": return [...(content.title ? [content.title] : []), ...content.events.flatMap((e) => [e.time, e.text])].map((s) => clean(s));
    case "stats": return [...(content.title ? [content.title] : []), ...content.metrics.flatMap((m) => [m.label, m.value, ...(m.delta ? [m.delta] : [])])].map((s) => clean(s));
    case "lyrics": return [...[content.title, content.credit].filter((t): t is string => Boolean(t)),
      ...content.stanzas.flatMap((s) => [...(s.label ? [s.label] : []), ...s.lines.flatMap((l) => [l.text, ...(l.note ? [l.note] : [])])])].map((s) => clean(s));
    case "qr": return [content.data];
  }
}
/** Ordered lists the layout numbers: the largest number each may show. */
function orderedCount(content: TemplateContent): number {
  if (content.kind === "list") return content.ordered ? content.items.length : 0;
  if (content.kind === "document") return Math.max(0, ...(content.blocks ?? []).map((b) => b.kind === "list" && b.ordered ? b.items.length : 0));
  // Code cards number their lines from 1 (the user asked for line numbers).
  if (content.kind === "code") return content.code.split("\n").length;
  // A diff's "+N −M" summary counts its added and removed lines (the signs are shapes).
  if (content.kind === "diff") return Math.max(...(["add", "del"] as const).map((type) => content.files.flatMap((f) => f.hunks.flatMap((h) => h.lines)).filter((l) => l.type === type).length));
  return 0;
}
const isNumber = (text: string, max: number) => /^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= max;

/** A signature footer (Settings › Templates): not source text. */
const SIGNATURE = "@nya · peesuto.com 签名";
function eachLayout(visit: (layout: TemplateLayout, content: TemplateContent, label: string) => void) {
  for (const content of ALL) for (const variant of templateRegistration(content.kind).variants.map((v) => v.id)) for (const aspect of FRAMES) for (const signature of [undefined, SIGNATURE]) {
    visit(layoutTemplate({ ...samplePlan(content, variant), aspect, ...(signature ? { signature } : {}) }, metrics), content, `${content.kind}/${variant}/${aspect}${signature ? "/signed" : ""}`);
  }
}

describe("template principles", () => {
  test("every drawn character comes from the source, except ordered-list numbers, code line numbers, a diff's line counts and the signature", () => {
    eachLayout((layout, content, label) => {
      const sources = sourceStrings(content), max = orderedCount(content);
      for (const line of layout.lines) {
        const text = line.text.trim();
        if (!text) continue;
        // The user's signature is the one exemption, and it is marked as such.
        if (line.signature) { expect(SIGNATURE).toContain(text); continue; }
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
        if (line.signature) continue;
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
      for (const u of [1, 1440 / 1080, 1920 / 1080]) for (const size of fontSizes(grown(scaledTo(style, u), k!))) expect(sizes.has(size)).toBe(true);
    }
  });
  test("phone readability floor: no text below 13 px (labels 11 px) when the card is shown 390 px wide", () => {
    expect([1080, 1440, 1920].map((w) => [minFontSize(w, "body"), minFontSize(w, "secondary")])).toEqual([[36, 32], [48, 44], [64, 56]]);
    eachLayout((layout, _content, label) => {
      for (const line of layout.lines) {
        const floor = line.secondary ? READABILITY.secondary : READABILITY.body;
        if (effectiveSize(line.size, layout.width) < floor - 1e-9) throw new Error(`${label}: "${line.text}" at ${line.size}px on ${layout.width} is ${effectiveSize(line.size, layout.width).toFixed(1)} px on a phone (floor ${floor})`);
      }
    });
    // Long content keeps the floor and grows the card instead of shrinking type.
    const longCode = { kind: "code" as const, code: Array.from({ length: 16 }, (_, i) => `const value${i} = compute(${i}, "a fairly long argument that wraps");`).join("\n") };
    for (const aspect of ["1:1", "16:9", "auto"] as const) {
      const layout = layoutTemplate({ ...samplePlan(longCode), aspect }, metrics);
      expect(layout.height).toBeGreaterThan(1080);
      for (const line of layout.lines) expect(effectiveSize(line.size, layout.width)).toBeGreaterThanOrEqual(READABILITY.secondary);
      expect(Math.min(...layout.lines.filter((l) => !l.secondary).map((l) => l.size))).toBe(minFontSize(layout.width));
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
  test("the signature footer: every card but QR, below everything, inside the canvas, and a fitting card keeps its frame", () => {
    const boxes = (layout: TemplateLayout) => [...layout.lines.filter((l) => !l.signature).map((l) => ({ y: l.y, bottom: l.y + l.height })),
      ...layout.images.filter((i) => !i.field).map((i) => ({ y: i.y, bottom: i.y + i.height }))]; // a colour-field backdrop is ground
    eachLayout((layout, content, label) => {
      const footer = layout.lines.filter((l) => l.signature);
      if (!label.endsWith("/signed") || content.kind === "qr") { expect(footer).toEqual([]); return; }
      if (!footer.length) throw new Error(`${label}: no signature`);
      expect(footer.map((l) => l.text.trim()).join(" ").replace(/\s+/g, " ")).toBe(SIGNATURE);
      const top = Math.min(...footer.map((l) => l.y));
      for (const box of boxes(layout)) if (box.bottom > top) throw new Error(`${label}: content at ${box.bottom} runs into the signature at ${top}`);
      for (const l of footer) {
        expect(l.y + l.height).toBeLessThanOrEqual(layout.height);
        expect(l.x).toBeGreaterThanOrEqual(0);
        expect(l.x + l.width).toBeLessThanOrEqual(layout.width + 0.1);
        expect(l.secondary).toBe(true);
      }
    });
    // Short content in a fixed frame: the footer fits in the frame, no growth (so a GIF does not scroll).
    for (const content of TEMPLATE_SAMPLES) for (const variant of templateRegistration(content.kind).variants.map((v) => v.id)) {
      const plain = layoutTemplate(samplePlan(content, variant), metrics);
      const contentBottom = Math.max(...plain.lines.map((l) => l.y + l.height), ...plain.images.filter((i) => !i.field).map((i) => i.y + i.height),
        ...plain.shapes.filter((r) => r.height < plain.height / 2).map((r) => r.y + r.height));
      // Room for the footer (gap 40, one 32 px line at leading 1.2, inset 56) in the frame.
      const top = Math.min(...plain.lines.map((l) => l.y), ...plain.shapes.filter((r) => r.height < plain.height / 2).map((r) => r.y));
      if (plain.height > 1080 || contentBottom - top + 72 + 40 + Math.ceil(32 * 1.2 * 1.2) + 56 > 1080) continue;
      const signed = layoutTemplate({ ...samplePlan(content, variant), signature: SIGNATURE }, metrics);
      if (signed.height !== 1080) throw new Error(`${content.kind}/${variant}: the signature grew the frame to ${signed.height}`);
    }
  });
  test("quality checks (checks.ts) pass for every sample, frame and signature; contrast only in the info card's owner-approved colours", () => {
    eachLayout((layout, content, label) => {
      for (const v of checkLayout(layout, { content })) {
        if (v.kind === "contrast" && content.kind === "info") continue;
        throw new Error(`${label}: ${v.kind}: ${v.message}`);
      }
    });
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
