# Subscription (design)

> **On hold (2026-09-24).** Peesuto ships open source (MIT) with local
> and bring-your-own-key providers only. The hosted service below is kept in
> the code but will not launch until there is demand; see PLAN.md §5.

This is the intended product flow, not a description of a shipped native
subscription UI. Hosted proxy routes and Core pack loading exist; the native
account/pack installer, real billing deployment and grace-period enforcement
remain unfinished. The retired desktop implementation is no longer an entry point.

## What it buys

- Hosted model calls: a decider (Jev) and a generator behind
  `proxy/` in hosted mode, no keys to create, metered per month.
- Official packs: style packs for the card and action packs, installed into
  App Support by the app when the subscription is active.

Everything else is identical to the open-source build; the app is the same
binary.

## Flow

1. Purchase through a merchant of record (Paddle or Lemon Squeezy); the
   webhook (`POST /webhooks/billing`) activates a subscriber token record in
   the proxy's KV (`proxy/README.md`).
2. The customer receives a license key by email: the plaintext subscriber
   token, shown once.
3. In Settings → Subscription the user pastes the key. The app stores it in
   the Keychain and sets the decider and generator to `hosted` with that
   token. `GET /v1/me` (to add) returns plan, quota, used, resetsAt for the
   Settings pane.
4. Every hosted call carries the token as a bearer; the proxy answers 402
   when the month's quota is spent and 401 when the subscription is
   cancelled. The app maps those to messages and offers the BYO-key path.
5. Grace: a cancelled subscription keeps installed packs readable for 7
   days, then the app hides them (they stay on disk; the formats are open).

## Packs

A pack is a directory: `pack.json` (`id`, `name`, `version`, `kind:
"actions" | "styles"`, `minApp`) plus `actions/*.json` or a catalog fragment
(`catalog.json`, merged by `mergeCatalog`; today it carries `palettes`, each
with a one-sentence `description` the decider reads and five `#rrggbb`
`colors`: bg, bg2, ink, muted, accent). `docs/packs/example-neon/` is a
complete styles pack: copy it into `App Support/packs/` and the two
palettes appear in the decider's choices and in the card. Later packs win
by name, so a pack may also restyle a base palette. The app fetches the pack index
from the hosted proxy (`GET /v1/packs`, to add), downloads a zip, verifies
its SHA-256 from the index, and unpacks into `App Support/packs/<id>/`.
Anyone can put a pack there by hand.
