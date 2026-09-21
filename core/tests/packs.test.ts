import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_CATALOG } from "../src/catalog.ts";
import { loadPacks, parseCatalogFragment, parsePackManifest, PackError } from "../src/packs.ts";
import { buildRequest } from "../src/questions.ts";

const neon = { description: "deep blue with a magenta glow, for launches", colors: { bg: "#050014", bg2: "#12003a", ink: "#f5f0ff", muted: "#b39ddb", accent: "#ff2d95" } };

describe("packs", () => {
  test("manifest and fragment validation", () => {
    expect(parsePackManifest({ id: "neon-pack", name: "Neon", version: "1.0.0", kind: "styles" }).kind).toBe("styles");
    expect(() => parsePackManifest({ id: "Bad Id", name: "x", version: "1", kind: "styles" })).toThrow(PackError);
    expect(() => parsePackManifest({ id: "ok", name: "x", version: "1", kind: "themes" })).toThrow(PackError);
    expect(parseCatalogFragment({ palettes: { neon } }).palettes?.neon?.colors.accent).toBe("#ff2d95");
    expect(() => parseCatalogFragment({ palettes: { neon: { ...neon, colors: { ...neon.colors, accent: "pink" } } } })).toThrow(PackError);
    expect(() => parseCatalogFragment({ kinds: {} })).toThrow(PackError);
  });
  test("a styles pack merges its palettes; the decider is offered them; a broken pack is a problem", async () => {
    const packs = await mkdtemp(join(tmpdir(), "paste-packs-"));
    await mkdir(join(packs, "neon"));
    await writeFile(join(packs, "neon/pack.json"), JSON.stringify({ id: "neon-pack", name: "Neon", version: "1.0.0", kind: "styles" }));
    await writeFile(join(packs, "neon/catalog.json"), JSON.stringify({ palettes: { neon, ink: { ...neon, description: "overrides the base ink" } } }));
    await mkdir(join(packs, "broken"));
    await writeFile(join(packs, "broken/pack.json"), JSON.stringify({ id: "broken", name: "B", version: "1", kind: "styles" }));
    const r = await loadPacks(packs);
    expect(r.packs.map((p) => p.id)).toEqual(["broken", "neon-pack"]);
    expect(Object.keys(r.catalog.palettes)).toEqual(expect.arrayContaining(["ink", "paper", "cyan", "amber", "neon"]));
    expect(r.catalog.palettes.ink?.description).toBe("overrides the base ink");
    expect(r.problems.length).toBe(1);
    const q = buildRequest("hello", r.catalog).body.questions as { palette: { criteria: Record<string, string> } };
    expect(q.palette.criteria.neon).toBe(neon.description);
    expect(BASE_CATALOG.palettes.neon).toBeUndefined();
  });
  test("no packs dir → the base catalog", async () => {
    const r = await loadPacks(undefined);
    expect(r.catalog).toBe(BASE_CATALOG);
    expect(r.packs).toEqual([]);
  });
});
