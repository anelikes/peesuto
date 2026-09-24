#!/bin/sh
# Rebuilds Peesuto Code and Peesuto Text (core/src/render/fonts/) from the
# upstream releases: Maple Mono NL CN v7.9 subset and renamed, JetBrains Mono
# v2.304 symbols merged in, full-width glyphs narrowed for Peesuto Text.
# Downloads go to .work/fonts (gitignored). Needs curl, unzip, python3 with
# fontTools. The same inputs give byte-identical fonts.
#
#   sh scripts/fonts/build.sh
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
work="$repo/.work/fonts"
mkdir -p "$work"

fetch() { # url file sha256
  if [ ! -f "$work/$2" ]; then
    curl -fL --retry 3 -o "$work/$2.partial" "$1"
    mv "$work/$2.partial" "$work/$2"
  fi
  echo "$3  $work/$2" | shasum -a 256 -c - >/dev/null || { echo "$2: SHA-256 mismatch" >&2; exit 1; }
}
fetch https://github.com/subframe7536/maple-font/releases/download/v7.9/MapleMonoNL-CN-unhinted.zip \
  MapleMonoNL-CN-unhinted.zip 80bf6db8920b2999d900e08f9e5031f7686baeb72dbdb80891f2c1ae9cec606f
fetch https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip \
  JetBrainsMono-2.304.zip 6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf
unzip -oqj "$work/JetBrainsMono-2.304.zip" fonts/ttf/JetBrainsMono-Regular.ttf fonts/ttf/JetBrainsMono-Bold.ttf -d "$work/jetbrains"

python3 "$repo/scripts/fonts/subset-maple.py" "$work/MapleMonoNL-CN-unhinted.zip"
python3 "$repo/scripts/fonts/merge-symbols.py" "$work/jetbrains"
python3 "$repo/scripts/fonts/peesuto-text.py"
