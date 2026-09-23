# Privacy baseline — 0.1.0 (historical desktop)

The source/build commands recorded below belong to the retired desktop and are
not runnable from the current checkout. They remain evidence of that build, not
proof of native acceptance. Use `native/README.md` for current commands and
`baselines/native-0.1.0.md` for native verification.

Date: 2026-09-22. Build: the **bundled debug** app (`bun run build:bundled --debug --bundles app`)
at commit `e2d66f3` plus the uncommitted round-3 shell changes in `app/`; Core and the
engine from the sidecar bundle (`resources/VERSION`: `ca3c07632017 e2d66f3f0f13 bun1.3.11`),
with the two path fixes noted at the end applied to the generated copies. Machine: macOS
(Darwin 25.5), Apple Silicon. Automated by `scripts/pasteboard-probe.swift` and an
unattended launch of the app (`POCKET_PASTE_AUTORUN`, `POCKET_PASTE_HISTORY_KEY`; debug
builds only), reading the results from `history.sqlite`, `images/`, `egress.log` and
`app.log` under `~/Library/Application Support/dev.pocketpaste.desktop/`.

Method note: the checks ran while the user session was at the lock screen, so the
"frontmost app" macOS reported for every pasteboard write was `com.apple.loginwindow`;
the blacklist check (2) therefore blacklists that id. The mechanism is the same for any
bundle id, but the four shipped defaults were not exercised with their real apps.

## Results (docs/privacy-audit.md §2–§4)

| # | check | expected | observed | result |
|---|---|---|---|---|
| 1 | plain pasteboard text | recorded | 1 row (55 B, `text`) | pass |
| 1 | `org.nspasteboard.ConcealedType` | not recorded | rows unchanged (1) | pass |
| 1 | `org.nspasteboard.TransientType` | not recorded | rows unchanged (1) | pass |
| 2 | blacklisted app (`com.apple.loginwindow` added to Settings → Exclusions) | plain copy skipped | rows unchanged (1); blacklist restored afterwards | pass |
| 3 | raw scan of `history.sqlite*` for the copied marker | 0 hits | 0 hits (`grep -a`, WAL included) | pass |
| 3 | image item (a PNG on the pasteboard) | encrypted files, no PNG chunks readable | `images/` holds 2 files (original + thumbnail), 0 `IHDR` hits | pass |
| 4 | Offline on, decider = proxy at `http://127.0.0.1:9` | pick falls back to heuristic, `egress.log` gains no line | `pick: heuristic` (4 ms), 0 lines | pass |
| 4 | Offline off, same decider | one egress line, no text in it | 1 line: `{"host":"127.0.0.1:9","purpose":"decider:proxy","bytesOut":639,"bytesIn":0,"status":0,"local":true,"error":"network"}`; marker not in the log | pass |
| 5 | delete an item (the image) | row and both files gone | rows 2→1, image files 2→0 | pass |
| 5 | clear all | empty table, empty `images/` | rows 0, files 0 | pass |

Also covered by `cargo test` in `app/src-tauri` (`store::tests`): round trip without
plaintext on disk, tamper detection, search/pin order, retention purge keeps pinned
items, image files go with the item, the locked state when the key is missing.

## Manual, not yet done

- [ ] Copy a password from 1Password (`com.1password.1password`), Bitwarden
      (`com.bitwarden.desktop`) and Keychain Access (`com.apple.keychainaccess`) with the
      apps really frontmost; nothing lands in history (the defaults were only exercised
      through the mechanism, see the method note).
- [ ] Safari password autofill (concealed type from a real app).
- [ ] Copy inside an `AXSecureTextField`; confirm the panel opens as plain history with the
      "Secure field" note and `app.log` shows no `pick:` line (needs Accessibility granted
      to the app and a human at the keyboard).
- [ ] The Accessibility prompt flow: deny → history usable, paste simulation and smart
      paste off with the banner; allow → both work. Not automatable (TCC dialog).
- [ ] Remove the Keychain item `pocket-paste/history-key` while a database exists; the
      panel shows "locked" and "Start fresh" deletes the database (covered by a unit test,
      not yet done by hand against the Keychain).
- [ ] Retention: set 1 day, backdate an item, relaunch; the item is gone (unit-tested only).
- [ ] Decider = cloudflare with a real token: one egress line per question to
      `api.cloudflare.com`, purpose `decide`, no text (no credentials available here).
- [ ] Generator = openai-compatible at `http://localhost:11434`: the egress line is marked
      `local: true` (no local model server was running).
- [ ] §5 permissions: confirm no TCC permission other than Accessibility is requested.

## Fixes the verification needed outside `app/` (reported, not applied to the sources)

1. `core/src/render/compose.ts:259` — `Bun.file(new URL("./charset.txt", import.meta.url).pathname)`
   percent-encodes a space in the install path (`Pocket%20Paste.app`); use
   `Bun.file(new URL("./charset.txt", import.meta.url))` (or `fileURLToPath`).
2. The engine (pocketjs-motion @ ca3c076, vendored pocketjs) derives filesystem paths with
   `new URL(…, import.meta.url).pathname` in `src/runtime/boot.ts:30`, `src/render/parallel.ts:65`,
   `src/render/build-record.ts:49`, `src/text/measure.ts:272,314` and
   `vendor/pocketjs/framework/compiler/jsx-plugin.ts:35-38,57,64-86,105-106`; under
   `~/Library/Application Support/…` (a space) every one of them fails with ENOENT. Fix with
   `fileURLToPath` in the engine (a new patch + `engine.json` bump), or rewrite those sites in
   `scripts/bundle-sidecar.ts` after the copy.
