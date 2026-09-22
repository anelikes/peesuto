# Cask skeleton for anelikes/homebrew-tap (Casks/peesuto.rb).
# Per release: set `version`, then `sha256` to `shasum -a 256 <the DMG>`.
# The asset name comes from productName and version in
# app/src-tauri/tauri.conf.json (Tauri names the DMG
# <productName>_<version>_aarch64.dmg). Check it against the release page once.
cask "peesuto" do
  version "0.0.0" # TODO(release): the tagged version, without the leading v
  sha256 "0000000000000000000000000000000000000000000000000000000000000000" # TODO(release): shasum -a 256 of the DMG

  url "https://github.com/anelikes/peesuto/releases/download/v#{version}/Peesuto_#{version}_aarch64.dmg"
  name "Peesuto"
  desc "Smart clipboard for the menu bar: paste as a card, a GIF, a translation or a summary"
  homepage "https://peesuto.com"

  livecheck do
    url :url
    strategy :github_latest
  end

  # Only an Apple silicon build is published.
  depends_on arch: :arm64
  # depends_on macos: ">= :sonoma" # TODO(release): match bundle.macOS.minimumSystemVersion once set

  app "Peesuto.app"

  zap trash: [
    "~/Library/Application Support/com.peesuto.desktop",
    "~/Library/Caches/com.peesuto.desktop",
    "~/Library/Preferences/com.peesuto.desktop.plist",
    "~/Library/Saved Application State/com.peesuto.desktop.savedState",
    "~/Library/WebKit/com.peesuto.desktop",
  ]
end
