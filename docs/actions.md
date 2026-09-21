# Actions

An action is one thing pocket-paste can do with text on its way from the
clipboard into an input: paste it as a card, paste a translation, paste a
summary, or anything you can phrase as a prompt. Actions are JSON files;
the five shipped ones use the same format as yours.

## Where they live

- Built-in: inside the app (`core/src/actions/builtin.ts`).
- Yours: `~/Library/Application Support/pocket-paste/actions/*.json`.
- Packs: `~/Library/Application Support/pocket-paste/packs/<pack>/pack.json`
  plus `packs/<pack>/actions/*.json`. A pack is a directory; copy it in, or
  install one from a subscription.

Later files win by `id`, so a file of yours named like a built-in replaces
it. A file that fails validation is reported in Settings and skipped; the
others still load.

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
| `trigger.hotkey` | Tauri accelerator, e.g. `CmdOrCtrl+Shift+V` | optional |
| `trigger.menu` | boolean | show in the tray menu |
| `input` | `clipboard` \| `item` | the current text, or a history item chosen in the panel |
| `needs` | `decider` \| `generator` \| `render` \| `none` | what has to be configured for it to run |
| `prompt` | string with `{{input}}` | generator actions; also `{{context}}` (where you are pasting) and `{{app}}` |
| `system` | string | optional system prompt |
| `maxTokens` | integer | optional |
| `output` | `text` \| `image` \| `gif` \| `video` \| `file` | generator → `text`; render → `image`, `gif` or `video` |
| `render.aspect` | `chat` \| `doc` \| `social` | render actions; the panel can override |
| `render.animate` | `auto` \| `always` \| `never` | `auto` lets the decider choose |

`video` needs ffmpeg on the machine and is disabled otherwise.

## The built-ins

| id | needs | output |
|---|---|---|
| `paste-smart` | decider | the history item that fits where you are pasting, preselected; Enter confirms |
| `paste-card` | render | a still PNG card |
| `paste-gif` | render | an animated GIF card |
| `paste-translate` | generator | English translation |
| `paste-summary` | generator | three-sentence summary in the input's language |

## Privacy

`needs: generator` sends the filled prompt to the generator you configured;
`needs: decider` sends the typed questions to the decider. `none` and
`render` (with the decider set to none) leave nothing on the machine's way
out. The Settings window shows, per action, where its data goes.
