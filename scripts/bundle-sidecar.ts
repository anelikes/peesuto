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
 *
 * The node_modules copies are pruned (PRUNE_* below) and the result must
 * render every template offline (scripts/bundle-render-probe.ts).
 */
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile, copyFile, chmod } from "node:fs/promises";
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
  // Of tools/ a render reads build.ts alone (the rest are device targets and benchmarks).
  "vendor/pocketjs/tools/build.ts", "vendor/pocketjs/framework", "vendor/pocketjs/contracts",
  "vendor/pocketjs/hosts/web", "vendor/pocketjs/tests/png.ts",
  // Noto Sans SC only: Core never sets a card in the engine's HarmonyOS Sans.
  "assets/fonts/NotoSansSC-Regular.otf", "assets/fonts/NotoSansSC-Bold.otf", "assets/fonts/NotoSansSC_LICENSE.txt",
  "assets/fonts/manifest.json", "assets/fonts/README.md",
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

/*
 * Pruning. The node_modules closures carry much that no render reads. What
 * goes was measured, not guessed: an atime trace of the bundled tree over
 * scripts/bundle-render-probe.ts (every template and variant as PNG and GIF,
 * the Noto face and its fallback, emoji, MP4 and the DSL card) and the engine
 * integration tests read 1,032 of 13,038 files. The rules below are
 * categories rather than that file list, and the same probe renders
 * everything from the pruned copy before this script succeeds, so a rule
 * that removes something a render needs fails the build.
 * Only the copies under --out are touched, never the engine checkout.
 */
/** Never loaded by a runtime: source maps, type declarations, Flow stubs, docs (licences stay). */
const PRUNE_FILE = /\.(map|d\.ts|d\.mts|d\.cts|flow)$|\.(md|markdown)$/i;
const KEEP_FILE = /^(LICEN[CS]E|NOTICE|COPYING)/i;
/** Vue's <script>-tag and browser-ESM builds; Bun resolves the bundler/node entries. */
const PRUNE_BROWSER_BUILD = /\.(global|esm-browser)(\.prod)?\.js$/;
/**
 * Engine closure packages no render reaches (zero files read in the trace):
 * type-only packages; Vue's runtime and SSR (Core writes Solid compositions,
 * only Vue's compiler is imported by tools/build.ts); Solid's SSR serializer;
 * build-plugin glue for Vite/webpack; Babel's config-file loaders the engine's
 * programmatic config never takes; `entities` (parse5 uses its own nested copy).
 * @babel/helpers is kept although unread: which helpers a transform injects
 * depends on the code it compiles.
 */
const PRUNE_PACKAGES = [
  "csstype", "@types/react", "@types/estree", "@types/estree-jsx",
  "@vue/runtime-dom", "@vue/runtime-core", "@vue/runtime-vapor", "@vue/reactivity", "@vue/server-renderer",
  "seroval", "seroval-plugins",
  "@vue-jsx-vapor/macros", "unplugin", "unplugin-utils", "webpack-virtual-modules", "ts-macro", "muggle-string",
  "pathe", "picomatch", "es-module-lexer", "hash-sum", "devalue", "escalade", "update-browserslist-db",
  "json5", "convert-source-map", "@jridgewell/remapping", "entities",
];
/** caniuse-lite's per-feature and per-region tables: browserslist reads them only for `supports …` and regional queries. */
const PRUNE_PATHS = ["caniuse-lite/data/features", "caniuse-lite/data/regions", "caniuse-lite/data/features.js"];

interface PruneTally { files: number; bytes: number }
const tally = new Map<string, PruneTally>();
function count(rule: string, bytes: number, files = 1): void {
  const t = tally.get(rule) ?? { files: 0, bytes: 0 };
  tally.set(rule, { files: t.files + files, bytes: t.bytes + bytes });
}
async function removeCounted(path: string, rule: string): Promise<void> {
  if (!existsSync(path)) throw new Error(`prune: ${path} is not there (engine or package changed? revisit the rule)`);
  let files = 0, bytes = 0;
  const st = await stat(path);
  if (st.isDirectory()) for (const f of new Bun.Glob("**/*").scanSync({ cwd: path, onlyFiles: true, dot: true })) { files++; bytes += (await stat(join(path, f))).size; }
  else { files = 1; bytes = st.size; }
  count(rule, bytes, files);
  await rm(path, { recursive: true, force: true });
}
/** Remove the non-runtime file categories anywhere under a node_modules tree. */
async function pruneFiles(nodeModules: string): Promise<void> {
  for (const f of new Bun.Glob("**/*").scanSync({ cwd: nodeModules, onlyFiles: true, dot: true })) {
    const name = f.slice(f.lastIndexOf("/") + 1);
    if (KEEP_FILE.test(name)) continue;
    const rule = PRUNE_FILE.test(name) ? "maps, type declarations, docs" : PRUNE_BROWSER_BUILD.test(name) ? "browser-only builds" : null;
    if (!rule) continue;
    count(rule, (await stat(join(nodeModules, f))).size);
    await rm(join(nodeModules, f));
  }
}

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
const engineNM = join(engineOut, "vendor/pocketjs/node_modules");
for (const name of PRUNE_PACKAGES) await removeCounted(join(engineNM, name), "unreached packages");
for (const p of PRUNE_PATHS) await removeCounted(join(engineNM, p), "caniuse-lite feature/region tables");
await pruneFiles(engineNM);
// A build regenerates this mirror; it must not carry one from the dev tree.
await rm(join(engineOut, "vendor/pocketjs/framework/src/styles.generated.ts"), { force: true });

await cp(join(REPO_ROOT, "core/src"), join(resources, "core"), { recursive: true });

// Core's own runtime packages (root package.json "dependencies") ship beside
// it. Without them the bundled Bun resolves nothing outside this repository,
// and by default would auto-install from the npm registry at runtime: a
// network request outside core's egress layer. The native app also launches
// Core with --no-install; the check below proves nothing is missing.
const ROOT_NM = join(REPO_ROOT, "node_modules");
/** Core modules the offline probe also imports (relative to resources/core). */
const CORE_ENTRY_MODULES = ["highlight.js/lib/core", "./templates/highlight.ts"];
/** Packages Core imports by subpath only; their main entry is pruned (highlight.js's loads every language). */
const SUBPATH_ONLY = new Set(["highlight.js"]);
const coreRoots = Object.keys((JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {});
const corePkgs = await packageClosure(coreRoots, ROOT_NM);
for (const name of coreRoots) if (!corePkgs.includes(name)) throw new Error(`core dependency ${name} is not installed; run bun install`);
for (const name of corePkgs) {
  await cp(join(ROOT_NM, name), join(resources, "core/node_modules", name), { recursive: true, dereference: true, filter: (f) => !/\/\.DS_Store$/.test(f) });
}

// highlight.js is some 9 MB with ~190 languages; Core registers a fixed set
// (LANGUAGE_NAMES in templates/highlight.ts, read from there), in both the
// CommonJS (lib/) and ESM (es/) trees, plus the package's own entry files.
if (corePkgs.includes("highlight.js")) {
  const hl = join(resources, "core/node_modules/highlight.js");
  const source = await readFile(join(REPO_ROOT, "core/src/templates/highlight.ts"), "utf8");
  const list = /const LANGUAGE_NAMES = \[([^\]]*)\]/.exec(source)?.[1];
  const languages = list ? [...list.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!) : [];
  if (!languages.length) throw new Error("bundle: cannot read LANGUAGE_NAMES from core/src/templates/highlight.ts");
  const keep = new Set(["package.json", "LICENSE", "es/package.json", "lib/core.js", "es/core.js",
    ...languages.flatMap((l) => [`lib/languages/${l}.js`, `es/languages/${l}.js`])]);
  for (const k of keep) if (!existsSync(join(hl, k))) throw new Error(`bundle: highlight.js lacks ${k}`);
  for (const f of new Bun.Glob("**/*").scanSync({ cwd: hl, onlyFiles: true, dot: true })) {
    if (keep.has(f)) continue;
    count("highlight.js unused languages", (await stat(join(hl, f))).size);
    await rm(join(hl, f));
  }
}
await pruneFiles(join(resources, "core/node_modules"));

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
    // Package names alone would load only each package's main entry: the
    // subpath entries core really imports (highlight.js/lib/core and its
    // languages) are proven by importing the modules that use them.
    const entries = [...coreRoots.filter((name) => !SUBPATH_ONLY.has(name)), ...CORE_ENTRY_MODULES];
    const script = entries.map((name) => `await import(${JSON.stringify(name)});`).join("") + `console.log("ok");`;
    const p = Bun.spawn([bin, "--no-install", "-e", script], { cwd: join(probe, "core"), stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(probe, "cache") } });
    const [stdout, stderr, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
    if (code !== 0 || stdout.trim() !== "ok") throw new Error(`bundled core cannot resolve its packages offline (${entries.join(", ")}):\n${stderr.trim()}`);
    console.log(`core packages: ${corePkgs.join(", ")} (resolve offline)`);
  } finally { await rm(probe, { recursive: true, force: true }); }
}

// Prove the pruned tree still renders, offline, with nothing but the bundle:
// scripts/bundle-render-probe.ts under the bundled Bun with --no-install, over
// copies outside this repository (renders write into the engine, as they do
// into the copy the app installs). A pruned file a render needs fails here.
{
  const probe = await mkdtemp(join(tmpdir(), "peesuto-render-probe-"));
  try {
    await cp(join(resources, "core"), join(probe, "core"), { recursive: true });
    await cp(engineOut, join(probe, "engine"), { recursive: true });
    const emoji = join(resources, "emoji");
    const ffmpeg = [Bun.which("ffmpeg"), "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((f): f is string => !!f && existsSync(f));
    const args = ["--core", join(probe, "core"), "--engine", join(probe, "engine"), "--out", join(probe, "out"),
      ...(existsSync(emoji) ? ["--emoji", emoji] : []), ...(ffmpeg ? ["--mp4", ffmpeg] : [])];
    const p = Bun.spawn([bin, "--no-install", join(REPO_ROOT, "scripts/bundle-render-probe.ts"), ...args], {
      cwd: join(probe, "core"), stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(probe, "cache") },
    });
    const [stdout, stderr, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
    const result = stdout.trim().split("\n").at(-1) ?? "";
    if (code !== 0 || !result.startsWith("ok ")) throw new Error(`bundled Core and engine cannot render every template from the pruned bundle:\n${stderr.trim().split("\n").filter((l) => !l.startsWith("templates:")).slice(-30).join("\n")}`);
    for (const line of stderr.split("\n")) if (line.startsWith("bundle-render-probe:")) console.warn(line);
    console.log(`render probe: ${result.slice(3)} (every template, PNG and GIF${ffmpeg ? ", MP4" : ""}; offline, from the bundle)`);
  } finally { await rm(probe, { recursive: true, force: true }); }
}

const pruned = [...tally].map(([rule, t]) => `  ${rule}: ${t.files} files, ${(t.bytes / 1048576).toFixed(1)} MiB`).join("\n");
console.log(`pruned from the bundle:\n${pruned}`);
const du = Bun.spawn(["du", "-sh", resources, bin], { stdout: "pipe" });
console.log(`sidecar: ${pkgs.length - PRUNE_PACKAGES.length} packages [${pkgs.filter((name) => !PRUNE_PACKAGES.includes(name)).join(", ")}]\nversion: ${version}\n${(await new Response(du.stdout).text()).trim()}`);
