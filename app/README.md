# Pocket Paste — desktop shell

Tauri 2 (Rust) + vanilla TypeScript/Vite. A menu-bar clipboard with actions:
three windows — `history` (the panel behind ⌘⇧V, with the smart pick),
`result` (what an action produced: text or a card) and `settings`.

    bun install
    bun tauri dev                 # dev sidecar: bun <repo>/core/src/daemon.ts
    bun tauri build --debug --bundles app
    bun run build:bundled         # after `bun ../scripts/bundle-sidecar.ts`: ships Core + Bun
    cargo test                    # in src-tauri: store, providers, context

`POCKET_PASTE_AUTORUN=history|card|action:<id>|delete-newest|clear[:<ms>] bun tauri dev`
drives the app shortly after launch (debug builds only; `POCKET_PASTE_AUTORUN_REPEAT=n`
runs `card`/`action` n times for cold and warm timings). Every rebuilt dev binary is
a new identity to the Keychain, so reading the history key prompts; for an
unattended run set `POCKET_PASTE_HISTORY_KEY=<base64 of 32 bytes>` (debug
builds only) and the Keychain is not touched. Icons: `bun run icons`.

## How it is put together

| file | does |
|---|---|
| `daemon.rs` | one long-lived Core process (`core/src/daemon.ts`): JSON lines over stdin/stdout, increasing ids, a pending map with per-request timeouts (pick 10 s, run-action/render 180 s), Core's stderr into the app log. Started at launch; restarted on the first request after it exits (idle, crash). The first line into a fresh process is always `config.set` with the provider configs and the Keychain secrets. Two consecutive start failures → renders fall back to the one-shot `paste` CLI (`sidecar.rs`), everything else reports `sidecar`; saving Settings tries again. |
| `sidecar.rs` | where Core lives: `dev` (bun on a checkout) or `bundled` (the `paste` Bun binary next to the app on `Resources/resources/core/…`), plus the CLI fallback. |
| `providers.rs` | `<app data>/providers.json` in Core's `ProvidersConfig` shape (kinds, URLs, models, offline) with only `*Ref` names for credentials; the secrets live in the Keychain under `SECRET_REFS` (`pocket-paste/proxy`, `pocket-paste/cloudflare`, `pocket-paste/hosted`, `pocket-paste/generator`) and reach Core in memory. Also the privacy pane's data: destinations by host, the egress log tail, cache clearing. |
| `store.rs` | history storage. `history.sqlite` with `text` and `preview` as AES-256-GCM blobs (12-byte nonce ‖ ciphertext) under a 32-byte key kept only in the Keychain (`pocket-paste/history-key`); images as encrypted files (`images/<id>.bin` + a 256 px `…thumb.bin`). Search decrypts the newest 500. Key gone but database present → *locked*: the panel says so and offers "Start fresh" (deletes the database). `MemoryStore` for tests. |
| `clipboard.rs` | the 250 ms pasteboard poller: text, file lists, images (PNG/TIFF when there is no text); exclusions (Concealed/Transient types, the app blacklist from Settings); retention at launch and hourly. |
| `context.rs` | the focused field through the Accessibility API when the hotkey fires: app, window title, role/subrole, label, and for text roles the 200 characters before and after the caret → Core's `Context` at level 0/1/2. `AXSecureTextField` → `secure`, no pick, plain history with a note. Not trusted → level 0 with the frontmost app. |
| `actions.rs` | the action registry (from `actions.list`), the tray menu and per-action hotkeys built from it (conflicts skipped and reported), running an action (`run-action`; input from the clipboard or a history item, context from the capture), and the result window's state. |
| `paste.rs` | write the pasteboard, give focus back, press ⌘V (needs Accessibility). |
| `settings.rs` | `settings.json` (store plugin): hotkey, aspect, sidecar mode + checkout, retention days, blacklist, smart paste, onboarded. |
| `hotkeys.rs`, `tray.rs`, `windows.rs`, `pasteboard.rs`, `secrets.rs`, `log.rs` | the rest of the system side. |

Frontend: `src/history.ts` (panel: on `history:open` from the hotkey it loads the
newest 50 items, calls `daemon_pick`, reorders by the ranking, preselects the
top and shows `decider`/`heuristic` and a should-paste dot; typing cancels the
pick order), `src/result.ts` (text mode with Paste/Copy and the model; card
mode with aspect toggle and "Another take" = `fresh: true`), `src/settings.ts`
(General, Providers with a Test per track, Actions, Privacy, Exclusions).

## Release build, updates, subscription

    bun ../scripts/bundle-sidecar.ts --out src-tauri     # from app/: binaries/ + resources/ (gitignored)
    bun run build:bundled --bundles app,dmg              # release profile with the sidecar config

`tauri.sidecar.conf.json` also switches the updater on: `plugins.updater`
(endpoint `https://github.com/qianiaoo/pocket-paste/releases/latest/download/latest.json`,
`pubkey` to fill in) and `bundle.createUpdaterArtifacts`. With that flag the
CLI signs the `.app.tar.gz` and needs `TAURI_SIGNING_PRIVATE_KEY` (and
`…_PASSWORD`) in the environment; without a key at hand, build with
`--config '{"bundle":{"createUpdaterArtifacts":false}}'` appended. The
user steps — generate the keypair with `bun tauri signer generate`, paste
the public key into `pubkey`, keep the private key as a CI secret — are in
`docs/RELEASING.md`. In Rust (`updater.rs`) the plugin is registered only
when the built config carries a non-empty `pubkey`, so `tauri dev` and
unsigned builds never contact the endpoint; when it is on, a check runs
30 s after launch and daily, and the tray's "Check for updates…" reports
either way ("Updates are not configured in this build." otherwise).

An unsigned `.app`/DMG is refused by Gatekeeper on first launch: right-click
→ Open, or `xattr -dr com.apple.quarantine "/Applications/Pocket Paste.app"`.

Settings → Subscription (`subscription.rs`): the license key goes to the
Keychain as `pocket-paste/hosted`, the base URL to Settings; *Activate* calls
`GET {base}/v1/me` and shows plan/quota/used/reset, *Use hosted for both
tracks* writes `providers.json` with `hosted` on both tracks and pushes
`config.set`. *Browse packs* lists `GET {base}/v1/packs`; *Install* downloads
the zip, checks its SHA-256 against the index and unpacks it into
`<app data>/packs/<id>/` (the zip root must hold `pack.json`), then asks Core
to reload and shows its problems; *Installed packs* is Core's `health.packs`
with Remove. These are the shell's own requests: each writes one line to
`egress.log` in Core's shape (`purpose: "subscription"` or `"pack"`), never
a body, and the Offline switch refuses them. Debug builds add *Install from
folder…* (`docs/packs/example-neon` is a complete styles pack) and the
`POCKET_PASTE_AUTORUN=pack-test:<dir>` hook.

## Data on disk

`~/Library/Application Support/dev.pocketpaste.desktop/`: `history.sqlite`,
`images/`, `providers.json` (no secrets), `settings.json`, `egress.log`,
`answers/` (decider cache), `actions/` (your action files), `packs/`,
`cards/`, `work/`, `app.log`. Keychain service `dev.pocketpaste.desktop`.
