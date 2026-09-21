#!/usr/bin/env bun
/**
 * Assemble the sidecar the desktop app ships: the Bun binary that runs us,
 * plus a read-only resource tree with the engine subset a paste needs and a
 * copy of core/. At first launch the app copies `resources/engine` into its
 * Application Support directory (the build writes into the vendored tree),
 * and every render happens there — never inside the app bundle.
 *
 *   bun scripts/bundle-sidecar.ts [--engine <root>] [--out app/src-tauri] [--target aarch64-apple-darwin]
 *
 * Layout produced under --out:
 *   binaries/paste-<target>     the Bun executable, renamed (Tauri's externalBin convention)
 *   resources/engine/…          engine subset (src, vendored compiler, wasm, fonts, node_modules closure)
 *   resources/core/…            core/src
 *   resources/VERSION           "<engine sha> <core sha>" — the install key
 */
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile, copyFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { engineMissing, engineRoot, REPO_ROOT } from "../core/src/engine.ts";

const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const engine = resolve(flag("engine") ?? engineRoot());
const out = resolve(flag("out", join(REPO_ROOT, "app/src-tauri"))!);
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
async function packageClosure(roots: readonly string[]): Promise<string[]> {
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
const pkgs = await packageClosure(PACKAGE_ROOTS);
for (const name of pkgs) {
  await cp(join(NM, name), join(engineOut, "vendor/pocketjs/node_modules", name), { recursive: true, dereference: true, filter: (s) => !/\/\.DS_Store$/.test(s) });
}
// A build regenerates this mirror; it must not carry one from the dev tree.
await rm(join(engineOut, "vendor/pocketjs/framework/src/styles.generated.ts"), { force: true });

await cp(join(REPO_ROOT, "core/src"), join(resources, "core"), { recursive: true });

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

const du = Bun.spawn(["du", "-sh", resources, bin], { stdout: "pipe" });
console.log(`sidecar: ${pkgs.length} packages [${pkgs.join(", ")}]\nversion: ${version}\n${(await new Response(du.stdout).text()).trim()}`);
