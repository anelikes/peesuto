# Native desktop first-build acceptance — 2026-09-22

Scope: the first SwiftUI + AppKit desktop in `native/`, retaining Bun Core and
Pocket Motion. This is an implementation baseline, not completion of N1–N5.
Tests used synthetic data and test keys; production clipboard history and
Keychain were not used for acceptance, and no Accessibility permission was granted.

## Environment and artifacts

- Local Apple silicon macOS; Xcode 26.5, Swift 6.3.2, Bun 1.3.11.
- Engine: `engine.json` pin `ad6b8a600cbbd576dd46112075605dfdaf23d063`
  (`v0.2.1`), freshly prepared in `.work/native-engine`.
- `native/dist/Peesuto.app`: normal profile, app identifier `com.peesuto.desktop`.
- `native/dist/Peesuto Preview.app`: isolated preview profile,
  `com.peesuto.desktop.preview`; synthetic history under a temporary directory.
- Release Swift build and ad-hoc signature verification passed for both bundles.
  `vtool` confirms the native executable declares macOS 12.0. Runtime testing on
  macOS 12 itself remains outstanding. Developer ID/notarization is not provided.
- Normal bundle occupies approximately 160 MB according to local `du -sh`.
  This is disk usage, not a memory measurement or promised final package size.

## Automated checks

| Check | Result |
|---|---|
| `swift test --package-path native` | 26 passed: 9 Core client, 11 storage/settings, 6 system integration |
| Core client subprocess fixtures | Ready/config barriers, concurrent response matching, crashes, deadlines, cancellation, full-pipe backpressure and actual render-worker process-group cleanup |
| Storage/settings fixtures | Legacy schema + independent AES-GCM vector, wrong-key lock, encrypted image lifecycle, file history, dedup/pins/retention, unknown settings fields, canonical credential references |
| System integration fixtures | Privacy filters, UTF-16 context bounds, accelerator parsing, TIFF-to-PNG compatibility and multiple file pasteboard items; no real pasteboard writes |
| `POCKET_ENGINE=<prepared pin> bun test core/tests/fixtures.test.ts` | 5 passed, existing frame digests unchanged |
| `bun run typecheck` | Passed |
| `codesign --verify --deep --strict native/dist/Peesuto.app` | Passed (local ad-hoc signing only) |

The native Swift test job was added to CI. A remote CI result is not implied
by local success.

## Standalone bundle smoke

The release smoke executable was run from `/tmp`, with only `/usr/bin:/bin`
on PATH, against the normal bundle (and the preview bundle in an earlier run):

```sh
env PATH=/usr/bin:/bin /absolute/repo/native/.build/release/PeesutoSmoke \
  /absolute/repo/native/dist/Peesuto.app
```

It used a new temporary directory and fixed test key, configured rules + no
generator + offline mode, verified encrypted history and Core health/actions,
and generated PNG and GIF. The final smoke check decodes the generated image
and checks that the GIF contains multiple frames. No system Bun or repository
working directory was needed. Result files were retained in the temporary
smoke directory for inspection. This does not measure model-provider quality.

## Native UI checks

Performed against the actual preview `.app` through native accessibility and
screenshots, with no browser/HTML preview:

- Native history opens, arrow-down changes selection, text search filters the
  list, Escape clears search while preserving a usable selection.
- Action menu shows the four transformation actions; recommendation is separate
  from the stable history order.
- PNG renders through the bundled engine and appears inside the detail pane.
  An initial NSImageView intrinsic-size overflow was fixed and visually rechecked.
- Chinese sample text renders through the GIF action and appears in the native
  image view; the automated smoke independently verifies multi-frame output.
- Back returns to the selected history item.
- Settings opens in a separate native window. English and Simplified Chinese
  update settings and the underlying history/result panel. An unsaved shortcut
  edit survives language switching. User sample text remains unchanged.
- General and AI settings layouts were inspected. No new credentials or external
  model requests were used in this UI session.

## Remaining acceptance

Real clipboard capture, target-app paste, existing user Keychain authorization,
real-data migration, multiple monitors, fullscreen and IME combinations need
further acceptance. The synthetic format tests are not a claim of completed
production migration. At the first-build baseline there was no native
account/pack-management UI, video action, native updater, signed release pipeline
or task lifecycle protocol. Video and lifecycle status were added in the follow-up below.
The existing Core request loop remains sequential. Old `app/` is retained.

## Media shortcut follow-up — 2026-09-22

The next local iteration adds configurable image/GIF/video shortcuts, a native
key recorder with conflict handling, an inactive task status panel, conservative
direct-paste target snapshots and clipboard-generation protection. MP4 now uses
Pocket Motion with locally discovered ffmpeg, with AVPlayerView native playback.
Task lifecycle events are opt-in and the idle deadline pauses during active work.

- `swift test --package-path native`: 34 passed (13 Core client, 11 storage,
  10 system integration). Additional checks cover event/response ordering,
  legacy response compatibility, event deadline behavior, shortcut routing,
  registration rollback/swaps and direct-paste rejection policy.
- A separate temporary native host also verified actual Carbon registration:
  two simultaneous hotkeys, externally occupied-key rejection, original group
  preservation on failure, key swapping and complete cleanup. It sent no key events.
- `bun run typecheck`: passed. `bun test core/tests`: 298 passed, 1 skipped
  (the separately opt-in video integration). The video integration was also
  run with the pinned engine and validated H.264/yuv420p/multiple frames via ffprobe.
- Complete normal bundle smoke ran from `/tmp` with `PATH=/usr/bin:/bin` and
  `--video`. PNG 18,435 bytes / 1,904 ms; GIF 51,841 bytes / 786 ms;
  MP4 45,897 bytes / 925 ms. Each returned accepted/running/completed events.
  AVFoundation reported playable MP4 with a video track and positive duration.
  These are single synthetic runs, not performance guarantees.
- Actual preview UI: shortcut page/defaults, key recording, duplicate rejection,
  valid save and closing settings during recording verified. Video action appears
  in the menu, renders a result and plays inside the native detail pane.
- No production history, Keychain reads or new Accessibility grants were used.
  Preview does not register global hotkeys or run clipboard-direct actions;
  real global-key delivery and automatic paste into external applications remain
  outside this UI acceptance. Synthetic tests validate the conservative policy,
  not target-app media support. Account/packs, finer progress/concurrency,
  native updating and signed distribution remain outstanding.
