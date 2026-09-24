import { MOTIONS, type TemplateId, type TemplateMotion, type VariantId } from "./types.ts";

export interface TemplateRegistration {
  readonly id: TemplateId;
  readonly name: string;
  readonly nameZh: string;
  readonly variants: readonly { readonly id: VariantId; readonly name: string; readonly nameZh: string }[];
  readonly motions: readonly TemplateMotion[];
}

/** Public registry used by templates.list and the constrained Jev questions. */
export const TEMPLATE_REGISTRY: readonly TemplateRegistration[] = [
  { id: "text", name: "Text", nameZh: "文字", variants: [
    { id: "classic", name: "Paper", nameZh: "纸面" }, { id: "editorial", name: "Ink", nameZh: "墨色" }, { id: "poster", name: "Poster", nameZh: "海报" },
  ], motions: MOTIONS },
  { id: "document", name: "Document", nameZh: "文档", variants: [
    { id: "classic", name: "Reading page", nameZh: "阅读页" }, { id: "editorial", name: "Editorial column", nameZh: "杂志专栏" },
  ], motions: MOTIONS },
  { id: "quote", name: "Quote", nameZh: "引用", variants: [
    { id: "classic", name: "Book excerpt", nameZh: "书摘" }, { id: "editorial", name: "Statement", nameZh: "大字引言" },
  ], motions: MOTIONS },
  { id: "code", name: "Code", nameZh: "代码", variants: [
    { id: "classic", name: "Terminal", nameZh: "终端" }, { id: "editorial", name: "Code notebook", nameZh: "代码笔记" },
  ], motions: MOTIONS },
  { id: "stat", name: "Statistic", nameZh: "数据", variants: [
    { id: "classic", name: "Big number", nameZh: "醒目数字" }, { id: "editorial", name: "Metric strip", nameZh: "指标条" },
  ], motions: MOTIONS },
  { id: "list", name: "List", nameZh: "列表", variants: [
    { id: "classic", name: "Checklist", nameZh: "清单" }, { id: "editorial", name: "Stacked steps", nameZh: "分步卡片" },
  ], motions: MOTIONS },
  { id: "chat", name: "Conversation", nameZh: "对话", variants: [
    { id: "classic", name: "Chat bubbles", nameZh: "对话气泡" }, { id: "editorial", name: "Transcript", nameZh: "对话实录" },
  ], motions: MOTIONS },
  { id: "table", name: "Table", nameZh: "表格", variants: [
    { id: "classic", name: "Data grid", nameZh: "数据网格" }, { id: "editorial", name: "Editorial ledger", nameZh: "简洁账表" },
  ], motions: MOTIONS },
  { id: "comparison", name: "Comparison", nameZh: "对比", variants: [
    { id: "classic", name: "Side by side", nameZh: "左右对照" }, { id: "editorial", name: "Split panels", nameZh: "分区对比" },
  ], motions: MOTIONS },
  { id: "diagram", name: "Diagram", nameZh: "流程图", variants: [
    { id: "classic", name: "Flow", nameZh: "流程" }, { id: "editorial", name: "Blueprint", nameZh: "蓝图" },
  ], motions: MOTIONS },
  { id: "info", name: "Info card", nameZh: "信息卡", variants: [
    { id: "classic", name: "Field list", nameZh: "信息清单" }, { id: "editorial", name: "Credentials", nameZh: "深色凭证" },
  ], motions: MOTIONS },
  { id: "changelog", name: "Release notes", nameZh: "更新日志", variants: [
    { id: "classic", name: "Release card", nameZh: "发布卡片" }, { id: "editorial", name: "Timeline", nameZh: "时间线" },
  ], motions: MOTIONS },
  { id: "terminal", name: "Terminal session", nameZh: "终端会话", variants: [
    { id: "classic", name: "Night terminal", nameZh: "夜色终端" }, { id: "editorial", name: "Command log", nameZh: "命令记录" },
  ], motions: MOTIONS },
  { id: "diff", name: "Diff", nameZh: "代码差异", variants: [
    { id: "classic", name: "Review", nameZh: "审阅卡片" }, { id: "editorial", name: "Night diff", nameZh: "夜色差异" },
  ], motions: MOTIONS },
  { id: "error", name: "Error", nameZh: "报错", variants: [
    { id: "classic", name: "Crash report", nameZh: "崩溃报告" }, { id: "editorial", name: "Console", nameZh: "控制台" },
  ], motions: MOTIONS },
  { id: "timeline", name: "Schedule", nameZh: "日程", variants: [
    { id: "classic", name: "Agenda", nameZh: "议程" }, { id: "editorial", name: "Milestones", nameZh: "里程碑" },
  ], motions: MOTIONS },
  { id: "stats", name: "Metrics", nameZh: "多项指标", variants: [
    { id: "classic", name: "Dashboard", nameZh: "仪表板" }, { id: "editorial", name: "Scoreboard", nameZh: "记分板" },
  ], motions: MOTIONS },
  { id: "lyrics", name: "Lyrics", nameZh: "歌词", variants: [
    { id: "classic", name: "Stage", nameZh: "舞台" }, { id: "editorial", name: "Paper", nameZh: "纸面" },
  ], motions: MOTIONS },
  { id: "qr", name: "QR code", nameZh: "二维码", variants: [
    { id: "classic", name: "Plain", nameZh: "纯净" }, { id: "editorial", name: "Card", nameZh: "卡片" },
  ], motions: ["none", "reveal"] },
];

/** Templates the model and the local rules never pick; only an explicit override does. */
export const MANUAL_TEMPLATES: readonly TemplateId[] = ["qr"];

export function templateRegistration(id: TemplateId): TemplateRegistration {
  return TEMPLATE_REGISTRY.find((entry) => entry.id === id)!;
}

export function templateHasVariant(id: TemplateId, variant: string): variant is VariantId {
  return templateRegistration(id).variants.some((entry) => entry.id === variant);
}
