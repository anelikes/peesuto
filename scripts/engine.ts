#!/usr/bin/env bun
/**
 * The engine as a dependency: fetch it at the commit engine.json pins, run
 * the setup steps a checkout needs, or say what an existing one is missing.
 *
 *   bun run setup             no checkout: clone into engine/ at the pin, then set it up
 *                             engine/ found: move it to the pin if it drifted, run missing steps
 *                             POCKET_ENGINE or ../pocketjs-motion found: report, run nothing
 *   bun run setup --fix       also run the missing steps inside a POCKET_ENGINE/sibling checkout
 *   bun run setup --status    where the engine is, its HEAD against the pin, what is missing
 *
 * The checkout is located the way core/src/engine.ts does at run time:
 * POCKET_ENGINE, then <repo>/engine, then a sibling ../pocketjs-motion. One
 * found through POCKET_ENGINE or the sibling path is the user's own working
 * tree: this never runs `git checkout` there, and only runs setup steps there
 * under --fix. Only <repo>/engine, which this script creates, is moved to the
 * pinned commit, and only when its tree is clean.
 *
 * Exit status is 0 when the checkout in use is complete, 1 otherwise.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { EngineError, engineMissing, engineRoot, REPO_ROOT } from "../core/src/engine.ts";

interface Pin { readonly repo: string; readonly ref: string; readonly sha: string }
type Source = "POCKET_ENGINE" | "engine/" | "sibling";
interface Found { readonly root: string; readonly source: Source }

const ENGINE_DIR = join(REPO_ROOT, "engine");
const SIBLING = resolve(REPO_ROOT, "../pocketjs-motion");
const BUN = process.execPath;

const argv = process.argv.slice(2);
const STATUS = argv.includes("--status");
const FIX = argv.includes("--fix");
for (const a of argv) if (a !== "--status" && a !== "--fix") fail(`unknown argument ${a} (flags: --status, --fix)`);

function fail(msg: string): never {
  console.error(`engine: ${msg}`);
  process.exit(1);
}

/** Which of the three candidate roots engineRoot() settled on, or null when none has a checkout. */
function locate(): Found | null {
  let root: string;
  try { root = engineRoot(); } catch (e) { if (e instanceof EngineError) return null; throw e; }
  const env = process.env.POCKET_ENGINE;
  const source: Source = env && resolve(env) === root ? "POCKET_ENGINE" : root === ENGINE_DIR ? "engine/" : "sibling";
  return { root, source };
}

/** Run a command with its output on our terminal; a non-zero exit ends the script. */
async function run(cmd: readonly string[], cwd: string): Promise<void> {
  const shown = cmd.map((c) => (c === BUN ? "bun" : c)).join(" ");
  console.log(`\n$ ${shown}    (in ${cwd})`);
  const p = Bun.spawn([...cmd], {
    cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit",
    // The engine spawns `bun` by name; make sure it finds the one running us.
    env: { ...process.env, PATH: `${dirname(BUN)}:${process.env.PATH ?? ""}` },
  });
  const code = await p.exited;
  if (code !== 0) fail(`\`${shown}\` exited with ${code}`);
}

/** Captured `git -C root ...`; null when git fails. */
async function git(root: string, ...args: string[]): Promise<string | null> {
  const p = Bun.spawn(["git", "-C", root, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return code === 0 ? out.trim() : null;
}

/** HEAD of the checkout rooted exactly at `root` (not of a repository above it), or null. */
async function headOf(root: string): Promise<string | null> {
  const top = await git(root, "rev-parse", "--show-toplevel");
  if (!top || realpathSync(top) !== realpathSync(root)) return null;
  return git(root, "rev-parse", "HEAD");
}

const short = (sha: string) => sha.slice(0, 12);

/** Setup steps, each with the check that says whether its product is missing. */
interface Step { readonly name: string; readonly cmd: readonly string[]; readonly needed: (root: string, missing: readonly string[]) => boolean }
const STEPS: readonly Step[] = [
  { name: "bun install", cmd: [BUN, "install"], needed: (root) => !existsSync(join(root, "node_modules")) },
  { name: "bun run vendor", cmd: [BUN, "run", "vendor"], needed: (_, missing) => missing.some((m) => m.startsWith("vendor/")) },
  { name: "bun scripts/assets.ts", cmd: [BUN, "scripts/assets.ts"], needed: (_, missing) => missing.some((m) => m.startsWith("assets/fonts/")) },
];

/** Print where the engine is and what state it is in; returns what engineMissing reports. */
async function report(found: Found, pin: Pin): Promise<string[]> {
  console.log(`engine: ${found.root}  (via ${found.source})`);
  const head = await headOf(found.root);
  if (head === null) console.log(`  HEAD: not a git checkout; engine.json pins ${short(pin.sha)} (${pin.ref})`);
  else if (head === pin.sha) console.log(`  HEAD: ${short(head)}, as engine.json pins (${pin.ref})`);
  else console.log(`  warning: HEAD ${short(head)} is not the pinned ${short(pin.sha)} (${pin.ref}); renders may differ from the recorded digests`);
  if (!existsSync(join(found.root, "node_modules"))) console.log("  node_modules: missing (from `bun install` in the engine)");
  const missing = engineMissing(found.root);
  if (missing.length === 0) console.log("  setup: complete");
  else {
    console.log("  missing:");
    for (const m of missing) console.log(`    ${m}`);
  }
  return missing;
}

function readPin(): Pin {
  const path = join(REPO_ROOT, "engine.json");
  if (!existsSync(path)) fail(`${path} not found`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Pin>;
  for (const k of ["repo", "ref", "sha"] as const) if (typeof raw[k] !== "string" || !raw[k]) fail(`engine.json: ${k} must be a non-empty string`);
  return raw as Pin;
}

async function main(): Promise<number> {
  const pin = readPin();
  let found = locate();

  if (STATUS) {
    if (!found) {
      const looked = [process.env.POCKET_ENGINE, ENGINE_DIR, SIBLING].filter((p): p is string => !!p).map((p) => resolve(p));
      console.log(`engine: none found (looked at ${looked.join(", ")})`);
      console.log("  run `bun run setup` to clone it into engine/, or point POCKET_ENGINE at a checkout");
      return 1;
    }
    return (await report(found, pin)).length === 0 ? 0 : 1;
  }

  if (!found) {
    if (existsSync(ENGINE_DIR) && (await readdir(ENGINE_DIR)).length > 0) {
      fail(`${ENGINE_DIR} exists but has no src/cli/main.ts; move it away and run again`);
    }
    console.log(`cloning ${pin.repo} at ${pin.ref} (${short(pin.sha)}) into ${ENGINE_DIR}`);
    await run(["git", "clone", "--filter=blob:none", "--no-checkout", pin.repo, ENGINE_DIR], REPO_ROOT);
    await run(["git", "fetch", "origin", pin.ref], ENGINE_DIR);
    await run(["git", "checkout", pin.sha], ENGINE_DIR);
    found = { root: ENGINE_DIR, source: "engine/" };
  } else if (found.source === "engine/") {
    // Ours: follow engine.json when it moved, unless someone has been editing in there.
    const head = await headOf(found.root);
    if (head !== null && head !== pin.sha) {
      const dirty = await git(found.root, "status", "--porcelain");
      if (dirty) {
        console.log(`warning: engine/ is at ${short(head)}, engine.json pins ${short(pin.sha)}, and the tree has local changes; leaving it where it is`);
      } else {
        console.log(`engine/ is at ${short(head)}; moving to the pinned ${short(pin.sha)} (${pin.ref})`);
        await run(["git", "fetch", "origin", pin.ref], found.root);
        await run(["git", "checkout", pin.sha], found.root);
      }
    }
  }

  const steps = STEPS.filter((s) => s.needed(found.root, engineMissing(found.root)));
  const own = found.source === "engine/";
  if (steps.length > 0 && !own && !FIX) {
    const missing = await report(found, pin);
    console.log(`\nthis checkout was found via ${found.source} and is not managed here; to complete it run, in ${found.root}:`);
    for (const s of steps) console.log(`    ${s.name}`);
    console.log("or run `bun run setup --fix` to have that done for you");
    return missing.length === 0 ? 0 : 1;
  }
  for (const s of steps) await run(s.cmd, found.root);
  if (steps.length > 0) console.log("");
  return (await report(found, pin)).length === 0 ? 0 : 1;
}

process.exit(await main());
