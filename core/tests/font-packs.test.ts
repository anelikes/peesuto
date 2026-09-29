import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FontParseError, fontFaces } from "../src/fonts/font-names.ts";
import {
  BUNDLED_DIR, BUNDLED_ID, CJK_RANGES, FAMILY_ALIASES, fontPackStatus, fontPacksRoot, JIZURA_FACES, JIZURA_FAMILIES, jizuraFontFiles,
  jizuraPackManifest, packUrl, parseManifest, type JizuraPackManifest,
} from "../src/fonts/jizura-packs.ts";
import { extractTar, TarError, writeTar } from "../src/fonts/tar.ts";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const REPO = join(import.meta.dir, "../..");
const manifest = jizuraPackManifest();
const bundledFile = (family: string, cut: boolean) => manifest.bundled.families.find((f) => f.family === family && !!f.lacks === cut);

describe("font packs: the committed manifest", () => {
  test("parses, and covers every face JIZURA asks for exactly once", () => {
    expect(JIZURA_FAMILIES.length).toBe(new Set(JIZURA_FAMILIES).size);
    for (const face of JIZURA_FACES) {
      const full = manifest.bundled.families.filter((f) => f.family === face.family && !f.lacks);
      const inPacks = manifest.packs.filter((p) => p.families.some((f) => f.family === face.family));
      expect({ family: face.family, places: (full.length ? 1 : 0) + inPacks.length }).toEqual({ family: face.family, places: 1 });
      const weights = (full.length ? full : inPacks[0]!.families.filter((f) => f.family === face.family)).map((f) => f.weight);
      // static Noto CJK has no 800: JIZURA's Serif 800 snaps to 900
      for (const w of face.weights) expect({ family: face.family, w, ok: weights.includes(w) || (w === 800 && weights.includes(900)) }).toEqual({ family: face.family, w, ok: true });
    }
    for (const f of [...manifest.bundled.families, ...manifest.packs.flatMap((p) => p.families)]) expect(JIZURA_FAMILIES).toContain(f.family);
  });

  test("a Chinese or Korean lyric never needs the Japanese pack, and every pack serves one language", () => {
    for (const p of manifest.packs) {
      expect(p.langs.length).toBe(1);
      for (const f of p.families) expect(JIZURA_FACES.find((x) => x.family === f.family)!.langs).toContain(p.langs[0]!);
    }
    // what each language needs beyond the base is in exactly one pack
    for (const lang of ["ja", "zh-Hans", "zh-Hant", "ko"] as const) {
      const needs = JIZURA_FACES.filter((f) => f.langs.includes(lang)).map((f) => f.family).filter((f) => !bundledFile(f, false));
      const packs = new Set(needs.map((f) => manifest.packs.find((p) => p.families.some((x) => x.family === f))!.id));
      expect({ lang, packs: packs.size }).toEqual({ lang, packs: 1 });
    }
  });

  test("the bundled fonts are there, at the listed size and SHA-256, with their licences, under ~15 MB", async () => {
    let total = 0;
    for (const f of [...manifest.bundled.families, ...manifest.bundled.licenses]) {
      const data = readFileSync(join(BUNDLED_DIR, f.file));
      expect({ file: f.file, bytes: data.length, sha256: sha(data) }).toEqual({ file: f.file, bytes: f.bytes, sha256: f.sha256 });
      total += data.length;
    }
    expect(total).toBeLessThan(15_000_000);
    const listed = new Set([...manifest.bundled.families, ...manifest.bundled.licenses].map((f) => f.file));
    for (const n of await readdir(BUNDLED_DIR)) if (n !== "README.md") expect(listed.has(n) ? n : `${n} (not in the manifest)`).toBe(n);
    for (const f of manifest.bundled.families) if (f.lacks) expect(f.lacks).toEqual(CJK_RANGES.map((r) => [...r]));
  });

  test("each bundled font names itself as the family it is listed under (or a known alias)", () => {
    for (const f of manifest.bundled.families) {
      const face = fontFaces(readFileSync(join(BUNDLED_DIR, f.file)))[0]!;
      const names = face.names.flatMap((n) => [n, FAMILY_ALIASES[n] ?? n]);
      expect({ file: f.file, has: names.includes(f.family), weight: face.weight }).toEqual({ file: f.file, has: true, weight: f.weight });
    }
  });

  test("built packs, when present in .work, match the manifest", () => {
    for (const p of manifest.packs) {
      const path = join(REPO, ".work/jizura-font-packs", p.file);
      if (!existsSync(path)) continue;
      const data = readFileSync(path);
      expect({ file: p.file, bytes: data.length, sha256: sha(data) }).toEqual({ file: p.file, bytes: p.bytes, sha256: p.sha256 });
    }
    for (const p of manifest.packs) expect(p.file.startsWith(`${p.id}-${p.sha256.slice(0, 8)}`)).toBe(true);
  });

  test("the host is the fonts-jizura-v1 release on GitHub; each pack is one of its assets", () => {
    // A release a shipped app downloads from is never deleted or re-uploaded: a changed pack gets a new tag and baseUrl.
    expect(manifest.baseUrl).toBe("https://github.com/anelikes/peesuto/releases/download/fonts-jizura-v1/");
    for (const p of manifest.packs) expect(packUrl(p, manifest.baseUrl)).toBe(`https://github.com/anelikes/peesuto/releases/download/fonts-jizura-v1/${p.id}-${p.sha256.slice(0, 8)}.tar`);
  });

  test("manifest validation rejects bad entries", () => {
    const good = JSON.parse(readFileSync(join(REPO, "core/src/fonts/jizura-packs.json"), "utf8"));
    expect(() => parseManifest({ ...good, formatVersion: 2 })).toThrow(/formatVersion/);
    const pack = { id: "x", title: { en: "x", zh: "x", ja: "x" }, langs: ["ja"], file: "x.tar", bytes: 1, sha256: "0".repeat(64), families: [], licenses: [] };
    expect(() => parseManifest({ ...good, packs: [pack, pack] })).toThrow(/twice/);
    expect(() => parseManifest({ ...good, packs: [{ ...pack, file: "../x.tar" }] })).toThrow(/plain file name/);
    expect(() => parseManifest({ ...good, packs: [{ ...pack, sha256: "abc" }] })).toThrow(/sha256/);
    expect(() => parseManifest({ ...good, packs: [{ ...pack, langs: ["fr"] }] })).toThrow(/unknown/);
    expect(() => parseManifest({ ...good, packs: [{ ...pack, id: BUNDLED_ID }] })).toThrow(/twice/);
  });
});

// ── resolution on a synthetic manifest ────────────────────────────────────────

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "font-packs-"));
  const bundled = join(root, "bundled");
  await mkdir(bundled);
  const put = async (dir: string, name: string, text: string) => { const b = new TextEncoder().encode(text); await writeFile(join(dir, name), b); return { file: name, bytes: b.length, sha256: sha(b) }; };
  const dot = await put(bundled, "Dot.woff2", "dot");
  const cut = await put(bundled, "SansJP-Latin.woff2", "cut");
  const lic = await put(bundled, "OFL.txt", "ofl");
  const packFonts = [{ family: "Noto Sans JP", weight: 900, style: "normal" as const, ...(await put(root, "SansJP-Black.woff2", "full-900")) }];
  const packLic = await put(root, "OFL-Pack.txt", "ofl pack");
  const m = parseManifest({
    formatVersion: 1, baseUrl: "https://packs.example.invalid/",
    bundled: { title: { en: "b", zh: "b", ja: "b" }, licenses: [lic], families: [
      { family: "DotGothic16", weight: 400, style: "normal", ...dot },
      { family: "Noto Sans JP", weight: 900, style: "normal", ...cut, lacks: CJK_RANGES },
    ] },
    packs: [{ id: "ja", title: { en: "ja", zh: "ja", ja: "ja" }, langs: ["ja"], file: "ja.tar", bytes: 1, sha256: "a".repeat(64), families: packFonts, licenses: [packLic] }],
  });
  /** Put the pack in place by hand, as an install would leave it. */
  const install = async (dataDir: string) => {
    const dir = join(fontPacksRoot(dataDir), `ja@${"a".repeat(12)}`);
    await mkdir(dir, { recursive: true });
    for (const f of [...packFonts, packLic]) await copyFile(join(root, f.file), join(dir, f.file));
    await writeFile(join(dir, ".pack.json"), JSON.stringify({ id: "ja", sha256: "a".repeat(64) }));
    return dir;
  };
  return { root, bundled, manifest: m as JizuraPackManifest, install };
}

describe("font packs: resolution", () => {
  const saved = process.env.PEESUTO_JIZURA_FONTS_DIR;
  afterEach(() => { if (saved === undefined) delete process.env.PEESUTO_JIZURA_FONTS_DIR; else process.env.PEESUTO_JIZURA_FONTS_DIR = saved; });

  test("bundled faces resolve; a Latin cut counts only for text without CJK; the rest is missing", async () => {
    delete process.env.PEESUTO_JIZURA_FONTS_DIR;
    const fx = await fixture();
    const o = { manifest: fx.manifest, bundledDir: fx.bundled };
    const all = jizuraFontFiles(["DotGothic16", "Noto Sans JP", "Nope"], o);
    expect(all.files).toEqual([{ family: "DotGothic16", weight: 400, style: "normal", path: join(fx.bundled, "Dot.woff2") }]);
    expect(all.missing).toEqual(["Noto Sans JP", "Nope"]);
    expect(jizuraFontFiles(["Noto Sans JP"], { ...o, text: "Hello, world — é ★♪" }).files.map((f) => f.path)).toEqual([join(fx.bundled, "SansJP-Latin.woff2")]);
    expect(jizuraFontFiles(["Noto Sans JP"], { ...o, text: "Hello　world" }).missing).toEqual([]);   // the ideographic space is not drawn
    for (const text of ["こんにちは", "你好", "사랑", "ＡＢＣ", "漢"]) expect(jizuraFontFiles(["Noto Sans JP"], { ...o, text }).missing).toEqual(["Noto Sans JP"]);
  });

  test("an installed pack gives the full face and wins over the cut; a damaged one does not count", async () => {
    delete process.env.PEESUTO_JIZURA_FONTS_DIR;
    const fx = await fixture();
    const dataDir = join(fx.root, "data");
    const o = { manifest: fx.manifest, bundledDir: fx.bundled, dataDir, text: "Latin only" };
    expect(fontPackStatus(o).map((s) => [s.id, s.installed, s.bundled])).toEqual([[BUNDLED_ID, true, true], ["ja", false, false]]);
    const dir = await fx.install(dataDir);
    expect(jizuraFontFiles(["Noto Sans JP"], o).files.map((f) => f.path)).toEqual([join(dir, "SansJP-Black.woff2")]);
    expect(jizuraFontFiles(["Noto Sans JP"], { ...o, text: "漢字" }).missing).toEqual([]);
    expect(fontPackStatus(o).find((s) => s.id === "ja")!.installed).toBe(true);
    await writeFile(join(dir, "SansJP-Black.woff2"), "short");
    expect(jizuraFontFiles(["Noto Sans JP"], { ...o, text: "漢字" }).missing).toEqual(["Noto Sans JP"]);
    expect(fontPackStatus(o).find((s) => s.id === "ja")!.installed).toBe(false);
  });

  test("PEESUTO_JIZURA_FONTS_DIR: files matched by their name tables (aliases included) take precedence", async () => {
    const fx = await fixture();
    const dev = join(fx.root, "dev");
    await mkdir(dev);
    const mono = bundledFile("IBM Plex Mono", false)!;
    const rounded = bundledFile("M PLUS Rounded 1c", true)!;
    await copyFile(join(BUNDLED_DIR, mono.file), join(dev, "anything.woff2"));
    await copyFile(join(BUNDLED_DIR, rounded.file), join(dev, "rounded.woff2"));
    await writeFile(join(dev, "not-a-font.ttf"), "nope");
    process.env.PEESUTO_JIZURA_FONTS_DIR = dev;
    const r = jizuraFontFiles(["IBM Plex Mono", "M PLUS Rounded 1c", "DotGothic16", "Zen Old Mincho"], { manifest: fx.manifest, bundledDir: fx.bundled });
    expect(r.files).toEqual([
      { family: "IBM Plex Mono", weight: 500, style: "normal", path: join(dev, "anything.woff2") },
      { family: "M PLUS Rounded 1c", weight: 800, style: "normal", path: join(dev, "rounded.woff2") },
      { family: "DotGothic16", weight: 400, style: "normal", path: join(fx.bundled, "Dot.woff2") },
    ]);
    expect(r.missing).toEqual(["Zen Old Mincho"]);
  });

  test("the committed base set draws English lyrics with every Japanese face and no download", () => {
    delete process.env.PEESUTO_JIZURA_FONTS_DIR;
    const ja = JIZURA_FACES.filter((f) => f.langs.includes("ja")).map((f) => f.family);
    const r = jizuraFontFiles(ja, { text: "Never gonna give you up — «encore» ★" });
    expect(r.missing).toEqual([]);
    for (const f of r.files) expect(statSync(f.path).size).toBeGreaterThan(1000);
    expect(jizuraFontFiles(ja, { text: "夜に駆ける" }).missing.length).toBe(ja.length - manifest.bundled.families.filter((f) => !f.lacks && ja.includes(f.family)).length);
  });
});

describe("font packs: file formats", () => {
  test("name tables of TrueType, OpenType/CFF and WOFF2 files", () => {
    for (const f of manifest.bundled.families) expect(fontFaces(readFileSync(join(BUNDLED_DIR, f.file))).length).toBe(1);
    expect(() => fontFaces(new TextEncoder().encode("definitely not a font"))).toThrow(FontParseError);
    const src = join(REPO, ".work/jizura-fonts-src");
    if (existsSync(join(src, "NotoSansJP-Black.otf"))) {
      expect(fontFaces(readFileSync(join(src, "NotoSansJP-Black.otf")))[0]).toMatchObject({ family: "Noto Sans JP", weight: 900, style: "normal" });
      expect(fontFaces(readFileSync(join(src, "ZCOOLXiaoWei-Regular.ttf")))[0]).toMatchObject({ family: "ZCOOL XiaoWei", weight: 400 });
    }
  });

  test("tar: round trip, readable by the system tar, strict about names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "font-tar-"));
    const a = new Uint8Array(1000).map((_, i) => i % 251), b = new TextEncoder().encode("licence\n");
    const tar = writeTar([{ name: "A-Black.woff2", data: a }, { name: "OFL.txt", data: b }]);
    expect(tar.length % 512).toBe(0);
    expect(sha(writeTar([{ name: "A-Black.woff2", data: a }, { name: "OFL.txt", data: b }]))).toBe(sha(tar));   // deterministic
    await writeFile(join(dir, "p.tar"), tar);
    const listed = Bun.spawnSync(["tar", "-tf", join(dir, "p.tar")]);
    expect(listed.stdout.toString().trim().split("\n")).toEqual(["A-Black.woff2", "OFL.txt"]);
    await mkdir(join(dir, "x"));
    expect(await extractTar(join(dir, "p.tar"), join(dir, "x"))).toEqual([{ name: "A-Black.woff2", size: 1000 }, { name: "OFL.txt", size: 8 }]);
    expect(sha(readFileSync(join(dir, "x/A-Black.woff2")))).toBe(sha(a));
    for (const name of ["../evil", "a/b", ".hidden", "x."]) expect(() => writeTar([{ name, data: a }])).toThrow(TarError);
    // a damaged header or a cut-off tar is refused
    const bad = tar.slice(); bad[0] = 0x2e;
    await writeFile(join(dir, "bad.tar"), bad);
    await mkdir(join(dir, "y"));
    expect(extractTar(join(dir, "bad.tar"), join(dir, "y"))).rejects.toThrow(TarError);
    await writeFile(join(dir, "cut.tar"), tar.slice(0, 700));
    await mkdir(join(dir, "z"));
    expect(extractTar(join(dir, "cut.tar"), join(dir, "z"))).rejects.toThrow(TarError);
  });
});
