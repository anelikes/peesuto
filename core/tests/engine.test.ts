import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { engineMissing, engineRoot, EngineError, ensureWorkTree, REPO_ROOT } from "../src/engine.ts";

/** What core/src/engine.ts requires of a checkout, by path. */
const REQUIRED = [
  "src/cli/main.ts",
  "src/text/fit.ts",
  "src/text/measure.ts",
  "vendor/pocketjs/tools/build.ts",
  "vendor/pocketjs/hosts/web/pocketjs.wasm",
  "vendor/pocketjs/node_modules/solid-js",
  "assets/fonts/NotoSansSC-Regular.otf",
  "assets/fonts/NotoSansSC-Bold.otf",
];
const pathOf = (missing: string) => missing.replace(/ \(from .*\)$/, "");

/** A fake engine checkout: the required files, empty, plus the directories a real one has. */
async function fakeEngine(root: string, composition: string): Promise<void> {
  for (const p of REQUIRED) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), "");
  }
  for (const d of ["compositions/" + composition, ".git", "node_modules", "dist", "out", "renders", "frames"]) await mkdir(join(root, d), { recursive: true });
  await writeFile(join(root, "package.json"), "{}\n");
}

const isLink = async (p: string) => (await lstat(p)).isSymbolicLink();
const isRealDir = async (p: string) => { const s = await lstat(p); return s.isDirectory() && !s.isSymbolicLink(); };

let tmp: string;
beforeAll(async () => { tmp = await mkdtemp(join(tmpdir(), "pocket-paste-engine-")); });
afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

describe("engineMissing", () => {
  test("an empty directory is missing every required file, each with its setup step", async () => {
    const empty = join(tmp, "empty");
    await mkdir(empty);
    const missing = engineMissing(empty);
    expect(missing.map(pathOf).sort()).toEqual([...REQUIRED].sort());
    for (const m of missing) expect(m).toMatch(/ \(from .+\)$/);
  });

  test("a complete fake checkout is missing nothing; removing a font shows up", async () => {
    const root = join(tmp, "complete");
    await fakeEngine(root, "demo");
    expect(engineMissing(root)).toEqual([]);
    await rm(join(root, "assets/fonts/NotoSansSC-Bold.otf"));
    const missing = engineMissing(root);
    expect(missing.length).toBe(1);
    expect(missing[0]).toContain("assets/fonts/NotoSansSC-Bold.otf");
    expect(missing[0]).toContain("assets.ts");
  });
});

describe("engineRoot", () => {
  test("honours POCKET_ENGINE", async () => {
    const root = join(tmp, "env-root");
    await fakeEngine(root, "demo");
    expect(engineRoot({ POCKET_ENGINE: root })).toBe(root);
  });

  test("never returns a POCKET_ENGINE that has no checkout", async () => {
    // With no env override the lookup falls through to <repo>/engine and the
    // sibling checkout, which may or may not exist on this machine: either an
    // EngineError naming the bad path, or some other, real checkout.
    const nowhere = join(tmp, "nowhere");
    let found: string | null = null;
    try { found = engineRoot({ POCKET_ENGINE: nowhere }); } catch (e) {
      expect(e).toBeInstanceOf(EngineError);
      expect((e as Error).message).toContain(nowhere);
    }
    if (found !== null) {
      expect(found).not.toBe(nowhere);
      expect(existsSync(join(found, "src/cli/main.ts"))).toBe(true);
    }
  });

  test("REPO_ROOT is this repository", () => {
    expect(existsSync(join(REPO_ROOT, "engine.json"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "core/src/engine.ts"))).toBe(true);
  });
});

describe("ensureWorkTree", () => {
  let root: string;
  let root2: string;
  let work: string;
  beforeAll(async () => {
    root = join(tmp, "engine-a");
    root2 = join(tmp, "engine-b");
    work = join(tmp, "work");
    await fakeEngine(root, "demo");
    await fakeEngine(root2, "other");
  });

  test("builds symlinks for top-level entries, a real compositions/ and a real empty dist/", async () => {
    await ensureWorkTree(root, work);
    for (const e of ["src", "vendor", "assets", "package.json"]) {
      expect(await isLink(join(work, e))).toBe(true);
      expect(await readlink(join(work, e))).toBe(join(root, e));
    }
    expect(await isRealDir(join(work, "compositions"))).toBe(true);
    expect(await isLink(join(work, "compositions/demo"))).toBe(true);
    expect(await readlink(join(work, "compositions/demo"))).toBe(join(root, "compositions/demo"));
    expect(await isRealDir(join(work, "dist"))).toBe(true);
    expect(await readdir(join(work, "dist"))).toEqual([]);
    for (const skipped of [".git", "node_modules", "out", "renders", "frames"]) expect(existsSync(join(work, skipped))).toBe(false);
    expect((await readFile(join(work, ".pocket-paste-work"), "utf8")).split("\n")[0]).toBe(root);
    // Through the links the work tree is itself a usable engine root.
    expect(engineMissing(work)).toEqual([]);
  });

  test("is idempotent: a second call over the same root keeps dist/ contents", async () => {
    await writeFile(join(work, "dist/cache.bin"), "cached");
    await mkdir(join(work, "compositions/paste"), { recursive: true });
    await writeFile(join(work, "compositions/paste/job.json"), "{}");
    const before = (await lstat(join(work, "src"))).ino;
    await ensureWorkTree(root, work);
    expect(await readFile(join(work, "dist/cache.bin"), "utf8")).toBe("cached");
    expect(existsSync(join(work, "compositions/paste/job.json"))).toBe(true);
    expect((await lstat(join(work, "src"))).ino).toBe(before);
    expect(await readlink(join(work, "src"))).toBe(join(root, "src"));
  });

  test("rebuilding over another root replaces the links but keeps dist/ and compositions/paste", async () => {
    await ensureWorkTree(root2, work);
    for (const e of ["src", "vendor", "assets", "package.json"]) {
      expect(await isLink(join(work, e))).toBe(true);
      expect(await readlink(join(work, e))).toBe(join(root2, e));
    }
    expect(existsSync(join(work, "compositions/demo"))).toBe(false);
    expect(await readlink(join(work, "compositions/other"))).toBe(join(root2, "compositions/other"));
    expect(await isRealDir(join(work, "compositions/paste"))).toBe(true);
    expect(existsSync(join(work, "compositions/paste/job.json"))).toBe(true);
    expect(await isRealDir(join(work, "dist"))).toBe(true);
    expect(await readFile(join(work, "dist/cache.bin"), "utf8")).toBe("cached");
    expect((await readFile(join(work, ".pocket-paste-work"), "utf8")).split("\n")[0]).toBe(root2);
    expect(engineMissing(work)).toEqual([]);
  });

  test("a fresh work directory is created from scratch", async () => {
    const fresh = join(tmp, "nested/deeper/work");
    await ensureWorkTree(root, fresh);
    expect(await isLink(join(fresh, "src"))).toBe(true);
    expect(await isRealDir(join(fresh, "dist"))).toBe(true);
  });
});
