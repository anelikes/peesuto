# Studio

A local page for reviewing and iterating on the card templates. It decides a text the way the app does (`decideTemplate` in `core/src/templates/decide.ts`) and renders every style of the chosen template, every other candidate template in all its styles, each motion as a GIF, and one MP4.

## Run

```bash
bun run studio                      # = bun scripts/studio.ts
bun scripts/studio.ts [--port 4455] [--engine <prepared engine>] [--ffmpeg <path>] [--fresh-engine] [--no-open]
```

- The server listens on `127.0.0.1` only (default port 4455) and opens the browser.
- The engine (default `.work/native-engine`, a prepared pocket-motion checkout at the `engine.json` sha) is copied once into `.work/studio/.engine`, because its build tools write caches. The copy is reused until the source path or its git HEAD changes; `--fresh-engine` copies it again.
- MP4 uses the native `PeesutoEncoder` when it is built (`swift build --package-path native -c release`), else ffmpeg (on `PATH` or `--ffmpeg`). With neither the MP4 option is disabled.
- The "Jev (Cloudflare)" decider is enabled when `PASTE_CF_TOKEN` and `PASTE_CF_ACCOUNT_ID` are set (Bun loads the repo's `.env`). Jev answers are cached in `.work/studio/answers`.

## What it shows

- **Sidebar**: 全部场景总览, 自定义文字 (paste any text; ⌘↩ renders it), and the scenarios from `scripts/studio/scenarios.ts`, grouped by `group`. To add a scenario, add `{ id, title, text, group? }` there. The static gallery uses the same list.
- **Toolbar**: two frame controls, what to render (本模板各风格 PNG, 画幅对比, 其他可选模板, GIF 动效, MP4 视频), the decider (本地规则 or Jev), and 发给模型 (原文 / 敏感信息脱敏 / 仅发结构, default 敏感信息脱敏). All are remembered in `localStorage`.
  - **发给模型**: the model-content mode of [privacy-rules.md](privacy-rules.md), with the built-in rules at their defaults. With Jev, the decision is made with exactly that text (the mode is part of the cache key); with 本地规则 only the panel below changes.
  - **图片画幅** (PNG jobs): 自动 · 1:1 · 4:5 · 16:9 · 9:16, default 自动. 自动 picks the width by content (1080, wider for wide tables, code and diagrams) and lets the height hug the content, down to a template-specific minimum ratio.
  - **动图/视频画幅** (GIF and MP4 jobs): 1:1 (1080×1080) · 4:5 (1080×1350) · 16:9 (1920×1080) · 9:16 (1080×1920), default 1:1. The frame is strictly fixed; tall content scrolls. Changing it does not re-render the overview (PNG only).
  - **画幅对比** (off by default): the chosen template's classic style as PNG in every image frame (自动 and the four fixed ones), side by side, to see how one text behaves across frames.
- **Scenario view**: the source text; the decision (template and style, `decisionSource`, `plan.emphasis`, candidate templates, and the Jev error if it fell back); the 「模型收到的内容」 panel (what `privacy.preview` would answer: the model text with each replaced span highlighted and named by rule, in 原文 mode the spans that would have been replaced, whether the text counts as containing a secret for precompose, and the text that is rendered); then a grid of cards. The automatic PNG is outlined. With Jev, its style and emphasis carry over to the GIF and MP4.
- **Card**: label (template · style · motion · format · frame and the actual pixel size, e.g. 「文字 · 纸面 · PNG · 自动 1080×620」, with the Chinese names from `TEMPLATE_REGISTRY`), frames, 滚动 when tall content scrolls, render ms, file size, 缓存 when served from the cache, and links to open the file or show it in Finder. A render error (for example `ComposeError:unsupported-script`) is shown on its card. It does not stop the queue.
- **Overview**: the automatic PNG of every scenario, like a contact sheet. Click one to open it.

Templates, styles and motions are read from `TEMPLATE_REGISTRY` at run time, so a new template shows up without changes to the Studio.

## Rendering, cache and invalidation

- One sequential queue, because a single engine work tree cannot render concurrently. A scenario you open is moved to the front, and overview tiles go to the back. Progress reaches the page over SSE (`/api/events`), so cards fill in as they finish.
- Core runs in two worker subprocesses (`scripts/studio/worker.ts`), one for decisions and one for renders. A worker is restarted whenever the code version changes, so an edit is always rendered with the new code without restarting the server.
- **Code version** = sha256 of every `core/src/templates/*.ts`, every `core/src/render/*.ts`, every `core/src/privacy/*.ts` and `engine.json` (the first 12 hex digits are shown in the sidebar).
- **Cache**: `.work/studio/cache/<key>.{png,gif,mp4}` plus `<key>.json` (metadata). The key hashes text, the image frame (the decision is made in it), the animated frame (GIF/MP4 only), the frame the job renders in, template, style, motion, format, decider and the code version. After a token edit the version changes, so a reload renders again, and unchanged code is served from the cache.
- The server watches those files (`fs.watch`). On a change it marks queued jobs as stale and the page shows 「模板代码已改变，点击刷新」. Clicking it re-plans with the new code.
- 清空缓存重新渲染 deletes `.work/studio/cache` and renders the current view again. Jev answers are kept.

API (for scripts): `GET /api/state`, `POST /api/plan {scenario | text, imageFrame, motionFrame, decider, modelContent, formats: {png, frames, others, gif, mp4}}`, `POST /api/overview {imageFrame, motionFrame, decider, modelContent}`, `POST /api/privacy {scenario | text, mode}`, `GET /api/events`, `POST /api/clear`, `POST /api/reveal {key}`, `GET /files/<key>.<ext>`.

## Where the style tokens live

All in `core/src/templates/compose.ts`. Run `grep -n "_STYLES\|TEMPLATE_SCROLL\|TEMPLATE_LIMITS" core/src/templates/compose.ts` to find them:

| Table | What it controls |
|---|---|
| `TEXT_STYLES` | The text template's styles `classic` (纸面 Paper), `editorial` (墨色 Ink), `poster` (海报 Poster): background, ink, accent (and whether it is bold), weight, alignment, margin, min/max type size, leading, rule. Sizes are clamped to the measurer's baked sizes (`SIZES`). |
| `DIAGRAM_STYLES` | The diagram template's styles (added alongside the diagram template). |
| `TEMPLATE_SCROLL` | When tall GIF/MP4 content scrolls (`threshold` × canvas height) and how fast: `pxPerS`, start/end holds, min/max duration. |
| `TEMPLATE_LIMITS` | Maximum height, grapheme limit, fps, typewriter duration cap, final hold. |

Every template reads its colours, sizes and spacing from a table in `core/src/templates/compose.ts`: `TEXT_STYLES`, `DOCUMENT_STYLES`, `QUOTE_STYLES`, `CODE_STYLES`, `STAT_STYLES`, `LIST_STYLES`, `CHAT_STYLES`, `TABLE_STYLES`, `COMPARISON_STYLES`, `DIAGRAM_STYLES` (+ `DIAGRAM_TIERS`), `QR_STYLES`, plus `TEMPLATE_GROW` (type steps tried when content would leave a fixed frame half empty), `AUTO_FRAME` and `TEMPLATE_SCROLL`. A redesign edits numbers there; font sizes must be members of `SIZES`.

## Static export

```bash
bun scripts/gallery.ts [--engine <prepared engine>] [--out .work/gallery] [--only short,chat] [--no-video] [--ffmpeg <path>] [--image-frame auto|1:1|4:5|16:9|9:16] [--motion-frame 1:1|4:5|16:9|9:16]
```

This renders the same scenarios and jobs through the Studio's pipeline (`scripts/studio/pipeline.ts`), using the local rules decider, image frame 自动 and animated frame 1:1 unless the flags say otherwise, into a self-contained `<out>/index.html`. A scenario that a privacy rule matches (the 隐私 group) also shows the redacted text a model would receive.
