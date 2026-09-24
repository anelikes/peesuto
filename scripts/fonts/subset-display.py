#!/usr/bin/env python3
"""
The display faces of Lyric motion (core/src/render/fonts/README.md, "Display
faces"): each upstream file subset to what its role needs and written to
core/src/render/fonts/<Name>.ttf.

    python3 scripts/fonts/subset-display.py <download dir>

or with the downloads: sh scripts/fonts/build-display.sh. Needs fontTools.

- Chinese faces keep GB 2312 (6,763 hanzi and its symbol rows).
- Japanese faces keep JIS X 0208 non-kanji rows and level 1 kanji (2,965),
  the kana blocks, and the 2010 jōyō additions they have.
- Every face keeps printable ASCII, Latin-1, Latin Extended-A, general
  punctuation, CJK symbols and punctuation and the half/full-width forms, and
  a few symbols lyrics use (♪ ★ ☆ ※ ‥ ― 〒) where the face has them.
- Hinting, glyph names and the `meta` table are dropped; layout features are
  kept. Upstream `head.modified` is kept, so the same inputs give identical
  bytes.
- Smiley Sans declares the Reserved Font Names "Smiley" and "得意黑": the
  subset is a Modified Version and is renamed "Peesuto Grin" (SIL OFL 1.1
  section 3). The other faces declare no Reserved Font Name and keep theirs.

Each input is checked against its SHA-256 before anything is written.
"""
import hashlib
import os
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

FONTS = Path(__file__).resolve().parents[2] / "core/src/render/fonts"


def double_byte(codec: str, first: range, second: range = range(0xA1, 0xFF)) -> set[int]:
    out = set()
    for hi in first:
        for lo in second:
            try:
                text = bytes([hi, lo]).decode(codec)
            except UnicodeDecodeError:
                continue
            if len(text) == 1:
                out.add(ord(text))
    return out


def blocks(*ranges: tuple[int, int]) -> set[int]:
    return {cp for lo, hi in ranges for cp in range(lo, hi + 1)}


GB2312 = double_byte("gb2312", range(0xA1, 0xF8))
JIS_NONKANJI = double_byte("euc_jp", range(0xA1, 0xB0))
JIS_LEVEL1 = double_byte("euc_jp", range(0xB0, 0xD0))
LATIN = blocks((0x0020, 0x007E), (0x00A0, 0x017F), (0x2000, 0x206F), (0x20AC, 0x20AC), (0x2122, 0x2122))
CJK = blocks((0x3000, 0x303F), (0xFF00, 0xFFEF))
KANA = blocks((0x3040, 0x30FF), (0x31F0, 0x31FF))
SYMBOLS = {ord(c) for c in "♪♫♬★☆※‥―〒・…「」『』【】〈〉《》"}
JOYO_2010 = {ord(c) for c in "塡剝頰"}

ZH = GB2312 | LATIN | CJK | SYMBOLS
JA = JIS_NONKANJI | JIS_LEVEL1 | KANA | LATIN | CJK | SYMBOLS | JOYO_2010
LATIN_ONLY = LATIN | SYMBOLS

# (source file in the download dir, SHA-256, output name, wanted code points, renames)
FACES = [
    ("smiley/SmileySans-Oblique.ttf", "b447d7e781f08bc95c4c9f23ba71ed2b8ebb639aa7184485c71c4ca5afcd25c4",
     "PeesutoGrin-Oblique.ttf", ZH, [("SmileySans-Oblique", "PeesutoGrin-Oblique"), ("Smiley Sans", "Peesuto Grin"), ("得意黑", "Peesuto Grin")]),
    ("delagothicone/DelaGothicOne-Regular.ttf", "4ff87a0965f1b0505e5a2c58424bc6ad3cff27e56a82f21c2fc9d6b0e3857ee2",
     "DelaGothicOne-Subset.ttf", JA, []),
    ("zcoolkuaile/ZCOOLKuaiLe-Regular.ttf", "812a6fc1fe54b6d73a419245c32dfeba8aa33104d5be90d1cf6af082007cb71d",
     "ZCOOLKuaiLe-Subset.ttf", ZH, []),
    ("zenmarugothic/ZenMaruGothic-Black.ttf", "6bd74fe76cd39ee0ec18775c3661d845343fb3f6f8fa09a3076638417baf741f",
     "ZenMaruGothic-Black-Subset.ttf", JA, []),
    ("LXGWWenKai-Medium.ttf", "d4bdeb38a39151d74d084cba5090f8cb7d20bf83eedb78c35939ae70b9f4e3f6",
     "LXGWWenKai-Medium-Subset.ttf", ZH, []),
    ("kaiseitokumin/KaiseiTokumin-ExtraBold.ttf", "bf44bb3e23cc703bfb19111833f78e651998d0a2b1863eff9e88cecb38a8bc53",
     "KaiseiTokumin-ExtraBold-Subset.ttf", JA, []),
    ("dotgothic16/DotGothic16-Regular.ttf", "3ad9af88726d42b40f7f365f0dcac785af73cf20ea6f1d5b44e57cc21150b8f1",
     "DotGothic16-Subset.ttf", JA, []),
    ("anton/Anton-Regular.ttf", "a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab",
     "Anton-Subset.ttf", LATIN_ONLY, []),
    ("instrumentserif/InstrumentSerif-Italic.ttf", "08939b8bdf534afec24ae0ef5e03f948940cd9a8fe08e7fecbad040e62327385",
     "InstrumentSerif-Italic-Subset.ttf", LATIN_ONLY, []),
]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def subset_face(src: Path, dst: Path, wanted: set[int], renames) -> int:
    font = TTFont(src, recalcTimestamp=False)
    have = font.getBestCmap()
    options = subset.Options()
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.notdef_outline = True
    options.glyph_names = False
    options.hinting = False
    options.drop_tables += ["meta", "DSIG"]
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes={cp for cp in wanted if cp in have})
    subsetter.subset(font)
    for record in font["name"].names:
        text = record.toUnicode()
        for old, new in renames:
            text = text.replace(old, new)
        record.string = text
    partial = dst.with_suffix(".partial")
    font.save(partial)
    os.replace(partial, dst)
    return len(font.getBestCmap())


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    root = Path(sys.argv[1])
    for rel, digest, _, _, _ in FACES:
        if sha256(root / rel) != digest:
            sys.exit(f"{rel}: SHA-256 mismatch (expected {digest})")
    total = 0
    for rel, _, out, wanted, renames in FACES:
        dst = FONTS / out
        count = subset_face(root / rel, dst, wanted, renames)
        size = dst.stat().st_size
        total += size
        print(f"{out}: {count} characters, {size / 1e6:.2f} MB")
    print(f"total {total / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
