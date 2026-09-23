# Homebrew distribution status

There is no supported native Peesuto cask yet. The old desktop's placeholder
cask was removed because its download URL, DMG name and updater assumptions do
not describe a native release.

For local builds, follow [native development](../../native/README.md). Do not
publish a cask pointing at a CI validation ZIP or an old desktop artifact.

Once a signed/notarized native release exists, create the cask using its actual
version, archive/DMG URL and SHA-256. Match its tested CPU and minimum-macOS
requirements; install `Peesuto.app` and document ffmpeg requirements separately.
Preserve existing user data during installation/upgrades. Any optional `zap`
cleanup must be explicit and distinguish encrypted history from disposable
caches. Release prerequisites are in [RELEASING.md](../RELEASING.md).
