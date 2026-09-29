#!/usr/bin/env bun
/**
 * Renders the website's template gallery with the real template pipeline:
 * for every registered template and each language's sample
 * (scripts/site-templates.ts), every style at 1:1, the first style at 16:9,
 * and the first style animated. Outputs go to site/gallery/<lang>/ and are
 * committed, so `bun run site:build` never needs the engine:
 *
 *   <template>-<style>.webp      1:1, 640 px wide (retina-sharp at the site's 320 px)
 *   <template>-<style>-wide.webp 16:9, 960 px wide (first style only)
 *   <template>.mp4               the animated card, 640 px, H.264, no audio
 *
 * Lyric motion is a film drawn by JIZURA (templates/lyrics-route.ts
 * renderLyrics) in the styles LYRIC_FILMS names; its classic styles appear
 * only as their posters (the 1:1 webp above):
 *
 *   lyrics-jizura-<style>.mp4        the 1:1 film, 640 px, H.264 (CRF 30), no audio
 *   lyrics-jizura-<style>.webp       one frame of it (LYRIC_FILMS' `still`), 640 px
 *   lyrics-jizura-auto-wide.webp     one frame of the 16:9 Auto film (LYRIC_WIDE_STILL), 960 px
 *
 * site/gallery/manifest.json records each file's input key, size and bytes
 * (and, for a JIZURA film, the style and mood it was drawn in). A file is
 * rendered again only when its input (sample text, template, style, frame,
 * still) or the renderer (core/src/templates, the render fonts, engine.json;
 * for JIZURA also core/src/jizura, core/src/fonts, vendor/jizura, jizura.json)
 * changed, so a rebuild with nothing new takes a second.
 *
 *   bun scripts/site-gallery.ts [--engine .work/native-engine] [--fonts <dir>] [--only code,diff] [--lang en]
 *                               [--jobs 4] [--force] [--reuse] [--check]
 *
 *   --check   only verify that each sample is picked as its own template (no engine)
 *   --sheet   also write docs/images/templates.png (the README's sheet: every style, English, 10 columns)
 *   --reuse   keep existing files whose input is unchanged even if the renderer changed
 *   --force   render everything again
 *   --fonts   JIZURA's faces for Chinese and Japanese (else PEESUTO_JIZURA_FONTS_DIR, else
 *             .work/jizura-fonts-src); a film JIZURA cannot draw fails, it never falls back to classic
 *
 * The engine checkout is copied to a scratch directory first (its builds write
 * caches); a run with only JIZURA films to draw needs no engine. Films are
 * drawn one at a time (each uses every core). Needs cwebp and ffmpeg
 * (brew install webp ffmpeg).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { cp, mkdir, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { decideTemplate } from "../core/src/templates/decide.ts";
import { parseTemplates } from "../core/src/templates/parse.ts";
import { MANUAL_TEMPLATES, TEMPLATE_REGISTRY } from "../core/src/templates/registry.ts";
import { renderLyrics } from "../core/src/templates/lyrics-route.ts";
import { renderTemplate } from "../core/src/templates/render.ts";
import type { TemplateId, VariantId } from "../core/src/templates/types.ts";
import { LYRIC_FILMS, LYRIC_WIDE_STILL, SAMPLES, type Lang } from "./site-templates.ts";

const REPO = resolve(import.meta.dir, "..");
const OUT = join(REPO, "site/gallery");
const MANIFEST = join(OUT, "manifest.json");
const LANGS: readonly Lang[] = ["en", "zh", "ja"];
const SQUARE_WIDTH = 640;
const WIDE_WIDTH = 960;

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const only = flag("only")?.split(",");
const onlyLang = flag("lang")?.split(",");
const jobs = Math.max(1, Number(flag("jobs") ?? 4));
const force = argv.includes("--force");
const reuse = argv.includes("--reuse");
const fonts = flag("fonts") ?? process.env.PEESUTO_JIZURA_FONTS_DIR ?? (existsSync(join(REPO, ".work/jizura-fonts-src")) ? join(REPO, ".work/jizura-fonts-src") : undefined);
if (fonts) process.env.PEESUTO_JIZURA_FONTS_DIR = resolve(fonts);

export interface GalleryFile {
  readonly input: string; readonly renderer: string; readonly width: number; readonly height: number; readonly bytes: number;
  /** A JIZURA film (or a frame of one): the style it was drawn in (Auto's pick, for "auto") and Auto's mood. */
  readonly lyric?: { readonly style: string; readonly mood: string | null };
}
export interface GalleryManifest { readonly files: Record<string, GalleryFile> }

// ---------------------------------------------------------------- check samples

const templates = TEMPLATE_REGISTRY.filter((t) => !only || only.includes(t.id));
const problems: string[] = [];
for (const t of templates) {
  const sample = SAMPLES[t.id];
  if (!sample) { console.warn(`warning: no sample for "${t.id}" in scripts/site-templates.ts; it is left out of the gallery`); continue; }
  for (const lang of LANGS) {
    const parsed = parseTemplates(sample[lang]);
    // Manual templates (QR, lyric motion) are never preferred; they only need to be available.
    const ok = MANUAL_TEMPLATES.includes(t.id) ? parsed.candidates.has(t.id) && parsed.preferred !== t.id : parsed.preferred === t.id;
    if (!ok) problems.push(`${t.id} (${lang}): the rules pick ${parsed.preferred} (candidates: ${[...parsed.candidates.keys()].join(", ")})`);
  }
}
if (problems.length) throw new Error(`samples not recognised as their own template:\n  ${problems.join("\n  ")}`);
console.log(`samples: ${templates.filter((t) => SAMPLES[t.id]).length} templates × ${LANGS.length} languages recognised`);
if (argv.includes("--check")) process.exit(0);

// ---------------------------------------------------------------- jobs

function rendererHash(): string {
  const h = createHash("sha256");
  const add = (path: string) => { h.update(relative(REPO, path)); h.update(readFileSync(path)); };
  const walk = (dir: string, keep: (f: string) => boolean) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, keep); else if (keep(e.name)) add(p);
    }
  };
  walk(join(REPO, "core/src/templates"), (f) => f.endsWith(".ts"));
  // Fonts are large: their names and sizes stand in for their bytes.
  for (const f of readdirSync(join(REPO, "core/src/render/fonts")).sort()) h.update(`${f}:${statSync(join(REPO, "core/src/render/fonts", f)).size}`);
  add(join(REPO, "engine.json"));
  return h.digest("hex").slice(0, 16);
}

/** JIZURA's films also depend on its engine, the adaptation, the font code and the base fonts. */
function jizuraHash(base: string): string {
  const h = createHash("sha256");
  h.update(base);
  const walk = (dir: string, keep: (f: string) => boolean) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, keep); else if (keep(e.name)) { h.update(relative(REPO, p)); h.update(readFileSync(p)); }
    }
  };
  walk(join(REPO, "core/src/jizura"), (f) => f.endsWith(".ts"));
  walk(join(REPO, "core/src/fonts"), () => true);
  walk(join(REPO, "vendor/jizura"), () => true);
  h.update(readFileSync(join(REPO, "jizura.json")));
  for (const f of readdirSync(join(REPO, "core/src/render/fonts/jizura")).sort()) h.update(`${f}:${statSync(join(REPO, "core/src/render/fonts/jizura", f)).size}`);
  return h.digest("hex").slice(0, 16);
}

type Kind = "square" | "wide" | "motion" | "film" | "film-wide";
interface Job {
  readonly file: string; readonly lang: Lang; readonly id: TemplateId; readonly variant: VariantId; readonly kind: Kind; readonly input: string;
  /** JIZURA's films: the style, and the second kept as the still. */
  readonly style?: string; readonly at?: number;
  /** A 1:1 film's still, written by the same job. */
  readonly still?: { readonly file: string; readonly input: string };
}

const renderer = rendererHash();
const jizuraRenderer = jizuraHash(renderer);
const isFilm = (j: Job) => j.kind === "film" || j.kind === "film-wide";
const rendererOf = (j: Job) => (isFilm(j) ? jizuraRenderer : renderer);
const manifest: GalleryManifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : { files: {} };
const wanted: Job[] = [];
for (const t of templates) {
  const sample = SAMPLES[t.id];
  if (!sample) continue;
  for (const lang of LANGS) {
    if (onlyLang && !onlyLang.includes(lang)) continue;
    const text = sample[lang];
    const key = (kind: string, variant: string, extra: object = {}) => createHash("sha256").update(JSON.stringify({ text, id: t.id, variant, kind, SQUARE_WIDTH, WIDE_WIDTH, ...extra })).digest("hex").slice(0, 16);
    const first = t.variants[0]!.id;
    // Every style at 1:1 (for Lyric motion: the classic styles' posters).
    for (const v of t.variants) wanted.push({ file: `${lang}/${t.id}-${v.id}.webp`, lang, id: t.id, variant: v.id, kind: "square", input: key("square", v.id) });
    if (t.id === "lyrics") {
      // Lyric motion: JIZURA's films, each with one frame as its still, and one frame of the 16:9 Auto film.
      for (const { style, still } of LYRIC_FILMS) {
        const at = still[lang];
        wanted.push({ file: `${lang}/lyrics-jizura-${style}.mp4`, lang, id: t.id, variant: first, kind: "film", style, at, input: key("film", first, { style }),
          still: { file: `${lang}/lyrics-jizura-${style}.webp`, input: key("film-still", first, { style, at }) } });
      }
      const at = LYRIC_WIDE_STILL[lang];
      wanted.push({ file: `${lang}/lyrics-jizura-auto-wide.webp`, lang, id: t.id, variant: first, kind: "film-wide", style: "auto", at, input: key("film-wide", first, { style: "auto", at }) });
      continue;
    }
    wanted.push({ file: `${lang}/${t.id}-${first}-wide.webp`, lang, id: t.id, variant: first, kind: "wide", input: key("wide", first) });
    wanted.push({ file: `${lang}/${t.id}.mp4`, lang, id: t.id, variant: first, kind: "motion", input: key("motion", first) });
  }
}
const freshFile = (file: string, input: string, r: string) => {
  const m = manifest.files[file];
  return !force && !!m && existsSync(join(OUT, file)) && m.input === input && (reuse || m.renderer === r);
};
const fresh = (j: Job) => freshFile(j.file, j.input, rendererOf(j)) && (!j.still || freshFile(j.still.file, j.still.input, rendererOf(j)));
const todo = wanted.filter((j) => !fresh(j));
console.log(`gallery: ${wanted.length} renders, ${wanted.length - todo.length} up to date, ${todo.length} to do (renderer ${renderer}, JIZURA ${jizuraRenderer})`);

// ---------------------------------------------------------------- render

async function run(cmd: string[]): Promise<void> {
  const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd[0]} failed (${code}): ${(await new Response(p.stderr).text()).slice(-600)}`);
}
async function probe(file: string): Promise<{ width: number; height: number }> {
  const p = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { stdout: "pipe" });
  const [w, h] = (await new Response(p.stdout).text()).trim().split(",").map(Number);
  await p.exited;
  return { width: w!, height: h! };
}

const scratch = join(tmpdir(), `peesuto-gallery-${process.pid}`);
const saveManifest = async () => {
  const files: Record<string, GalleryFile> = {};
  for (const k of Object.keys(manifest.files).sort()) files[k] = manifest.files[k]!;
  await Bun.write(MANIFEST, `${JSON.stringify({ files }, null, 1)}\n`);
};

/** A webp from a PNG, as every still here is made. */
const webp = (png: string, target: string, width: number) =>
  run(["cwebp", "-quiet", "-q", "90", "-m", "6", "-sharp_yuv", "-metadata", "none", "-resize", String(width), "0", png, "-o", target]);
/** An MP4 for the site: 640 px, H.264 at `crf`, no audio, moov first. */
const mp4 = (raw: string, target: string, crf: number) =>
  run(["ffmpeg", "-y", "-loglevel", "error", "-i", raw, "-vf", `scale=${SQUARE_WIDTH}:-2:flags=lanczos`, "-c:v", "libx264", "-preset", "slow",
    "-crf", String(crf), "-pix_fmt", "yuv420p", "-profile:v", "high", "-movflags", "+faststart", "-an", target]);
const record = async (file: string, input: string, r: string, lyric?: GalleryFile["lyric"]): Promise<string> => {
  const target = join(OUT, file);
  const { width, height } = await probe(target);
  const bytes = (await stat(target)).size;
  manifest.files[file] = { input, renderer: r, width, height, bytes, ...(lyric ? { lyric } : {}) };
  return `${file} ${width}×${height} ${(bytes / 1024).toFixed(1)} KB`;
};

if (todo.length) {
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  // The engine draws everything but JIZURA's films; a run with only films needs none.
  const engine = join(scratch, ".engine");
  if (todo.some((j) => !isFilm(j))) {
    const sourceEngine = resolve(flag("engine") ?? join(REPO, ".work/native-engine"));
    if (!existsSync(sourceEngine)) throw new Error(`engine checkout not found: ${sourceEngine} (pass --engine)`);
    await cp(sourceEngine, engine, { recursive: true });
  }
  let done = 0;
  const started = performance.now();
  const renderFilm = async (j: Job, worker: number) => {
    const text = SAMPLES[j.id]![j.lang];
    const decision = await decideTemplate(text, { aspect: j.kind === "film-wide" ? "16:9" : "1:1", output: "video", decider: null, override: { id: j.id, variant: j.variant } });
    const raw = join(scratch, `w${worker}-${j.lang}-${j.id}-${j.style}-${j.kind}.mp4`);
    const r = await renderLyrics(decision.plan, {
      engine, work: join(scratch, `.tree-${worker}`), emojiCache: join(scratch, ".emoji"), emojiBundle: join(REPO, ".work/emoji-all"), format: "mp4", out: raw,
    }, { engine: "jizura", style: j.style });
    // The site shows these as JIZURA's films: never a classic fallback.
    if (r.lyric.engine !== "jizura") throw new Error(`JIZURA did not draw ${j.file} (${r.lyric.reason}${r.lyric.message ? `: ${r.lyric.message}` : ""}); pass --fonts <a directory with its faces>`);
    const lyric = { style: r.lyric.style, mood: r.lyric.mood ?? null };
    await mkdir(join(OUT, j.lang), { recursive: true });
    const frame = `${raw}.png`;
    await run(["ffmpeg", "-y", "-loglevel", "error", "-ss", String(j.at), "-i", raw, "-frames:v", "1", frame]);
    const lines: string[] = [];
    if (j.kind === "film") {
      // The same CRF as the classic Lyric motion clips had: film grain and colour cuts cost bits.
      await mp4(raw, join(OUT, j.file), 30);
      await webp(frame, join(OUT, j.still!.file), SQUARE_WIDTH);
      lines.push(await record(j.file, j.input, jizuraRenderer, lyric), await record(j.still!.file, j.still!.input, jizuraRenderer, lyric));
    } else {
      await webp(frame, join(OUT, j.file), WIDE_WIDTH);
      lines.push(await record(j.file, j.input, jizuraRenderer, lyric));
    }
    await unlink(raw).catch(() => {});
    await unlink(frame).catch(() => {});
    done++;
    console.log(`[${done}/${todo.length}] ${lines.join(", ")} (JIZURA: ${lyric.style}${lyric.mood ? `, ${lyric.mood}` : ""})`);
    if (done % 10 === 0) await saveManifest();
  };
  // JIZURA draws a film on every core: one film at a time, whatever --jobs says.
  let filmTurn: Promise<unknown> = Promise.resolve();
  const renderOne = async (j: Job, worker: number) => {
    if (isFilm(j)) {
      const turn = filmTurn.then(() => renderFilm(j, worker));
      filmTurn = turn.catch(() => {});
      return turn;
    }
    const text = SAMPLES[j.id]![j.lang];
    const output = j.kind === "motion" ? "video" : "image";
    const decision = await decideTemplate(text, {
      aspect: j.kind === "wide" ? "16:9" : "1:1", output, decider: null, override: { id: j.id, variant: j.variant },
    });
    const format = j.kind === "motion" ? "mp4" : "png";
    const raw = join(scratch, `w${worker}-${j.lang}-${j.id}-${j.variant}-${j.kind}.${format}`);
    await renderTemplate(decision.plan, {
      engine, work: join(scratch, `.tree-${worker}`), emojiCache: join(scratch, ".emoji"), emojiBundle: join(REPO, ".work/emoji-all"),
      format, out: raw,
    });
    const target = join(OUT, j.file);
    await mkdir(join(OUT, j.lang), { recursive: true });
    if (j.kind === "motion") await mp4(raw, target, 26);
    else await webp(raw, target, j.kind === "wide" ? WIDE_WIDTH : SQUARE_WIDTH);
    await unlink(raw).catch(() => {});
    const line = await record(j.file, j.input, renderer);
    done++;
    console.log(`[${done}/${todo.length}] ${line}`);
    if (done % 10 === 0) await saveManifest();
  };
  const queue = [...todo];
  const failures: string[] = [];
  try {
    await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async (_, worker) => {
      for (let j = queue.shift(); j; j = queue.shift()) {
        try { await renderOne(j, worker); } catch (error) { failures.push(`${j.file}: ${(error as Error).message}`); console.error(`failed ${j.file}: ${(error as Error).message}`); }
      }
    }));
  } finally {
    await saveManifest();
    await rm(scratch, { recursive: true, force: true });
  }
  console.log(`rendered ${done} in ${((performance.now() - started) / 1000).toFixed(0)} s`);
  if (failures.length) throw new Error(`${failures.length} renders failed:\n  ${failures.join("\n  ")}`);
}

// Files no longer wanted (a removed template or style) leave the manifest and the disk,
// unless this run was narrowed with --only or --lang.
if (!only && !onlyLang) {
  const keep = new Set(wanted.flatMap((j) => (j.still ? [j.file, j.still.file] : [j.file])));
  for (const file of Object.keys(manifest.files)) if (!keep.has(file)) { delete manifest.files[file]; await rm(join(OUT, file), { force: true }); console.log(`removed ${file}`); }
  await saveManifest();
}
const total = Object.values(manifest.files).reduce((n, f) => n + f.bytes, 0);
console.log(`site/gallery: ${Object.keys(manifest.files).length} files, ${(total / 1024 / 1024).toFixed(2)} MB`);

// ---------------------------------------------------------------- README sheet

if (argv.includes("--sheet")) {
  const files = TEMPLATE_REGISTRY.flatMap((t) => t.variants.map((v) => `en/${t.id}-${v.id}.webp`)).filter((f) => manifest.files[f]);
  const cols = 10, gap = 13, cell = Math.floor((1600 - gap * (cols - 1)) / cols), rows = Math.ceil(files.length / cols);
  const inputs = files.flatMap((f) => ["-i", join(OUT, f)]);
  const scaled = files.map((_, i) => `[${i}:v]scale=${cell}:${cell}:force_original_aspect_ratio=increase:flags=lanczos,crop=${cell}:${cell}:0:0,format=rgba[c${i}]`).join(";");
  const layout = files.map((_, i) => `${(i % cols) * (cell + gap)}_${Math.floor(i / cols) * (cell + gap)}`).join("|");
  const width = cols * cell + (cols - 1) * gap, height = rows * cell + (rows - 1) * gap;
  const target = join(REPO, "docs/images/templates.png");
  await run(["ffmpeg", "-y", "-loglevel", "error", ...inputs, "-filter_complex",
    `${scaled};color=c=0x00000000:s=${width}x${height},format=rgba[bg];${files.map((_, i) => `[c${i}]`).join("")}xstack=inputs=${files.length}:layout=${layout}:fill=0x00000000[grid];[bg][grid]overlay=0:0:format=auto`,
    "-frames:v", "1", "-pix_fmt", "rgba", target]);
  console.log(`sheet → docs/images/templates.png (${files.length} styles, ${width}×${height}, ${((await stat(target)).size / 1024).toFixed(0)} KB)`);
}
