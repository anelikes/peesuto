#!/usr/bin/env bun
/**
 * Assemble the sidecar the desktop app ships: the Bun binary that runs us,
 * plus a read-only resource tree with the engine subset a paste needs and a
 * copy of core/. At first launch the app copies `resources/engine` into its
 * Application Support directory (the build writes into the vendored tree),
 * and every render happens there — never inside the app bundle.
 *
 *   bun scripts/bundle-sidecar.ts [--engine <root>] [--out native/.bundle] [--target aarch64-apple-darwin]
 *
 * Layout produced under --out:
 *   binaries/paste-<target>     the Bun executable staged for the native app bundle
 *   resources/engine/…          engine subset (src, vendored compiler, wasm, fonts, node_modules closure)
 *   resources/core/…            core/src
 *   resources/VERSION           "<engine sha> <core sha>" — the install key
 */
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, copyFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { engineMissing, engineRoot, REPO_ROOT } from "../core/src/engine.ts";

const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const engine = resolve(flag("engine") ?? engineRoot());
const out = resolve(flag("out", join(REPO_ROOT, "native/.bundle"))!);
const target = flag("target", `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`)!;

const missing = engineMissing(engine);
if (missing.length) throw new Error(`engine at ${engine} is not set up:\n  ${missing.join("\n  ")}`);

/** Engine paths copied verbatim (directories recursively). */
const ENGINE_PATHS = [
  "package.json", "tsconfig.json", "src", "patches",
  "vendor/pocketjs/package.json", "vendor/pocketjs/tsconfig.json",
  "vendor/pocketjs/tools", "vendor/pocketjs/framework", "vendor/pocketjs/contracts",
  "vendor/pocketjs/hosts/web", "vendor/pocketjs/tests/png.ts",
  "assets/fonts",
];
/**
 * npm packages the vendored compiler reaches. The vue ones are imported at
 * module top level by `tools/build.ts` even for a solid composition, so they
 * have to come along; `bun build --packages=external` over tools/build.ts is
 * how this list was read off.
 */
const PACKAGE_ROOTS = ["@babel/core", "@babel/preset-typescript", "babel-preset-solid", "opentype.js", "solid-js",
  "vue", "vue-jsx-vapor", "@vue-jsx-vapor/runtime", "@vue/compiler-sfc", "octane"];

const NM = join(engine, "vendor/pocketjs/node_modules");

/** Transitive `dependencies` closure over the flat node_modules. */
async function packageClosure(roots: readonly string[], NM: string): Promise<string[]> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    const pj = join(NM, name, "package.json");
    if (!existsSync(pj)) { console.warn(`  (skip ${name}: not in node_modules)`); continue; }
    seen.add(name);
    const meta = JSON.parse(await readFile(pj, "utf8")) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    for (const dep of Object.keys({ ...(meta.dependencies ?? {}), ...(meta.optionalDependencies ?? {}) })) queue.push(dep);
  }
  return [...seen].sort();
}

const resources = join(out, "resources");
const engineOut = join(resources, "engine");
await rm(resources, { recursive: true, force: true });
await mkdir(join(out, "binaries"), { recursive: true });

const filter = (src: string) => !/\/(\.git|node_modules|dist|target|\.DS_Store)(\/|$)/.test(src) || src.startsWith(NM);
for (const p of ENGINE_PATHS) {
  const from = join(engine, p), to = join(engineOut, p);
  if (!existsSync(from)) throw new Error(`engine lacks ${p}`);
  await mkdir(join(to, ".."), { recursive: true });
  await cp(from, to, { recursive: true, dereference: true, filter: (s) => filter(s) });
}
const pkgs = await packageClosure(PACKAGE_ROOTS, NM);
for (const name of pkgs) {
  await cp(join(NM, name), join(engineOut, "vendor/pocketjs/node_modules", name), { recursive: true, dereference: true, filter: (s) => !/\/\.DS_Store$/.test(s) });
}
// A build regenerates this mirror; it must not carry one from the dev tree.
await rm(join(engineOut, "vendor/pocketjs/framework/src/styles.generated.ts"), { force: true });

await cp(join(REPO_ROOT, "core/src"), join(resources, "core"), { recursive: true });

// Core's own runtime packages (root package.json "dependencies") ship beside
// it. Without them the bundled Bun resolves nothing outside this repository,
// and by default would auto-install from the npm registry at runtime: a
// network request outside core's egress layer. The native app also launches
// Core with --no-install; the check below proves nothing is missing.
const ROOT_NM = join(REPO_ROOT, "node_modules");
const coreRoots = Object.keys((JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {});
const corePkgs = await packageClosure(coreRoots, ROOT_NM);
for (const name of coreRoots) if (!corePkgs.includes(name)) throw new Error(`core dependency ${name} is not installed; run bun install`);
for (const name of corePkgs) {
  await cp(join(ROOT_NM, name), join(resources, "core/node_modules", name), { recursive: true, dereference: true, filter: (f) => !/\/\.DS_Store$/.test(f) });
}

// Noto Emoji 128 px, the whole set (3,583 files, 19 MiB): `scripts/fetch-emoji.ts`
// fills .work/emoji-all once; without it the app falls back to fetching per emoji.
const emojiAll = join(REPO_ROOT, ".work/emoji-all");
if (existsSync(emojiAll)) await cp(emojiAll, join(resources, "emoji"), { recursive: true, filter: (f) => !/\/\.DS_Store$/.test(f) });
else console.warn("bundle: no .work/emoji-all — run `bun scripts/fetch-emoji.ts` to ship the emoji set");

const sha = async (cwd: string) => { const p = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe", stderr: "pipe" }); return (await new Response(p.stdout).text()).trim() || "unknown"; };
/** Content digest of the resource tree, so a rebuilt bundle with the same shas still reinstalls. */
async function treeDigest(dir: string): Promise<string> {
  const files = [...new Bun.Glob("**/*").scanSync({ cwd: dir, onlyFiles: true })].sort();
  const h = new Bun.CryptoHasher("sha256");
  for (const f of files) { h.update(f + "\0"); h.update(await Bun.file(join(dir, f)).bytes()); h.update("\0"); }
  return h.digest("hex").slice(0, 12);
}
const version = `${(await sha(engine)).slice(0, 12)} ${(await sha(REPO_ROOT)).slice(0, 12)} bun${Bun.version} tree${await treeDigest(resources)}`;
await writeFile(join(resources, "VERSION"), version + "\n");

const bin = join(out, "binaries", `paste-${target}`);
await copyFile(process.execPath, bin);
await chmod(bin, 0o755);

// Prove core's packages resolve from the bundle alone: a copy of core outside
// this repository (so no parent node_modules can help), imports only, with
// runtime auto-install disabled.
{
  const probe = await mkdtemp(join(tmpdir(), "peesuto-core-probe-"));
  try {
    await cp(join(resources, "core"), join(probe, "core"), { recursive: true });
    const script = coreRoots.map((name) => `await import(${JSON.stringify(name)});`).join("") + `console.log("ok");`;
    const p = Bun.spawn([bin, "--no-install", "-e", script], { cwd: join(probe, "core"), stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(probe, "cache") } });
    const [stdout, stderr, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
    if (code !== 0 || stdout.trim() !== "ok") throw new Error(`bundled core cannot resolve its packages offline (${coreRoots.join(", ")}):\n${stderr.trim()}`);
    console.log(`core packages: ${corePkgs.join(", ")} (resolve offline)`);
  } finally { await rm(probe, { recursive: true, force: true }); }
}

const du = Bun.spawn(["du", "-sh", resources, bin], { stdout: "pipe" });
console.log(`sidecar: ${pkgs.length} packages [${pkgs.join(", ")}]\nversion: ${version}\n${(await new Response(du.stdout).text()).trim()}`);
