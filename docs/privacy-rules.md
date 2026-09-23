# Privacy rules: what a model sees

Peesuto uses a decision model (Jev) to choose a template, a style, a motion
and an emphasis word, and to rank history for smart paste. The model only
**chooses**. It never writes text: every card is rendered on this Mac from
your own text. So what the model receives can be reduced without changing
what you get. Privacy rules control that reduction.

The rules live in `core/src/privacy/rules.ts`. They are applied at one
choke point, `core/src/privacy/decider.ts`, which wraps every **network**
decider (`cloudflare`, `proxy`, `hosted`, and any other endpoint). **Local**
deciders (`rules`, `none`, `laya`) run on this machine and receive the
original text, because it does not leave the machine.

## The three modes

Settings → 「发给 AI 模型的内容」 (`config.set` `privacy.modelContent`):

| mode | 名称 | what the model receives |
|---|---|---|
| `raw` | 原文 | the text as copied |
| `redacted` (default) | 敏感信息脱敏 | the text with every match replaced by a placeholder such as `[密钥]` |
| `structure` | 仅发结构 | the redacted text with Latin letters → `x`/`X`, digits → `0`, other letters (Chinese and so on) → `字`; whitespace, punctuation, line breaks and length are kept, and the placeholders stay readable |

Example, `项目 ABC 的密码: hunter22` →
- redacted: `项目 ABC 的密码: [密码]`
- structure: `字字 XXX 字字字: [密码]`

The mode applies to every model decision: the shortcut actions (card, GIF,
video), precompose when it uses the model, and smart paste. It rewrites every
string in the request's `state` and every choice's criterion *description*.
Criterion keys, question names and instructions are Peesuto's own text and are
not changed. Two things keep a secret out of questions that are built from
your text:

- **Emphasis.** The emphasis question offers words of your text, and the
  word itself is the criterion key. Behind a wrapped decider, words that
  overlap a redacted span are never offered. In structure mode no emphasis
  question is asked. An answer that names such a word is ignored.
- **Smart paste.** Candidates are shortened to 80-character summaries.
  Behind a wrapped decider, they are redacted *before* shortening, so a
  key cut in half cannot slip past its rule.

## Built-in rules

Secrets are on by default. Personal data rules exist but are off by default.
Each rule can be turned on or off in Settings (`privacy.builtins`).

| id | 默认 | detects | placeholder |
|---|---|---|---|
| `api-keys` | on | OpenAI `sk-`/`sk-proj-`, Anthropic `sk-ant-`, GitHub `ghp_ gho_ ghu_ ghs_ github_pat_`, AWS `AKIA`/`ASIA` access key ids and a 40-character secret next to one (or after "aws"/"secret"), Google `AIza`, Slack `xox[abprs]-`, Stripe `sk_live_`/`rk_live_` | `[密钥]` |
| `private-keys` | on | PEM and OpenSSH `-----BEGIN … PRIVATE KEY-----` blocks, also when cut off before the END line | `[私钥]` |
| `jwt` | on | `eyJ….….…` | `[令牌]` |
| `bearer-tokens` | on | the value of `Authorization:` headers, and `Bearer <token>` (plain words are not tokens) | `[令牌]` |
| `connection-strings` | on | the password in `scheme://user:password@host` | `[密码]` |
| `secret-assignments` | on | the **value** after `key=`, `key:`, `key：` or `key =>`, when the key contains password, passwd, pwd, secret, token, api_key, access_key, private_key, 密码, 密钥, 口令 or 令牌. The name stays. Placeholders such as `********` and `${VAR}` are left alone | `[密码]`, `[密钥]` or `[令牌]` by key |
| `random-tokens` | on | random-looking strings of 20+ characters: three character classes, or high Shannon entropy. Not flagged: git SHAs and other hex up to 64 characters (unless assigned to a secret key, see above), UUIDs, numbers, ordinary words and identifiers, file paths, and links without credentials | `[令牌]` |
| `email` | off | email addresses | `[邮箱]` |
| `phone` | off | mainland China mobile numbers (`1[3-9]` + 9 digits, optional `+86`), international `+…` numbers | `[手机号]` |
| `id-card` | off | 18-digit resident ID numbers with a valid checksum | `[身份证号]` |
| `bank-card` | off | 13–19 digits (spaces or dashes allowed) that pass the Luhn check | `[银行卡号]` |

"Contains a secret" (used by precompose) means an enabled rule from the first
seven matched. Email, phone, ID card and bank card are personal data, not
secrets.

## Custom rules

Settings → custom rules (`privacy.rules`, at most 100):

| field | meaning |
|---|---|
| `match` | `text` (a literal), `keywords` (one keyword per line; blank lines ignored; the longest keyword wins) or `regex` (JavaScript syntax) |
| `pattern` | at most 500 characters |
| `replacement` | literal text, at most 100 characters (no `$1` references) |
| `caseSensitive` | default off |
| `wholeWord` | default off. A match must start and end at a word boundary. Boundaries are Unicode-aware: Chinese is segmented into words, so 「中国」 matches in 「我在中国。」 but not in 「我爱中国人」, and `cat` matches in `cat's` but not in `concatenate` |
| `alsoInOutput` (「图片中也替换」) | default off: the replacement is only in what the model sees. On: the text is also replaced in the rendered image, GIF or video |
| `enabled` | default on |

`config.set` validates and compiles every rule once. An invalid regex, a
regex that repeats a repeated group (like `(a+)+`, which can hang), or a
field over its limit is a `usage` error that names the rule, and the
previous configuration stays in force.

When matches overlap, the earliest start wins, then the longest, then the
rule listed first (your rules come before the built-ins).

## alsoInOutput and rendering

For render actions (card, GIF, video) and precompose, rules marked
`alsoInOutput` are applied to the text **before** the template is chosen and
rendered. The model then sees at most that text, redacted per the mode. Text
actions (translate, summarize) and smart paste are not changed by
`alsoInOutput`.

## Checking a text

`privacy.preview {text}` answers `{modelText, outputText, spans, containsSecret}`:
the text the model would receive under the current mode, the text that would
be rendered, the replaced spans (`start`/`end` are UTF-16 offsets into the
original, so they map to `NSRange`), and whether precompose would treat it as
containing a secret. Settings has a test box for this. The Studio shows the
same thing in its 「模型收到的内容」 panel (`bun run studio`).

## Precompose

Precompose renders every text you copy in the background, so the shortcut
returns at once. It is off by default. It decides with the **local rules**
unless 「预合成也使用 AI 模型」 is on, so by default precompose sends
nothing anywhere. With that switch on, every copied text reaches the model,
redacted per the mode. With 「包含密钥时不预合成」 (default on), a text that
contains a secret is not precomposed at all. See [daemon.md](daemon.md#precompose).

## Limits

- Detection is pattern matching. It can miss a secret with an unusual
  format, such as a short password written in prose ("my password is
  tulip"), and it can replace something harmless. Structure mode is the
  safer choice for very sensitive work. Turning the decider off (rules or
  none) sends nothing.
- The model never returns text, so nothing needs to be restored: templates,
  styles and motions are names, and the emphasis word must occur verbatim in
  your text.
- The rules decide what leaves the machine. Your text is still stored in the
  encrypted local history as copied.
