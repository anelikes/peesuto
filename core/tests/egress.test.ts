import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { egress, egressLogPath, isLocalHost, isOffline, setEgressLog, setOffline, type EgressLogLine } from "../src/provider/egress.ts";
import { ProviderConfigError, ProviderError } from "../src/provider/types.ts";

let server: ReturnType<typeof Bun.serve>;
let hits = 0;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      hits++;
      const path = new URL(req.url).pathname;
      if (path === "/slow") { await Bun.sleep(400); return Response.json({ late: true }); }
      if (path === "/text") return new Response("plain text", { status: 200 });
      return Response.json({ method: req.method, got: await req.text() });
    },
  });
});
afterAll(() => server.stop(true));
afterEach(() => { setOffline(false); setEgressLog(null); });

const url = (path = "/") => `http://127.0.0.1:${server.port}${path}`;
const EGRESS = join(import.meta.dir, "../src/provider/egress.ts");

/** The ProviderError code a promise rejects with, or "resolved". */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) {
    if (e instanceof ProviderError) return e.code;
    throw e;
  }
  return "resolved";
}

async function lines(file: string): Promise<EgressLogLine[]> {
  return (await readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as EgressLogLine);
}

describe("offline mode", () => {
  test("refuses every request before it is made, local ones included", async () => {
    setOffline(true);
    expect(isOffline()).toBe(true);
    const before = hits;
    let err: unknown;
    try { await egress.post(url(), { hello: 1 }, { purpose: "test:post" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("offline");
    expect((err as ProviderError).message).toContain("test:post");
    expect(await codeOf(egress.get(url(), { purpose: "test:get" }))).toBe("offline");
    expect(hits).toBe(before);
    setOffline(false);
    expect((await egress.post(url(), { hello: 1 }, { purpose: "test:post" })).status).toBe(200);
    expect(hits).toBe(before + 1);
  });

  test("starts from PASTE_OFFLINE in the environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-egress-"));
    const probe = join(dir, "probe.ts");
    await Bun.write(probe, `import { isOffline } from ${JSON.stringify(EGRESS)};\nconsole.log(isOffline());\n`);
    const run = (env: Record<string, string | undefined>) => Bun.spawnSync([process.execPath, probe], { env: { ...process.env, PASTE_OFFLINE: undefined, ...env } }).stdout.toString().trim();
    expect(run({ PASTE_OFFLINE: "1" })).toBe("true");
    expect(run({ PASTE_OFFLINE: "0" })).toBe("false");
    expect(run({})).toBe("false");
  });
});

describe("destination log", () => {
  test("is off by default", () => expect(egressLogPath()).toBeNull());

  test("writes one line per request with host, purpose, sizes, status and timing — never the body or a header", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-egress-"));
    const file = join(dir, "logs", "egress.log");
    setEgressLog(file);
    const body = { clipboard: "SENTINEL-BODY-7f3a", n: 1 };
    const r = await egress.post(url("/ask"), body, { headers: { authorization: "Bearer SENTINEL-HEADER-9c1d" }, purpose: "decider:test" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ method: "POST", got: JSON.stringify(body) });
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("SENTINEL-BODY");
    expect(raw).not.toContain("SENTINEL-HEADER");
    expect(raw).not.toContain("/ask");
    const [line, ...rest] = await lines(file);
    expect(rest).toEqual([]);
    expect(Object.keys(line!).sort()).toEqual(["at", "bytesIn", "bytesOut", "host", "local", "ms", "purpose", "status"]);
    expect(Number.isNaN(Date.parse(line!.at))).toBe(false);
    expect(line!.host).toBe(`127.0.0.1:${server.port}`);
    expect(line!.local).toBe(true);
    expect(line!.purpose).toBe("decider:test");
    expect(line!.bytesOut).toBe(Buffer.byteLength(JSON.stringify(body)));
    expect(line!.bytesIn).toBe(Buffer.byteLength(r.text));
    expect(line!.status).toBe(200);
    expect(line!.ms).toBeGreaterThanOrEqual(0);
  });

  test("a GET has bytesOut 0; a non-JSON body comes back as text and {error}", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-egress-"));
    const file = join(dir, "egress.log");
    setEgressLog(file);
    const r = await egress.get(url("/text"), { purpose: "test:get" });
    expect(r).toEqual({ status: 200, text: "plain text", json: { error: "plain text" } });
    const [line] = await lines(file);
    expect(line!.bytesOut).toBe(0);
    expect(line!.bytesIn).toBe(10);
  });

  test("a timeout is ProviderError(timeout) and is logged with status 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-egress-"));
    const file = join(dir, "egress.log");
    setEgressLog(file);
    const t0 = performance.now();
    expect(await codeOf(egress.post(url("/slow"), {}, { timeoutMs: 50, purpose: "test:slow" }))).toBe("timeout");
    expect(performance.now() - t0).toBeLessThan(350);
    const [line] = await lines(file);
    expect(line).toMatchObject({ purpose: "test:slow", status: 0, bytesIn: 0, error: "timeout", local: true });
  });

  test("a closed port is ProviderError(network) and is logged too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-egress-"));
    const file = join(dir, "egress.log");
    setEgressLog(file);
    expect(await codeOf(egress.post("http://127.0.0.1:1/", {}, { purpose: "test:refused" }))).toBe("network");
    const [line] = await lines(file);
    expect(line).toMatchObject({ host: "127.0.0.1:1", status: 0, error: "network" });
  });

  test("not a URL is a config error, and nothing is logged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-egress-"));
    const file = join(dir, "egress.log");
    setEgressLog(file);
    await expect(egress.post("not a url", {}, { purpose: "test:bad" })).rejects.toBeInstanceOf(ProviderConfigError);
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });
});

describe("isLocalHost", () => {
  test("knows the loopback names and nothing else", () => {
    for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "[::1]", "::1", "0.0.0.0", "ollama.localhost"]) expect(isLocalHost(h)).toBe(true);
    for (const h of ["api.cloudflare.com", "api.anthropic.com", "localhost.example.com", "10.0.0.1", "127.0.0.1.nip.io"]) expect(isLocalHost(h)).toBe(false);
  });
});
