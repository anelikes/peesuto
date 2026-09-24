#!/usr/bin/env bun
/**
 * Builds the static website in site/ (peesuto.com): the English and Chinese
 * home pages, the changelog (generated from CHANGELOG.md), the privacy policy,
 * the 404 page, sitemap.xml and robots.txt. No network and no tools beyond Bun;
 * binary assets (cards, icons, fonts, the backdrop, og.png) come from
 * `bun scripts/site-assets.ts` and are committed.
 *
 *   bun scripts/site.ts            (bun run site:build)
 *
 * Hand-written and left alone: site/assets/site.css, site/assets/site.js,
 * site/_headers. Never touched: site/appcast.xml (scripts/appcast.ts writes it).
 * See docs/site.md.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { TEMPLATE_REGISTRY } from "../core/src/templates/registry.ts";

const REPO = resolve(import.meta.dir, "..");
const SITE = join(REPO, "site");
const ORIGIN = "https://peesuto.com";
const GITHUB = "https://github.com/anelikes/peesuto";
/** Every release also carries the DMG as Peesuto.dmg, so this always downloads the newest one. */
const DOWNLOAD = `${GITHUB}/releases/latest/download/Peesuto.dmg`;
/**
 * The hero plays an HTML/CSS loop. When the promo video exists, put it at
 * site/assets/<name>.mp4 (and a poster .webp beside it) and set this to the
 * name: the figure then shows a muted, looping <video> instead of the loop.
 */
const HERO_VIDEO: string | null = null;

type Lang = "en" | "zh" | "ja";
const LANGS: readonly { lang: Lang; path: string; hreflang: string; label: string; locale: string }[] = [
  { lang: "en", path: "/", hreflang: "en", label: "English", locale: "en_US" },
  { lang: "zh", path: "/zh/", hreflang: "zh-Hans", label: "中文", locale: "zh_CN" },
  { lang: "ja", path: "/ja/", hreflang: "ja", label: "日本語", locale: "ja_JP" },
];
const L = (lang: Lang) => LANGS.find((l) => l.lang === lang)!;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hash = (file: string) => createHash("sha256").update(readFileSync(join(SITE, file))).digest("hex").slice(0, 10);
const asset = (file: string) => `/${file}?v=${hash(file)}`;
const card = (name: string) => `/cards/${name}.webp`;
const T = (lang: Lang, en: string, zh: string, ja: string) => (lang === "en" ? en : lang === "zh" ? zh : ja);

const templates = TEMPLATE_REGISTRY;
const styleCount = templates.reduce((n, t) => n + t.variants.length, 0);
/** Japanese template and style names (the registry carries English and Chinese only). */
const JA_NAMES: Record<string, string> = {
  text: "テキスト", "text-classic": "ペーパー", "text-editorial": "インク", "text-poster": "ポスター",
  document: "ドキュメント", "document-classic": "読みもの", "document-editorial": "コラム",
  quote: "引用", "quote-classic": "本の抜き書き", "quote-editorial": "ステートメント",
  code: "コード", "code-classic": "ターミナル", "code-editorial": "コードノート",
  stat: "数字", "stat-classic": "大きな数字", "stat-editorial": "指標バー",
  list: "リスト", "list-classic": "チェックリスト", "list-editorial": "ステップ",
  chat: "会話", "chat-classic": "吹き出し", "chat-editorial": "書き起こし",
  table: "表", "table-classic": "グリッド", "table-editorial": "罫線表",
  comparison: "比較", "comparison-classic": "左右に並べる", "comparison-editorial": "上下に分ける",
  diagram: "図", "diagram-classic": "フロー", "diagram-editorial": "ブループリント",
  info: "情報カード", "info-classic": "項目リスト", "info-editorial": "認証情報",
  changelog: "リリースノート", "changelog-classic": "リリースカード", "changelog-editorial": "タイムライン",
  qr: "QR コード", "qr-classic": "シンプル", "qr-editorial": "カード",
};
const templateName = (lang: Lang, id: string, variant: string) => {
  const t = templates.find((x) => x.id === id)!;
  const v = t.variants.find((x) => x.id === variant)!;
  if (lang === "ja") return [JA_NAMES[t.id]!, JA_NAMES[`${t.id}-${v.id}`]!] as const;
  return lang === "en" ? [t.name, v.name] as const : [t.nameZh, v.nameZh] as const;
};

// ---------------------------------------------------------------- shared chrome

const ICONS = `<svg xmlns="http://www.w3.org/2000/svg" hidden aria-hidden="true">
<symbol id="i-image" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="5.5" cy="6" r="1.2" fill="currentColor"/><path d="M2 12l3.8-3.6 2.7 2.4 2.2-1.9L14 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></symbol>
<symbol id="i-gif" viewBox="0 0 16 16"><path d="M9 2.5 13.5 8 9 13.5 4.5 8Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5.5 3.5 1.8 8l3.7 4.5M3.6 3.5 0 8l3.6 4.5" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="1.4 1.4"/></symbol>
<symbol id="i-video" viewBox="0 0 16 16"><rect x="1.5" y="3" width="13" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.5 3v10M11.5 3v10M1.5 6h3M1.5 10h3M11.5 6h3M11.5 10h3" stroke="currentColor" stroke-width="1"/></symbol>
<symbol id="i-qr" viewBox="0 0 16 16"><path d="M2 2h4.5v4.5H2zM9.5 2H14v4.5H9.5zM2 9.5h4.5V14H2z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M9.5 9.5h2v2h-2zM12 12h2v2h-2zM12 9.5h2M9.5 13h1.5" fill="none" stroke="currentColor" stroke-width="1.1"/></symbol>
<symbol id="i-pin" viewBox="0 0 16 16"><path d="M5.5 1.8h5M6.5 2v4.2L4.3 9h7.4L9.5 6.2V2M8 9v5.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></symbol>
<symbol id="i-history" viewBox="0 0 16 16"><path d="M2.6 5.2A6 6 0 1 1 2 8" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2.2 2.2v3.2h3.2M8 4.8V8l2.2 1.6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></symbol>
<symbol id="i-plus" viewBox="0 0 14 14"><path d="M7 0v14M0 7h14" stroke="currentColor" stroke-width="1.5"/></symbol>
<symbol id="i-arrow" viewBox="0 0 48 14"><path d="M0 7h44M38 1l7 6-7 6" fill="none" stroke="currentColor" stroke-width="1.5"/></symbol>
</svg>`;

interface PageInfo {
  lang: Lang; path: string; title: string; description: string; current?: "home" | "changelog" | "privacy";
  alternates?: boolean; noindex?: boolean; body: string; script?: boolean;
}

function page(p: PageInfo): string {
  const url = ORIGIN + p.path;
  const alt = p.alternates
    ? `${LANGS.map((l) => `<link rel="alternate" hreflang="${l.hreflang}" href="${ORIGIN}${l.path}">\n`).join("")}<link rel="alternate" hreflang="x-default" href="${ORIGIN}/">\n`
    : "";
  return `<!doctype html>
<html lang="${L(p.lang).hreflang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.description)}">
${p.noindex ? '<meta name="robots" content="noindex">\n' : `<link rel="canonical" href="${url}">\n`}${alt}<meta name="theme-color" content="#F6F3EE" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#161412" media="(prefers-color-scheme: dark)">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/assets/icon-256.png" type="image/png" sizes="256x256">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Peesuto">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${ORIGIN}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Peesuto: Copy text. Paste a card.">
<meta property="og:locale" content="${L(p.lang).locale}">
<meta name="twitter:card" content="summary_large_image">
<link rel="preload" href="/assets/fonts/peesuto-mono-bold.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${asset("assets/site.css")}">
${p.script ? `<script src="${asset("assets/site.js")}" defer></script>\n` : ""}</head>
<body>
<a class="skip" href="#main">${T(p.lang, "Skip to content", "跳到正文", "本文へスキップ")}</a>
${ICONS}
${header(p.lang, p.current)}
<main id="main">
${p.body}
</main>
${footer(p.lang, p.current)}
</body>
</html>
`;
}

function header(lang: Lang, current?: string): string {
  const home = L(lang).path;
  const cur = (name: string) => (current === name ? ' aria-current="page"' : "");
  return `<header class="site-header">
<nav class="wrap" aria-label="${T(lang, "Main", "主导航", "メイン")}">
<a class="brand" href="${home}"${current === "home" ? ' aria-current="page"' : ""}><img src="/assets/icon-64.png" width="26" height="26" alt="">Peesuto</a>
<a class="nav-link hide-sm" href="${home}#templates">${T(lang, "Templates", "模板", "テンプレート")}</a>
<a class="nav-link hide-sm" href="${home}#privacy">${T(lang, "Privacy", "隐私", "プライバシー")}</a>
<a class="nav-link hide-sm" href="${home}#faq">${T(lang, "FAQ", "常见问题", "よくある質問")}</a>
<a class="nav-link hide-sm" href="/changelog/"${cur("changelog")}>${T(lang, "Changelog", "更新日志", "更新履歴")}</a>
<span class="langs">${LANGS.filter((l) => l.lang !== lang).map((l) => `<a class="nav-link" href="${l.path}" lang="${l.hreflang}" hreflang="${l.hreflang}">${l.label}</a>`).join("")}</span>
<a class="btn btn-primary btn-sm" href="${DOWNLOAD}">${T(lang, "Download", "下载", "ダウンロード")}</a>
</nav>
</header>`;
}

function footer(lang: Lang, current?: string): string {
  const cur = (name: string) => (current === name ? ' aria-current="page"' : "");
  return `<footer class="site-footer">
<div class="wrap">
<div class="who"><b>Peesuto</b><span>${T(lang, "A small clipboard app for the Mac.", "一款小巧的 Mac 剪贴板应用。", "Mac のための小さなクリップボードアプリ。")}</span></div>
<nav aria-label="${T(lang, "Footer", "页脚", "フッター")}">
<a href="${GITHUB}">GitHub</a>
<a href="/changelog/"${cur("changelog")}>${T(lang, "Changelog", "更新日志", "更新履歴")}</a>
<a href="/privacy/"${cur("privacy")}>${T(lang, "Privacy policy", "隐私政策", "プライバシーポリシー")}</a>
<a href="mailto:contact@peesuto.com">contact@peesuto.com</a>
${LANGS.map((l) => `<a href="${l.path}" lang="${l.hreflang}" hreflang="${l.hreflang}"${l.lang === lang && current === "home" ? ' aria-current="page"' : ""}>${l.label}</a>`).join("\n")}
</nav>
<small>© 2026 The Peesuto Authors · ${T(lang, "MIT License", "MIT 许可证", "MIT ライセンス")} · ${T(lang, "“Peesuto” and its logo are trademarks.", "“Peesuto”名称及标志为商标。", "「Peesuto」の名称とロゴは商標です。")}</small>
</div>
</footer>`;
}

// ---------------------------------------------------------------- home

interface Sample { file: string; text: string; card: string; ask: string; alt: string }

function chooser(lang: Lang, cardName: string, alt = ""): string {
  const row = (icon: string, label: string, key: string, cls = "") =>
    `<li${cls ? ` class="${cls}"` : ""}><svg aria-hidden="true"><use href="#i-${icon}"/></svg>${label}<kbd>${key}</kbd></li>`;
  return `<div class="chooser" aria-hidden="true">
<div class="ch-head">${T(lang, "Paste as…", "粘贴为…", "ペースト形式…")}<span>${T(lang, "Cancel", "取消", "キャンセル")} <kbd>esc</kbd></span></div>
<div class="ch-prev"><img data-card="thumb" src="${card(cardName)}" width="116" height="116" alt="${esc(alt)}"></div>
<ul class="ch-rows">
${row("image", T(lang, "Image", "图片", "画像"), "↩", "on")}
${row("gif", "GIF", "G")}
${row("video", T(lang, "Video", "视频", "動画"), "M")}
${row("qr", T(lang, "QR code", "二维码", "QR コード"), "Q")}
${row("pin", T(lang, "Pin to screen", "贴到屏幕", "画面にピン留め"), "P", "sep")}
${row("history", T(lang, "Clipboard history", "剪贴板历史", "クリップボード履歴"), "H")}
</ul>
</div>`;
}

function heroDemo(lang: Lang): string {
  const samples: Sample[] = [
    { file: "greet.swift", text: 'func greet(_ name: String) -> String {\n    "Hello, \\(name)!"\n}\n\nprint(greet("Peesuto"))', card: card("code-classic"),
      ask: T(lang, "Can you send the greeting helper?", "昨天那个问候函数发我看看？", "あいさつの関数、送ってもらえますか？"),
      alt: T(lang, "Code card: the Swift function, highlighted, in a dark window on an indigo field.", "代码卡片：高亮的 Swift 函数，深色窗口，靛蓝色背景。", "コードカード：ハイライトされた Swift の関数。藍色の背景に暗いウィンドウ。") },
    { file: T(lang, "Notes", "备忘录", "メモ"), text: "Make room for a clearer thought.", card: card("text-poster"),
      ask: T(lang, "Slide 3 still needs a title.", "第三页还缺个标题。", "3 枚目のスライド、まだタイトルがないです。"),
      alt: T(lang, "Poster card: “Make room for a clearer thought.” in large type on red.", "海报卡片：红底大字 “Make room for a clearer thought.”", "ポスターカード：赤地に大きな文字で「Make room for a clearer thought.」") },
    { file: "plans.md", text: "| Plan | Price | Seats |\n|---|---|---|\n| Solo | $0 | 1 |\n| Team | $12 | 10 |", card: card("table-classic"),
      ask: T(lang, "What were the plans again?", "套餐价格是多少来着？", "プランの料金、どうなってましたっけ？"),
      alt: T(lang, "Table card: plans, prices and seats in a green-headed grid.", "表格卡片：套餐、价格和席位，绿色表头。", "表カード：プラン、料金、席数。見出しは緑。") },
  ];
  const first = samples[0]!;
  if (HERO_VIDEO) {
    return `<figure class="demo">
<div class="field"><video src="/assets/${HERO_VIDEO}.mp4" poster="/assets/${HERO_VIDEO}.webp" autoplay muted loop playsinline preload="metadata" aria-label="${esc(T(lang, "Text is copied, ⌥V opens Paste as…, Return pastes it as a card.", "复制文字，按 ⌥V 打开“粘贴为…”，回车后粘贴成卡片。", "テキストをコピーし、⌥V で「ペースト形式」を開き、Return でカードとしてペースト。"))}"></video></div>
</figure>`;
  }
  const me = T(lang, "You", "我", "自分"), them = T(lang, "Maya", "小林", "佐藤");
  return `<figure class="demo" data-demo>
<div class="field">
<div class="stage-wrap" role="img" aria-label="${esc(T(lang,
    "A short loop: text is selected and copied, ⌥V opens the Paste as… chooser at the caret with the card already drawn, Return pastes the card into a chat.",
    "一段短循环：选中并复制文字，按 ⌥V 在光标处打开“粘贴为…”，卡片已经画好，回车后卡片粘贴进聊天。", "短いループ：テキストを選んでコピーし、⌥V を押すとカーソルの位置に「ペースト形式」のパネルが開き、カードはもうできています。Return でチャットにペーストされます。"))}">
<div class="stage" aria-hidden="true">
<div class="win src"><div class="win-bar"><i></i><i></i><i></i><b>${esc(first.file)}</b></div><span class="toast"><kbd>⌘C</kbd>${T(lang, "Copied", "已复制", "コピーしました")}</span><pre><span><span class="sel">${esc(first.text)}</span></span></pre></div>
<div class="keys"><span class="cap cap-mod">⌥</span><span class="cap cap-mod">V</span><span class="cap cap-enter">↩</span></div>
<div class="win chat"><div class="win-bar"><i></i><i></i><i></i><b>${T(lang, "# launch", "# 发布", "# リリース")}</b></div>
<div class="thread">
<div class="msg msg-ask"><span class="avatar">${them.slice(0, 1)}</span><b>${them}<small>10:02</small></b><p>${esc(first.ask)}</p></div>
<div class="msg msg-new"><span class="avatar you">${me.slice(0, 1)}</span><b>${me}<small>10:03</small></b><img data-card="msg" src="${first.card}" width="240" height="240" alt=""></div>
</div>
<div class="composer"><span class="caret"></span>${T(lang, "Message #launch", "发消息到 #发布", "#リリース へメッセージを送信")}</div>
${chooser(lang, "code-classic")}
</div>
</div>
</div>
<div class="demo-bar">
<ol class="steps" aria-hidden="true"><li>${T(lang, "Copy", "复制", "コピー")}</li><li>⌥V</li><li>${T(lang, "Paste as…", "粘贴为…", "ペースト形式…")}</li><li>${T(lang, "Pasted", "已粘贴", "ペースト完了")}</li></ol>
<button class="play" type="button" hidden aria-pressed="false" data-play="${T(lang, "Play", "播放", "再生")}" data-pause="${T(lang, "Pause", "暂停", "一時停止")}"><svg viewBox="0 0 10 12" aria-hidden="true"><path d="M0 0h3.5v12H0zM6.5 0H10v12H6.5z" fill="currentColor"/></svg><span class="label">${T(lang, "Pause", "暂停", "一時停止")}</span></button>
</div>
</div>
<script type="application/json">${JSON.stringify(samples).replace(/</g, "\\u003c")}</script>
<figcaption>${T(lang, "Still when your Mac is set to reduce motion.", "Mac 开启“减弱动态效果”时画面保持静止。", "Mac で「視差効果を減らす」がオンのときは静止します。")}</figcaption>
</figure>`;
}

function strip(lang: Lang): string {
  const picks: [string, string][] = [
    ["text", "poster"], ["code", "classic"], ["chat", "classic"], ["stat", "classic"], ["info", "editorial"], ["diagram", "editorial"],
    ["quote", "editorial"], ["changelog", "classic"], ["comparison", "editorial"], ["table", "classic"], ["list", "editorial"], ["qr", "editorial"],
  ];
  const items = picks.map(([id, v]) => {
    const [name, style] = templateName(lang, id, v);
    return `<li><img src="${card(`${id}-${v === "poster" ? "poster" : v}`)}" width="320" height="320" loading="lazy" decoding="async" alt="${esc(`${name}, ${style}`)}"></li>`;
  }).join("\n");
  return `<section class="strip" aria-labelledby="strip-title">
<h2 id="strip-title" class="visually-hidden">${T(lang, "Cards made by Peesuto", "Peesuto 做出的卡片", "Peesuto で作ったカード")}</h2>
<ul>
${items}
</ul>
<p class="wrap">${T(lang, "Each of these was pasted from plain text.", "以上每一张都是从纯文本粘贴出来的。", "どれもプレーンテキストからペーストしたものです。")}</p>
</section>`;
}

function reads(lang: Lang): string {
  const types: { id: string; tint: string; card: string; name: string; src: string; note: string }[] = [
    { id: "code", tint: "code", card: "code-classic", name: T(lang, "Code", "代码", "コード"),
      src: 'func greet(_ name: String) -> String {\n    "Hello, \\(name)!"\n}\n\nprint(greet("Peesuto"))',
      note: T(lang, "24 languages highlighted, from the fence or detected. Long lines wrap; indentation holds.", "支持 24 种语言高亮，按代码块标注或自动识别。长行自动换行，缩进保持不变。", "24 言語をハイライト。コードブロックの指定か自動判別で。長い行は折り返し、インデントは崩れません。") },
    { id: "chat", tint: "chat", card: "chat-classic", name: T(lang, "Chat", "聊天", "チャット"),
      src: "Lin: Can this chat become an image?\nAsh: Yes, copy it and press the shortcut.\nLin: Nice, that's all?",
      note: T(lang, "Speakers and times copied out of chat apps become bubbles or a transcript.", "从聊天软件复制的发言人和时间，会排成气泡或对话实录。", "チャットアプリからコピーした発言者と時刻は、吹き出しか書き起こしになります。") },
    { id: "table", tint: "table", card: "table-classic", name: T(lang, "Table", "表格", "表"),
      src: "| Plan | Price | Seats |\n|---|---|---|\n| Solo | $0 | 1 |\n| Team | $12 | 10 |",
      note: T(lang, "Tab-separated, Markdown and terminal box tables. Columns keep whole words.", "制表符分隔、Markdown 和终端里的框线表格都认得。单词不会在列中被拆开。", "タブ区切り、Markdown、ターミナルの罫線表に対応。単語が列の途中で切れることはありません。") },
    { id: "info", tint: "info", card: "info-classic", name: T(lang, "Info card", "信息卡", "情報カード"),
      src: "Staging account\nUser: admin\nPassword: P@ssw0rd!2026\nEmail: ops@example.com\nHost: https://staging.example.com",
      note: T(lang, "Contacts, accounts and dotenv blocks become fields. Passwords and keys are marked with a lock.", "联系人、账号和 dotenv 片段会排成字段，密码和密钥带锁标出。", "連絡先、アカウント、dotenv は項目ごとに整理。パスワードやキーには鍵マークが付きます。") },
    { id: "diagram", tint: "diagram", card: "diagram-editorial", name: T(lang, "Diagram", "流程图", "図"),
      src: "Copy → Decide → Render → Paste",
      note: T(lang, "Mermaid flowcharts and plain arrow chains, laid out and routed.", "Mermaid 流程图和普通的箭头链，自动布局和连线。", "Mermaid のフローチャートや、矢印でつないだ手順を配置して線を引きます。") },
    { id: "quote", tint: "quote", card: "quote-editorial", name: T(lang, "Quote", "引用", "引用"),
      src: "“Simplicity is the ultimate sophistication.”\n— Leonardo da Vinci",
      note: T(lang, "An author is shown only when your text has one.", "原文写了作者，卡片上才会署名。", "著者名は、元のテキストにあるときだけ表示します。") },
    { id: "changelog", tint: "changelog", card: "changelog-classic", name: T(lang, "Release notes", "更新日志", "リリースノート"),
      src: "## v1.2.0 — 2026-09-24\n### Added\n- Signatures on cards\n- Release notes cards\n### Fixed\n- Long code lines wrap",
      note: T(lang, "Keep a Changelog sections, or a version line over its items, become a release card.", "Keep a Changelog 格式，或一行版本号加若干条目，会排成一张发布卡片。", "Keep a Changelog 形式や、バージョン行に続く箇条書きがリリースカードになります。") },
  ];
  const tabs = types.map((t, i) => `<button class="tab" type="button" role="tab" id="tab-${t.id}" aria-controls="panel-${t.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${t.name}</button>`).join("\n");
  const panels = types.map((t, i) => `<div class="tabpanel" role="tabpanel" id="panel-${t.id}" aria-labelledby="tab-${t.id}" data-tint="${t.tint}"${i === 0 ? "" : " hidden"}>
<div class="from"><span class="eyebrow">${T(lang, "On your clipboard", "剪贴板里", "クリップボードの中身")}</span><pre>${esc(t.src)}</pre></div>
<svg class="arrow" viewBox="0 0 48 14" aria-hidden="true"><use href="#i-arrow"/></svg>
<div class="to"><span class="eyebrow">${T(lang, "Pasted with ⌥V ↩", "按 ⌥V ↩ 粘贴", "⌥V ↩ でペースト")}</span><img src="${card(t.card)}" width="320" height="320" loading="lazy" decoding="async" alt="${esc(T(lang, `${t.name} card made from the text on the left.`, `由左侧文字生成的${t.name}卡片。`, `左のテキストから作った${t.name}カード。`))}"></div>
<p class="note"><strong>${t.name}.</strong> ${t.note}</p>
</div>`).join("\n");
  return `<section class="reads pad" id="reads" data-theme="light" aria-labelledby="reads-title">
<div class="wrap">
<h2 class="h2" id="reads-title">${T(lang, "It reads what you copied.", "它读得懂你复制了什么。", "コピーしたものを、読み取ります。")}</h2>
<p class="lede">${T(lang, "Words, names, numbers and order come from your text. Nothing is rewritten or made up; it is only set.", "字词、人名、数字和顺序都来自原文。不改写，不编造，只负责排版。", "言葉、名前、数字、順番はすべて元のテキストのまま。書き換えも付け足しもせず、組むだけです。")}</p>
<div class="tabs" role="tablist" aria-label="${T(lang, "Content type", "内容类型", "内容の種類")}">
${tabs}
</div>
${panels}
</div>
</section>`;
}

function gallery(lang: Lang): string {
  const big = new Set(["text-poster", "code-classic", "chat-classic"]);
  const items = templates.flatMap((t) => t.variants.map((v) => {
    const file = `${t.id}-${v.id}`;
    const [name, style] = templateName(lang, t.id, v.id);
    return `<li${big.has(file) ? ' class="big"' : ""}><img src="${card(file)}" width="320" height="320" loading="lazy" decoding="async" alt="${esc(`${name}, ${style}`)}"><p>${esc(name)} <span>${esc(style)}</span></p></li>`;
  })).join("\n");
  return `<section class="gallery pad" id="templates" data-theme="light" aria-labelledby="templates-title">
<div class="wrap">
<div class="gallery-head">
<h2 class="h2" id="templates-title">${T(lang, `${templates.length} templates,<br>${styleCount} styles.`, `${templates.length} 种模板，<br>${styleCount} 种样式。`, `${templates.length} のテンプレート、<br>${styleCount} のスタイル。`)}</h2>
<p>${T(lang,
    `Local rules pick the template; you can switch the style after pasting, choose a default per template, or turn one off in Settings. Each style is an open table of type and colour: <a href="${GITHUB}/blob/main/docs/templates.md">how templates work</a>.`,
    `模板由本地规则挑选；粘贴后可以换样式，也可以在设置里为每个模板选默认样式或关掉它。每种样式都是一张公开的字体与配色表：<a href="${GITHUB}/blob/main/docs/templates.md">模板说明</a>。`, `テンプレートはローカルのルールが選びます。ペーストしたあとでスタイルを変えたり、テンプレートごとに既定のスタイルを決めたり、設定でオフにしたりできます。スタイルはどれも、書体と配色を定めた公開の表です：<a href="${GITHUB}/blob/main/docs/templates.md">テンプレートの仕組み</a>（英語）。`)}</p>
</div>
<ul class="grid">
${items}
</ul>
</div>
</section>`;
}

function shortcuts(lang: Lang): string {
  const colon = T(lang, ": ", "：", "：");
  const out = (key: string, name: string, note: string) => `<dt><kbd class="inline-cap">${key}</kbd></dt><dd><strong>${name}</strong>${colon}${note}</dd>`;
  return `<section class="pad" id="shortcuts" aria-labelledby="shortcuts-title">
<div class="wrap keys-grid">
<div class="keys-copy">
<h2 class="h2" id="shortcuts-title">${T(lang, "Two keys to remember.", "只要记两个快捷键。", "覚えるキーはふたつだけ。")}</h2>
<p class="lede">${T(lang, "Both act on what you copied last.", "都作用于你最近复制的内容。", "どちらも、最後にコピーしたものに働きます。")}</p>
<ul class="keys-list">
<li><span class="caps"><kbd>⌥</kbd><kbd>V</kbd></span><div><h3>${T(lang, "Paste as…", "粘贴为…", "ペースト形式…")}</h3></div>
<p>${T(lang, "A small chooser opens at your caret, with the card already drawn. One more key:", "在光标处打开一个小面板，卡片已经画好。再按一个键：", "カーソルの位置に小さなパネルが開き、カードはもうできています。あとはキーをひとつ：")}</p>
<dl>
${out("↩", T(lang, "Image", "图片", "画像"), T(lang, "a PNG, pasted into the app you are typing in", "PNG，直接粘贴进你正在输入的应用", "PNG を、いま入力中のアプリにそのままペースト"))}
${out("G", "GIF", T(lang, "the same card, revealed line by line", "同一张卡片，逐行出现", "同じカードを、一行ずつ表示"))}
${out("M", T(lang, "Video", "视频", "動画"), T(lang, "MP4, made with the ffmpeg on your Mac", "MP4，用你 Mac 上的 ffmpeg 生成", "MP4。Mac に入っている ffmpeg で作ります"))}
${out("Q", T(lang, "QR code", "二维码", "QR コード"), T(lang, "exactly the text you copied; never sent to a model", "编码的就是你复制的原文，不会发给任何模型", "コピーしたテキストをそのまま。モデルには送りません"))}
${out("P", T(lang, "Pin to screen", "贴到屏幕", "画面にピン留め"), T(lang, "floats above every window; drag, pinch to zoom, double-click to close", "浮在所有窗口之上；可拖动、捏合缩放，双击关闭", "すべてのウィンドウの上に浮かびます。ドラッグで移動、ピンチで拡大、ダブルクリックで閉じます"))}
</dl>
</li>
<li><span class="caps"><kbd>⇧</kbd><kbd>⌥</kbd><kbd>V</kbd></span><div><h3>${T(lang, "Clipboard history", "剪贴板历史", "クリップボード履歴")}</h3></div>
<p>${T(lang, "Everything you copied, encrypted on your Mac and searchable.", "复制过的所有内容，加密保存在本机，可以搜索。", "コピーしたものすべてを Mac の中で暗号化して保存。検索もできます。")}</p></li>
</ul>
<p class="keys-note">${T(lang, "Image, GIF, video, QR code and pin can each get a direct shortcut in Settings › Shortcuts. They are unbound by default.", "图片、GIF、视频、二维码和贴到屏幕也可以在“设置 › 快捷键”里各自绑定快捷键，默认不绑定。", "画像、GIF、動画、QR コード、ピン留めには「設定 › ショートカット」で個別のキーも割り当てられます。初期状態では未設定です。")}</p>
</div>
<div class="keys-art"><div class="field">${chooser(lang, "text-poster")}</div></div>
</div>
</section>`;
}

function privacy(lang: Lang): string {
  return `<section class="privacy pad" id="privacy" data-theme="dark" aria-labelledby="privacy-title">
<div class="wrap">
<h2 class="h2" id="privacy-title">${T(lang, "Nothing you copy leaves your Mac.", "你复制的内容不会离开这台 Mac。", "コピーしたものは、Mac の外に出ません。")}</h2>
<p class="lede">${T(lang, "Unless you decide it should. No account, no telemetry, no analytics.", "除非你自己决定。没有账号，没有遥测，没有统计。", "あなたが決めない限りは。アカウントも、テレメトリも、アクセス解析もありません。")}</p>
<div class="flow">
<div class="mac"><span class="eyebrow">${T(lang, "Your Mac", "你的 Mac", "あなたの Mac")}</span>
<div class="chips"><span>${T(lang, "Clipboard history · encrypted", "剪贴板历史 · 加密", "クリップボード履歴・暗号化")}</span><span>${T(lang, "Key in Keychain", "密钥在钥匙串", "鍵はキーチェーンに")}</span><span>${T(lang, "Template rules", "模板规则", "テンプレートのルール")}</span><span>${T(lang, "Layout &amp; rendering", "排版与渲染", "組版とレンダリング")}</span></div></div>
<div class="link"><svg viewBox="0 0 160 14" preserveAspectRatio="none" aria-hidden="true"><path d="M0 7h150" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 5"/><path d="M146 1l7 6-7 6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>${T(lang, "only with your key,<br>secrets redacted", "只在你填了密钥时，<br>先脱敏再发送", "自分のキーを入れたときだけ、<br>秘密情報を伏せてから")}</div>
<div class="opt"><span class="eyebrow">${T(lang, "Optional", "可选", "任意")}</span><p>${T(lang, "AI provider", "AI 服务", "AI サービス")}</p><p>${T(lang, "picks the style, never the words", "只挑样式，不碰文字", "選ぶのはスタイルだけ。言葉には触れません")}</p></div>
</div>
<dl class="facts">
<div><dt>${T(lang, "Rendered locally", "本地渲染", "ローカルでレンダリング")}</dt><dd>${T(lang, "Parsing, layout and rendering run on your Mac. Local rules choose the template; no model needed.", "解析、排版和渲染都在本机完成。模板由本地规则选择，不需要任何模型。", "解析も組版もレンダリングも Mac の中。テンプレートはローカルのルールが選ぶので、モデルは要りません。")}</dd></div>
<div><dt>${T(lang, "Passwords skipped", "不记录密码", "パスワードは記録しない")}</dt><dd>${T(lang, "Copies from password managers and secure fields are never recorded.", "从密码管理器和安全输入框复制的内容一律不记录。", "パスワードマネージャーや保護された入力欄からのコピーは記録しません。")}</dd></div>
<div><dt>${T(lang, "Open source", "开源", "オープンソース")}</dt><dd>${T(lang, `MIT-licensed, so you can check. Read the <a href="/privacy/">privacy policy</a>.`, `以 MIT 许可证开源，可以自己检查。详见<a href="/privacy/">隐私政策</a>（英文）。`, `MIT ライセンスなので、中身を確かめられます。詳しくは<a href="/privacy/">プライバシーポリシー</a>（英語）へ。`)}</dd></div>
</dl>
</div>
</section>`;
}

function faq(lang: Lang): string {
  const qa: [string, string][] = lang === "ja" ? [
    ["なぜ「アクセシビリティ」の許可が必要なのですか？", "入力中のアプリにペーストするため、カーソルの位置にパネルを開くため、そしてペーストの直前にカーソルが元の場所にあるかを確かめるためです。許可しなくてもコピーと履歴は使えます。その場合、結果はクリップボードに入るので、⌘V はご自分で押してください。"],
    ["Mac の外に出るデータはありますか？", `初期状態では何も出ません。AI サービスを設定したときだけ、コピーしたテキストが秘密情報を伏せたうえで、あなたのキーでそのサービスに送られます。設定のオフラインスイッチひとつで、すべて止められます。すべてのケースは<a href="/privacy/">プライバシーポリシー</a>（英語）に書いてあります。`],
    ["AI は必須ですか？", "いいえ。テンプレートはすべてローカルのルールで選べます。お好みで、自分の API キーを入れて小さなモデル Jev にテンプレートとスタイルを選ばせることもできます。TypeSafe、Vercel AI Gateway、OpenRouter、またはご自身の Cloudflare アカウントから使えます。Jev が決めるのは見せ方だけで、文章を書き換えることはありません。"],
    ["ffmpeg は必要ですか？", "MP4 動画を作るときだけ必要です。Peesuto は Mac にインストール済みの ffmpeg（<code>brew install ffmpeg</code>）を使い、同梱も自動インストールもしません。画像、GIF、QR コードには何も要りません。"],
    ["対応している Mac は？", "Apple シリコン搭載で、macOS 13 Ventura 以降の Mac です。"],
    ["Homebrew で入れられますか？", "はい。<code>brew install --cask anelikes/tap/peesuto</code> でインストールできます。アップデートはアプリ自身が行います。"],
    ["料金はかかりますか？", "かかりません。Peesuto は MIT ライセンスのオープンソースで、オープンソース版から外している機能もありません。"],
    ["アップデートはどうなりますか？", `Peesuto は 1 日に 1 回 <code>peesuto.com/appcast.xml</code> を確認し、署名済みのアップデートがあればお知らせします（Sparkle）。自動確認は「設定 › 一般」でオフにできます。0.1.0 と 0.1.1 はアップデート機能より前の版なので、一度だけ手動で更新してください。変更点は<a href="/changelog/">更新履歴</a>（英語）にあります。`],
  ] : lang === "en" ? [
    ["Why does it ask for Accessibility access?", "To paste into the app you are typing in, to open the chooser at your caret, and to check that the caret is still where you left it before pasting. Without the permission, copying and history still work; the result is copied and you press ⌘V yourself."],
    ["What leaves my Mac?", `By default, nothing. Only if you set up an AI provider is copied text sent, with secrets redacted first, to that provider with your key. One offline switch in Settings stops all of it. The <a href="/privacy/">privacy policy</a> lists every case.`],
    ["Is AI required?", "No. Local rules choose a template for everything. If you like, bring your own key and let Jev, a small model, choose the template and style, through TypeSafe, Vercel AI Gateway, OpenRouter or your own Cloudflare account. It picks presentation only; it never rewrites your text."],
    ["Do I need ffmpeg?", "Only for MP4 video. Peesuto uses the ffmpeg already on your Mac (<code>brew install ffmpeg</code>) and does not bundle or install it. Images, GIFs and QR codes need nothing extra."],
    ["Which Macs does it run on?", "Macs with Apple silicon, on macOS 13 Ventura or later."],
    ["Can I install it with Homebrew?", "Yes: <code>brew install --cask anelikes/tap/peesuto</code>. The app keeps itself up to date from then on."],
    ["What does it cost?", "Nothing. Peesuto is free and MIT-licensed, and no feature is held back from the open-source build."],
    ["How do updates work?", `Peesuto checks <code>peesuto.com/appcast.xml</code> once a day and offers signed updates (Sparkle); you can turn the check off in Settings › General. Versions 0.1.0 and 0.1.1 came before the updater, so update those once by hand. The <a href="/changelog/">changelog</a> lists what changed.`],
  ] : [
    ["为什么需要“辅助功能”权限？", "为了把结果粘贴进你正在使用的应用、在光标处打开选择面板，并在粘贴前确认光标还在原来的位置。不授权也能正常复制和查看历史，结果会放进剪贴板，由你自己按 ⌘V。"],
    ["哪些数据会离开我的 Mac？", `默认什么都不会。只有当你配置了 AI 服务，复制的文字才会先脱敏，再用你的密钥发给该服务商。设置里有一个离线开关，可以一键全部切断。<a href="/privacy/">隐私政策</a>（英文）列出了每一种情况。`],
    ["必须用 AI 吗？", "不必。本地规则就能为所有内容选好模板。如果愿意，也可以填入自己的密钥，让小模型 Jev 来挑模板和样式，支持 TypeSafe、Vercel AI Gateway、OpenRouter 或你自己的 Cloudflare 账号。它只负责选择呈现方式，从不改写你的文字。"],
    ["需要安装 ffmpeg 吗？", "只有生成 MP4 视频时需要。Peesuto 使用你 Mac 上已有的 ffmpeg（<code>brew install ffmpeg</code>），不会自带或自动安装。图片、GIF 和二维码不需要任何额外组件。"],
    ["支持哪些 Mac？", "搭载 Apple 芯片、运行 macOS 13 Ventura 或更高版本的 Mac。"],
    ["可以用 Homebrew 安装吗？", "可以：<code>brew install --cask anelikes/tap/peesuto</code>。之后应用会自己更新。"],
    ["收费吗？", "免费。Peesuto 以 MIT 许可证开源，开源版本没有任何功能保留。"],
    ["怎么更新？", `Peesuto 每天检查一次 <code>peesuto.com/appcast.xml</code>，有新版本时提示安装经过签名的更新（Sparkle）；可以在“设置 › 通用”里关闭自动检查。0.1.0 和 0.1.1 早于更新器，需要手动更新一次。改动见<a href="/changelog/">更新日志</a>。`],
  ];
  const items = qa.map(([q, a]) => `<details><summary>${q}<svg aria-hidden="true"><use href="#i-plus"/></svg></summary><p>${a}</p></details>`).join("\n");
  return `<section class="faq pad" id="faq" aria-labelledby="faq-title">
<div class="wrap">
<h2 class="h2" id="faq-title">${T(lang, "Questions.", "常见问题。", "よくある質問。")}</h2>
<div class="faq-list">
${items}
</div>
</div>
</section>`;
}

function home(lang: Lang): string {
  const body = `<section class="hero" aria-labelledby="hero-title">
<div class="wrap">
<div class="hero-head">
<h1 class="display" id="hero-title">${T(lang, "Copy text.<br>Paste a card.", "复制文字，<br>粘贴成卡片。", "テキストをコピー。<br>カードをペースト。")}</h1>
<div class="hero-side">
<p class="intro">${T(lang,
    "Peesuto is a clipboard app for the Mac. It sees what you copied (code, a chat, a table, a quote) and pastes it as a well-set image into whatever you are typing in. GIF and video too.",
    "Peesuto 是一款 Mac 剪贴板应用。它看得懂你复制的内容，比如代码、聊天记录、表格、引语，把它排成一张好看的图片，直接粘贴到你正在输入的地方。也能生成 GIF 和视频。", "Peesuto は Mac のクリップボードアプリです。コピーしたもの（コード、チャット、表、引用など）を読み取り、きれいに組んだ画像にして、いま入力しているところへペーストします。GIF や動画にもできます。")}</p>
<div class="cta-row"><a class="btn btn-primary" href="${DOWNLOAD}">${T(lang, "Download for Mac", "下载 Mac 版", "Mac 版をダウンロード")}</a><a class="btn btn-ghost" href="${GITHUB}">${T(lang, "View on GitHub", "在 GitHub 上查看", "GitHub で見る")}</a></div>
<p class="meta"><span>${T(lang, "macOS 13+", "macOS 13 及以上", "macOS 13 以降")}</span><span>${T(lang, "Apple silicon", "Apple 芯片", "Apple シリコン")}</span><span>${T(lang, "Free, MIT-licensed", "免费，MIT 开源", "無料・MIT ライセンス")}</span></p>
</div>
</div>
${heroDemo(lang)}
</div>
</section>
${strip(lang)}
${reads(lang)}
${gallery(lang)}
${shortcuts(lang)}
${privacy(lang)}
${faq(lang)}
<section class="closing" aria-labelledby="closing-title">
<div class="wrap">
<h2 class="h2" id="closing-title">${T(lang, "Copy. ⌥V. Return.", "复制，⌥V，回车。", "コピー、⌥V、Return。")}</h2>
<a class="btn" href="${DOWNLOAD}">${T(lang, "Download for Mac", "下载 Mac 版", "Mac 版をダウンロード")}</a>
<p class="meta"><span>${T(lang, "macOS 13+ · Apple silicon · MIT", "macOS 13 及以上 · Apple 芯片 · MIT", "macOS 13 以降 · Apple シリコン · MIT")}</span></p>
</div>
</section>`;
  return page({
    lang, path: L(lang).path, current: "home", alternates: true, script: true,
    title: T(lang, "Peesuto — Copy text. Paste a card.", "Peesuto — 复制文字，粘贴成卡片", "Peesuto — テキストをコピー、カードをペースト"),
    description: T(lang,
      "A small, open-source clipboard app for the Mac. Copy text, press ⌥V, and a well-set card is pasted into the app you are typing in.",
      "一款小巧的开源 Mac 剪贴板应用。复制文字，按 ⌥V，一张排好版的卡片就粘贴进你正在输入的应用。", "Mac のための小さなオープンソースのクリップボードアプリ。テキストをコピーして ⌥V を押すと、きれいに組んだカードが入力中のアプリにペーストされます。"),
    body,
  });
}

// ---------------------------------------------------------------- changelog

interface Release { title: string; date?: string; blocks: string }

/** Inline Markdown used by CHANGELOG.md: `code`, **bold**, [text](url). */
function inline(md: string): string {
  const parts: string[] = [];
  let rest = md;
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/;
  for (let m = rest.match(re); m; m = rest.match(re)) {
    parts.push(esc(rest.slice(0, m.index)));
    if (m[1] !== undefined) parts.push(`<code>${esc(m[1])}</code>`);
    else if (m[2] !== undefined) parts.push(`<strong>${inline(m[2])}</strong>`);
    else {
      const href = m[4]!.startsWith("http") ? m[4]! : `${GITHUB}/blob/main/${m[4]!.replace(/^\.?\//, "")}`;
      parts.push(`<a href="${esc(href)}">${inline(m[3]!)}</a>`);
    }
    rest = rest.slice(m.index! + m[0].length);
  }
  parts.push(esc(rest));
  return parts.join("");
}

function markdownBlocks(lines: string[]): string {
  const out: string[] = [];
  let list: string[] | null = null;
  let para: string[] | null = null;
  const flushPara = () => { if (para) { out.push(`<p>${inline(para.join(" "))}</p>`); para = null; } };
  const flushList = () => { if (list) { out.push(`<ul>\n${list.map((li) => `<li>${inline(li)}</li>`).join("\n")}\n</ul>`); list = null; } };
  let pendingBlank = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushPara(); pendingBlank = true; continue; }
    const heading = line.match(/^###\s+(.*)$/);
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (heading) { flushPara(); flushList(); out.push(`<h3>${inline(heading[1]!)}</h3>`); }
    else if (bullet) { flushPara(); (list ??= []).push(bullet[1]!); }
    else if (/^\s+\S/.test(line) && list && !pendingBlank) { list[list.length - 1] += ` ${line.trim()}`; }
    else { flushList(); (para ??= []).push(line.trim()); }
    pendingBlank = false;
  }
  flushPara(); flushList();
  return out.join("\n");
}

function parseChangelog(md: string): Release[] {
  const releases: Release[] = [];
  let current: { title: string; date?: string; lines: string[] } | null = null;
  for (const line of md.split("\n")) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      if (current) releases.push({ title: current.title, date: current.date, blocks: markdownBlocks(current.lines) });
      const [title, date] = h[1]!.split(/\s+[—–-]\s+/);
      current = { title: title!.trim(), date: date?.trim(), lines: [] };
    } else if (current) current.lines.push(line);
  }
  if (current) releases.push({ title: current.title, date: current.date, blocks: markdownBlocks(current.lines) });
  return releases;
}

function changelog(): string {
  const releases = parseChangelog(readFileSync(join(REPO, "CHANGELOG.md"), "utf8"));
  const fmt = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  // An empty section (right after a release, "Unreleased" has nothing yet) is not shown.
  const articles = releases.filter((r) => r.blocks.length > 0).map((r) => {
    const unreleased = /^unreleased$/i.test(r.title);
    const id = unreleased ? "unreleased" : `v${r.title.replace(/[^0-9a-z.]/gi, "")}`;
    const meta = unreleased
      ? `<p>In development</p><span class="tag">Not in a release yet</span>`
      : `${r.date ? `<p><time datetime="${esc(r.date)}">${fmt(r.date)}</time></p>` : ""}<p><a href="${GITHUB}/releases/tag/v${esc(r.title)}">v${esc(r.title)} on GitHub</a></p>`;
    return `<article class="release" aria-labelledby="${id}">
<header><h2 id="${id}">${unreleased ? "Unreleased" : esc(r.title)}</h2>${meta}</header>
<div class="body">
${r.blocks}
</div>
</article>`;
  }).join("\n");
  const body = `<div class="page wrap log">
<h1>Changelog</h1>
<p>What changed in each release, newest first. “Unreleased” is what the next release will contain. The source is <a href="${GITHUB}/blob/main/CHANGELOG.md">CHANGELOG.md</a>.</p>
${articles}
</div>`;
  return page({ lang: "en", path: "/changelog/", current: "changelog", title: "Changelog — Peesuto",
    description: "What changed in each release of Peesuto, the open-source clipboard app for the Mac.", body });
}

// ---------------------------------------------------------------- privacy

function privacyPolicy(): string {
  const updated = "2026-09-24";
  const row = (a: string, b: string, c: string) => `<tr><td>${a}</td><td>${b}</td><td>${c}</td></tr>`;
  const body = `<div class="page wrap"><article class="prose">
<h1>Privacy policy</h1>
<p class="updated">Updated <time datetime="${updated}">24 September 2026</time></p>
<p class="big">Peesuto has no telemetry, no analytics and no account. What you copy stays on your Mac unless you set up an AI provider yourself.</p>

<h2>What is stored, and where</h2>
<ul>
<li><strong>Clipboard history</strong> is stored on your Mac, encrypted. The key is kept in your macOS Keychain.</li>
<li><strong>Excluded by default:</strong> copies from password managers and content macOS marks as concealed, including secure input fields.</li>
<li><strong>Rendered cards</strong> are saved in the app’s folder and pruned after 24 hours or beyond the newest 30.</li>
<li><strong>API keys</strong> you enter for an AI provider are kept in your Keychain, never in a settings file.</li>
</ul>
<p>You can clear the history at any time in Settings.</p>

<h2>What is sent, and only when you choose it</h2>
<p>By default Peesuto decides with local rules and sends nothing about your text anywhere. If you configure a provider, this is what goes where:</p>
<div class="table-scroll"><table>
<thead><tr><th scope="col">Provider</th><th scope="col">What is sent</th><th scope="col">To</th></tr></thead>
<tbody>
${row("Local rules <span>(default)</span>", "Nothing", "—")}
${row("Jev via TypeSafe, Vercel AI Gateway or OpenRouter", "Short typed questions about the text, and the text, redacted", "That service, with your key")}
${row("Jev via Cloudflare", "The same", "Your own Workers AI account")}
${row("Custom endpoint or local model", "The same", "The URL you set")}
${row("Text generation (translate, summarise, your own prompts)", "The filled prompt, redacted", "The base URL you set, with your key")}
</tbody>
</table></div>
<p>Before anything is sent, built-in rules remove API keys, private keys, JWTs, bearer tokens, credentials in URLs and secret assignments. You can add your own rules, or send structure only. A model only chooses how the card looks; the card itself is always rendered on your Mac. QR codes are never sent anywhere.</p>
<p>The offline switch in Settings closes the single network path for all of the above. A log records where bytes went, never what they were.</p>

<h2>Other network requests</h2>
<ul>
<li><strong>Emoji.</strong> Emoji pictures come from a set bundled with the app. An emoji missing from it is fetched once by its code point from the jsDelivr CDN (Google’s Noto Emoji) and cached. That reveals which emoji, not your text.</li>
<li><strong>Update checks.</strong> Once a day Peesuto fetches <code>https://peesuto.com/appcast.xml</code> to see whether a new version exists, and downloads it only if you accept. The request names the app and its version (the user agent of Sparkle, the update framework); Sparkle’s optional system profile is not enabled, so nothing about your Mac is sent. Turn automatic checks off in Settings › General.</li>
</ul>

<h2>This website</h2>
<p>peesuto.com is a static site. It sets no cookies, runs no trackers or analytics and loads nothing from other domains; fonts and images are served from here. Our host, Cloudflare, processes requests (including IP addresses) to deliver the site and keep it secure, and keeps standard logs.</p>

<h2>Checking and contact</h2>
<p>All of this can be checked in the open-source code on <a href="${GITHUB}">GitHub</a>. Questions, or a security issue to report: <a href="mailto:contact@peesuto.com">contact@peesuto.com</a>.</p>
</article></div>`;
  return page({ lang: "en", path: "/privacy/", current: "privacy", title: "Privacy policy — Peesuto",
    description: "What Peesuto stores on your Mac, what leaves it and only when you choose, and what this website does.", body });
}

// ---------------------------------------------------------------- 404

function notFound(): string {
  const body = `<div class="page wrap notfound">
<h1 class="display">404</h1>
<p>This page does not exist. Maybe it was pasted somewhere else.</p>
<p lang="zh-Hans">页面不存在。</p>
<p lang="ja">このページは見つかりませんでした。</p>
<div class="cta-row"><a class="btn btn-primary" href="/">Peesuto home</a><a class="btn btn-ghost" href="/zh/" lang="zh-Hans">中文首页</a><a class="btn btn-ghost" href="/ja/" lang="ja">日本語トップ</a></div>
</div>`;
  return page({ lang: "en", path: "/404", noindex: true, title: "Not found — Peesuto", description: "This page does not exist.", body });
}

// ---------------------------------------------------------------- write

async function write(rel: string, content: string): Promise<void> {
  const path = join(SITE, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

for (const f of ["assets/site.css", "assets/site.js", "cards/code-classic.webp", "assets/fonts/peesuto-mono-bold.woff2"]) {
  if (!existsSync(join(SITE, f))) throw new Error(`site/${f} is missing (run bun scripts/site-assets.ts for binary assets)`);
}
for (const t of templates) for (const v of t.variants) {
  if (!existsSync(join(SITE, "cards", `${t.id}-${v.id}.webp`))) throw new Error(`site/cards/${t.id}-${v.id}.webp is missing: run bun scripts/site-assets.ts --only cards`);
}

await write("index.html", home("en"));
await write("zh/index.html", home("zh"));
await write("ja/index.html", home("ja"));
await write("changelog/index.html", changelog());
await write("privacy/index.html", privacyPolicy());
await write("404.html", notFound());
await write("robots.txt", `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
await write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${LANGS.map((home) => `<url><loc>${ORIGIN}${home.path}</loc>${LANGS.map((l) => `<xhtml:link rel="alternate" hreflang="${l.hreflang}" href="${ORIGIN}${l.path}"/>`).join("")}</url>`).join("\n")}
<url><loc>${ORIGIN}/changelog/</loc></url>
<url><loc>${ORIGIN}/privacy/</loc></url>
</urlset>
`);
console.log(`site: ${["index.html", "zh/index.html", "ja/index.html", "changelog/index.html", "privacy/index.html", "404.html", "robots.txt", "sitemap.xml"].join(", ")}`);
