# Cask skeleton for anelikes/homebrew-tap (Casks/pocket-paste.rb).
# Per release: set `version`, then `sha256` to `shasum -a 256 <the DMG>`.
# The asset name comes from productName and version in
# app/src-tauri/tauri.conf.json; GitHub turns the space in "Pocket Paste"
# into a dot in the asset name. Check it against the release page once.
cask "pocket-paste" do
  version "0.0.0" # TODO(release): the tagged version, without the leading v
  sha256 "0000000000000000000000000000000000000000000000000000000000000000" # TODO(release): shasum -a 256 of the DMG

  url "https://github.com/anelikes/pocket-paste/releases/download/v#{version}/Pocket.Paste_#{version}_aarch64.dmg"
  name "Pocket Paste"
  desc "Smart clipboard for the menu bar: paste as a card, a GIF, a translation or a summary"
  homepage "https://github.com/anelikes/pocket-paste"

  livecheck do
    url :url
    strategy :github_latest
  end

  # Only an Apple silicon build is published.
  depends_on arch: :arm64
  # depends_on macos: ">= :sonoma" # TODO(release): match bundle.macOS.minimumSystemVersion once set

  app "Pocket Paste.app"

  zap trash: [
    "~/Library/Application Support/dev.pocketpaste.app",
    "~/Library/Caches/dev.pocketpaste.app",
    "~/Library/Preferences/dev.pocketpaste.app.plist",
    "~/Library/Saved Application State/dev.pocketpaste.app.savedState",
    "~/Library/WebKit/dev.pocketpaste.app",
  ]
end
