# Homebrew

```sh
brew install --cask anelikes/tap/peesuto
```

The cask lives in its own tap,
[anelikes/homebrew-tap](https://github.com/anelikes/homebrew-tap)
(`Casks/peesuto.rb`): the official `homebrew/cask` repository requires more
GitHub stars, forks or watchers than Peesuto has yet
(`brew audit --new` reports "not notable enough"). Move it there once it
qualifies.

What the cask does:

- installs `Peesuto.app` from the notarized
  `Peesuto-<version>-arm64.dmg` of the GitHub Release `v<version>`;
- `depends_on arch: :arm64` and `depends_on macos: :ventura` (macOS 13 or
  later), matching the tested build;
- `auto_updates true`: the app updates itself with Sparkle, so `brew upgrade`
  skips it unless `--greedy`;
- `livecheck` reads https://peesuto.com/appcast.xml (`strategy :sparkle`,
  short version);
- plain `brew uninstall` keeps user data. `--zap` deletes
  `~/Library/Application Support/com.peesuto.desktop` (encrypted history,
  settings, cards), the caches, HTTP/WebKit storage, preferences, saved state
  and `~/.pocket-paste` (the engine copy used when the app-data path contains a
  space). Keychain items (service `com.peesuto.desktop`) and the Accessibility
  grant are not removed; the tap README tells people how.

Each release bumps `version` and `sha256` with `scripts/update-cask.ts`
([RELEASING.md](../RELEASING.md), "Publishing an update", step 6). Check with
`brew style` in the tap and
`brew audit --cask --strict --online anelikes/tap/peesuto`.

ffmpeg (MP4 only) is not a cask dependency; people install it with
`brew install ffmpeg` when they want video.
