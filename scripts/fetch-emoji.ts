#!/usr/bin/env bun
/**
 * fetch-emoji — the whole Noto Emoji `png/128` set at the tag emoji.ts pins.
 *
 *   bun scripts/fetch-emoji.ts [--dir DIR] [--dry-run] [--concurrency N]
 *
 * Lists `png/128/emoji_u*.png` through the GitHub tree API (blob sizes come
 * with the listing; `gh api` is the fallback when the unauthenticated call is
 * rate-limited), downloads each from the jsDelivr mirror of the same tag into
 * DIR (default `<repo>/.work/emoji-all/`), skipping files already there with
 * a size, then prints the count, the total bytes and the ten largest files.
 * `--dry-run` lists and sums from the tree alone.
 *
 * This is M2's measurement: under 20 MB the whole set ships with the app,
 * over it a subset does and the rest stays a network cache.
 */
import { mkdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { REPO_ROOT } from "../core/src/engine.ts";

const TAG = "v2.047";
const REPO = "googlefonts/noto-emoji";
const PREFIX = "png/128/";
const NAME = /^emoji_u[0-9a-f_]+\.png$/;
const TREE_URL = `https://api.github.com/repos/${REPO}/git/trees/${TAG}?recursive=1`;
const cdnUrl = (name: string) => `https://cdn.jsdelivr.net/gh/${REPO}@${TAG}/${PREFIX}${name}`;

interface Blob { readonly name: string; readonly size: number }
interface Tree { readonly tree?: readonly { path?: string; type?: string; size?: number }[]; readonly truncated?: boolean }

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function fetchTree(): Promise<Tree> {
  const res = await fetch(TREE_URL, { headers: { accept: "application/vnd.github+json", "user-agent": "pocket-paste fetch-emoji" } });
  if (res.ok) return (await res.json()) as Tree;
  if (res.status !== 403 && res.status !== 429) throw new Error(`tree API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  console.error(`tree API HTTP ${res.status} (rate limit?) — falling back to \`gh api\``);
  const p = Bun.spawn(["gh", "api", `repos/${REPO}/git/trees/${TAG}?recursive=1`], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`gh api failed (${code}): ${err.trim()}`);
  return JSON.parse(out) as Tree;
}

/** Every `png/128/emoji_u*.png` blob at the tag, with its size. */
async function listBlobs(): Promise<Blob[]> {
  const tree = await fetchTree();
  if (tree.truncated) throw new Error("tree API response is truncated; the listing would be incomplete");
  const blobs: Blob[] = [];
  for (const e of tree.tree ?? []) {
    if (e.type !== "blob" || !e.path?.startsWith(PREFIX)) continue;
    const name = e.path.slice(PREFIX.length);
    if (!NAME.test(name) || typeof e.size !== "number") continue;
    blobs.push({ name, size: e.size });
  }
  return blobs.sort((a, b) => a.name.localeCompare(b.name));
}

async function sizeOf(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch { return -1; }
}

async function fetchTo(url: string, path: string): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "pocket-paste fetch-emoji" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0) throw new Error("empty body");
      await Bun.write(path, buf);
      return;
    } catch (e) {
      last = e;
      await Bun.sleep(250 * (attempt + 1));
    }
  }
  throw new Error(`${url}: ${msg(last)}`);
}

async function download(blobs: readonly Blob[], dir: string, concurrency: number): Promise<{ fetched: number; skipped: number; failed: string[] }> {
  await mkdir(dir, { recursive: true });
  let next = 0, fetched = 0, skipped = 0, done = 0;
  const failed: string[] = [];
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= blobs.length) return;
      const b = blobs[i]!;
      const path = join(dir, b.name);
      if ((await sizeOf(path)) > 0) skipped++;
      else {
        try { await fetchTo(cdnUrl(b.name), path); fetched++; }
        catch (e) { failed.push(msg(e)); }
      }
      if (++done % 500 === 0 || done === blobs.length) console.error(`  ${done}/${blobs.length} (${fetched} fetched, ${skipped} present, ${failed.length} failed)`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { fetched, skipped, failed };
}

function report(title: string, files: readonly Blob[]): void {
  const total = files.reduce((a, f) => a + f.size, 0);
  console.log(`${title}: ${files.length} files, ${total} bytes (${mb(total)})`);
  console.log("largest:");
  for (const f of [...files].sort((a, b) => b.size - a.size).slice(0, 10)) console.log(`  ${String(f.size).padStart(8)}  ${f.name}`);
}

async function main(argv: readonly string[]): Promise<number> {
  const flag = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const dryRun = argv.includes("--dry-run");
  const dir = resolve(flag("dir") ?? join(REPO_ROOT, ".work/emoji-all"));
  const concurrency = Number(flag("concurrency") ?? 16);

  const blobs = await listBlobs();
  if (blobs.length === 0) throw new Error(`no ${PREFIX}emoji_u*.png blobs at ${TAG}`);
  report(`Noto Emoji ${TAG} ${PREFIX}emoji_u*.png (tree API)`, blobs);
  if (dryRun) return 0;

  console.error(`downloading into ${dir} with concurrency ${concurrency}`);
  const r = await download(blobs, dir, concurrency);
  console.log(`fetched ${r.fetched}, already present ${r.skipped}, failed ${r.failed.length}`);
  for (const f of r.failed.slice(0, 20)) console.log(`  failed: ${f}`);

  const onDisk: Blob[] = [];
  const mismatched: string[] = [];
  for (const b of blobs) {
    const size = await sizeOf(join(dir, b.name));
    if (size > 0) onDisk.push({ name: b.name, size });
    if (size !== b.size) mismatched.push(`${b.name}: disk ${size} vs tree ${b.size}`);
  }
  report(`on disk in ${basename(dir)}/`, onDisk);
  const expected = blobs.reduce((a, f) => a + f.size, 0);
  const actual = onDisk.reduce((a, f) => a + f.size, 0);
  console.log(mismatched.length === 0
    ? `on-disk total matches the tree total (${actual} bytes)`
    : `${mismatched.length} file(s) differ from the tree (disk ${actual} vs tree ${expected} bytes):\n  ${mismatched.slice(0, 20).join("\n  ")}`);
  return r.failed.length === 0 && mismatched.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (e) {
    console.error(`fetch-emoji: ${msg(e)}`);
    process.exit(1);
  }
}
