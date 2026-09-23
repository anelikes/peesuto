import { describe, expect, test } from "bun:test";
import { encodeQr, qrRuns, QR_MAX_BYTES } from "../src/templates/qr.ts";
import { layoutTemplate, qrCaption, type TemplateMeasure } from "../src/templates/compose.ts";
import { decideTemplate } from "../src/templates/decide.ts";
import { parseTemplates } from "../src/templates/parse.ts";
import { ComposeError } from "../src/render/compose.ts";
import { BUILTIN_ACTIONS } from "../src/actions/builtin.ts";
import { samplePlan } from "./fixtures/templates.ts";

const metrics: TemplateMeasure = {
  width: (text, size) => [...text].length * size * 0.6,
  lineHeight: (size) => size * 1.2,
};

describe("QR encoding", () => {
  test("any text encodes; size grows with the data; the level falls back from M to L", () => {
    expect(encodeQr("https://peesuto.com").size).toBe(25);
    expect(encodeQr("你好，世界 🎉").level).toBe("M");
    const big = encodeQr("汉".repeat(900)); // 2,700 bytes: too much for M, fits L
    expect(big.level).toBe("L");
    expect(big.size).toBeGreaterThanOrEqual(165); // version 38+
  });
  test("over capacity is an explicit qr-too-long error, never truncation", () => {
    expect(() => encodeQr("汉".repeat(1000))).toThrow(ComposeError);
    try { encodeQr("x".repeat(QR_MAX_BYTES + 1)); } catch (e) { expect((e as ComposeError).code).toBe("qr-too-long"); }
  });
  test("runs cover exactly the dark modules", () => {
    const m = encodeQr("peesuto");
    const dark = new Set<string>();
    for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.isDark(r, c)) dark.add(`${r},${c}`);
    const covered = new Set<string>();
    for (const run of qrRuns(m)) for (let i = 0; i < run.length; i++) covered.add(`${run.row},${run.col + i}`);
    expect(covered).toEqual(dark);
  });
});

describe("QR template", () => {
  test("always a candidate, never chosen automatically, even when a model names it", async () => {
    for (const text of ["少即是多。", "graph TD\n A --> B", "| a | b |\n| --- | --- |\n| 1 | 2 |"]) {
      const parsed = parseTemplates(text);
      expect(parsed.candidates.has("qr")).toBe(true);
      expect(parsed.preferred).not.toBe("qr");
    }
    const answers = { template: { choice: "qr", probabilities: { qr: 0.99 } } };
    const d = await decideTemplate("少即是多。", { output: "image", decider: { name: "fixture", ask: async () => answers } });
    expect(d.plan.template).not.toBe("qr");
  });
  test("the source is encoded exactly (surrounding whitespace aside), not the cleaned text", () => {
    const qr = parseTemplates("  a\u2005b\n").candidates.get("qr");
    expect(qr).toEqual({ kind: "qr", data: "a\u2005b" });
  });
  test("the paste-qr action is fixed to the QR template; GIF motion falls back to reveal", async () => {
    const spec = BUILTIN_ACTIONS.find((a) => a.id === "paste-qr")!;
    expect(spec.render?.template).toBe("qr");
    const gif = await decideTemplate("hello", { output: "gif", decider: null, override: { id: "qr", motion: "typewriter" } });
    expect(gif.plan.motion).toBe("reveal");
  });
  test("layout: whole-pixel modules, a 4-module quiet zone, centered; a caption only for one short line", () => {
    const url = layoutTemplate({ ...samplePlan({ kind: "qr", data: "https://peesuto.com" }), aspect: "1:1" }, metrics);
    const modules = url.shapes.slice(1);
    const unit = Math.min(...modules.map((r) => r.height));
    expect(Number.isInteger(unit)).toBe(true);
    for (const r of modules) { expect(r.height).toBe(unit); expect(r.width % unit).toBe(0); }
    const plate = url.shapes[0]!;
    expect(Math.min(...modules.map((r) => r.x)) - plate.x).toBe(4 * unit);
    expect(url.lines.map((l) => l.text).join("")).toBe("https://peesuto.com");
    const long = layoutTemplate({ ...samplePlan({ kind: "qr", data: "第一行\n第二行" }), aspect: "1:1" }, metrics);
    expect(long.lines).toHaveLength(0);
    expect(qrCaption({ data: "x".repeat(61) })).toBeUndefined();
  });
  test("auto frame is square around the code, taller only for the caption", () => {
    const plain = layoutTemplate({ ...samplePlan({ kind: "qr", data: "第一行\n第二行" }), aspect: "auto" }, metrics);
    expect(plain.height).toBe(plain.width);
  });
});
