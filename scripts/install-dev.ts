/**
 * Build, sign and install the current working tree over /Applications/Peesuto.app,
 * then relaunch it — for frequent local testing between releases.
 *
 *   bun scripts/install-dev.ts [--skip-build] [--no-launch]
 *
 * Signs with the Developer ID Application identity in the login keychain (or an
 * Apple Development one, else ad-hoc), without notarization: a locally built app
 * is not quarantined, so Gatekeeper does not check it. A stable team signature
 * keeps the Accessibility grant and the Keychain "Always Allow" across installs;
 * an ad-hoc build loses both every time.
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const APP = "/Applications/Peesuto.app";
const BUNDLE_ID = "com.peesuto.desktop";

async function sh(cmd: string[], opts: { quiet?: boolean; allowFailure?: boolean } = {}): Promise<string> {
  const p = Bun.spawn(cmd, { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  if (!opts.quiet) process.stdout.write(out);
  if (code !== 0 && !opts.allowFailure) { process.stderr.write(err); throw new Error(`${cmd.join(" ")} exited ${code}`); }
  return out;
}

const identities = await sh(["security", "find-identity", "-v", "-p", "codesigning"], { quiet: true });
const pick = (kind: string) => identities.split("\n").find((line) => line.includes(`"${kind}`))?.match(/\b([0-9A-F]{40})\b/)?.[1];
const identity = pick("Developer ID Application") ?? pick("Apple Development");
console.log(identity ? `identity: ${identities.split("\n").find((l) => l.includes(identity))!.replace(/.*"(.*)".*/, "$1")}` : "identity: none found, ad-hoc (Accessibility and Keychain grants will not survive reinstalls)");

if (identity) {
  const release = ["bun", "scripts/release-native.ts", "--identity", identity, "--no-notarize", "--no-dmg", ...(args.includes("--skip-build") ? ["--skip-build"] : ["--engine", join(REPO, ".work/native-engine")])];
  await sh(release);
} else if (!args.includes("--skip-build")) {
  await sh(["bun", "scripts/build-native.ts", "--engine", join(REPO, ".work/native-engine")]);
}

const built = join(REPO, "native/dist/Peesuto.app");
if (!existsSync(built)) throw new Error("no native/dist/Peesuto.app to install");

// Quit the running app (and its Core) before replacing it.
await sh(["osascript", "-e", `tell application id "${BUNDLE_ID}" to quit`], { quiet: true, allowFailure: true });
for (let i = 0; i < 40; i++) {
  const running = await sh(["pgrep", "-f", `${APP}/Contents/MacOS/`], { quiet: true, allowFailure: true });
  if (!running.trim()) break;
  await Bun.sleep(250);
}
await rm(APP, { recursive: true, force: true });
await sh(["ditto", built, APP]);
const version = (await sh(["/usr/libexec/PlistBuddy", "-c", "Print CFBundleShortVersionString", "-c", "Print CFBundleVersion", join(APP, "Contents/Info.plist")], { quiet: true })).trim().split("\n").join(" build ");
console.log(`installed ${APP} (${version})`);
if (!args.includes("--no-launch")) await sh(["open", APP]);
