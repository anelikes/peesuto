# Studio

A local page for reviewing and iterating on the card templates. It decides a text the way the app does (`decideTemplate` in `core/src/templates/decide.ts`) and renders every style of the chosen template, every other candidate template in all its styles, each motion as a GIF, and one MP4.

## Run

```bash
bun run studio                      # = bun scripts/studio.ts
bun scripts/studio.ts [--port 4455] [--engine <prepared engine>] [--ffmpeg <path>] [--fresh-engine] [--no-open]
```

- The server listens on `127.0.0.1` only (default port 4455) and opens the browser.
- The engine (default `.work/native-engine`, a prepared pocket-motion checkout at the `engine.json` sha) is copied once into `.work/studio/.engine`, because its build tools write caches. The copy is reused until the source path or its git HEAD changes; `--fresh-engine` copies it again.
- MP4 needs ffmpeg (on `PATH` or `--ffmpeg`). Without it the MP4 option is disabled.
- The "Jev (Cloudflare)" decider is enabled when `PASTE_CF_TOKEN` and `PASTE_CF_ACCOUNT_ID` are set (Bun loads the repo's `.env`). Jev answers are cached in `.work/studio/answers`.

## What it shows

- **Sidebar**: 全部场景总览, 自定义文字 (paste any text; ⌘↩ renders it), and the scenarios from `scripts/studio/scenarios.ts`, grouped by `group`. To add a scenario, add `{ id, title, text, group? }` there. The static gallery uses the same list.
- **Toolbar**: aspect (聊天 1080×1080 / 文档 1920×1080 / 竖屏 1080×1920), what to render (本模板各风格 PNG, 其他可选模板, GIF 动效, MP4 视频), and the decider (本地规则 or Jev).
- **Scenario view**: the source text; the decision (template and style, `decisionSource`, `plan.emphasis`, candidate templates, and the Jev error if it fell back); then a grid of cards. The automatic PNG is outlined. With Jev, its style and emphasis carry over to the GIF and MP4.
- **Card**: label (template · style · motion · format, with the Chinese names from `TEMPLATE_REGISTRY`), size, frames, 滚动 when tall content scrolls, render ms, file size, 缓存 when served from the cache, and links to open the file or show it in Finder. A render error (for example `ComposeError:unsupported-script`) is shown on its card. It does not stop the queue.
- **Overview**: the automatic PNG of every scenario, like a contact sheet. Click one to open it.

Templates, styles and motions are read from `TEMPLATE_REGISTRY` at run time, so a new template shows up without changes to the Studio.

## Rendering, cache and invalidation

- One sequential queue, because a single engine work tree cannot render concurrently. A scenario you open is moved to the front, and overview tiles go to the back. Progress reaches the page over SSE (`/api/events`), so cards fill in as they finish.
- Core runs in two worker subprocesses (`scripts/studio/worker.ts`), one for decisions and one for renders. A worker is restarted whenever the code version changes, so an edit is always rendered with the new code without restarting the server.
- **Code version** = sha256 of every `core/src/templates/*.ts`, every `core/src/render/*.ts` and `engine.json` (the first 12 hex digits are shown in the sidebar).
- **Cache**: `.work/studio/cache/<key>.{png,gif,mp4}` plus `<key>.json` (metadata). The key hashes text, aspect, template, style, motion, format, decider and the code version. After a token edit the version changes, so a reload renders again, and unchanged code is served from the cache.
- The server watches those files (`fs.watch`). On a change it marks queued jobs as stale and the page shows 「模板代码已改变，点击刷新」. Clicking it re-plans with the new code.
- 清空缓存重新渲染 deletes `.work/studio/cache` and renders the current view again. Jev answers are kept.

API (for scripts): `GET /api/state`, `POST /api/plan {scenario | text, aspect, decider, formats}`, `POST /api/overview {aspect, decider}`, `GET /api/events`, `POST /api/clear`, `POST /api/reveal {key}`, `GET /files/<key>.<ext>`.

## Where the style tokens live

All in `core/src/templates/compose.ts`. Run `grep -n "_STYLES\|TEMPLATE_SCROLL\|TEMPLATE_LIMITS" core/src/templates/compose.ts` to find them:

| Table | What it controls |
|---|---|
| `TEXT_STYLES` | The text template's styles `classic` (纸面 Paper), `editorial` (墨色 Ink), `poster` (海报 Poster): background, ink, accent (and whether it is bold), weight, alignment, margin, min/max type size, leading, rule. Sizes are clamped to the measurer's baked sizes (`SIZES`). |
| `DIAGRAM_STYLES` | The diagram template's styles (added alongside the diagram template). |
| `TEMPLATE_SCROLL` | When tall GIF/MP4 content scrolls (`threshold` × canvas height) and how fast: `pxPerS`, start/end holds, min/max duration. |
| `TEMPLATE_LIMITS` | Maximum height, grapheme limit, fps, typewriter duration cap, final hold. |

The other templates (document, quote, code, stat, list, chat, table, comparison) still set colors and sizes inline in `layoutTemplate` (one `case` per template, `editorial ? … : …`). Moving them into `*_STYLES` tables would let a redesign edit only tokens.

## Static export

```bash
bun scripts/gallery.ts [--engine <prepared engine>] [--out .work/gallery] [--only short,chat] [--no-video] [--ffmpeg <path>]
```

This renders the same scenarios and jobs through the Studio's pipeline (`scripts/studio/pipeline.ts`), using the local rules decider and the chat aspect, into a self-contained `<out>/index.html`.
