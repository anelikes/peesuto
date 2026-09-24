# The Core daemon

This document describes the **currently implemented protocol**. The
SwiftUI + AppKit desktop retains this Bun Core; the
[native migration plan](native-migration.md) defines the target lifecycle and
protocol improvements. The first Swift client now exists at
`native/Sources/PeesutoKit/CoreClient.swift`; the original request/response
format is preserved, with optional task lifecycle events for new callers.

The native desktop starts Core on demand (`paste-daemon`, the Bun sidecar)
and reuses it across tasks. It talks over stdin/stdout in JSON lines: one
request per line and one final response per request, matched by `id`.
Opted-in requests may also receive lifecycle event lines before their final
response. Requests are served one at a time in order, so a render or model call delays
all requests behind it for its remaining duration. Native migration must
remove this scheduling limitation rather than merely displaying a spinner.

```
paste-daemon --app-data ~/Library/Application\ Support/com.peesuto.desktop \
             --engine-resources <app bundle>/Contents/Resources/resources \
             --idle-minutes 10
```

The first line out is `{"id":0,"ok":true,"cmd":"ready","version":…,"engine":…}`.
The current ready message has no protocol capability negotiation.
`engine` is null when rendering is unavailable (the install carries no
engine, or it failed to set up); the daemon still serves pick and generator
actions. The process exits when stdin closes, on `shutdown`, or after
`--idle-minutes` with no active request; the shell restarts it on the next request.
The idle timer is suspended while handling a request and restarted after its
response. A slow model/render task is not idle just because stdin is silent,
and neither is precompose work running in the background.
Only responses and opted-in lifecycle events are written to stdout; diagnostics go to stderr.

## Commands

| cmd | request fields | response |
|---|---|---|
| `health` | — | `version`, `engine`, `providers {decider, generator, offline}`, `uptimeMs` |
| `config.set` | `decider`, `generator` (provider configs), `offline`, `secrets {name: value}`, `egressLog`, `privacy?`, `precompose?` | `providers` |
| `pick` | `context`, `candidates[]`, `fresh?` | `result {ranked[], shouldPaste, source}` |
| `actions.list` / `actions.reload` | — | `actions[]`, `problems[]` |
| `templates.list` | — | bilingual `templates[]` with variants and motions |
| `run-action` | `action` (id), `input {text, item?, context?, aspect?, fresh?, template?, templatePreferences?}`, `candidates?[]`, `events?` | `result` (text, or path+format for image/GIF/video; `meta.template.aspect` is the frame used), `pick?` |
| `render` | `dsl`, `out?`, `events?` | `path`, `format`, `frames`, `ms` |
| `privacy.rules` | — | `builtins[] {id, name, nameZh, description, descriptionZh, defaultEnabled, enabled}` |
| `privacy.preview` | `text` | `modelText`, `outputText`, `spans[] {start, end, ruleId, replacement}`, `containsSecret` |
| `precompose` | `text`, `frames? {image?, gif?, video?}`, `templatePreferences?` | `queued: true`, or `queued: false` and `skipped` (`off`, `secret`, `too-long`, `empty`) |
| `shutdown` | — | — |

Media actions use the [structured template pipeline](templates.md). Optional
`input.template` selects `{id?, variant?, motion?}`; `templatePreferences` maps
template IDs to saved variant IDs. Result `meta.template` reports the actual
selection and compatible templates. Content comes from local source parsing,
not generated model fields. The explicit DSL `render` command remains separate.

A render action's result carries `meta.precomposed: true` when it was served
from the precompose cache (the key is absent otherwise).

## Privacy and precompose settings

Both `config.set` sections are optional; an absent section means its
defaults, so every `config.set` sends the full settings. Everything is
validated before anything changes: an invalid rule is a `usage` error naming
the rule, and the previous settings stay in force.

```
privacy: {
  modelContent: "raw" | "redacted" | "structure",   // default "redacted"
  builtins?: { [ruleId]: boolean },                 // override a built-in's default
  rules?: [{ id, name, match: "text" | "keywords" | "regex", pattern, replacement,
             caseSensitive?, wholeWord?, alsoInOutput?, enabled? }]   // ≤ 100; pattern ≤ 500; replacement ≤ 100
}
precompose: {
  outputs: ("image" | "gif" | "video")[],   // [] = off (default)
  useModel: boolean,                        // default false: local rules decide
  skipSecrets: boolean,                     // default true
  maxChars?: number                         // default 1200 visible characters
}
```

What the rules detect, the three modes and their limits are in
[privacy-rules.md](privacy-rules.md). Network deciders (`cloudflare`, `proxy`,
`hosted`, any other endpoint) are wrapped so every request goes through the
rules; `rules`, `none` and `laya` receive the original text. `privacy.preview`
spans are UTF-16 offsets into the original text (`NSRange`); in `raw` mode it
returns no spans. `alsoInOutput` rules change the text of render actions and
precompose before the template is decided; text actions are unchanged.

## Precompose

`precompose` answers at once. The work runs in the background of the same
process: one task per configured output, one at a time, the engine at a
lower priority (`nice 10`), GIF encoding yielding between frames.

- **Skipped** (`queued: false`): `off` when no output is configured (or the
  install cannot render), `empty` for whitespace, `too-long` above `maxChars`
  visible characters (grapheme clusters that are not whitespace), `secret` when
  `skipSecrets` is on and an enabled built-in secret rule matches. Video is
  left out silently when no MP4 encoder (PeesutoEncoder or ffmpeg) is available. A `frames` value that is not a
  frame is a `usage` error.
- **Latest only.** A new `precompose` replaces queued work and cancels the
  running task unless it is for the same key. Cancelling kills the engine's
  whole process group and stops the GIF encoder between frames.
- **Decider.** The local rules, unless `useModel`, then the configured
  decider (wrapped by the privacy rules like every other model call).
- **Cache.** Results are kept in memory, the latest 20 keys; the files are in
  the normal output directory, so the usual pruning (newest 30, one day)
  applies, and a hit whose file is gone is a miss. The key covers the text,
  the output, the normalized frame, the action's animate setting,
  `templatePreferences`, the privacy settings, the precompose settings, the
  decider when `useModel`, the installed packs and the core version (the
  bundle's `VERSION`, or a hash of `core/src` in a development tree).
  `actions.reload` clears the cache; any settings change cancels pending work.
- **run-action** for a render action with no `input.template` and no
  `input.fresh`: a cached result is returned at once with
  `meta.precomposed: true`. If precompose for the same key is running, it
  waits for it. Otherwise it pauses the worker and cancels what runs: work
  for another text is dropped, work for the same text (another output)
  resumes afterwards. The DSL `render` command also pauses the worker. Only
  one render uses the engine work tree at a time.
- Precompose results are never written into the cache by `run-action`, so
  `meta.precomposed` always means "rendered before you asked".

## Errors

Errors: `{"id":n,"ok":false,"kind":"provider:auth","message":"…"}`. The
kinds are the CLI's (`core/src/daemon/protocol.ts`, `ERROR_KINDS`). A
`compose` error also carries `code` (`overflow`, `unsupported-script`, `empty`
or `catalog`), and an `unsupported-script` one lists the offending
`characters`, so the shell can say which character the font lacks instead of
calling everything "too long".

## Optional task lifecycle events

Set `events: true` on `run-action` or `render` to receive content-free task
lifecycle notifications for the same request ID:

```json
{"id":7,"cmd":"run-action","action":"paste-card","input":{"text":"Example"},"events":true}
```

```json
{"id":7,"event":"task","cmd":"run-action","state":"accepted"}
{"id":7,"event":"task","cmd":"run-action","state":"running"}
{"id":7,"event":"task","cmd":"run-action","state":"completed"}
```

The normal final response follows these events. On failure the terminal event
is `failed`, followed by the original `ok: false` error response. Events do
not contain an `ok` field, clipboard content, credentials or percentages.
`accepted` means the request reached the handler; `running` means handling
started. These are not renderer sub-stages, queue-depth estimates or encoding
progress. A process killed during cancellation/crash cannot emit its terminal
event; the client settles the pending request as an error.

Requests without `events: true` receive no extra lines, preserving compatibility
with existing request/response-only CLI and integration callers. Swift's optional `runAction(..., onState:)` enables
the extension and delivers `CoreTaskState` values. Events do not consume the
final response continuation or extend its deadline. Unknown future states are
ignored, and a legacy daemon that only sends a final response remains usable.

## Secrets

Core never reads the Keychain and never writes a secret to disk. The shell
owns the Keychain; at launch and whenever settings change it sends
`config.set` with the provider configs and the resolved secrets, and Core
keeps them in memory for the life of the process. A restart of the daemon
therefore always begins with `config.set`.

## Types

`Context`, `ClipItem`, `PickResult`, `ActionSpec`, `ActionInput`,
`ActionResult` are defined in `core/src/pick/types.ts` and
`core/src/actions/types.ts`. The native client mirrors these in
`native/Sources/PeesutoKit/CoreModels.swift`; tests cover response matching,
configuration barriers, timeouts, crashes, cancellation and worker cleanup.

## Native client status

The Swift client starts Core on demand, waits for ready/configuration, keeps
secrets in memory and reapplies them after restart. Pipe writes are off the
actor so a full pipe cannot block deadline handling. The bundled
`PeesutoCoreHost` establishes a private process group; cancellation, timeout
and shutdown stop that Core and its workers. This currently fails all pending
requests, not only one independently cancellable task. Requests are not
silently replayed, and the native UI remains responsive while awaiting work.
The native direct-action path shows a nonactivating status panel and checks
the original target and clipboard generation before automatic delivery;
Core only returns an output and never simulates the paste itself.

## Remaining protocol and lifecycle work

- Version/capability negotiation, detailed rendering progress, independent
  task cancellation and complete error-code/localization coverage. The command
  table above remains the current API; lifecycle events are implemented, but
  there is no per-task cancel command or percentage-based progress protocol.
- Separate long rendering work from light requests while serializing builds
  against shared engine resources or isolating those resources completely.
- Extend the current process-group cancellation with task-specific cleanup
  and partial-output policy without weakening late-result protection or
  silently replaying model requests and paste operations after a crash.

The migration is partially complete; the remaining items above are not implemented.
