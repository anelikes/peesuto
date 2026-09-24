# Native build and release status

The only desktop build is SwiftUI + AppKit in `native/`, with bundled Bun Core
and Pocket Motion. The previous desktop source and its release workflow have
been removed. Developer ID signing, notarization and DMG packaging run locally
with `scripts/release-native.ts` (below), which also signs the update and writes
the Sparkle appcast ([Automatic updates](#automatic-updates-sparkle)). **Release
automation in CI is not implemented and nothing is published automatically.**
Pushing a version tag does not create a release or an update artifact.

## Build a local validation bundle

From the repository root on macOS:

```sh
bun install --frozen-lockfile
swift test --package-path native
bun scripts/fetch-emoji.ts
bun scripts/build-native.ts --engine /absolute/path/to/prepared-pinned-engine
native/.build/release/PeesutoSmoke native/dist/Peesuto.app
open native/dist/Peesuto.app
```

The engine checkout must match `engine.json`. Prepare a dedicated checkout with
`scripts/engine.ts`; do not edit a separate engine working tree to make a release.
`native/dist/Peesuto.app` includes the native executable, Core host, Bun and
engine resources. Its version comes from the root `package.json`; the build
currently uses a local ad-hoc signature. This is not a notarized distribution.
See [native development](../native/README.md) for preview isolation and resource
rebuild rules. A bare Swift build is not a complete application bundle.

MP4 additionally needs a locally installed ffmpeg. Where available, run:

```sh
native/.build/release/PeesutoSmoke native/dist/Peesuto.app --video
```

The smoke uses synthetic data, a temporary directory and local rules/offline
mode. It does not read production history or user Keychain credentials. Actual
window, permission and cross-application paste testing remains necessary.

## Install the working tree for testing

```sh
bun run install-dev            # build, sign, replace /Applications/Peesuto.app, relaunch
bun run install-dev --skip-build   # re-sign and reinstall the last build
```

`scripts/install-dev.ts` signs with the Developer ID identity in the login
keychain but does not notarize (a locally built app is not quarantined). The
stable team signature keeps Accessibility and the Keychain grant across
installs. The About section shows the version and the build number (the
commit count) to tell installs apart. These builds carry the Sparkle updater and
check https://peesuto.com/appcast.xml daily; until the feed exists the
background check fails silently.

## CI and manual build artifacts

`.github/workflows/ci.yml` runs Core typechecks/unit tests, native Swift tests
and release compilation, plus pinned-engine fixtures and a complete native
bundle PNG/GIF smoke on macOS. The macOS jobs run on `macos-15` with Xcode 16.4
selected explicitly (the native code needs Swift 6.x). Engine Rust/WASM
compilation remains required and stays pinned to Rust 1.97.1.

`.github/workflows/release.yml` is now **manual validation only**. The workflow
named “native validation build” builds and verifies the same native `.app`,
then uploads `Peesuto-native-validation.zip` as a workflow artifact. It does
not create or publish GitHub Releases, use signing secrets, generate update
metadata or modify a Homebrew tap. These workflow definitions have not been
verified by a remote run merely because local checks pass.

**The artifact is arm64 (Apple Silicon) only.** The build targets the build
machine's architecture and the runner is Apple Silicon; there is no universal
or x86_64 build. The minimum system is **macOS 13.0**, set by the bundled Bun
binary (see `PLAN.md` §5).

## Signing, notarization and DMG

`scripts/release-native.ts` builds the app, signs it with the hardened runtime,
packages a DMG, notarizes and staples it. It runs on the maintainer's Mac; CI
does not sign yet (add the same steps to `release.yml` only after a real
notarized run passes locally).

### Maintainer prerequisites (one time)

- A **Developer ID Application** certificate in the login keychain. Only the
  Apple Developer team's Account Holder can create it: generate a CSR in
  Keychain Access (Certificate Assistant, "Request a Certificate From a
  Certificate Authority", saved to disk), have the Account Holder issue a
  Developer ID Application certificate from it, then double-click the
  downloaded `.cer` so it pairs with the private key. Keep a `.p12` export
  (certificate plus private key) as a backup and for future CI.
- An **app-specific password** for the Apple ID (appleid.apple.com, Sign-In
  and Security), used only for notarization.
- Store the notarization credentials once in the keychain. notarytool prompts
  for the app-specific password, so it never appears in shell history:

  ```sh
  xcrun notarytool store-credentials pocket-paste \
    --apple-id "<apple id>" --team-id "<team id>"
  ```

- Confirm the identity is visible:

  ```sh
  security find-identity -v -p codesigning | grep "Developer ID Application"
  ```

- For CI later: the `.p12`, its password, the identity, Apple ID, app-specific
  password and team ID become repository secrets, set by the maintainer with
  `gh secret set`. Agents never handle secret values.

### Release build

```sh
bun scripts/release-native.ts \
  --identity "Developer ID Application: <name> (<team id>)" \
  --notary-profile pocket-paste \
  --engine "$PWD/.work/native-engine"
```

Options: `--skip-build` signs the existing `native/dist/Peesuto.app`;
`--engine` defaults to `.work/native-engine` (a prepared checkout matching
`engine.json`); `--identity` also accepts the SHA-1 hash printed by
`security find-identity`. Notarization is refused for an identity that is not
Developer ID Application.

What it does:

1. Runs `scripts/build-native.ts` (skipped with `--skip-build`).
2. Signs inside-out with `codesign --force --options runtime --timestamp`, no
   `--deep`: every Mach-O file under `Contents/Resources` (found by magic bytes,
   currently the engine's `compiler-rs.darwin-arm64.node`), then
   `Contents/MacOS/paste` (bundled Bun, identifier `com.peesuto.desktop.paste`,
   entitlements `native/Resources/Bun.entitlements.plist`), then
   `PeesutoCoreHost` (`com.peesuto.desktop.corehost`), then Sparkle as its
   "Sandboxing and code signing" guide lists (`Versions/B/Autoupdate`,
   `Versions/B/Updater.app`, then `Contents/Frameworks/Sparkle.framework`),
   then the bundle, which
   signs the main executable. The app itself has no entitlements:
   Accessibility and pasteboard access are TCC permissions, not entitlements.
3. Verifies with `codesign --verify --strict --deep --verbose=2`, prints Bun's
   entitlements (`codesign -d --entitlements - --xml`) and reports
   `spctl -a -vv -t exec` (rejected until notarized; not fatal).
4. Creates `native/dist/Peesuto-<version>-arm64.dmg` (version from root
   `package.json`; UDZO, volume name "Peesuto", the app plus an
   `/Applications` link) and signs the DMG.
5. `xcrun notarytool submit <dmg> --keychain-profile <profile> --wait`, prints
   the submission id and, on failure, `notarytool log <id>`; then
   `xcrun stapler staple`, `xcrun stapler validate` and
   `spctl -a -vv -t open --context context:primary-signature <dmg>`.
6. Signs the notarized DMG for Sparkle and adds it to `site/appcast.xml`
   (`scripts/appcast.ts`; skipped with `--no-notarize`).
7. Writes `<dmg>.sha256` and prints a summary (paths, sizes, identity,
   notarized, appcast).

The bundled Bun needs `com.apple.security.cs.allow-jit` under the hardened
runtime: without it the Core still works, but JavaScriptCore falls back to its
interpreter and a GIF render took about 9 s instead of 0.75 s.
`allow-unsigned-executable-memory` and `disable-library-validation` are kept as
Bun recommends for compiled executables loading native addons.

### Manual verification of the result

```sh
codesign --verify --strict --deep --verbose=2 native/dist/Peesuto.app
xcrun stapler validate native/dist/Peesuto-<version>-arm64.dmg
spctl -a -vv -t open --context context:primary-signature native/dist/Peesuto-<version>-arm64.dmg
shasum -a 256 -c native/dist/Peesuto-<version>-arm64.dmg.sha256   # run inside native/dist
native/.build/release/PeesutoSmoke native/dist/Peesuto.app --video
```

Then copy the app from the mounted DMG to `/Applications` on a clean macOS 13+
user account and open it: Gatekeeper must show the normal "downloaded from the
internet" prompt, not a malware or unidentified-developer block.

### Local dry run without the Developer ID certificate

Any Apple Development identity exercises the same signing path offline (no
secure timestamp, no notarization; spctl rejections are reported, not fatal):

```sh
bun scripts/release-native.ts --identity "<Apple Development identity or SHA-1>" --no-notarize
native/.build/release/PeesutoSmoke native/dist/Peesuto.app --video
```

Do not distribute that DMG.

### Distribution notes

- 0.1.0 and 0.1.1 have no updater: anyone who installed them downloads the
  first Sparkle-enabled DMG once by hand; from then on updates arrive in the app.
- While `anelikes/peesuto` is private, GitHub Release assets are **not publicly
  downloadable**: only collaborators signed in to GitHub can fetch them. Host the
  DMG elsewhere (for example peesuto.com) or make the repository public before
  pointing users or a Homebrew cask at it.

## Automatic updates (Sparkle)

The app embeds [Sparkle 2](https://sparkle-project.org) (SwiftPM dependency of
the `Peesuto` target, pinned in `native/Package.resolved`).
`scripts/build-native.ts` copies `Sparkle.framework` into
`Contents/Frameworks` (the executable has the `@executable_path/../Frameworks`
rpath) and removes the framework's XPC services, which only sandboxed apps
need; Peesuto is not sandboxed. The generated `Info.plist` sets:

| Key | Value |
|---|---|
| `SUFeedURL` | `https://peesuto.com/appcast.xml` |
| `SUPublicEDKey` | the EdDSA public key in `scripts/build-native.ts` |
| `SUEnableAutomaticChecks` | `true` |
| `SUScheduledCheckInterval` | `86400` (daily) |

Preview builds (`--preview`, `com.peesuto.desktop.preview`) get none of these
keys and never start the updater (`UpdaterConfiguration` in PeesutoKit, tested
in `UpdaterConfigurationTests`). In the app: "Check for Updates…" in the menu
bar menu and the app menu, and Settings › General › "Automatically check for
updates" with the current version.

### The EdDSA signing key

Updates are accepted only when signed by the private key matching
`SUPublicEDKey`. The key pair was created once with Sparkle's `generate_keys`
(`native/.build/artifacts/sparkle/Sparkle/bin/`, present after
`swift package resolve --package-path native`), which keeps the **private key
in the maintainer's login Keychain** (generic password, service
`https://sparkle-project.org`, account `ed25519`). Running `generate_keys` again prints the existing
public key; `generate_keys -p` prints only the public key.

**Back it up now (maintainer only).** Losing the private key means every
installed copy can never accept another update: users would have to download a
new DMG by hand, and the app would need a new public key. Export it to a secure
place of your choice (for example as a password manager attachment) and delete
any temporary file:

```sh
native/.build/artifacts/sparkle/Sparkle/bin/generate_keys -x <file>
```

On another Mac, `generate_keys -f <file>` imports it. Agents never export,
print or copy the private key.

### Publishing an update

1. Bump the version in root `package.json`, rename `## Unreleased` in
   `CHANGELOG.md` to `## <version> — <date>` (its body becomes the release
   notes in the feed), and commit.
2. Build, sign, notarize and staple the DMG, then sign the update and write the
   feed:

   ```sh
   bun scripts/release-native.ts --identity "Developer ID Application: <name> (<team id>)" \
     --notary-profile pocket-paste --engine "$PWD/.work/native-engine"
   ```

   After the DMG is notarized it runs `scripts/appcast.ts`, which calls
   Sparkle's `sign_update` on the DMG (EdDSA signature and length; macOS may ask
   to allow Keychain access) and adds an `<item>` to `site/appcast.xml`:
   `sparkle:version` = `CFBundleVersion` (the build number Sparkle compares),
   `sparkle:shortVersionString`, `pubDate`, `minimumSystemVersion` 13.0, the
   release notes, and an enclosure at
   `https://github.com/anelikes/peesuto/releases/download/v<version>/Peesuto-<version>-arm64.dmg`.
   Items stay newest first; rerunning for the same build replaces its item. To
   redo only this step: `bun scripts/appcast.ts --dmg native/dist/Peesuto-<version>-arm64.dmg --build <build> [--dry-run]`.
3. Commit `site/appcast.xml`.
4. Create the GitHub Release `v<version>` and upload the DMG (and `.sha256`), plus a copy named `Peesuto.dmg` (the website's Download button is `releases/latest/download/Peesuto.dmg`)
   **exactly as signed**; any change to the file invalidates the signature. The
   repository must be public (or the enclosure hosted elsewhere) for the
   download to work.
5. Deploy `site/` (the future peesuto.com root, Cloudflare Pages) so
   `https://peesuto.com/appcast.xml` serves the new feed. Publish the DMG
   before the feed, never the other way round.
6. Bump the Homebrew cask in the tap
   [anelikes/homebrew-tap](https://github.com/anelikes/homebrew-tap)
   (`brew install --cask anelikes/tap/peesuto`) once the release assets are
   public:

   ```sh
   git clone https://github.com/anelikes/homebrew-tap.git ../homebrew-tap   # once
   bun scripts/update-cask.ts --tap ../homebrew-tap --dmg native/dist/Peesuto-<version>-arm64.dmg
   brew update && brew audit --cask --strict --online anelikes/tap/peesuto
   ```

   The script rewrites `version` and `sha256` in `Casks/peesuto.rb` (the URL
   interpolates the version), commits with `-s` and pushes; `--dry-run` prints
   the new cask, `--no-push` commits only. Hash the DMG exactly as uploaded.
   The cask is `auto_updates true`, so Homebrew users get updates from Sparkle
   anyway; the bump keeps fresh installs and `brew upgrade --greedy` current.

## Before enabling public distribution

- Run a real notarized release build above with the Developer ID certificate.
- Test installing the notarized DMG on a fresh user profile on macOS 13.
- Verify the Sparkle path end to end once: install version N, publish N+1 to
  a test feed, and let the app update itself. No release was ever published, so
  there is no older update metadata to stay compatible with.
- Preserve `com.peesuto.desktop`, encrypted history and Keychain references;
  never run two app versions against the same production store concurrently.
- Complete the outstanding native privacy, focus/IME/multi-monitor and feature
  acceptance. Removing legacy source does not implement account/pack management,
  custom action editing or other missing native features.
- After these checks, implement a reviewed publishing workflow, tag the version
  from root `package.json` and update `CHANGELOG.md`. The Homebrew cask exists
  since 0.2.0 in the own tap; see [Homebrew](homebrew/README.md).
