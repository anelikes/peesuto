# Peesuto Code

The monospace face of the code template (`CODE_FONT` in
`core/src/templates/compose.ts`). It ships inside `core/src`, so the native
sidecar bundle carries it as `resources/core/render/fonts/`.

- Source: [Sarasa Gothic](https://github.com/be5invis/Sarasa-Gothic) 1.0.41,
  `SarasaMonoSC-TTF-Unhinted-1.0.41.7z`, faces Sarasa Mono SC Regular and Bold (unhinted TTF).
- Subset (9,609 characters): Basic Latin, Latin-1, Latin Extended-A and -B,
  Greek, Cyrillic, general punctuation, arrows, mathematical operators, box
  drawing, geometric shapes, CJK symbols and punctuation, hiragana and
  katakana, half-width and full-width forms, and every GB2312 character.
- Renamed: family "Peesuto Code" (name IDs 1, 3 and 4). The PostScript name
  still reads Sarasa-Mono-SC-*. The only Reserved Font Name in the license is
  Adobe's "Source", which this font does not use.
- License: SIL Open Font License 1.1, full text in [OFL.txt](OFL.txt). Do not
  sell the font files on their own; any modified version must stay under the OFL.

When a code card contains a character this subset lacks (emoji aside), the
whole card is set in Noto Sans SC instead.
