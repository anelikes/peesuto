#!/usr/bin/env bun
/** Homebrew cask bump: rewrites `version` and `sha256` in Casks/peesuto.rb of a local
 * clone of github.com/anelikes/homebrew-tap, then commits and pushes it.
 *
 * bun scripts/update-cask.ts --tap <clone of anelikes/homebrew-tap>
 *   [--version <short version>] [--dmg <dmg> | --sha256 <hex>] [--no-push] [--dry-run]
 *
 * --version  defaults to the root package.json version.
 * --dmg      the DMG exactly as uploaded to the GitHub Release; defaults to
 *            native/dist/Peesuto-<version>-arm64.dmg. --sha256 skips hashing.
 * --no-push  commit only.  --dry-run  print the new cask, change nothing.
 * Nothing changes (and nothing is committed) when the cask already has this
 * version and checksum. Run it only after the release assets are public: the
 * cask points at releases/download/v<version>/Peesuto-<version>-arm64.dmg.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const CASK_PATH = "Casks/peesuto.rb";

/** The cask text with its version and sha256 stanzas replaced. Throws when either is missing. */
export function bumpCask(text: string, version: string, sha256: string): string {
  if (!/^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$/.test(version)) throw new Error(`not a version: ${version}`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`not a SHA-256: ${sha256}`);
  const versionLine = /^(\s*)version "[^"]*"$/m;
  const shaLine = /^(\s*)sha256 "[^"]*"$/m;
  if (!versionLine.test(text) || !shaLine.test(text)) throw new Error("cask has no version/sha256 stanza");
  return text.replace(versionLine, `$1version "${version}"`).replace(shaLine, `$1sha256 "${sha256}"`);
}

function run(cmd: string[], cwd: string): string {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed:\n${result.stderr.toString()}`);
  return result.stdout.toString();
}

function tryRun(cmd: string[], cwd: string): boolean {
  return Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" }).exitCode === 0;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
    return value;
  };
  const root = resolve(import.meta.dir, "..");
  const tap = option("--tap");
  if (!tap) throw new Error("usage: bun scripts/update-cask.ts --tap <clone of anelikes/homebrew-tap> [--version v] [--dmg f | --sha256 h] [--no-push] [--dry-run]");
  const tapDir = resolve(tap);
  const caskFile = join(tapDir, CASK_PATH);
  if (!existsSync(caskFile)) throw new Error(`${caskFile} not found (is --tap a clone of anelikes/homebrew-tap?)`);
  const version = option("--version") ?? (await Bun.file(join(root, "package.json")).json()).version as string;
  const dryRun = args.includes("--dry-run");
  const push = !args.includes("--no-push") && !dryRun;

  let sha256 = option("--sha256")?.toLowerCase();
  if (!sha256) {
    const dmg = resolve(option("--dmg") ?? join(root, "native/dist", `Peesuto-${version}-arm64.dmg`));
    if (!existsSync(dmg)) throw new Error(`${dmg} not found; pass --dmg or --sha256`);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(await Bun.file(dmg).arrayBuffer());
    sha256 = hasher.digest("hex");
  }

  if (!dryRun) {
    if (run(["git", "status", "--porcelain"], tapDir).trim()) throw new Error(`${tapDir} has uncommitted changes`);
    run(["git", "pull", "--rebase", "--quiet"], tapDir);
  }
  const before = await Bun.file(caskFile).text();
  const after = bumpCask(before, version, sha256);
  if (after === before) {
    console.log(`${CASK_PATH} already at ${version} (${sha256}); nothing to do.`);
    return;
  }
  if (dryRun) {
    console.log(after);
    return;
  }
  await Bun.write(caskFile, after);
  run(["git", "add", CASK_PATH], tapDir);
  run(["git", "commit", "-s", "--quiet", "-m", `peesuto ${version}\n\nNew Peesuto release: point the cask at the v${version} DMG and its checksum.`], tapDir);
  console.log(run(["git", "log", "--oneline", "-1"], tapDir).trim());
  if (!push) return;
  if (!tryRun(["git", "push", "--quiet"], tapDir)) {
    run(["git", "pull", "--rebase", "--quiet"], tapDir);
    if (!tryRun(["git", "push", "--quiet"], tapDir)) throw new Error("git push failed; resolve and push by hand (never force)");
  }
  console.log(`pushed; check with: brew update && brew audit --cask --strict --online anelikes/tap/peesuto`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
