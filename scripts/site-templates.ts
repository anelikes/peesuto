/**
 * Copy and samples for the website's template gallery (/templates/ and one
 * page per template), shared by scripts/site-gallery.ts (renders the images)
 * and scripts/site.ts (writes the pages). See docs/site.md.
 *
 * The template list itself always comes from core/src/templates/registry.ts.
 * A template registered there but missing here still gets a page once it has
 * a sample: until then the gallery skips it (with a warning) and it lands in
 * the "Other" group.
 *
 * Every sample must be picked by the local rules as its own template
 * (`bun scripts/site-gallery.ts --check` verifies it without rendering). QR and
 * Lyric motion are the exception: never chosen automatically, only by pressing
 * Q or L.
 */
export type Lang = "en" | "zh" | "ja";
export type Localized = Readonly<Record<Lang, string>>;

export interface GroupInfo { readonly id: string; readonly name: Localized; readonly blurb: Localized; readonly ids: readonly string[] }

/** The overview's sections, in order. Unknown ids fall into "other". */
export const GROUPS: readonly GroupInfo[] = [
  { id: "writing", name: { en: "Writing", zh: "写作", ja: "文章" },
    blurb: { en: "Sentences, notes, quotes, lists and kinetic type.", zh: "句子、笔记、引语、清单和文字 PV。", ja: "文、メモ、引用、リスト、文字PV。" },
    ids: ["text", "document", "quote", "list", "comparison", "lyrics"] },
  { id: "developers", name: { en: "Developers", zh: "开发", ja: "開発" },
    blurb: { en: "Code, shells, diffs, stack traces and releases.", zh: "代码、终端、差异、报错和版本发布。", ja: "コード、ターミナル、差分、エラー、リリース。" },
    ids: ["code", "terminal", "diff", "error", "changelog"] },
  { id: "data", name: { en: "Data", zh: "数据", ja: "データ" },
    blurb: { en: "Tables, numbers, schedules and flows.", zh: "表格、数字、日程和流程。", ja: "表、数字、スケジュール、フロー。" },
    ids: ["table", "stats", "stat", "timeline", "diagram"] },
  { id: "personal", name: { en: "Personal", zh: "个人", ja: "身の回り" },
    blurb: { en: "Accounts, conversations and links.", zh: "账号、对话和链接。", ja: "アカウント、会話、リンク。" },
    ids: ["info", "chat", "qr"] },
];
export const OTHER_GROUP: GroupInfo = { id: "other", name: { en: "Other", zh: "其他", ja: "その他" },
  blurb: { en: "Newer templates.", zh: "新加入的模板。", ja: "新しいテンプレート。" }, ids: [] };

/** Japanese template and style names (the registry carries English and Chinese only). */
export const JA_NAMES: Readonly<Record<string, string>> = {
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
  terminal: "ターミナルセッション", "terminal-classic": "夜のターミナル", "terminal-editorial": "コマンドログ",
  diff: "差分", "diff-classic": "レビュー", "diff-editorial": "夜の差分",
  error: "エラー", "error-classic": "クラッシュレポート", "error-editorial": "コンソール",
  timeline: "スケジュール", "timeline-classic": "アジェンダ", "timeline-editorial": "マイルストーン",
  stats: "指標", "stats-classic": "ダッシュボード", "stats-editorial": "スコアボード",
  lyrics: "文字PV", "lyrics-classic": "ステージ", "lyrics-editorial": "紙面", "lyrics-pop": "ポップ", "lyrics-night": "ナイト",
  qr: "QR コード", "qr-classic": "シンプル", "qr-editorial": "カード",
};

/**
 * The text copied on each page, per language. English samples match
 * scripts/template-previews.ts, so the home page's "It reads what you copied"
 * panels show the same text as their cards.
 */
export const SAMPLES: Readonly<Record<string, Localized>> = {
  text: {
    en: "Make room for a clearer thought.",
    zh: "好的设计，是把复杂留给自己，把简单留给别人。",
    ja: "余白があると、考えがはっきりする。",
  },
  document: {
    en: "# Weekly notes\n\nThe native app is now the only desktop build, and **every test passes**.\n\n- Text cards shipped\n- Long chats scroll\n\n## Next week\n\nPrepare the first signed release.",
    zh: "# 周会纪要\n\n本周完成了原生版迁移，**所有测试通过**。\n\n- 文字模板上线\n- 长聊天记录可以滚动\n\n## 下周\n\n准备第一次签名发布。",
    ja: "# 週次メモ\n\nネイティブ版への移行が終わり、**テストはすべて通りました**。\n\n- テキストカードを公開\n- 長いチャットはスクロール\n\n## 来週\n\n最初の署名付きリリースを準備する。",
  },
  quote: {
    en: "“Simplicity is the ultimate sophistication.”\n— Leonardo da Vinci",
    zh: "“知之者不如好之者，好之者不如乐之者。”\n——孔子",
    ja: "「初心忘るべからず」\n— 世阿弥",
  },
  code: {
    en: "func greet(_ name: String) -> String {\n    \"Hello, \\(name)!\"\n}\n\nprint(greet(\"Peesuto\"))",
    zh: "def greet(name: str) -> str:\n    # 返回一句问候\n    return f\"你好，{name}！\"\n\nprint(greet(\"Peesuto\"))",
    ja: "function greet(name) {\n  // あいさつを返す\n  return `こんにちは、${name}さん！`;\n}\n\nconsole.log(greet(\"Peesuto\"));",
  },
  stat: {
    en: "Weekly active users: 12,480",
    zh: "本周活跃用户：12,480",
    ja: "今週のアクティブユーザー：12,480",
  },
  list: {
    en: "- Copy the text\n- Press the shortcut\n- Paste the card",
    zh: "1. 先把问题写清楚\n2. 一次只改一个变量\n3. 量化结果再继续",
    ja: "- テキストをコピー\n- ショートカットを押す\n- カードをペースト",
  },
  chat: {
    en: "Lin: Can this chat become an image?\nAsh: Yes, copy it and press the shortcut.\nLin: Nice, that's all?",
    zh: "小林：这段对话能变成图片吗？\n阿杰：可以，复制后按一下快捷键。\n小林：就这么简单？",
    ja: "佐藤：このチャット、画像にできますか？\n田中：できます。コピーしてショートカットを押すだけです。\n佐藤：それだけ？",
  },
  table: {
    en: "| Plan | Price | Seats |\n|---|---|---|\n| Solo | $0 | 1 |\n| Team | $12 | 10 |",
    zh: "| 套餐 | 价格 | 席位 |\n|---|---|---|\n| 个人 | ¥0 | 1 |\n| 团队 | ¥88 | 10 |",
    ja: "| プラン | 料金 | 席数 |\n|---|---|---|\n| 個人 | ¥0 | 1 |\n| チーム | ¥1,800 | 10 |",
  },
  comparison: {
    en: "Before:\nCopy, screenshot, crop, paste\nAfter:\nCopy, press a shortcut",
    zh: "之前：\n复制、截图、裁剪、粘贴\n之后：\n复制，按一下快捷键",
    ja: "Before:\nコピー、スクショ、切り抜き、貼り付け\nAfter:\nコピーして、ショートカットを押す",
  },
  diagram: {
    en: "Copy → Decide → Render → Paste",
    zh: "复制 → 识别 → 渲染 → 粘贴",
    ja: "コピー → 判定 → 描画 → ペースト",
  },
  info: {
    en: "Staging account\nUser: admin\nPassword: P@ssw0rd!2026\nEmail: ops@example.com\nHost: https://staging.example.com",
    zh: "测试环境账号\n用户名：admin\n密码：P@ssw0rd!2026\n邮箱：ops@example.com\n主机：https://staging.example.com",
    ja: "検証環境のアカウント\nユーザー名：admin\nパスワード：P@ssw0rd!2026\nメール：ops@example.com\nホスト：https://staging.example.com",
  },
  changelog: {
    en: "## v1.2.0 — 2026-09-24\n### Added\n- Signatures on cards\n- Release notes cards\n### Fixed\n- Long code lines wrap",
    zh: "## v1.2.0 — 2026-09-24\n### 新增\n- 卡片签名\n- 更新日志卡片\n### 修复\n- 长代码行自动换行",
    ja: "## v1.2.0 — 2026-09-24\n### 追加\n- カードに署名\n- リリースノートのカード\n### 修正\n- 長いコード行を折り返す",
  },
  terminal: {
    en: "$ bun test\n 512 pass\n 0 fail\n$ git push\nEverything up-to-date",
    zh: "$ npm run build\n> peesuto@0.2.0 build\n构建完成，用时 3.2 秒\n$ git push\nEverything up-to-date",
    ja: "$ npm run build\n> peesuto@0.2.0 build\nビルド完了（3.2 秒）\n$ git push\nEverything up-to-date",
  },
  diff: {
    en: "--- a/greet.swift\n+++ b/greet.swift\n@@ -1,3 +1,3 @@\n func greet(_ name: String) -> String {\n-    \"Hi, \\(name)\"\n+    \"Hello, \\(name)!\"\n }",
    zh: "commit 3f2a1c9e8b7d6a5f4e3d2c1b0a99887766554433\nAuthor: 林小雨 <lin@example.com>\nDate:   Wed Sep 24 10:12:03 2026 +0800\n\n    文档：加上 Homebrew 安装方式\n\n--- a/文档/说明.md\n+++ b/文档/说明.md\n@@ -1,3 +1,4 @@\n ## 安装\n-下载 DMG，拖进应用程序文件夹。\n+用 Homebrew 安装：brew install --cask peesuto\n+或者下载 DMG，拖进应用程序文件夹。\n 首次打开时需要授予辅助功能权限。",
    ja: "--- a/docs/はじめに.md\n+++ b/docs/はじめに.md\n@@ -1,3 +1,4 @@\n ## インストール\n-DMG をダウンロードして、アプリケーションフォルダへ。\n+Homebrew なら：brew install --cask peesuto\n+または DMG をダウンロードして、アプリケーションフォルダへ。\n 初回はアクセシビリティの許可が必要です。",
  },
  error: {
    en: "TypeError: Cannot read properties of undefined (reading 'name')\n    at greet (/app/src/greet.ts:3:18)\n    at main (/app/src/main.ts:9:3)\n    at node:internal/main/run_main_module:28:49",
    zh: "Exception in thread \"main\" java.lang.IllegalStateException: 订单状态不能从「已发货」改回「待付款」\n\tat com.example.shop.OrderService.transition(OrderService.java:88)\n\tat com.example.shop.OrderController.cancel(OrderController.java:41)\n\tat org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:897)",
    ja: "Traceback (most recent call last):\n  File \"/srv/app/main.py\", line 9, in <module>\n    load(\"設定.json\")\n  File \"/srv/app/config.py\", line 4, in load\n    raise FileNotFoundError(f\"設定ファイルが見つかりません：{path}\")\nFileNotFoundError: 設定ファイルが見つかりません：設定.json",
  },
  timeline: {
    en: "Launch day\n09:00 Doors open\n10:30 Keynote\n14:00 Workshops\n18:00 Party",
    zh: "周五发布日程\n09:00 冻结代码\n10:30 回归测试\n14:00 提交公证\n17:00 发布 0.3.0",
    ja: "リリース当日\n09:00 コードフリーズ\n10:30 回帰テスト\n14:00 公証に提出\n17:00 0.3.0 を公開",
  },
  stats: {
    en: "This week\nDAU: 12,480 (+8%)\nRevenue: $48.2k (−3%)\nRetention: 41%\nNPS: 61",
    zh: "本周数据\n日活：12,480（+8%）\n收入：¥32.5万（-4%）\n转化率：3.2%\n新用户：1,860 人",
    ja: "今週の数字\nDAU：12,480（+8%）\n売上：¥482万（−3%）\n継続率：41%\nNPS：61",
  },
  lyrics: {
    en: "The best tools disappear. They show up when you need them, and get out of the way when you don't. That is the whole idea.",
    zh: "今天在地铁上看到一个小孩，把整张车窗当成画板，用手指画了一只猫。到站的时候，他对着那只猫挥手说再见。",
    ja: "改札を抜けて/走りだす\n*まぶしい*朝の光\n君の名前を呼んだ!\n\nまだ眠い町の灯り",
  },
  qr: {
    en: "https://peesuto.com",
    zh: "https://peesuto.com/zh/",
    ja: "https://peesuto.com/ja/",
  },
};

/** One line under the template's name: what it is for. */
export const BLURBS: Readonly<Record<string, Localized>> = {
  text: { en: "A line or a few short paragraphs, set large.", zh: "一句话或几小段文字，用大字排出来。", ja: "一文や短い段落を、大きな文字で。" },
  document: { en: "Longer notes and Markdown, set as a readable page.", zh: "较长的笔记和 Markdown，排成一页好读的文章。", ja: "長めのメモや Markdown を、読みやすいページに。" },
  quote: { en: "A quotation, with its author when you wrote one.", zh: "一段引语，写了作者就署上作者。", ja: "引用文。著者が書いてあれば添えて。" },
  code: { en: "Source code in 24 highlighted languages.", zh: "源代码，支持 24 种语言高亮。", ja: "ソースコード。24 言語をハイライト。" },
  stat: { en: "One number and what it counts.", zh: "一个数字，加上它的含义。", ja: "ひとつの数字と、その意味。" },
  list: { en: "Bulleted or numbered items, in order.", zh: "带圆点或编号的条目，保持原有顺序。", ja: "箇条書きや番号付きの項目を、その順番で。" },
  chat: { en: "A conversation as bubbles or a transcript.", zh: "一段对话，排成气泡或对话实录。", ja: "会話を、吹き出しか書き起こしに。" },
  table: { en: "Markdown, tab-separated or box-drawn tables.", zh: "Markdown、制表符分隔或框线表格。", ja: "Markdown、タブ区切り、罫線の表。" },
  comparison: { en: "Before and after, pros and cons, A and B.", zh: "之前与之后、优点与缺点、方案 A 与 B。", ja: "Before と After、長所と短所、A と B。" },
  diagram: { en: "Mermaid flowcharts and arrow chains, laid out.", zh: "Mermaid 流程图和箭头链，自动布局。", ja: "Mermaid のフローチャートや矢印の手順を図に。" },
  info: { en: "Contacts, accounts and keys as tidy fields.", zh: "联系方式、账号和密钥，排成整齐的字段。", ja: "連絡先、アカウント、キーを項目ごとに。" },
  changelog: { en: "Versions, dates and what changed.", zh: "版本、日期和改动。", ja: "バージョン、日付、変更点。" },
  terminal: { en: "Commands and their output, as a session.", zh: "命令和输出，排成一段终端会话。", ja: "コマンドとその出力を、ひとつのセッションに。" },
  diff: { en: "Added and removed lines, ready for review.", zh: "增删的行，方便审阅。", ja: "追加と削除の行を、レビューしやすく。" },
  error: { en: "The error message first, your own frames marked.", zh: "报错信息放在最前，你自己的代码帧会被标出。", ja: "エラーメッセージを先頭に。自分のコードのフレームに印を。" },
  timeline: { en: "Times and dates, each with its event.", zh: "时间或日期，各自带着要做的事。", ja: "時刻や日付と、その予定。" },
  stats: { en: "Several numbers in a grid, with their changes.", zh: "几项数字排成网格，涨跌一目了然。", ja: "いくつもの数字をグリッドに。増減も一目で。" },
  lyrics: { en: "Any text as kinetic type, by pressing L.", zh: "任意文字做成文字 PV，按 L 即可。", ja: "どんなテキストも文字PVに。L を押すだけ。" },
  qr: { en: "Any text as a QR code, by pressing Q.", zh: "任何文字都能变成二维码，按 Q 即可。", ja: "どんなテキストも QR コードに。Q を押すだけ。" },
};

/** "How Peesuto recognises it", in plain words (after docs/templates.md). */
export const HOW: Readonly<Record<string, Localized>> = {
  text: {
    en: "Short plain prose: at most 280 characters, a few short paragraphs, and nothing that carries layout (no list markers, tables, indentation or “Label: value” lines). The longer the text, the smaller the type.",
    zh: "简短的纯文字：不超过 280 个字符、几小段，而且没有任何承担排版作用的东西（列表符号、表格、缩进、“标签: 值”这样的行）。字越多，字号越小。",
    ja: "短いプレーンな文章です。280 文字以内の数段落で、レイアウトを担う要素（箇条書きの記号、表、インデント、「ラベル: 値」の行）を含まないもの。文字が多いほど、文字は小さくなります。",
  },
  document: {
    en: "The fallback for everything else: longer notes, Markdown with headings, **bold** and lists. Nothing is dropped; every paragraph is kept in order.",
    zh: "其他内容的兜底模板：较长的笔记、带标题、**加粗**和列表的 Markdown。一个字都不丢，所有段落按原顺序保留。",
    ja: "ほかのどれにも当てはまらないときの受け皿です。長めのメモや、見出し・**太字**・リストを含む Markdown など。何も落とさず、すべての段落を順番どおりに残します。",
  },
  quote: {
    en: "Text wrapped in quotation marks (“ ”, 「 」, \" \") or lines starting with >. An author appears only when a line such as “— Name” names one; none is ever guessed.",
    zh: "用引号（“ ”、「 」、\" \"）括起来的文字，或每行以 > 开头的引用。只有写了“——某人”这样的署名行，卡片上才会出现作者，从不猜测。",
    ja: "引用符（“ ”、「 」、\" \"）で囲んだ文、または > で始まる行。「— 名前」のような行があるときだけ著者を表示し、推測はしません。",
  },
  code: {
    en: "A fenced ``` block, or text that is plainly code: function definitions, imports, SQL, JSON. The language comes from the fence or is detected; indentation is kept and long lines wrap.",
    zh: "用 ``` 围起来的代码块，或一眼就是代码的文字：函数定义、import、SQL、JSON 等。语言取自代码块标注或自动识别；缩进保持不变，长行自动换行。",
    ja: "``` で囲んだブロック、または明らかにコードとわかるテキスト（関数定義、import、SQL、JSON など）。言語はコードブロックの指定か自動判別で。インデントはそのまま、長い行は折り返します。",
  },
  stat: {
    en: "A single “label: number” line, or a number on one line with its label under it. Currency, thousands separators and units such as % or ms are fine.",
    zh: "只有一行“标签：数字”，或者一行数字、下一行是它的说明。可以带货币符号、千位分隔符和 %、ms 这样的单位。",
    ja: "「ラベル：数字」の一行、または数字の行とその下の説明。通貨記号、桁区切り、% や ms などの単位も使えます。",
  },
  list: {
    en: "Two or more lines that all start with a marker: -, *, • or a number such as 1. or 2). Numbered items keep their numbers.",
    zh: "两行以上、每行都以列表符号开头：-、*、• 或 1.、2) 这样的编号。有编号的保留编号。",
    ja: "2 行以上で、すべての行が記号（-、*、•）や番号（1. や 2) など）で始まるもの。番号はそのまま残します。",
  },
  chat: {
    en: "Turns with speakers: “Name: message” lines where names repeat, or text copied out of a chat app with a name and a time over each message. The copied times are kept.",
    zh: "有发言人的轮流对话：“名字：内容”这样的行且名字会重复出现，或从聊天软件复制出来、每条消息上方带名字和时间的记录。复制来的时间会保留。",
    ja: "発言者のいるやりとりです。名前がくり返し出てくる「名前：発言」の行や、チャットアプリからコピーした、発言ごとに名前と時刻が付いたテキスト。コピーした時刻はそのまま残します。",
  },
  table: {
    en: "A Markdown table, tab-separated columns (what spreadsheets copy), or a box-drawn table from a terminal. Every cell is kept; columns never split a word.",
    zh: "Markdown 表格、制表符分隔的列（从电子表格复制出来的就是这样）或终端里的框线表格。每个单元格都保留，单词不会在列中被拆开。",
    ja: "Markdown の表、タブ区切りの列（スプレッドシートからのコピー）、ターミナルの罫線表。セルはすべて残し、単語が列の途中で切れることはありません。",
  },
  comparison: {
    en: "Exactly two headings that end in a colon and form a known pair (Before/After, Pros/Cons, Option A/Option B, 之前/之后, 优点/缺点), each with its lines under it.",
    zh: "正好两个以冒号结尾、成对出现的小标题（Before/After、Pros/Cons、Option A/Option B、之前/之后、优点/缺点……），各自下面跟着内容。",
    ja: "コロンで終わる見出しがちょうどふたつあり、決まった組（Before/After、Pros/Cons、Option A/Option B、之前/之后 など）になっていて、それぞれの下に内容があるもの。",
  },
  diagram: {
    en: "A Mermaid flowchart (graph or flowchart, fenced or bare), or lines like “A → B → C”. It wins over every other structure; the nodes are laid out and the arrows routed.",
    zh: "Mermaid 流程图（graph 或 flowchart，带不带代码块都行），或“A → B → C”这样的箭头链。它的优先级最高；节点自动布局，箭头自动连线。",
    ja: "Mermaid のフローチャート（graph か flowchart。コードブロックの有無は問いません）や、「A → B → C」のような行。ほかの構造より優先され、ノードを配置して矢印を引きます。",
  },
  info: {
    en: "Every line is a field (“label: value”, an UPPER_CASE=value setting, or a bare email, link, phone number or key), with an optional title first. Passwords and keys are shown in full next to a lock; redact them with the privacy rules if you need to.",
    zh: "每一行都是一个字段（“标签：值”、UPPER_CASE=值 这样的配置，或单独的邮箱、链接、电话、密钥），第一行可以是标题。密码和密钥会完整显示并带锁标，需要隐藏时请用隐私规则脱敏。",
    ja: "すべての行が項目（「ラベル：値」、UPPER_CASE=値 の設定、または単独のメール、リンク、電話番号、キー）で、先頭に任意のタイトル。パスワードやキーは鍵マーク付きでそのまま表示されるので、隠したいときはプライバシールールで伏せてください。",
  },
  changelog: {
    en: "Keep a Changelog style: a version heading (## v1.2.0 — 2026-09-24), section titles such as Added or Fixed, and - items. A version line followed by items works too.",
    zh: "Keep a Changelog 格式：版本标题（## v1.2.0 — 2026-09-24）、Added 或 Fixed 这样的小节标题，加上以 - 开头的条目。一行版本号跟着若干条目也可以。",
    ja: "Keep a Changelog 形式です。バージョンの見出し（## v1.2.0 — 2026-09-24）、Added や Fixed などのセクション名、- で始まる項目。バージョン行に項目が続くだけでも認識します。",
  },
  terminal: {
    en: "The first line is a prompt ($, %, ❯, user@host:~$, PS C:\\>) followed by a command, and every other line is a prompt or its output. Errors and warnings are coloured; an exit status gets a pill.",
    zh: "第一行是提示符（$、%、❯、user@host:~$、PS C:\\>）加命令，其余每一行不是提示符就是输出。错误和警告会上色，退出码显示在小标签里。",
    ja: "1 行目がプロンプト（$、%、❯、user@host:~$、PS C:\\>）とコマンドで、残りの行はすべてプロンプトかその出力であること。エラーや警告には色を付け、終了コードはバッジで表示します。",
  },
  diff: {
    en: "A unified diff, as git diff or diff -u prints it: file headers, @@ hunks, and lines starting with +, - or a space. The added and removed lines are counted for the summary. A commit header from git show or git format-patch (sha, author, date, message) is drawn above it as written.",
    zh: "统一格式的 diff，就是 git diff 或 diff -u 输出的样子：文件头、@@ 块，以及以 +、- 或空格开头的行。增删的行数会统计在摘要里。git show 或 git format-patch 带的提交信息（哈希、作者、日期、说明）会原样画在上方。",
    ja: "git diff や diff -u が出力する unified diff です。ファイルのヘッダー、@@ のハンク、+・-・空白で始まる行。追加と削除の行数を数えて要約に表示します。git show や git format-patch のコミット情報（ハッシュ、作者、日付、メッセージ）は、そのまま上に表示します。",
  },
  error: {
    en: "An error line (TypeError: …, Exception in thread …, panic: …, PHP Fatal error: Uncaught …, Ruby's file.rb:12:in 'm': … (ErrorClass)) followed by its stack trace, or a Python traceback with the error last. Frames from libraries (node_modules, site-packages, gems, vendor…) are dimmed and your own are marked.",
    zh: "一行报错（TypeError: …、Exception in thread …、panic: …、PHP Fatal error: Uncaught …、Ruby 的 file.rb:12:in 'm': …（ErrorClass））加上调用栈，或错误在最后一行的 Python Traceback。依赖库里的帧（node_modules、site-packages、gems、vendor 等）会变淡，你自己的代码帧会被标出。",
    ja: "エラーの行（TypeError: …、Exception in thread …、panic: …、PHP Fatal error: Uncaught …、Ruby の file.rb:12:in 'm': …（ErrorClass） など）とスタックトレース、またはエラーが最後に来る Python の Traceback。ライブラリ（node_modules、site-packages、gems、vendor など）のフレームは薄く、自分のコードのフレームには印を付けます。",
  },
  timeline: {
    en: "An optional title, then two or more lines that each start with a time or a date (09:00, 2pm, Sep 24, Q3 2026, Monday) and say what happens. Logs with seconds or levels such as INFO are not schedules.",
    zh: "可选的标题，然后是两行以上、每行以时间或日期开头（09:00、下午3点、9月24日、Q3 2026、周一）并写明事项的内容。带秒数或 INFO 之类级别的日志不算日程。",
    ja: "任意のタイトルに続いて、時刻や日付（09:00、2pm、9月24日、Q3 2026、月曜など）で始まり予定が書かれた行が 2 行以上。秒や INFO などのレベルが付いたログは、スケジュールとはみなしません。",
  },
  stats: {
    en: "An optional title, then two to twelve “label: value” lines where every value is a number, optionally with a change such as +8% or (−3%). Rises are green, falls red.",
    zh: "可选的标题，然后是 2 到 12 行“标签：值”，每个值都是数字，后面可以跟 +8% 或（-4%）这样的变化。上涨显示绿色，下跌显示红色。",
    ja: "任意のタイトルに続いて、値がすべて数字の「ラベル：値」の行が 2〜12 行。+8% や（−3%）のような増減を添えられます。増加は緑、減少は赤で表示します。",
  },
  lyrics: {
    en: "Chosen by you: press L in Paste as… (⌥V). Any text works. Prose is cut into screens at its sentence ends and clause marks, short phrases kept together and long ones broken between words; song lyrics, LRC files and poems keep their own lines. JIZURA's markup works: / cuts a line, *word* is emphasis, a final ! flashes, lyric|note adds a note. Code and tables are better as an image, and it says so.",
    zh: "由你来选：在“粘贴为…”（⌥V）里按 L。任何文字都行：普通文字按句末和分句的标点切成一幕幕，短语不拆开，长句在词与词之间断开；歌词、LRC 文件和诗保留原来的分行。支持 JIZURA 的记法：/ 切分画面，*词* 强调，行末 ! 闪一下，歌词|注释 加小注。代码和表格更适合做成图片，它会直接告诉你。",
    ja: "選ぶのはあなた：「ペースト形式…」（⌥V）で L を押します。どんなテキストでも使えます。文章は文末や句の区切りで場面に分け、短い語句はまとめ、長い文は語の切れ目で分けます。歌詞、LRC ファイル、詩は元の行のまま。JIZURA の記法が使えます：/ でカットを分け、*語* で強調、行末の ! でフラッシュ、歌詞|注釈 で小さな注釈。コードや表は画像のほうが向いているので、そう伝えます。",
  },
  qr: {
    en: "Never chosen on its own: any text can be a QR code, so press Q in the ⌥V chooser. The code holds your text exactly as copied, and it is never sent to a model.",
    zh: "不会被自动选中：任何文字都能变成二维码，所以要在 ⌥V 面板里按 Q。二维码里就是你复制的原文，一字不改，也不会发给任何模型。",
    ja: "自動では選ばれません。どんなテキストでも QR コードにできるので、⌥V のパネルで Q を押してください。コードの中身はコピーしたテキストそのままで、モデルには送りません。",
  },
};

/** Home page: the strip under the hero and the compact gallery, as template-variant. */
export const HOME_STRIP: readonly string[] = [
  "text-poster", "code-classic", "chat-classic", "stats-editorial", "info-editorial", "diagram-editorial",
  "quote-editorial", "terminal-classic", "changelog-classic", "timeline-classic", "table-classic", "diff-classic",
];
/** Two large and four small: two even rows on a wide screen. */
export const HOME_PICKS: readonly string[] = ["text-poster", "code-classic", "error-editorial", "stats-classic", "chat-classic", "timeline-editorial"];
