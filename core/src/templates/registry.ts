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
];

export function templateRegistration(id: TemplateId): TemplateRegistration {
  return TEMPLATE_REGISTRY.find((entry) => entry.id === id)!;
}
