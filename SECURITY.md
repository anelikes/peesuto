# Security

## What leaves your machine

Pocket Paste is local-first. Clipboard text, the answer cache and every
rendered card stay on disk under your user account. Two kinds of request can
go over the network, and both depend on what you configured.

### The clipboard text, to the decision provider

To decide what kind of card to make, the seven typed questions are sent as
one JSON body, `{state: {clipboard: <the text>}, questions: {…}}`. Where that
body goes is the provider setting (`--provider` on the CLI, `PASTE_PROVIDER`
in the environment, the Provider pane in the app):

| provider | the text goes to | notes |
|---|---|---|
| `none` | nowhere | no request at all; every paste gets the plain card |
| `cloudflare` | `api.cloudflare.com`, Workers AI on your own account, model `typesafe/jev` | authenticated with your API token; subject to Cloudflare's terms for Workers AI |
| `proxy` (the CLI default) | `http://localhost:8787/`, the worker in `proxy/` running under `wrangler dev` | the worker forwards to Workers AI through your own wrangler login and stores nothing |
| `hosted` | our proxy (`jev.pocketpaste.dev`), which forwards to Workers AI | the proxy does not store the text; its logs carry a timestamp, the subscriber token id, byte counts and latency, never content |

The request is a single HTTPS `POST` (plain HTTP only for localhost) with a
bearer token where the provider needs one, and gives up after 8 seconds.
Answers come back as choices from a fixed catalog (kind, layout, palette,
scale, tone, animate) plus the index of the emphasised word. They are cached
on disk under a file named by the SHA-256 of the text so the same text is not
sent twice; the cache holds the answers, not the text. `--fresh` asks again.

### Emoji pictures, from jsDelivr

An emoji in the text is drawn as a picture from Noto Emoji at a pinned tag:
`https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@v2.047/png/128/emoji_u<codepoints>.png`,
fetched once per distinct emoji and kept in a local cache. The URL reveals
which emoji you used (and, as with any request, your IP address to the CDN),
not the text around it. Text without emoji makes no such request.

### What never leaves

- Anything with `--provider none`: no network access at all, apart from the
  emoji fetch above when the text has an emoji that is not cached yet.
- Credentials. A token is sent only to the endpoint it authenticates, in the
  `Authorization` header. The app keeps them in the macOS Keychain; the CLI
  reads them from flags or `PASTE_*` environment variables and never writes
  them to disk.
- Rendered cards, the work tree (`.work/`, or Application Support for the
  app) and the engine checkout.
- No telemetry, analytics or crash reporting. The only other request a
  release build will make is the update check against GitHub Releases, once
  the updater is enabled; it carries the app version and platform.

`PLAN.md` adds a clipboard history with field-level encryption,
password-manager exclusions, an offline switch and a local egress log that
records destinations and byte counts only. Until those land, this file
describes the CLI and the app as they are.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Either

- email **security@pocketpaste.dev** — TODO(user): replace this placeholder
  with an address you read; the domain is not set up — or
- use GitHub's private reporting on this repository: *Security → Report a
  vulnerability*.

Include the version or commit, the provider in use, steps to reproduce and
what an attacker gains. Expect an acknowledgement within 7 days and a fix or
a published mitigation within 90 days of a confirmed report. You will be
credited in the release notes unless you prefer not to be.

## Supported versions

Only the latest release receives security fixes. A fix ships as a new
release; older releases are not patched. Keep the app updated, and on a
checkout track `main`.

| version | supported |
|---|---|
| latest release | yes |
| anything older | no |
