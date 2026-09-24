import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_ACTIONS, fillTemplate, loadActions, parseActionSpec, runAction, ActionError } from "../src/actions/index.ts";

const valid = { id: "shout", name: "Shout", input: "clipboard", needs: "generator", prompt: "SHOUT: {{input}}", output: "text" };

describe("parseActionSpec", () => {
  test("accepts a generator action and strips builtin/pack claims", () => {
    const spec = parseActionSpec({ ...valid, builtin: true, pack: "x" });
    expect(spec.id).toBe("shout");
    expect((spec as { builtin?: boolean }).builtin).toBeUndefined();
  });
  test("every built-in passes its own validation", () => {
    for (const a of BUILTIN_ACTIONS) expect(() => parseActionSpec(a)).not.toThrow();
  });
  const bad: [string, unknown][] = [
    ["bad id", { ...valid, id: "Shout!" }],
    ["missing name", { ...valid, name: "" }],
    ["bad input", { ...valid, input: "selection" }],
    ["bad needs", { ...valid, needs: "magic" }],
    ["generator without {{input}}", { ...valid, prompt: "no placeholder" }],
    ["generator with image output", { ...valid, output: "image" }],
    ["render with text output", { id: "c", name: "C", input: "clipboard", needs: "render", output: "text" }],
    ["render bad aspect", { id: "c", name: "C", input: "clipboard", needs: "render", output: "image", render: { aspect: "wide" } }],
    ["maxTokens zero", { ...valid, maxTokens: 0 }],
    ["fallback on an image action", { id: "c", name: "C", input: "clipboard", needs: "render", output: "image", render: { fallback: "gif" } }],
    ["fallback other than gif", { id: "c", name: "C", input: "clipboard", needs: "render", output: "video", render: { fallback: "png" } }],
    ["outputs without the output", { id: "c", name: "C", input: "clipboard", needs: "render", output: "gif", render: { outputs: ["video", "image"] } }],
    ["outputs with a text output", { id: "c", name: "C", input: "clipboard", needs: "render", output: "gif", render: { outputs: ["gif", "text"] } }],
  ];
  for (const [name, raw] of bad) test(`rejects ${name}`, () => { expect(() => parseActionSpec(raw)).toThrow(ActionError); });
});

describe("loadActions", () => {
  test("built-ins, then user files, then packs; broken files are problems, not failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "paste-actions-"));
    const user = join(root, "actions"), packs = join(root, "packs");
    await mkdir(user); await mkdir(join(packs, "office/actions"), { recursive: true });
    await writeFile(join(user, "shout.json"), JSON.stringify(valid));
    await writeFile(join(user, "paste-summary.json"), JSON.stringify({ ...valid, id: "paste-summary", name: "My summary" }));
    await writeFile(join(user, "broken.json"), "{ not json");
    await writeFile(join(packs, "office/pack.json"), JSON.stringify({ id: "office-pack", name: "Office" }));
    await writeFile(join(packs, "office/actions/memo.json"), JSON.stringify({ ...valid, id: "memo", name: "Memo" }));
    const { actions, problems } = await loadActions({ userDir: user, packsDir: packs });
    const ids = actions.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(["paste-smart", "paste-card", "shout", "memo"]));
    expect(actions.find((a) => a.id === "paste-summary")?.name).toBe("My summary");
    expect(actions.find((a) => a.id === "paste-summary")?.builtin).toBeUndefined();
    expect(actions.find((a) => a.id === "memo")?.pack).toBe("office-pack");
    expect(problems.length).toBe(1);
    expect(problems[0]!.file.endsWith("broken.json")).toBe(true);
  });
});

describe("runAction", () => {
  const deps = { decider: null, generator: { generate: async (r: { prompt: string; system?: string }) => ({ text: `[${r.system ?? ""}] ${r.prompt}`, model: "stub" }) }, render: null };
  test("none returns the text", async () => {
    const r = await runAction(parseActionSpec({ id: "as-is", name: "As is", input: "clipboard", needs: "none", output: "text" }), { text: "hi" }, deps);
    expect(r).toMatchObject({ output: "text", text: "hi" });
  });
  test("generator fills the template and returns the model's text", async () => {
    const r = await runAction(parseActionSpec(valid), { text: "hello", context: { level: 1, appBundleId: "com.apple.Notes", appName: "Notes", role: "AXTextArea" } }, deps);
    expect(r).toMatchObject({ output: "text", text: "[] SHOUT: hello", model: "stub" });
  });
  test("a generator that answers with nothing → ActionError(run) naming the model", async () => {
    const silent = { generate: async () => ({ text: "  \n", model: "qwen3.5:4b" }) };
    await expect(runAction(parseActionSpec(valid), { text: "x" }, { ...deps, generator: silent })).rejects.toMatchObject({ kind: "run", message: expect.stringContaining("qwen3.5:4b returned nothing") });
  });

  test("generator missing → ActionError(needs); empty input → ActionError(input)", async () => {
    await expect(runAction(parseActionSpec(valid), { text: "x" }, { ...deps, generator: null })).rejects.toMatchObject({ kind: "needs" });
    await expect(runAction(parseActionSpec(valid), { text: "  " }, deps)).rejects.toMatchObject({ kind: "input" });
  });
  test("render without an engine → ActionError(needs)", async () => {
    const card = BUILTIN_ACTIONS.find((a) => a.id === "paste-card")!;
    await expect(runAction(card, { text: "x" }, deps)).rejects.toMatchObject({ kind: "needs" });
  });
  test("paste-lyric: fixed to lyric motion, a GIF by default, video or poster on request; GIF only when no MP4 encoder exists", async () => {
    const lyric = BUILTIN_ACTIONS.find((a) => a.id === "paste-lyric")!;
    expect(lyric).toMatchObject({ output: "gif", render: { template: "lyrics", animate: "always", outputs: ["gif", "video", "image"], fallback: "gif" } });
    expect(parseActionSpec(lyric).render?.outputs).toEqual(["gif", "video", "image"]);
    const formats: string[] = [];
    const fake = (async (plan: { template: string; motion: string }, o: { format: string }) => {
      formats.push(`${plan.template}:${o.format}`);
      return { path: `/tmp/fake.${o.format}`, format: o.format, frames: o.format === "png" ? 1 : 90, lines: 1, size: 40, width: 1080, height: 1080, scroll: false, ms: { compose: 1, build: 1, frame: 1 }, ...(o.format === "mp4" ? { encoder: "native" } : {}) };
    }) as never;
    const encoder = join(tmpdir(), "peesuto-mock-encoder");
    await Bun.write(encoder, "#!/bin/sh\nexit 0\n");
    await chmod(encoder, 0o755);
    const withNative = { decider: null, generator: null, render: { engine: "/fake", work: "/tmp/w", nativeEncoder: encoder }, renderTemplate: fake } as never;
    const text = "We shipped the release today. Thanks, everyone.";
    // Default: GIF, no fallback.
    expect(await runAction(lyric, { text }, withNative)).toMatchObject({ output: "gif", format: "gif", meta: { template: { id: "lyrics" } } });
    // Settings › Templates › Lyric motion: Video → MP4 through the native encoder, no GIF fallback.
    const video = await runAction(lyric, { text, output: "video" }, withNative);
    expect(video).toMatchObject({ output: "video", format: "mp4", meta: { encoder: "native" } });
    expect((video as { meta?: Record<string, unknown> }).meta?.fallback).toBeUndefined();
    // Poster: a PNG of the whole text.
    expect(await runAction(lyric, { text, output: "image" }, withNative)).toMatchObject({ output: "image", format: "png" });
    expect(formats).toEqual(["lyrics:gif", "lyrics:mp4", "lyrics:png"]);
    // An output the action does not offer is refused.
    await expect(runAction(BUILTIN_ACTIONS.find((a) => a.id === "paste-card")!, { text, output: "video" }, withNative)).rejects.toMatchObject({ kind: "input" });
    // Neither the app's encoder nor ffmpeg: Video becomes an explicit GIF fallback; paste-video fails with "needs".
    const noEncoder = { decider: null, generator: null, render: { engine: "/fake", work: "/tmp/w", videoEncoder: "ffmpeg", ffmpeg: "/nonexistent/ffmpeg" }, renderTemplate: fake } as never;
    expect(await runAction(lyric, { text, output: "video" }, noEncoder)).toMatchObject({ output: "gif", format: "gif", meta: { fallback: { from: "video", to: "gif", reason: "encoder" } } });
    await expect(runAction(BUILTIN_ACTIONS.find((a) => a.id === "paste-video")!, { text: "x" }, noEncoder)).rejects.toMatchObject({ kind: "needs" });
  });
  test("fillTemplate substitutes input, context and app", () => {
    const out = fillTemplate("{{app}}|{{context}}|{{input}}", { text: "T", context: { level: 0, appBundleId: "com.x.y", appName: "Y" } });
    expect(out.startsWith("Y|")).toBe(true);
    expect(out.endsWith("|T")).toBe(true);
  });
});
