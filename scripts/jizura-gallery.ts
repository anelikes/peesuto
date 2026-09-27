/**
 * The JIZURA render line, for looking at: the same two texts (Chinese and
 * Japanese) as Lyric motion GIFs drawn by JIZURA in おまかせ and seven of its
 * styles, next to the classic (Pocket Motion) renders of the same texts, and
 * the grain presampled (core/src/jizura/grain.ts, opt-in) against JIZURA's own
 * pattern fill: crops of one frame each way, their difference amplified, the
 * numbers, and the MP4 each way. Every render's time and size is listed.
 *
 *   bun run jizura-gallery [-- options]
 *   bun scripts/jizura-gallery.ts [--out .work/jizura-gallery] [--fonts <dir>] [--engine <prepared engine>]
 *                                 [--styles auto,noir,…] [--no-classic] [--no-video]
 *
 * JIZURA's faces: --fonts, else PEESUTO_JIZURA_FONTS_DIR, else
 * .work/jizura-fonts-src when it exists (see docs/development.md). The
 * classic renders need a prepared engine (default .work/native-engine); it is
 * cloned (cp -Rc) into <out>/engine first, because builds write into it.
 * Open <out>/index.html in a browser.
 */
import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { prepareJizura, renderJizura, SLOW_PARTS, type JizuraJob } from "../core/src/jizura/index.ts";
import { JizuraDrawer } from "../core/src/jizura/render.ts";
import { lyricStyles } from "../core/src/jizura/catalog.ts";
import { resolveVideoEncoder, videoAvailable } from "../core/src/render/video.ts";
import { renderTemplate } from "../core/src/templates/render.ts";
import { parseTemplates } from "../core/src/templates/parse.ts";
import type { TemplateContent, TemplatePlan } from "../core/src/templates/types.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const REPO = resolve(import.meta.dir, "..");
const out = resolve(flag("out", join(REPO, ".work/jizura-gallery"))!);
const fonts = flag("fonts") ?? process.env.PEESUTO_JIZURA_FONTS_DIR ?? (existsSync(join(REPO, ".work/jizura-fonts-src")) ? join(REPO, ".work/jizura-fonts-src") : undefined);
if (fonts) process.env.PEESUTO_JIZURA_FONTS_DIR = resolve(fonts);
const STYLES = flag("styles")?.split(",") ?? ["auto", "noir", "paper", "magenta", "sakura", "synth80", "candy", "sumi"];
const classic = !argv.includes("--no-classic");
const video = !argv.includes("--no-video") && videoAvailable();

// Sample texts written for Peesuto (not real songs), in JIZURA's markup.
const TEXTS = {
  zh: "晚风吹亮*月光*\n我们慢慢走回家\n路灯一盏盏醒来\n把影子拉得很长\n\n你说明天还会下雨\n我说那就一起淋湿吧\n旧站台的白铃兰\n还在等夏天回来!",
  ja: "夜明けの色を/覚えてる\n*透明*な傘をたたんで\n坂道の途中で笑った!\nまだ眠い町の灯り\n\nほどけた声が鳴った\nねえ、まだ間に合うかな\n二人で数えた橋の数\nもう一度だけ/歩こう",
} as const;
type Lang = keyof typeof TEXTS;
const lyricsOf = (text: string) => parseTemplates(text).candidates.get("lyrics") as Extract<TemplateContent, { kind: "lyrics" }>;

interface Shot { file: string; label: string; note: string; ms: number; bytes: number; frames: number; size: string }
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const kb = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
const styleName = new Map(lyricStyles({ horror: true }).map((s) => [s.id, s.name]));

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "media"), { recursive: true });
const t0 = performance.now();

/* ───────────── JIZURA ───────────── */
async function jizura(lang: Lang, style: string, format: "gif" | "mp4", aspect: "1:1" | "16:9" = "1:1"): Promise<Shot | string> {
  const text = TEXTS[lang];
  const p = await prepareJizura({ content: lyricsOf(text), sourceText: text, aspect, format, style });
  if (!p.ok) return `${lang} ${style}: ${p.message}`;
  const file = `media/jizura-${lang}-${style}-${aspect.replace(":", "x")}.${format}`;
  const started = performance.now();
  const r = await renderJizura(p.job, { out: join(out, file), format, ...(format === "mp4" ? { encoder: resolveVideoEncoder() } : {}) });
  const ms = Math.round(performance.now() - started);
  const name = styleName.get(p.meta.style);
  const label = style === "auto" ? `おまかせ → ${name?.ja ?? p.meta.style}${p.meta.mood ? ` · ${p.meta.mood}` : ""}` : `${name?.ja ?? style} / ${name?.en ?? ""}`;
  console.log(`jizura ${lang} ${style} ${format} ${aspect}: ${ms} ms, ${r.frames} frames on ${r.draw.threads} threads`);
  return { file, label, note: `${p.meta.style} · ${p.meta.cuts} cuts · ${r.draw.threads} threads`, ms, bytes: (await stat(join(out, file))).size, frames: r.frames, size: `${r.width}×${r.height}` };
}

const grid: Record<Lang, (Shot | string)[]> = { zh: [], ja: [] };
for (const lang of Object.keys(TEXTS) as Lang[]) for (const style of STYLES) grid[lang].push(await jizura(lang, style, "gif"));
const videos: (Shot | string)[] = [];
if (video) for (const lang of Object.keys(TEXTS) as Lang[]) for (const aspect of ["1:1", "16:9"] as const) videos.push(await jizura(lang, "auto", "mp4", aspect));

/* ───────────── Classic, for comparison ───────────── */
const classicShots: Record<Lang, (Shot | string)[]> = { zh: [], ja: [] };
if (classic) {
  const source = resolve(flag("engine", join(REPO, ".work/native-engine"))!);
  const engine = join(out, "engine");
  if (!existsSync(join(source, "package.json"))) console.warn(`jizura-gallery: no prepared engine at ${source}; classic renders skipped`);
  else {
    const cp = Bun.spawn(["cp", "-Rc", source, engine]);
    if (await cp.exited !== 0) throw new Error("jizura-gallery: could not clone the engine");
    for (const lang of Object.keys(TEXTS) as Lang[]) for (const variant of ["classic", "editorial"] as const) {
      const text = TEXTS[lang];
      const plan: TemplatePlan = { version: 1, template: "lyrics", variant, motion: "reveal", sourceText: text, content: lyricsOf(text), aspect: "1:1" };
      const file = `media/classic-${lang}-${variant}.gif`;
      try {
        const started = performance.now();
        const r = await renderTemplate(plan, { engine, work: join(out, "work"), emojiCache: join(out, "emoji"), format: "gif", out: join(out, file) });
        const ms = Math.round(performance.now() - started);
        classicShots[lang].push({ file, label: variant === "classic" ? "Stage ステージ (classic)" : "Paper ペーパー (classic)", note: "Pocket Motion", ms, bytes: (await stat(join(out, file))).size, frames: r.frames, size: `${r.width}×${r.height}` });
        console.log(`classic ${lang} ${variant}: ${ms} ms`);
      } catch (e) { classicShots[lang].push(`${lang} ${variant}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    await rm(engine, { recursive: true, force: true });
    await rm(join(out, "work"), { recursive: true, force: true });
  }
}

/* ───────────── Grain presampled (opt-in) vs JIZURA's pattern fill (default) ───────────── */
interface GrainCase { style: string; lang: Lang; crops: string; mean: number; max: number; changed: number; msPattern: number; msSheets: number; mp4?: { pattern: number; sheets: number } }
const grain: GrainCase[] = [];
{
  for (const [lang, style] of [["zh", "noir"], ["ja", "mint"], ["zh", "paper"]] as const) {
    const text = TEXTS[lang];
    const p = await prepareJizura({ content: lyricsOf(text), sourceText: text, aspect: "1:1", format: "mp4", style });
    if (!p.ok) { console.warn(`grain ${style}: ${p.message}`); continue; }
    // Two seconds from the middle of the film, drawn both ways in one thread.
    const mid = Math.floor(p.job.durationFrames / 2);
    const frames = Array.from({ length: 60 }, (_, i) => mid + i);
    const job = (grainShim: boolean): JizuraJob => ({ ...p.job, grainShim, durationFrames: mid + 60, chunks: [{ frames, replay: Array.from({ length: 30 }, (_, i) => mid - 30 + i) }] });
    const draw = async (shim: boolean) => {
      const d = await JizuraDrawer.open(job(shim));
      const pics: Uint8Array[] = [];
      const started = performance.now();
      for (const f of frames) pics.push(await d.draw(f));
      return { pics, ms: (performance.now() - started) / frames.length };
    };
    const a = await draw(false), b = await draw(true);
    let sum = 0, max = 0, changed = 0, n = 0;
    for (let i = 0; i < a.pics.length; i++) for (let k = 0; k < a.pics[i]!.length; k += 4) for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.pics[i]![k + c]! - b.pics[i]![k + c]!); sum += d; n++; if (d) changed++; if (d > max) max = d;
    }
    // Crops of one frame: pattern | presampled | difference ×40, at 2×, written as a PNG here (no canvas).
    const rgb = cropSheet(a.pics[30]!, b.pics[30]!, p.job.width, p.job.height, 300);
    const crops = `media/grain-${style}.png`;
    await Bun.write(join(out, crops), png(rgb.data, rgb.width, rgb.height));
    const c: GrainCase = { style, lang, crops, mean: +(sum / n).toFixed(3), max, changed: +(changed / n).toFixed(3), msPattern: Math.round(a.ms), msSheets: Math.round(b.ms) };
    if (video) {
      const sizes: number[] = [];
      for (const shim of [false, true]) {
        const file = join(out, `media/grain-${style}-${shim ? "presampled" : "pattern"}.mp4`);
        await renderJizura({ ...p.job, grainShim: shim }, { out: file, format: "mp4", encoder: resolveVideoEncoder() });
        sizes.push(existsSync(file) ? (await stat(file)).size : 0);
      }
      c.mp4 = { pattern: sizes[0]!, sheets: sizes[1]! };
    }
    grain.push(c);
    console.log(`grain ${style}: mean ${c.mean}, max ${c.max}; ${c.msPattern} → ${c.msSheets} ms a frame`);
  }
}

/**
 * Three centre crops side by side at 2×: `a`, `b` and their difference ×40.
 * A plain function on purpose: the same loops written as a closure inside
 * this module's top-level-await body stopped early under Bun 1.3.11's
 * optimising JIT (JavaScriptCore), leaving most of the sheet unwritten.
 */
function cropSheet(a: Uint8Array, b: Uint8Array, W: number, H: number, crop: number): { data: Uint8Array; width: number; height: number } {
  const x0 = Math.round(W / 2 - crop / 2), y0 = Math.round(H / 2 - crop / 2), gap = 8, SW = crop * 6 + gap * 2, SH = crop * 2;
  const diff = new Uint8Array(a.length);
  for (let i = 0; i < diff.length; i++) diff[i] = Math.min(255, Math.abs(a[i]! - b[i]!) * 40);
  const rgb = new Uint8Array(SW * SH * 3).fill(255);
  const panels = [a, b, diff];
  for (let j = 0; j < 3; j++) {
    const px = panels[j]!;
    for (let y = 0; y < SH; y++) for (let x = 0; x < crop * 2; x++) {
      const s = ((y0 + (y >> 1)) * W + x0 + (x >> 1)) * 4, t = (y * SW + j * (crop * 2 + gap) + x) * 3;
      rgb[t] = px[s]!; rgb[t + 1] = px[s + 1]!; rgb[t + 2] = px[s + 2]!;
    }
  }
  return { data: rgb, width: SW, height: SH };
}

/** RGB → PNG (8-bit, no filter), for the crops. */
function png(rgb: Uint8Array, w: number, h: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length), v = new DataView(out.buffer);
    v.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
    v.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  const ihdr = new Uint8Array(13), iv = new DataView(ihdr.buffer);
  iv.setUint32(0, w); iv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", new Uint8Array())];
  const zl = parts.reduce((n, p) => n + p.length, 0), outBuf = new Uint8Array(zl);
  let at = 0; for (const p of parts) { outBuf.set(p, at); at += p.length; }
  return outBuf;
}

/* ───────────── The page ───────────── */
const card = (s: Shot | string, kind: "img" | "video" = "img") => typeof s === "string"
  ? `<figure class="miss"><figcaption>${esc(s)}</figcaption></figure>`
  : `<figure>${kind === "img" ? `<img loading="lazy" src="${s.file}" alt="${esc(s.label)}">` : `<video src="${s.file}" controls loop muted playsinline></video>`}<figcaption><b>${esc(s.label)}</b><span>${esc(s.note)}</span><span>${s.size} · ${s.frames} frames · ${kb(s.bytes)} · ${(s.ms / 1000).toFixed(1)} s</span></figcaption></figure>`;
const excluded = Object.entries(SLOW_PARTS).map(([g, ks]) => `${g}: ${ks.join(", ")}`).join("; ") || "none";
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>JIZURA render line</title>
<style>
:root { --bg: #f4f2ee; --ink: #1d1b19; --sub: #6c665e; --line: #d9d4cc; --card: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #151413; --ink: #ece8e2; --sub: #9b948b; --line: #33302c; --card: #1e1c1a; } }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 -apple-system, "Helvetica Neue", "PingFang SC", "Hiragino Sans", sans-serif; }
main { max-width: 1400px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 36px 0 8px; border-top: 1px solid var(--line); padding-top: 16px; }
p { color: var(--sub); max-width: 70em; } code { font-size: 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
figure { margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
figure img, figure video { display: block; width: 100%; height: auto; background: #000; }
figcaption { padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; font-size: 12px; } figcaption span { color: var(--sub); }
figure.miss figcaption { color: #b3261e; }
.wide { grid-template-columns: 1fr; } .wide img { image-rendering: pixelated; }
table { border-collapse: collapse; font-size: 13px; } td, th { border-bottom: 1px solid var(--line); padding: 4px 10px; text-align: left; }
</style></head><body><main>
<h1>JIZURA render line</h1>
<p>Lyric motion drawn by <a href="https://github.com/852wa/JIZURA">JIZURA</a> (MIT, © 2026 hakoniwa), its own engine unmodified, headless in Bun over Skia. GIFs at 15 frames a second, the GIF's own width; the same two sample texts throughout. Rendered ${new Date().toISOString().slice(0, 16).replace("T", " ")} in ${Math.round((performance.now() - t0) / 1000)} s. Parts kept out of random picks: ${esc(excluded)}.</p>
${(Object.keys(TEXTS) as Lang[]).map((lang) => `<h2>${lang === "zh" ? "Chinese" : "Japanese"} · JIZURA</h2><p><code>${esc(TEXTS[lang].replace(/\n/g, " / "))}</code></p><div class="grid">${grid[lang].map((s) => card(s)).join("")}</div>`).join("\n")}
${classic ? `<h2>Classic (Pocket Motion) and JIZURA おまかせ, same texts</h2><div class="grid">${(Object.keys(TEXTS) as Lang[]).flatMap((lang) => [...classicShots[lang], grid[lang][0]!]).map((s) => card(s)).join("")}</div>` : ""}
${videos.length ? `<h2>MP4 (おまかせ), 1:1 and 16:9</h2><div class="grid">${videos.map((s) => card(s, "video")).join("")}</div>` : ""}
<h2>Grain: presampled (opt-in, PEESUTO_JIZURA_GRAIN=presampled) vs JIZURA's pattern fill (default)</h2>
<p>JIZURA fills its grain (and scanlines) as a repeating pattern every frame; Skia's pattern shader makes that most of a frame. The opt-in path samples one period of the layer with the same pattern fill and lays it over the frame by whole-pixel copies (core/src/jizura/grain.ts): the sampling is JIZURA's, the blend rounds in 8 bits. Each row: one frame, centre crop at 2× — pattern | presampled | difference ×40. Differences and times over 60 frames (two seconds from the middle of the film); MP4 sizes over the whole film, each way. The default is the pattern: presampled frames are faster, but the MP4s come out larger.</p>
<table><tr><th>style</th><th>mean |Δ| (0–255)</th><th>max |Δ|</th><th>pixels changed</th><th>ms/frame pattern → presampled</th><th>MP4 pattern → presampled</th></tr>
${grain.map((g) => `<tr><td>${g.style} (${g.lang})</td><td>${g.mean}</td><td>${g.max}</td><td>${(g.changed * 100).toFixed(1)}%</td><td>${g.msPattern} → ${g.msSheets}</td><td>${g.mp4 ? `${kb(g.mp4.pattern)} → ${kb(g.mp4.sheets)}` : "—"}</td></tr>`).join("\n")}
</table>
<div class="grid wide">${grain.map((g) => `<figure><img src="${g.crops}" alt="grain ${g.style}"><figcaption><b>${g.style}</b><span>pattern | presampled | difference ×40</span></figcaption></figure>`).join("")}</div>
</main></body></html>
`;
await writeFile(join(out, "index.html"), html);
console.log(`jizura-gallery: ${relative(REPO, join(out, "index.html"))} (${Math.round((performance.now() - t0) / 1000)} s)`);
