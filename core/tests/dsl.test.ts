import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ASPECTS, type Dsl, DslError, isAspect, KINDS, LAYOUTS, PALETTES, parseDsl } from "../src/dsl.ts";

const FIXTURES = join(import.meta.dir, "../fixtures");
/** Every job file; digests.json is the record of what they render to, not a job. */
const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json") && f !== "digests.json").sort();
const fixture = (f: string): unknown => JSON.parse(readFileSync(join(FIXTURES, f), "utf8"));

describe("parseDsl accepts every fixture", () => {
  test("there are fixtures", () => expect(files.length).toBeGreaterThan(0));
  for (const f of files) {
    test(f, () => {
      const raw = fixture(f);
      const dsl = parseDsl(raw);
      expect(dsl).toEqual(raw as Dsl);
      expect(KINDS).toContain(dsl.kind);
      expect(LAYOUTS).toContain(dsl.layout);
      expect(PALETTES as readonly string[]).toContain(dsl.palette);
      expect(ASPECTS).toContain(dsl.aspect);
    });
  }
});

describe("parseDsl rejects", () => {
  const good = fixture("plain.json") as Record<string, unknown>;
  const withField = (k: string, v: unknown) => () => parseDsl({ ...good, [k]: v });

  test("the fixture itself is good", () => expect(() => parseDsl(good)).not.toThrow());
  test("non-objects", () => {
    expect(() => parseDsl(null)).toThrow(DslError);
    expect(() => parseDsl("text")).toThrow(DslError);
    expect(() => parseDsl(undefined)).toThrow(DslError);
  });
  test("empty text", () => {
    expect(withField("text", "")).toThrow(DslError);
    expect(withField("text", "   \n")).toThrow(DslError);
    expect(withField("text", 42)).toThrow(DslError);
  });
  test("a bad kind", () => {
    expect(withField("kind", "poem")).toThrow(DslError);
    expect(withField("kind", "event")).toThrow(DslError);
  });
  test("a bad layout, palette or aspect", () => {
    expect(withField("layout", "diagonal")).toThrow(DslError);
    expect(withField("palette", "Neon Lights")).toThrow(DslError);
    expect(withField("palette", "-neon")).toThrow(DslError);
    expect(withField("aspect", "square")).toThrow(DslError);
  });
  test("scale 4", () => expect(withField("scale", 4)).toThrow(DslError));
  test("tone out of range or fractional", () => {
    expect(withField("tone", -1)).toThrow(DslError);
    expect(withField("tone", 1.5)).toThrow(DslError);
  });
  test("emphasis -2", () => {
    expect(withField("emphasis", -2)).toThrow(DslError);
    expect(withField("emphasis", 1.5)).toThrow(DslError);
    expect(withField("emphasis", "w7")).toThrow(DslError);
  });
  test("non-boolean animate", () => {
    expect(withField("animate", "yes")).toThrow(DslError);
    expect(withField("animate", 1)).toThrow(DslError);
  });
  test("with a message naming the field", () => {
    expect(withField("scale", 4)).toThrow(/scale/);
    expect(withField("emphasis", -2)).toThrow(/emphasis/);
  });
});

describe("isAspect", () => {
  test("names the three aspects only", () => {
    for (const a of ASPECTS) expect(isAspect(a)).toBe(true);
    expect(isAspect("square")).toBe(false);
    expect(isAspect(undefined)).toBe(false);
  });
});
