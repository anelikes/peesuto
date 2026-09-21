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

Text is measured against a cached metrics-only bake of `paste/charset.txt`
(ASCII, CJK punctuation, GB2312 level 1), so a paste costs one composition
build, not two; a character outside the charset falls back to a per-paste
measurement build. Emoji are pictures: `paste/emoji.ts` splits them out of
the text, fetches each one's 128 px PNG from Noto Emoji at a pinned tag into
`.work/emoji/`, stages it beside the composition and draws it inline at the
font size, measured as one advance when wrapping.

Output is transparent where the card declares no ground once the engine
checkout carries patch 0014; the palettes here all declare one.
