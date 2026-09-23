# Privacy audit checklist

pocket-paste watches the clipboard, so the burden of proof is on it. This
list is what a release must pass, step by step, so anyone can repeat it.
Date, version and result go into `baselines/privacy-<version>.md`.

## Native migration acceptance

The original privacy baseline below is historical evidence from the retired
desktop. The current app is SwiftUI + AppKit; old passing checks are not native
acceptance results. Re-run this checklist against the
actual native `.app`, including imported encrypted history/images, existing
Keychain credentials, permission denial, Core crashes and task cancellation.
Use synthetic data and a separate data directory for migration tests; do not
run both desktop versions against the production store at the same time.
See the [migration compatibility requirements](native-migration.md).

## 1. Data classes and where each one goes

| data | stored | leaves the machine | switch |
|---|---|---|---|
| clipboard text, RTF, HTML | encrypted SQLite in App Support; key in Keychain | only as part of a decider question or a generator prompt, and only for the item you act on (with precompose + 「预合成也使用 AI 模型」, for every copied text). Decider questions to a network decider carry the text as the model-content mode allows: redacted by default, see [privacy-rules.md](privacy-rules.md) | decider = rules or none, generator = none, or Offline; mode 仅发结构 |
| precomposed cards (every copied text, when precompose is on) | rendered files in `App Support/cards/`, pruned like other outputs (newest 30, one day); results indexed in memory only | never, unless 「预合成也使用 AI 模型」 is on: then each copied text reaches the decider, redacted per the mode | precompose outputs = none (default); 「包含密钥时不预合成」 (default on) |
| privacy rules (custom patterns and replacements) | the shell's settings file; sent to Core with `config.set`, kept in memory | never | — |
| images, files copied | thumbnail + original under App Support | never | history off |
| app bundle id per item | with the item | as part of the pick question's state (bundle id only) | decider = rules or none |
| focused field context (role, label, text around the caret) | never stored | as part of the pick question, redacted per level | smart paste off, or decider = rules or none |
| history search queries | never stored | never | — |
| provider credentials | Keychain | to the provider they belong to | — |
| egress log (host, purpose, bytes, status) | `App Support/egress.log` | never | — |
| answer cache (decider answers keyed by text hash) | `App Support/answers/` | never | clear cache |
| emoji codepoints | cached PNGs | to jsdelivr on first use of an emoji | ship the bundled set |

## 2. Exclusions that must hold

Run each and confirm nothing lands in history:

- [ ] Copy a password from 1Password (`com.1password.1password`).
- [ ] Copy a password from Bitwarden (`com.bitwarden.desktop`).
- [ ] Copy a password from Keychain Access (`com.apple.keychainaccess`).
- [ ] Copy from a field that sets `org.nspasteboard.ConcealedType` (Safari's
      password autofill; any app using the standard concealed type).
- [ ] Copy from an app that sets `org.nspasteboard.TransientType`.
- [ ] Copy inside a `AXSecureTextField`; also confirm smart paste does NOT
      open on that field and no context is captured.
- [ ] Add an app to the blacklist in Settings; copy from it; nothing recorded.

## 3. Egress

- [ ] Offline switch on: run every built-in action; every provider call fails
      with `provider:offline`, and `egress.log` gains no line.
- [ ] Offline switch off, decider = rules (the default) and then none, generator = none: paste as card
      renders; `egress.log` gains no line except jsdelivr for an unbundled emoji.
- [ ] Decider = cloudflare: one line per question, host
      `api.cloudflare.com`, purpose `decide`; the line contains no text.
- [ ] Generator = openai-compatible at `http://localhost:11434`: the line is
      marked `local: true`.
- [ ] Grep `egress.log` and the app's stderr for any clipboard text used in
      the test; zero hits.

## 3a. What the model receives (privacy rules)

- [ ] Decider = cloudflare (or proxy), mode 敏感信息脱敏: copy a text with a
      fake key (`sk-proj-FAKE…`), a `password: …` line and a
      `postgres://user:pass@host` URL; run paste as card. Capture the request
      (proxy under `wrangler dev` logs the body, or a local endpoint decider)
      and confirm it holds `[密钥]` / `[密码]` and none of the fake values;
      the emphasis criteria contain none of them either.
- [ ] Mode 仅发结构: the same request holds only `x`, `0`, `字`,
      punctuation and placeholders, and no emphasis question.
- [ ] Mode 原文: the request holds the text as copied.
- [ ] Decider = rules, none or laya: no request leaves the machine (laya is
      local and receives the original).
- [ ] Smart paste with a history item longer than 80 characters that ends in
      a key: the pick request holds the placeholder, not half the key.
- [ ] A custom rule with 「图片中也替换」 changes the rendered card; without it
      the card shows the original and only the request is changed.
- [ ] Settings' test box (`privacy.preview`) shows the same model text as the
      captured request.

## 3b. Precompose

- [ ] Precompose off (default): copying text renders nothing; `cards/` does
      not grow.
- [ ] Precompose on, 「预合成也使用 AI 模型」 off: copying text renders a card
      in `cards/` and `egress.log` gains no line.
- [ ] 「包含密钥时不预合成」 on: copying a text with a fake key renders nothing.
- [ ] Concealed/transient copies, excluded apps and Peesuto's own writes are
      never precomposed.
- [ ] 「预合成也使用 AI 模型」 on with a network decider: every copy adds one
      `egress.log` line, and the captured request is redacted per the mode.
- [ ] Low Power Mode or a serious thermal state: nothing is precomposed.

## 4. Storage

- [ ] The SQLite file opened with `sqlite3` shows no plaintext for a copied
      marker string (search the raw file with `grep -a`).
- [ ] Deleting an item removes its row and its image file.
- [ ] Clear all leaves an empty table and an empty images directory.
- [ ] Removing the Keychain key makes the history unreadable, and the app
      offers to start fresh rather than crashing.
- [ ] Retention: set 1 day, backdate an item, relaunch; the item is gone.

## 5. Permissions

- [ ] The Accessibility prompt explains why (paste simulation, field
      context); denying it leaves history usable and disables only paste
      simulation and smart paste.
- [ ] No other TCC permission is requested.

## 6. Settings tells the truth

- [ ] The Privacy pane lists the same table as section 1, with each row's
      switch, and the current provider destinations by host.

## Historical verification — retired desktop, 2026-09-22

The automatable parts of §2 (plain / concealed / transient, the app blacklist), §3
(offline switch, egress log without text) and §4 (raw-file scan, delete, clear all)
passed against the bundled debug build; the results, the method and the list of
manual checks still open (1Password, Bitwarden, Keychain Access, `AXSecureTextField`,
the Accessibility prompt flow) are in [`baselines/privacy-0.1.0.md`](../baselines/privacy-0.1.0.md).
