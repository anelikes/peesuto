# pocket-paste

Copy text anywhere, get a card back: a PNG or a short GIF.

Jev (TypeSafe AI, via Cloudflare Workers AI) answers typed questions about
the text — what kind it is, which layout, palette, size, tone, which word to
emphasise, whether motion would reveal an order. Every answer is a choice from
a fixed set. Pocket Motion renders the card from those choices; line breaks
and sizes are measured, never guessed.

## Run

```bash
# once: a local proxy to Workers AI, using wrangler's own login
cd jev-proxy && npx wrangler dev --port 8787

# then, from the project root
bun run.ts "本季度活跃用户增长了 37%，是过去三年最快的一次。" --aspect doc
pbpaste | bun run.ts --stdin --aspect chat
```

Needs a checkout of pocketjs-motion at `../pocketjs-motion` (with `bun run
vendor` and `bun scripts/assets.ts` done). Rendering happens in a symlink tree
under `.work/`; the engine checkout is never written to.

`paste/gen.ts` is the whole DSL → composition step: every field except `text`
is something Jev can return. `probe.ts` asks the questions for six sample
texts and prints what came back.
