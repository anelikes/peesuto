# The Core daemon

The desktop app does not shell out per paste. It starts one Core process at
launch (`paste-daemon`, the Bun sidecar) and talks to it over stdin/stdout
in JSON lines: one request per line, one response per line, matched by
`id`. Requests are served one at a time in order, so a render in flight
delays a pick behind it by about a second; the shell should show that.

```
paste-daemon --app-data ~/Library/Application\ Support/pocket-paste \
             --engine-resources <app bundle>/Contents/Resources/resources \
             --idle-minutes 10
```

The first line out is `{"id":0,"ok":true,"cmd":"ready","version":…,"engine":…}`.
`engine` is null when rendering is unavailable (the install carries no
engine, or it failed to set up); the daemon still serves pick and generator
actions. The process exits when stdin closes, on `shutdown`, or after
`--idle-minutes` of silence; the shell restarts it on the next request.
Nothing but responses is written to stdout; diagnostics go to stderr.

## Commands

| cmd | request fields | response |
|---|---|---|
| `health` | — | `version`, `engine`, `providers {decider, generator, offline}`, `uptimeMs` |
| `config.set` | `decider`, `generator` (provider configs), `offline`, `secrets {name: value}`, `egressLog` | `providers` |
| `pick` | `context`, `candidates[]`, `fresh?` | `result {ranked[], shouldPaste, source}` |
| `actions.list` / `actions.reload` | — | `actions[]`, `problems[]` |
| `run-action` | `action` (id), `input {text, item?, context?, aspect?, fresh?}`, `candidates?[]` | `result` (text, or path+format for pictures), `pick?` |
| `render` | `dsl`, `out?` | `path`, `format`, `frames`, `ms` |
| `shutdown` | — | — |

Errors: `{"id":n,"ok":false,"kind":"provider:auth","message":"…"}`. The
kinds are the CLI's (`core/src/daemon/protocol.ts`, `ERROR_KINDS`).

## Secrets

Core never reads the Keychain and never writes a secret to disk. The shell
owns the Keychain; at launch and whenever settings change it sends
`config.set` with the provider configs and the resolved secrets, and Core
keeps them in memory for the life of the process. A restart of the daemon
therefore always begins with `config.set`.

## Types

`Context`, `ClipItem`, `PickResult`, `ActionSpec`, `ActionInput`,
`ActionResult` are defined in `core/src/pick/types.ts` and
`core/src/actions/types.ts`; the Rust side mirrors them with serde structs
(`app/src-tauri/src/sidecar.rs`).
