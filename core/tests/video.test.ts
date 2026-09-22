import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUILTIN_ACTIONS, parseActionSpec, runAction } from "../src/actions/index.ts";
import { engineMissing } from "../src/engine.ts";
import { renderCard } from "../src/render/card.ts";
import { resolveFFmpeg, videoEnvironment, VideoUnavailableError } from "../src/render/video.ts";
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

describe("video action", () => {
  test("is shipped and validates as an animated MP4 action", () => {
    const action = BUILTIN_ACTIONS.find((action) => action.id === "paste-video")!;
    expect(action).toMatchObject({ builtin: true, needs: "render", output: "video", render: { animate: "always" } });
    expect(parseActionSpec(action).output).toBe("video");
  });
  test("missing ffmpeg fails before contacting a provider or preparing an engine", async () => {
    const root = await makeRoot();
    let asked = false;
    const spec = BUILTIN_ACTIONS.find((action) => action.id === "paste-video")!;
    await expect(runAction(spec, { text: "fixture" }, {
      decider: { name: "fixture", ask: async () => { asked = true; return {}; } }, generator: null,
      render: { engine: join(root, "missing-engine"), work: join(root, "work"), emojiCache: join(root, "emoji"), ffmpeg: join(root, "missing-ffmpeg") },
    })).rejects.toMatchObject({ kind: "needs", message: expect.stringContaining("Video export needs ffmpeg") });
    expect(asked).toBe(false);
    expect(existsSync(join(root, "work"))).toBe(false);
  });
  test("direct MP4 rendering also checks ffmpeg before building", async () => {
    const root = await makeRoot();
    await expect(renderCard(fallbackDsl("fixture", "chat"), {
      engine: join(root, "missing-engine"), work: join(root, "work"), emojiCache: join(root, "emoji"),
      format: "mp4", ffmpeg: join(root, "missing-ffmpeg"),
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
    const ffmpeg = resolveFFmpeg();
    const ffprobe = Bun.which("ffprobe") ?? join(dirname(ffmpeg), "ffprobe");
    const root = await makeRoot();
    const render = { engine: engine!, work: join(root, "work"), emojiCache: join(root, "emoji"), outDir: join(root, "cards"), ffmpeg };
    const deps = { decider: null, generator: null, render };
    const result = await runAction(BUILTIN_ACTIONS.find((a) => a.id === "paste-video")!, { text: "Peesuto native video" }, deps);
    expect(result).toMatchObject({ output: "video", format: "mp4" });
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
