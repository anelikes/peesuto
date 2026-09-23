## What

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `bun test core/tests` and `bun run typecheck` pass.
- [ ] `core/fixtures/digests.json` is unchanged, or this PR re-records it on purpose and says what changed visually and why (see CONTRIBUTING.md).
- [ ] Nothing writes into the engine checkout. Engine changes went to the pocket-motion repository, and `engine.json` moved only if they landed there.
- [ ] Any new name Jev may choose (kind, layout, palette) lives in `core/src/catalog.ts` with its numbers, nowhere else.
- [ ] Nothing new leaves the machine, or SECURITY.md says what and where to.
- [ ] Commit messages read `type(scope): summary`, and every commit is signed off (`git commit -s`, see CONTRIBUTING.md).
