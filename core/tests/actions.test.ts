import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
  test("fillTemplate substitutes input, context and app", () => {
    const out = fillTemplate("{{app}}|{{context}}|{{input}}", { text: "T", context: { level: 0, appBundleId: "com.x.y", appName: "Y" } });
    expect(out.startsWith("Y|")).toBe(true);
    expect(out.endsWith("|T")).toBe(true);
  });
});
