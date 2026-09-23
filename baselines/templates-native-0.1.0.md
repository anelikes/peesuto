# Native structured-template acceptance — 2026-09-22

Local Apple Silicon development build, Bun 1.3.11, Swift 6.3.2. Pocket Motion
remains pinned by `engine.json` at `ad6b8a600cbbd576dd46112075605dfdaf23d063`.
This records local verification; it is not a signed release or a remote CI result.

## Delivered

- Eight templates, two variants each: document, quote, code, stat, list, chat,
  table and comparison. Shared PNG/GIF/MP4 presentation pipeline.
- Source-backed parsing, constrained decision-provider choices, deterministic
  fallback, explicit overrides and saved per-template style preference.
- Native result menus for compatible templates, variants, motion and output.
  Rerenders retain the original source and do not automatically paste.
- Complete removal of the legacy desktop source, dependencies and build outputs
  under `app/`. Native Swift desktop is the only app build entry.

## Verification

- `bun test core/tests`: 358 pass, 4 skip, 0 fail. The five legacy engine fixture
  digests pass. Three optional template engine tests and the optional legacy MP4
  integration test are excluded from that default invocation.
- `bun run typecheck`: pass.
- `swift test --package-path native`: 35 pass, 0 fail.
- Real template engine suite, enabled separately against a disposable prepared
  engine copy: 3 pass, 58 assertions. All 16 PNG variants render. Typewriter
  first/middle/final frames differ; the ending hold matches the final frame;
  complete static PNG exactly matches the animation's final frame. GIF and a
  Markdown document with headings, bold, a list and code also render.
- Visually inspected actual quote, chat, table and Markdown document output;
  no visible overlap, missing glyphs or clipping in those samples.
- Full native resource/app build and local ad-hoc signature verification pass.
  Standalone `PeesutoSmoke <bundle> --video` runs from `/tmp` with
  `PATH=/usr/bin:/bin`, using isolated synthetic storage, validating catalog,
  encrypted history, structured chat metadata, PNG decoding, multiframe GIF
  and AVFoundation-readable MP4. Locally installed ffmpeg supplies video encoding.
- Native preview UI: dialogue automatically selects chat; changing bubbles to
  transcript works; PNG → GIF → typewriter → MP4 works; native video playback
  advances. Quoted text selects quote. A subsequent chat action remembers the
  transcript variant. Production history, credentials and AX grants untouched.
- Both workflow YAML files parse, and `git diff --check` passes. Render CI now
  includes opt-in template engine acceptance; remote CI was not run locally.

Generated samples are reproducible through `core/tests/template-engine.test.ts`
and stored locally under `.work/template-samples/` (not committed binary assets).

## Limits

Recognition is conservative and may retain document text for ambiguous input.
The new structured Jev contract was tested with fixtures, not a paid live provider.
GIF raw-frame retention is bounded at 128 MiB; font, engine and palette memory
are additional. Oversized content is rejected rather than silently truncated.
Flowcharts, timelines, event cards and poetry layouts remain planned.
Formal signing, notarization, updater and distributable release remain open.
