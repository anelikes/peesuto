# Peesuto Code

The monospace face of the code template: a subset of **Maple Mono NL CN v7.9**
(unhinted; the no-ligature build, so `=>` and `!=` render as typed), renamed
"Peesuto Code" as a Modified Version under the SIL Open Font License 1.1
(`OFL.txt`, copied from the release).

- Upstream: https://github.com/subframe7536/maple-font (v7.9,
  `MapleMonoNL-CN-unhinted.zip`, Regular and Bold). Copyright 2022 The Maple
  Mono Project Authors. No Reserved Font Name is declared.
- The CN build's Chinese glyphs come from Resource Han Rounded
  (https://github.com/CyanoHao/Resource-Han-Rounded, SIL OFL 1.1), itself
  derived from Adobe's Source Han Sans (Reserved Font Name "Source", not
  used here). Chinese and Latin keep an exact 2:1 width.
- Subset (fontTools): Basic Latin, Latin-1, Latin Extended-A/B, Greek,
  Cyrillic, General Punctuation, currency, letterlike symbols, arrows,
  mathematical operators, miscellaneous technical, enclosed alphanumerics,
  box drawing, block elements, geometric shapes, miscellaneous symbols,
  dingbats, CJK symbols and punctuation, kana, half/full-width forms and all
  of GB 2312 (8,009 characters). Layout features kept.
- A card whose text needs a glyph outside the subset falls back to Noto Sans SC.

The OFL permits bundling the font with software, including commercial
software; the font files may not be sold on their own, and this notice and
`OFL.txt` must travel with them.
