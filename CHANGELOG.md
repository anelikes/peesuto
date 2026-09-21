# Changelog

Notable changes to pocket-paste, newest first, in the shape of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
semver once there is a release to follow; `docs/RELEASING.md` says how a
section here becomes one.

## Unreleased

The foundation — M0 of `PLAN.md`, which was M1 to M3 of the plan's first
edition: the render chain as a package, the engine as a pinned dependency,
the sidecar proven to run outside the repository, and the decision layer
with its providers. No app yet beyond the Tauri 2 scaffold.

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
- Tauri 2 scaffold in `app/`.
- `PLAN.md`: the v1 implementation plan, second edition: a smart clipboard
  first, cards as one action, two-track self-hostable providers.

### Fixed

- An `animate=yes` answer with tone 0 rendered a single frame. Jev answers
  the two questions independently, so the pair is reachable and now moves.
