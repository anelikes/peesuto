#!/usr/bin/env bun
/** Builds a real native .app. --preview uses isolated synthetic data and no clipboard capture.
 * bun scripts/build-native.ts --engine <prepared pinned checkout> [--preview] [--skip-resources]
 */
import { existsSync } from "node:fs";
import { cp, mkdir, rm, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { engineRoot, REPO_ROOT } from "../core/src/engine.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const preview = args.includes("--preview");
/** Sparkle update feed and the EdDSA public key that verifies every update (public by design).
 * The private key lives only in the maintainer's login Keychain (docs/RELEASING.md).
 * Preview builds get neither, so they never check for updates. */
const SPARKLE_FEED_URL = "https://peesuto.com/appcast.xml";
const SPARKLE_PUBLIC_ED_KEY = "3mrnJuKG6QU3x2WO2ZtM2mGrIMxHeHmycaHvwpqBwao=";
const native = join(REPO_ROOT, "native");
const stage = join(native, ".bundle");
const target = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`;
async function run(command: string[], cwd = REPO_ROOT): Promise<void> {
  const p = Bun.spawn(command, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (await p.exited !== 0) throw new Error(`Native build failed: ${command[0]}`);
}
// Swift first: the bundle's render probe encodes an MP4 through the PeesutoEncoder it builds.
await run(["swift", "build", "--package-path", native, "-c", "release"]);
const encoder = join(native, ".build/release/PeesutoEncoder");
if (!args.includes("--skip-resources")) {
  const engine = resolve(flag("--engine") ?? engineRoot());
  const pin = await Bun.file(join(REPO_ROOT, "engine.json")).json();
  const p = Bun.spawn(["git", "-C", engine, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  const sha = (await new Response(p.stdout).text()).trim();
  if (await p.exited !== 0 || sha !== pin.sha) throw new Error("Prepare the engine.json pinned checkout and pass --engine <path>. Refusing to bundle a different engine.");
  await run([process.execPath, "scripts/bundle-sidecar.ts", "--engine", engine, "--out", stage, "--target", target, "--encoder", encoder]);
} else {
  if (!existsSync(join(stage, "resources/core/daemon.ts")) || !existsSync(join(stage, "binaries", `paste-${target}`))) throw new Error("No staged resources. Build once without --skip-resources.");
  console.log("Reusing staged Core/engine resources (--skip-resources).");
}
const name = preview ? "Peesuto Preview" : "Peesuto";
const app = join(native, "dist", `${name}.app`);
await rm(app, { recursive: true, force: true });
const macos = join(app, "Contents/MacOS");
const resources = join(app, "Contents/Resources");
await mkdir(macos, { recursive: true });
await mkdir(resources, { recursive: true });
// PeesutoEncoder sits next to the bundled Bun (Contents/MacOS/paste): Core finds it there for MP4.
for (const binary of ["Peesuto", "PeesutoCoreHost", "PeesutoEncoder"]) {
  await cp(join(native, ".build/release", binary), join(macos, binary));
  await chmod(join(macos, binary), 0o755);
}
// Sparkle (automatic updates). ditto keeps the framework's Versions/Current symlinks.
// The app is not sandboxed, so Sparkle's XPC services are not used: they are removed
// as Sparkle's "Removing XPC Services" documentation describes, and the framework is re-signed.
const frameworks = join(app, "Contents/Frameworks");
const sparkle = join(frameworks, "Sparkle.framework");
await mkdir(frameworks, { recursive: true });
await run(["ditto", join(native, ".build/release/Sparkle.framework"), sparkle]);
await rm(join(sparkle, "Versions/B/XPCServices"), { recursive: true, force: true });
await rm(join(sparkle, "XPCServices"), { force: true });
await cp(join(stage, "binaries", `paste-${target}`), join(macos, "paste"));
await chmod(join(macos, "paste"), 0o755);
await cp(join(stage, "resources"), join(resources, "resources"), { recursive: true });
await cp(join(native, "Resources/AppIcon.icns"), join(resources, "AppIcon.icns"));
// Onboarding sample cards (rendered by scripts/onboarding-assets.ts).
await cp(join(native, "Resources/Onboarding"), join(resources, "Onboarding"), { recursive: true });
// Template previews for Settings › Templates (rendered by scripts/template-previews.ts).
await cp(join(native, "Resources/TemplatePreviews"), join(resources, "TemplatePreviews"), { recursive: true });
const version = (await Bun.file(join(REPO_ROOT, "package.json")).json()).version;
// Monotonic build number: the commit count of the checked-out history.
const counter = Bun.spawn(["git", "-C", REPO_ROOT, "rev-list", "--count", "HEAD"], { stdout: "pipe", stderr: "pipe" });
const build = (await new Response(counter.stdout).text()).trim();
if (await counter.exited !== 0 || !/^\d+$/.test(build)) throw new Error("Could not compute the build number (git rev-list --count HEAD).");
await Bun.write(join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>${name}</string>
<key>CFBundleDisplayName</key><string>${name}</string>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleLocalizations</key><array><string>en</string><string>zh-Hans</string><string>ja</string></array>
<key>CFBundleIdentifier</key><string>com.peesuto.desktop${preview ? ".preview" : ""}</string>
<key>CFBundleExecutable</key><string>Peesuto</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${build}</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>PeesutoPreview</key><${preview ? "true" : "false"}/>
${preview ? "" : `<key>SUFeedURL</key><string>${SPARKLE_FEED_URL}</string>
<key>SUPublicEDKey</key><string>${SPARKLE_PUBLIC_ED_KEY}</string>
<key>SUEnableAutomaticChecks</key><true/>
<key>SUScheduledCheckInterval</key><integer>86400</integer>
`}</dict></plist>
`);
// Local development signature only. Developer ID/notarization remains N5 work.
await run(["codesign", "--force", "--sign", "-", "--entitlements", join(native, "Resources/Bun.entitlements.plist"), join(macos, "paste")]);
await run(["codesign", "--force", "--sign", "-", join(macos, "PeesutoCoreHost")]);
await run(["codesign", "--force", "--sign", "-", join(macos, "PeesutoEncoder")]);
await run(["codesign", "--force", "--sign", "-", sparkle]);
await run(["codesign", "--force", "--sign", "-", app]);
await run(["codesign", "--verify", "--deep", "--strict", app]);
console.log(`Built native app: ${app}`);
