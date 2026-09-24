# Website (peesuto.com)

A static site in `site/`, deployed to Cloudflare Pages (project `peesuto`).
Plain HTML and CSS with one small script; no framework, no trackers, no
requests to other domains at runtime.

| Path | Source |
|---|---|
| `/`, `/zh/`, `/ja/` | `scripts/site.ts` (all copy for English, Chinese and Japanese lives there) |
| `/templates/`, `/zh/templates/`, `/ja/templates/` | `scripts/site.ts`: every template, grouped by use (`GROUPS` in `scripts/site-templates.ts`) |
| `/templates/<id>/` (and `/zh/…`, `/ja/…`) | `scripts/site.ts`: one page per registered template (sample and copy button, styles, 1:1 and 16:9, animation, how it is recognised) |
| `/changelog/` | generated from `CHANGELOG.md` by `scripts/site.ts`; "Unreleased" is labelled "Not in a release yet" (English only) |
| `/privacy/`, `/zh/privacy/`, `/ja/privacy/` | `scripts/site.ts` (the English text is authoritative, the others say so) |
| `/404.html`, `robots.txt`, `sitemap.xml` | `scripts/site.ts` |
| `/assets/site.css`, `/assets/site.js` | hand-written (`site.js`: hero video or loop, tabs, card videos, Copy sample) |
| `/_headers` | hand-written: security headers, CSP (self only), caching, `application/xml` for the feeds |
| `/gallery/<lang>/*` | rendered by `scripts/site-gallery.ts` with the real engine from the samples in `scripts/site-templates.ts`; `manifest.json` holds each file's render key and size |
| `/assets/peesuto-promo.{mp4,webp}` | the promo film for the hero, `scripts/site-assets.ts --only hero --promo <mp4>` |
| `/assets/field-indigo.*`, `grain.png` | the code cards' "Indigo night" field (`core/src/templates/backdrop.ts`) |
| `/assets/fonts/*.woff2` | Latin + keyboard-symbol subset of `core/src/render/fonts/PeesutoText-*.ttf` (SIL OFL, `OFL.txt` beside them) |
| `/og.png` | `scripts/site/og.html` rendered by Chrome |
| `/appcast.xml` | **written by `scripts/appcast.ts` at release time; never edit or delete it by hand** |

## Commands

```bash
bun run site:build      # regenerate the HTML pages; Bun only, no network, no engine
bun scripts/site-gallery.ts   # render the template gallery (engine + cwebp + ffmpeg); cached
bun run site:assets     # regenerate other binary assets (macOS: sips, iconutil; cwebp, pyftsubset + brotli, Chrome)
bun run site:deploy     # build, then wrangler pages deploy site --project-name peesuto --branch main
```

Asset URLs carry a content hash (`?v=`), so a deploy is picked up at once;
`/assets/*` and `/gallery/*` are cached for a day.

Preview locally with any static server rooted at `site/`, for example
`python3 -m http.server -d site 8765` (localhost counts as a secure context,
so the Copy sample button works there).

## Template gallery

`scripts/site-templates.ts` holds everything written about templates: the
groups (Writing, Developers, Data, Personal; an id in none of them lands in
"Other"), Japanese names, a one-line blurb, "How Peesuto recognises it" (plain
words after `docs/templates.md`), and one sample per template and language.
The list of templates always comes from `core/src/templates/registry.ts`.

`bun scripts/site-gallery.ts` first checks that the local rules pick each
sample as its own template (QR: that it is available; `--check` stops there),
then renders, per language: every style at 1:1 (`<id>-<style>.webp`, 640 px),
the first style at 16:9 (`<id>-<style>-wide.webp`, 960 px) and the first style
animated (`<id>.mp4`, 640 px, H.264, no audio). It copies `.work/native-engine`
(or `--engine`) to a scratch directory, since engine builds write caches. A file
is rendered again only when its input (sample, template, style, frame) or the
renderer (`core/src/templates/**`, the render fonts, `engine.json`) changed;
`--reuse` ignores renderer changes, `--force` redoes everything, `--only
code,diff` and `--lang en` narrow a run. A full run is about 220 files and five
minutes; the output is about 4 MB.

A **new template** appears on the site once it has a sample in
`scripts/site-templates.ts` and renders: add the sample (and ideally blurb,
how, Japanese names and a group), run the gallery script, then `site:build`.
Until then `site:build` warns and leaves it out, so a deploy never breaks.
After a template's look changes, rerun the gallery script (the renderer hash
changes, so everything is redrawn) and `site:build`.

The home page uses the same renders: the strip under the hero (`HOME_STRIP`),
the compact gallery (`HOME_PICKS`, linking to `/templates/`), the "It reads
what you copied" panels and the hero loop (English samples, whose text matches
those panels). `scripts/template-previews.ts` still renders the 320 px previews
for the app's Settings; the site no longer uses them.

## The hero loop

The hero's fallback is a quiet HTML/CSS loop (copy, ⌥V, the "Paste as…" chooser,
Return, the card lands), driven by `site/assets/site.js`. It pauses when out of
view, has a Pause button, and shows one still frame (chooser open) when the
visitor prefers reduced motion. The chooser mirrors
`native/Sources/Peesuto/ChooserWindow.swift`; update both together.

The promo film sits in front of it: `HERO_VIDEO` in `scripts/site.ts` names
`site/assets/<name>.mp4` and its poster `<name>.webp`. `site.js` shows the video
instead of the loop when the browser can play H.264, starts it muted and looping
only when the visitor has no reduced-motion preference (otherwise the poster
waits, with controls), and brings the loop back if the video fails to load.
Without JavaScript the loop's still frame shows. To replace the film:
`bun scripts/site-assets.ts --only hero --promo path/to/film.mp4` (1080p60 H.264,
CRF 22 capped at 2.6 Mbit/s, AAC 96k, faststart; the current 42 s cut is 6 MB),
then `site:build`. `HERO_VIDEO = null` returns to the loop alone.

## Custom domain

Attach `peesuto.com` and `www.peesuto.com` in the Cloudflare dashboard:
Workers & Pages › peesuto › Custom domains › Set up a custom domain. With the
zone on the same Cloudflare account the DNS records are created for you.
The `*.pages.dev` hostname answers with `X-Robots-Tag: noindex`.
