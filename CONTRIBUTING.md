# Contributing

pocket-paste is a macOS menu-bar app (Tauri 2, `app/`) around an open-source
render chain (`core/`) that turns clipboard text into a card through Jev and
Pocket Motion. Bug fixes and small improvements: open a pull request.
Anything that changes what a card looks like, what leaves the machine, or the
shape of a provider or an action: open an issue first, so the direction is
agreed before the work is done.

## Setup

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
`bun run setup --fix` runs the missing steps inside it. Until the engine's
branch stack lands in the public pocket-motion, the pinned repository is
private: ask for read access if the clone is refused.

For the app: `bun scripts/bundle-sidecar.ts --out app/src-tauri` assembles
the sidecar the app ships (a Bun binary plus the engine subset), then
`cd app && bun install && bun run tauri dev`.

## Tests

```bash
bun test core/tests       # unit tests; the fixture renders skip without an engine
bun run typecheck
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
