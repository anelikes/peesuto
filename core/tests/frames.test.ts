/**
 * The frame stream (render/frames.ts): order, held frames, worker threads,
 * stopping and falling back, first over synthetic frames (no engine), then,
 * opt-in, against a real prepared engine copy: every frame drawn by worker
 * threads and held-frame reuse hashes the same as the plain one-thread path.
 *
 *   PEESUTO_TEMPLATE_ENGINE=/tmp/prepared-engine-copy bun test core/tests/frames.test.ts
 *
 * (A copy, as for template-engine.test.ts: builds write into the engine's vendor tree.)
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EngineAbortedError, EngineError, EngineTimeoutError } from "../src/engine.ts";
import { liveFrameWorkers, renderFrames, type Frame, type FramesOptions, type FrameStats } from "../src/render/frames.ts";
import { encodeCardGif } from "../src/render/gif.ts";
import { resolvePrepared, type ResolvedComposition } from "../src/render/prepared.ts";
import { RENDER_THREADS, renderThreads } from "../src/render/threads.ts";
import { encodeNativeMp4 } from "../src/render/video.ts";
import { prepareTemplate } from "../src/templates/render.ts";
import { parseTemplates } from "../src/templates/parse.ts";
import { fakeDrawer, fakeMode, fakePicture, FAKE_SIZE } from "./helpers/fake-frames.ts";

const GB = 2 ** 30;

describe("render threads", () => {
  const m4 = { performanceCores: 4, logicalCores: 10, memoryBytes: 32 * GB };
  test("one and a half per performance core, capped at the measured sweet spot", () => {
    expect(renderThreads(m4, {})).toBe(6);
    expect(renderThreads({ performanceCores: 2, logicalCores: 4, memoryBytes: 32 * GB }, {})).toBe(3);
    expect(renderThreads({ performanceCores: 12, logicalCores: 16, memoryBytes: 64 * GB }, {})).toBe(RENDER_THREADS.max);
  });
  test("a quarter of physical memory at 0.6 GB a thread: an 8 GB Mac gets 3, 16 GB gets 6", () => {
    expect(renderThreads({ performanceCores: 4, logicalCores: 8, memoryBytes: 8 * GB }, {})).toBe(3);
    expect(renderThreads({ performanceCores: 4, logicalCores: 10, memoryBytes: 16 * GB }, {})).toBe(6);
    expect(renderThreads({ performanceCores: 4, logicalCores: 8, memoryBytes: 2 * GB }, {})).toBe(1);
  });
  test("without a performance-core count, the logical CPUs less two", () => {
    expect(renderThreads({ logicalCores: 8, memoryBytes: 32 * GB }, {})).toBe(6);
    expect(renderThreads({ logicalCores: 4, memoryBytes: 32 * GB }, {})).toBe(2);
    expect(renderThreads({ logicalCores: 1, memoryBytes: 32 * GB }, {})).toBe(1);
  });
  test("PEESUTO_RENDER_THREADS wins (1 is the one-thread path), within reason; junk is ignored; background work gets one", () => {
    expect(renderThreads(m4, { PEESUTO_RENDER_THREADS: "1" })).toBe(1);
    expect(renderThreads(m4, { PEESUTO_RENDER_THREADS: " 9 " })).toBe(9);
    expect(renderThreads(m4, { PEESUTO_RENDER_THREADS: "5000" })).toBe(RENDER_THREADS.ceiling);
    for (const junk of ["", "0", "-2", "2.5", "many"]) expect(renderThreads(m4, { PEESUTO_RENDER_THREADS: junk })).toBe(6);
    expect(renderThreads(m4, {}, { lowPriority: true })).toBe(1);
    expect(renderThreads(m4, { PEESUTO_RENDER_THREADS: "4" }, { lowPriority: true })).toBe(4);
  });
});

/* ---- synthetic frames ------------------------------------------------------ */
const FAKE_WORKER = new URL("./helpers/fake-frame-worker.ts", import.meta.url).href;
const composition = (durationFrames: number): ResolvedComposition => ({
  compositionId: "fake", bundlePath: "/nonexistent/bundle.js", pakPath: "/nonexistent/pak", width: FAKE_SIZE.width, height: FAKE_SIZE.height,
  fps: 30, durationFrames, supersample: 1, buildCommand: "", sidecar: {},
});
const fake = (mode: string, durationFrames: number, o: Partial<FramesOptions> = {}): FramesOptions => ({
  engine: `fake:${mode}`, composition: composition(durationFrames), threads: 3, label: "test", worker: FAKE_WORKER,
  openDrawer: async (engine) => fakeDrawer(fakeMode(engine)), ...o,
});
const collect = async (o: FramesOptions): Promise<Frame[]> => { const out: Frame[] = []; for await (const f of renderFrames(o)) out.push(f); return out; };
const summary = (frames: readonly Frame[]) => frames.map((f) => `${f.index}:${f.rgba[0]}${f.held ? "h" : ""}`);
/** Resolves once every frame worker of this process has closed; fails the test past `ms`. */
async function workersGone(ms = 1000): Promise<number> {
  const started = performance.now();
  while (liveFrameWorkers() > 0) {
    if (performance.now() - started > ms) throw new Error(`${liveFrameWorkers()} frame workers still alive after ${ms} ms`);
    await Bun.sleep(5);
  }
  return performance.now() - started;
}
afterEach(async () => { await workersGone(2000); });

describe("frame stream (synthetic frames)", () => {
  test("threads deliver every frame in order, pixels and held frames as one thread does", async () => {
    for (const [mode, n, step] of [["hold=3", 100, 1], ["hold=1", 61, 1], ["hold=2", 97, 2], ["hold=5", 13, 1]] as const) {
      const serialStats: FrameStats = { threads: 0, drawn: 0, held: 0 }, parallelStats: FrameStats = { threads: 0, drawn: 0, held: 0 };
      const serial = await collect(fake(mode, n, { threads: 1, step, stats: serialStats }));
      const parallel = await collect(fake(mode, n, { threads: 4, step, stats: parallelStats }));
      expect(serial.map((f) => f.index)).toEqual(Array.from({ length: Math.ceil(n / step) }, (_, i) => i * step));
      expect(summary(parallel)).toEqual(summary(serial));
      const hold = fakeMode(mode).hold;
      for (const f of serial) expect(f.rgba[0]).toBe(fakePicture(f.index, hold));
      expect(serialStats.threads).toBe(1);
      expect(parallelStats).toEqual({ ...serialStats, threads: parallelStats.threads });
      // Two chunks (of six frames) a thread at least: a 13-frame video is not worth a worker.
      expect(parallelStats.threads).toBe(Math.max(1, Math.min(4, Math.floor(Math.ceil(Math.ceil(n / step) / 6) / 2))));
      expect(serialStats.held).toBe(serial.filter((f) => f.held).length);
    }
    // Held frames repeat the previous buffer rather than a copy.
    const held = await collect(fake("hold=3", 60, { threads: 3 }));
    expect(held[1]!.held).toBe(true);
    expect(held[1]!.rgba).toBe(held[0]!.rgba);
  });

  test("aborting stops busy workers within a frame or two", async () => {
    const control = new AbortController();
    const frames = renderFrames(fake("busy=40", 400, { threads: 4, signal: control.signal }));
    for (let i = 0; i < 3; i++) await frames.next();
    expect(liveFrameWorkers()).toBe(4);
    const pending = frames.next();
    const aborted = performance.now();
    control.abort();
    await expect(pending).rejects.toBeInstanceOf(EngineAbortedError);
    expect(performance.now() - aborted).toBeLessThan(200);
    expect(performance.now() - aborted + (await workersGone(1000))).toBeLessThan(400);
  });

  test("leaving the loop early, the deadline and a render failure all stop every worker", async () => {
    for await (const f of renderFrames(fake("busy=10", 300, { threads: 3 }))) if (f.index === 4) break;
    await workersGone();

    await expect(collect(fake("busy=30", 300, { threads: 3, deadline: performance.now() + 150 }))).rejects.toBeInstanceOf(EngineTimeoutError);
    await workersGone();

    const failing = collect(fake("failAt=40", 120, { threads: 3 }));
    await expect(failing).rejects.toThrow("test: fake failure at frame 40");
    await expect(failing).rejects.toBeInstanceOf(EngineError);
    await workersGone();
  });

  test("workers that cannot start fall back to this thread, from where the stream was", async () => {
    const want = summary(await collect(fake("hold=2", 90, { threads: 1 })));
    for (const worker of [undefined, new URL("./helpers/no-such-worker.ts", import.meta.url).href]) {
      const stats: FrameStats = { threads: 0, drawn: 0, held: 0 };
      // failInit: every world fails to boot; a missing module: the thread cannot load at all.
      const o = worker ? fake("hold=2", 90, { threads: 3, stats, worker }) : fake("hold=2,failInit", 90, { threads: 3, stats });
      // The drawer in this thread is the fake one without the failure.
      const frames = await collect({ ...o, openDrawer: async () => fakeDrawer(fakeMode("hold=2")) });
      expect(summary(frames)).toEqual(want);
      expect(stats.threads).toBe(1);
      expect(stats.fallback).toMatch(/could not start/);
      await workersGone();
    }
  });
});

/* ---- a real engine (opt-in) ------------------------------------------------ */
const engine = process.env.PEESUTO_TEMPLATE_ENGINE ? resolve(process.env.PEESUTO_TEMPLATE_ENGINE) : undefined;
const withEngine = engine ? describe : describe.skip;

withEngine("frame stream (real engine)", () => {
  const root = resolve(".work/test-frames");
  const hashes = (frames: readonly Frame[]) => frames.map((f) => Bun.hash.wyhash(f.rgba).toString(16));
  /** Written for this test: a short Pop lyric (koma-uchi holds) and a Paper one in 9:16 (vertical columns, commas as plates). */
  const prepared = async (name: string, text: string, variant: "pop" | "editorial", format: "gif" | "mp4", aspect: "1:1" | "9:16") => {
    const work = join(root, name);
    await mkdir(work, { recursive: true });
    const plan = { version: 1 as const, template: "lyrics" as const, variant, motion: "reveal" as const, aspect, sourceText: text, content: parseTemplates(text).candidates.get("lyrics")! };
    await prepareTemplate(plan, { engine: engine!, work, emojiCache: join(root, "emoji"), format });
    return { work, composition: await resolvePrepared(engine!, work, "test") };
  };

  test("worker threads and held-frame reuse draw exactly the one-thread frames", async () => {
    const pop = await prepared("pop", "晚风吹亮*月光*\n我们慢慢走回家", "pop", "mp4", "1:1");
    const paper = await prepared("paper", "ねえ、まだ間に合うかな", "editorial", "gif", "9:16");
    for (const [{ composition }, step, width] of [[pop, 1, undefined], [pop, 2, 360], [paper, 2, 300]] as const) {
      const run = async (threads: number, reuse: boolean) => {
        const stats: FrameStats = { threads: 0, drawn: 0, held: 0 };
        return { hashes: hashes(await collect({ engine: engine!, composition, threads, reuse, step, width, label: "test", stats })), stats };
      };
      const plain = await run(1, false), reused = await run(1, true), threaded = await run(3, true);
      expect(reused.hashes).toEqual(plain.hashes);
      expect(threaded.hashes).toEqual(plain.hashes);
      expect(threaded.stats).toMatchObject({ threads: 3, drawn: reused.stats.drawn, held: reused.stats.held });
      expect(reused.stats.held).toBeGreaterThan(0);
    }
  }, 240_000);

  test("GIF bytes and the MP4 frame stream are the same with threads as without", async () => {
    const { work } = await prepared("pop", "晚风吹亮*月光*\n我们慢慢走回家", "pop", "mp4", "1:1");
    const out = await mkdtemp(join(tmpdir(), "peesuto-frames-"));
    try {
      const gif = async (threads: number) => { const path = join(out, `t${threads}.gif`); await encodeCardGif({ engine: engine!, work, out: path, width: 360, threads }); return Bun.hash.wyhash(await Bun.file(path).bytes()); };
      expect(await gif(3)).toBe(await gif(1));
      // A stand-in encoder that keeps the raw RGBA it is sent.
      const encoder = join(out, "raw-encoder");
      await writeFile(encoder, `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --width) W=$2;; --height) H=$2;; --out) O=$2;; esac; shift 2; done
cat > "$O"
BYTES=$(wc -c < "$O" | tr -d ' ')
printf '{"ok":true,"frames":%d,"width":%d,"height":%d}\\n' $((BYTES / (W * H * 4))) $W $H
`);
      await chmod(encoder, 0o755);
      const mp4 = async (threads: number) => {
        const path = join(out, `t${threads}.raw`);
        const r = await encodeNativeMp4({ engine: engine!, work, out: path, encoder, threads });
        expect(r.draw?.threads).toBe(threads);
        return Bun.hash.wyhash(await Bun.file(path).bytes());
      };
      expect(await mp4(4)).toBe(await mp4(1));
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 240_000);
});
