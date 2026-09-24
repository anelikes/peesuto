import type { TemplateContent, TemplatePlan, VariantId } from "../../src/templates/types.ts";

export const TEMPLATE_SAMPLES: readonly TemplateContent[] = [
  { kind: "text", paragraphs: ["好的设计，是把复杂留给自己，把简单留给别人。"] },
  { kind: "document", paragraphs: ["把复杂的想法，讲得简单。", "A good note makes room for a clearer thought.\n先记录，再整理，最后分享。"] },
  { kind: "quote", text: "一个人只拥有此生此世是不够的，他还应该拥有诗意的世界。", author: "王小波" },
  { kind: "code", language: "TypeScript", code: "const greet = (name: string) => {\n  return `Hello, ${name}!`;\n};\nconsole.log(greet('世界'));" },
  { kind: "stat", value: "37%", label: "本季度活跃用户增长\nSmall improvements, compounded daily." },
  { kind: "list", ordered: true, items: ["先把问题写清楚", "一次只改一个变量", "Measure the result before adding more."] },
  { kind: "chat", turns: [{ speaker: "小林", text: "今天有什么值得记录的进展？" }, { speaker: "Alex", text: "The native app feels quieter. 🎉" }, { speaker: "小林", text: "把表达留给内容，把复杂留给工具。" }] },
  { kind: "table", headers: ["项目", "状态", "结果"], rows: [["原生界面", "完成", "更清晰"], ["模板渲染", "验证", "保留结构"]] },
  { kind: "diagram", direction: "TD", nodes: [{ id: "A", label: "复制文字", shape: "pill" }, { id: "B", label: "有结构吗？", shape: "diamond" }, { id: "C", label: "专门模板", shape: "rect" }, { id: "D", label: "Text template", shape: "round" }],
    edges: [{ from: "A", to: "B", line: "solid", arrow: true }, { from: "B", to: "C", label: "有", line: "solid", arrow: true }, { from: "B", to: "D", label: "没有", line: "dotted", arrow: true }] },
  { kind: "info", title: "测试环境账号", fields: [
    { label: "手机", value: "13800138000", type: "phone" }, { label: "邮箱", value: "ops@example.com", type: "email" },
    { label: "Host", value: "https://staging.example.com", type: "url" }, { label: "API Key", value: "sk-proj-4f8a2c9e1b7d3a6f0e5c8b2a", type: "secret" },
    { label: "备注", value: "只用于联调，别发到群里", type: "plain" },
  ] },
  { kind: "changelog", releases: [{ version: "v1.2.0", date: "2026-09-24", sections: [
    { title: "新增", type: "added", items: ["卡片签名", "Release notes become **cards**"] }, { title: "Fixed", type: "fixed", items: ["长代码行自动换行"] },
  ] }] },
  { kind: "terminal", lines: [
    { kind: "prompt", prompt: "nya@mbp:~/peesuto$ ", command: "bun test core/tests" },
    { kind: "output", text: " 512 pass" }, { kind: "output", text: " 0 fail" },
    { kind: "prompt", prompt: "nya@mbp:~/peesuto$ ", command: "git push 推送" },
    { kind: "output", text: "error: failed to push some refs", tone: "error" }, { kind: "exit", text: "[exit 1]", ok: false },
  ] },
  { kind: "diff", files: [{ path: "core/src/render/fonts.ts", meta: [], hunks: [{ header: "@@ -1,4 +1,5 @@ export const FONTS = {", lines: [
    { type: "context", text: " export const FONTS = {" }, { type: "del", text: "-  code: \"NotoSansSC\"," }, { type: "add", text: "+  code: \"PeesutoCode\", // 等宽" },
    { type: "add", text: "+  fallback: \"NotoSansSC\"," }, { type: "context", text: "   text: \"NotoSansSC\"," }, { type: "context", text: " };" },
  ] }] }] },
  { kind: "error", type: "Error", message: "ENOENT: no such file or directory, open '/srv/配置/actions.json'", trace: [
    { text: "at Object.openSync (node:fs:601:3)", role: "frame", own: false },
    { text: "at loadActions (/srv/paste/core/src/actions/load.ts:18:22)", role: "frame", own: true },
    { text: "at async handle (/srv/paste/core/src/daemon/server.ts:77:12)", role: "frame", own: true },
  ] },
  { kind: "timeline", title: "发布日程", events: [
    { time: "09:00", text: "冻结代码" }, { time: "10:30–11:00", text: "Regression tests on every template" }, { time: "下午5点", text: "发布 🎉" },
  ] },
  { kind: "stats", title: "本周数据", metrics: [
    { label: "日活", value: "12,480", delta: "+8%" }, { label: "Revenue", value: "$48.2k", delta: "−3.1% WoW" }, { label: "转化率", value: "3.2%" },
  ] },
  { kind: "lyrics", title: "晴天", credit: "Peesuto", stanzas: [
    { label: "[Verse]", lines: [{ text: "故事的小黄花", at: 12340, until: 15800 }, { text: "I remember the dawn", breaks: [11], at: 15800, until: 19200 }] },
    { lines: [{ text: "透明な風が吹いて", emphasis: [[0, 2]], note: "とうめい" }, { text: "Hold on to me!", at: 22600 }] },
  ] },
  { kind: "comparison", columns: [{ title: "Before", items: ["许多零散入口", "Manual formatting", "重复整理内容"] }, { title: "After", items: ["一个明确动作", "Structured templates", "把时间留给创作"] }] },
];
export const samplePlan = (content: TemplateContent, variant: VariantId = "classic", motion: TemplatePlan["motion"] = "none", emphasis?: string): TemplatePlan => ({
  version: 1, template: content.kind, variant, motion, sourceText: JSON.stringify(content), content, aspect: "1:1", ...(emphasis ? { emphasis } : {}),
});
