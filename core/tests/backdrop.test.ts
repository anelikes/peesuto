/** Colour-field backdrops (templates/backdrop.ts) and the terminal style's `field` backdrop option. */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { CODE_FIELDS, crc32, encodePng, fieldColorAt, fieldKey, fieldPng, fieldTexture, renderField, stageField, textureField, type ColourField } from "../src/templates/backdrop.ts";
import { CODE_STYLES, layoutTemplate, type TemplateMeasure } from "../src/templates/compose.ts";
import { checkLayout, contrastRatio, type CheckedLayout } from "../src/templates/checks.ts";
import { samplePlan } from "./fixtures/templates.ts";

const field = CODE_FIELDS.indigo as ColourField;
const metrics: TemplateMeasure = { width: (t, s) => [...t].length * s * 0.6, lineHeight: (s) => s * 1.2 };

/** Chunks of a PNG, checking every CRC. */
function chunks(png: Uint8Array): { type: string; data: Uint8Array }[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength), out = [];
  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at), type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    expect(view.getUint32(at + 8 + length)).toBe(crc32(png.subarray(at + 4, at + 8 + length)));
    out.push({ type, data }); at += 12 + length;
  }
  return out;
}

describe("colour-field PNG", () => {
  test("signature, IHDR and size; the pixels decode back", () => {
    const png = fieldPng(field, { width: 320, height: 180 });
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const parts = chunks(png);
    expect(parts.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    const ihdr = new DataView(parts[0]!.data.buffer, parts[0]!.data.byteOffset, 13);
    expect([ihdr.getUint32(0), ihdr.getUint32(4), parts[0]!.data[8], parts[0]!.data[9]]).toEqual([320, 180, 8, 2]);
    // Undo the Sub filter and compare with the raster.
    const raw = inflateSync(parts[1]!.data), rgb = renderField(field, { width: 320, height: 180 });
    expect(raw.length).toBe(180 * (320 * 3 + 1));
    const decoded = new Uint8Array(rgb.length);
    for (let j = 0; j < 180; j++) {
      expect(raw[j * 961]).toBe(1);
      for (let k = 0; k < 960; k++) decoded[j * 960 + k] = (raw[j * 961 + 1 + k]! + (k >= 3 ? decoded[j * 960 + k - 3]! : 0)) & 0xff;
    }
    expect([...decoded]).toEqual([...rgb]);
  });

  test("CRC32 matches the reference value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("encodePng refuses a mismatched buffer", () => {
    expect(() => encodePng(2, 2, new Uint8Array(3))).toThrow();
  });

  test("deterministic; the seed moves only the grain", () => {
    const size = { width: 200, height: 120 };
    expect(fieldPng(field, size)).toEqual(fieldPng(field, size));
    const a = renderField(field, size), b = renderField({ ...field, seed: 99 }, size);
    expect(a).not.toEqual(b);
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
    expect(worst).toBeLessThanOrEqual(Math.ceil(2 * 0.012 * 255) + 1);
  });

  test("every palette stays in range and in colour (no NaN, no clipping to black or white)", () => {
    for (const f of Object.values(CODE_FIELDS)) {
      const rgb = renderField({ ...f, grain: 0 } as ColourField, { width: 160, height: 90 });
      // A single channel may reach 0 in a deep blue; a whole pixel never goes to black or white.
      let darkest = 255, lightest = 0;
      for (let i = 0; i < rgb.length; i += 3) {
        const top = Math.max(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!), bottom = Math.min(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!);
        darkest = Math.min(darkest, top); lightest = Math.max(lightest, bottom);
      }
      expect(darkest).toBeGreaterThan(20);
      expect(lightest).toBeLessThan(200);
      for (const [x, y] of [[0, 0], [80, 45], [159, 89]]) expect(fieldColorAt(f as ColourField, { width: 160, height: 90 }, x!, y!)).toMatch(/^#[0-9a-f]{6}$/);
    }
    // Extreme inputs clamp instead of producing NaN.
    const wild: ColourField = { background: { l: 1.2, c: 0.5, h: 30 }, blobs: [{ x: 0.5, y: 0.5, rx: 0, ry: 0, color: { l: -0.2, c: 0.9, h: 200 }, strength: 3 }], grain: 1, vignette: 5 };
    for (const v of renderField(wild, { width: 32, height: 32 })) expect(v >= 0 && v <= 255).toBe(true);
  });

  test("the colour at a point is the rendered pixel without grain", () => {
    const size = { width: 64, height: 64 }, rgb = renderField({ ...field, grain: 0 }, size);
    const hex = fieldColorAt(field, size, 20.5, 40.5), at = (40 * 64 + 20) * 3;
    const expected = [rgb[at], rgb[at + 1], rgb[at + 2]].map((v) => v!.toString(16).padStart(2, "0")).join("");
    const diff = [0, 1, 2].map((i) => Math.abs(parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) - parseInt(expected.slice(2 * i, 2 * i + 2), 16)));
    expect(Math.max(...diff)).toBeLessThanOrEqual(1);
  });

  test("textures are powers of two the engine accepts; the grain shrinks with the stretch", () => {
    for (const [w, h, tw, th] of [[1080, 1080, 512, 512], [1920, 1080, 512, 512], [1080, 4096, 256, 512], [1080, 1350, 512, 512], [4096, 200, 512, 64]]) {
      expect(fieldTexture({ width: w!, height: h! })).toEqual({ width: tw!, height: th! });
    }
    const t = textureField(field, { width: 1024, height: 1024 }, { width: 512, height: 512 });
    expect(t.grain).toBeCloseTo(0.012 / 2, 6);
    expect(textureField(field, { width: 4096, height: 4096 }, { width: 512, height: 512 }).grain).toBeCloseTo(1 / 255, 6); // never below one level
    expect(textureField({ ...field, grain: 0 }, { width: 2048, height: 2048 }, { width: 512, height: 512 }).grain).toBe(0);
  });

  test("cache keys are stable and change with every parameter", () => {
    const size = { width: 1080, height: 1080 };
    const key = fieldKey(field, size);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(fieldKey(JSON.parse(JSON.stringify(field)), { height: 1080, width: 1080 })).toBe(key);
    expect(fieldKey({ ...field, seed: 8 }, size)).not.toBe(key);
    expect(fieldKey({ ...field, grain: 0.02 }, size)).not.toBe(key);
    expect(fieldKey(field, { width: 1080, height: 1082 })).not.toBe(key);
    expect(fieldKey(field, size, { width: 512, height: 512 })).not.toBe(key);
    expect(fieldKey({ ...field, blobs: field.blobs.slice(1) }, size)).not.toBe(key);
  });

  test("an uncached texture renders fast", () => {
    fieldPng(field, { width: 64, height: 64 }); // warm the gamma table and JIT
    const started = performance.now();
    for (const f of Object.values(CODE_FIELDS)) {
      const canvas = { width: 1920, height: 1080 }, raster = fieldTexture(canvas);
      fieldPng(textureField(f as ColourField, canvas, raster), canvas, raster);
    }
    expect((performance.now() - started) / 3).toBeLessThan(60 * 3); // 60 ms target; loose bound for slow CI machines
  });

  test("stageField renders once per key and copies after that", async () => {
    const root = await mkdtemp(join(tmpdir(), "peesuto-field-"));
    try {
      const cache = join(root, "cache"), a = join(root, "a"), b = join(root, "b");
      await Bun.write(join(a, ".keep"), ""); await Bun.write(join(b, ".keep"), "");
      const name = await stageField(field, { width: 1080, height: 1080 }, cache, a);
      expect(name).toMatch(/^bg_[0-9a-f]{16}\.png$/);
      const first = (await stat(join(cache, name))).mtimeMs;
      expect(await stageField(field, { width: 1080, height: 1080 }, cache, b)).toBe(name);
      expect((await stat(join(cache, name))).mtimeMs).toBe(first);
      expect(await Bun.file(join(b, name)).bytes()).toEqual(await Bun.file(join(a, name)).bytes());
      expect((await readdir(cache)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("field backdrops in the terminal style", () => {
  const style = CODE_STYLES.classic as unknown as { backdrop: unknown };
  const withField = <T>(run: () => T): T => {
    const saved = style.backdrop;
    style.backdrop = [{ field }];
    try { return run(); } finally { style.backdrop = saved; }
  };

  test("PNG and MP4 draw the Indigo night field; GIF keeps the hue arc", () => {
    expect(CODE_STYLES.classic.backdrop).toEqual([{ field: CODE_FIELDS.indigo }]);
    expect("arc" in CODE_STYLES.classic.gifBackdrop[0]!).toBe(true);
    const plan = samplePlan({ kind: "code", code: "echo hi" });
    const arcSegments = (l: ReturnType<typeof layoutTemplate>) => l.shapes.filter((s) => s.gradient && s.y === 0 && s.height === l.height);
    for (const format of ["png", "mp4"] as const) {
      const layout = layoutTemplate(plan, metrics, { format });
      const fields = layout.images.filter((i) => i.field);
      expect(fields).toHaveLength(1);
      expect(fields[0]!.field).toBe(CODE_FIELDS.indigo);
      expect(fields[0]).toMatchObject({ x: 0, y: 0, width: layout.width, height: layout.height });
      expect(arcSegments(layout)).toEqual([]);
    }
    const gif = layoutTemplate({ ...plan, motion: "reveal" }, metrics, { format: "gif" });
    expect(gif.images.filter((i) => i.field)).toEqual([]);
    expect(arcSegments(gif)).toHaveLength(CODE_STYLES.classic.gifBackdrop[0]!.segments);
    // Without a format: a still plan is a PNG, an animated one a GIF (renderTemplate's default).
    expect(layoutTemplate(plan, metrics).images.filter((i) => i.field)).toHaveLength(1);
    expect(layoutTemplate({ ...plan, motion: "reveal" }, metrics).images.filter((i) => i.field)).toEqual([]);
  });

  test("the notebook style has no backdrop in any format", () => {
    for (const format of ["png", "gif", "mp4"] as const) {
      const layout = layoutTemplate(samplePlan({ kind: "code", code: "echo hi" }, "editorial"), metrics, { format });
      expect(layout.images.filter((i) => i.field)).toEqual([]);
      expect(layout.shapes.filter((s) => s.gradient)).toEqual([]);
    }
  });

  test("a field is one pinned, full-bleed image stretched to the canvas, instead of gradient rects", () => {
    const code = Array.from({ length: 40 }, (_, i) => `echo line ${i}`).join("\n");
    const layout = withField(() => layoutTemplate({ ...samplePlan({ kind: "code", code }), aspect: "1:1" }, metrics));
    const fields = layout.images.filter((i) => i.field);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ x: 0, y: 0, width: layout.width, height: layout.height });
    expect(layout.shapes.some((s) => s.gradient && s.y === 0)).toBe(false);
  });

  test("text directly on a field is checked against the field there", () => {
    const light: ColourField = { background: { l: 0.95, c: 0.01, h: 90 }, blobs: [] };
    const dark: ColourField = { background: { l: 0.2, c: 0.05, h: 280 }, blobs: [] };
    const on = (f: ColourField): CheckedLayout => ({ width: 1080, height: 1080, background: "#000000", shapes: [],
      images: [{ x: 0, y: 0, width: 1080, height: 1080, field: f }],
      lines: [{ text: "hello world", x: 100, y: 900, width: 264, height: 48, size: 40, color: "#ffffff" }] });
    const kinds = (l: CheckedLayout) => checkLayout(l, { content: { kind: "text", paragraphs: ["hello world"] } }).map((v) => v.kind);
    expect(kinds(on(light))).toContain("contrast");
    expect(kinds(on(dark))).not.toContain("contrast");
  });

  test("the white signature keeps 4.5:1 over each sample field's lower half", () => {
    for (const [name, f] of Object.entries(CODE_FIELDS)) {
      for (const canvas of [{ width: 1080, height: 1080 }, { width: 1920, height: 1080 }, { width: 1080, height: 1920 }]) {
        for (let x = 0; x <= 1; x += 0.1) for (let y = 0.6; y <= 1; y += 0.1) {
          const ratio = contrastRatio("#ffffff", fieldColorAt(f as ColourField, canvas, x * canvas.width, y * canvas.height));
          if (ratio < 4.5) throw new Error(`${name} ${canvas.width}x${canvas.height} at ${x.toFixed(1)},${y.toFixed(1)}: ${ratio.toFixed(2)}`);
        }
      }
    }
  });
});
