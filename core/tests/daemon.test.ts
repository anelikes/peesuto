import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, parseRequest, type DaemonHost } from "../src/daemon/server.ts";

const host = async (): Promise<DaemonHost> => ({
  version: "test", appData: await mkdtemp(join(tmpdir(), "paste-daemon-")), engine: null,
  async resolveProviders(cfg) {
    const gen = (cfg.generator as { kind?: string } | undefined)?.kind === "stub"
      ? { generate: async (r: { prompt: string }) => ({ text: `gen:${r.prompt}`, model: "stub" }) } : null;
    return { decider: null, generator: gen, names: { decider: "none", generator: gen ? "stub" : "none", offline: !!cfg.offline } };
  },
});

describe("daemon", () => {
  test("health, actions.list, none action, unknown action, unknown cmd", async () => {
    const d = new Daemon(await host()); await d.init();
    expect(await d.handle({ id: 1, cmd: "health" })).toMatchObject({ id: 1, ok: true, engine: null, providers: { decider: "none", generator: "none" } });
    const list = await d.handle({ id: 2, cmd: "actions.list" });
    expect(list.ok && list.cmd === "actions.list" && list.actions.map((a) => a.id)).toContain("paste-card");
    const run = await d.handle({ id: 3, cmd: "run-action", action: "paste-translate", input: { text: "hi" } });
    expect(run).toMatchObject({ id: 3, ok: false, kind: "action:needs" });
    expect(await d.handle({ id: 4, cmd: "run-action", action: "nope", input: { text: "hi" } })).toMatchObject({ ok: false, kind: "action:spec" });
    expect(await d.handle({ id: 5, cmd: "bogus" } as never)).toMatchObject({ ok: false, kind: "usage" });
    expect(await d.handle({ id: 6, cmd: "render", dsl: {} as never })).toMatchObject({ ok: false, kind: "engine" });
  });
  test("config.set swaps providers; a generator action then runs", async () => {
    const d = new Daemon(await host()); await d.init();
    expect(await d.handle({ id: 1, cmd: "config.set", generator: { kind: "stub" }, offline: true })).toMatchObject({ ok: true, providers: { generator: "stub", offline: true } });
    const run = await d.handle({ id: 2, cmd: "run-action", action: "paste-summary", input: { text: "long text" } });
    expect(run.ok && run.cmd === "run-action" && run.result.output === "text" && run.result.text.startsWith("gen:")).toBe(true);
  });
  test("pick without a decider falls back to the heuristic", async () => {
    const d = new Daemon(await host()); await d.init();
    const now = Date.now();
    const r = await d.handle({ id: 1, cmd: "pick", context: { level: 1, appBundleId: "com.apple.Notes", role: "AXTextArea" }, candidates: [
      { id: "a", kind: "text", text: "old", preview: "old", createdAt: now - 3_600_000 },
      { id: "b", kind: "text", text: "new", preview: "new", createdAt: now - 1000 },
    ] });
    expect(r.ok && r.cmd === "pick" && r.result.source).toBe("heuristic");
    expect(r.ok && r.cmd === "pick" && r.result.ranked[0]?.item.id).toBe("b");
  });
  test("parseRequest rejects malformed lines with id -1", () => {
    expect(parseRequest("{")).toMatchObject({ id: -1, ok: false, kind: "usage" });
    expect(parseRequest('{"cmd":"health"}')).toMatchObject({ id: -1, ok: false });
    expect(parseRequest('{"id":7,"cmd":"health"}')).toMatchObject({ id: 7, cmd: "health" });
  });
});
