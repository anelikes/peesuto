/**
 * Where the engine is, whether it is usable, and how to run it.
 *
 * pocket-paste never writes into the engine checkout. Every build and render
 * happens in a WORK TREE: a directory whose top-level entries are symlinks to
 * the engine's, except `compositions/` (real, with symlinks to the engine's
 * own compositions plus our real `paste/`) and `dist/` (real, empty). The
 * engine derives its repository root from a composition's path, so from
 * inside the work tree everything it writes lands in the work tree.
 */
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class EngineError extends Error {}

/** The pocket-paste repository root (`core/src/engine.ts` → two up). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Files a usable engine checkout must have; each names the setup step that produces it. */
const REQUIRED: readonly (readonly [string, string])[] = [
  ["src/cli/main.ts", "a checkout of pocket-motion"],
  ["src/text/fit.ts", "a checkout of pocket-motion"],
  ["src/text/measure.ts", "a checkout of pocket-motion at or after patch 0015"],
  ["vendor/pocketjs/tools/build.ts", "`bun run vendor` in the engine"],
  ["vendor/pocketjs/hosts/web/pocketjs.wasm", "`bun run vendor` in the engine"],
  ["vendor/pocketjs/node_modules/solid-js", "`bun run vendor` in the engine"],
  ["assets/fonts/NotoSansSC-Regular.otf", "`bun scripts/assets.ts` in the engine"],
  ["assets/fonts/NotoSansSC-Bold.otf", "`bun scripts/assets.ts` in the engine"],
];

/** Locate the engine: `POCKET_ENGINE`, then `<repo>/engine`, then a sibling `../pocketjs-motion`. */
export function engineRoot(env: Record<string, string | undefined> = process.env): string {
  if (env.POCKET_ENGINE) {
    // An explicit setting is never silently ignored: a typo would otherwise
    // pick up whatever sibling checkout happens to be there.
    const p = resolve(env.POCKET_ENGINE);
    if (!existsSync(join(p, "src/cli/main.ts"))) throw new EngineError(`POCKET_ENGINE=${env.POCKET_ENGINE} is not an engine checkout (no src/cli/main.ts)`);
    return p;
  }
  const candidates = [join(REPO_ROOT, "engine"), resolve(REPO_ROOT, "../pocketjs-motion")];
  for (const c of candidates) if (existsSync(join(c, "src/cli/main.ts"))) return c;
  throw new EngineError(`no engine checkout found (looked at ${candidates.join(", ")}); run \`bun run setup\` or set POCKET_ENGINE`);
}

/** What a checkout is missing, with the step that would produce each item. Empty means usable. */
export function engineMissing(root: string): string[] {
  return REQUIRED.filter(([p]) => !existsSync(join(root, p))).map(([p, how]) => `${p} (from ${how})`);
}

export function assertEngine(root: string): void {
  const missing = engineMissing(root);
  if (missing.length > 0) throw new EngineError(`engine at ${root} is not set up:\n  ${missing.join("\n  ")}`);
}

/**
 * Install the engine subset a sidecar bundle carries into a writable place.
 * The vendored compiler writes into its own tree during a build
 * (`framework/src/styles.generated.ts`), so an engine inside a signed app
 * bundle cannot be used in place. One copy per VERSION under `<appData>/engine/`;
 * an existing copy with the same version is reused. Returns the engine root.
 */
export async function installEngine(resources: string, appData: string): Promise<string> {
  const version = (await readFile(join(resources, "VERSION"), "utf8")).trim();
  const key = version.replace(/[^A-Za-z0-9.]+/g, "-");
  const root = join(appData, "engine", key);
  const done = join(root, ".installed");
  if (existsSync(done)) return root;
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, ".."), { recursive: true });
  await cp(join(resources, "engine"), root, { recursive: true });
  await writeFile(done, version + "\n");
  return root;
}

const MARKER = ".pocket-paste-work";

/**
 * Build (or refresh) the work tree over `root`. Idempotent: an existing tree
 * built over the same engine root is kept, one built over another root is
 * rebuilt, and `dist/` survives so measurement caches persist across pastes.
 */
export async function ensureWorkTree(root: string, work: string): Promise<void> {
  const marker = join(work, MARKER);
  // Keyed on the root AND its entry list: an engine that gains a top-level
  // directory after a setup must get a link for it.
  const key = [root, ...(await readdir(root)).sort()].join("\n");
  if (existsSync(marker) && (await readFile(marker, "utf8")).trim() === key) return;
  if (existsSync(work)) {
    // Rebuild the links but keep dist/ and compositions/paste (caches, staged emoji).
    for (const e of await readdir(work)) if (!["dist", "compositions"].includes(e)) await rm(join(work, e), { recursive: true, force: true });
    if (existsSync(join(work, "compositions"))) for (const e of await readdir(join(work, "compositions"))) if (e !== "paste") await rm(join(work, "compositions", e), { recursive: true, force: true });
  }
  await mkdir(join(work, "compositions"), { recursive: true });
  await mkdir(join(work, "dist"), { recursive: true });
  for (const e of await readdir(root)) {
    if (["compositions", "dist", ".git", "node_modules", "out", "renders", "frames"].includes(e)) continue;
    await symlink(join(root, e), join(work, e));
  }
  if (existsSync(join(root, "compositions"))) {
    for (const c of await readdir(join(root, "compositions"))) await symlink(join(root, "compositions", c), join(work, "compositions", c));
  }
  await writeFile(marker, key + "\n");
}

export interface RunResult { readonly stdout: string; readonly stderr: string; readonly ms: number }

/**
 * A PATH whose first entry holds a `bun` that is the Bun running us. In a
 * packaged app the executable is the sidecar (`paste`), so `<binDir>/bun` is
 * a symlink to it; in development it points at the real bun. The engine
 * spawns `bun` by name for builds, and its build record insists the Bun that
 * built a bundle is the one that boots it.
 *
 * Bun resolves a spawned name against the PATH a process STARTED with, not
 * against a `process.env.PATH` assigned later, so a process that needs the
 * shim must be started with this PATH (`cli.ts` re-executes itself once).
 */
export async function bunOnPath(binDir: string): Promise<{ readonly PATH: string; readonly dir: string }> {
  const link = join(binDir, "bun");
  await mkdir(binDir, { recursive: true });
  try {
    if ((await readlink(link)) !== process.execPath) { await rm(link, { force: true }); await symlink(process.execPath, link); }
  } catch { await symlink(process.execPath, link); }
  return { PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`, dir: binDir };
}

/** Is the `bun` a child would find by name the very Bun running us? */
export function bunIsOnPath(): boolean {
  const found = Bun.which("bun");
  if (!found) return false;
  try { return realpathSync(found) === realpathSync(process.execPath); } catch { return false; }
}

/**
 * Run an engine CLI command from the work tree. The engine spawns `bun` by
 * name for builds, so the directory of the Bun running us is put first on
 * PATH: the build then runs under the same Bun that boots the result, which
 * the engine's build record insists on.
 */
export async function runEngine(work: string, args: readonly string[], env: Record<string, string> = {}): Promise<RunResult> {
  const t0 = performance.now();
  const p = Bun.spawn([process.execPath, "src/cli/main.ts", ...args], {
    cwd: work, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, PATH: (await bunOnPath(join(work, ".bin"))).PATH, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new EngineError(`engine ${args.slice(0, 2).join(" ")} failed (${code}):\n${stdout}${stderr}`);
  return { stdout, stderr, ms: Math.round(performance.now() - t0) };
}
