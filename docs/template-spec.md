# Community templates: a declarative format (proposal)

Status: proposal, not implemented. Today every template is TypeScript in
`core/src/templates/`; this note describes the format a community template
would ship in, so that templates can be shared and installed without running
anyone's code. It borrows from kami (per-template content schemas and a
`checks_thresholds.json`) and ljg-card (a verified text ledger before output).

## What exists today

| Piece | Where | Declarative already? |
|---|---|---|
| Content types (what a template consumes) | `TemplateContent` in `types.ts`, filled by `parse.ts` | Shape yes, parsers no |
| Registry (id, bilingual names, styles, motions) | `registry.ts` | Yes |
| Style tokens (colours, sizes, spacing, ornament slots) | `*_STYLES` in `compose.ts` | Yes: layout code reads only these |
| Layout (where each block goes) | `layoutAt()` in `compose.ts`, one case per template | No: code |
| Quality gate | `checks.ts` (`CHECK_THRESHOLDS`, `checkLayout`) | Yes: data in, violations out |
| Shared rules | `READABILITY`, `SIZES`, one font pair, SVG limits | Constants |

## The package

A template is a directory (or a zip of one) with no executable content:

```
my-template/
  template.json      manifest: id, version, names {en, zh}, author, license (SPDX), content kind
  styles.json        one entry per style: tokens with the same keys as a built-in *_STYLES table
  layout.json        a tree of layout primitives (below), bound to content fields
  assets/*.svg       optional: fill-only paths, square power-of-two box ≤ 512, no arc commands
  samples/*.txt      optional extra sources the gate also renders
```

- **Content schema.** A template declares which existing content kind it
  consumes (`list`, `chat`, `info`…) and which fields it draws. Parsers stay
  built in: they are code, and they are where "only the source's words" is
  enforced. A new kind is a core change, not a package.
- **Layout primitives.** A small closed set, each already implemented as a
  layout case today: `stack` (blocks top to bottom), `columns`, `bands`
  (full-bleed), `cards`, `grid` (table), `ledger`, `bubbles`, `field-list`,
  `hero` (one value, one label), `graph` (the diagram engine). A primitive
  takes a content field (`items`, `turns[].text`…) and style token names; it
  can never supply a string of its own. Numbers for ordered items and the
  signature footer are the only generated text, as now.
- **Styles** are data with today's token names: colours, SIZES members, px at
  the 1080 reference width (scaled like built-ins), ornament slots that may be
  null. Each style needs a `signature` colour. Fonts: the bundled pair only.

## The publish gate

`checkLayout` becomes the gate, run by a `templates check <dir>` command and
by any registry that lists packages. A package passes when, for every style,
every frame (auto, 1:1, 4:5, 16:9, 9:16), with and without a signature, and
for the built-in sample corpus of its content kind plus its own samples:

- no `overflow`, `overlap`, `untraceable` or `missing` violation (the runtime
  guard already refuses these);
- no `size` or `contrast` violation either (the runtime only logs these; a
  published template must be clean): `CHECK_THRESHOLDS` is the one source of
  numbers (13/11 px on a 390 px phone, 4.5:1 body, 3:1 large);
- every font size is a `SIZES` member; the two styles are geometrically
  distinct; assets meet the SVG rules;
- bounded cost: at most N shapes and M assets per card, measured on the corpus.

## The sandbox

- No code: JSON and SVG only; the renderer interprets them. No expressions
  beyond token references and field bindings.
- No network: assets are in the package; no URLs anywhere, fonts included.
- No new glyphs: text comes from content fields, the signature and ordered
  numbers; the fidelity check runs at render time as it does now.
- Installed packages are read only and versioned; a package that fails the
  gate after an app update (new thresholds) is disabled, not rendered.

## Open questions

- Whether motion (reveal order, typewriter) is declared per primitive or
  fixed per kind (today: fixed).
- How a package's samples and screenshots are reviewed for content, which is
  a moderation question, not a format one.
- Migrating built-ins: the first step is to express two existing templates
  (list, info) in this format and render them bit-identically.
