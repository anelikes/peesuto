# pocket-paste

Copy text anywhere, get a card back: a PNG, or a short GIF when the text has
an order worth revealing.

Jev (TypeSafe AI, reached through Cloudflare Workers AI) answers typed
questions about the text — what kind it is, which layout, palette, size,
tone, which word to emphasise, whether motion would reveal a sequence. Every
answer is a choice from a fixed set. Pocket Motion renders the card from
those choices; line breaks and sizes are measured, never guessed.

The core is open source. Text leaves your machine only to answer those
questions, and only through the provider you configure (below).

## Layout

```
core/        the render chain (Bun + TypeScript): text → decisions → DSL → card
  src/cli.ts       `paste`, the command line and the desktop app's sidecar
  src/catalog.ts   every name Jev may choose, with the numbers behind it
  src/questions.ts the seven questions and answers → DSL
  src/provider/    where the questions go: none | proxy | (cloudflare, hosted)
  src/render/      composition generation, emoji, engine driver, GIF
  fixtures/        five DSL fixtures and the digests they render to
app/         the macOS menu-bar app (Tauri 2), a shell around `paste`
proxy/       a Cloudflare Worker that forwards questions to Jev
scripts/     engine setup, sidecar bundling, probes
engine.json  the pinned Pocket Motion commit
```

## Run from a checkout

Needs Bun 1.3.x. The engine is a separate checkout, pinned in `engine.json`;
`bun run setup` fetches and prepares it into `engine/` (Rust with the
`wasm32-unknown-unknown` target is required for its rasteriser), or set
`POCKET_ENGINE` to an existing pocket-motion checkout.

```bash
bun install
bun run setup                      # or: export POCKET_ENGINE=../pocketjs-motion

# no decision provider: a plain card, never wrong, never clever
bun run paste --provider none "本季度活跃用户增长了 37%，是过去三年最快的一次。"

# with Jev through the dev proxy (wrangler's own login, no key handled)
(cd proxy && npx wrangler dev --port 8787) &
bun run paste "本季度活跃用户增长了 37%，是过去三年最快的一次。" --aspect doc
pbpaste | bun run paste --stdin --aspect chat

# render a DSL as-is, skipping Jev
bun run paste --dsl core/fixtures/quote.json --out out/quote.gif
```

Output lands in `out/` unless `--out` says otherwise. `--json` prints one
JSON object with the path, the DSL and timings, which is how the app drives
it. Rendering happens in a symlink tree under `.work/` — the engine checkout
is never written to.

## How a paste is measured

Text is measured against a cached metrics-only bake of
`core/src/render/charset.txt` (ASCII, CJK punctuation, GB2312 level 1), so a
paste costs one composition build, not two; a character outside the charset
falls back to a per-paste measurement build. Emoji are pictures: split out of
the text, fetched once from Noto Emoji at a pinned tag, staged beside the
composition and drawn inline at the font size, measured as one advance when
wrapping.

## Tests

```bash
bun test core/tests          # unit tests; the fixture renders skip without an engine
bun run typecheck
```

`core/fixtures/digests.json` holds the SHA-256 of frames the five fixtures
render to at the pinned engine; a change there is either a deliberate
re-recording or a regression.

## Status

Work in progress towards v1: a menu-bar app, an open-source CLI with your own
Cloudflare credentials, and a hosted subscription that needs no setup. The
plan is `PLAN.md`.
