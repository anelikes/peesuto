# Actions

An action is one thing pocket-paste can do with text on its way from the
clipboard into an input: paste it as a card, paste a translation, paste a
summary, or anything you can phrase as a prompt. Actions are JSON files;
the six shipped ones use the same format as yours.

## Native desktop compatibility

The [native migration](native-migration.md) retains the Bun action runtime,
JSON declarations, IDs and custom prompts. Swift replaces the desktop UI
and shortcut registration, not this format. Existing accelerator strings
must be parsed compatibly, and custom action labels/prompts must not be
translated when the interface language changes. The native menu design may
change where actions appear; it must preserve access to enabled actions.

The native desktop currently provides shortcuts that can be recorded or disabled for
opening history and three direct clipboard actions. Defaults are ⌘⌥1 for
`paste-card`, ⌘⌥2 for `paste-gif`, ⌘⌥3 for `paste-video`, and ⌘⌥4 for `paste-qr`. Record a binding
in **Settings → Shortcuts**, or clear it to disable; changes apply on save.
Bindings are stored in `settings.json` under `native_shortcuts`, separately
from action JSON declarations. Arbitrary custom-action shortcut registration
and the native action editor are not implemented yet.

These direct shortcuts use the current clipboard text instead of the selected
history row. Protected clipboard content remains excluded. A nonactivating
status panel reports task state without taking input focus. Automatic paste
requires the original frontmost application, window, input element, selection
and content to remain verifiably unchanged, with Accessibility available.
If the target cannot be verified, the result is copied for manual paste. If
the clipboard changed while generating, newer clipboard content is preserved
and the result remains available for explicit copy/paste/export.

## Where they live

- Built-in: inside the app (`core/src/actions/builtin.ts`).
- Yours: `~/Library/Application Support/com.peesuto.desktop/actions/*.json`.
- Packs: `~/Library/Application Support/com.peesuto.desktop/packs/<pack>/pack.json`
  plus `packs/<pack>/actions/*.json`. A pack is a directory; copy it in, or
  install one from a subscription.

Later files win by `id`, so a file of yours named like a built-in replaces
it. A file that fails validation is returned in `actions.list` problems and
skipped; the others still load. The legacy settings UI exposes action problems;
the native action-management UI is still incomplete.

## Format

```json
{
  "id": "translate-ja",
  "name": "Paste Japanese",
  "description": "Translate the clipboard into Japanese.",
  "trigger": { "hotkey": "CmdOrCtrl+Alt+J", "menu": true },
  "input": "clipboard",
  "needs": "generator",
  "system": "You are a precise translator. Output only the translation.",
  "prompt": "Translate into Japanese:\n\n{{input}}",
  "maxTokens": 1024,
  "output": "text"
}
```

| field | values | notes |
|---|---|---|
| `id` | `[a-z0-9-]`, ≤ 64 | unique; built-in ids may be overridden |
| `name` | string | shown in menus |
| `trigger.hotkey` | accelerator string, e.g. `CmdOrCtrl+Shift+V` | optional declaration; native currently registers its dedicated shortcut settings, not arbitrary action declarations |
| `trigger.menu` | boolean | legacy tray visibility; native uses a compact tray and panel action menu |
| `input` | `clipboard` \| `item` | the current text, or a history item chosen in the panel |
| `needs` | `decider` \| `generator` \| `render` \| `none` | what has to be configured for it to run |
| `prompt` | string with `{{input}}` | generator actions; also `{{context}}` (where you are pasting) and `{{app}}` |
| `system` | string | optional system prompt |
| `maxTokens` | integer | optional |
| `output` | `text` \| `image` \| `gif` \| `video` \| `file` | generator → `text`; render runtime → `image`, `gif` or `video` (MP4); generic `file` output is not implemented |
| `render.template` | a template id | render actions; always this template (the model is not asked); the result view can still switch |
| `render.aspect` | `auto` \| `1:1` \| `4:5` \| `16:9` \| `9:16` (legacy `chat` \| `doc` \| `social` = 1:1, 16:9, 9:16) | render actions; absent = the output's default (image `auto`, GIF and video `1:1`); the panel's per-format frame setting overrides |
| `render.animate` | `auto` \| `always` \| `never` | `auto` lets the decider choose |

`video` is implemented by the render runtime and the `paste-video` built-in.
Pocket Motion renders and encodes an MP4 using a locally installed ffmpeg.
The application does not bundle or automatically install ffmpeg. Discovery
checks an explicit `PEESUTO_FFMPEG_PATH`, then PATH, then the usual macOS
Homebrew locations `/opt/homebrew/bin/ffmpeg` and `/usr/local/bin/ffmpeg`.
An explicit path must be absolute and executable; invalid explicit paths fail
instead of silently selecting another binary. Missing ffmpeg produces an
action dependency error, while PNG/GIF remain available. Official encoder
distribution and full target-app video acceptance remain N4 work.

## The built-ins

| id | needs | output |
|---|---|---|
| `paste-smart` | decider | the history item that fits where you are pasting, preselected; Enter confirms |
| `paste-card` | render | a still PNG card |
| `paste-gif` | render | an animated GIF card |
| `paste-video` | render | an animated MP4 card; requires local ffmpeg |
| `paste-qr` | render | the copied text, exactly, as a QR code image (`render.template: "qr"`; no model is asked) |
| `paste-translate` | generator | English translation |
| `paste-summary` | generator | three-sentence summary in the input's language |

## Privacy

`needs: generator` sends the filled prompt to the generator you configured;
`needs: decider` sends the typed questions to the decider. `none` and
`render` (with the decider set to none) leave nothing on the machine's way
out. The legacy Settings window shows per-action destinations; the native
provider configuration is available, but the full action/privacy detail UI
has not been migrated yet.

## Thinking models

`maxTokens` is the whole answer budget. A model that reasons before it
answers (Ollama's qwen3.5 and gemma4 defaults, DeepSeek-R1, …) spends it on
the reasoning first, and on an action-sized budget often never reaches the
answer: the server returns empty `content` with the thinking in
`reasoning`. The `openai-compatible` generator treats that as a thinking
model, retries once with `reasoning_effort: "none"`, and sends the field on
every later request of the same session. A server that rejects the field
(older Ollama, some hosted APIs) gets a clear `model` error instead of an
empty paste; an action whose generator returns nothing fails with
`<action>: <model> returned nothing` rather than pasting an empty string.
Pin the behaviour in the legacy *Settings → Providers → Thinking* (or `reasoning` in
`providers.json`, `PASTE_GEN_REASONING` for the CLI) to skip the detour, and
raise *Timeout* (`timeoutMs`, `PASTE_GEN_TIMEOUT_MS`) for a large local
model that legitimately needs more than a minute.
The native UI preserves these advanced provider fields when saving the same
provider kind, but does not yet expose all of them as controls.

## Structured media presentation

The PNG/GIF/MP4 presets share the [template pipeline](templates.md). There are
8 source-backed template families with two variants each; flowcharts, timelines,
event cards and poetry-specific layouts remain later work. Jev chooses bounded
presentation options, while local parsing preserves source content. The native
result controls can rerender the captured input in a different style or format
without rereading the clipboard or automatically pasting again.
