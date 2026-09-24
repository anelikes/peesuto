# pocket-paste

A smart clipboard for macOS, and a way into AI actions through the thing you
already do a hundred times a day: copy, paste.

- **History.** Everything you copy is kept locally, encrypted, searchable,
  one hotkey away. Password managers and concealed pasteboard content are
  excluded by default.
- **Smart paste.** When you paste into a field, the app reads where you are
  (through macOS Accessibility) and suggests a history item separately from
  the stable recent list. Select an item and confirm with Enter. Dedicated
  media shortcuts use the guarded automatic-delivery flow described below.
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
  on. Advanced thinking parameters remain available in provider configuration;
  the native settings UI does not yet expose all of them.

Everything here is open source under the MIT License: the app, Core,
the template and pack formats and the proxy. Peesuto runs on your machine
with the keys you bring (or none: rules and the heuristic need no model); no
feature is held back from the open build. A hosted service may come later
for people who would rather not set up keys; it is not live today.

## Desktop architecture

The desktop uses **SwiftUI + AppKit, retaining TypeScript/Bun Core and the
independent Pocket Motion engine**. The former Tauri desktop, UI WebView and
its build dependencies have been removed; Electron is not part of the design. Bun remains a
local business/render runtime, not a UI runtime. Image, GIF and video generation
are core product capabilities. PNG/GIF and MP4 actions are implemented; MP4
requires locally installed ffmpeg, which is not bundled or installed automatically.

**The native app is the only desktop implementation. Feature and release work remains.**
[`native/`](native/README.md) builds a standalone SwiftUI + AppKit `.app`, with
encrypted history, bundled Core, PNG/GIF/MP4 actions and bilingual settings.
The native app can transform the current clipboard directly with configurable
`⌘⌥1` (image), `⌘⌥2` (GIF) and `⌘⌥3` (video). Change or disable bindings in
Settings → Shortcuts. It pastes automatically only when the original insertion
point can still be verified; newer clipboard contents are preserved.
The native app preserves history formats, credentials, Core actions/providers and
English/Simplified Chinese support. Account/pack-management UI, action editing,
auto-update and signed distribution are still incomplete; removing the old app
does not claim these features have been ported. See
[PLAN.md](PLAN.md) and the [native migration plan](docs/native-migration.md)
for the scope, task protocol work and actual `.app` acceptance requirements.

## Content-preserving media templates

Copy text and generate an image, GIF or MP4 through Pocket Motion. The current
registry provides **8 template families with 2 variants each**: document,
quote, code, statistic, list, conversation, table and comparison. Four further
families remain planned; they are not implemented by this registry.

Content is parsed locally from the original text and explicit source syntax.
Jev may choose only from constrained, compatible template/style/motion options;
it does not rewrite the source or invent numbers, speakers or table entries.
Without a usable decision provider, local rules select a valid fallback.
The native result view supports changing style and output format while keeping
the original input. See [templates and their limits](docs/templates.md).

The CLI's explicit DSL fixtures remain supported and continue to exercise the
legacy card renderer; their unchanged digests do not by themselves validate
every new template family.

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
  src/templates/   local parsing, constrained selection, registry and template rendering
  fixtures/        five DSL fixtures and the digests they render to
native/      SwiftUI + AppKit desktop, system/storage/Core modules and tests
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

## Build the native app

On macOS, after preparing the pinned engine. The app requires macOS 13 or
later and is built for Apple Silicon (arm64) only; building needs Xcode 16.4
or newer.

```bash
swift test --package-path native
bun scripts/fetch-emoji.ts       # once: include the emoji set for offline use
bun scripts/build-native.ts --engine /absolute/path/to/prepared-pocket-motion
open native/dist/Peesuto.app
```

`native/dist/Peesuto.app` contains the Swift application, Bun Core and Pocket
Motion resources. `--preview` builds `native/dist/Peesuto Preview.app` with
isolated sample history and no clipboard monitoring. The build currently uses
local ad-hoc signing; Developer ID, notarization and automatic updates are not
implemented. See [native/README.md](native/README.md) for build/smoke commands
and [release status](docs/RELEASING.md) for distribution limits.

Accessibility permission is needed for automatic paste and focused-field
context. Copy and history remain usable without it.

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
swift test --package-path native  # macOS native modules
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
| decider `typesafe` / `vercel` / `openrouter` | the same | Jev at TypeSafe, Vercel AI Gateway or OpenRouter, with your own key |
| decider `endpoint` | the same | the URL you set (your own proxy, or ours) |
| generator `openai-compatible` / `anthropic` | the filled prompt | the base URL you set |
| generator `openrouter` / `vercel` | the filled prompt | the gateway's OpenAI-compatible API, with the same key as its Jev |
| generator `hosted` | the filled prompt | our proxy, which does not store it (not live yet) |

The offline switch in Settings closes the single egress path for everything
above. Emoji pictures are fetched by codepoint from a CDN once and cached;
that reveals which emoji, not the text. History is stored encrypted with a
key in your Keychain. See `SECURITY.md`.

## Status

The old desktop is removed. Remaining v1 features and release acceptance are tracked in `PLAN.md`.

## License

[MIT](LICENSE); third-party components are listed in
[NOTICE](NOTICE). "Peesuto" and its logo are trademarks and are not covered
by the license; see [Trademarks](CONTRIBUTING.md#trademarks).
