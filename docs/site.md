# Website (peesuto.com)

A static site in `site/`, deployed to Cloudflare Pages (project `peesuto`).
Plain HTML and CSS with one small script; no framework, no trackers, no
requests to other domains at runtime.

| Path | Source |
|---|---|
| `/`, `/zh/`, `/ja/` | `scripts/site.ts` (all copy for English, Chinese and Japanese lives there) |
| `/changelog/` | generated from `CHANGELOG.md` by `scripts/site.ts`; "Unreleased" is labelled "Not in a release yet" |
| `/privacy/` | `scripts/site.ts` (English only) |
| `/404.html`, `robots.txt`, `sitemap.xml` | `scripts/site.ts` |
| `/assets/site.css`, `/assets/site.js` | hand-written |
| `/_headers` | hand-written: security headers, CSP (self only), caching, `application/xml` for the feeds |
| `/cards/*.webp` | `native/Resources/TemplatePreviews/*.png` via `scripts/site-assets.ts` |
| `/assets/field-indigo.*`, `grain.png` | the code cards' "Indigo night" field (`core/src/templates/backdrop.ts`) |
| `/assets/fonts/*.woff2` | Latin + keyboard-symbol subset of `core/src/render/fonts/PeesutoText-*.ttf` (SIL OFL, `OFL.txt` beside them) |
| `/og.png` | `scripts/site/og.html` rendered by Chrome |
| `/appcast.xml` | **written by `scripts/appcast.ts` at release time; never edit or delete it by hand** |

## Commands

```bash
bun run site:build      # regenerate the HTML pages; Bun only, no network
bun run site:assets     # regenerate binary assets (macOS: sips, iconutil; cwebp, pyftsubset + brotli, Chrome)
bun run site:deploy     # build, then wrangler pages deploy site --project-name peesuto --branch main
```

Run `site:assets --only cards` after `bun scripts/template-previews.ts`
changes the previews, then `site:build` (the build refuses to run when a
registered template style has no card). Asset URLs for the CSS and script
carry a content hash, so a deploy is picked up at once; `/assets/*` and
`/cards/*` are cached for a day.

Preview locally with any static server rooted at `site/`, for example
`python3 -m http.server -d site 8765`.

## The hero loop

The hero plays a quiet HTML/CSS loop (copy, ⌥V, the "Paste as…" chooser,
Return, the card lands), driven by `site/assets/site.js`. It pauses when out of
view, has a Pause button, and shows one still frame (chooser open) when the
visitor prefers reduced motion. The chooser mirrors
`native/Sources/Peesuto/ChooserWindow.swift`; update both together.

To replace it with the promo video, put `site/assets/<name>.mp4` and a poster
`site/assets/<name>.webp` in place and set `HERO_VIDEO = "<name>"` in
`scripts/site.ts`; the figure then renders a muted, looping `<video>`.

## Custom domain

Attach `peesuto.com` and `www.peesuto.com` in the Cloudflare dashboard:
Workers & Pages › peesuto › Custom domains › Set up a custom domain. With the
zone on the same Cloudflare account the DNS records are created for you.
The `*.pages.dev` hostname answers with `X-Robots-Tag: noindex`.
