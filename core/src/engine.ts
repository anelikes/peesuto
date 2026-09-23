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
import { homedir } from "node:os";
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
  const root = join(engineInstallBase(appData), key);
  const done = join(root, ".installed");
  if (existsSync(done)) return root;
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, ".."), { recursive: true });
  await cp(join(resources, "engine"), root, { recursive: true });
  await writeFile(done, version + "\n");
  return root;
}

/**
 * Where installed engines live. The engine derives file paths with
 * `new URL(…, import.meta.url).pathname`, which percent-encodes a space, so
 * an engine under `~/Library/Application Support/…` cannot find its own
 * files. Until the engine switches those sites to `fileURLToPath`
 * (src/runtime/boot.ts, src/render/parallel.ts, src/render/build-record.ts,
 * src/text/measure.ts, vendor/pocketjs/framework/compiler/jsx-plugin.ts), an
 * app-data path that would encode falls back to `~/.pocket-paste/engine`.
 */
export function engineInstallBase(appData: string): string {
  const preferred = join(appData, "engine");
  return encodeURI(preferred) === preferred ? preferred : join(homedir(), ".pocket-paste", "engine");
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

/** Default render deadlines; `PASTE_RENDER_TIMEOUT_MS` overrides both. The
 * native shell's request timeouts (300 s / 720 s) sit above these so Core's
 * error, not the shell's, reaches the user. */
export const RENDER_TIMEOUT_MS = { still: 240_000, video: 600_000 } as const;

export class EngineTimeoutError extends EngineError {}

/** Milliseconds a render of `format` may take, all engine children included. */
export function renderTimeoutMs(format: "png" | "gif" | "mp4" | undefined): number {
  const override = Number(process.env.PASTE_RENDER_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return override;
  return format === "mp4" ? RENDER_TIMEOUT_MS.video : RENDER_TIMEOUT_MS.still;
}

/** An absolute deadline (performance.now() clock) for one render. */
export function renderDeadline(format: "png" | "gif" | "mp4" | undefined): number {
  return performance.now() + renderTimeoutMs(format);
}

export interface RunEngineOptions {
  /** Absolute performance.now() deadline shared by every child of one render. */
  readonly deadline?: number;
  /** Aborting kills the child's whole process group and throws EngineAbortedError. */
  readonly signal?: AbortSignal;
  /** Run the child at a lower scheduling priority (background work). */
  readonly lowPriority?: boolean;
}

/** A render stopped on purpose (a newer request replaced it), not a failure. */
export class EngineAbortedError extends EngineError {
  constructor(message = "render cancelled") { super(message); }
}

/** Throw EngineAbortedError when `signal` has fired. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new EngineAbortedError();
}

const NICE = ["/usr/bin/nice", "/bin/nice"].find((p) => existsSync(p));

/** Children still running, so an exiting Core does not orphan their groups. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;
function killGroup(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
}

/**
 * Run an engine CLI command from the work tree. The engine spawns `bun` by
 * name for builds, so the directory of the Bun running us is put first on
 * PATH: the build then runs under the same Bun that boots the result, which
 * the engine's build record insists on.
 *
 * The child leads its own process group; past the deadline the whole group
 * (engine, its bun build, ffmpeg) is killed and an EngineTimeoutError thrown.
 */
export async function runEngine(work: string, args: readonly string[], env: Record<string, string> = {}, options: RunEngineOptions = {}): Promise<RunResult> {
  const t0 = performance.now();
  const mp4 = args.includes("mp4");
  const deadline = options.deadline ?? renderDeadline(mp4 ? "mp4" : undefined);
  const label = args.slice(0, 2).join(" ");
  const remaining = Math.max(0, deadline - t0);
  if (remaining === 0) throw new EngineTimeoutError(`engine ${label} did not start: the render deadline had already passed.`);
  throwIfAborted(options.signal);
  // `nice` execs the command, so the pid (and the process group) stay the child's.
  const prefix = options.lowPriority && NICE ? [NICE, "-n", "10"] : [];
  const p = Bun.spawn([...prefix, process.execPath, "src/cli/main.ts", ...args], {
    cwd: work, stdout: "pipe", stderr: "pipe", detached: true,
    env: { ...process.env, PATH: (await bunOnPath(join(work, ".bin"))).PATH, ...env },
  });
  if (!exitHookInstalled) { exitHookInstalled = true; process.once("exit", () => { for (const pid of liveGroups) killGroup(pid); }); }
  liveGroups.add(p.pid);
  let timedOut = false;
  let aborted = false;
  const timer = setTimeout(() => { timedOut = true; killGroup(p.pid); }, remaining);
  const onAbort = () => { aborted = true; killGroup(p.pid); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (aborted) throw new EngineAbortedError(`engine ${label} was cancelled`);
    if (timedOut) throw new EngineTimeoutError(`engine ${label} timed out after ${Math.round((performance.now() - t0) / 1000)} s and was stopped. Try a shorter text, PNG, or set PASTE_RENDER_TIMEOUT_MS.`);
    if (code !== 0) throw new EngineError(`engine ${label} failed (${code}):\n${stdout}${stderr}`);
    return { stdout, stderr, ms: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    // The leader has exited; stop anything it left behind in its group.
    if (timedOut || aborted) killGroup(p.pid);
    liveGroups.delete(p.pid);
  }
}
