/**
 * Clipboard scenarios for the Studio (scripts/studio.ts) and the static gallery
 * (scripts/gallery.ts). Add a scenario here and both pick it up; `group` is the
 * sidebar heading (ungrouped ones go under 其他).
 */
export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly group?: string;
}

export const SCENARIOS: readonly Scenario[] = [
  { id: "short", title: "一句话", text: "少即是多。", group: "文字" },
  { id: "slogan", title: "一句中文文案", text: "好的设计，是把复杂留给自己，把简单留给别人。", group: "文字" },
  { id: "english", title: "英文短句", text: "Make it work, make it right, make it fast.", group: "文字" },
  { id: "paragraph", title: "两段感想", text: "我们总以为效率来自更快的工具，其实更多来自更少的切换。把一件事做完再开始下一件，比同时开着十个窗口要快得多。\n\n今天就试试：关掉不用的标签页。", group: "文字" },
  { id: "emoji", title: "带 emoji 的消息", text: "周五下午茶到了 🍰☕️ 大家自取，顺便庆祝新版本上线 🎉", group: "文字" },
  { id: "quote", title: "带作者的引语", text: "“一个人只拥有此生此世是不够的，他还应该拥有诗意的世界。”——王小波", group: "引用" },
  { id: "quote-en", title: "英文引用块", text: "> Simplicity is prerequisite for reliability.\n— Edsger W. Dijkstra", group: "引用" },
  { id: "stat", title: "数据指标", text: "本季度活跃用户增长: 37%", group: "数据与列表" },
  { id: "list", title: "有序清单", text: "1. 先把问题写清楚\n2. 一次只改一个变量\n3. 量化结果再继续", group: "数据与列表" },
  { id: "bullets", title: "无序清单（英文）", text: "- Ship the native app\n- Record the release notes\n- Ask ten people to try it", group: "数据与列表" },
  { id: "code", title: "代码块", text: "```ts\nconst greet = (name: string) => {\n  return `Hello, ${name}!`;\n};\nconsole.log(greet(\"世界\"));\n```", group: "代码" },
  { id: "command", title: "终端命令", text: "git log --oneline -5 --author=anelikes", group: "代码" },
  { id: "code-python", title: "Python（中文注释）", text: "```python\nimport json\n\n# 读取配置并返回默认值 🎯\ndef load_config(path: str, default: dict | None = None) -> dict:\n    \"\"\"从文件加载配置；文件不存在时返回默认值。\"\"\"\n    try:\n        with open(path, encoding=\"utf-8\") as f:\n            return json.load(f)\n    except FileNotFoundError:\n        return default or {\"语言\": \"中文\", \"重试\": 3}\n```", group: "代码" },
  { id: "code-ts", title: "TypeScript", text: "```ts\ninterface Clip { id: number; text: string; pinned?: boolean }\n\nexport async function latest(clips: Clip[], limit = 5): Promise<Clip[]> {\n  const sorted = [...clips].sort((a, b) => b.id - a.id);\n  return sorted.filter((c) => !c.pinned).slice(0, limit);\n}\n```", group: "代码" },
  { id: "code-sql", title: "SQL 查询", text: "```sql\n-- 最近 7 天每个应用的复制次数\nSELECT app, COUNT(*) AS copies, MAX(created_at) AS last_seen\nFROM clipboard_history\nWHERE created_at >= NOW() - INTERVAL '7 days'\n  AND app <> 'Peesuto'\nGROUP BY app\nORDER BY copies DESC\nLIMIT 10;\n```", group: "代码" },
  { id: "code-shell", title: "终端会话", text: "$ bun install --frozen-lockfile\nbun install v1.3.11\n  + highlight.js@11.12.0\n$ bun test core/tests | tail -3\n 493 pass\n 0 fail\n$ git status --short\n M core/src/templates/compose.ts", group: "代码" },
  { id: "code-json", title: "JSON 配置", text: "{\n  \"name\": \"peesuto\",\n  \"version\": \"0.1.1\",\n  \"shortcuts\": { \"panel\": \"⌘⇧V\", \"card\": \"⌘⌥1\" },\n  \"privacy\": { \"offline\": true, \"rules\": [\"secrets\", \"email\"] },\n  \"theme\": null\n}", group: "代码" },
  { id: "code-go", title: "Go", text: "```go\npackage main\n\nimport (\n\t\"fmt\"\n\t\"strings\"\n)\n\n// 把每个单词的首字母大写\nfunc title(words []string) string {\n\tfor i, w := range words {\n\t\twords[i] = strings.ToUpper(w[:1]) + w[1:]\n\t}\n\treturn strings.Join(words, \" \")\n}\n\nfunc main() { fmt.Println(title([]string{\"hello\", \"gopher\"})) }\n```", group: "代码" },
  { id: "code-diff", title: "代码 diff", text: "```diff\ndiff --git a/core/src/render/fonts.ts b/core/src/render/fonts.ts\n@@ -1,4 +1,5 @@\n export const FONTS = {\n-  code: \"NotoSansSC\",\n+  code: \"PeesutoCode\",\n+  fallback: \"NotoSansSC\",\n   text: \"NotoSansSC\",\n };\n```", group: "代码" },
  { id: "chat", title: "带标签的对话", text: "用户: 这个快捷键在哪里改？\n助手: 设置 → 通用 → 快捷键，点一下就能录新的组合。\n用户: 找到了，谢谢！", group: "对话" },
  { id: "chat-app", title: "从聊天软件复制的记录（长，会滚动）", text: "nok\n2026年09月22日 22:10\n如果ty不去武汉的话我整一个看看\n\nshybee\n2026年09月23日  0:10\n@nok \n\nshybee\n2026年09月23日  0:10\n全聚德\n\nshybee\n2026年09月23日  0:11\n明天吃这个不\n\nnok\n2026年09月23日  8:20\n牛逼\n\nnok\n2026年09月23日  8:20\nok", group: "对话" },
  { id: "table", title: "Markdown 表格", text: "| 项目 | 状态 | 负责人 |\n| --- | --- | --- |\n| 原生界面 | 完成 | nok |\n| 模板渲染 | 验证中 | shybee |\n| 签名公证 | 待证书 | — |", group: "数据与列表" },
  { id: "comparison", title: "前后对比", text: "之前:\n许多零散入口\n\n手动排版\n\n之后:\n一个明确动作\n\n自动选择模板", group: "数据与列表" },
  { id: "markdown", title: "Markdown 笔记", text: "# 周会纪要\n\n本周完成了原生版迁移，**所有测试通过**。\n\n- 文字模板上线\n- 聊天记录可以滚动\n\n## 下周\n\n准备第一次签名发布。", group: "文档" },
  { id: "long", title: "长文（超过一屏）", text: Array.from({ length: 6 }, (_, i) => `第 ${i + 1} 段。把复杂的想法讲清楚，需要先把它想清楚，再删掉所有不必要的部分，最后留下的每一句话都应该有它存在的理由。写作如此，做产品也如此。`).join("\n\n"), group: "文字" },
  { id: "mermaid-decision", title: "Mermaid 判断流程", text: "```mermaid\nflowchart TD\n    A([用户复制文字]) --> B{有明确结构吗?}\n    B -->|有| C[专门模板]\n    B -->|没有| D{够短吗?}\n    D -->|是| E[文字模板]\n    D -->|否| F[文档模板]\n    C --> G([渲染并粘贴])\n    E --> G\n    F --> G\n```", group: "流程图" },
  { id: "mermaid-cycle", title: "Mermaid 带回环", text: "flowchart TD\n  A[写代码] --> B[跑测试]\n  B -- 失败 --> A\n  B -- 通过 --> C[提交]\n  C -.-> D[(发布)]", group: "流程图" },
  { id: "mermaid-lr", title: "Mermaid 横向流水线", text: "graph LR\n  clip[剪贴板] --> parse[解析] --> decide[选模板] --> layout[排版] --> render[渲染]", group: "流程图" },
  { id: "arrow-chain", title: "一行箭头链", text: "需求 → 设计 → 开发 → 测试 → 上线", group: "流程图" },
  // 隐私：以下密钥全是编造的（FAKE），只用来看脱敏效果，任何服务都不认。
  { id: "privacy-env", title: "带密钥的配置片段", text: "# 本地开发配置\nOPENAI_API_KEY=sk-proj-FAKEfake0000FAKEfake1111FAKE\nDATABASE_URL=postgres://app:fake-pass-123@db.internal:5432/app\nDEBUG=true", group: "隐私" },
  { id: "privacy-chat", title: "消息里夹着令牌与密码", text: "我把测试环境的登录信息发你：\n账号 demo，密码：Fake#2026pass\n接口加请求头 Authorization: Bearer FAKEtoken0000fake1111FAKE 就行，用完记得换掉。", group: "隐私" },
  { id: "privacy-contact", title: "联系方式（个人信息规则默认关闭）", text: "周五评审改到 3 点，有问题找小王：13800000000，wang.fake@example.com。GitHub 令牌 ghp_FAKEfakeFAKEfakeFAKEfakeFAKEfake0000 已作废。", group: "隐私" },
  { id: "arrow-branches", title: "多行箭头链（分支与汇合）", text: "登录 -> 首页 -> 设置\n首页 -> 历史\n历史 -> 详情 -> 设置", group: "流程图" },
  { id: "qr-url", title: "网址（用 ⌘⌥4 转二维码）", text: "https://peesuto.com/download?ref=clipboard", group: "二维码" },
  { id: "qr-note", title: "多行留言（二维码不参与自动选择）", text: "明天下午三点，老地方见。\n记得带上那本《诗意的世界》🎉", group: "二维码" },
];
