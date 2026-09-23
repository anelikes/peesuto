# Changelog

Notable changes to pocket-paste, newest first, in the shape of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
semver once there is a release to follow; `docs/RELEASING.md` says how a
section here becomes one.

## Unreleased

- License: Apache 2.0 (was MIT), with a NOTICE listing bundled third-party components. Contributions are signed off under the DCO; the Peesuto name and logo are trademarks the license does not grant (CONTRIBUTING.md).
- Code cards: line numbers from 1 in both styles; larger macOS window dots; the terminal style sits on a layered gradient (indigo to teal, a rose tint below) with a drop shadow on the window. Template shapes can carry the engine's two-stop gradients and shadows.
- Code cards use a monospace font (Peesuto Code: Maple Mono NL CN v7.9 subset, SIL OFL; no ligatures) with CJK at two columns, and real syntax highlighting (highlight.js 11.12, 24 languages, fence language or auto-detect); text is verified unchanged, with fallbacks to the proportional font and the simple colouring.
- Pin to screen (⌘⌥5): the copied image, or a card rendered from copied text, floats above every window; drag to move, scroll or pinch to zoom around the cursor, double-click to close; right-click to copy, save or close all. GIFs animate. Also a button on image and GIF results.

## 0.1.1 — 2026-09-23

First signed and notarized native release (Apple silicon, macOS 13+).

- Media shortcuts always paste into the frontmost app (no more "copied, press ⌘V" after a focus check); only missing Accessibility, secure input or Peesuto in front fall back to copy, with the reason and a button to grant access.
- Prepare on copy moved next to the paste shortcuts; new installs pre-render images by default, with local rules only.
- First-run welcome guide (what Peesuto does, shortcuts, permissions and privacy including the Keychain prompt, preferences, a try-it step), reopenable from Settings › General › About.
- Box-drawing tables (Unicode, rounded, ASCII, psql) copied from terminals become tables; wrapped cells are joined. Mixed Latin and Chinese lines break between Chinese words instead of stranding a word before a space.
- Template redesign (with Claude Design): one neutral paper and night plus a signature colour per template; every template reads a style table; short content grows a type step and is centred in fixed frames; code gets light syntax colouring; added labels (NOTES, 01, CODE, line numbers) are gone; quote marks and author dashes are shapes, not glyphs. Diagram ports spread over a node side and edge labels avoid nodes, lines and each other.
- QR code: `paste-qr` (⌘⌥4) encodes the copied text exactly as a QR code, in two styles, with a caption for one short line; never chosen automatically and never sent to a model; too-long text is an explicit error.
- Fix: the app bundle now ships core's own packages (gifenc, qrcode-generator) and Core runs with `--no-install`. Installed outside the repository, GIF rendering failed offline and Bun would otherwise have fetched the package from npm at runtime, outside the egress layer. The bundler proves offline resolution from a copy outside the repository.
- Precompose (off by default): each copied text is rendered in the background as an image, GIF and/or video, so the paste shortcut returns it at once; local rules decide unless the model is allowed; texts with secrets, long texts, Low Power Mode and busy moments are skipped; a new copy cancels older work, an explicit action preempts it.
- What an AI model sees is now controlled: raw, sensitive details redacted (default) or structure only. Built-in rules catch API keys, private keys, JWTs, bearer tokens, credentials in URLs, secret assignments and random-looking tokens; email, phone, ID card and bank card rules exist but are off. Custom rules (text, keywords or regex) replace matches with the user's text, optionally in the rendered output too. The model still only picks presentation; content is rendered locally. Settings, Privacy & Precompose; Studio shows what the model receives.
- Frames: images fit their content by default (width by content, height hugging it above a per-template minimum); GIF and video keep a strict fixed frame (1:1 by default, also 4:5, 16:9, 9:16) and scroll tall content. The native app has an image, GIF and video frame setting and a per-result frame menu; `meta.template.aspect` reports the frame used.
- Studio (`bun run studio`): a local page that decides and renders clipboard scenarios or any pasted text in every template, style, motion and format, with a cache keyed by the template code so edited style tokens re-render on reload; links per scenario (`#<id>`); the static gallery reuses it.
- Diagram template: Mermaid flowcharts (fenced or bare) and plain arrow chains become a layered node diagram in two styles (Flow, Blueprint), with decision diamonds, edge labels, dotted and thick links, cycles, and a rank-by-rank reveal.
- Mixed Chinese and Latin lines no longer break at a far-back space ("第 1" alone on a line); `scripts/gallery.ts` renders a preview page of realistic scenarios in every template, style, motion and format.
- Tall GIF/MP4 content scrolls through a fixed canvas (still start, eased scroll at reading speed, still end) instead of growing or failing; PNG still grows.
- Messages copied out of chat apps (speaker, timestamp, message) render as a conversation, with the time kept as small text.
- Invisible characters chat apps insert (U+2005 after a WeChat @mention, zero-width spaces) no longer make a card fail with "could not fit"; layout errors now say which character the font cannot draw, or that there is nothing to render.
- Text template, the default for short plain prose: typography alone in three styles (Paper, Ink, Poster), size by length, balanced and vertically centered lines, and an optional accent on one source word chosen by the model. Styles are a token table for redesign.
- All templates: lines break at word boundaries in Chinese and Japanese too, and closing punctuation no longer starts a line.
- Native app: saving settings during a render no longer restarts Core (the config waits for the task); action timeouts are 300 s for image/GIF and 720 s for video; Core's death fails pending requests at once and its process group is always killed; the last Core stderr lines show in errors and in Settings → Core diagnostics.
- Native app: a locked history keeps capturing in memory and offers "Start fresh"; Clear history; Open at login; decider errors show as a note on the result; the app no longer records its own pasteboard writes.
- GIF and video actions can no longer come out as a single still frame: "none" is not offered as motion when an action needs motion, an override of it falls back to "reveal", and a one-frame GIF/MP4 is an error.
- Over-long text is refused before any model call or layout; wrapping is linear.
- Renders have a deadline (240 s image/GIF, 600 s MP4, `PASTE_RENDER_TIMEOUT_MS`); a hung engine or ffmpeg process group is killed.
- Generated files in the cards directory are pruned after each render (older than 24 h or beyond the newest 30).
- A failed decider still renders with the fallback, and the error now comes back as `decisionError` in the action result.
- A failed render never deletes a caller's existing file; the daemon answers an unknown `cmd` with a usage error carrying the request id.
- Minimum macOS is now 13.0 (the bundled Bun requires it); builds are arm64 only. CI's macOS jobs moved to `macos-15` with Xcode 16.4 selected explicitly.

- Removed the legacy desktop source, UI build dependencies and tag-triggered release workflow. `native/` is now the only desktop entry point; CI builds/tests the native app and bundled Core. Manual workflow artifacts are validation builds only; native signing, notarization, updating and missing management UI remain unfinished.

- Native media shortcuts: configurable `⌘⌥1` image, `⌘⌥2` GIF and `⌘⌥3` video operate on copied text without opening history. Includes a key recorder, conflict rollback, task status window and conservative automatic paste with focus/clipboard guards. Added the `paste-video` MP4 action (requires locally installed ffmpeg), native video playback, unique result files and opt-in Core lifecycle events; active tasks no longer trigger the daemon idle timeout.

- First SwiftUI + AppKit desktop implementation in `native/`, retaining Bun Core and Pocket Motion without a UI WebView. Includes native history/results/settings, English and Simplified Chinese, compatible encrypted storage/Keychain, system integration, a process-safe Core client and actual `.app` build/smoke commands. Full desktop migration and release cutover remain incomplete.

- Recorded the native architecture decision: SwiftUI + AppKit replaces the retired desktop while retaining Bun Core and Pocket Motion. Image/GIF/video generation is a core product capability. The migration plan includes data compatibility, task lifecycle, a simpler bilingual GUI and actual `.app` acceptance; the first native implementation is now available; complete migration remains unfinished.

- English and Simplified Chinese UI, with a language selector in Settings → General (system default). User content and custom action names stay unchanged.

- The app is called Peesuto. The identifier is com.peesuto.desktop; the repository and internal paths keep the name pocket-paste.
- Cloudflare decider: posts to Workers AI's `/ai/run` with `{model, input}`
  and unwraps the run record `{state, result: {answers}}`; the old per-model
  path answered "No route for that URI". First verified against the real
  endpoint on 2026-09-22.
- Proxy: the worker entry exports only the handler; `wrangler dev` refused
  to start while string constants were exported from it.
- Smart paste: context-levelled pick question, heuristic fallback, hit-rate probe.
- Two-track providers (decider: cloudflare, endpoint, none; generator: openai-compatible, anthropic, hosted, none) behind one egress layer with an offline switch and a destination-only log.
- Actions: JSON format, five built-ins, user files and packs, `paste --action`.
- Core daemon over JSON lines for the desktop app.
- Proxy worker: hosted mode with subscriber tokens, quota, rate limit, generate, me, packs.
- Release status docs and a manual native validation build; privacy audit checklist.
- Card corpus of 100 samples; composer truncation, wrapping, script refusal, emphasis by the decider's word list.
- Style packs: catalog fragments merged into the Core catalog at load. Installing packs and the account/subscription UI are not in the native app yet.
- Privacy baseline 0.1.0: five automated checks pass; manual list recorded.
- Generator: thinking models on Ollama (qwen3.5, gemma4) answered with empty content and the action reported success; the openai-compatible generator now detects it, retries with `reasoning_effort: "none"`, learns, and exposes `reasoning` and `timeoutMs` (settings, providers.json, env). An action whose generator returns nothing is an error.
- Engine: pinned to the public anelikes/pocket-motion v0.2.1 (the private branch stack replayed, plus paths through fileURLToPath); CI clones it without a credential, Rust pinned to 1.97.1 for the wasm build.
- Decider `rules`, now the default: card kinds by the rule classifier (moved from the corpus script into core, 91% on the corpus), geometry by the length heuristics, picks by the heuristic; nothing configured, nothing leaves. Decider `laya`: a local Laya model behind `scripts/laya/server.py`, blended into the pick at a low weight; `docs/laya.md`.

The foundation — M0 of `PLAN.md`, which was M1 to M3 of the plan's first
edition: the render chain as a package, the engine as a pinned dependency,
the sidecar proven to run outside the repository, and the decision layer
with its providers. No desktop app yet.

### Added

- `paste`: clipboard text to a card, a PNG, or a GIF when the text has an
  order worth revealing. Jev (TypeSafe AI, reached through Cloudflare Workers
  AI) answers seven typed questions about the text: kind, layout, palette,
  scale, tone, which word to emphasise, whether to animate. Every answer is a
  choice from a fixed set; Pocket Motion renders the composition with
  measured line breaks and sizes, never guessed.
- Aspects `chat`, `doc` and `social`; `--stdin`; `--dsl` to render a DSL
  as-is and skip Jev; `--out`; `--json` (path, DSL and timings on one line)
  for a host program; `--app-data` and `--engine-resources` for the packaged
  app.
- `core/`, the chain as a package: `dsl.ts` (validation), `catalog.ts`
  (every name Jev may choose with the numbers behind it; style packs are
  fragments of the same shape merged at runtime), `questions.ts` (the seven
  questions, answers to DSL), `render/` (composition generation, engine
  driver, emoji, GIF), `cli.ts`.
- Providers behind one interface: `none` (the plain card, no request),
  `proxy` (the `wrangler dev` worker in `proxy/`, the CLI default),
  `cloudflare` (Workers AI REST on your own account), `hosted` (our proxy,
  token-gated). Errors classified as auth, network, timeout, model,
  bad-response or quota, with readable messages.
- Answers cached by the SHA-256 of the text and the question set, so the same
  text gives the same card; `--fresh` asks again.
- `engine.json` pins Pocket Motion by repo, ref and sha. `bun run setup`
  (`scripts/engine.ts`) clones it at the pin and runs its setup steps, or
  verifies a checkout given by `POCKET_ENGINE` (`--status`, `--fix`).
- Renders happen in a symlink work tree under `.work/`; the engine checkout
  is never written to.
- GIF encoded in process with `gifenc` from the engine's frame source; no
  ffmpeg, about half the bytes of the ffmpeg pass.
- Text measured against a cached metrics-only bake of
  `core/src/render/charset.txt` (ASCII, CJK punctuation, GB2312 level 1), so
  a paste costs one composition build; warm text-to-card about 1.2 s
  including Jev. A character outside the charset falls back to a per-paste
  measurement build.
- Emoji as inline pictures: split out of the text (pictographs, keycaps,
  VS16, skin tones, ZWJ joins), fetched once as 128 px PNGs from Noto Emoji
  v2.047 through jsDelivr, drawn at the font size and measured as one advance
  when wrapping.
- `scripts/bundle-sidecar.ts`: the sidecar the app ships, a Bun binary plus
  a 73 MB resource tree (engine subset, `core/`) that renders from a clean
  environment with no repository and no `bun` on PATH; cold start about
  3.2 s, warm about 0.8 s.
- `scripts/fetch-emoji.ts`: measures the full Noto Emoji 128 px set for the
  ship-the-set-or-a-subset decision.
- Five DSL fixtures (`plain`, `quote`, `code`, `stat`, `list`) with the
  SHA-256 of the frames they render to at the pinned engine
  (`core/fixtures/digests.json`); 96 unit tests; CI runs the unit tests on
  Ubuntu and the fixture renders at the pinned engine on macOS.
- `PLAN.md`: the v1 implementation plan, second edition: a smart clipboard
  first, cards as one action, two-track self-hostable providers.

### Fixed

- An `animate=yes` answer with tone 0 rendered a single frame. Jev answers
  the two questions independently, so the pair is reachable and now moves.
