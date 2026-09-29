# JIZURA base fonts

The fonts the JIZURA render line (Lyric motion) draws with when nothing has
been downloaded. JIZURA asks for about forty families by name (src/02_fonts.js
and src/02b_lang.js at 852wa/JIZURA bae339e); in a browser it fetches them
from Google Fonts. Peesuto never fetches a font while rendering: this base set
comes with the app, and one pack per lyric language (Japanese, Simplified
Chinese, Traditional Chinese, Korean) is downloaded once, when the user
agrees to it (a lyric that needs it says so, and the app asks), from the
GitHub Release that the `baseUrl` in `core/src/fonts/jizura-packs.json`
names, and checked against the SHA-256 listed there. A lyric needs its own
language's pack only. How they are built and served:
[docs/development.md](../../../../../docs/development.md), "JIZURA font packs".

Everything here is WOFF2 converted with fontTools from the pinned upstream
files in `scripts/fonts/jizura-sources.json` (URL at an exact commit and
SHA-256 for each). Every file is under the SIL Open Font License 1.1, and
its licence travels beside it as `OFL-<Family>.txt`.

## What is here (3.76 MB)

Whole faces, converted to WOFF2 only (outlines untouched): the faces JIZURA
uses in every language, and IBM Plex Sans JP, whose licence reserves the name
"Plex", so it is not cut.

| File | Family, weight | Copyright | Licence |
| --- | --- | --- | --- |
| DotGothic16-Regular.woff2 | DotGothic16 400 | 2020 The DotGothic16 Project Authors | OFL-DotGothic16.txt |
| IBMPlexMono-Medium.woff2 | IBM Plex Mono 500 | 2017 IBM Corp., Reserved Font Name "Plex" | OFL-IBMPlexMono.txt |
| IBMPlexSansJP-Medium.woff2 | IBM Plex Sans JP 500 | 2017 IBM Corp., Reserved Font Name "Plex" | OFL-IBMPlexSansJP.txt |

Latin cuts of the other Japanese faces: everything each face has except
kana, han, hangul, CJK symbols and punctuation, and half- and full-width
forms (`CJK_RANGES` in `core/src/fonts/jizura-packs.ts`). JIZURA draws
English lyrics with its Japanese faces, so these let an English lyric video
render with no download; a text with any CJK character needs the full face
from a pack. A cut is a Modified Version under the OFL; none of these
licences declares a Reserved Font Name, so the cuts keep their names.

| File | Family, weight | Copyright | Licence |
| --- | --- | --- | --- |
| NotoSansJP-{Light,Medium,Bold,Black}-Latin.woff2 | Noto Sans JP 300, 500, 700, 900 | 2014–2021 Adobe | OFL-NotoSansCJK.txt |
| NotoSerifJP-{Light,Medium,Bold}-Latin.woff2 | Noto Serif JP 300, 500, 700 | 2017–2024 Adobe | OFL-NotoSerifCJK.txt |
| DelaGothicOne-Regular-Latin.woff2 | Dela Gothic One 400 | 2020 The Dela Gothic Project Authors | OFL-DelaGothicOne.txt |
| ZenKakuGothicNew-Black-Latin.woff2 | Zen Kaku Gothic New 900 | 2022 The Zen Kaku Gothic Project Authors | OFL-ZenKakuGothicNew.txt |
| ZenOldMincho-Black-Latin.woff2 | Zen Old Mincho 900 | 2021 The Zen Old Mincho Project Authors | OFL-ZenOldMincho.txt |
| KaiseiTokumin-ExtraBold-Latin.woff2 | Kaisei Tokumin 800 | 2020 The Kaisei Project Authors | OFL-KaiseiTokumin.txt |
| MPLUSRounded1c-ExtraBold-Latin.woff2 | M PLUS Rounded 1c 800 | 2016 The Rounded M+ Project Authors | OFL-MPLUSRounded1c.txt |
| MochiyPopOne-Regular-Latin.woff2 | Mochiy Pop One 400 | 2020 The Mochiypop Project Authors | OFL-MochiyPopOne.txt |
| YujiSyuku-Regular-Latin.woff2 | Yuji Syuku 400 | 2021 The Yuji Project Authors | OFL-YujiSyuku.txt |
| ReggaeOne-Regular-Latin.woff2 | Reggae One 400 | 2020 The Reggae Project Authors | OFL-ReggaeOne.txt |
| RampartOne-Regular-Latin.woff2 | Rampart One 400 | 2020 The Rampart Project Authors | OFL-RampartOne.txt |
| PottaOne-Regular-Latin.woff2 | Potta One 400 | 2020 The Potta Project Authors | OFL-PottaOne.txt |
| KiwiMaru-Medium-Latin.woff2 | Kiwi Maru 500 | 2020 The Kiwi Maru Project Authors | OFL-KiwiMaru.txt |
| KleeOne-SemiBold-Latin.woff2 | Klee One 600 | 2020 The Klee Project Authors | OFL-KleeOne.txt |
| ShipporiMinchoB1-ExtraBold-Latin.woff2 | Shippori Mincho B1 800 | 2021 The Shippori Mincho Project Authors | OFL-ShipporiMinchoB1.txt |

Notes:

- Noto Sans/Serif JP come from notofonts/noto-cjk (Sans2.004, Serif2.003,
  `SubsetOTF`), the static CFF builds, because they have no overlapping
  contours; the TrueType and variable builds Google Fonts serves have them in
  most glyphs, and JIZURA's outline treatments would stroke them as inner
  lines. Noto CJK's licence text carries no copyright line; the copyright
  above is the fonts' own.
- The other faces come from google/fonts at commit 23e54b51. Google Fonts
  ships no OFL.txt for M PLUS Rounded 1c, so its licence is the OFL text from
  coz-m/MPLUS_FONTS (whose copyright line names the M+ FONTS Project; the
  font names the Rounded M+ Project). The file calls itself "Rounded Mplus
  1c"; it is registered as "M PLUS Rounded 1c", the name JIZURA asks for.
- A few JIZURA decorations write fixed Japanese words (moon names, family
  crests, toggle labels). In an English lyric video drawn only with these
  cuts, those characters fall back to a system font.

## The downloadable packs

Not in the repository; each is one tar of WOFF2 files with their licences,
an asset of the GitHub Release
[`fonts-jizura-v1`](https://github.com/anelikes/peesuto/releases/tag/fonts-jizura-v1).
Sizes of the current build:

| Pack | Families (weights) | Download |
| --- | --- | --- |
| `ja` | Noto Sans JP (300, 500, 700, 900), Noto Serif JP (300, 500, 700), Dela Gothic One, Zen Kaku Gothic New 900, Zen Old Mincho 900, Kaisei Tokumin 800, M PLUS Rounded 1c 800, Mochiy Pop One, Yuji Syuku, Reggae One, Rampart One, Potta One, Kiwi Maru 500, Klee One 600, Shippori Mincho B1 800 | 56.0 MB |
| `zh-hans` | Noto Sans SC (300, 500, 700, 900), Noto Serif SC (300, 500, 700, 900), ZCOOL QingKe HuangYou, ZCOOL KuaiLe, ZCOOL XiaoWei, Ma Shan Zheng | 68.9 MB |
| `zh-hant` | Noto Sans TC (300, 500, 700, 900), Noto Serif TC (300, 500, 700, 900), WDXL Lubrifont TC, Chiron GoRound TC 800, Huninn, LXGW WenKai TC 700, LXGW Marker Gothic | 66.2 MB |
| `ko` | Noto Sans KR (300, 500, 700, 900), Noto Serif KR (300, 500, 700, 900), IBM Plex Sans KR 500, Black Han Sans, Jua, Do Hyeon, Gowun Dodum, Gowun Batang 700, Nanum Brush Script | 34.9 MB |

All SIL Open Font License 1.1, whole faces converted to WOFF2 only. Chiron
GoRound TC is the static CFF build from chiron-fonts/chiron-go-round-tc
v1.011 (Google Fonts has only a variable TrueType); static Noto CJK has no
weight 800, so JIZURA's Serif 800 is drawn at 900. Nanum Brush Script
(Reserved Font Names "Nanum", "NanumBrush" and others) keeps the overlapping
contours in about a quarter of its glyphs, since removing them would be a
Modified Version under a reserved name.
