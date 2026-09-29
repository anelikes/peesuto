/**
 * The JIZURA render line (core/src/jizura): the vendored engine and its pin,
 * Lyric motion's text and timing as JIZURA lines, plans that depend on the
 * text alone, horror off unless asked, typed results when fonts or glyphs
 * are missing (and the classic fallback that follows), and frames that are
 * the same with any number of threads.
 *
 * Runs without JIZURA's own fonts: Core's Peesuto Text (Latin, Chinese and
 * Japanese) stands in for every face JIZURA asks for. The canvas tests skip
 * when the Skia addon is not installed for this platform.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { EngineAbortedError } from "../src/engine.ts";
import type { JizuraFontFile } from "../src/fonts/jizura-packs.ts";
import { loadCanvas } from "../src/jizura/canvas.ts";
import { jizuraBundlePath } from "../src/jizura/bundle.ts";
import { AUTO_STYLE, JizuraDrawer, JizuraStyleError, lyricStyles, prepareJizura, renderJizura, type JizuraJob } from "../src/jizura/index.ts";
import { registerFonts } from "../src/jizura/fonts.ts";
import { createRealm } from "../src/jizura/realm.ts";
import { jizuraChunks } from "../src/jizura/render.ts";
import { shimGrain } from "../src/jizura/grain.ts";
import { lyricScript } from "../src/jizura/script.ts";
import { ComposeError } from "../src/render/compose.ts";
import { liveFrameWorkers, renderFrames } from "../src/render/frames.ts";
import { RENDER_THREADS, renderThreads } from "../src/render/threads.ts";
import { renderLyrics } from "../src/templates/lyrics-route.ts";
import { parseTemplates } from "../src/templates/parse.ts";
import { TemplateInputError, type TemplateContent, type TemplatePlan } from "../src/templates/types.ts";

type Lyrics = Extract<TemplateContent, { kind: "lyrics" }>;
const lyricsOf = (text: string): Lyrics => {
  const c = parseTemplates(text).candidates.get("lyrics");
  if (c?.kind !== "lyrics") throw new Error("no lyrics candidate");
  return c;
};
const ZH = "晚风吹亮*月光*\n我们慢慢走回家\n路灯一盏盏醒来\n把影子拉得很长";
const JA = "夜明けの色を/覚えてる\n*透明*な傘をたたんで\n坂道の途中で笑った!\nまだ眠い町の灯り";

const FONT_DIR = join(import.meta.dir, "../src/render/fonts");
/** Every family JIZURA asks for, drawn with Peesuto Text (regular and bold). */
const standIn = (families: readonly string[]) => ({
  files: families.flatMap((family): JizuraFontFile[] => [
    { family, weight: 400, style: "normal", path: join(FONT_DIR, "PeesutoText-Regular.ttf") },
    { family, weight: 700, style: "normal", path: join(FONT_DIR, "PeesutoText-Bold.ttf") },
  ]),
  missing: [] as string[],
});
const hash = (u: Uint8Array) => createHash("sha1").update(u).digest("hex").slice(0, 16);
const canvasReady = await loadCanvas().then(() => true, () => false);
const withCanvas = test.skipIf(!canvasReady);

afterEach(async () => {
  for (let i = 0; i < 200 && liveFrameWorkers() > 0; i++) await Bun.sleep(10);
  expect(liveFrameWorkers()).toBe(0);
});

describe("the vendored engine", () => {
  test("vendor/jizura is the pinned commit, with JIZURA's MIT licence and catalogue", () => {
    const pin = JSON.parse(readFileSync(join(import.meta.dir, "../../jizura.json"), "utf8")) as { commit: string; version: string; repo: string };
    const head = readFileSync(jizuraBundlePath(), "utf8").slice(0, 800);
    expect(head).toContain(`JIZURA ${pin.version}`);
    expect(head).toContain(pin.commit);
    expect(head).toContain("MIT License");
    const license = readFileSync(join(jizuraBundlePath(), "../LICENSE"), "utf8");
    expect(license).toContain("Copyright (c) 2026 hakoniwa");
    expect(license).toContain("Permission is hereby granted, free of charge");
  });
  test("styles: auto, 24 JIZURA styles (27 with horror), the 4 classic ones; every JIZURA name in Japanese, English and Chinese", () => {
    const plain = lyricStyles(), all = lyricStyles({ horror: true });
    expect(plain[0]!.id).toBe(AUTO_STYLE);
    expect(plain.filter((s) => s.engine === "jizura" && s.id !== AUTO_STYLE)).toHaveLength(24);
    expect(all.filter((s) => s.engine === "jizura" && s.id !== AUTO_STYLE)).toHaveLength(27);
    expect(plain.some((s) => s.horror)).toBe(false);
    expect(all.filter((s) => s.horror).map((s) => s.id).sort()).toEqual(["hrCurse", "hrNightRec", "hrRuin"]);
    expect(plain.filter((s) => s.engine === "classic").map((s) => s.id)).toEqual(["classic", "editorial", "pop", "night"]);
    const noir = plain.find((s) => s.id === "noir")!;
    expect(noir.name).toEqual({ ja: "ノワール・クロマ", en: "Noir Chroma", "zh-Hans": "黑白色差" });
    const catalog = JSON.parse(readFileSync(join(jizuraBundlePath(), "../catalog.json"), "utf8")) as { styles: { key: string; en?: unknown; "zh-Hans"?: unknown }[] };
    expect(catalog.styles).toHaveLength(27);
    for (const s of catalog.styles) { expect(s.en).toBeDefined(); expect(s["zh-Hans"]).toBeDefined(); }
  });
});

describe("text and timing as JIZURA lines", () => {
  test("lyric lines keep their / pieces, emphasis, notes and a trailing !, as JIZURA's markup", () => {
    const s = lyricScript(lyricsOf(JA), { width: 1080, height: 1080, format: "mp4" });
    expect(s.lines.map((l) => l.text)).toEqual(["夜明けの色を/覚えてる", "*透明*な傘をたたんで", "坂道の途中で笑った!", "まだ眠い町の灯り"]);
    expect(s.lyrics.split("\n")).toHaveLength(4);
    // Times follow on from the intro; the whole is intro + lines + tail.
    let at = s.introMs + s.titleMs;
    for (const l of s.lines) { expect(l.startMs).toBe(at); at += l.durationMs; }
    expect(s.totalMs).toBe(at + s.tailMs);
  });
  test("prose: every cut is a line of its own, a paragraph break a stanza gap", () => {
    const text = "我们今天发布了新版本，感谢每一位参与测试的朋友。下一步会继续改进速度。\n\n晚上见。";
    const s = lyricScript(lyricsOf(text), { width: 1080, height: 1080, format: "mp4" });
    expect(s.lines.length).toBeGreaterThan(2);
    expect(s.lyrics).toContain("\n\n");
    expect(s.lines.map((l) => l.text).join("")).toBe(text.replace(/\s+/g, ""));
  });
  withCanvas("characters JIZURA reads as markup stay text: *, /, a leading # and a leading LRC-like tag", async () => {
    const text = "#1 song of the night, 5 * 3 = 15 stars.\nMix 1/2 cup of milk, then wait.\n[00:12] was not a stamp here.";
    const s = lyricScript(lyricsOf(text), { width: 1080, height: 1080, format: "mp4" });
    const realm = createRealm(await loadCanvas(), jizuraBundlePath(), 1);
    const parsed = realm.J.parseLyrics(s.lyrics).lines;
    expect(parsed).toHaveLength(s.lines.length);
    expect(parsed.map((l) => l.text)).toEqual(["＃1 song of the night,", "5 ＊ 3 = 15 stars.", "Mix 1／2 cup of milk,", "then wait.", "［00:12] was not a stamp here."]);
    expect(parsed.every((l) => l.lrc === null && l.manual === null)).toBe(true);
  }, 60_000);
  test("the caps are Lyric motion's: a GIF too long is lyric-gif-too-long, pointing at video; nothing is dropped", () => {
    const long = Array.from({ length: 40 }, (_, i) => `第${i + 1}行的歌词在这里慢慢唱`).join("\n");
    let error: unknown;
    try { lyricScript(lyricsOf(long), { width: 1080, height: 1080, format: "gif" }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(ComposeError);
    expect((error as ComposeError).code).toBe("lyric-gif-too-long");
    // Video holds 30 s: the same text pairs lines or is too long, never shorter than its floors.
    const video = (() => { try { return lyricScript(lyricsOf(long), { width: 1080, height: 1080, format: "mp4" }); } catch (e) { return e; } })();
    if (video instanceof ComposeError) expect(video.code).toBe("lyric-too-long");
    else expect((video as ReturnType<typeof lyricScript>).totalMs).toBeLessThanOrEqual(30_000);
  });
});

describe.skipIf(!canvasReady)("plans", () => {
  const prepare = (text: string, o: { style?: string; horror?: boolean; format?: "gif" | "mp4"; aspect?: "1:1" | "16:9" } = {}) =>
    prepareJizura({ content: lyricsOf(text), sourceText: text, aspect: o.aspect ?? "1:1", format: o.format ?? "gif", ...(o.style ? { style: o.style } : {}), ...(o.horror ? { horror: true } : {}), resolveFonts: standIn });

  test("the same text gives the same film; おまかせ picks from the text", async () => {
    const a = await prepare(ZH), b = await prepare(ZH), c = await prepare(JA);
    if (!a.ok || !b.ok || !c.ok) throw new Error("not prepared");
    expect(JSON.stringify(a.job)).toBe(JSON.stringify(b.job));
    expect(a.meta.requestedStyle).toBe("auto");
    expect(a.meta.mood).not.toBeNull();
    expect(a.meta.lang).toBe("zh-Hans");
    expect(c.meta.lang).toBe("ja");
    expect(JSON.stringify(a.job.project)).not.toBe(JSON.stringify(c.job.project));
  }, 60_000);
  test("a chosen style is drawn in that style; a GIF is drawn at its own width, 15 frames a second", async () => {
    const p = await prepare(JA, { style: "sakura" });
    if (!p.ok) throw new Error(p.message);
    expect(p.meta.style).toBe("sakura");
    expect(p.meta.mood).toBeNull();
    expect(p.job.step).toBe(2);
    expect(p.job.width).toBeLessThanOrEqual(540);
    expect(p.job.width).toBeGreaterThanOrEqual(360);
    const video = await prepare(JA, { style: "sakura", format: "mp4", aspect: "16:9" });
    if (!video.ok) throw new Error(video.message);
    expect([video.job.width, video.job.height, video.job.step]).toEqual([1920, 1080, 1]);
  }, 60_000);
  test("horror is off unless asked: おまかせ never draws a horror style or part, a horror style needs the switch", async () => {
    const canvas = await loadCanvas();
    for (const text of [ZH, JA, "Rain on the window\nI remember you\nNight is falling\nHold on to me"]) {
      const p = await prepare(text);
      if (!p.ok) throw new Error(p.message);
      expect(p.job.project.horror).toBe(false);
      expect(p.meta.style.startsWith("hr")).toBe(false);
      const { J } = createRealm(canvas, p.job.bundlePath, 1);
      const plan = J.plan(p.job.project, null);
      for (const cut of plan.cuts) {
        for (const [group, key] of [["layout", cut.layout], ["enter", cut.enter], ["exit", cut.exit], ["hold", cut.hold], ["treat", cut.treat], ["bg", cut.bg], ["cam", cut.cam]] as const) {
          if (key) expect(J.setOf(group, key)).not.toBe("horror");
        }
        for (const d of cut.decor ?? []) expect(J.setOf("decor", d.id)).not.toBe("horror");
      }
    }
    await expect(prepare(ZH, { style: "hrRuin" })).rejects.toBeInstanceOf(JizuraStyleError);
    const horror = await prepare(ZH, { style: "hrRuin", horror: true });
    expect(horror.ok && horror.meta.style).toBe("hrRuin");
    await expect(prepare(ZH, { style: "no-such-style" })).rejects.toBeInstanceOf(JizuraStyleError);
  }, 60_000);
  test("missing fonts and missing glyphs are typed results, never a render with boxes", async () => {
    const text = ZH;
    const missing = await prepareJizura({ content: lyricsOf(text), sourceText: text, aspect: "1:1", format: "gif", resolveFonts: (families) => ({ files: [], missing: [...families] }) });
    expect(missing.ok).toBe(false);
    if (!missing.ok && missing.reason === "fonts-missing") expect(missing.missing).toContain("Noto Sans SC");
    else throw new Error("expected fonts-missing");
    // Anton has Latin only: the Chinese characters would be boxes.
    const latinOnly = (families: readonly string[]) => ({ files: families.map((family): JizuraFontFile => ({ family, weight: 400, style: "normal", path: join(FONT_DIR, "Anton-Subset.ttf") })), missing: [] });
    const glyphs = await prepareJizura({ content: lyricsOf(text), sourceText: text, aspect: "1:1", format: "gif", resolveFonts: latinOnly });
    expect(glyphs.ok).toBe(false);
    if (!glyphs.ok && glyphs.reason === "glyphs") expect(glyphs.characters).toContain("晚");
    else throw new Error("expected glyphs");
  }, 60_000);
  test("a Chinese film needs its own faces only: the Japanese faces at the end of its font lists are fallbacks", async () => {
    const asked: { families: string[]; text: string }[] = [];
    // this machine has every face but the Japanese ones (no Japanese pack, no Latin cut)
    const noJapanese = (families: readonly string[], o: { readonly text: string }) => {
      asked.push({ families: [...families], text: o.text });
      const jp = families.filter((f) => f.endsWith(" JP"));
      return { files: standIn(families.filter((f) => !jp.includes(f))).files, missing: jp };
    };
    const zh = await prepareJizura({ content: lyricsOf(ZH), sourceText: ZH, aspect: "1:1", format: "gif", style: "forest", resolveFonts: noJapanese });
    if (!zh.ok) throw new Error(zh.message);
    expect(zh.meta.families).toContain("Noto Sans JP");                 // in the lists, behind Noto Sans SC
    const needed = asked.filter((a) => a.text !== "").flatMap((a) => a.families);
    expect(needed).toContain("Noto Sans SC");
    expect(needed.filter((f) => f.endsWith(" JP"))).toEqual([]);
    expect(asked.some((a) => a.text === "" && a.families.includes("Noto Sans JP"))).toBe(true);
    // a Japanese film draws with the Japanese faces first: they are needed
    const ja = await prepareJizura({ content: lyricsOf(JA), sourceText: JA, aspect: "1:1", format: "gif", resolveFonts: noJapanese });
    expect(!ja.ok && ja.reason === "fonts-missing" && ja.missing.some((f) => f.endsWith(" JP"))).toBe(true);
  }, 60_000);
  test("a full face registered after its Latin cut replaces it (Skia draws a family with the face registered first)", async () => {
    const canvas = await loadCanvas();
    const draw = (family: string) => {
      const cv = canvas.createCanvas(160, 60);
      const ctx = cv.getContext("2d") as unknown as { fillStyle: string; font: string; fillRect(x: number, y: number, w: number, h: number): void; fillText(t: string, x: number, y: number): void };
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 160, 60);
      ctx.fillStyle = "#000"; ctx.font = `700 40px "${family}"`; ctx.fillText("夜明", 4, 46);
      return hash(cv.data());
    };
    const cut = join(FONT_DIR, "jizura/NotoSansJP-Bold-Latin.woff2"), full = join(FONT_DIR, "PeesutoText-Bold.ttf");
    registerFonts(canvas, [{ family: "Cut Then Full", weight: 700, style: "normal", path: cut, cut: true }]);
    const boxes = draw("Cut Then Full");
    registerFonts(canvas, [{ family: "Cut Then Full", weight: 700, style: "normal", path: full }]);
    registerFonts(canvas, [{ family: "Full Only", weight: 700, style: "normal", path: full }]);
    expect(draw("Cut Then Full")).toBe(draw("Full Only"));
    expect(draw("Cut Then Full")).not.toBe(boxes);
  });
});

describe("routing (templates/lyrics-route.ts)", () => {
  const plan = (text: string, format: "gif" | "mp4" | "png" = "gif"): [TemplatePlan, string[]] => {
    const calls: string[] = [];
    return [{ version: 1, template: "lyrics", variant: "classic", motion: format === "png" ? "none" : "reveal", sourceText: text, content: lyricsOf(text), aspect: "1:1" }, calls];
  };
  const fakeClassic = (calls: string[]) => (async (p: TemplatePlan, o: { format?: string }) => {
    calls.push(`${p.variant}:${o.format}`);
    return { path: `/tmp/fake.${o.format}`, format: o.format, frames: 90, lines: 1, size: 40, width: 1080, height: 1080, scroll: false, ms: { compose: 1, build: 1, frame: 1 } };
  }) as never;
  const options = { engine: "/fake", work: "/tmp/w", emojiCache: "/tmp/e" };

  test("the poster and an explicit classic choice go to Pocket Motion", async () => {
    const [p, calls] = plan(ZH, "png");
    expect((await renderLyrics(p, { ...options, format: "png" }, {}, fakeClassic(calls))).lyric).toEqual({ engine: "classic", reason: "poster" });
    const [g] = plan(ZH);
    expect((await renderLyrics(g, { ...options, format: "gif" }, { style: "night" }, fakeClassic(calls))).lyric).toEqual({ engine: "classic", reason: "chosen" });
    expect((await renderLyrics(g, { ...options, format: "gif" }, { engine: "classic" }, fakeClassic(calls))).lyric).toEqual({ engine: "classic", reason: "chosen" });
    expect((await renderLyrics(g, { ...options, format: "gif" }, { classicVariant: true }, fakeClassic(calls))).lyric).toEqual({ engine: "classic", reason: "chosen" });
    expect(calls).toEqual(["classic:png", "night:gif", "classic:gif", "classic:gif"]);
  });
  withCanvas("JIZURA without its fonts falls back to classic and says which fonts", async () => {
    const [g, calls] = plan(ZH);
    const r = await renderLyrics(g, { ...options, format: "gif" }, { resolveFonts: (families) => ({ files: [], missing: [...families] }) }, fakeClassic(calls));
    expect(r.lyric).toMatchObject({ engine: "classic", reason: "fonts-missing", missing: expect.arrayContaining(["Noto Sans SC"]) });
    expect(calls).toEqual(["classic:gif"]);
  }, 60_000);
  withCanvas("an input JIZURA refuses is an input error, not a fallback", async () => {
    const [g, calls] = plan(ZH);
    await expect(renderLyrics(g, { ...options, format: "gif" }, { style: "hrCurse", resolveFonts: standIn }, fakeClassic(calls))).rejects.toBeInstanceOf(TemplateInputError);
    await expect(renderLyrics(g, { ...options, format: "gif" }, { engine: "jizura", style: "pop" }, fakeClassic(calls))).rejects.toBeInstanceOf(TemplateInputError);
    expect(calls).toEqual([]);
  }, 60_000);
});

describe.skipIf(!canvasReady)("frames", () => {
  /** A short film, small: a GIF-sized 1:1 at 15 frames a second, cut into small chunks so every thread gets some. */
  const film = async (text = JA, style = "noir"): Promise<JizuraJob> => {
    const p = await prepareJizura({ content: lyricsOf(text), sourceText: text, aspect: "1:1", format: "gif", style, resolveFonts: standIn });
    if (!p.ok) throw new Error(p.message);
    const width = 240, height = 240, durationFrames = Math.min(p.job.durationFrames, 150);
    return { ...p.job, width, height, durationFrames, maxRes: 512, chunks: jizuraChunks({ durationFrames, step: p.job.step, fps: p.job.fps, width, height, size: 8 }) };
  };
  const hashes = async (job: JizuraJob, threads: number) => {
    const out: string[] = [];
    for await (const f of renderFrames({ jizura: job, threads, label: "test" })) out.push(hash(f.rgba));
    return out;
  };

  test("one thread, three threads and four draw the same frames, byte for byte", async () => {
    const job = await film();
    expect(job.chunks.length).toBeGreaterThan(4);
    const one = await hashes(job, 1);
    expect(one.length).toBe(Math.ceil(job.durationFrames / job.step));
    expect(new Set(one).size).toBeGreaterThan(one.length / 3);
    expect(await hashes(job, 3)).toEqual(one);
    expect(await hashes(job, 4)).toEqual(one);
  }, 120_000);
  test("chunked frames are the frames of one uninterrupted run", async () => {
    for (const [text, style] of [[JA, "noir"], [ZH, "auto"]] as const) {
      const job = await film(text, style);
      const chunked = await hashes(job, 3);
      const canvas = await loadCanvas();
      const realm = createRealm(canvas, job.bundlePath, job.randomSeed);
      realm.J.glyphs.maxRes = job.maxRes;
      const plan = realm.J.plan(JSON.parse(JSON.stringify(job.project)), null);
      const renderer = new realm.J.Renderer();
      const cv = canvas.createCanvas(job.width, job.height), ctx = cv.getContext("2d", { alpha: false });
      const r = renderer as unknown as { grain: unknown[]; scan: unknown };
      if (job.grainShim || job.noGrain) shimGrain(canvas, ctx, [...r.grain, r.scan], { sheets: job.grainShim, ...(job.noGrain ? { skip: r.grain } : {}) });
      const straight: string[] = [];
      for (let f = 0; f < job.durationFrames; f += job.step) { renderer.frame(ctx, plan, f / job.fps, { scale: job.width / plan.W }); straight.push(hash(cv.data())); }
      realm.dispose();
      expect(chunked).toEqual(straight);
    }
  }, 120_000);
  test("drawing resumes inside a chunk with the same pixels (the workers gave up there)", async () => {
    const job = await film(ZH, "candy");
    const chunk = job.chunks[2]!;
    const whole = await JizuraDrawer.open(job);
    const all: string[] = [];
    for (const f of chunk.frames) all.push(hash(await whole.draw(f)));
    const resumed = await JizuraDrawer.open(job);
    const k = Math.floor(chunk.frames.length / 2);
    const tail: string[] = [];
    for (const f of chunk.frames.slice(k)) tail.push(hash(await resumed.draw(f)));
    expect(tail).toEqual(all.slice(k));
  }, 120_000);
  test("the grain drawn as sheets matches Skia's pattern fill within rounding", async () => {
    const job = await film(ZH, "mint");
    const short = { ...job, chunks: job.chunks.slice(0, 2) };
    const a = await JizuraDrawer.open({ ...short, grainShim: false, noGrain: false }), b = await JizuraDrawer.open({ ...short, grainShim: true, noGrain: false });
    let max = 0, sum = 0, n = 0;
    for (const f of short.chunks.flatMap((c) => c.frames)) {
      const x = await a.draw(f), y = await b.draw(f);
      for (let i = 0; i < x.length; i += 4) for (let c = 0; c < 3; c++) { const d = Math.abs(x[i + c]! - y[i + c]!); max = Math.max(max, d); sum += d; n++; }
    }
    expect(max).toBeLessThanOrEqual(8);
    // Under 1 on macOS; Skia's pattern sampling on Linux x64 rounds differently (1.15 on ubuntu-latest).
    expect(sum / n).toBeLessThan(1.5);
  }, 120_000);
  test("cancelling stops the threads and the render", async () => {
    const job = await film();
    const control = new AbortController();
    const dir = await mkdtemp(join(tmpdir(), "peesuto-jizura-"));
    try {
      const run = renderJizura(job, { out: join(dir, "x.gif"), format: "gif", threads: 3, signal: control.signal });
      setTimeout(() => control.abort(), 300);
      await expect(run).rejects.toBeInstanceOf(EngineAbortedError);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60_000);
  test.skipIf(!Bun.which("ffmpeg"))("an MP4 through ffmpeg's raw pipe (outside the app), H.264 tagged BT.709", async () => {
    const job = { ...(await film(ZH, "candy")), step: 1, durationFrames: 40 };
    const chunked = { ...job, chunks: jizuraChunks({ durationFrames: 40, step: 1, fps: job.fps, width: job.width, height: job.height, size: 8 }) };
    const dir = await mkdtemp(join(tmpdir(), "peesuto-jizura-"));
    try {
      const out = join(dir, "x.mp4");
      const r = await renderJizura(chunked, { out, format: "mp4", threads: 2, encoder: { kind: "ffmpeg", path: Bun.which("ffmpeg")! } });
      expect(r.frames).toBe(40);
      const probe = Bun.spawnSync([Bun.which("ffprobe") ?? "ffprobe", "-v", "error", "-show_entries", "stream=codec_name,color_primaries,color_transfer,nb_frames", "-of", "compact", out]);
      const text = probe.stdout.toString();
      if (probe.exitCode === 0) expect(text).toContain("codec_name=h264");
      const bytes = await Bun.file(out).bytes();
      const at = (box: string) => Buffer.from(bytes).indexOf(box);
      expect(at("moov")).toBeLessThan(at("mdat"));
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60_000);
  test("a GIF leaves the film grain out (as classic Lyric motion); video keeps it", async () => {
    const gif = await prepareJizura({ content: lyricsOf(JA), sourceText: JA, aspect: "1:1", format: "gif", style: "noir", resolveFonts: standIn });
    const video = await prepareJizura({ content: lyricsOf(JA), sourceText: JA, aspect: "1:1", format: "mp4", style: "noir", resolveFonts: standIn });
    expect(gif.ok && gif.job.noGrain).toBe(true);
    expect(video.ok && video.job.noGrain).toBeFalsy();
  }, 60_000);
  test("a GIF out of a prepared film", async () => {
    const job = await film(ZH, "candy");
    const dir = await mkdtemp(join(tmpdir(), "peesuto-jizura-"));
    try {
      const r = await renderJizura(job, { out: join(dir, "x.gif"), format: "gif", threads: 2 });
      const bytes = await Bun.file(join(dir, "x.gif")).bytes();
      expect(Buffer.from(bytes.slice(0, 6)).toString()).toBe("GIF89a");
      expect(r.frames).toBe(Math.ceil(job.durationFrames / job.step));
      expect(r.fps).toBe(15);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60_000);
});

describe("threads for JIZURA", () => {
  test("their own memory budget", () => {
    const GB = 2 ** 30;
    expect(renderThreads({ performanceCores: 4, logicalCores: 10, memoryBytes: 32 * GB }, {}, { kind: "jizura" })).toBe(RENDER_THREADS.jizura.max);
    expect(renderThreads({ performanceCores: 4, logicalCores: 8, memoryBytes: 8 * GB }, {}, { kind: "jizura" })).toBe(Math.floor(8 * GB * 0.25 / RENDER_THREADS.jizura.bytesPerThread));
    expect(renderThreads({ performanceCores: 4, logicalCores: 8, memoryBytes: 8 * GB }, { PEESUTO_RENDER_THREADS: "5" }, { kind: "jizura" })).toBe(5);
  });
});
