# Pocket Paste — desktop shell

Tauri 2 (Rust) + vanilla TypeScript/Vite. Three windows: `history` (the panel
behind ⌘⇧V), `result` (a card from "Paste as card") and `settings`.

    bun install
    bun tauri dev                 # dev sidecar: bun <repo>/core/src/cli.ts
    bun tauri build --debug
    bun run build:bundled         # after `bun ../scripts/bundle-sidecar.ts`: ships the sidecar

`POCKET_PASTE_AUTORUN=history|card bun tauri dev` opens a window shortly after
launch (debug builds only). Icons: `bun run icons`.
