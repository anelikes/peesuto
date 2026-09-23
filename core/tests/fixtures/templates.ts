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
  { kind: "comparison", columns: [{ title: "Before", items: ["许多零散入口", "Manual formatting", "重复整理内容"] }, { title: "After", items: ["一个明确动作", "Structured templates", "把时间留给创作"] }] },
];
export const samplePlan = (content: TemplateContent, variant: VariantId = "classic", motion: TemplatePlan["motion"] = "none", emphasis?: string): TemplatePlan => ({
  version: 1, template: content.kind, variant, motion, sourceText: JSON.stringify(content), content, aspect: "1:1", ...(emphasis ? { emphasis } : {}),
});
