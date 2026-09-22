import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, parseRequest, type DaemonHost } from "../src/daemon/server.ts";
import type { TaskEvent } from "../src/daemon/protocol.ts";

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

  test("task events are opt-in, content-free, and preserve the final response", async () => {
    const d = new Daemon(await host()); await d.init();
    await d.handle({ id: 1, cmd: "config.set", generator: { kind: "stub" } });
    const events: TaskEvent[] = [];
    const request = { id: 2, cmd: "run-action" as const, action: "paste-summary", input: { text: "synthetic private content" } };
    const legacy = await d.handle(request, (event) => events.push(event));
    expect(events).toEqual([]);
    const response = await d.handle({ ...request, events: true }, (event) => events.push(event));
    expect(response).toMatchObject({ id: 2, cmd: "run-action", ok: true });
    expect(legacy.ok && response.ok && legacy.cmd === "run-action" && response.cmd === "run-action" && legacy.result.output === "text" && response.result.output === "text" && legacy.result.text === response.result.text).toBe(true);
    expect(events).toEqual((["accepted", "running", "completed"] as const).map((state) => ({ id: 2, cmd: "run-action", event: "task", state })));
    expect(JSON.stringify(events)).not.toContain("synthetic private content");
    events.length = 0;
    const failure = await d.handle({ ...request, action: "missing-action", events: true }, (event) => events.push(event));
    expect(failure).toMatchObject({ id: 2, ok: false, kind: "action:spec" });
    expect(events.map((event) => event.state)).toEqual(["accepted", "running", "failed"]);
  });

  test("render failures emit terminal lifecycle without changing their error", async () => {
    const d = new Daemon(await host()); await d.init();
    const events: TaskEvent[] = [];
    expect(await d.handle({ id: 9, cmd: "render", dsl: {} as never, events: true }, (event) => events.push(event)))
      .toMatchObject({ id: 9, ok: false, kind: "engine" });
    expect(events.map((event) => [event.cmd, event.state])).toEqual([
      ["render", "accepted"], ["render", "running"], ["render", "failed"],
    ]);
  });

  test("daemon does not idle-exit during a slow request, then exits when idle", async () => {
    const appData = await mkdtemp(join(tmpdir(), "paste-daemon-idle-"));
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch() {
        await Bun.sleep(450);
        return Response.json({ choices: [{ message: { content: "synthetic delayed summary" } }], model: "fixture" });
      },
    });
    const process = Bun.spawn([Bun.which("bun") ?? "bun", join(import.meta.dir, "../src/daemon.ts"), "--app-data", appData, "--idle-minutes", "0.002"], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...Bun.env, POCKET_ENGINE: join(appData, "missing-engine"), PASTE_REEXEC: "1" },
    });
    try {
      process.stdin.write([
        { id: 1, cmd: "config.set", decider: { kind: "rules" }, generator: { kind: "openai-compatible", baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "fixture" }, offline: false },
        { id: 2, cmd: "run-action", action: "paste-summary", input: { text: "synthetic request" }, events: true },
      ].map((request) => JSON.stringify(request) + "\n").join(""));
      // Keep stdin open: process termination must come from the *post-task*
      // idle deadline, not EOF or an explicit shutdown request.
      const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
      expect(code).toBe(0);
      const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
      expect(lines.find((line) => line.id === 2 && line.ok === true)).toMatchObject({ cmd: "run-action", result: { text: "synthetic delayed summary" } });
      expect(lines.filter((line) => line.event === "task").map((line) => line.state)).toEqual(["accepted", "running", "completed"]);
      expect(stderr).toContain("daemon: idle, exiting");
    } finally {
      if (process.exitCode === null) process.kill();
      server.stop(true);
      await rm(appData, { recursive: true, force: true });
    }
  }, 10_000);
});
