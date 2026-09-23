import { describe, expect, test } from "bun:test";
import { layoutDiagram, parseArrowChains, parseMermaid, type DiagramContent } from "../src/templates/diagram.ts";
import { layoutTemplate, type TemplateMeasure } from "../src/templates/compose.ts";
import { parseTemplates } from "../src/templates/parse.ts";
import { decideTemplate } from "../src/templates/decide.ts";
import { samplePlan } from "./fixtures/templates.ts";

const metrics: TemplateMeasure = {
  width: (text, size) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].reduce((n, { segment }) => n + size * (/^[\x00-\x7f]+$/.test(segment) ? 0.55 : 1), 0),
  lineHeight: (size) => size * 1.2,
};

describe("diagram parsing", () => {
  test("Mermaid flowchart: shapes, labels, chains, fan-out and direction", () => {
    const d = parseMermaid("flowchart LR\n  A([开始]) --> B{\"可以吗?\"}\n  B -->|是| C[做] & D(记录)\n  B -- 否 --> E[[停]]\n  C -.-> F\n  D ==> F\n  classDef hot fill:#f00\n  class A hot")!;
    expect(d.direction).toBe("LR");
    expect(d.nodes).toEqual([
      { id: "A", label: "开始", shape: "pill" }, { id: "B", label: "可以吗?", shape: "diamond" }, { id: "C", label: "做", shape: "rect" },
      { id: "D", label: "记录", shape: "round" }, { id: "E", label: "停", shape: "rect" }, { id: "F", label: "F", shape: "rect" },
    ]);
    expect(d.edges).toEqual([
      { from: "A", to: "B", line: "solid", arrow: true },
      { from: "B", to: "C", line: "solid", arrow: true, label: "是" }, { from: "B", to: "D", line: "solid", arrow: true, label: "是" },
      { from: "B", to: "E", line: "solid", arrow: true, label: "否" },
      { from: "C", to: "F", line: "dotted", arrow: true }, { from: "D", to: "F", line: "thick", arrow: true },
    ]);
  });
  test("graph defaults to top-down; TB means TD; <br> breaks a label; links without arrows", () => {
    const d = parseMermaid("graph\n  a[one<br/>two] --- b\n  b --> c")!;
    expect(d.direction).toBe("TD");
    expect(d.nodes[0]!.label).toBe("one\ntwo");
    expect(d.edges[0]).toEqual({ from: "a", to: "b", line: "solid", arrow: false });
    expect(parseMermaid("flowchart TB\n a-->b")!.direction).toBe("TD");
  });
  test("subgraphs are flattened; other diagram kinds and broken syntax are not diagrams", () => {
    expect(parseMermaid("flowchart TD\n subgraph one\n  a --> b\n end\n b --> c")!.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(parseMermaid("sequenceDiagram\n  Alice->>Bob: Hi")).toBeUndefined();
    expect(parseMermaid("flowchart TD\n  a --> ")).toBeUndefined();
    expect(parseMermaid("flowchart TD\n  a[unclosed --> b")).toBeUndefined();
    expect(parseMermaid("flowchart TD\n  a")).toBeUndefined(); // one node, no edge
  });
  test("arrow chains: shared labels are one node; one short chain goes sideways", () => {
    const one = parseArrowChains("需求 → 设计 → 开发")!;
    expect(one.direction).toBe("LR");
    expect(one.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["需求>设计", "设计>开发"]);
    const many = parseArrowChains("登录 -> 首页 -> 设置\n首页 -> 历史")!;
    expect(many.direction).toBe("TD");
    expect(many.nodes.map((n) => n.label)).toEqual(["登录", "首页", "设置", "历史"]);
    for (const source of ["just a sentence", "a -> b\nplain line", "x => { return 1; }", "-> b"]) expect(parseArrowChains(source)).toBeUndefined();
  });
});

describe("diagram in the template set", () => {
  test("Mermaid, fenced or bare, and arrow chains prefer the diagram template", () => {
    const fenced = parseTemplates("```mermaid\ngraph TD\n  A --> B\n```");
    expect(fenced.preferred).toBe("diagram");
    expect(fenced.candidates.has("code")).toBe(true);
    expect(parseTemplates("graph TD\n  A --> B").preferred).toBe("diagram");
    expect(parseTemplates("graph TD\n  A --> B").candidates.has("text")).toBe(false);
    expect(parseTemplates("设置 → 通用 → 快捷键").preferred).toBe("diagram");
    expect(parseTemplates("const f = (x) => x * 2;").candidates.has("diagram")).toBe(false);
  });
  test("a JS arrow function or a sentence mentioning an arrow never becomes a diagram", async () => {
    for (const source of ["items.map((x) => x.id)", "点 设置 → 通用，然后在快捷键里录一个新组合，再点保存。"]) {
      expect((await decideTemplate(source, { aspect: "chat", output: "image", decider: null })).plan.template).not.toBe("diagram");
    }
  });
});

const box = (w: number, h: number) => () => ({ width: w, height: h });
const spacing = { rankGap: 80, nodeGap: 40, labelGap: 12, dummyWidth: 8 };
const label = () => ({ width: 40, height: 24 });
function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("diagram layout", () => {
  const graph = parseMermaid("flowchart TD\n A-->B\n A-->C\n B-->D\n C-->D\n A-->D\n D-->A")!;
  test("ranks go down, nodes never overlap, a cycle is still drawn", () => {
    const g = layoutDiagram(graph, box(120, 60), spacing, label);
    const at = new Map(g.nodes.map((n) => [n.id, n]));
    expect(at.get("A")!.y).toBeLessThan(at.get("B")!.y);
    expect(at.get("B")!.y).toBeLessThan(at.get("D")!.y);
    for (const a of g.nodes) for (const b of g.nodes) if (a !== b) expect(overlaps(a, b)).toBe(false);
    expect(g.edges).toHaveLength(6);
  });
  test("edges are orthogonal and end on their target's border", () => {
    const g = layoutDiagram(graph, box(120, 60), spacing, label);
    const at = new Map(g.nodes.map((n) => [n.id, n]));
    for (const e of g.edges) {
      for (let i = 1; i < e.points.length; i++) {
        const a = e.points[i - 1]!, b = e.points[i]!;
        expect(a.x === b.x || a.y === b.y).toBe(true);
      }
      const end = e.points.at(-1)!, target = at.get(e.edge.to)!;
      const onBorder = end.y === target.y || end.y === target.y + target.height || end.x === target.x || end.x === target.x + target.width;
      expect(onBorder).toBe(true);
    }
  });
  test("a long edge bends around the rank between instead of crossing its nodes", () => {
    const g = layoutDiagram(graph, box(120, 60), spacing, label);
    const long = g.edges.find((e) => e.edge.from === "A" && e.edge.to === "D")!;
    const middle = g.nodes.filter((n) => n.id === "B" || n.id === "C");
    for (let i = 1; i < long.points.length; i++) {
      const a = long.points[i - 1]!, b = long.points[i]!;
      const seg = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x) + 0.1, height: Math.abs(a.y - b.y) + 0.1 };
      for (const n of middle) expect(overlaps(seg, n)).toBe(false);
    }
  });
  test("LR lays ranks left to right; BT and RL mirror", () => {
    const chain: DiagramContent = parseArrowChains("a -> b -> c")!;
    const lr = layoutDiagram(chain, box(100, 50), spacing, label);
    expect(lr.nodes[0]!.x).toBeLessThan(lr.nodes[1]!.x);
    expect(lr.nodes[0]!.y).toBe(lr.nodes[1]!.y);
    const bt = layoutDiagram({ ...chain, direction: "BT" }, box(100, 50), spacing, label);
    expect(bt.nodes[0]!.y).toBeGreaterThan(bt.nodes[1]!.y);
  });
});

describe("diagram composition", () => {
  const content = parseMermaid("flowchart TD\n A([开始]) --> B{可以吗?}\n B -->|是| C[做]\n B -->|否| D[停]")!;
  test("every label is drawn once, in rank order; nothing added", () => {
    const layout = layoutTemplate(samplePlan(content), metrics);
    const texts = layout.lines.map((line) => line.text);
    expect(texts.sort()).toEqual(["可以吗?", "否", "做", "停", "开始", "是"].sort());
    expect(layout.images.some((image) => image.src.startsWith("arrow-down"))).toBe(true);
    expect(layout.images.some((image) => image.src.startsWith("diamond-"))).toBe(true);
    for (const name of new Set(layout.images.map((image) => image.src))) expect(layout.assets[name]).toContain("<svg");
    const groups = layout.lines.map((line) => line.group);
    expect(groups).toEqual([...groups].sort((a, b) => a - b));
  });
  test("everything stays inside the card; styles differ in geometry, not just color", () => {
    const flow = layoutTemplate(samplePlan(content), metrics);
    const blueprint = layoutTemplate(samplePlan(content, "editorial"), metrics);
    for (const layout of [flow, blueprint]) {
      for (const shape of layout.shapes) expect(shape.x >= 0 && shape.x + shape.width <= layout.width).toBe(true);
      for (const line of layout.lines) expect(line.x + line.width).toBeLessThanOrEqual(layout.width);
    }
    expect(flow.shapes.map((s) => [s.x, s.width])).not.toEqual(blueprint.shapes.map((s) => [s.x, s.width]));
  });
  test("a fan-out too wide for the card is an explicit overflow", () => {
    const wide = parseMermaid(`flowchart TD\n${Array.from({ length: 30 }, (_, i) => ` root --> n${i}[第 ${i} 个很长的节点名称]`).join("\n")}`)!;
    expect(() => layoutTemplate(samplePlan(wide), metrics)).toThrow(/wide/);
  });
});
