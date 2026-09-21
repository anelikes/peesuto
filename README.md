# pocket-paste

A smart clipboard for macOS, and a way into AI actions through the thing you
already do a hundred times a day: copy, paste.

- **History.** Everything you copy is kept locally, encrypted, searchable,
  one hotkey away. Password managers and concealed pasteboard content are
  excluded by default.
- **Smart paste.** When you paste into a field, the app reads where you are
  (through macOS Accessibility) and a small decision model preselects the
  history item that fits. You confirm with Enter; nothing is pasted for you.
- **Actions.** Paste as a card or a GIF (rendered deterministically by
  Pocket Motion), paste a translation, paste a summary, or paste the result
  of your own prompt. Actions are JSON files; packs of them can be shared.
- **Your models.** Two tracks, each self-hostable: a decider (Jev through
  your own Cloudflare account, any compatible endpoint including the proxy in
  this repository, or none) and a generator (any OpenAI-compatible endpoint
  such as Ollama, vLLM or LM Studio, Anthropic, or none). One egress layer,
  one offline switch, a log of where bytes went and never of what they were.

Everything here is MIT. A subscription, when it exists, buys hosted model
calls that need no setup and official style and action packs; the formats
stay open.

## The card

The first action, and where the project started: copy text, paste a card.
Jev (TypeSafe AI) answers typed questions about the text — what kind it is,
which layout, palette, size, tone, which word to emphasise, whether motion
would reveal a sequence. Every answer is a choice from a fixed set. Pocket
Motion renders the card from those choices; line breaks and sizes are
measured, never guessed.

## Layout

```
core/        Core (Bun + TypeScript): the judgement — pick, actions, providers, render
  src/cli.ts       `paste`, the command line for the card chain
  src/daemon/      the long-lived sidecar the app talks to (JSON lines)
  src/pick/        smart paste: context levels, the pick question, the heuristic
  src/actions/     action format, loading, the five built-ins, the runtime
  src/provider/    decider and generator tracks behind one egress layer
  src/catalog.ts   every name the decider may choose for a card, with the numbers behind it
  src/questions.ts the card's seven questions and answers → DSL
  src/render/      composition generation, emoji, engine driver, GIF
  fixtures/        five DSL fixtures and the digests they render to
app/         the macOS menu-bar app (Tauri 2): history, paste simulation,
             context capture, encrypted store, Keychain, windows
proxy/       a self-hostable Cloudflare Worker that forwards questions to Jev
docs/        actions format, releasing
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

## Privacy

What leaves the machine, and only when you chose that provider:

| provider | what is sent | to |
|---|---|---|
| decider `none` | nothing | — |
| decider `cloudflare` | the typed questions and the text they are about | your own Workers AI account |
| decider `endpoint` | the same | the URL you set (your own proxy, or ours) |
| generator `openai-compatible` / `anthropic` | the filled prompt | the base URL you set |
| generator `hosted` | the filled prompt | our proxy, which does not store it |

The offline switch in Settings closes the single egress path for everything
above. Emoji pictures are fetched by codepoint from a CDN once and cached;
that reveals which emoji, not the text. History is stored encrypted with a
key in your Keychain. See `SECURITY.md`.

## Status

Work in progress towards v1; the plan and its milestones are `PLAN.md`.
