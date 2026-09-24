import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUILTIN_ACTIONS, parseActionSpec, runAction } from "../src/actions/index.ts";
import { EngineError, engineMissing } from "../src/engine.ts";
import { mp4Boxes } from "./helpers/mp4.ts";
import { renderCard } from "../src/render/card.ts";
import { pipeFramesToEncoder, resolveFFmpeg, resolveVideoEncoder, videoEnvironment, VideoUnavailableError } from "../src/render/video.ts";
import { fallbackDsl } from "../src/questions.ts";

const temporary: string[] = [];
const makeRoot = async () => { const dir = await mkdtemp(join(tmpdir(), "peesuto-video-test-")); temporary.push(dir); return dir; };
afterEach(async () => { for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }); });
const executable = async (root: string, name: string) => {
  const file = join(root, name);
  await writeFile(file, "#!/bin/sh\nexit 0\n");
  await chmod(file, 0o755);
  return file;
};

describe("video encoder discovery", () => {
  test("explicit override wins and supports a custom filename", async () => {
    const root = await makeRoot();
    const selected = await executable(root, "encoder-custom");
    expect(resolveFFmpeg({ executable: selected, env: { PATH: "/unavailable" }, fallbackPaths: [] })).toBe(selected);
    expect(resolveFFmpeg({ env: { PEESUTO_FFMPEG_PATH: selected, PATH: "" }, fallbackPaths: [] })).toBe(selected);
  });
  test("PATH wins before GUI fallback locations", async () => {
    const root = await makeRoot();
    const selected = await executable(root, "ffmpeg");
    const fallback = await executable(root, "other-ffmpeg");
    expect(resolveFFmpeg({ env: { PATH: root }, fallbackPaths: [fallback] })).toBe(selected);
    expect(resolveFFmpeg({ env: { PATH: "/unavailable" }, fallbackPaths: [fallback] })).toBe(fallback);
  });
  test("invalid explicit override fails instead of silently selecting another encoder", async () => {
    const root = await makeRoot();
    const fallback = await executable(root, "ffmpeg");
    expect(() => resolveFFmpeg({ executable: join(root, "missing"), env: { PATH: root }, fallbackPaths: [fallback] })).toThrow(VideoUnavailableError);
    expect(() => resolveFFmpeg({ executable: root, fallbackPaths: [] })).toThrow(VideoUnavailableError);
    expect(() => resolveFFmpeg({ executable: "relative/path", fallbackPaths: [] })).toThrow(VideoUnavailableError);
  });
  test("missing encoder gives actionable error while preserving PNG/GIF availability", () => {
    expect(() => resolveFFmpeg({ env: { PATH: "/unavailable" }, fallbackPaths: [] })).toThrow("PNG and GIF export are still available");
  });
  test("the native encoder wins over ffmpeg; ffmpeg is the fallback, or forced for debugging", async () => {
    const root = await makeRoot();
    const native = await executable(root, "PeesutoEncoder");
    const ffmpeg = await executable(root, "ffmpeg");
    const none = { nativePaths: [], ffmpegFallbackPaths: [] };
    expect(resolveVideoEncoder({ env: { PATH: root }, nativePaths: [join(root, "missing"), native] })).toEqual({ kind: "native", path: native });
    expect(resolveVideoEncoder({ env: { PATH: root }, ...none })).toEqual({ kind: "ffmpeg", path: ffmpeg });
    expect(resolveVideoEncoder({ env: { PATH: root, PEESUTO_VIDEO_ENCODER: "ffmpeg" }, nativePaths: [native] })).toEqual({ kind: "ffmpeg", path: ffmpeg });
    expect(resolveVideoEncoder({ prefer: "ffmpeg", env: { PATH: root }, nativePaths: [native] })).toEqual({ kind: "ffmpeg", path: ffmpeg });
    expect(resolveVideoEncoder({ env: { PATH: "", PEESUTO_ENCODER_PATH: native }, ...none })).toEqual({ kind: "native", path: native });
    expect(() => resolveVideoEncoder({ prefer: "native", env: { PATH: root }, ...none })).toThrow(VideoUnavailableError);
    expect(() => resolveVideoEncoder({ env: { PATH: root, PEESUTO_VIDEO_ENCODER: "x264" }, ...none })).toThrow("auto, native or ffmpeg");
    // A configured path that is wrong fails instead of silently using another encoder.
    expect(() => resolveVideoEncoder({ native: join(root, "missing"), env: { PATH: root }, nativePaths: [native] })).toThrow(VideoUnavailableError);
    // Neither: one error that says what to do, never "needs ffmpeg" inside the app.
    expect(() => resolveVideoEncoder({ env: { PATH: "/unavailable" }, ...none })).toThrow("The Peesuto app includes one");
  });
  test("work-local aliases expose both ffmpeg and Bun without changing process PATH", async () => {
    const root = await makeRoot();
    const selected = await executable(root, "encoder-custom");
    const original = process.env.PATH;
    const env = await videoEnvironment(join(root, "work"), selected);
    expect(Bun.which("ffmpeg", env)).toBe(join(root, "work/.video-bin/ffmpeg"));
    expect(Bun.which("bun", env)).toBe(join(root, "work/.bin/bun"));
    expect(process.env.PATH).toBe(original);
  });
});

/** A stand-in for PeesutoEncoder: counts stdin bytes, writes --out, reports like the real one. */
async function mockEncoder(root: string, body = ""): Promise<string> {
  const file = join(root, "mock-encoder");
  await writeFile(file, `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --width) W=$2;; --height) H=$2;; --fps) F=$2;; --out) O=$2;; esac; shift 2; done
echo "$W $H $F" > "$O.args"
${body}
BYTES=$(wc -c | tr -d ' ')
printf 'mp4' > "$O"
printf '{"ok":true,"frames":%d,"width":%d,"height":%d,"fps":%d}\\n' $((BYTES / (W * H * 4))) $W $H $F
`);
  await chmod(file, 0o755);
  return file;
}

describe("native encoder pipe (mock encoder)", () => {
  const frames = (w: number, h: number) => (i: number) => new Uint8Array(w * h * 4).fill(i);
  test("streams every frame as raw RGBA and passes size and rate", async () => {
    const root = await makeRoot();
    const out = join(root, "out/card.mp4");
    const r = await pipeFramesToEncoder({ encoder: await mockEncoder(root), out, width: 8, height: 6, fps: 30, frames: 12, frame: frames(8, 6) });
    expect(r).toMatchObject({ frames: 12, width: 8, height: 6, fps: 30 });
    expect(await Bun.file(`${out}.args`).text()).toBe("8 6 30\n");
    expect(await Bun.file(out).text()).toBe("mp4");
  });
  test("an encoder failure surfaces its stderr; a short count is an error", async () => {
    const root = await makeRoot();
    const failing = await mockEncoder(root, `cat >/dev/null; echo "PeesutoEncoder: the H.264 encoder rejected 8×6" >&2; exit 1`);
    await expect(pipeFramesToEncoder({ encoder: failing, out: join(root, "a.mp4"), width: 8, height: 6, fps: 30, frames: 3, frame: frames(8, 6) }))
      .rejects.toThrow("the H.264 encoder rejected");
    const short = join(root, "short");
    await writeFile(short, `#!/bin/sh
cat >/dev/null
echo '{"ok":true,"frames":1}'
`);
    await chmod(short, 0o755);
    await expect(pipeFramesToEncoder({ encoder: short, out: join(root, "b.mp4"), width: 8, height: 6, fps: 30, frames: 3, frame: frames(8, 6) }))
      .rejects.toThrow("wrote 1 of 3 frames");
  });
  test("a frame of the wrong size, a deadline or an abort stops the encoder", async () => {
    const root = await makeRoot();
    const encoder = await mockEncoder(root);
    await expect(pipeFramesToEncoder({ encoder, out: join(root, "a.mp4"), width: 8, height: 6, fps: 30, frames: 2, frame: () => new Uint8Array(5) })).rejects.toBeInstanceOf(EngineError);
    await expect(pipeFramesToEncoder({ encoder, out: join(root, "b.mp4"), width: 8, height: 6, fps: 30, frames: 2, frame: frames(8, 6), deadline: performance.now() - 1 })).rejects.toThrow("timed out");
    const control = new AbortController();
    control.abort();
    await expect(pipeFramesToEncoder({ encoder, out: join(root, "c.mp4"), width: 8, height: 6, fps: 30, frames: 2, frame: frames(8, 6), signal: control.signal })).rejects.toBeInstanceOf(EngineError);
  });
});

// The real PeesutoEncoder (macOS): `swift build --package-path native -c release` first.
// CI's render job builds it and sets PEESUTO_TEST_ENCODER=1, so a missing build fails there.
const builtEncoder = join(import.meta.dir, "../../native/.build/release/PeesutoEncoder");
const requireEncoder = process.env.PEESUTO_TEST_ENCODER === "1";
describe.skipIf(process.platform !== "darwin" || (!requireEncoder && !existsSync(builtEncoder)))("PeesutoEncoder (AVFoundation)", () => {
  test("encodes a real clip: H.264 High, 4:2:0, faststart, exact frame count and rate, colour tagged", async () => {
    const root = await makeRoot();
    const out = join(root, "clip.mp4");
    const W = 320, H = 240, colours = [[230, 40, 40], [40, 180, 70], [40, 70, 220], [128, 128, 128]];
    const r = await pipeFramesToEncoder({ encoder: builtEncoder, out, width: W, height: H, fps: 30, frames: 45, frame: (i) => {
      const rgba = new Uint8Array(W * H * 4);
      for (let p = 0; p < W * H; p++) { const c = colours[(Math.floor((p % W) / 80) + (i >> 3)) % 4]!; rgba.set([c[0]!, c[1]!, c[2]!, 255], p * 4); }
      return rgba;
    } });
    expect(r).toMatchObject({ frames: 45, width: W, height: H, fps: 30 });
    const boxes = mp4Boxes(await Bun.file(out).bytes());
    expect(boxes.top.indexOf("moov")).toBeGreaterThan(-1);
    expect(boxes.top.indexOf("moov")).toBeLessThan(boxes.top.indexOf("mdat")); // faststart
    expect(boxes.codec).toBe("avc1");
    expect(boxes.profile).toBe(100); // High
    expect(boxes.chroma).toBe(1); // 4:2:0 (avcC chroma_format_idc for High)
    expect(boxes.size).toEqual([W, H]);
    expect(boxes.samples).toBe(45);
    expect(boxes.durationSeconds).toBeCloseTo(1.5, 3);
    // BT.709 primaries and matrix, limited range; transfer sRGB (13), or BT.709 (1) where the writer refuses sRGB.
    expect(boxes.colour).toMatchObject({ primaries: 1, matrix: 1, fullRange: false });
    expect([13, 1]).toContain(boxes.colour!.transfer);
    expect((await Array.fromAsync(new Bun.Glob("*").scan(root))).sort()).toEqual(["clip.mp4"]);
  }, 60_000);
  test("fails cleanly on a truncated frame and leaves no file", async () => {
    const root = await makeRoot();
    const p = Bun.spawn([builtEncoder, "--width", "16", "--height", "16", "--fps", "30", "--out", join(root, "x.mp4")], { stdin: new Uint8Array(100), stdout: "pipe", stderr: "pipe" });
    expect(await p.exited).toBe(1);
    expect(await new Response(p.stderr).text()).toContain("stdin ended inside a frame");
    expect(await Array.fromAsync(new Bun.Glob("*").scan(root))).toEqual([]);
  });
});

describe("video action", () => {
  test("is shipped and validates as an animated MP4 action", () => {
    const action = BUILTIN_ACTIONS.find((action) => action.id === "paste-video")!;
    expect(action).toMatchObject({ builtin: true, needs: "render", output: "video", render: { animate: "always" } });
    expect(parseActionSpec(action).output).toBe("video");
  });
  test("no MP4 encoder fails before contacting a provider or preparing an engine", async () => {
    const root = await makeRoot();
    let asked = false;
    const spec = BUILTIN_ACTIONS.find((action) => action.id === "paste-video")!;
    await expect(runAction(spec, { text: "fixture" }, {
      decider: { name: "fixture", ask: async () => { asked = true; return {}; } }, generator: null,
      render: { engine: join(root, "missing-engine"), work: join(root, "work"), emojiCache: join(root, "emoji"), videoEncoder: "ffmpeg", ffmpeg: join(root, "missing-ffmpeg") },
    })).rejects.toMatchObject({ kind: "needs", message: expect.stringContaining("PNG and GIF export are still available") });
    expect(asked).toBe(false);
    expect(existsSync(join(root, "work"))).toBe(false);
  });
  test("direct MP4 rendering also checks the encoder before building", async () => {
    const root = await makeRoot();
    await expect(renderCard(fallbackDsl("fixture", "chat"), {
      engine: join(root, "missing-engine"), work: join(root, "work"), emojiCache: join(root, "emoji"),
      format: "mp4", nativeEncoder: join(root, "missing-encoder"),
    })).rejects.toBeInstanceOf(VideoUnavailableError);
    expect(existsSync(join(root, "work"))).toBe(false);
  });
});

// Explicit opt-in: never auto-discover a sibling engine checkout and build in
// it during unit tests. The host uses a private pinned engine installation.
const engine = process.env.POCKET_ENGINE;
const runIntegration = process.env.PEESUTO_TEST_VIDEO === "1";
describe.skipIf(!runIntegration)("Pocket Motion MP4 integration", () => {
  test("renders playable H.264, retains prior outputs, and still produces PNG/GIF", async () => {
    expect(engine).toBeTruthy();
    expect(engineMissing(engine!)).toEqual([]);
    const encoder = resolveVideoEncoder();
    const ffprobe = Bun.which("ffprobe") ?? join(dirname(encoder.path), "ffprobe");
    const root = await makeRoot();
    const render = { engine: engine!, work: join(root, "work"), emojiCache: join(root, "emoji"), outDir: join(root, "cards") };
    const deps = { decider: null, generator: null, render };
    const result = await runAction(BUILTIN_ACTIONS.find((a) => a.id === "paste-video")!, { text: "Peesuto native video" }, deps);
    expect(result).toMatchObject({ output: "video", format: "mp4", meta: { encoder: encoder.kind } });
    if (result.output === "text") throw new Error("Expected video output");
    const probe = Bun.spawn([ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", result.path], { stdout: "pipe", stderr: "pipe" });
    const [output, errors, code] = await Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited]);
    expect(errors).toBe("");
    expect(code).toBe(0);
    const info = JSON.parse(output);
    expect(info.streams[0].codec_name).toBe("h264");
    expect(info.streams[0].pix_fmt).toBe("yuv420p");
    expect(Number(info.streams[0].nb_frames)).toBeGreaterThan(1);
    expect(Number(info.format.duration)).toBeGreaterThan(0);
    const first = await runAction(BUILTIN_ACTIONS.find((a) => a.id === "paste-card")!, { text: "First card" }, deps);
    const second = await runAction(BUILTIN_ACTIONS.find((a) => a.id === "paste-card")!, { text: "Second card" }, deps);
    if (first.output === "text" || second.output === "text") throw new Error("Expected image outputs");
    expect(first.format).toBe("png");
    expect(second.path).not.toBe(first.path);
    expect((await Bun.file(first.path).bytes()).slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const gif = await runAction(BUILTIN_ACTIONS.find((a) => a.id === "paste-gif")!, { text: "Animated card" }, deps);
    if (gif.output === "text") throw new Error("Expected GIF output");
    expect(gif).toMatchObject({ output: "gif", format: "gif" });
    expect(new TextDecoder().decode((await Bun.file(gif.path).bytes()).slice(0, 6))).toBe("GIF89a");
    expect(await Bun.file(result.path).exists()).toBe(true);
  }, 180_000);
});
