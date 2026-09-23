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
orthogonal routing with one channel per edge between ranks. Edge labels sit on
a long horizontal run, or beside the line under the source. Size tiers from
56 px down are tried until the diagram fits the card; height alone never pushes
text below 32 px, the card grows instead (and an animation scrolls). A diagram
too wide even at 24 px is an overflow error. Reveal and typewriter bring the
diagram in rank by rank, the edges into a rank just before its nodes. Styles
are `DIAGRAM_STYLES`; size tiers `DIAGRAM_TIERS`, both in
`core/src/templates/compose.ts`. Arrowheads and diamonds are small SVGs the
engine bakes; everything else is boxes and text.

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
| auto | width 1080 (1440 for tables of 4+ columns, code lines over 56 characters and sideways diagrams; wider again on overflow), height hugging the content | images, by default |
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
