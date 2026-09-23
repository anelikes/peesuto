#!/usr/bin/env bun
/** Signs, verifies, packages and (optionally) notarizes the native app as a DMG.
 * bun scripts/release-native.ts --identity "<codesign identity>" [--notary-profile <keychain profile>]
 *   [--skip-build] [--engine <prepared engine>] [--no-notarize]
 *
 * --identity        codesign identity name or SHA-1 (Developer ID Application for a public release).
 * --notary-profile  `xcrun notarytool store-credentials` profile; required unless --no-notarize.
 * --skip-build      sign the existing native/dist/Peesuto.app instead of rebuilding it.
 * --engine          prepared pinned engine checkout for the build (default .work/native-engine).
 * --no-notarize     offline dry run: no secure timestamp, no notarization; Gatekeeper checks are
 *                   reported but do not fail (expected with a development certificate).
 * Never pass secrets on the command line; notarytool reads them from the keychain profile.
 */
import { existsSync } from "node:fs";
import { mkdir, open, readdir, rm, stat, symlink } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { REPO_ROOT } from "../core/src/engine.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const identity = flag("--identity");
const notaryProfile = flag("--notary-profile");
const skipBuild = args.includes("--skip-build");
const notarize = !args.includes("--no-notarize");
const engine = resolve(flag("--engine") ?? join(REPO_ROOT, ".work/native-engine"));

const native = join(REPO_ROOT, "native");
const app = join(native, "dist", "Peesuto.app");
const macos = join(app, "Contents/MacOS");
const resources = join(app, "Contents/Resources");
const bunEntitlements = join(native, "Resources/Bun.entitlements.plist");
const arch = process.arch === "arm64" ? "arm64" : "x86_64";

function fail(message: string): never { console.error(`release-native: ${message}`); process.exit(1); }
if (!identity) fail("--identity \"<codesign identity>\" is required (see `security find-identity -v -p codesigning`).");
if (notarize && !notaryProfile) fail("--notary-profile <profile> is required unless --no-notarize.");

async function run(command: string[], options: { allowFailure?: boolean; quiet?: boolean } = {}): Promise<{ code: number; out: string }> {
  if (!options.quiet) console.log(`$ ${command.map(a => /[\s"]/.test(a) ? JSON.stringify(a) : a).join(" ")}`);
  const p = Bun.spawn(command, { cwd: REPO_ROOT, stdin: "inherit", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (!options.quiet) { if (out.trim()) console.log(out.trimEnd()); if (err.trim()) console.log(err.trimEnd()); }
  if (code !== 0 && !options.allowFailure) fail(`${command[0]} ${command[1] ?? ""} exited ${code}`);
  return { code, out: out + err };
}

// Resolve the identity against the keychain so a typo fails before a long build.
const identities = (await run(["security", "find-identity", "-v", "-p", "codesigning"], { quiet: true })).out;
const line = identities.split("\n").find(l => l.includes(`"${identity}"`) || l.includes(identity.toUpperCase()));
if (!line) fail(`codesign identity not found in the keychain: ${identity}`);
const identityName = line.match(/"(.+)"/)?.[1] ?? identity;
const developerId = identityName.startsWith("Developer ID Application:");
if (notarize && !developerId) fail(`notarization needs a "Developer ID Application" identity, got "${identityName}". Use --no-notarize for a local dry run.`);

// 1. Build.
if (!skipBuild) {
  const p = Bun.spawn([process.execPath, "scripts/build-native.ts", "--engine", engine], { cwd: REPO_ROOT, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (await p.exited !== 0) fail("native build failed");
}
if (!existsSync(join(macos, "Peesuto"))) fail(`no app at ${app}; build it first or drop --skip-build.`);
const version: string = (await Bun.file(join(REPO_ROOT, "package.json")).json()).version;

// 2. Sign inside-out with the hardened runtime. No --deep signing.
const timestamp = notarize ? "--timestamp" : "--timestamp=none";
const sign = (path: string, extra: string[] = []) =>
  run(["codesign", "--force", "--options", "runtime", timestamp, "--sign", identity, ...extra, path]);

const MACHO = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]);
async function isMachO(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(8);
    const { bytesRead } = await handle.read(buf, 0, 8, 0);
    if (bytesRead < 8) return false;
    const magic = buf.readUInt32BE(0);
    if (MACHO.has(magic)) return true;
    // Universal binary; Java class files share 0xcafebabe but carry a large version number.
    return magic === 0xcafebabe && buf.readUInt32BE(4) < 32;
  } finally { await handle.close(); }
}
async function walk(dir: string, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, found);
    else if (entry.isFile() && await isMachO(path)) found.push(path);
  }
  return found;
}
const nested = (await walk(resources)).sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b));
console.log(`Signing ${nested.length} Mach-O file(s) inside Contents/Resources.`);
for (const path of nested) await sign(path);
await sign(join(macos, "paste"), ["--identifier", "com.peesuto.desktop.paste", "--entitlements", bunEntitlements]);
await sign(join(macos, "PeesutoCoreHost"), ["--identifier", "com.peesuto.desktop.corehost"]);
// The bundle signature covers the main executable (Contents/MacOS/Peesuto). It needs no
// entitlements: Accessibility and pasteboard access are TCC permissions, not entitlements.
await sign(app);

// 3. Verify.
await run(["codesign", "--verify", "--strict", "--deep", "--verbose=2", app]);
await run(["codesign", "-d", "--entitlements", "-", "--xml", join(macos, "paste")]);

/** Staple with retries: Apple's ticket service (CloudKit) is reached over the
 * network and fails transiently (TLS errors, error 68). */
async function staple(file: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const result = await run(["xcrun", "stapler", "staple", file], { allowFailure: true });
    if (result.code === 0) return;
    if (attempt >= 5) fail(`stapling ${basename(file)} kept failing (exit ${result.code}); rerun later with --skip-build.`);
    console.log(`stapler failed (exit ${result.code}); retrying in ${attempt * 15} s`);
    await Bun.sleep(attempt * 15_000);
  }
}

/** Submit a file for notarization and wait; returns the submission id, or fails with Apple's log. */
async function notarizeFile(file: string): Promise<string> {
  const result = await run(["xcrun", "notarytool", "submit", file, "--keychain-profile", notaryProfile!, "--wait", "--output-format", "json"], { allowFailure: true });
  let parsed: { id?: string; status?: string } = {};
  try { parsed = JSON.parse(result.out.slice(result.out.indexOf("{"), result.out.lastIndexOf("}") + 1)); } catch {}
  const id = parsed.id ?? "";
  console.log(`Notarization of ${basename(file)}: id ${id || "(unknown)"}, status ${parsed.status ?? "(unknown)"}`);
  if (result.code !== 0 || parsed.status !== "Accepted") {
    if (id) await run(["xcrun", "notarytool", "log", id, "--keychain-profile", notaryProfile!], { allowFailure: true });
    fail(`notarization of ${basename(file)} was not accepted; see the log above.`);
  }
  return id;
}

// 3b. Notarize and staple the app itself, so a first launch works offline
// after it is copied out of the DMG (a ticket stapled only to the DMG does
// not travel with the app).
const submissions: string[] = [];
if (notarize) {
  const zip = join(REPO_ROOT, ".work/release/Peesuto-app.zip");
  await mkdir(join(REPO_ROOT, ".work/release"), { recursive: true });
  await rm(zip, { force: true });
  await run(["ditto", "-c", "-k", "--keepParent", app, zip]);
  submissions.push(await notarizeFile(zip));
  await rm(zip, { force: true });
  await staple(app);
  await run(["xcrun", "stapler", "validate", app]);
}
const gatekeeperApp = await run(["spctl", "-a", "-vv", "-t", "exec", app], { allowFailure: true });
if (gatekeeperApp.code !== 0) console.log(notarize
  ? "spctl rejected the stapled app."
  : "spctl rejected the app (expected without a notarized Developer ID signature); continuing because of --no-notarize.");
if (notarize && gatekeeperApp.code !== 0) fail("Gatekeeper rejects the notarized app.");

// 4. DMG with the app and an /Applications link.
const dmgName = `Peesuto-${version}-${arch}.dmg`;
const dmg = join(native, "dist", dmgName);
const staging = join(REPO_ROOT, ".work/release/dmg-root");
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await run(["ditto", app, join(staging, "Peesuto.app")]);
await symlink("/Applications", join(staging, "Applications"));
await rm(dmg, { force: true });
await run(["hdiutil", "create", "-volname", "Peesuto", "-srcfolder", staging, "-ov", "-format", "UDZO", "-fs", "HFS+", dmg]);
await rm(staging, { recursive: true, force: true });
await run(["codesign", "--force", timestamp, "--sign", identity, dmg]);
await run(["codesign", "--verify", "--verbose=2", dmg]);

// 5. Notarize the DMG (it holds the stapled app), staple, verify.
if (notarize) {
  submissions.push(await notarizeFile(dmg));
  await staple(dmg);
  await run(["xcrun", "stapler", "validate", dmg]);
  await run(["spctl", "-a", "-vv", "-t", "open", "--context", "context:primary-signature", dmg]);
}

// 6. Checksum and summary.
const hasher = new Bun.CryptoHasher("sha256");
hasher.update(await Bun.file(dmg).arrayBuffer());
const digest = hasher.digest("hex");
await Bun.write(`${dmg}.sha256`, `${digest}  ${dmgName}\n`);
const appKb = (await run(["du", "-sk", app], { quiet: true })).out.split(/\s/)[0];
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const dmgBytes = (await stat(dmg)).size;
console.log(`
Release summary
  app        ${relative(REPO_ROOT, app)} (${mb(Number(appKb) * 1024)})
  dmg        ${relative(REPO_ROOT, dmg)} (${mb(dmgBytes)})
  sha256     ${digest}  (${basename(dmg)}.sha256)
  version    ${version} (${arch})
  identity   ${identityName}${developerId ? "" : " (not Developer ID: local use only)"}
  notarized  ${notarize ? `yes (app ${submissions[0]}, dmg ${submissions[1]}; both stapled)` : "no (--no-notarize)"}
  gatekeeper app ${gatekeeperApp.code === 0 ? "accepted" : "rejected"}`);
