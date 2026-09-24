/** Hue-arc gradients: colourful all the way, unlike a straight RGB blend. */
import { describe, expect, test } from "bun:test";
import { oklchHex, sampleArc } from "../src/templates/gradient.ts";
import { CODE_STYLES, layoutTemplate, type TemplateMeasure } from "../src/templates/compose.ts";
import { samplePlan } from "./fixtures/templates.ts";

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
/** HSV saturation, 0 for grey. */
const saturation = (c: number[]) => { const max = Math.max(...c), min = Math.min(...c); return max ? (max - min) / max : 0; };
const mid = (a: string, b: string) => rgb(a).map((v, i) => (v + rgb(b)[i]!) / 2);

describe("hue arcs", () => {
  test("colours are #rrggbb, out-of-gamut chroma is reduced rather than clipped to another hue", () => {
    expect(oklchHex({ l: 0, c: 0, h: 0 })).toBe("#000000");
    expect(oklchHex({ l: 1, c: 0, h: 0 })).toBe("#ffffff");
    const vivid = oklchHex({ l: 0.7, c: 0.4, h: 150 }); // far outside sRGB
    expect(vivid).toMatch(/^#[0-9a-f]{6}$/);
    const [r, g, b] = rgb(vivid);
    expect(g).toBeGreaterThan(r!); expect(g).toBeGreaterThan(b!); // still green
  });

  test("the code backdrop never passes through grey, even between segment stops", () => {
    const layer = CODE_STYLES.classic.gifBackdrop[0]!;
    const colors = sampleArc(layer.arc, layer.segments);
    expect(colors).toHaveLength(layer.segments + 1);
    for (const c of colors) expect(saturation(rgb(c))).toBeGreaterThan(0.45);
    for (let i = 0; i < layer.segments; i++) expect(saturation(mid(colors[i]!, colors[i + 1]!))).toBeGreaterThan(0.45);
    // The two ends blended straight in RGB would be much greyer: the reason for the arc.
    expect(saturation(mid(colors[0]!, colors.at(-1)!))).toBeLessThan(saturation(mid(colors[3]!, colors[5]!)));
  });

  test("segments tile the full width on whole pixels, each stop shared with its neighbour", () => {
    const metrics: TemplateMeasure = { width: (t, s) => [...t].length * s * 0.6, lineHeight: (s) => s * 1.2 };
    const layout = layoutTemplate(samplePlan({ kind: "code", code: "echo hi" }), metrics, { format: "gif" });
    const segments = layout.shapes.filter((s) => s.gradient && s.y === 0).sort((a, b) => a.x - b.x);
    expect(segments.length).toBe(CODE_STYLES.classic.gifBackdrop[0]!.segments);
    expect(segments[0]!.x).toBe(0);
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.x).toBe(segments[i - 1]!.x + segments[i - 1]!.width);
      expect(segments[i]!.gradient!.from).toBe(segments[i - 1]!.gradient!.to);
    }
    const last = segments.at(-1)!;
    expect(last.x + last.width).toBe(layout.width);
    for (const s of segments) { expect(Number.isInteger(s.x)).toBe(true); expect(s.height).toBe(layout.height); }
  });
});
