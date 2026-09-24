#!/bin/sh
# Rebuilds Lyric motion's display faces (core/src/render/fonts/, README
# "Display faces") from the upstream files: downloads into
# .work/fonts/display (gitignored), checks each SHA-256, then subsets them
# with scripts/fonts/subset-display.py. Needs curl, unzip and python3 with
# fontTools. The same inputs give byte-identical fonts.
#
#   sh scripts/fonts/build-display.sh
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
work="$repo/.work/fonts/display"
mkdir -p "$work"
GF=https://raw.githubusercontent.com/google/fonts/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl

fetch() { # url path sha256
  mkdir -p "$(dirname "$work/$2")"
  if [ ! -f "$work/$2" ]; then
    curl -fsSL --retry 3 -o "$work/$2.partial" "$1"
    mv "$work/$2.partial" "$work/$2"
  fi
  echo "$3  $work/$2" | shasum -a 256 -c - >/dev/null || { echo "$2: SHA-256 mismatch" >&2; exit 1; }
}
fetch https://github.com/atelier-anchor/smiley-sans/releases/download/v2.0.1/smiley-sans-v2.0.1.zip \
  smiley-sans-v2.0.1.zip 299c0be6c960ae37361762eca76f7d0cd516615435bb96c0d4b98a1e70178a07
unzip -oq "$work/smiley-sans-v2.0.1.zip" SmileySans-Oblique.ttf -d "$work/smiley"
fetch https://github.com/lxgw/LxgwWenKai/releases/download/v1.522/LXGWWenKai-Medium.ttf \
  LXGWWenKai-Medium.ttf d4bdeb38a39151d74d084cba5090f8cb7d20bf83eedb78c35939ae70b9f4e3f6
fetch $GF/delagothicone/DelaGothicOne-Regular.ttf delagothicone/DelaGothicOne-Regular.ttf 4ff87a0965f1b0505e5a2c58424bc6ad3cff27e56a82f21c2fc9d6b0e3857ee2
fetch $GF/zcoolkuaile/ZCOOLKuaiLe-Regular.ttf zcoolkuaile/ZCOOLKuaiLe-Regular.ttf 812a6fc1fe54b6d73a419245c32dfeba8aa33104d5be90d1cf6af082007cb71d
fetch $GF/zenmarugothic/ZenMaruGothic-Black.ttf zenmarugothic/ZenMaruGothic-Black.ttf 6bd74fe76cd39ee0ec18775c3661d845343fb3f6f8fa09a3076638417baf741f
fetch $GF/kaiseitokumin/KaiseiTokumin-ExtraBold.ttf kaiseitokumin/KaiseiTokumin-ExtraBold.ttf bf44bb3e23cc703bfb19111833f78e651998d0a2b1863eff9e88cecb38a8bc53
fetch $GF/dotgothic16/DotGothic16-Regular.ttf dotgothic16/DotGothic16-Regular.ttf 3ad9af88726d42b40f7f365f0dcac785af73cf20ea6f1d5b44e57cc21150b8f1
fetch $GF/anton/Anton-Regular.ttf anton/Anton-Regular.ttf a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab
fetch $GF/instrumentserif/InstrumentSerif-Italic.ttf instrumentserif/InstrumentSerif-Italic.ttf 08939b8bdf534afec24ae0ef5e03f948940cd9a8fe08e7fecbad040e62327385

python3 "$repo/scripts/fonts/subset-display.py" "$work"
