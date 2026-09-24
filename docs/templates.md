# Structured media templates

The native app shares one content and presentation pipeline across PNG, GIF and MP4.
An output format is not a separate template. `paste-card`, `paste-gif` and
`paste-video` remain convenient output presets and shortcut targets.

## Pipeline and ownership

1. Swift captures the input once, plus the destination/clipboard snapshot for a direct shortcut.
2. Core parses source-backed candidate structures, always retaining a document fallback.
3. The configured decision provider chooses a template, variant and motion from valid options.
4. Core validates the choices, measures and lays out the complete content, then creates a Pocket Motion composition.
5. Pocket Motion renders the frames. Core exports PNG/GIF or uses locally available ffmpeg for MP4.
6. Swift previews the output and performs the existing conservative paste checks.

The parser owns words, numbers, speakers, attribution, order and table cells. Jev
only chooses presentation metadata; its response cannot replace source content or
invent missing authors, participants or data. Default local rules work offline.
Configured model errors, malformed answers and low-confidence decisions fall back
to local decisions. This is not a claim that Jev understands every arbitrary input.

## Template set

| Template | Classic | Editorial | Poster |
|---|---|---|---|
| Text | Paper | Ink | Poster |
| Document | Reading page | Editorial column | |
| Quote | Book excerpt | Statement | |
| Code | Terminal | Code notebook | |
| Statistic | Big number | Metric strip | |
| List | Checklist | Stacked steps | |
| Conversation | Chat bubbles | Transcript | |
| Table | Data grid | Editorial ledger | |
| Comparison | Side by side | Split panels | |
| Diagram | Flow | Blueprint | |
| Info card | Field list | Credentials | |
| Release notes | Release card | Timeline | |
| QR code | Plain | Card | |

These variants change composition and typographic hierarchy, not just color.
A style id is valid only for the templates that register it: `poster` exists
for text alone, and a saved or manual `poster` elsewhere is ignored or refused.

### Text: typography only

Text is the default for short plain prose, the most common thing people copy:
a line, a sentence, a few short paragraphs. It draws the source paragraphs and
nothing else (no labels, numbers or decoration made of words).

- Eligible: at most 280 visible characters, eight paragraphs and twelve lines;
  no Markdown blocks or `**bold**`, and nothing layout-bearing (indentation,
  tabs, pipes, list markers, `>` quotes, lines ending in a colon, two or more
  `Label: value` lines). Code, table, list, conversation and comparison sources
  never get it; a quote or statistic wins but keeps text as an alternative.
  Anything else falls to document.
- Size follows length: the largest baked size whose wrapped text fits the box,
  so a line is poster-sized and a paragraph smaller. The measure is then
  narrowed while the line count holds, which balances the lines, and the block
  is vertically centered.
- Accent: with a model decider, one optional question offers `none` plus up to
  twelve whole words taken from the source; a confident answer colors that word.
  Local rules never accent. A manual restyle does not ask again, so it drops the accent.
- Styles are one token table, `TEXT_STYLES` in `core/src/templates/compose.ts`
  (colors, weight, alignment, margin, size range, leading, rule); a redesign
  changes numbers there, not the layout code.

### Diagram: Mermaid flowcharts and arrow chains

Two sources become a node diagram, and it wins over every other structure:

- A Mermaid `graph`/`flowchart` (bare, or fenced as ```` ```mermaid ````, which
  keeps code as an alternative). Directions TD/TB/LR/BT/RL; node shapes `[ ]`
  box, `( )` rounded, `([ ])` `(( ))` pill (drawn in the accent), `{ }` decision
  diamond, the rest as boxes; links `-->`, `---`, `-.->`, `==>`, chains
  `A --> B --> C`, fan-out `A --> B & C`, labels `-->|yes|` and `-- yes -->`;
  `<br>` breaks a label. `classDef`, `class`, `style`, `linkStyle` and `click`
  are ignored and subgraphs are flattened. Other Mermaid kinds (sequence,
  class, gantt…) are not diagrams; any line that does not parse means the
  whole source stays code.
- Plain arrow chains: every non-empty line is `A → B → C` (also `->`, `-->`,
  `=>`, `⇒`, `➜`). Equal labels are one node, so lines can branch and merge.
  A label with sentence punctuation or unbalanced brackets is prose or code,
  not a node. One short chain goes left to right, anything else top-down.

At most 40 nodes, 80 edges and 80 characters per label; labels are drawn
verbatim. Layout is layered: ranks by longest path (cycles are reversed for
ranking and drawn back up), points for edges that skip ranks so they bend
around the nodes between, barycenter ordering, parent-aligned positions, and
orthogonal routing with one channel per edge between ranks. Incoming and outgoing ports spread evenly over 20–80% of a node side (at least 1.6 arrowheads apart; the node widens if needed), and the last run into a node is at least an arrowhead plus 12 px. Edge labels try beside the first run (away from sibling edges), then above, then below a horizontal run, rejecting any spot that touches a node, another label or a line; if none fits, that rank gap grows. Size tiers from
56 px down are tried until the diagram fits the card; height alone never pushes
text below the readability floor, the card grows instead (and an animation
scrolls). A sideways diagram too wide at the floor is drawn top-down when that
is readable; only a diagram too wide either way goes below the floor (the
last-resort tiers down to 24 px, not scaled with the canvas, so a wider auto
frame can still hold it), and one too wide even at 24 px is an overflow error. Reveal and typewriter bring the
diagram in rank by rank, the edges into a rank just before its nodes. Styles
are `DIAGRAM_STYLES`; size tiers `DIAGRAM_TIERS`, both in
`core/src/templates/compose.ts`. Arrowheads and diamonds are small SVGs the
engine bakes; everything else is boxes and text.

### Decoration (all templates)

Every line or shape encodes something: a separation (hairlines between rows,
cards, panels, bands), a state (before/after, a secret) or a relationship (a
bullet to its item, a dash to an author, an edge between nodes). Rules, marks
and bars that only decorate are not drawn: the style tables keep their slots
(`mark`, `rule`, `band`, `masthead`, `rail`, `gutter`, `bar`, `marker`) as
`null`, so a style can bring one back as a token change. One accent colour per
style, with a role (an accented word, a heading level, a bullet). Greys are
warm; ink is a warm or dark near-black, never pure black. Owner-approved
exceptions: the code terminal's hue-arc backdrop and window dots, the info
card's pill and icons, and colour-field grounds (Poster, Big number, the
comparison panels), which are the style rather than an accent on it.

### Readability floor (all templates)

Cards are mostly looked at on a phone, where a card of any width is shown
about 390 px wide. A font size's effective size is `size × 390 / canvas
width`, and no drawn text goes below 13 effective px (Apple's footnote size;
ljg-card's 40 px on 1080 is 14.4), labels, times, captions, language tags and
line numbers below 11 (the smallest step of Apple's type scale). That is:

| Canvas width | Body | Secondary |
|---|---|---|
| 1080 | 36 px | 32 px |
| 1440 | 48 px | 44 px |
| 1920 (16:9) | 64 px | 56 px |

The style tables are drawn for 1080 and meet the floor there; a wider canvas
scales the whole style (lengths, margins and sizes, snapped to the nearest
baked size) by width / 1080, which keeps both floors. Content that does not
fit at the floor grows the canvas (PNG) or scrolls (GIF/MP4) instead of
shrinking type; code wraps. The only exception is a diagram too wide to draw
at the floor in either direction (see Diagram). The numbers are `READABILITY`
in `core/src/templates/types.ts`; `core/tests/template-principles.test.ts`
checks every template, style and frame.

### Quality checks (all templates)

`core/src/templates/checks.ts` inspects a finished layout: text below the
readability floor (`size`), a line outside the canvas (`overflow`), text lines
drawn over each other (`overlap`), text against the ground or shape beneath it
below 4.5:1, or 3:1 from 48 px at the reference width (`contrast`), drawn text
that is not in the source (`untraceable`; ordered-list and code line numbers,
marked `generated`, and the signature are exempt) and source text never drawn
(`missing`). Thresholds are one constant, `CHECK_THRESHOLDS`. The principle
tests run it over every sample, style, frame and signature; `composeTemplate`
runs it on every card as a guard: overflow is an `overflow` error, and a
failed source ledger a `fidelity` error (like ljg-card's check before output:
every non-whitespace grapheme of the content drawn at least as often as it
occurs, and nothing drawn the content does not hold; QR's caption is
optional), and nothing is rendered; the other kinds go to stderr
as kinds and counts (never text). The info card's muted colours are the known
contrast findings (owner-approved). A future declarative template format would
use the same checks as its publish gate: [template-spec.md](template-spec.md).

### Card font

Cards are set in Maple Mono by default, with a choice of Noto Sans SC in
Settings › Templates (`template_font`, sent as `templateFont` with every
render and precompose request, part of the precompose key, carried in the
plan as `font`). Code is always Maple Mono. Maple comes in two cuts under
`core/src/render/fonts/`: Peesuto Code, Chinese at two Latin columns so code
aligns, and Peesuto Text, Chinese at 1em for everything else (the two-column
width reads as letter-spacing in prose; `scripts/fonts/peesuto-text.py`).
Both cuts carry keyboard and technical symbols from JetBrains Mono (⌘ ⌥ ⌃ ⎋ ⏎).
A card is set in the chosen face when it has every glyph (emoji aside), else in
the other one when that has them all (Noto lacks ⌥, Maple lacks 體); when
neither does, an explicit `unsupported-script` error names what is missing. One
font pair per composition.

### Signature footer

Settings › Templates › Signature takes one short line of the user's own
("@nya · peesuto.com"; at most 40 characters, empty by default, which means
none). It is saved as `template_signature`, sent as `templateSignature` with
every render and precompose request, part of the precompose key, and carried
in the plan as `signature` (one line, whitespace collapsed, trimmed, cut at 40
graphemes by `templateSignature()`). Every card but QR draws it at the foot in
the secondary size (32 px on 1080), in the style's `signature` colour (a muted
tone of the ground, at least 4.5:1), left-aligned with the content (centred on
Ink): 56 px above the bottom edge or above a pinned band, and at least 40 px
below everything else. Content is centred and fitted leaving it that room, so
a card that fits its frame still does; one that does not grows (PNG) or
scrolls (GIF/MP4). It is not source text: its lines are marked `signature` and
exempt from the source rules (and from reveal and typing: it is there from the
first frame). A signature the card's font cannot draw is dropped without an
error; it never chooses the font. Token: `SIGNATURE_STYLE` in `compose.ts`.

### Code: monospace type and syntax colour

- Font: the whole code card (both styles, the language label included) is set
  in Peesuto Code, a Maple Mono NL CN v7.9 subset shipped in
  `core/src/render/fonts/` (Latin, Greek, Cyrillic, symbols, box drawing, kana,
  full-width forms and all of GB2312; see the README there). CJK is exactly two
  columns wide, so indentation and alignment hold in mixed code. The composition
  gets its own copy (hard link or copy) under `compositions/paste/fonts/`, since
  engine font paths must stay inside the work tree. If any non-emoji character of
  the card is missing from Peesuto Code (traditional Chinese outside GB2312,
  say), the whole card falls back to Noto Sans SC; there is no error and no mixed
  font. Every other template keeps Noto Sans SC, and code blocks inside a
  document stay proportional: one font pair per composition.
- Highlighter: highlight.js (pinned, pure JS) with 24 registered languages:
  TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, Swift, C, C++, C#,
  Ruby, PHP, SQL, Bash, shell sessions, JSON, YAML, XML/HTML, CSS, Markdown,
  diff, Dockerfile, INI/TOML. Its output is decoded to one colour per grapheme,
  and the decoded text must equal the source line for line; any mismatch or
  error falls back to the built-in regex colouring (`syntaxColors`). Colour
  only: the text is never changed.
- Language: the fence language when highlight.js knows it or its alias (`py`,
  `ts`, `sh`, `html`, `toml`…); otherwise automatic detection over the
  registered languages only. A snippet under two lines and 40 characters whose
  detection is unsure (relevance below 5) keeps the regex colouring.
- Colours: `CODE_STYLES.<style>.syntax` maps token classes to keyword, string,
  number, comment, function (function and other titles), type (types, classes,
  built-ins), property (attributes, properties, variables, parameters), literal
  (true/false/null, symbols), meta (tags, selectors, decorators, headings, diff
  deletions; diff additions use string), punct (operators, punctuation).
- Backdrop (Terminal): a hue arc, not a two-colour blend. A straight RGB
  gradient between distant hues goes grey in the middle; walking the hue circle
  stays saturated. `core/src/templates/gradient.ts` samples the arc in OKLCH
  (even perceptual steps, chroma reduced to fit sRGB, hue and lightness kept)
  and the backdrop draws it as adjacent two-stop segments on whole pixels,
  since the engine only has two-stop gradients. Current arc: indigo, violet,
  magenta, coral, amber (hue 272° to 62°, lightness 0.34 to 0.76). No overlay:
  any tint across different hues (black over orange turns brown) muddies it.

### Info card: contacts, accounts and keys

- Recognized when every line is a field (`label: value`, `label：value`, a
  dotenv `UPPER_CASE=value`, or a bare email, URL, phone number or key), except
  an optional short first line, which becomes the title (a `# comment` titles
  an env block, its marker dropped as a Markdown heading's is). Two dotenv
  assignments are recognizable on their own. At least two fields, labels unique (a returning label
  is a conversation), and at least one known label (phone, email, address,
  password, API key, host, order number…) or recognizable value. Any other
  line means document, so nothing is ever dropped. It ranks after comparison,
  before quote, list and chat.
- Unlabelled lines count as fields when recognizable: an email, a URL, a phone
  number, a key, or an address (`looksLikeAddress`: two or more Chinese place
  units such as 市 区 路 号, or a house number and a street word). Such a field
  gets an icon where its label would be (phone, envelope, globe, pin), drawn
  from `INFO_ICONS`; no label text is ever added.
- Values are drawn verbatim; the field type (`infoFieldType`) only styles them:
  a Chinese mobile number is spaced 3-4-4 as separate runs (no characters
  added), an email's `@domain` and a URL's scheme are muted, the rest of a URL
  takes the link colour, and a password, token or key (by label, or by value
  shape: `sk-`, `ghp_`, `AKIA`, JWT…) sits in a pill behind a lock. Secrets are
  shown in full; the privacy rules are the place to redact them.
- Field list puts labels in a left column when the widest fits a third of the
  card, else above the values; Credentials always stacks them.

### Release notes: versions, dates and tagged changes

- Recognized when every non-blank line is one of: an optional first `# Title`;
  a release heading with a version (`## v1.2.0 — 2026-09-24`,
  `## [1.2.0] - 2026-09-24`, `1.2.0 (2026-09-24)`, `v1.2.0`, `Version 1.2.0`,
  `## [Unreleased]`); a section title (any `###` heading, or a bare known
  one such as `Added`, `Fixed:`, `新增：`, `修复`); or a `-`, `*` or `•` item at
  one indentation. A version is `v1.2` or longer with a `v`, three parts
  without (`1.2` alone is a section number), with an optional pre-release or
  build suffix. At least one real version (not only Unreleased), at least one
  item, and no empty titled section; anything else stays a document. It ranks
  after comparison and before info, list and chat, so a commit-style list
  with a URL is not an info card.
- Drawn verbatim: title, versions, dates, section titles, items (`**bold**`
  in items is bold). Heading markers, brackets, the dash or parentheses
  between version and date, and a section title's colon are syntax and are
  not drawn. Nothing else is written: items right under a version get no
  invented heading.
- A section title's words pick its colour (`changeType`: added, changed,
  fixed, removed, security including breaking changes, other); styling only.
- Release card: the first release with items leads in large type, date
  under it, titles on a tint, hairlines between releases. Timeline: dark,
  version and date in a left column beside the sections, titles in colour;
  a version or date too wide for the column stacks above the sections.
  Styles are `CHANGELOG_STYLES` in `compose.ts`.

### QR code: any text, by shortcut only

Every text can become a QR code, so QR is never chosen automatically: it is
always among a result's available templates (the template menu can switch to
it), the model is never offered it, and the `paste-qr` action (⌘⌥4) always
uses it without asking a model. The data is the source exactly (surrounding
whitespace aside; invisible characters are kept), UTF-8, error correction M,
falling back to L; past 2,953 bytes (about 980 Chinese characters) it is a
`qr-too-long` error, never a truncation. Modules are whole pixels with a
4-module quiet zone, dark on light in every style (scanners expect it). A
caption repeats the data under the code only when it is one line of at most
60 characters (a URL, a word) the font can draw; nothing else is written. Any
script works, since only the caption needs glyphs. Motions: still, or reveal
row band by row band. Styles are `QR_STYLES` in `core/src/templates/compose.ts`.

### Line breaking (all templates)

Lines break at spaces, and in unspaced scripts at ICU word boundaries (so 复杂
stays whole), backing up at most half a line. Closing punctuation never starts
a line and opening punctuation never ends one (kinsoku).
Flowcharts, timelines, event cards and poetry-specific layouts are later work.
New template implementations must register a parser, presentation options and an
actual renderer; adding a catalog name alone does not create a working template.
Existing palette packs and the legacy DSL render endpoint remain separate from
this version of the template registry.

## Input recognition

Explicit structures take precedence. Examples include fenced source code,
quoted text with an optional explicit author, marked lists, Markdown/TSV tables,
and recognizable before/after or option A/B sections. Conversation recognition
requires evidence of turns: known speaker roles, explicit `[speaker]: message`
labels, or a repeated speaker in a sequence. Messages copied out of a chat app
also count: a speaker line and a timestamp line (or `Name 10:21` on one line),
then the message, repeated; every line must belong to such a block, the text
before the first one must be empty, and no message may be empty (an image or a
sticker). The copied time is kept verbatim and drawn as small text under the
speaker. Arbitrary key/value fields are not automatically treated as dialogue.
Uncertain structures remain document text.

Before parsing, invisible characters chat apps insert are cleaned: unusual
spaces (WeChat puts U+2005 after an @mention) become a plain space, and
zero-width, bidi and soft-hyphen controls are dropped; the zero-width joiner
and variation selectors that emoji need stay. `sourceText` keeps the original.

The source may offer more than one compatible template; the native template menu
shows only these candidates. A manual request for an incompatible structure
fails instead of fabricating content. Long content must fit a bounded expanded
canvas or produce an explicit overflow error; new templates do not silently
truncate text to make it fit.

## Frames

| Frame | Size | Used by |
|---|---|---|
| auto | width 1080 (1440, then 1920, only on overflow: the floor scales with the width, so a wider card holds no more readable text per line), height hugging the content | images, by default |
| 1:1 | 1080×1080 | GIF and video by default; images on request |
| 4:5 | 1080×1350 | on request |
| 16:9 | 1920×1080 | on request |
| 9:16 | 1080×1920 | on request |

`auto` starts the canvas at a minimum height (0.75 of the width for text and
statistics, 0.6 for quotes, 0.5 otherwise, so a short line is not a thin strip)
and grows with the content; type is still sized against a square, so a short
line stays large. A fixed frame is exact when the content fits. A PNG in a
fixed frame grows taller rather than dropping content; GIF and MP4 never grow,
content taller than the frame scrolls. `auto` for GIF/MP4 means 1:1. Legacy
`chat`, `doc` and `social` still work (1:1, 16:9, 9:16). The numbers are
`AUTO_FRAME` in `core/src/templates/compose.ts` and `FRAMES` in
`core/src/templates/types.ts`. The native app keeps one frame per output kind
(Settings → Shortcuts) and a per-result frame menu.

## Output and motion

- PNG always uses the complete static layout, even when a typewriter override was supplied.
- GIF/MP4 can use a still composition, sequential reveal, or typewriter appearance.
- Typewriter appearance uses grapheme clusters and the final layout, keeping line breaks stable.
- Animation has a bounded duration and a readable ending. An unsupported or oversized input is reported explicitly.
- Tall content scrolls in GIF/MP4. When the layout is taller than the frame,
  the frame keeps its size and the content scrolls: 0.9 s still,
  an eased scroll at 120 px/s (at least 1.5 s, at most 12 s, faster for longer
  content), then 1.5 s still on the end. Content is shown whole while it
  scrolls; reveal and typewriter apply only to content that fits. The numbers
  are `TEMPLATE_SCROLL` in `core/src/templates/compose.ts`. PNG always grows in
  height instead (up to 4096 px), and the result reports `scroll`.
- GIF uses at most 128 MiB for retained raw frames (engine and palette memory are additional). It starts at 540 px wide, may reduce to 360 px, and rejects taller animations that still exceed this budget.
- MP4 still requires ffmpeg; this app does not install it automatically.

## Native controls and protocol

`templates.list` returns bilingual names, registered variants and motions. The
`run-action` input accepts `template: {id?, variant?, motion?}` and a
`templatePreferences` dictionary mapping template IDs to saved variant IDs.
Result `meta.template` returns `id`, `variant`, `motion`, `decisionSource` and
`availableTemplates`; it does not repeat source content.

The result view can change template, style, motion and output format using the
original input snapshot. These explicit rerenders do not reread the clipboard or
automatically paste. Changing a style successfully remembers it in native
`settings.json` under `template_styles`; explicit choices take precedence over
saved preferences, which take precedence over automatic style decisions.

Settings › Templates shows every template with a preview of each style
(`native/Resources/TemplatePreviews/<template>-<variant>.png`, rendered by
`bun scripts/template-previews.ts` at 1:1; rerun it after a template's look
changes). A style clicked there is the saved preference above; a template
switched off is stored as `templates_disabled` and sent as
`disabledTemplates` with every `run-action` and `precompose` request. Rules and
the model then choose among the templates left on, while choosing by hand still
reaches all of them; `document` is the fallback and cannot be switched off, and
`qr` is never chosen automatically anyway. The list is part of the precompose
cache key.

The older DSL `render` request remains for deterministic fixtures and CLI
compatibility. Its existing truncation behavior is unchanged; new media actions
use the structured pipeline. Keep those contracts distinct in tests and UI claims.

## Validation

`bun test core/tests` covers parsing, constrained provider decisions, layout,
motion timing and memory bounds. Real engine acceptance is opt-in:

```sh
PEESUTO_TEMPLATE_ENGINE=/absolute/path/to/prepared-engine-copy bun test core/tests/template-engine.test.ts
```

Use a disposable copy of the prepared pinned engine: its build tools write vendor
caches. This test renders every registered variant and compares the typewriter's final
frame, ending hold and complete PNG export. The macOS render CI runs this suite.
Native bundle and interface acceptance is recorded in
[the template baseline](../baselines/templates-native-0.1.0.md).

## Third-party notices

- Peesuto Code is a renamed subset of [Maple Mono](https://github.com/subframe7536/maple-font)
  (Maple Mono NL CN v7.9), © 2022 The Maple Mono Project Authors, whose Chinese glyphs come
  from [Resource Han Rounded](https://github.com/CyanoHao/Resource-Han-Rounded) (derived from
  Adobe's Source Han Sans), all under the SIL Open Font License 1.1:
  `core/src/render/fonts/OFL.txt`. The OFL allows bundling in commercial software; the font
  files may not be sold on their own.
- [highlight.js](https://highlightjs.org/) 11.12.0, © 2006 Ivan Sagalaev and contributors,
  BSD 3-Clause License (shipped with its package in the sidecar's `core/node_modules/highlight.js/LICENSE`).
