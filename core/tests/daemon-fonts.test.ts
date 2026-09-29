/**
 * The daemon's font pack commands (fonts.status, fonts.install, fonts.cancel,
 * fonts.remove) against a loopback server: install answers at once and the
 * download runs in the background while other requests are served, progress
 * and the last failure in fonts.status, errors known up front, cancel and
 * resume, remove, offline mode and shutdown stopping a download, and a
 * spawned daemon that does not idle out while a download runs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, errorOf, parseRequest, type DaemonHost } from "../src/daemon/server.ts";
import { ERROR_KINDS, type FontPackState, type Response as DaemonResponse } from "../src/daemon/protocol.ts";
import { FontPackError, fontPacksRoot, jizuraPackManifest, parseManifest, type JizuraPackManifest } from "../src/fonts/jizura-packs.ts";
import { writeTar } from "../src/fonts/tar.ts";
import { setOffline } from "../src/provider/egress.ts";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (n: number, seed: number) => new Uint8Array(n).map((_, i) => (i * 31 + seed * 7) % 256);
const font = bytes(300_000, 3), lic = new TextEncoder().encode("SIL Open Font License 1.1\n");
const tarJa = writeTar([{ name: "SansJP-Black.woff2", data: font }, { name: "OFL.txt", data: lic }]);
const entry = (name: string, data: Uint8Array) => ({ file: name, bytes: data.length, sha256: sha(data) });
const manifest: JizuraPackManifest = parseManifest({
  formatVersion: 1, baseUrl: "https://packs.example.invalid/",
  bundled: { title: { en: "Base", zh: "基础", ja: "基本" }, families: [], licenses: [] },
  packs: [{ id: "ja", title: { en: "Japanese", zh: "日文", ja: "日本語" }, langs: ["ja"], file: "ja.tar", bytes: tarJa.length, sha256: sha(tarJa),
    families: [{ family: "Noto Sans JP", weight: 900, style: "normal", ...entry("SansJP-Black.woff2", font) }], licenses: [entry("OFL.txt", lic)] }],
});
const partPath = (appData: string) => join(fontPacksRoot(appData), ".partial", `ja@${sha(tarJa).slice(0, 12)}.tar.part`);

// ── the server: /ja.tar with Range; "slow" sends 64 KB, then holds until released ──
type Mode = "ok" | "slow" | "404";
let mode: Mode = "ok";
const hits: { path: string; range: string | null }[] = [];
let server: ReturnType<typeof Bun.serve>;
let base = "";
let release: (() => void) | null = null;
beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      const url = new URL(req.url);
      hits.push({ path: url.pathname, range: req.headers.get("range") });
      if (mode === "404" || url.pathname !== "/ja.tar") return new Response("no", { status: 404 });
      const range = /^bytes=(\d+)-$/.exec(req.headers.get("range") ?? "");
      const from = range ? Number(range[1]) : 0;
      const part = tarJa.slice(from);
      const headers: Record<string, string> = range ? { "content-range": `bytes ${from}-${tarJa.length - 1}/${tarJa.length}` } : {};
      if (mode !== "slow") return new Response(part, { status: range ? 206 : 200, headers });
      const stream = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(part.slice(0, 65_536));
          await new Promise<void>((r) => { release = r; });
          c.enqueue(part.slice(65_536));
          c.close();
        },
      });
      return new Response(stream, { status: range ? 206 : 200, headers });
    },
  });
  base = `http://127.0.0.1:${server.port}/`;
});
afterAll(() => server.stop(true));
afterEach(() => { mode = "ok"; hits.length = 0; release?.(); release = null; setOffline(false); });

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });
async function daemon(o: { baseUrl?: string | null } = {}): Promise<{ d: Daemon; appData: string }> {
  const appData = await mkdtemp(join(tmpdir(), "daemon-fonts-"));
  dirs.push(appData);
  const host: DaemonHost = {
    version: "test", appData, engine: null,
    async resolveProviders(cfg) { return { decider: null, generator: null, names: { decider: "none", generator: "none", offline: !!cfg.offline } }; },
    fontPacks: { manifest, ...(o.baseUrl === null ? {} : { baseUrl: o.baseUrl ?? base }) },
  };
  const d = new Daemon(host);
  await d.init();
  return { d, appData };
}
const until = async (f: () => boolean | Promise<boolean>) => { for (let i = 0; i < 300 && !(await f()); i++) await Bun.sleep(10); };
async function status(d: Daemon): Promise<{ offline: boolean; packs: FontPackState[] }> {
  const r = await d.handle({ id: 99, cmd: "fonts.status" });
  if (!r.ok || r.cmd !== "fonts.status") throw new Error(JSON.stringify(r));
  return r;
}
const ja = async (d: Daemon) => (await status(d)).packs.find((p) => p.id === "ja")!;

describe("daemon: font packs", () => {
  test("fonts.status: the base set first, then every pack, and offline mode", async () => {
    const { d } = await daemon();
    const s = await status(d);
    expect(s.offline).toBe(false);
    expect(s.packs.map((p) => [p.id, p.bundled, p.installed, p.installing])).toEqual([["base", true, true, false], ["ja", false, false, false]]);
    expect(s.packs[1]).toEqual({ id: "ja", title: { en: "Japanese", zh: "日文", ja: "日本語" }, bytes: tarJa.length, installed: false, bundled: false, installing: false, langs: ["ja"], families: ["Noto Sans JP"] });
    setOffline(true);
    expect((await status(d)).offline).toBe(true);
    expect(hits).toEqual([]);
  });

  test("fonts.install answers at once; the download runs in the background while other requests are served", async () => {
    const { d, appData } = await daemon();
    mode = "slow";
    expect(await d.handle({ id: 1, cmd: "fonts.install", pack: "ja" })).toEqual({ id: 1, ok: true, cmd: "fonts.install", started: true });
    await until(() => release !== null);
    expect(d.busy()).toBe(true);                        // the idle timer waits for it
    expect(await d.handle({ id: 2, cmd: "health" })).toMatchObject({ id: 2, ok: true, cmd: "health" });
    await until(async () => (await ja(d)).progress?.done === 65_536);
    expect(await ja(d)).toMatchObject({ installed: false, installing: true, progress: { done: 65_536, total: tarJa.length } });
    // asking again while it runs joins it
    expect(await d.handle({ id: 3, cmd: "fonts.install", pack: "ja" })).toMatchObject({ ok: true, started: true });
    release!();
    await d.fontsIdle();
    const done = await ja(d);
    expect(done).toMatchObject({ installed: true, installing: false });
    expect(done.progress).toBeUndefined();
    expect(done.error).toBeUndefined();
    expect(d.busy()).toBe(false);
    expect(hits.length).toBe(1);
    expect(existsSync(join(fontPacksRoot(appData), `ja@${sha(tarJa).slice(0, 12)}`, "SansJP-Black.woff2"))).toBe(true);
    // installed and intact: nothing to start
    expect(await d.handle({ id: 4, cmd: "fonts.install", pack: "ja" })).toEqual({ id: 4, ok: true, cmd: "fonts.install", started: false });
    expect(hits.length).toBe(1);
  });

  test("errors known up front come back as kind fonts, before anything is sent", async () => {
    const { d } = await daemon();
    expect(await d.handle({ id: 1, cmd: "fonts.install", pack: "fr" })).toMatchObject({ id: 1, ok: false, cmd: "fonts.install", kind: "fonts", code: "unknown-pack" });
    expect(await d.handle({ id: 2, cmd: "fonts.install", pack: "base" })).toMatchObject({ ok: false, kind: "fonts", code: "bundled" });
    setOffline(true);
    expect(await d.handle({ id: 3, cmd: "fonts.install", pack: "ja" })).toMatchObject({ ok: false, kind: "fonts", code: "offline" });
    setOffline(false);
    const { d: noHost } = await daemon({ baseUrl: null });
    expect(await noHost.handle({ id: 4, cmd: "fonts.install", pack: "ja" })).toMatchObject({ ok: false, kind: "fonts", code: "unconfigured" });
    const { d: plain } = await daemon({ baseUrl: "http://example.com/packs/" });
    expect(await plain.handle({ id: 5, cmd: "fonts.install", pack: "ja" })).toMatchObject({ ok: false, kind: "fonts", code: "insecure" });
    expect(await d.handle({ id: 6, cmd: "fonts.install" } as never)).toMatchObject({ ok: false, kind: "usage" });
    expect(await d.handle({ id: 7, cmd: "fonts.cancel", pack: "fr" })).toMatchObject({ ok: false, kind: "fonts", code: "unknown-pack" });
    expect(await d.handle({ id: 8, cmd: "fonts.remove", pack: "base" })).toMatchObject({ ok: false, kind: "fonts", code: "bundled" });
    expect(hits).toEqual([]);
    expect((await ja(d)).error).toBeUndefined();        // nothing started, nothing failed
  });

  test("a download that fails is fonts.status's error until the next one starts", async () => {
    const { d } = await daemon();
    mode = "404";
    expect(await d.handle({ id: 1, cmd: "fonts.install", pack: "ja" })).toMatchObject({ ok: true, started: true });
    await d.fontsIdle();
    const failed = await ja(d);
    expect(failed).toMatchObject({ installed: false, installing: false, error: { code: "http" } });
    expect(failed.error!.message).toContain("404");
    mode = "slow";
    await d.handle({ id: 2, cmd: "fonts.install", pack: "ja" });
    await until(() => release !== null);
    expect((await ja(d)).error).toBeUndefined();        // cleared when the next one starts
    release!();
    await d.fontsIdle();
    expect(await ja(d)).toMatchObject({ installed: true });
  });

  test("fonts.cancel stops the download (not a failure) and keeps what came; the next install resumes it", async () => {
    const { d, appData } = await daemon();
    mode = "slow";
    await d.handle({ id: 1, cmd: "fonts.install", pack: "ja" });
    await until(async () => (await ja(d)).progress?.done === 65_536);
    expect(await d.handle({ id: 2, cmd: "fonts.cancel", pack: "ja" })).toEqual({ id: 2, ok: true, cmd: "fonts.cancel", cancelled: true });
    const after = await ja(d);
    expect(after).toMatchObject({ installed: false, installing: false });
    expect(after.error).toBeUndefined();
    expect(after.progress).toBeUndefined();
    expect(d.busy()).toBe(false);
    expect(readFileSync(partPath(appData)).length).toBe(65_536);
    expect(await d.handle({ id: 3, cmd: "fonts.cancel", pack: "ja" })).toMatchObject({ ok: true, cancelled: false });
    mode = "ok";
    expect(await d.handle({ id: 4, cmd: "fonts.install", pack: "ja" })).toMatchObject({ ok: true, started: true });
    await d.fontsIdle();
    expect(await ja(d)).toMatchObject({ installed: true });
    expect(hits.at(-1)!.range).toBe("bytes=65536-");
  });

  test("fonts.remove deletes an installed pack, and stops one being downloaded", async () => {
    const { d, appData } = await daemon();
    await d.handle({ id: 1, cmd: "fonts.install", pack: "ja" });
    await d.fontsIdle();
    expect(await d.handle({ id: 2, cmd: "fonts.remove", pack: "ja" })).toEqual({ id: 2, ok: true, cmd: "fonts.remove", removed: true });
    expect(await ja(d)).toMatchObject({ installed: false });
    expect(await d.handle({ id: 3, cmd: "fonts.remove", pack: "ja" })).toMatchObject({ ok: true, removed: false });
    mode = "slow";
    await d.handle({ id: 4, cmd: "fonts.install", pack: "ja" });
    await until(() => release !== null);
    expect(await d.handle({ id: 5, cmd: "fonts.remove", pack: "ja" })).toMatchObject({ ok: true, removed: false });
    const s = await ja(d);
    expect(s).toMatchObject({ installed: false, installing: false });
    expect(s.error).toBeUndefined();
    expect(existsSync(partPath(appData))).toBe(false);
  });

  test("turning offline mode on stops a download (error offline); shutdown stops one too", async () => {
    const { d } = await daemon();
    mode = "slow";
    await d.handle({ id: 1, cmd: "fonts.install", pack: "ja" });
    await until(() => release !== null);
    expect(await d.handle({ id: 2, cmd: "config.set", offline: true })).toMatchObject({ ok: true, providers: { offline: true } });
    expect(await ja(d)).toMatchObject({ installing: false, error: { code: "offline" } });
    release = null;
    await d.handle({ id: 3, cmd: "config.set", offline: false });
    await d.handle({ id: 4, cmd: "fonts.install", pack: "ja" });
    await until(() => release !== null);
    expect(d.busy()).toBe(true);
    expect(await d.handle({ id: 5, cmd: "shutdown" })).toMatchObject({ ok: true, cmd: "shutdown" });
    expect(d.busy()).toBe(false);
    expect((await ja(d)).error).toBeUndefined();
  });

  test("fonts.* are known commands; a FontPackError maps to kind fonts with its code", () => {
    for (const cmd of ["fonts.status", "fonts.install", "fonts.cancel", "fonts.remove"]) expect(parseRequest(JSON.stringify({ id: 1, cmd, pack: "ja" }))).toMatchObject({ id: 1, cmd });
    expect(errorOf(new FontPackError("sha256", "bad"))).toEqual({ kind: "fonts", code: "sha256", message: "bad" });
    expect(ERROR_KINDS).toContain("fonts");
  });
});

test("a spawned daemon answers while a download runs and does not idle out during it, then exits when idle", async () => {
  const appData = await mkdtemp(join(tmpdir(), "daemon-fonts-idle-"));
  dirs.push(appData);
  const pack = jizuraPackManifest().packs.find((p) => p.id === "ja")!;
  let letGo: () => void = () => {};
  const held = new Promise<void>((r) => { letGo = r; });
  const paths: string[] = [];
  // the committed manifest's ja pack, cut short: 100 000 bytes, then nothing until let go, then the end
  const slow = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      paths.push(new URL(req.url).pathname);
      return new Response(new ReadableStream<Uint8Array>({ async start(c) { c.enqueue(new Uint8Array(100_000)); await held; c.close(); } }));
    },
  });
  const proc = Bun.spawn([Bun.which("bun") ?? "bun", join(import.meta.dir, "../src/daemon.ts"), "--app-data", appData, "--idle-minutes", "0.002"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...Bun.env, POCKET_ENGINE: join(appData, "missing-engine"), PASTE_REEXEC: "1", PEESUTO_FONT_PACKS_URL: `http://127.0.0.1:${slow.port}/` },
  });
  const lines: DaemonResponse[] = [];
  const stderr = new Response(proc.stderr).text();
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); }
    }
  })();
  const send = (o: object) => { proc.stdin.write(JSON.stringify(o) + "\n"); proc.stdin.flush(); };
  const answer = async (id: number) => { await until(() => lines.some((l) => l.id === id)); return lines.find((l) => l.id === id)!; };
  const jaOf = (r: DaemonResponse) => (r.ok && r.cmd === "fonts.status" ? r.packs.find((p) => p.id === "ja") : undefined);
  try {
    send({ id: 1, cmd: "fonts.install", pack: "ja" });
    expect(await answer(1)).toMatchObject({ ok: true, cmd: "fonts.install", started: true });
    let n = 2;
    for (;;) {                                           // until the first 100 000 bytes are in
      send({ id: n, cmd: "fonts.status" });
      const p = jaOf(await answer(n++));
      if (p?.progress?.done === 100_000) { expect(p).toMatchObject({ installing: true, progress: { total: pack.bytes } }); break; }
      await Bun.sleep(20);
    }
    await Bun.sleep(500);                                // four idle timeouts (120 ms) go by
    expect(proc.exitCode).toBeNull();
    send({ id: 100, cmd: "fonts.status" });
    expect(jaOf(await answer(100))).toMatchObject({ installing: true });
    letGo();                                             // the download ends short and fails; the daemon is idle again
    expect(await proc.exited).toBe(0);
    expect(await stderr).toContain("daemon: idle, exiting");
    expect(paths).toEqual([`/${pack.file}`]);
    const log = readFileSync(join(appData, "egress.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log).toEqual([expect.objectContaining({ host: `127.0.0.1:${slow.port}`, purpose: "fonts:ja", bytesIn: 100_000, status: 200, local: true })]);
  } finally {
    letGo();
    if (proc.exitCode === null) proc.kill();
    slow.stop(true);
  }
}, 20_000);
