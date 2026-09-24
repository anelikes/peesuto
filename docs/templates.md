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

| Template | Classic | Editorial | More styles |
|---|---|---|---|
| Text | Paper | Ink | Poster (`poster`) |
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
| Terminal session | Night terminal | Command log | |
| Diff | Review | Night diff | |
| Error | Crash report | Console | |
| Schedule (`timeline`) | Agenda | Milestones | |
| Metrics (`stats`) | Dashboard | Scoreboard | |
| Lyric motion (`lyrics`; 文字 PV) | Stage | Paper | Pop (`pop`), Night (`night`) |
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
exceptions: the code terminal's backdrop (colour field, hue arc in GIFs) and window dots, the info
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
plan as `font`). Code and the other monospace templates (`MONO_TEMPLATES`:
code, terminal, diff, error) are always Peesuto Code. Maple comes in two cuts under
`core/src/render/fonts/`: Peesuto Code, Chinese at two Latin columns so code
aligns, and Peesuto Text, Chinese at 1em for everything else (the two-column
width reads as letter-spacing in prose; `scripts/fonts/peesuto-text.py`).
Both cuts carry keyboard and technical symbols from JetBrains Mono (⌘ ⌥ ⌃ ⎋ ⏎),
and CJK from GB 2312 and JIS X 0208 (level 1 and 2 kanji, kana, half-width
katakana, full-width letters and digits), so Chinese and Japanese text stay in
Maple. Its kanji are Chinese (PRC) glyph forms: 直 令 誤 look mainland to a
Japanese reader (Noto Sans SC draws them the same way); see the fonts README.
A card is set in the chosen face when it has every glyph (emoji aside), else in
the other one when that has them all (Noto lacks ⌥, Maple lacks 說); when
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
  full-width forms, all of GB2312 and all of JIS X 0208; see the README there;
  rebuilt by `scripts/fonts/build.sh`). CJK is exactly two
  columns wide, so indentation and alignment hold in mixed code. The composition
  gets its own copy (hard link or copy) under `compositions/paste/fonts/`, since
  engine font paths must stay inside the work tree. If any non-emoji character of
  the card is missing from Peesuto Code (traditional Chinese outside GB2312 and
  JIS X 0208, say), the whole card falls back to Noto Sans SC; there is no error and no mixed
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
- Backdrop (Terminal) depends on the output format: PNG and MP4 draw the
  Indigo night colour field (`CODE_FIELDS.indigo`, `CODE_STYLES.classic.backdrop`);
  GIF draws the hue arc below (`CODE_STYLES.classic.gifBackdrop`), since a
  256-colour GIF palette dithers the soft field visibly. A style's
  `gifBackdrop` replaces its `backdrop` in GIF output (null: the same
  backdrop). `layoutTemplate(plan, measure, { format })` takes the format;
  `composeTemplate` passes the one being rendered, and without one a still
  plan is laid out as PNG and an animated one as GIF (renderTemplate's
  default).
- Hue arc (Terminal GIF backdrop): not a two-colour blend. A straight RGB
  gradient between distant hues goes grey in the middle; walking the hue circle
  stays saturated. `core/src/templates/gradient.ts` samples the arc in OKLCH
  (even perceptual steps, chroma reduced to fit sRGB, hue and lightness kept)
  and the backdrop draws it as adjacent two-stop segments on whole pixels,
  since the engine only has two-stop gradients. Current arc: indigo, violet,
  magenta, coral, amber (hue 272° to 62°, lightness 0.34 to 0.76). No overlay:
  any tint across different hues (black over orange turns brown) muddies it.
- Colour-field backdrops: a backdrop layer
  `{ field }` draws a blurred colour field instead: a dark ground, a few large
  anisotropic Gaussian blobs of two or three neighbouring hues mixed in OKLab,
  an optional vignette and a fine seeded grain against banding.
  `core/src/templates/backdrop.ts` renders it to a PNG at compose time, at
  the canvas's own size (Pocket Motion v0.4.0 takes images of any size up to
  2048 px a side; only a longer canvas gets a raster scaled down to 2048, its
  grain reduced by the stretch so magnified noise does not read as a
  crosshatch), and it is drawn full-bleed under every shape. Mixing in OKLab
  and the seeded grain are beyond the engine's gradients, and one image costs
  a frame nothing where a blurred layer would be paid on every frame. PNGs
  are cached in `<work>/dist/.backdrops/` by a hash of the field and canvas
  size, about 0.2–0.3 s uncached at 1080p. Text drawn straight on a field is
  contrast-checked against the field's colour under it. `CODE_FIELDS` holds
  three fields for the terminal: Indigo night (the PNG/MP4 default), Dusk and
  Aurora (samples). In GIFs the 256-colour palette dithers a field visibly,
  hence the terminal's GIF fallback to the hue arc.

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

### Terminal session: commands, output and errors

- Recognized when the first line is a prompt and every other line is a
  prompt or output (blank lines kept): `$ `, `% `, `❯ `, `➜  dir`,
  `user@host:~/path$ `, `[user@host dir]$ `, `~/path $ `, `bash-5.2$ `,
  `PS C:\> `, `C:\Users> `, each optionally after a `(venv) `. It needs a
  prompt with a command and an output line, or two prompts with commands.
  A bare `$`, `%` or `❯` prompt counts only when some command starts with a
  well-known one (`git`, `npm`, `ls`, `docker`… in `KNOWN_COMMANDS`) or a
  path; a command that starts with a number (`$ 100 off`) is prose. A fence
  whose language is a shell (```` ```console ````, `sh`, `powershell`…) or
  none is read the same way. It ranks before code, which stays the
  alternative in the template menu.
- Drawn verbatim, line by line, in Peesuto Code: the prompt in a dim accent,
  the command bold and bright, output dimmed. Output that starts with
  `error`, `fatal`, `npm ERR!`, `E:`… or says `command not found`,
  `Permission denied`, `No such file or directory` takes the error colour;
  `warning`, `npm WARN`, `W:` the warning colour; colour only. A last line
  such as `[exit 1]`, `exit status 2` or `Process exited with code 0` is the
  exit status, in a pill: green for 0, red otherwise. A wrapped line
  continues two columns in (a hanging indent), so a wrap never reads as a new
  line.
- Night terminal: a window with three dots on the code card's Indigo night
  field (the hue arc in GIFs). Command log: a light page, each command on a
  tinted band, output beneath. Styles are `TERMINAL_STYLES` in `compose.ts`.

### Diff: added and removed lines

- Recognized when every line belongs to a unified diff: `diff --git` and
  `index` lines, mode, rename, similarity and `Binary files … differ` lines,
  `---`/`+++` headers, `@@ -a,b +c,d @@` hunks, and hunk lines starting with
  `+`, `-`, a space or `\` (a blank line is an empty context line). At least
  one hunk and one added or removed line. The hunk's counts decide whether a
  `---` line is a removed line or the next file's header; past the counts,
  a trimmed hunk still reads as one. A fence marked `diff` or `patch` (or
  unmarked) is read the same way. It ranks before code; the code card's own
  diff colouring remains the alternative and the fallback for anything this
  does not recognize.
- A commit header may sit above the diff. `git show` (and `git log -p` for
  one commit): `commit <sha>` (refs after it allowed), at least one field
  (`Author:`, `Date:`, `Merge:`, `--format=fuller`'s `AuthorDate:`,
  `Commit:`, `CommitDate:`), a blank line, the message indented four spaces,
  an optional `--stat`. `git format-patch`: `From <sha> Mon Sep 17 00:00:00
  2001`, mail headers with `From:` and `Subject:`, a blank line, the message,
  `---`, the diffstat, and after the diff the `-- ` signature with git's
  version. A header that starts like one but breaks (no fields, no message,
  a line that is not a header, no diff after it, a second commit) makes the
  whole text not a diff.
- The header is drawn as written above the files: the `commit`/`From` line
  small in the hunk colour, fields small, the subject (the first message
  line, or the `Subject:` line) bold (at most 1.25 × the small size), the rest of the
  message small. Syntax, not drawn: git's four-space indent, a folded
  Subject's line break (joined with a space), MIME and other transport
  headers (`MIME-Version`, `Content-Type`, `Message-Id`…), the `---`, the
  diffstat (the summary counts the lines) and the signature.
- Drawn verbatim: each file's path is its title (from `+++`, or `---` for a
  deleted file, or `diff --git`); the `diff --git`, `index`, `---` and `+++`
  lines and the `a/` `b/` prefixes are syntax and not drawn. A renamed file
  shows its old path above the new one unless a `rename from` line says it.
  Mode, rename and binary lines are drawn small, hunk headers small, every
  hunk line as written: its `+`/`-` in a gutter, the rest on a green or red
  tinted row (context untinted), `\ No newline at end of file` small. Wrapped
  lines hang two columns in.
- The summary: the counted added and removed lines, `+N −M`, beside the
  first file's path (Review) or under it (Night diff). The digits are the
  one thing drawn that the source did not write; they are marked
  `generated` and checked like code line numbers (a number from 1 to the
  larger count), and the + and − are shapes, not glyphs. A zero count is
  left out.
- Review: each file a white card, its path in a header band. Night diff:
  dark, the path as a heading, rows running edge to edge. Styles are
  `DIFF_STYLES` in `compose.ts`.

### Error: the message first, your own frames emphasised

- Recognized when a heading is followed by a stack trace and every line is
  accounted for. Headings: `TypeError: message` (any `…Error`/`…Exception`
  type, dotted or with Node's `[ERR_X]`), optionally after `Uncaught`,
  `Unhandled exception.` or `Exception in thread "main"`; `panic: …` and
  `fatal error: …` (Go); `thread 'main' panicked at file:line:col:` with the
  message on the next line (Rust; its backtrace is optional). Python puts
  the error last: `Traceback (most recent call last):` first, the
  `KeyError: 'a'` line last. Ruby starts with the top frame:
  `app.rb:12:in 'Integer#/': divided by 0 (ZeroDivisionError)` (backquotes
  before 3.4, namespaced classes such as `ActiveRecord::RecordNotFound`),
  error_highlight's snippet and carets may follow, then `from …` frames;
  Ruby 2.5–2.7 on a terminal prints them reversed under `Traceback` with the
  heading last (at least one `from` frame then). PHP:
  `PHP Fatal error:  Uncaught Exception: message in /path/file.php:42` (or
  `Fatal error: Uncaught …` without `PHP `), then `Stack trace:`, `#0 …`
  frames, `{main}`, `thrown in … on line n`, and `Next Class: … in …` for a
  chained exception. A PHP fatal error without a trace (memory exhausted,
  a parse error) and warnings are not error cards. Trace lines: frames (`at fn (file:line:col)`,
  `File "x.py", line n, in f`, `0: fn`, `#0 …`, Go's `main.main()`), lines
  indented under a frame (Python's source line and carets, Go's `file:line`),
  and notes (`... 3 more`, `Caused by: …`, `goroutine 1 [running]:`,
  `During handling of the above exception…`, `note: …`, `exit status 2`).
  At least one frame. An unfenced trace, or one fenced as text, a log or
  one of the languages that print these, is read. It ranks before code,
  which stays the alternative.
- Drawn verbatim: the lead small, the type in the error colour, the message
  large (the largest size that keeps it to four lines and the card in its
  frame); the colon between type and message is syntax. Ruby's location
  and PHP's `in /path:line` become the first frame (the parentheses around
  Ruby's class and PHP's `in` are syntax); PHP's `Fatal error: Uncaught` is
  the lead. Trace lines keep
  their text (their leading indentation trimmed; relative indentation under
  a frame kept, so carets still point). Frames in dependencies, the standard
  library or the runtime (`node_modules`, `site-packages`, `node:`,
  `/usr/lib/`, `java.`, `System.`, `/rustc/`, Go's `runtime.`, Ruby's
  `gems/`, `lib/ruby/` and `<internal:…>`, PHP's `vendor/`,
  `[internal function]` and `{main}`… in
  `LIBRARY_FRAME`) are dimmed; your own frames are bold with a mark. Lines
  break at identifier punctuation (`.` `/` `:` `(`…) as well as spaces, so
  a long qualified name wraps between its parts, never inside one; wrapped
  lines hang two columns in (terminal and diff cards break the same way).
- Crash report: warm page, the trace on a tinted panel, a red bar beside
  each own frame. Console: dark, the trace along a rail with a red dot at
  each own frame. Styles are `ERROR_STYLES` in `compose.ts`.

### Schedule (timeline): times and dates on a line

- Recognized when an optional title line (a `#` marker is syntax) is
  followed by at least two lines that each start with a time or a date and
  have text after it, and nothing else. Times: `09:00`, `9:30am`, `2pm`,
  `下午3点`, ranges `14:00–15:00`. Dates and periods: `2026-09-24`,
  `2026年9月`, `9月24日`, `9/24`, `Sep 24`, `24 Sep`, `Q3 2026`, `H2`, a year,
  `周一`, `星期三`, `Monday`, `Mon`, `第一周`, `Day 3`, `Week 2`, `today`,
  a date with a time. A list marker before and a separator after the time
  (spaces, `-`, `:`, `|`, `→`) are syntax.
- Not a schedule: a conversation (the chat template takes speaker and time
  lines, and a chat candidate suppresses this one), logs (a time with
  seconds, an ISO `T` timestamp, a level such as `INFO`/`WARN`/`错误` after
  the time, `key=value` text), a label with only a number or percentage
  after it (a metric), fractions before cooking units (`1/2 cup`). It ranks
  after info and before quote, list and chat, so a bulleted schedule is a
  schedule.
- Agenda: times right-aligned in a column (as wide as the widest time, at
  most 40% of the card; a wider time stacks above its event), a line with a
  dot per event, the events beside it. Milestones: dark, the line at the
  left edge, each date above its event. Styles are `TIMELINE_STYLES` in
  `compose.ts`. The English name is Schedule, since the release-notes card
  already has a style called Timeline.

### Metrics (stats): several numbers in a grid

- Recognized when an optional title line (`#` marker and a trailing colon
  are syntax) is followed by at least two (at most twelve) `label: value`
  lines and nothing else, every value a number as written: currency,
  grouping, decimals, a unit (`%`, `k`, `万`, `ms`, `人`…) or a ratio
  (`4.8/5`), optionally followed by a change: signed (`+8%`, `−3.1% WoW`,
  `↓0.3pp`, `环比+8%`) or in parentheses (`(+8%)`, `（-4%）`; the
  parentheses are syntax). Labels are unique; `- ` markers are syntax.
- The boundary with the info card: every value must be a number, so a block
  mixing in an email, a URL or text is an info card; a number under an
  identifier or contact label (phone, QQ, ID, order number, port, account,
  version, 手机, 订单号, 单号…, in `IDENTIFIER_LABEL`) or a bare string of
  seven or more digits (a phone number, an ID) makes it an info card too.
  One `label: number` line stays the single-number stat card. It ranks after
  release notes and before info, schedule and chat (`A: 5`, `B: 7` are
  metrics, not a conversation).
- Layout: two columns for two or four metrics, else three, fewer when the
  values do not fit; the value size is the largest that fits every cell
  (and the frame, when it can). Each cell: the label small, the value large,
  the change under it in green when it rises (`+`, `↑`, `▲`) and red when it
  falls (`-`, `−`, `↓`, `▼`), neutral when unsigned; colour only. Dashboard:
  white tiles on a warm page. Scoreboard: night, hairlines between the
  cells, values in yellow. Styles are `STATS_STYLES` in `compose.ts`.

### Lyric motion (文字 PV): any text as kinetic type, by choice only

Inspired by [JIZURA](https://github.com/852wa/JIZURA) (MIT), a browser
lyric-video maker by 852wa: its vocabulary (a cut = layout + entrance + hold +
exit + decor) and its lyric markup are what this template speaks. No JIZURA
code or assets are used. Peesuto makes the quick version; the result panel's
**Open in JIZURA** hands the text over for a full video (below).

Lyric motion is a **manual** template, like QR: rules and the model never
choose it (`MANUAL_TEMPLATES`; the model is never offered it), and every text
has it as an available candidate, so a result's template menu can always
switch to it. The `paste-lyric` action (L in the ⌥V chooser, an unbound
shortcut in Settings, Paste Directly in the menu bar) always uses it: an MP4
when ffmpeg is installed, else a GIF, and the result says so
(`meta.fallback = { from: "video", to: "gif", reason: "ffmpeg" }`). It is
never precomposed (fixed-template actions have no precompose key). The id
stays `lyrics`, so saved styles and disabled lists keep working; the
user-facing name is "Lyric motion" / 「文字 PV」 / 「文字PV」.

- **Content** (`lyricMotion` in `parse.ts`): lyrics, LRC and poems keep their
  own lines (read as below); code, terminal sessions, diffs, errors, tables,
  diagrams, what the legacy classifier calls code (CSS, minified scripts,
  logs) and text that is only links are marked `unfit`, and composing them
  is an explicit `lyric-unfit` error ("use an image instead"); everything else
  is **prose**:
  - paragraphs are stanzas, a first `# ` line the title, `[Chorus]` lines
    labels, and each line is cut by `splitCuts`;
  - a cut ends at a sentence end (。！？!?… and a Latin `.` before a space,
    never an abbreviation's, 3.14's or a URL's); clause marks (，；：,;: and a
    spaced dash) end a clause, and clauses of one sentence share a cut while
    it stays within `CUT_JOIN_UNITS` (10 units: a CJK character is one unit,
    anything else a half); a clause of three units or less ("Oh," "嗯，") and
    the items of a 、 series join up to `CUT_MAX_UNITS` (16);
  - a clause longer than `CUT_MAX_UNITS` is broken between words (ICU) into
    near-even pieces, preferring natural points: Japanese after a particle
    (は が を に で と…), Chinese before a conjunction or adverb (但 而 因为 就
    才…) or after 了/着/过 and never after 的, English before a conjunction or
    preposition and never after an article, a possessive or a preposition;
    never inside a word, an `*emphasis*` run, a URL or an address;
  - JIZURA markup keeps working: `/` marks cuts of its own, `*word*`,
    a trailing `!`, `line|note` (the note goes with the line's last cut);
  - prose is read, not sung: a prose cut is never shown shorter than
    0.14 s per CJK and 0.06 s per other character (`proseCjkMs`,
    `proseLatinMs`).
  Inside a cut, rows never end on a word that leads into the next (the, a,
  to, my…; a lone Chinese character before a word, 新|版本), and a measure
  word stays with its numeral (每一位).
- **Lyric-shaped text** is read three ways:
  - **LRC**: every non-blank line is a timestamped line (`[mm:ss.xx]`, several
    stamps repeat the line) or a header tag, at least two with text.
    Timestamps and enhanced word timings (`<mm:ss.xx>`) are syntax; `[ti:]`
    is drawn as the title and `[ar:]` as the credit, other tags (`[al:]`,
    `[by:]`, `[offset:]`…) are file metadata and not drawn. A stamp with no
    text ends the line before it and starts a new stanza. LRC ranks before
    chat and schedule, which also never parse an LRC block (`[00:12.34]`
    looks like a speaker, and like a time).
  - **A classical poem**: every line one or two phrases of 4 to 7 Han
    characters (床前明月光，…), all phrases the same length, an even number of
    them, optionally under a title line and an author line, or with a
    `—— author` line at the end (a poem, not a quote).
  - **Lyrics**: at least four short lines (three with markup), each at most
    `LYRIC_LINE_UNITS` (20 CJK or 40 Latin characters), at most one in five
    ending in or containing a sentence stop, nothing that marks another
    structure (list markers, `key: value` fields on two lines, lines starting
    with a time or date, URLs, emails, code characters, table pipes, more
    than 30% digits), and some evidence of a song: JIZURA markup; two stanzas
    between blank lines or a repeated line, with a lyric voice (I, you, love,
    night, 我, 你, 夢, 君…) in some line (two blocks of meeting notes have
    none); or six lines or more, 60% of them in that voice. A first `# ` line is the
    title; `[Chorus]` / `【副歌】` lines label their stanza. Short lines with no
    such evidence (a to-do list without markers, even "Call my mom / Buy milk
    for you") are prose.
  Automatically, lyrics are text, poems text or a quote, LRC a document (an
  LRC block still never parses as a chat or a schedule). An LRC line longer
  than `LYRIC_LINE_UNITS` is cut by `splitCuts`, its pieces sharing its time
  by length.
- **Markup** (JIZURA's): `/` cuts a line into separate screens (a slash
  between digits, in `//` or a URL is text; two Latin words either side of a
  bare `/` keep a space); `*word*` emphasises; `lyric|note` adds a small note;
  a trailing `!` stays text and adds a flash and a shake.
- **Styles** (`LYRICS_STYLES`, `LYRICS_MOTION` in `lyrics.ts`): four, each a
  set of colour schemes, a display face per script, a motion set, a decor set
  and a texture. The ids stay `classic` and `editorial` for the first two.
  | Style | Faces (zh / ja / Latin) | Schemes | Motion |
  |---|---|---|---|
  | Stage (`classic`) | Peesuto Grin (得意黑) / Dela Gothic One / Anton | night, red, cobalt, yellow, cream | smooth, snappy; hard cuts, slices, colour swaps; giant words, bands, split fields; light grain and vignette |
  | Paper (`editorial`) | LXGW WenKai / Kaisei Tokumin / Instrument Serif italic | paper, indigo, fog, sumi | smooth and slow, crossfades, focus-in letters; vertical CJK, captions under hairlines, a vermilion seal; paper tooth |
  | Pop (`pop`) | ZCOOL KuaiLe / Zen Maru Gothic Black / Zen Maru | pink, lemon, sky, grape, mint | koma-uchi at 12 fps, bouncy pops and drops; stickers, waves, size jumps, tickers |
  | Night (`night`) | Peesuto Grin / DotGothic16 / DotGothic16 | black, deep blue, acid, magenta | koma-uchi at 12 fps, flicker, jitter; chromatic ghosts on every cut, glitch cuts, a camera HUD; scanlines, grain, vignette |
  Every scheme keeps ink, accent and secondary text at 4.5:1 or more against
  its ground and its tint, and plate ink against its plate (tested).
- **Faces** (`core/src/render/fonts/README.md`, "Display faces"): the style's
  face for the text's script (kana → ja, Han → zh, else Latin) sets the
  lyric and the title; notes, labels, credits and the signature stay in the
  card's pair. A face that cannot draw every character of the text it sets
  is left out for that card (compose.ts `faceTexts`), which then falls back
  as before (Peesuto Text, else Noto Sans SC).
- **PNG, a lyric poster.** Stage: a slab of bold type on one colour of the
  palette (chosen by the lyrics, so the same lyrics give the same poster),
  every line at the largest size that fits the measure (a much longer line
  may break in two, sizes within `stackRatio` of each other), emphasis in the
  accent, a quiet disc in the emptiest corner when the poster keeps its
  frame. Paper: a calm centred column, emphasis in vermilion; CJK verse (no
  Latin, brackets or ー) is set vertically, right to left, title and author
  first, a comma or full stop in the top-right corner of its cell (the line's
  box is where the mark lands, `offset` says how far it is drawn from it).
  Pop and Night set the slab in their own faces and schemes. A poem's lines
  are set phrase by phrase.
- **GIF/MP4, a lyric video** (`lyric-video.ts` plans and lays out,
  `lyric-film.ts` bakes the animation). Each line, or `/` piece, is a cut, a
  title card first when there is a title or credit. A share of the lines of
  six units or more (`chunk`: Stage 55%, Pop and Night 60%, Paper 12%) is
  broken into two or three chunks of whole words, a cut each, never inside an
  emphasised run: a line lands in two or three hits and keeps its colour
  across them. A cut is:
  - a **layout**, drawn by a seeded planner from 21 (`LYRIC_LAYOUTS`): centre;
    low left under an accent rule; a stack stepping across; **steps** (rows of
    one or two words whose sizes jump, big–small–big); **giant** (a short line
    as one or two rows filling the frame's width); **focus** (one glyph of the
    line as a giant ghost, solid in the tint or hollow, the line over it);
    **diagonal** (the line on a tilted band across the frame); **split** (two
    colour fields, the line broken across them); **mix** (CJK: the first
    phrase in a tall column, the rest across the bottom left); vertical CJK
    columns; **echo** (hollow ghost repeats above and below); **jump** (the key
    word twice the size on one baseline); **labels** (each word on an ink
    plate); **sweep** (thick bars sweeping under the rows, a marker behind the
    emphasis); **numeral** (the cut's number as a giant graphic); **caption**
    (smaller, in the lower corner under a hairline, the cut number at its end);
    **cascade** (words stepping down); **frame** (a thick frame drawing itself
    round the screen); **ticker** (bands of the line running above and below);
    **wide** (one spaced-out row between rules); **wave** (glyphs whose sizes
    and baselines rise and fall). Weights come from the style, the cut
    (short lines favour giant and wave, emphasis and `!` giant, jump and split,
    CJK portrait frames vertical and mix) and novelty (a layout used in the
    last two cuts is almost never drawn, in the last six rarely). A layout
    that cannot keep the rules below for a cut is not used for it; center
    always can.
  - an **entrance** suited to the layout: per glyph (rise, drop with a
    bounce, slide, pop with overshoot, focus from a blur, flicker, typewriter
    with a caret), per plate (zoom, pop), or of the whole block (a wipe: a
    window moving over still type with an accent bar on its edge; slices:
    three bands sliding in from alternate sides);
  - a **hold** on the block (drift, float, breathe 1 → 1.035, a stepped
    jitter) and, on a trailing `!`, a stepped shake and a flash;
  - **emphasis**: engine type punches (lifts, turns from ink to its paint);
    a plate glyph jumps in size (1 → 1.32 → 1);
  - a **transition** from the cut before (hard cut, wipe, slices of the new
    ground, a white or accent flash, a colour swap through the new ink,
    glitch bands in the ghost colours, crossfade); within a line's chunks,
    hard cuts and now and then a flash;
  - **chromatic ghosts** (`ghosts.share` of the cuts): two copies of the
    lyric in the scheme's ghost colours behind it, offset, screen-blended on
    dark grounds and multiplied on light ones, spiking on the cut and on every
    beat;
  - **decor** on quiet layouts (bars, a soft orb, dots; rules and a sun in
    Paper) kept clear of the text; Night adds a camera HUD (corner brackets,
    the cut number over the count);
  - **texture** over everything (`texture`): sparse film grain that changes
    12 times a second, scanlines (Night), a paper tooth (Paper), a vignette
    lighter on light grounds; none in a GIF.
  **Koma-uchi**: Pop and Night (`koma: 12`) sample every motion at 12
  drawings a second and hold each (pairs of keyframes one engine tick apart,
  linear; the engine has no steps()), with delays on the same grid; Stage and
  Paper are smooth. **Beat**: cut lengths snap up to whole beats of the
  style's tempo (`bpm`: Stage 120, Paper 84, Pop 128, Night 132; LRC timing is
  kept as written), and ghosts and decor pulse on the beat.
  Everything is seeded by the source text: the same text gives the same video.
- **Type plates** (`type-raster.ts`): Pocket Motion bakes glyphs into atlases
  whose cell metrics are bytes (about 176 px at most) and never turns or
  resizes a Text node, so lyric type above the engine's sizes (plate sizes
  184–360 px at 1080), tilted, jumping or outlined is set by Peesuto itself:
  the face's TrueType outlines filled by an exact-area scanline rasteriser
  (an outline from a distance transform, gradient ink by row) into an RGBA
  PNG, drawn as an Image. A plate line keeps its place in the layout (its box
  is the em box on its baseline) and passes the same checks. Plates are drawn
  once per content and cached under `dist/.plates`. A card whose text a face
  cannot draw (or set in Noto) uses engine sizes only.
- **Timing** (`LYRICS_TIMING`): about 0.35 s per CJK character and 0.18 s per
  other character, at least 1.1 s (a chunk 0.65 s) and at most 3.6 s per cut
  (prose: never below its reading floor); LRC timestamps when present (a
  line lasts until the next stamp, a `/` piece or chunk its share). An MP4
  runs to 30 s (`maxMs`); a GIF keeps to the longest animation other
  templates make (`gifMaxMs`, 14.4 s) and to the frame-memory budget at the
  narrowest 360 px width (about 9.6 s at 9:16). A longer excerpt is played
  faster in proportion, down to each cut's floor. When the cuts cannot fit,
  chunked lines become whole again, then two cuts of a stanza share a
  screen; if that is still too long the render stops with an explicit
  `lyric-too-long` error. No text is ever dropped. The last cut holds.
- **Checks**: a video's cuts share the canvas but never the screen, so the
  quality checks run per cut against that cut's own ground (a tilted plate
  against its band, split halves against their field), and the source ledger
  over the whole layout (`lyricsViolations` in `lyric-video.ts`). Ghost
  repeats, tickers, the big numeral and the HUD are `decorative`: they must be
  source text (or a cut number within range) but never count as the text
  drawn, and are exempt from the size, contrast and overlap checks, so they
  can never stand in for the lyric.
- **Engine paint** (Pocket Motion v0.4.0), per style (`engine`, in em, never
  scaled): Stage gilds the emphasised word (gradient ink whose stops keep the
  contrast against the ground and its tint) with a low glow of the accent
  (not on light grounds, never in a GIF); Paper inks it heavier (an outline
  of its own colour); Night gives it a neon glow of the accent. Plates keep
  gradient ink and the outline; the glow is engine type's only.
  Contrast checks read the paint (`inkColors` in checks.ts): gradient ink
  counts both stops, hollow text its outline (and fails below the large
  size), an outline of at least 4% of the size counts as a halo.
- **Cost**: a 20 s 1:1 MP4 renders in about 17–23 s on an M-series Mac
  (Paper fastest, Night slowest), 9:16 in 15–38 s. Full-canvas images are the
  expensive part of the software rasteriser, so textures are sparse and
  sampled nearest.
- **Open in JIZURA** (native result panel, lyric-motion results only):
  JIZURA's web app takes no lyrics in its URL (it starts from what it saved
  in the browser; checked in its `src/12_ui.js`), so the button copies the
  text exactly as written (markup included: JIZURA reads the same syntax)
  and opens the app, the Japanese edition for a Japanese interface and the
  English one otherwise, with the note "Text copied — paste it in JIZURA". `JizuraHandoff` in `native/Sources/PeesutoKit`.

### QR code: any text, by shortcut only

Every text can become a QR code, so QR is never chosen automatically: it is
always among a result's available templates (the template menu can switch to
it), the model is never offered it, and the `paste-qr` action (Q in the ⌥V chooser) always
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
`lyrics` and `qr` are never chosen automatically anyway (Settings shows "Only
when chosen" for them). The list is part of the precompose
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
  Adobe's Source Han Sans), and symbols from JetBrains Mono v2.304, all under the SIL Open Font License 1.1:
  `core/src/render/fonts/OFL.txt`. The OFL allows bundling in commercial software; the font
  files may not be sold on their own.
- [highlight.js](https://highlightjs.org/) 11.12.0, © 2006 Ivan Sagalaev and contributors,
  BSD 3-Clause License (shipped with its package in the sidecar's `core/node_modules/highlight.js/LICENSE`).
- The lyrics template is inspired by [JIZURA](https://github.com/852wa/JIZURA) by 852wa (MIT
  License): its cut vocabulary and lyric markup. No JIZURA code or assets are included; the
  "Open in JIZURA" action only opens its public web app.
