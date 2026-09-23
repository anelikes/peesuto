# Contributing

Peesuto is a macOS clipboard and AI-action app whose image, GIF and video
rendering capabilities are central to the product. The desktop is SwiftUI +
AppKit (`native/`), retaining TypeScript/Bun Core and the independent Pocket
Motion engine. The old desktop source and build workflow have been removed.
See [native development](native/README.md) and the remaining
[migration requirements](docs/native-migration.md).

Bug fixes and small improvements: open a pull request.
Anything that changes what a card looks like, what leaves the machine, or the
shape of a provider or an action: open an issue first, so the direction is
agreed before the work is done.

## Setup

- macOS with Swift 5.9 or newer for the native desktop.
- Bun 1.3.x (CI pins 1.3.11).
- Rust stable with the `wasm32-unknown-unknown` target; the engine's
  rasteriser is built to wasm: `rustup target add wasm32-unknown-unknown`.
- The engine, Pocket Motion, is a separate checkout pinned in `engine.json`.

```bash
bun install
bun run setup             # clone the engine at the pinned commit into engine/ and prepare it
bun run setup --status    # where the engine is, whether it matches the pin, what is missing
```

Already have a pocket-motion checkout? Point `POCKET_ENGINE` at it, or keep
it as a sibling `../pocketjs-motion`. `bun run setup` then only reports;
`bun run setup --fix` runs the missing steps inside it. The pinned
`anelikes/pocket-motion` repository is public; cloning it needs no credentials.

For the app, run `bun scripts/build-native.ts --engine <prepared-engine-root>`.
This stages Bun/Core/engine resources in `native/.bundle`, builds Swift release
executables and assembles `native/dist/Peesuto.app`. Launch that exact bundle;
`swift build` alone does not package Core or the engine. Use `--preview` for
isolated sample data and no clipboard monitoring. Do not use `--skip-resources`
after changing Core or resources. Formal distribution remains disabled; see
[RELEASING.md](docs/RELEASING.md).

## Native migration boundaries

- Keep Core, CLI, action/pack formats, provider adapters and Pocket Motion.
  Do not translate business logic into Swift as part of the desktop rewrite.
- Keep encrypted storage and Keychain compatible with prior installations.
  Existing user data and credentials must never be reset on migration failure.
- The native app is the only desktop implementation. Retired source remains in
  Git history; do not restore legacy build entry points. Account/packs UI,
  signed distribution and complete real-device acceptance are still open.
- Preserve the engine pin and frame digests unless an engine/render change
  explicitly requires otherwise. Rust remains an engine build dependency
  even after the Rust desktop layer is removed.
- Protocol extensions must distinguish progress from final responses and
  preserve the transition client contract. Rendering must not block light
  requests, but builds sharing generated engine files must stay serialized
  or use isolated resources.

## Tests

```bash
bun test core/tests       # unit tests; the fixture renders skip without an engine
bun run typecheck
swift test --package-path native
```

`core/tests/fixtures.test.ts` renders the five fixtures and compares them to
recorded digests; it needs a complete engine checkout and skips itself
otherwise. Run it before sending anything that touches `core/src/render/`,
`core/src/dsl.ts`, `core/src/catalog.ts` or `engine.json`.

## Digests

`core/fixtures/digests.json` holds the SHA-256 of the frames each fixture
renders to at the pinned engine: frame 0 for all five, plus one
mid-animation frame for the animated ones. A change in that file is one of
two things, a deliberate re-recording or a regression, and a PR has to say
which. Never update a hash just to make the test pass.

To re-record: with the engine at the pin, run
`bun test core/tests/fixtures.test.ts`. A failing frame prints the hash it
got and leaves the PNG at `.work/test-out/<fixture>-<frame>.png`. Compare it
with the previous card (on `main`,
`bun run paste --dsl core/fixtures/<fixture>.json --out out/<fixture>.png`
gives you frame 0). If the difference is what your change intends, put the
new hash into `digests.json` (`shasum -a 256 .work/test-out/<fixture>-<frame>.png`)
and describe the visual change in the PR. Moving `engine.json` re-records
every digest the same way, in the same commit.

## The engine rule

pocket-paste never writes into the engine checkout. Renders happen in a
symlink work tree under `.work/` (see `core/src/engine.ts`), and the packaged
app copies its engine subset into Application Support before building there.
If the engine needs to behave differently, change it in the pocket-motion
repository, get that merged, then move the `sha` in `engine.json` and
re-record the digests. Edits under `engine/` are never part of a PR here.

## Names and numbers

`core/src/catalog.ts` is the only place a name Jev may choose (a kind, a
layout, a palette) is bound to the numbers behind it. Questions are generated
from the catalog and the composer only looks names up in it, so the two
cannot drift. A new palette is one entry there: not a constant in
`compose.ts`, not a string in `questions.ts`. A style pack is a fragment of
the same shape merged in at runtime.

## Commits and pull requests

Commit messages read `type(scope): summary`: imperative, lowercase, no
trailing period, in the style of the existing log —
`feat(paste): emoji as inline pictures from Noto Emoji at a pinned tag`,
`fix(run): an animate=yes answer with tone 0 still moves`,
`docs(plan): second edition`. Types: `feat`, `fix`, `docs`, `test`, `chore`,
`refactor`; the scope is optional. The body says why, not what the diff
already shows. Squash work-in-progress before opening the PR; the PR
template's checklist is what reviewers go through.

Code: TypeScript strict, `.ts` extensions on imports, no new dependency
without a sentence in the PR on why the standard library is not enough.

## One engine build at a time

Every engine build rewrites one file inside the engine checkout
(`vendor/pocketjs/framework/src/styles.generated.ts`, reached through the
work tree's symlink) and the host reads it when it boots a bundle. Two
work trees building against the same checkout at the same time race on it,
and the loser fails its frame with "unknown class … not in the compiled
style table". Run `bun test`, `scripts/corpus.ts` and the app one at a time
against one engine, or point them at separate checkouts with
`POCKET_ENGINE`. The current daemon serialises its own requests. The native
migration must preserve build exclusion even when request handling becomes concurrent;
separate output directories alone do not isolate shared generated files.
