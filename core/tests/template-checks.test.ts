/** The quality checks (templates/checks.ts) and the runtime guard in composeTemplate. */
import { describe, expect, test } from "bun:test";
import { CHECK_THRESHOLDS, checkLayout, contentStrings, contrastRatio, fidelityViolations, type CheckedLayout, type CheckedLine } from "../src/templates/checks.ts";
import { guardLayout, layoutTemplate, type TemplateLayout, type TemplateMeasure } from "../src/templates/compose.ts";
import { ComposeError } from "../src/render/compose.ts";
import { samplePlan } from "./fixtures/templates.ts";

const line = (over: Partial<CheckedLine> = {}): CheckedLine => ({ text: "hello", x: 100, y: 100, width: 200, height: 48, size: 40, color: "#18181b", ...over });
const layout = (lines: CheckedLine[], over: Partial<CheckedLayout> = {}): CheckedLayout => ({ width: 1080, height: 1080, background: "#fbfaf6", lines, shapes: [], ...over });
const kinds = (l: CheckedLayout, content = { kind: "text" as const, paragraphs: ["hello world"] }) => checkLayout(l, { content }).map((v) => v.kind);
const metrics: TemplateMeasure = { width: (t, size) => [...t].length * size * 0.6, lineHeight: (size) => size * 1.2 };

describe("template checks", () => {
  test("a clean layout has no violations", () => {
    expect(kinds(layout([line({ text: "hello world", width: 264 })]))).toEqual([]);
  });
  test("each kind is found", () => {
    expect(kinds(layout([line({ text: "hello world", size: 28 })]))).toContain("size");
    expect(kinds(layout([line({ text: "hello world", size: 32, secondary: true })]))).not.toContain("size");
    expect(kinds(layout([line({ text: "hello world", size: 40 })], { width: 1920 }))).toContain("size");
    expect(kinds(layout([line({ text: "hello world", x: 1000 })]))).toContain("overflow");
    expect(kinds(layout([line({ text: "hello world", y: 1060 })]))).toContain("overflow");
    expect(kinds(layout([line({ text: "hello" }), line({ text: "world", y: 120 })]))).toContain("overlap");
    expect(kinds(layout([line({ text: "hello" }), line({ text: "world", y: 148 })]))).not.toContain("overlap");
    expect(kinds(layout([line({ text: "hello world", color: "#c9c5bb" })]))).toContain("contrast");
    // Large type needs 3:1 only.
    expect(contrastRatio("#8a857a", "#fbfaf6")).toBeGreaterThan(CHECK_THRESHOLDS.contrast.large);
    expect(kinds(layout([line({ text: "hello world", size: 56, color: "#8a857a" })]))).not.toContain("contrast");
    expect(kinds(layout([line({ text: "hello world", size: 40, color: "#8a857a" })]))).toContain("contrast");
    // The ground under a line is the topmost shape there.
    expect(kinds(layout([line({ text: "hello world", color: "#ffffff" })], { shapes: [{ x: 0, y: 0, width: 1080, height: 1080, color: "#18181b" }] }))).not.toContain("contrast");
    expect(kinds(layout([line({ text: "hello world" }), line({ text: "added", y: 300 })]))).toContain("untraceable");
    expect(kinds(layout([line({ text: "hello" })]))).toContain("missing");
  });
  test("generated numbers and the signature are the only exemptions", () => {
    const list = { kind: "list" as const, ordered: true, items: ["一", "二"] };
    const base = [line({ text: "一" }), line({ text: "二", y: 200 })];
    expect(fidelityViolations(layout([...base, line({ text: "2", x: 20, width: 40, generated: true })]), { content: list })).toEqual([]);
    expect(fidelityViolations(layout([...base, line({ text: "3", x: 20, width: 40, generated: true })]), { content: list }).map((v) => v.kind)).toEqual(["untraceable"]);
    expect(fidelityViolations(layout([...base, line({ text: "2", x: 20, width: 40 })]), { content: list }).map((v) => v.kind)).toEqual(["untraceable"]);
    expect(fidelityViolations(layout([...base, line({ text: "@nya", y: 900, signature: true })]), { content: list })).toEqual([]);
    // QR's caption is optional, but nothing else may be written.
    expect(fidelityViolations(layout([]), { content: { kind: "qr", data: "https://peesuto.com" } })).toEqual([]);
  });
  test("document Markdown is compared without its bold markers; code keeps them", () => {
    expect(contentStrings({ kind: "document", paragraphs: ["a **b** c"] })).toEqual(["a b c"]);
    expect(contentStrings({ kind: "code", code: "f(**kwargs)" })).toEqual(["f(**kwargs)"]);
  });
});

describe("runtime guard", () => {
  const plan = samplePlan({ kind: "list", ordered: false, items: ["买牛奶", "回电话"] });
  const good = () => layoutTemplate(plan, metrics);
  test("a real layout passes and logs nothing", () => {
    const logged: string[] = [];
    expect(guardLayout(good(), plan, (l) => logged.push(l))).toEqual([]);
    expect(logged).toEqual([]);
  });
  test("untraceable text is a fidelity error and overflow an overflow error; nothing renders", () => {
    const added: TemplateLayout = { ...good() }; added.lines = [...added.lines, { ...added.lines[0]!, text: "广告", y: 10 }];
    expect(() => guardLayout(added, plan, () => {})).toThrow(ComposeError);
    try { guardLayout(added, plan, () => {}); } catch (e) { expect((e as ComposeError).code).toBe("fidelity"); }
    const wide: TemplateLayout = { ...good() }; wide.lines = wide.lines.map((l, i) => (i ? l : { ...l, x: 1070 }));
    try { guardLayout(wide, plan, () => {}); throw new Error("no throw"); } catch (e) { expect((e as ComposeError).code).toBe("overflow"); }
  });
  test("the source ledger: a dropped character is a fidelity error (code line numbers, list numbers and the signature are exempt)", () => {
    const truncated: TemplateLayout = { ...good() }; truncated.lines = truncated.lines.map((l, i) => (i ? l : { ...l, text: l.text.slice(0, -1) }));
    try { guardLayout(truncated, plan, () => {}); throw new Error("no throw"); } catch (e) { expect((e as ComposeError).code).toBe("fidelity"); }
    // A repeated character must be drawn as often as the source has it.
    const twice = samplePlan({ kind: "text", paragraphs: ["哈哈"] });
    const once: TemplateLayout = { ...layoutTemplate(twice, metrics) }; once.lines = once.lines.map((l) => ({ ...l, text: "哈" }));
    expect(() => guardLayout(once, twice, () => {})).toThrow(ComposeError);
    const code = samplePlan({ kind: "code", code: "a = 1\nb = 2" });
    expect(guardLayout(layoutTemplate({ ...code, signature: "@nya" }, metrics), code, () => {})).toEqual([]);
    const ordered = samplePlan({ kind: "list", ordered: true, items: ["一", "二"] });
    expect(guardLayout(layoutTemplate(ordered, metrics), ordered, () => {})).toEqual([]);
    // QR: the caption may go, nothing else may be written.
    const qr = samplePlan({ kind: "qr", data: "https://peesuto.com" });
    const bare: TemplateLayout = { ...layoutTemplate(qr, metrics) }; bare.lines = [];
    expect(guardLayout(bare, qr, () => {})).toEqual([]);
  });
  test("the ledger is cheap: a full card checks in a few milliseconds", () => {
    const long = samplePlan({ kind: "document", paragraphs: Array.from({ length: 24 }, (_, i) => `第 ${i + 1} 段：把复杂的想法讲清楚，需要先把它想清楚，再删掉所有不必要的部分。Keep every word.`) });
    const l = layoutTemplate(long, metrics);
    const started = performance.now();
    for (let i = 0; i < 10; i++) guardLayout(l, long, () => {});
    expect((performance.now() - started) / 10).toBeLessThan(25);
  });
  test("size and contrast are logged as kinds and counts, never text", () => {
    const faint: TemplateLayout = { ...good() }; faint.lines = faint.lines.map((l) => ({ ...l, color: "#e4dfd4" }));
    const logged: string[] = [];
    expect(guardLayout(faint, plan, (l) => logged.push(l)).every((v) => v.kind === "contrast")).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/list\/classic .*contrast/);
    expect(logged[0]).not.toContain("牛奶");
  });
});

describe("painted text (Pocket Motion v0.4.0 paint)", () => {
  const on = (l: CheckedLine, background = "#fbfaf6") => kinds(layout([{ ...l, text: "hello world", width: 264 }], { background }));
  test("gradient ink counts both of its stops", () => {
    expect(on(line({ paint: { gradient: { from: "#18181b", to: "#27272a" } } }))).toEqual([]);
    expect(on(line({ color: "#18181b", paint: { gradient: { from: "#18181b", to: "#f4f4f5" } } }))).toContain("contrast");
  });
  test("hollow text is its outline, and only at the large size", () => {
    expect(on(line({ size: 96, height: 110, color: "#fbfaf6", paint: { stroke: { width: 3, color: "#b8321e", hollow: true } } }))).toEqual([]);
    expect(on(line({ size: 96, height: 110, paint: { stroke: { width: 3, color: "#f0ede6", hollow: true } } }))).toContain("contrast");
    expect(on(line({ size: 40, paint: { stroke: { width: 3, color: "#b8321e", hollow: true } } }))).toContain("contrast");
  });
  test("a wide enough outline is a halo: a fill that fails on the ground passes against it", () => {
    const pale = line({ color: "#f4f4f5" });
    expect(on(pale)).toContain("contrast");
    expect(on({ ...pale, paint: { stroke: { width: 40 * CHECK_THRESHOLDS.haloEm, color: "#18181b" } } })).toEqual([]);
    expect(on({ ...pale, paint: { stroke: { width: 1, color: "#18181b" } } })).toContain("contrast");
  });
});

describe("paint class tokens", () => {
  test("gradient, outline, glow and the soft disc", async () => {
    const { paintClasses, softFill } = await import("../src/templates/compose.ts");
    expect(paintClasses(undefined, "#111111")).toBe("text-[#111111]");
    expect(paintClasses({ gradient: { from: "#ffeeaa", to: "#ff9900", fromAt: 0.22, toAt: 0.86 } }, "#111111"))
      .toBe("bg-clip-text text-transparent bg-linear-180 from-[#ffeeaa] from-22% to-[#ff9900] to-86%");
    expect(paintClasses({ stroke: { width: 2, color: "#b8321e", position: "outside", hollow: true }, glow: { radius: 40, color: "#ffd23f66", gain: 1 } }, "#111111"))
      .toBe("text-transparent text-stroke-[2px] text-stroke-[#b8321e] text-stroke-outside glow-[40px] glow-[#ffd23f66]");
    expect(softFill("#9a1f13", 0.4)).toBe("bg-[radial-gradient(#9a1f13,#9a1f13_42.4%,#9a1f1300_70.7%)]");
  });
});
