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
  test("size and contrast are logged as kinds and counts, never text", () => {
    const faint: TemplateLayout = { ...good() }; faint.lines = faint.lines.map((l) => ({ ...l, color: "#e4dfd4" }));
    const logged: string[] = [];
    expect(guardLayout(faint, plan, (l) => logged.push(l)).every((v) => v.kind === "contrast")).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/list\/classic .*contrast/);
    expect(logged[0]).not.toContain("牛奶");
  });
});
