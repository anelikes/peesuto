import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Daemon, type DaemonHost } from "../src/daemon/server.ts";
import { parsePrecomposeConfig, visibleChars } from "../src/daemon/precompose.ts";
import { EngineAbortedError, runEngine } from "../src/engine.ts";
import type { renderTemplate } from "../src/templates/render.ts";
import type { TemplatePlan } from "../src/templates/types.ts";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A work tree whose "engine" starts a grandchild and then hangs (as in render-safety.test.ts). */
async function hangingWork(): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "paste-hang-"));
  await mkdir(join(work, "src/cli"), { recursive: true });
  await writeFile(join(work, "src/cli/main.ts"), `
    const child = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    await Bun.write(${JSON.stringify(join(work, "grandchild.pid"))}, String(child.pid));
    await Bun.sleep(60_000);
  `);
  return work;
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const until = performance.now() + ms;
  while (!(await check())) { if (performance.now() > until) throw new Error("timed out waiting"); await Bun.sleep(10); }
}

/**
 * A fake renderer: writes a file in the output directory. Texts containing
 * SLOW run a hanging engine (killed only by the abort signal); texts
 * containing WAIT take 300 ms.
 */
function fakeRenderer(hang?: string) {
  const calls: { text: string; format: string; lowPriority?: boolean; aborted?: boolean }[] = [];
  const render = (async (plan: TemplatePlan, o: Parameters<typeof renderTemplate>[1]) => {
    const call: (typeof calls)[number] = { text: plan.sourceText, format: o.format!, lowPriority: o.lowPriority };
    calls.push(call);
    if (hang && plan.sourceText.includes("SLOW")) {
      try { await runEngine(hang, ["render", "compositions/paste"], {}, { signal: o.signal, deadline: performance.now() + 30_000 }); }
      catch (e) { call.aborted = e instanceof EngineAbortedError; throw e; }
    }
    if (plan.sourceText.includes("WAIT")) await Bun.sleep(300);
    const path = join(o.outDir!, `template-${crypto.randomUUID()}.${o.format}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "fake");
    return { path, format: o.format, frames: o.format === "png" ? 1 : 30, lines: 1, size: 40, width: 1080, height: 1080, scroll: false, ms: { compose: 1, build: 1, frame: 1 } } as never;
  }) as typeof renderTemplate;
  return { calls, render };
}

async function daemon(render: typeof renderTemplate) {
  const host: DaemonHost = {
    version: "test", appData: await mkdtemp(join(tmpdir(), "paste-pre-")), engine: "/fake-engine", coreVersion: "test", renderTemplate: render,
    async resolveProviders(cfg) {
      const gen = (cfg.generator as { kind?: string } | undefined)?.kind === "stub" ? { generate: async (r: { prompt: string }) => ({ text: `gen:${r.prompt}`, model: "stub" }) } : null;
      return { decider: null, generator: gen, names: { decider: "none", generator: gen ? "stub" : "none", offline: false } };
    },
  };
  const d = new Daemon(host); await d.init();
  return d;
}

const card = (id: number, text: string, aspect?: string) => ({ id, cmd: "run-action" as const, action: "paste-card", input: { text, ...(aspect ? { aspect } : {}) } });
const metaOf = (r: Awaited<ReturnType<Daemon["handle"]>>) => (r.ok && r.cmd === "run-action" && r.result.output !== "text" ? r.result.meta ?? {} : null);
const pathOf = (r: Awaited<ReturnType<Daemon["handle"]>>) => (r.ok && r.cmd === "run-action" && r.result.output !== "text" ? r.result.path : "");

describe("precompose", () => {
  test("config: defaults, validation, visible characters", () => {
    expect(parsePrecomposeConfig(undefined)).toEqual({ outputs: [], useModel: false, skipSecrets: true, maxChars: 1200 });
    expect(parsePrecomposeConfig({ outputs: ["video", "image"] }).outputs).toEqual(["image", "video"]);
    expect(() => parsePrecomposeConfig({ outputs: ["png"] })).toThrow();
    expect(() => parsePrecomposeConfig({ maxChars: 0 })).toThrow();
    expect(visibleChars("a b\n👍🏽 中")).toBe(4);
  });

  test("skip reasons: off, empty, too-long, secret", async () => {
    const { render } = fakeRenderer();
    const d = await daemon(render);
    expect(await d.handle({ id: 1, cmd: "precompose", text: "hello" })).toEqual({ id: 1, ok: true, cmd: "precompose", queued: false, skipped: "off" });
    await d.handle({ id: 2, cmd: "config.set", precompose: { outputs: ["image"], maxChars: 5 } });
    expect(await d.handle({ id: 3, cmd: "precompose", text: "  \n " })).toMatchObject({ queued: false, skipped: "empty" });
    expect(await d.handle({ id: 4, cmd: "precompose", text: "一二三 四五六" })).toMatchObject({ queued: false, skipped: "too-long" });
    await d.handle({ id: 5, cmd: "config.set", precompose: { outputs: ["image"] } });
    const secret = "key sk-proj-FAKEfake0000FAKEfake1111FAKE";
    expect(await d.handle({ id: 6, cmd: "precompose", text: secret })).toMatchObject({ queued: false, skipped: "secret" });
    await d.handle({ id: 7, cmd: "config.set", precompose: { outputs: ["image"], skipSecrets: false } });
    expect(await d.handle({ id: 8, cmd: "precompose", text: secret })).toEqual({ id: 8, ok: true, cmd: "precompose", queued: true });
    expect(await d.handle({ id: 9, cmd: "precompose", text: "x", frames: { image: "2:1" } })).toMatchObject({ ok: false, kind: "usage" });
    await d.idle();
  });

  test("a hit returns meta.precomposed with no second render; a vanished file is a miss", async () => {
    const { calls, render } = fakeRenderer();
    const d = await daemon(render);
    await d.handle({ id: 1, cmd: "config.set", precompose: { outputs: ["image", "gif"] } });
    expect(await d.handle({ id: 2, cmd: "precompose", text: "少即是多。", frames: { image: "auto", gif: "1:1" } })).toMatchObject({ queued: true });
    await d.idle();
    expect(calls.map((c) => [c.format, c.lowPriority])).toEqual([["png", true], ["gif", true]]);
    const hit = await d.handle(card(3, "少即是多。"));
    expect(metaOf(hit)).toMatchObject({ precomposed: true, template: { aspect: "auto" } });
    const gif = await d.handle({ id: 4, cmd: "run-action", action: "paste-gif", input: { text: "少即是多。" } });
    expect(metaOf(gif)).toMatchObject({ precomposed: true });
    expect(calls.length).toBe(2);
    // Not precomposed: another text, another frame, an explicit template, "another take".
    for (const req of [card(5, "多即是少。"), card(6, "少即是多。", "16:9"), { ...card(7, "少即是多。"), input: { text: "少即是多。", template: { id: "document" as const } } }, { ...card(8, "少即是多。"), input: { text: "少即是多。", fresh: true } }]) {
      const r = await d.handle(req);
      expect(r.ok).toBe(true);
      expect(metaOf(r)!.precomposed).toBeUndefined();
    }
    expect(calls.length).toBe(6);
    await rm(pathOf(hit));
    expect(metaOf(await d.handle(card(9, "少即是多。")))!.precomposed).toBeUndefined();
  });

  test("the same text waits for its running precompose instead of rendering again", async () => {
    const { calls, render } = fakeRenderer();
    const d = await daemon(render);
    await d.handle({ id: 1, cmd: "config.set", precompose: { outputs: ["image"] } });
    await d.handle({ id: 2, cmd: "precompose", text: "WAIT for me" });
    await waitFor(() => calls.length === 1);
    const r = await d.handle(card(3, "WAIT for me"));
    expect(metaOf(r)).toMatchObject({ precomposed: true });
    expect(calls.length).toBe(1);
  });

  test("a different text cancels running work and kills the engine's process group", async () => {
    const hang = await hangingWork();
    const { calls, render } = fakeRenderer(hang);
    const d = await daemon(render);
    await d.handle({ id: 1, cmd: "config.set", precompose: { outputs: ["image"] } });
    await d.handle({ id: 2, cmd: "precompose", text: "SLOW text" });
    await waitFor(async () => { try { return Number(await readFile(join(hang, "grandchild.pid"), "utf8")) > 0; } catch { return false; } });
    const grandchild = Number(await readFile(join(hang, "grandchild.pid"), "utf8"));
    expect(alive(grandchild)).toBe(true);
    const started = performance.now();
    const r = await d.handle(card(3, "another text"));
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(r.ok).toBe(true);
    expect(metaOf(r)!.precomposed).toBeUndefined();
    expect(calls[0]).toMatchObject({ text: "SLOW text", aborted: true });
    await Bun.sleep(100);
    expect(alive(grandchild)).toBe(false);
    // The cancelled text was dropped, not resumed.
    await d.idle();
    expect(calls.length).toBe(2);
  }, 20_000);

  test("latest only: a new text replaces the running one", async () => {
    const hang = await hangingWork();
    const { calls, render } = fakeRenderer(hang);
    const d = await daemon(render);
    await d.handle({ id: 1, cmd: "config.set", precompose: { outputs: ["image"] } });
    await d.handle({ id: 2, cmd: "precompose", text: "SLOW one" });
    await waitFor(() => calls.length === 1);
    await d.handle({ id: 3, cmd: "precompose", text: "second" });
    await d.idle();
    expect(calls.map((c) => [c.text, c.aborted ?? false])).toEqual([["SLOW one", true], ["second", false]]);
    expect(metaOf(await d.handle(card(4, "second")))).toMatchObject({ precomposed: true });
  }, 20_000);

  test("config changes invalidate: privacy rules, precompose settings", async () => {
    const { calls, render } = fakeRenderer();
    const d = await daemon(render);
    await d.handle({ id: 1, cmd: "config.set", precompose: { outputs: ["image"] } });
    await d.handle({ id: 2, cmd: "precompose", text: "cache me" });
    await d.idle();
    expect(metaOf(await d.handle(card(3, "cache me")))).toMatchObject({ precomposed: true });
    await d.handle({ id: 4, cmd: "config.set", precompose: { outputs: ["image"] }, privacy: { builtins: { email: true } } });
    expect(metaOf(await d.handle(card(5, "cache me")))!.precomposed).toBeUndefined();
    await d.handle({ id: 6, cmd: "precompose", text: "cache me" });
    await d.idle();
    await d.handle({ id: 7, cmd: "config.set", precompose: { outputs: ["image"], maxChars: 900 }, privacy: { builtins: { email: true } } });
    expect(metaOf(await d.handle(card(8, "cache me")))!.precomposed).toBeUndefined();
    expect(calls.length).toBe(4);
  });

  test("alsoInOutput rules change what render actions draw, not text actions", async () => {
    const { calls, render } = fakeRenderer();
    const d = await daemon(render);
    await d.handle({ id: 1, cmd: "config.set", generator: { kind: "stub" }, privacy: { rules: [{ id: "a", name: "代号", match: "text", pattern: "Aurora", replacement: "某项目", alsoInOutput: true }, { id: "b", name: "人名", match: "text", pattern: "Zhang", replacement: "某人" }] } });
    await d.handle(card(2, "Aurora by Zhang"));
    expect(calls[0]!.text).toBe("某项目 by Zhang");
    const summary = await d.handle({ id: 3, cmd: "run-action", action: "paste-summary", input: { text: "Aurora by Zhang" } });
    expect(summary.ok && summary.cmd === "run-action" && summary.result.output === "text" && summary.result.text).toContain("Aurora by Zhang");
    await d.handle({ id: 4, cmd: "config.set", privacy: { rules: [{ id: "a", name: "代号", match: "text", pattern: "Aurora", replacement: "某项目", alsoInOutput: true }] }, precompose: { outputs: ["image"] } });
    await d.handle({ id: 5, cmd: "precompose", text: "Aurora rises" });
    await d.idle();
    expect(calls.at(-1)!.text).toBe("某项目 rises");
  });
});

describe("runEngine cancellation", () => {
  test("aborting kills the whole process group; an aborted signal never starts", async () => {
    const work = await hangingWork();
    const abort = new AbortController();
    const run = runEngine(work, ["render", "compositions/paste"], {}, { signal: abort.signal, lowPriority: true });
    await waitFor(async () => { try { return Number(await readFile(join(work, "grandchild.pid"), "utf8")) > 0; } catch { return false; } });
    const grandchild = Number(await readFile(join(work, "grandchild.pid"), "utf8"));
    abort.abort();
    await expect(run).rejects.toBeInstanceOf(EngineAbortedError);
    await Bun.sleep(100);
    expect(alive(grandchild)).toBe(false);
    await expect(runEngine(work, ["build"], {}, { signal: abort.signal })).rejects.toBeInstanceOf(EngineAbortedError);
  }, 20_000);
});
