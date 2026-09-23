# Native build and release status

The only desktop build is SwiftUI + AppKit in `native/`, with bundled Bun Core
and Pocket Motion. The previous desktop source and its release workflow have
been removed. Developer ID signing, notarization and DMG packaging run locally
with `scripts/release-native.ts` (below). **Release automation in CI and
automatic updates are not implemented.** Pushing a version tag does not create
a release or an update artifact.

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
  xcrun notarytool store-credentials pocket-paste-notary \
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
  --notary-profile pocket-paste-notary \
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
   `PeesutoCoreHost` (`com.peesuto.desktop.corehost`), then the bundle, which
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
6. Writes `<dmg>.sha256` and prints a summary (paths, sizes, identity,
   notarized).

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

- The first release ships **without automatic updates**. Choosing an update
  mechanism (Sparkle is the candidate) is a later decision; users update by
  downloading a new DMG.
- While `anelikes/peesuto` is private, GitHub Release assets are **not publicly
  downloadable**: only collaborators signed in to GitHub can fetch them. Host the
  DMG elsewhere (for example peesuto.com) or make the repository public before
  pointing users or a Homebrew cask at it.

## Before enabling public distribution

- Run a real notarized release build above with the Developer ID certificate.
- Test installing the notarized DMG on a fresh user profile on macOS 13.
- Choose and verify a native update mechanism (Sparkle is the suggested
  candidate). No release was ever published, so there are no earlier installs
  to bridge and no old update metadata to stay compatible with.
- Preserve `com.peesuto.desktop`, encrypted history and Keychain references;
  never run two app versions against the same production store concurrently.
- Complete the outstanding native privacy, focus/IME/multi-monitor and feature
  acceptance. Removing legacy source does not implement account/pack management,
  custom action editing or other missing native features.
- After these checks, implement a reviewed publishing workflow, tag the version
  from root `package.json`, update `CHANGELOG.md`, and provide a real Homebrew
  cask (N5). The old placeholder cask was removed; see
  [Homebrew status](homebrew/README.md).
