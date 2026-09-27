/**
 * Font-pack downloads against a local Bun server (plain HTTP is allowed for
 * loopback hosts only): success, bad hash, truncation and resume, abort,
 * shared downloads, atomic install and repair, removal, offline mode, and
 * the HTTPS rule.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CJK_RANGES, ensureJizuraFonts, FontPackError, fontPackStatus, fontPacksRoot, installFontPack, jizuraFontFiles, parseManifest,
  removeFontPack, type JizuraPackManifest,
} from "../src/fonts/jizura-packs.ts";
import { writeTar } from "../src/fonts/tar.ts";
import { setEgressLog, setOffline } from "../src/provider/egress.ts";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (n: number, seed: number) => new Uint8Array(n).map((_, i) => (i * 31 + seed * 7) % 256);

// Two packs of made-up "fonts" (installation never parses them).
const fontA = bytes(300_000, 1), fontB = bytes(120_000, 2), lic = new TextEncoder().encode("SIL Open Font License 1.1\n");
const tarJa = writeTar([{ name: "SansJP-Black.woff2", data: fontA }, { name: "OFL.txt", data: lic }]);
const tarKo = writeTar([{ name: "SansKR-Black.woff2", data: fontB }, { name: "OFL.txt", data: lic }]);
const fileEntry = (name: string, data: Uint8Array) => ({ file: name, bytes: data.length, sha256: sha(data) });

function manifestWith(o: { jaSha?: string; jaBytes?: number } = {}): JizuraPackManifest {
  return parseManifest({
    formatVersion: 1, baseUrl: "https://packs.example.invalid/",
    bundled: { title: { en: "b", zh: "b", ja: "b" }, families: [], licenses: [] },
    packs: [
      { id: "ja", title: { en: "ja", zh: "ja", ja: "ja" }, langs: ["ja"], file: "ja.tar", bytes: o.jaBytes ?? tarJa.length, sha256: o.jaSha ?? sha(tarJa),
        families: [{ family: "Noto Sans JP", weight: 900, style: "normal", ...fileEntry("SansJP-Black.woff2", fontA) }], licenses: [fileEntry("OFL.txt", lic)] },
      { id: "ko", title: { en: "ko", zh: "ko", ja: "ko" }, langs: ["ko"], file: "ko.tar", bytes: tarKo.length, sha256: sha(tarKo),
        families: [{ family: "Noto Sans KR", weight: 900, style: "normal", ...fileEntry("SansKR-Black.woff2", fontB) }], licenses: [fileEntry("OFL.txt", lic)] },
    ],
  });
}
const manifest = manifestWith();

// ── the server: serves /ja.tar and /ko.tar with Range support; behaviour switchable per test ──
type Mode = "ok" | "truncate" | "slow" | "corrupt" | "redirect" | "redirect-insecure" | "404";
let mode: Mode = "ok";
const hits: { path: string; range: string | null; ua: string | null; cookie: string | null }[] = [];
let server: ReturnType<typeof Bun.serve>;
let base = "";
let release: (() => void) | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      hits.push({ path: url.pathname, range: req.headers.get("range"), ua: req.headers.get("user-agent"), cookie: req.headers.get("cookie") });
      if (mode === "404") return new Response("no", { status: 404 });
      if (mode === "redirect" && !url.pathname.startsWith("/moved/")) return Response.redirect(`${base}moved${url.pathname}`, 302);
      if (mode === "redirect-insecure") return Response.redirect(`http://example.com${url.pathname}`, 302);
      const path = url.pathname.replace(/^\/moved/, "");
      let body = path === "/ja.tar" ? tarJa : path === "/ko.tar" ? tarKo : null;
      if (!body) return new Response("no", { status: 404 });
      if (mode === "corrupt") { body = body.slice(); body[700] = body[700]! ^ 0xff; }
      if (mode === "truncate") return new Response(body.slice(0, 100_000));
      const range = /^bytes=(\d+)-$/.exec(req.headers.get("range") ?? "");
      const from = range ? Number(range[1]) : 0;
      const part = body.slice(from);
      const headers: Record<string, string> = range ? { "content-range": `bytes ${from}-${body.length - 1}/${body.length}` } : {};
      if (mode === "slow") {
        // first 64 KB at once, then hold until the test lets go (or the client leaves)
        const stream = new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(part.slice(0, 65_536));
            await new Promise<void>((r) => { release = r; });
            c.enqueue(part.slice(65_536));
            c.close();
          },
        });
        return new Response(stream, { status: range ? 206 : 200, headers });
      }
      return new Response(part, { status: range ? 206 : 200, headers });
    },
  });
  base = `http://127.0.0.1:${server.port}/`;
});
afterAll(() => server.stop(true));
afterEach(() => { mode = "ok"; hits.length = 0; release?.(); release = null; setOffline(false); setEgressLog(null); });

const dataDirs: string[] = [];
async function dataDir() { const d = await mkdtemp(join(tmpdir(), "font-dl-")); dataDirs.push(d); return d; }
afterAll(async () => { for (const d of dataDirs) await rm(d, { recursive: true, force: true }); });
const opts = async () => ({ dataDir: await dataDir(), manifest, baseUrl: base });
const code = async (p: Promise<unknown>) => { try { await p; return "resolved"; } catch (e) { return e instanceof FontPackError ? e.code : String(e); } };
const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await Bun.sleep(10); };

describe("font packs: download", () => {
  test("downloads, verifies and installs a pack; reports progress; logs the request, sends nothing else", async () => {
    const o = await opts();
    const log = join(o.dataDir, "egress.log");
    setEgressLog(log);
    const seen: [number, number][] = [];
    const r = await installFontPack("ja", { ...o, onProgress: (d, t) => seen.push([d, t]) });
    expect(r.downloaded).toBe(true);
    expect(r.dir).toBe(join(fontPacksRoot(o.dataDir), `ja@${sha(tarJa).slice(0, 12)}`));
    expect(sha(readFileSync(join(r.dir, "SansJP-Black.woff2")))).toBe(sha(fontA));
    expect(seen.at(-1)).toEqual([tarJa.length, tarJa.length]);
    for (let i = 1; i < seen.length; i++) expect(seen[i]![0]).toBeGreaterThanOrEqual(seen[i - 1]![0]);
    expect(hits).toEqual([{ path: "/ja.tar", range: null, ua: "Peesuto", cookie: null }]);
    const line = JSON.parse(readFileSync(log, "utf8").trim());
    expect(line).toMatchObject({ host: `127.0.0.1:${server.port}`, purpose: "fonts:ja", bytesOut: 0, bytesIn: tarJa.length, status: 200, local: true });
    // nothing left behind but the pack
    expect((await readdir(join(fontPacksRoot(o.dataDir), ".partial"))).length).toBe(0);
    expect(fontPackStatus(o).find((s) => s.id === "ja")!.installed).toBe(true);
    // already there: no second request
    expect((await installFontPack("ja", o)).downloaded).toBe(false);
    expect(hits.length).toBe(1);
  });

  test("a file that does not match its SHA-256 is refused and deleted", async () => {
    const o = await opts();
    mode = "corrupt";
    expect(await code(installFontPack("ja", o))).toBe("sha256");
    expect(existsSync(join(fontPacksRoot(o.dataDir), `ja@${sha(tarJa).slice(0, 12)}`))).toBe(false);
    expect(await readdir(join(fontPacksRoot(o.dataDir), ".partial"))).toEqual([]);
    mode = "ok";
    expect((await installFontPack("ja", o)).downloaded).toBe(true);
  });

  test("a download cut short is kept and resumed with a Range request", async () => {
    const o = await opts();
    mode = "truncate";
    expect(await code(installFontPack("ja", o))).toBe("size");
    const partial = join(fontPacksRoot(o.dataDir), ".partial");
    expect(await readdir(partial)).toEqual([`ja@${sha(tarJa).slice(0, 12)}.tar.part`]);
    mode = "ok";
    expect((await installFontPack("ja", o)).downloaded).toBe(true);
    expect(hits.at(-1)!.range).toBe("bytes=100000-");
    expect(jizuraFontFiles(["Noto Sans JP"], o).missing).toEqual([]);
  });

  test("a server that sends more than the manifest says is cut off", async () => {
    const o = { ...(await opts()), manifest: manifestWith({ jaBytes: tarJa.length - 512, jaSha: sha(tarJa.slice(0, tarJa.length - 512)) }) };
    expect(await code(installFontPack("ja", o))).toBe("size");
  });

  test("aborting stops the download and installs nothing; the next call finishes it", async () => {
    const o = await opts();
    mode = "slow";
    const ac = new AbortController();
    const p = installFontPack("ja", { ...o, signal: ac.signal });
    await until(() => release !== null);
    ac.abort();
    expect(await code(p)).toBe("aborted");
    expect(fontPackStatus(o).find((s) => s.id === "ja")).toMatchObject({ installed: false });
    await until(() => !fontPackStatus(o).find((s) => s.id === "ja")!.installing);
    mode = "ok";
    release?.(); release = null;
    expect((await installFontPack("ja", o)).downloaded).toBe(true);
    expect(await code(installFontPack("ja", { ...o, signal: AbortSignal.abort() }))).toBe("aborted");
  });

  test("concurrent callers share one download; one leaving does not stop it for the others", async () => {
    const o = await opts();
    mode = "slow";
    const ac = new AbortController();
    const a = installFontPack("ja", { ...o, signal: ac.signal });
    const b = installFontPack("ja", o);
    const c = ensureJizuraFonts(["Noto Sans JP"], o);
    await until(() => release !== null);
    expect(fontPackStatus(o).find((s) => s.id === "ja")!.installing).toBe(true);
    ac.abort();
    expect(await code(a)).toBe("aborted");
    release!();
    expect((await b).downloaded).toBe(true);
    expect((await c).missing).toEqual([]);
    expect(hits.filter((h) => h.path === "/ja.tar").length).toBe(1);
  });

  test("ensure downloads only the packs the families need, with one progress total", async () => {
    const o = await opts();
    const seen: number[] = [];
    const r = await ensureJizuraFonts(["Noto Sans KR", "Unknown Face"], { ...o, onProgress: (d, t) => { seen.push(t); } });
    expect(r.files.map((f) => f.family)).toEqual(["Noto Sans KR"]);
    expect(r.missing).toEqual(["Unknown Face"]);
    expect(hits.map((h) => h.path)).toEqual(["/ko.tar"]);
    expect(new Set(seen)).toEqual(new Set([tarKo.length]));
    // installed and intact: no network
    await ensureJizuraFonts(["Noto Sans KR"], o);
    expect(hits.length).toBe(1);
  });

  test("a Latin cut in the base set means no download for Latin text", async () => {
    const dir = await dataDir();
    const bundled = join(dir, "bundled");
    await mkdir(bundled);
    const cut = new TextEncoder().encode("latin cut");
    await writeFile(join(bundled, "SansJP-Latin.woff2"), cut);
    const m = parseManifest({ ...JSON.parse(JSON.stringify(manifest)), bundled: { title: { en: "b", zh: "b", ja: "b" }, licenses: [],
      families: [{ family: "Noto Sans JP", weight: 900, style: "normal", ...fileEntry("SansJP-Latin.woff2", cut), lacks: CJK_RANGES }] } });
    const o = { dataDir: dir, manifest: m, bundledDir: bundled, baseUrl: base };
    expect((await ensureJizuraFonts(["Noto Sans JP"], { ...o, text: "Hello" })).files[0]!.path).toBe(join(bundled, "SansJP-Latin.woff2"));
    expect(hits.length).toBe(0);
    expect((await ensureJizuraFonts(["Noto Sans JP"], { ...o, text: "夜に駆ける" })).files[0]!.path).toEndWith("SansJP-Black.woff2");
    expect(hits.length).toBe(1);
  });

  test("a damaged install is noticed and repaired", async () => {
    const o = await opts();
    const { dir } = await installFontPack("ja", o);
    // same size, different bytes: only the SHA-256 check sees it
    const damaged = fontA.slice(); damaged[5] = damaged[5]! ^ 1;
    await writeFile(join(dir, "SansJP-Black.woff2"), damaged);
    expect((await installFontPack("ja", o)).downloaded).toBe(true);
    expect(sha(readFileSync(join(dir, "SansJP-Black.woff2")))).toBe(sha(fontA));
    // a missing file: the local check already says "not installed"
    await rm(join(dir, "OFL.txt"));
    expect(jizuraFontFiles(["Noto Sans JP"], o).missing).toEqual(["Noto Sans JP"]);
    expect((await ensureJizuraFonts(["Noto Sans JP"], o)).missing).toEqual([]);
    expect(hits.length).toBe(3);
  });

  test("a new version of a pack replaces the old one", async () => {
    const o = await opts();
    const old = join(fontPacksRoot(o.dataDir), "ja@000000000000");
    await mkdir(old, { recursive: true });
    await writeFile(join(old, "SansJP-Black.woff2"), "old");
    await installFontPack("ja", o);
    expect((await readdir(fontPacksRoot(o.dataDir))).sort()).toEqual([".partial", `ja@${sha(tarJa).slice(0, 12)}`]);
  });

  test("remove deletes the pack; the base set and unknown packs are refused", async () => {
    const o = await opts();
    await installFontPack("ja", o);
    expect(await removeFontPack("ja", o)).toEqual({ removed: true });
    expect(fontPackStatus(o).find((s) => s.id === "ja")!.installed).toBe(false);
    expect(jizuraFontFiles(["Noto Sans JP"], o).missing).toEqual(["Noto Sans JP"]);
    expect(await removeFontPack("ja", o)).toEqual({ removed: false });
    expect(await code(removeFontPack("base", o))).toBe("bundled");
    expect(await code(removeFontPack("nope", o))).toBe("unknown-pack");
    expect(await code(installFontPack("base", o))).toBe("bundled");
    expect(await code(installFontPack("nope", o))).toBe("unknown-pack");
  });

  test("remove stops a running download", async () => {
    const o = await opts();
    mode = "slow";
    const p = code(installFontPack("ja", o));
    await until(() => release !== null);
    await removeFontPack("ja", o);
    expect(await p).toBe("aborted");
    expect(existsSync(join(fontPacksRoot(o.dataDir), ".partial", `ja@${sha(tarJa).slice(0, 12)}.tar.part`))).toBe(false);
  });

  test("offline mode, an unset host and non-HTTPS hosts send nothing", async () => {
    const o = await opts();
    setOffline(true);
    expect(await code(installFontPack("ja", o))).toBe("offline");
    setOffline(false);
    expect(await code(installFontPack("ja", { ...o, baseUrl: undefined }))).toBe("unconfigured");
    expect(await code(installFontPack("ja", { ...o, baseUrl: "http://example.com/packs/" }))).toBe("insecure");
    mode = "redirect-insecure";
    expect(await code(installFontPack("ja", o))).toBe("insecure");
    expect(hits.length).toBe(1);                         // the redirect itself; example.com was never asked
    mode = "404";
    expect(await code(installFontPack("ja", o))).toBe("http");
    // local lookups never reach the network
    hits.length = 0;
    jizuraFontFiles(["Noto Sans JP", "Noto Sans KR"], o);
    fontPackStatus(o);
    expect(hits.length).toBe(0);
  });

  test("redirects are followed (each hop checked)", async () => {
    const o = await opts();
    mode = "redirect";
    expect((await installFontPack("ja", o)).downloaded).toBe(true);
    expect(hits.map((h) => h.path)).toEqual(["/ja.tar", "/moved/ja.tar"]);
  });

  test("PEESUTO_FONT_PACKS_URL sets the host", async () => {
    const o = await opts();
    process.env.PEESUTO_FONT_PACKS_URL = base;
    try { expect((await installFontPack("ko", { ...o, baseUrl: undefined })).downloaded).toBe(true); }
    finally { delete process.env.PEESUTO_FONT_PACKS_URL; }
  });

  test("another process's lock is waited for; a dead process's lock is taken over", async () => {
    const o = await opts();
    const partial = join(fontPacksRoot(o.dataDir), ".partial");
    await mkdir(partial, { recursive: true });
    const lock = join(partial, `ja@${sha(tarJa).slice(0, 12)}.lock`);
    const other = spawn("sleep", ["30"]);
    await writeFile(lock, String(other.pid));
    const p = installFontPack("ja", o);
    await Bun.sleep(400);
    expect(hits.length).toBe(0);                         // still waiting for the live holder
    other.kill();
    await new Promise((r) => other.once("exit", r));
    expect((await p).downloaded).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });
});
