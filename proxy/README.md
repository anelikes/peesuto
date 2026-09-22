# jev-proxy

The Cloudflare Worker behind Pocket Paste's decision providers. It takes a
paste's seven typed questions (`{state: {clipboard}, questions}`), forwards
them to Workers AI `typesafe/jev`, and returns `{ms, ...result}` where
`result` carries Jev's `answers`. A second route runs a Workers AI text model
for free-form generation. One worker, two modes, chosen by the `MODE` var.

| Mode | Where | Auth | Used by |
|---|---|---|---|
| `dev` (default) | `wrangler dev` on localhost:8787 | none | `PASTE_PROVIDER=proxy` (core's `proxyProvider`) |
| `hosted` | deployed, `--env hosted` | `Authorization: Bearer <subscriber token>` | `PASTE_PROVIDER=hosted` (core's `hostedProvider`) |

## Endpoints

| Route | Mode | What |
|---|---|---|
| `POST /v1/ask` (dev also `POST /`) | both | Validate, forward to Jev. Hosted: needs a bearer token; 401 unknown/inactive, 402 quota `{error:"quota", used, quota, resetsAt}`, 429 over 60 calls/min. Success adds `x-quota-used` / `x-quota-limit` headers. |
| `POST /v1/generate` | both | Text generation through the model in the `GEN_MODEL` var (default `@cf/meta/llama-3.1-8b-instruct`). Same auth, quota and rate limit as `/v1/ask`. Body `{prompt, system?, maxTokens?, temperature?}` → `{text, model, ms, usage?: {in, out}}`. |
| `GET /v1/me` | hosted | Bearer token. `{plan, quota, used, resetsAt, label?, active: true}` for the caller — what the Settings pane shows. Rate-limited, not billed. |
| `GET /v1/packs` | hosted | Bearer token. `{packs: [...]}` — the pack index filtered to what the caller's plan may install. Rate-limited, not billed. |
| `GET /healthz` | both | `{mode}` |
| `POST /admin/tokens` | hosted | Bearer `ADMIN_SECRET`. Body `{token?, plan, quota, resetDay?, label?}`. Mints a random 32-byte base64url token (or upserts the given one). Returns `{token, hash, plan, quota}` — the only response that ever contains the plaintext token. |
| `GET /admin/tokens/<hash>` | hosted | The record plus `{used, period, resetsAt}` for the current period. |
| `DELETE /admin/tokens/<hash>` | hosted | Deactivates (the record is kept). |
| `PUT /admin/packs` | hosted | Bearer `ADMIN_SECRET`. Body = the whole pack index `{packs: [...]}`; replaces it. `GET /admin/packs` reads it back unfiltered. |
| `POST /webhooks/billing` | hosted | `X-Signature: <hex HMAC-SHA256 of the raw body, key BILLING_WEBHOOK_SECRET>`. Body `{event: "subscription.activated" \| "subscription.cancelled", token_hash, plan, quota, resetDay?, label?}`. Provider-agnostic; Paddle/LemonSqueezy adapters map onto it later. |

Anything else is 404; a known route with the wrong method is 405. No CORS:
the callers are the app and the CLI.

Vars: `MODE` (`dev` | `hosted`) and `GEN_MODEL` (any Workers AI text model
that answers `{response}`), both set per environment in `wrangler.toml`.

### Validation (both modes)

Every body is at most 64 KB of JSON; anything off-shape is `400 {error}`.

`/v1/ask` admits exactly two shapes, told apart by the state; the questions
must then belong to that shape, so a mix of the two is refused. All character
limits count code points. This is what keeps the worker from being a general
Jev relay.

- **Card** (`core/src/questions.ts` `buildRequest`): `state` is
  `{clipboard}`, a string of at most 2000 characters; `questions` contains
  only `kind|layout|palette|emphasis` (`type: "choice"`), `scale|tone`
  (`type: "score"`), `animate` (`type: "noul"`), and `emphasis.criteria` has
  at most 201 entries (200 words plus `none`).
- **Smart pick** (`core/src/pick/question.ts` `buildPickRequest`): `state` is
  `{app ≤ 128, role? ≤ 64, label? ≤ 200, before? ≤ 200, after? ≤ 200,
  candidates}` where `candidates` is at most 9 of `{i: integer ≥ 0,
  summary ≤ 120}`; `questions` is exactly `pick` (`type: "choice"`, at most
  10 criteria — the candidates plus `none`) and `paste` (`type: "noul"`).

Extra keys anywhere are refused. Error bodies name the offending key and
the limit, never the text; candidate summaries and caret context are user
content and are treated like the clipboard.

`/v1/generate` takes `prompt` (non-empty, at most 8000 code points),
optional `system` (at most 2000), `maxTokens` (integer 1–2048, default 512)
and `temperature` (0–1; the model's default when omitted). Upstream it is
`AI.run(GEN_MODEL, {messages: [system?, user], max_tokens, temperature?})`;
the model's `response` string comes back as `text`, and its `usage`
(`prompt_tokens`/`completion_tokens`) as `usage: {in, out}` when present.

### Packs

`GET /v1/packs` returns entries of the form

```
{id, name, version, kind: "actions" | "styles", minApp, bytes, sha256, url, requiresPlan?}
```

The app downloads the zip at `url` (wherever it is hosted — R2 later; the
proxy never serves pack bytes), checks it against `sha256`, and unpacks it
into `App Support/packs/<id>/`. `requiresPlan` lists the plans that may
install the pack (`["pro", "team"]`); absent means every plan. Plans are
plain strings, compared exactly against the caller's record.

`PUT /admin/packs` validates every entry: `id` is 1–64 of `[a-z0-9-]` and
unique, `kind` is `actions` or `styles`, `bytes` a non-negative integer,
`sha256` 64 hex characters (stored lowercase), `url` https, `requiresPlan`
a non-empty array of plan names when present; unknown keys are rejected.
At most 200 packs.

### Quota accounting

An ask and a generate call each count as one call against the same
per-period quota. Every authenticated `/v1/*` request, including `/v1/me`
and `/v1/packs`, counts against the 60/min rate limit. Pricing may weight
them differently later (a generate call is far more expensive upstream);
the counter would then move from calls to units, but the records and routes
stay the same.

## KV records (`SUBS` namespace, hosted only)

```
tok:<sha256hex(token)>       {"plan":"solo","quota":1000,"resetDay":1,"active":true,"label":"…","createdAt":…,"updatedAt":…}
use:<tokenhash>:<YYYY-MM>    "17"        calls in that billing period (UTC); expires after 70 days
rl:<tokenhash>:<unixMinute>  "3"         calls in that minute; expires after 120 s
packs:index                  {"packs":[…],"updatedAt":…}   written by PUT /admin/packs
```

Tokens are stored only as SHA-256 hashes. A billing period starts on
`resetDay` (1–28, UTC; default 1 = calendar month) and is keyed by the
year-month it starts in. KV counters are eventually consistent, so a
subscriber can get a few calls past a limit; billing never depends on them.

## Run the dev proxy

```sh
cd proxy
bun install
bunx wrangler dev --port 8787        # AI binding is remote; wrangler's own login
```

Then `PASTE_PROVIDER=proxy` (the default) in core points at `http://localhost:8787/`.

Tests and typecheck, no network or bindings needed:

```sh
bun test proxy/test
bunx tsc --noEmit -p proxy/tsconfig.json
```

## Deploy hosted

Run by the account owner; nothing here is done automatically.

```sh
cd proxy
bunx wrangler kv namespace create SUBS --env hosted      # paste the id into wrangler.toml [[env.hosted.kv_namespaces]]
bunx wrangler secret put ADMIN_SECRET --env hosted
bunx wrangler secret put BILLING_WEBHOOK_SECRET --env hosted
bunx wrangler deploy --env hosted                        # then route api.peesuto.com to it
```

Mint a subscriber:

```sh
curl -X POST https://api.peesuto.com/admin/tokens \
  -H "Authorization: Bearer $ADMIN_SECRET" -H "content-type: application/json" \
  -d '{"plan":"solo","quota":1000,"label":"alice"}'
```

To rehearse hosted mode locally, `bunx wrangler dev --env hosted` uses a
simulated KV (the placeholder id is fine) and reads secrets from
`proxy/.dev.vars`:

```
ADMIN_SECRET=dev-admin
BILLING_WEBHOOK_SECRET=dev-hook
```

## Privacy

Clipboard text, pick context (candidate summaries, the text around the
caret) and generation prompts pass through to the model and are never
stored or logged. Each request writes one log line — method, path,
status, milliseconds, and the first eight characters of the token hash — and
nothing else. Tokens exist in plaintext only in the admin response that mints
them and on the subscriber's machine.
