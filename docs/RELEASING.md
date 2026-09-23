# Native build and release status

The only desktop build is SwiftUI + AppKit in `native/`, with bundled Bun Core
and Pocket Motion. The previous desktop source and its release workflow have
been removed. **Public release automation, Developer ID signing, notarization,
DMG delivery and automatic updates are not implemented for the native app.**
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

## Signing & notarization (to do, N5)

Nothing below is implemented; the current bundle is ad-hoc signed.

What the maintainer must provide:

- A **Developer ID Application** certificate. Only the Apple Developer team's
  Account Holder can create it: generate a CSR locally, have the Account
  Holder issue the certificate, then export it with its private key as a
  `.p12`.
- Notarization credentials: an app-specific password (or App Store Connect
  API key) for `xcrun notarytool store-credentials`.
- For CI, the certificate, its password, the signing identity, the Apple ID,
  the app-specific password and the team ID as repository secrets, set by the
  maintainer with `gh secret set`. Agents never handle secret values.

Work still to do:

- Enable the hardened runtime (`codesign --options runtime`) with a secure
  timestamp for every signed Mach-O.
- Sign inside-out: the bundled Bun binary (`paste`) separately with its own
  entitlements (`native/Resources/Bun.entitlements.plist`; Bun's JIT needs
  them under the hardened runtime), every nested `.node` or other Mach-O file in the engine resources,
  `PeesutoCoreHost`, then the app bundle. No `--deep`.
- `xcrun notarytool submit --wait` the archive or DMG, then
  `xcrun stapler staple` and verify with `spctl -a -vv` and
  `codesign --verify --strict --deep`.
- Add these steps to `release.yml` only after they pass locally.

## Before enabling public distribution

- Complete signing and notarization above.
- Define reproducible installer/archive names (DMG) and checksums; test
  installation on a fresh user profile on macOS 13.
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
