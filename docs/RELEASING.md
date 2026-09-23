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
bundle PNG/GIF smoke on macOS. Engine Rust/WASM compilation remains required.

`.github/workflows/release.yml` is now **manual validation only**. The workflow
named “native validation build” builds and verifies the same native `.app`,
then uploads `Peesuto-native-validation.zip` as a workflow artifact. It does
not create or publish GitHub Releases, use signing secrets, generate update
metadata or modify a Homebrew tap. These workflow definitions have not been
verified by a remote run merely because local checks pass.

## Before enabling public distribution

- Implement and verify Developer ID signing for the app and every nested
  executable, with the Bun runtime entitlements it requires; notarize and
  staple the deliverable. Existing secrets are not read or changed by this work.
- Define reproducible installer/archive names, checksums, architecture and
  minimum-OS support; test installation on a fresh user profile.
- Choose and verify a native update mechanism. Historical updater signatures
  and metadata are not compatible by assumption; do not reuse old artifacts.
- Establish a tested manual replacement or update bridge for earlier installs.
  Preserve `com.peesuto.desktop`, encrypted history and Keychain references;
  never run two app versions against the same production store concurrently.
- Complete the outstanding native privacy, focus/IME/multi-monitor and feature
  acceptance. Removing legacy source does not implement account/pack management,
  custom action editing or other missing native features.
- After these checks, implement a reviewed publishing workflow, tag the version
  from root `package.json`, update `CHANGELOG.md`, and provide a real Homebrew
  cask. The old placeholder cask was removed; see [Homebrew status](homebrew/README.md).

Keep historical release artifacts available for diagnosis or manual rollback;
this source cleanup does not delete releases, installed apps or user data.
