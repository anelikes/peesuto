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
| `GET /healthz` | both | `{mode}` |
| `POST /admin/tokens` | hosted | Bearer `ADMIN_SECRET`. Body `{token?, plan, quota, resetDay?, label?}`. Mints a random 32-byte base64url token (or upserts the given one). Returns `{token, hash, plan, quota}` — the only response that ever contains the plaintext token. |
| `GET /admin/tokens/<hash>` | hosted | The record plus `{used, period, resetsAt}` for the current period. |
| `DELETE /admin/tokens/<hash>` | hosted | Deactivates (the record is kept). |
| `POST /webhooks/billing` | hosted | `X-Signature: <hex HMAC-SHA256 of the raw body, key BILLING_WEBHOOK_SECRET>`. Body `{event: "subscription.activated" \| "subscription.cancelled", token_hash, plan, quota, resetDay?, label?}`. Provider-agnostic; Paddle/LemonSqueezy adapters map onto it later. |

Anything else is 404; a known route with the wrong method is 405. No CORS:
the callers are the app and the CLI.

Vars: `MODE` (`dev` | `hosted`) and `GEN_MODEL` (any Workers AI text model
that answers `{response}`), both set per environment in `wrangler.toml`.

### Validation (both modes)

Every body is at most 64 KB of JSON; anything off-shape is `400 {error}`.

`/v1/ask` must be shaped exactly like `core/src/questions.ts` `buildRequest`
produces: `state.clipboard` is a string of at most 2000 characters (code
points), `questions` contains only `kind|layout|palette|emphasis`
(`type: "choice"`), `scale|tone` (`type: "score"`), `animate`
(`type: "noul"`), and `emphasis.criteria` has at most 201 entries (200 words
plus `none`). This is what keeps the worker from being a general Jev relay.

`/v1/generate` takes `prompt` (non-empty, at most 8000 code points),
optional `system` (at most 2000), `maxTokens` (integer 1–2048, default 512)
and `temperature` (0–1; the model's default when omitted). Upstream it is
`AI.run(GEN_MODEL, {messages: [system?, user], max_tokens, temperature?})`;
the model's `response` string comes back as `text`, and its `usage`
(`prompt_tokens`/`completion_tokens`) as `usage: {in, out}` when present.

### Quota accounting

An ask and a generate call each count as one call against the same
per-period quota, and both share the 60/min rate limit. Pricing may weight
them differently later (a generate call is far more expensive upstream);
the counter would then move from calls to units, but the records and routes
stay the same.

## KV records (`SUBS` namespace, hosted only)

```
tok:<sha256hex(token)>       {"plan":"solo","quota":1000,"resetDay":1,"active":true,"label":"…","createdAt":…,"updatedAt":…}
use:<tokenhash>:<YYYY-MM>    "17"        calls in that billing period (UTC); expires after 70 days
rl:<tokenhash>:<unixMinute>  "3"         calls in that minute; expires after 120 s
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
bunx wrangler deploy --env hosted                        # then route jev.pocketpaste.dev to it
```

Mint a subscriber:

```sh
curl -X POST https://jev.pocketpaste.dev/admin/tokens \
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

Clipboard text and generation prompts pass through to the model and are
never stored or logged. Each request writes one log line — method, path,
status, milliseconds, and the first eight characters of the token hash — and
nothing else. Tokens exist in plaintext only in the admin response that mints
them and on the subscriber's machine.
