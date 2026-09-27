#!/usr/bin/env bun
/**
 * Builds the JIZURA font packs from the pinned sources.
 *
 *   bun scripts/fonts/jizura-packs.ts            fetch, convert, pack, write the manifest
 *   bun scripts/fonts/jizura-packs.ts --pin      also fill in an empty sha256 in jizura-sources.json from the download
 *   bun scripts/fonts/jizura-packs.ts --verify   also check the WOFF2 files against their sources (outlines, pixels, overlaps)
 *
 * Sources (scripts/fonts/jizura-sources.json) are downloaded once into
 * .work/jizura-font-cache and checked against their SHA-256. Each becomes a
 * WOFF2 (scripts/fonts/jizura-fonts.py, fontTools; outlines untouched, CFF
 * stays CFF) in .work/jizura-font-packs/woff2, and the families listed under
 * layout.bundled.latin also a Latin cut (everything but CJK_RANGES). Then:
 *
 *   - each pack in layout.packs → .work/jizura-font-packs/<id>-<sha8>.tar
 *     (a plain tar of its WOFF2 files and licences; this is what gets hosted)
 *   - the bundled base → core/src/render/fonts/jizura/ (committed)
 *   - core/src/fonts/jizura-packs.json: sizes and SHA-256 of all of it (baseUrl is kept)
 *
 * The same sources give byte-identical WOFF2, tars and manifest.
 * `--verify` needs @napi-rs/canvas (not a repo dependency): it is loaded from
 * .work/jizura-font-verify/node_modules (`cd .work/jizura-font-verify && bun add
 * @napi-rs/canvas`) or JIZURA_CANVAS_DIR; the overlap count needs skia-pathops in
 * the Python named by PYTHON (default python3).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { CJK_RANGES, JIZURA_FACES, parseManifest, type JizuraLang, type ManifestFile, type ManifestFont, type ManifestPack, type Titles } from "../../core/src/fonts/jizura-packs.ts";
import { fontFaces } from "../../core/src/fonts/font-names.ts";
import { writeTar } from "../../core/src/fonts/tar.ts";

const REPO = resolve(import.meta.dir, "../..");
const SOURCES = join(REPO, "scripts/fonts/jizura-sources.json");
const HELPER = join(REPO, "scripts/fonts/jizura-fonts.py");
const CACHE = join(REPO, ".work/jizura-font-cache");
const OUT = join(REPO, ".work/jizura-font-packs");
const WOFF = join(OUT, "woff2");
const BUNDLED = join(REPO, "core/src/render/fonts/jizura");
const MANIFEST = join(REPO, "core/src/fonts/jizura-packs.json");
const PYTHON = process.env.PYTHON ?? "python3";

const args = new Set(process.argv.slice(2));
const PIN = args.has("--pin"), VERIFY = args.has("--verify");

interface Source {
  family: string; weight: number; style: "normal" | "italic";
  url: string; repo: string; tag?: string; commit: string; sha256: string;
  license: string; licenseSha256?: string; licenseFile: string;
}
interface Sources {
  $comment: string[];
  fonts: Source[];
  layout: {
    bundled: { title: Titles; full: string[]; latin: string[] };
    packs: { id: string; langs: JizuraLang[]; title: Titles; families: string[] }[];
  };
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const mb = (n: number) => (n / 1e6).toFixed(2);
const fail = (m: string): never => { console.error(`jizura-packs: ${m}`); process.exit(1); };

const doc = JSON.parse(await readFile(SOURCES, "utf8")) as Sources;

// ── validate the layout against what JIZURA asks for ────────────────────────
{
  const byFamily = new Map<string, Source[]>();
  for (const s of doc.fonts) byFamily.set(s.family, [...(byFamily.get(s.family) ?? []), s]);
  const placed = new Map<string, string>();
  const place = (family: string, where: string) => {
    if (!byFamily.has(family)) fail(`${where} lists ${family}, which has no source`);
    if (placed.has(family)) fail(`${family} is in both ${placed.get(family)} and ${where}`);
    placed.set(family, where);
  };
  for (const f of doc.layout.bundled.full) place(f, "bundled");
  for (const p of doc.layout.packs) for (const f of p.families) place(f, p.id);
  for (const f of doc.layout.bundled.latin) if (!doc.layout.packs.some((p) => p.families.includes(f))) fail(`the Latin cut of ${f} needs its full face in a pack`);
  for (const face of JIZURA_FACES) {
    if (!placed.has(face.family)) fail(`${face.family} (asked for by JIZURA) is in no pack`);
    const weights = byFamily.get(face.family)!.map((s) => s.weight);
    for (const w of face.weights) if (!weights.includes(w) && !(w === 800 && weights.includes(900))) fail(`${face.family} ${w} has no source (only 800 may snap to 900)`);
  }
  for (const f of byFamily.keys()) if (!JIZURA_FACES.some((x) => x.family === f)) fail(`${f} is not a face JIZURA asks for`);
}

// ── fetch ───────────────────────────────────────────────────────────────────
await mkdir(CACHE, { recursive: true });
let pinned = false;
const fetches = new Map<string, Promise<{ path: string; sha: string }>>();
let running = 0;
const queue: (() => void)[] = [];
/** One download per URL, six at a time. */
function fetchPinned(url: string, want: string | undefined, what: string): Promise<{ path: string; sha: string }> {
  let job = fetches.get(url);
  if (!job) {
    job = (async () => {
      if (running >= 6) await new Promise<void>((r) => queue.push(r));
      running++;
      try { return await fetchOne(url, want, what); } finally { running--; queue.shift()?.(); }
    })();
    fetches.set(url, job);
  }
  return job;
}
async function fetchOne(url: string, want: string | undefined, what: string): Promise<{ path: string; sha: string }> {
  const u = new URL(url);
  if (u.protocol !== "https:") fail(`${what}: not an HTTPS URL`);
  const path = join(CACHE, `${sha256(url).slice(0, 12)}-${basename(u.pathname)}`);
  if (existsSync(path)) {
    const have = sha256(new Uint8Array(await Bun.file(path).arrayBuffer()));
    if (want ? have === want : PIN) return { path, sha: have };
    await rm(path);
  }
  if (!want && !PIN) fail(`${what}: no sha256 (run with --pin to take it from the download)`);
  let data: Uint8Array | null = null;
  for (let i = 0; i < 3 && !data; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = new Uint8Array(await res.arrayBuffer());
    } catch (e) { if (i === 2) fail(`${what}: ${url}: ${(e as Error).message}`); }
  }
  const have = sha256(data!);
  if (want && have !== want) fail(`${what}: SHA-256 mismatch (${have}, pinned ${want})`);
  await writeFile(`${path}.partial`, data!);
  await rename(`${path}.partial`, path);
  console.log(`fetched ${what} (${mb(data!.length)} MB)`);
  return { path, sha: have };
}

const srcPath = new Map<Source, string>();
const licensePath = new Map<string, string>();       // licence file name → cached text
await Promise.all(doc.fonts.map(async (s) => {
  const f = await fetchPinned(s.url, s.sha256 || undefined, `${s.family} ${s.weight}`);
  if (!s.sha256) { s.sha256 = f.sha; pinned = true; }
  srcPath.set(s, f.path);
  const l = await fetchPinned(s.license, s.licenseSha256 || undefined, `${s.family} licence`);
  if (!s.licenseSha256) { s.licenseSha256 = l.sha; pinned = true; }
  const prev = licensePath.get(s.licenseFile);
  if (prev && prev !== l.path && sha256(await readFile(prev)) !== l.sha) fail(`${s.licenseFile} names two different licences`);
  licensePath.set(s.licenseFile, l.path);
}));
if (pinned) {
  const line = (x: unknown) => JSON.stringify(x);
  const text = `{\n "$comment": ${JSON.stringify(doc.$comment, null, 2).replace(/\n/g, "\n ")},\n "fonts": [\n${doc.fonts.map((f) => `  ${line(f)}`).join(",\n")}\n ],\n "layout": ${JSON.stringify(doc.layout, null, 2).replace(/\n/g, "\n ")}\n}\n`;
  await writeFile(SOURCES, text);
  console.log("pinned new SHA-256 values in scripts/fonts/jizura-sources.json");
}

// the families' own names: what a font says it is must be what JIZURA asks for (or a known alias)
for (const s of doc.fonts) {
  const face = fontFaces(new Uint8Array(await Bun.file(srcPath.get(s)!).arrayBuffer()))[0]!;
  if (face.weight !== s.weight) console.warn(`note: ${s.family} ${s.weight}: the file says weight ${face.weight}`);
  if (!face.names.includes(s.family)) console.warn(`note: ${s.family}: the file calls itself ${face.names.join(" / ")} (registered under ${s.family})`);
}
// Reserved Font Names: a cut is a Modified Version and may not carry one
for (const s of doc.fonts) {
  if (!doc.layout.bundled.latin.includes(s.family)) continue;
  const text = (await readFile(licensePath.get(s.licenseFile)!, "utf8")).replace(/\s+/g, " ");
  // `with Reserved Font Name "Plex"` or `with Reserved Font Name Nanum, Naver Nanum, …`
  const rfn = [...text.matchAll(/with Reserved Font Names? (?:["“]([^"”]+)["”]|([^."“]+?)\.)/g)].flatMap((m) => (m[1] ?? m[2]!).split(/,\s*|\s+and\s+/)).map((n) => n.replace(/^["“]|["”]$/g, "").trim()).filter(Boolean);
  if (rfn.some((n) => s.family.toLowerCase().includes(n.toLowerCase()))) fail(`${s.family} has the Reserved Font Name ${rfn.join(", ")}: its cut would need a new name`);
}

// ── convert ─────────────────────────────────────────────────────────────────
await mkdir(WOFF, { recursive: true });
const helperSha = sha256(await readFile(HELPER));
const stem = (s: Source) => basename(new URL(s.url).pathname).replace(/\.(ttf|otf)$/i, "");   // the upstream file's name
interface Out { source: Source; cut: "latin" | null; file: string }
const outs: Out[] = [];
for (const s of doc.fonts) {
  outs.push({ source: s, cut: null, file: `${stem(s)}.woff2` });
  if (doc.layout.bundled.latin.includes(s.family)) outs.push({ source: s, cut: "latin", file: `${stem(s)}-Latin.woff2` });
}
{
  const names = new Set<string>();
  for (const o of outs) { if (names.has(o.file)) fail(`two outputs named ${o.file}`); names.add(o.file); }
}
const stampOf = (o: Out) => JSON.stringify({ src: o.source.sha256, helper: helperSha, cut: o.cut, lacks: o.cut ? CJK_RANGES : null });
const todo: Out[] = [];
for (const o of outs) {
  const stamp = join(WOFF, `${o.file}.stamp`);
  if (existsSync(join(WOFF, o.file)) && existsSync(stamp) && (await readFile(stamp, "utf8")) === stampOf(o)) continue;
  todo.push(o);
}
if (todo.length) {
  console.log(`converting ${todo.length} font${todo.length === 1 ? "" : "s"} to WOFF2…`);
  const jobs = todo.map((o) => ({ src: srcPath.get(o.source)!, out: join(WOFF, o.file), cut: o.cut, lacks: o.cut ? CJK_RANGES : null }));
  const p = Bun.spawn([PYTHON, HELPER, "woff2"], { stdin: new TextEncoder().encode(JSON.stringify(jobs)), stdout: "pipe", stderr: "inherit" });
  const text = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) fail("WOFF2 conversion failed");
  if (text.trim().split("\n").length !== todo.length) fail("WOFF2 conversion did not report every file");
  for (const o of todo) await writeFile(join(WOFF, `${o.file}.stamp`), stampOf(o));
}

// ── assemble ────────────────────────────────────────────────────────────────
async function entry(o: Out): Promise<ManifestFont> {
  const data = new Uint8Array(await Bun.file(join(WOFF, o.file)).arrayBuffer());
  return { family: o.source.family, weight: o.source.weight, style: o.source.style, file: o.file, bytes: data.length, sha256: sha256(data), ...(o.cut ? { lacks: CJK_RANGES } : {}) };
}
async function licenseEntry(name: string): Promise<ManifestFile & { data: Uint8Array }> {
  const data = new Uint8Array(await Bun.file(licensePath.get(name)!).arrayBuffer());
  return { file: name, bytes: data.length, sha256: sha256(data), data };
}
const licensesOf = (sources: Source[]) => [...new Set(sources.map((s) => s.licenseFile))].sort();

const packs: ManifestPack[] = [];
const keepTars = new Set<string>();
for (const p of doc.layout.packs) {
  const sources = doc.fonts.filter((s) => p.families.includes(s.family));
  const fonts = await Promise.all(outs.filter((o) => !o.cut && sources.includes(o.source)).map(entry));
  const licenses = await Promise.all(licensesOf(sources).map(licenseEntry));
  const tar = writeTar([
    ...(await Promise.all(fonts.map(async (f) => ({ name: f.file, data: new Uint8Array(await Bun.file(join(WOFF, f.file)).arrayBuffer()) })))),
    ...licenses.map((l) => ({ name: l.file, data: l.data })),
  ]);
  const sha = sha256(tar);
  const file = `${p.id}-${sha.slice(0, 8)}.tar`;
  keepTars.add(file);
  if (!existsSync(join(OUT, file))) { await writeFile(join(OUT, `${file}.partial`), tar); await rename(join(OUT, `${file}.partial`), join(OUT, file)); }
  packs.push({ id: p.id, title: p.title, langs: p.langs, file, bytes: tar.length, sha256: sha, families: fonts, licenses: licenses.map(({ data: _, ...l }) => l) });
}
for (const n of await readdir(OUT)) if (n.endsWith(".tar") && !keepTars.has(n)) await rm(join(OUT, n));

// bundled base: full faces + Latin cuts, and their licences
const baseSources = doc.fonts.filter((s) => doc.layout.bundled.full.includes(s.family) || doc.layout.bundled.latin.includes(s.family));
const baseOuts = outs.filter((o) => (o.cut === "latin") || (!o.cut && doc.layout.bundled.full.includes(o.source.family)));
const baseFonts = await Promise.all(baseOuts.map(entry));
const baseLicenses = await Promise.all(licensesOf(baseSources).map(licenseEntry));
await mkdir(BUNDLED, { recursive: true });
const keep = new Set(["README.md", ...baseFonts.map((f) => f.file), ...baseLicenses.map((l) => l.file)]);
for (const n of await readdir(BUNDLED)) if (!keep.has(n)) await rm(join(BUNDLED, n), { recursive: true });
for (const f of baseFonts) {
  const to = join(BUNDLED, f.file);
  if (existsSync(to) && (await stat(to)).size === f.bytes && sha256(await readFile(to)) === f.sha256) continue;
  await copyFile(join(WOFF, f.file), `${to}.partial`);
  await rename(`${to}.partial`, to);
}
for (const l of baseLicenses) await writeFile(join(BUNDLED, l.file), l.data);

// manifest (the host stays whatever it was)
let baseUrl = "https://font-packs.peesuto.invalid/jizura/v1/";
try { baseUrl = (JSON.parse(await readFile(MANIFEST, "utf8")) as { baseUrl: string }).baseUrl; } catch { /* first build */ }
const manifest = {
  formatVersion: 1 as const,
  baseUrl,
  bundled: { title: doc.layout.bundled.title, families: baseFonts, licenses: baseLicenses.map(({ data: _, ...l }) => l) },
  packs,
};
parseManifest(manifest);
const fontLine = (f: ManifestFont) => `      ${JSON.stringify(f)}`;
const fileLine = (f: ManifestFile) => `      ${JSON.stringify(f)}`;
const block = (fs: readonly ManifestFont[], ls: readonly ManifestFile[]) => `"families": [\n${fs.map(fontLine).join(",\n")}\n    ],\n    "licenses": [\n${ls.map(fileLine).join(",\n")}\n    ]`;
const json = `{
  "formatVersion": 1,
  "baseUrl": ${JSON.stringify(baseUrl)},
  "bundled": {
    "title": ${JSON.stringify(manifest.bundled.title)},
    ${block(manifest.bundled.families, manifest.bundled.licenses)}
  },
  "packs": [
${packs.map((p) => `    {
    "id": ${JSON.stringify(p.id)}, "title": ${JSON.stringify(p.title)}, "langs": ${JSON.stringify(p.langs)},
    "file": ${JSON.stringify(p.file)}, "bytes": ${p.bytes}, "sha256": ${JSON.stringify(p.sha256)},
    ${block(p.families, p.licenses)}
    }`).join(",\n")}
  ]
}
`;
parseManifest(JSON.parse(json));
await writeFile(MANIFEST, json);

// ── report ──────────────────────────────────────────────────────────────────
const lines: string[] = [];
const baseBytes = [...baseFonts, ...baseLicenses].reduce((s, f) => s + f.bytes, 0);
lines.push("| pack | families | files | bytes | MB | how |", "|---|---|---|---|---|---|");
lines.push(`| base | ${[...new Set(baseFonts.map((f) => f.family + (f.lacks ? " (Latin)" : "")))].join(", ")} | ${baseFonts.length} | ${baseBytes} | ${mb(baseBytes)} | bundled |`);
for (const p of packs) lines.push(`| ${p.id} | ${[...new Set(p.families.map((f) => `${f.family}`))].join(", ")} | ${p.families.length} | ${p.bytes} | ${mb(p.bytes)} | download ${p.file} |`);
lines.push("", `sources: ${doc.fonts.length} files, ${mb((await Promise.all([...srcPath.values()].map((p) => stat(p)))).reduce((s, x) => s + x.size, 0))} MB`);
console.log(lines.join("\n"));
await writeFile(join(OUT, "report.md"), lines.join("\n") + "\n");

if (VERIFY) await verify();

// ── verify ──────────────────────────────────────────────────────────────────
async function verify(): Promise<void> {
  const report: string[] = [];
  // 1. every WOFF2 draws exactly its source's outlines (a cut: for every character it keeps)
  const pairs = outs.map((o) => ({ a: srcPath.get(o.source)!, b: join(WOFF, o.file), cut: !!o.cut }));
  const p = Bun.spawn([PYTHON, HELPER, "outlines"], { stdin: new TextEncoder().encode(JSON.stringify(pairs)), stdout: "pipe", stderr: "inherit" });
  const res = (await new Response(p.stdout).text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { b: string; glyphs: number; differentCount: number; different: string[] });
  if ((await p.exited) !== 0) fail("outline check failed to run");
  let glyphs = 0, bad = 0;
  for (const r of res) { glyphs += r.glyphs; if (r.differentCount) { bad++; report.push(`outlines differ: ${basename(r.b)} (${r.differentCount}: ${r.different.join(" ")})`); } }
  report.push(`outlines: ${res.length} WOFF2 files, ${glyphs} glyphs compared with their sources, ${bad} files differ`);

  // 2. overlaps (needs skia-pathops): which sources have overlapping contours at all
  const probe = Bun.spawnSync([PYTHON, "-c", "import pathops"]);
  if (probe.exitCode === 0) {
    const q = Bun.spawn([PYTHON, HELPER, "overlaps"], { stdin: new TextEncoder().encode(JSON.stringify(doc.fonts.map((s) => srcPath.get(s)!))), stdout: "pipe", stderr: "inherit" });
    const rows = (await new Response(q.stdout).text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { path: string; glyphs: number; overlapping: number; examples: string[] });
    await q.exited;
    for (const r of rows) {
      const s = doc.fonts.find((x) => srcPath.get(x) === r.path)!;
      report.push(`overlaps: ${s.family} ${s.weight}: ${r.overlapping} of ${r.glyphs} glyphs${r.overlapping ? ` (${r.examples.join(" ")})` : ""}`);
    }
  } else report.push("overlaps: skipped (no skia-pathops in PYTHON)");

  // 3. pixels: @napi-rs/canvas draws the WOFF2 exactly like the source, filled and stroked
  const dir = process.env.JIZURA_CANVAS_DIR ?? join(REPO, ".work/jizura-font-verify");
  interface Ctx { font: string; textBaseline: string; lineWidth: number; lineJoin: string; strokeStyle: string; fillStyle: string; strokeText(t: string, x: number, y: number): void; fillText(t: string, x: number, y: number): void; getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } }
  interface Canvas { createCanvas(w: number, h: number): { getContext(k: "2d"): Ctx }; GlobalFonts: { registerFromPath(path: string, alias?: string): boolean } }
  let canvas: Canvas | null = null;
  try { canvas = createRequire(join(dir, "package.json"))("@napi-rs/canvas"); } catch { report.push(`pixels: skipped (no @napi-rs/canvas under ${dir})`); }
  if (canvas) {
    const { createCanvas, GlobalFonts } = canvas;
    const SAMPLE: Record<string, string> = { ja: "永あア漢字 Ag", "zh-Hans": "永远爱的 Ag", "zh-Hant": "永遠愛的 Ag", ko: "사랑해 永 Ag" };
    const LATIN = "Lyric Ag&? é—★";
    const draw = (family: string, weight: number, text: string, stroke: boolean) => {
      const c = createCanvas(900, 200), x = c.getContext("2d");
      x.font = `${weight} 120px "${family}"`;
      x.textBaseline = "middle";
      if (stroke) { x.lineWidth = 4; x.lineJoin = "round"; x.strokeStyle = "#fff"; x.strokeText(text, 20, 100); }
      else { x.fillStyle = "#fff"; x.fillText(text, 20, 100); }
      return x.getImageData(0, 0, 900, 200).data;
    };
    let n = 0, differing = 0;
    for (const [i, o] of outs.entries()) {
      const s = o.source;
      const lang = JIZURA_FACES.find((f) => f.family === s.family)!.langs[0]!;
      const text = o.cut ? LATIN : SAMPLE[lang]!;
      const a = `verify-src-${i}`, b = `verify-woff2-${i}`;
      if (!GlobalFonts.registerFromPath(srcPath.get(s)!, a) || !GlobalFonts.registerFromPath(join(WOFF, o.file), b)) { report.push(`pixels: cannot register ${o.file}`); differing++; continue; }
      for (const stroke of [false, true]) {
        const pa = draw(a, s.weight, text, stroke), pb = draw(b, s.weight, text, stroke);
        let diff = 0, ink = 0;
        for (let k = 3; k < pa.length; k += 4) { if (pa[k] !== pb[k]) diff++; if (pa[k]) ink++; }
        n++;
        if (diff || !ink) { differing++; report.push(`pixels: ${o.file} ${stroke ? "stroked" : "filled"}: ${diff} of ${ink} inked pixels differ${ink ? "" : " (nothing drawn)"}`); }
      }
    }
    report.push(`pixels: ${n} renders (filled and stroked, source vs WOFF2), ${differing} differ`);
  }
  console.log(report.join("\n"));
  await writeFile(join(OUT, "verify.md"), report.join("\n") + "\n");
}
