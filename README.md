# pocket-paste

A smart clipboard for macOS, and a way into AI actions through the thing you
already do a hundred times a day: copy, paste.

- **History.** Everything you copy is kept locally, encrypted, searchable,
  one hotkey away. Password managers and concealed pasteboard content are
  excluded by default.
- **Smart paste.** When you paste into a field, the app reads where you are
  (through macOS Accessibility) and a small decision model preselects the
  history item that fits. You confirm with Enter; nothing is pasted for you.
- **Actions.** Paste as a card, GIF or video (rendered by
  Pocket Motion), paste a translation, paste a summary, or paste the result
  of your own prompt. Actions are JSON files; packs of them can be shared.
- **Your models.** Two tracks, each self-hostable: a decider (Jev through
  your own Cloudflare account, any compatible endpoint including the proxy in
  this repository, or none) and a generator (any OpenAI-compatible endpoint
  such as Ollama, vLLM or LM Studio, Anthropic, or none). One egress layer,
  one offline switch, a log of where bytes went and never of what they were.
  A fresh install decides cards by rules and picks by the heuristic, so it
  works with nothing configured and nothing leaving the machine; `docs/laya.md`
  adds a local model for people who want one.
  Thinking models (Ollama's qwen3.5, gemma4, …) work out of the box: the
  generator notices an answer that was all reasoning and no text, repeats
  the request with `reasoning_effort: "none"`, and keeps doing so from then
  on; *Settings → Providers → Thinking* pins that choice or a budget.

Everything here is MIT. A subscription, when it exists, buys hosted model
calls that need no setup and official style and action packs; the formats
stay open.

## Desktop architecture direction

The agreed target is **SwiftUI + AppKit for the macOS desktop, retaining the
TypeScript/Bun Core and the independent Pocket Motion engine**. Tauri and the
UI WebView will be removed; Electron is not part of the design. Bun remains a
local business/render runtime, not a UI runtime. Image, GIF and video generation
are core product capabilities. PNG/GIF and MP4 actions are implemented; MP4
requires locally installed ffmpeg, which is not bundled or installed automatically.

**The first native build is implemented; migration is incomplete.**
[`native/`](native/README.md) builds a standalone SwiftUI + AppKit `.app`, with
encrypted history, bundled Core, PNG/GIF/MP4 actions and bilingual settings.
The native app can transform the current clipboard directly with configurable
`⌘⌥1` (image), `⌘⌥2` (GIF) and `⌘⌥3` (video). Change or disable bindings in
Settings → Shortcuts. It pastes automatically only when the original insertion
point can still be verified; newer clipboard contents are preserved.
`app/` and its commands still build the Tauri version for comparison.
The native UI replaces its system layer
as well as its HTML interface, while preserving history, credentials, actions,
providers, packs and English/Simplified Chinese support. See
[PLAN.md](PLAN.md) and the [native migration plan](docs/native-migration.md)
for the scope, task protocol work and actual `.app` acceptance requirements.

## The card

The first action, and where the project started: copy text, paste a card.
Jev (TypeSafe AI) answers typed questions about the text — what kind it is,
which layout, palette, size, tone, which word to emphasise, whether motion
would reveal a sequence. Every answer is a choice from a fixed set. Pocket
Motion renders the card from those choices; line breaks and sizes are
measured, never guessed.

## Current layout

```
core/        Core (Bun + TypeScript): the judgement — pick, actions, providers, render
  src/cli.ts       `paste`, the command line for the card chain
  src/daemon/      the long-lived sidecar the app talks to (JSON lines)
  src/pick/        smart paste: context levels, the pick question, the heuristic
  src/actions/     action format, loading, the six built-ins, the runtime
  src/provider/    decider and generator tracks behind one egress layer
  src/catalog.ts   every name the decider may choose for a card, with the numbers behind it
  src/questions.ts the card's seven questions and answers → DSL
  src/render/      composition generation, emoji, engine driver, GIF/MP4
  fixtures/        five DSL fixtures and the digests they render to
native/      the new SwiftUI + AppKit desktop, compatibility modules and tests
app/         the existing menu-bar app (Tauri 2): history, paste simulation,
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
JSON object with the path, the DSL and timings for CLI consumers. The desktop
normally uses the persistent [daemon protocol](docs/daemon.md). Rendering happens
in a symlink tree under `.work/`; see the engine build isolation rules in
[CONTRIBUTING.md](CONTRIBUTING.md).

## The current app (Tauri, pending native replacement)

From the repository root, start the current development app:

```bash
(cd app && bun install && bun tauri dev)
```

Or build the current bundled app, also starting at the repository root:

```bash
bun scripts/fetch-emoji.ts        # once: the bundled emoji set
bun scripts/bundle-sidecar.ts --out app/src-tauri
(cd app && bun install && bun run build:bundled)
```

These are Tauri commands, not native Swift build instructions. The native
build entry point is documented in [native/README.md](native/README.md).

`app/README.md` describes the shell: the history panel and smart paste,
the encrypted store, Accessibility context capture, the daemon lifecycle
and the settings panes. Accessibility permission is required for paste
simulation and context capture.

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
| decider `rules` (the default) | nothing | — |
| decider `none` | nothing | — |
| decider `laya` | the typed questions and the text they are about | the local URL you run `scripts/laya/server.py` at, `127.0.0.1` unless you change it |
| decider `cloudflare` | the typed questions and the text they are about | your own Workers AI account |
| decider `endpoint` | the same | the URL you set (your own proxy, or ours) |
| generator `openai-compatible` / `anthropic` | the filled prompt | the base URL you set |
| generator `hosted` | the filled prompt | our proxy, which does not store it |

The offline switch in Settings closes the single egress path for everything
above. Emoji pictures are fetched by codepoint from a CDN once and cached;
that reveals which emoji, not the text. History is stored encrypted with a
key in your Keychain. See `SECURITY.md`.

## Status

The v1 migration is incomplete; the plan and its milestones are `PLAN.md`.
