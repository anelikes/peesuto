import { classify } from "../render/classify.ts";
import { parseArrowChains, parseMermaid } from "./diagram.ts";
import { TEMPLATE_MAX_GRAPHEMES, TEXT_MAX_GRAPHEMES, TemplateInputError, type DocumentBlock, type TemplateContent, type TemplateId } from "./types.ts";

export interface ParsedTemplates {
  readonly sourceText: string;
  readonly preferred: TemplateId;
  readonly candidates: ReadonlyMap<TemplateId, TemplateContent>;
}

/** Only source-backed, complete structures become specialized templates.
 * Ambiguous text always retains a document candidate and is never rewritten. */
export function parseTemplates(sourceText: string): ParsedTemplates {
  if (typeof sourceText !== "string" || !sourceText.trim()) throw new TemplateInputError("Template input must contain text.");
  assertTemplateLength(sourceText);
  const normalized = cleanInvisible(sourceText.replace(/\r\n?/g, "\n"));
  // Blank boundary lines do not change structure. Leading indentation and
  // trailing tabs can be meaningful code, nesting, or empty TSV cells.
  const text = trimBlankLines(normalized);
  const candidates = new Map<TemplateId, TemplateContent>();
  candidates.set("document", { kind: "document", paragraphs: normalized.split(/\n[\t ]*\n+/), blocks: documentBlocks(normalized) });
  // A fenced block must consume the entire input, including its closing fence.
  const code = parseCode(text);
  // A Mermaid flowchart, fenced as ```mermaid or bare, is a diagram; the
  // fenced source stays available as code.
  const mermaid = code?.kind === "code" && (!code.language || /^mermaid$/i.test(code.language)) ? parseMermaid(code.code) : parseMermaid(text.trim());
  if (mermaid) candidates.set("diagram", mermaid);
  if (code) candidates.set("code", code);
  else if (!mermaid) {
    const table = parseTable(text);
    const comparison = parseComparison(text);
    const quote = isRawCode(text) ? undefined : parseQuote(text);
    const list = parseList(text);
    const chat = parseChat(text) ?? parseTranscript(text);
    const stat = parseStat(text);
    for (const content of [table, comparison, quote, list, chat, stat]) {
      if (content) candidates.set(content.kind, content);
    }
    // The legacy classifier also understands commands, JSON and stack traces.
    // Keep those capabilities without treating malformed tables or mixed
    // Markdown containing a fence as one large code block.
    if (candidates.size === 1 && isRawCode(text.trim())) candidates.set("code", { kind: "code", code: normalized });
    // Arrow chains: every line "A → B → C". Code (JS `=>`) never qualifies.
    if (!candidates.has("code")) {
      const chains = parseArrowChains(text);
      if (chains) candidates.set("diagram", chains);
    }
  }
  const prose = parseText(text, candidates);
  if (prose) candidates.set("text", prose);
  // A recognized structure wins; short plain prose is typography; the rest is a document.
  const preferred = PREFERENCE.find((id) => candidates.has(id)) ?? (prose ? "text" : "document");
  return { sourceText, preferred, candidates };
}

/** Which recognized structure wins when several parse. */
const PREFERENCE: readonly TemplateId[] = ["diagram", "code", "table", "comparison", "quote", "list", "chat", "stat"];

/** Short prose with no structure of its own: at most TEXT_MAX_GRAPHEMES visible
 * characters and eight paragraphs, no Markdown blocks, and no structure a
 * specialized template would lose (code, table, list, chat, comparison).
 * Quotes and statistics keep text as an alternative. */
function parseText(text: string, candidates: ReadonlyMap<TemplateId, TemplateContent>): TemplateContent | undefined {
  if (["code", "table", "list", "chat", "comparison"].some((id) => candidates.has(id as TemplateId))) return;
  if (/^(?:graph|flowchart)\b/i.test(text.trim())) return;
  if (exceedsGraphemes(text, TEXT_MAX_GRAPHEMES) !== undefined) return;
  const blocks = documentBlocks(text);
  if (!blocks.length || blocks.some((block) => block.kind !== "paragraph")) return;
  if (/\*\*[^*\n]+\*\*/.test(text)) return;
  const lines = text.split("\n").filter((line) => line.trim());
  // Layout-bearing source (indentation, tabs, pipes, list markers, field labels) stays a document.
  if (lines.some((line) => /^[\t ]|\t|\||^(?:[-*•]|\d+[.)、])[\t ]|^(?:`{3,}|~{3,})|^>|[:：][\t ]*$/.test(line))) return;
  if (lines.filter((line) => /^[^:：\n]{1,40}[:：][\t ]*\S/.test(line)).length >= 2) return;
  const paragraphs = text.split(/\n[\t ]*\n+/).map((paragraph) => paragraph.trim()).filter(Boolean);
  if (!paragraphs.length || paragraphs.length > 8 || lines.length > 12) return;
  return { kind: "text", paragraphs };
}

/** Invisible characters chat apps insert (WeChat puts U+2005 after an @mention)
 * that the card font has no glyph for. Unusual spaces become a plain space;
 * zero-width, bidi and soft-hyphen controls are dropped. The zero-width joiner
 * and variation selectors stay: emoji sequences need them. The ideographic
 * space U+3000 is drawn by the font and stays. */
export function cleanInvisible(text: string): string {
  return text
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F]/g, " ")
    .replace(/[\u00AD\u180E\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, "");
}

function trimBlankLines(text: string): string {
  return text.replace(/^(?:[\t ]*\n)+/, "").replace(/(?:\n[\t ]*)+$/, "");
}

function parseCode(text: string): TemplateContent | undefined {
  const match = text.match(/^(`{3,}|~{3,})([\w.+#-]*)[^\S\n]*\n([\s\S]*?)\n\1$/);
  if (!match || !match[3]!.trim()) return;
  if (match[3]!.split("\n").some((line) => line.trim() === match[1])) return;
  return { kind: "code", code: match[3]!, ...(match[2] ? { language: match[2] } : {}) };
}

function parseQuote(text: string): TemplateContent | undefined {
  let body = text;
  let author: string | undefined;
  // Attribution is recognized only as explicit source syntax; no author is inferred.
  const attribution = body.match(/(?:\n|(?<=[”」』"])[\t ]*)(?:——|—|--)[\t ]*([^\n]{1,100})$/);
  if (attribution) {
    author = attribution[1]!.trim();
    body = body.slice(0, attribution.index).trim();
  }
  if (!body) return;
  if (body.split("\n").every((line) => /^>[\t ]?/.test(line))) {
    body = body.split("\n").map((line) => line.replace(/^>[\t ]?/, "")).join("\n");
  } else {
    const quotes: Record<string, string> = { "“": "”", "「": "」", "『": "』", '"': '"' };
    const closing = quotes[body[0]!];
    if (closing && body.endsWith(closing) && body.length > 2) body = body.slice(1, -1);
    else if (!author) return;
  }
  return { kind: "quote", text: body, ...(author ? { author } : {}) };
}

function parseList(text: string): TemplateContent | undefined {
  const lines = text.split("\n");
  if (lines.length < 2 || lines.some((line) => !line.trim())) return;
  const parts = lines.map((line) => line.match(/^[\t ]*(?:([-*•])|(\d+)[.)、])[\t ]+(.+)$/));
  if (parts.some((part) => !part)) return;
  const ordered = Boolean(parts[0]![2]);
  if (parts.some((part) => Boolean(part![2]) !== ordered)) return;
  // The renderer numbers ordered items from 1. Nonsequential/custom numbering
  // stays a document rather than silently changing the author's numbering.
  if (ordered && parts.some((part, index) => Number(part![2]) !== index + 1)) return;
  // Nested indentation is meaningful; don't flatten a tree into a simple list.
  const indents = lines.map((line) => line.match(/^[\t ]*/)?.[0] ?? "");
  if (indents.some((indent) => indent !== indents[0])) return;
  return { kind: "list", ordered, items: parts.map((part) => part![3]!) };
}

function parseChat(text: string): TemplateContent | undefined {
  const lines = text.split("\n");
  if (lines.length < 2) return;
  const matches = lines.map((line) => line.match(/^(?:\[([^\]\n]{1,32})\]|([^:\n：]{1,32}))[:：][\t ]*(\S.*)$/));
  if (matches.some((match) => !match)) return;
  const turns = matches.map((match) => ({ speaker: (match![1] ?? match![2])!.trim(), text: match![3]! }));
  const speakers = new Set(turns.map((turn) => turn.speaker));
  if (speakers.size < 2) return;
  if (turns.some((turn) => /^(?:name|age|address|email|phone|url|date|time|title|status|id|姓名|年龄|地址|邮箱|电话|日期|时间|标题|状态|编号)$/i.test(turn.speaker))) return;
  // Two arbitrary key:value fields are not proof of a conversation. Require
  // explicit [speaker] labels, recognizable dialogue roles, or a returning turn.
  const roles = /^(?:user|assistant|system|human|ai|alice|bob|a|b|q|answer|question|我|你|甲|乙|用户|助手|问|答|张三|李四)$/i;
  const explicit = matches.every((match) => Boolean(match![1]));
  const knownRoles = turns.every((turn) => roles.test(turn.speaker));
  const returningTurn = turns.length >= 3 && turns.some((turn, i) => i >= 2 && turns.slice(0, i - 1).some((previous) => previous.speaker === turn.speaker));
  if (!explicit && !knownRoles && !returningTurn) return;
  return { kind: "chat", turns };
}

/** A timestamp as chat apps copy it: a date and a time, or a time alone. */
const CLOCK = String.raw`(?:(?:上午|下午|凌晨|中午|晚上)\s*)?\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp]\.?[Mm]\.?)?`;
const DAY = String.raw`(?:\d{4}[年/.-]\d{1,2}[月/.-]\d{1,2}日?|\d{1,2}[月/]\d{1,2}日?|昨天|今天|前天|星期[一二三四五六日天]|周[一二三四五六日天]|Yesterday|Today)`;
const TIME_LINE = new RegExp(`^\\s*\\[?(?:${DAY}[\\s,]*)?${CLOCK}\\]?\\s*$`, "i");
const NAME_TIME_LINE = new RegExp(`^(\\S[^\\n]{0,31}?)[\\s,]+\\[?((?:${DAY}[\\s,]*)?${CLOCK})\\]?\\s*$`, "i");

/** Messages as chat apps copy them: a speaker line and a timestamp line (or
 * both on one line), then the message lines, repeated. Every line must belong
 * to such a block; names and times are kept verbatim, nothing is inferred. */
function parseTranscript(text: string): TemplateContent | undefined {
  const lines = text.split("\n");
  const headers: { index: number; next: number; speaker: string; time: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const next = lines[i + 1]?.trim() ?? "";
    if (TIME_LINE.test(next) && !TIME_LINE.test(line) && [...line].length <= 32) { headers.push({ index: i, next: i + 2, speaker: line, time: next }); i++; continue; }
    const combined = line.match(NAME_TIME_LINE);
    if (combined && !TIME_LINE.test(combined[1]!)) headers.push({ index: i, next: i + 1, speaker: combined[1]!.trim(), time: combined[2]!.trim() });
  }
  if (headers.length < 2 || lines.slice(0, headers[0]!.index).some((line) => line.trim())) return;
  const turns: { speaker: string; text: string; time: string }[] = [];
  for (const [n, header] of headers.entries()) {
    const end = headers[n + 1]?.index ?? lines.length;
    const body = trimBlankLines(lines.slice(header.next, end).join("\n")).trim();
    if (!body) return; // An empty message (an image, a sticker) is not text we can show.
    turns.push({ speaker: header.speaker, text: body, time: header.time });
  }
  return { kind: "chat", turns };
}

/** Split unescaped pipes. Markdown escapes are syntax, not visible backslashes. */
function pipeCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && inner[i + 1] === "|") { cell += "|"; i++; }
    else if (inner[i] === "|") { cells.push(cell.trim()); cell = ""; }
    else cell += inner[i];
  }
  cells.push(cell.trim());
  return cells;
}

function parseTable(text: string): TemplateContent | undefined {
  const lines = text.split("\n");
  if (lines.length < 2) return;
  if (lines.every((line) => line.includes("\t"))) {
    const rows = lines.map((line) => line.split("\t"));
    const width = rows[0]!.length;
    if (width < 2 || rows.some((row) => row.length !== width) || rows[0]!.some((cell) => !cell.trim())) return;
    return { kind: "table", headers: rows[0]!, rows: rows.slice(1) };
  }
  if (lines.length < 3 || !lines.every((line) => line.includes("|"))) return;
  const cells = lines.map(pipeCells);
  const width = cells[0]!.length;
  if (width < 2 || cells.some((row) => row.length !== width) || cells[0]!.some((cell) => !cell)) return;
  if (!cells[1]!.every((cell) => /^:?-{3,}:?$/.test(cell))) return;
  return { kind: "table", headers: cells[0]!, rows: cells.slice(2) };
}

function parseComparison(text: string): TemplateContent | undefined {
  const lines = text.split("\n");
  const headings = lines.map((line, index) => {
    const match = line.match(/^(?:#{1,3}\s+)?([^:\n：]{1,40})[:：]$/);
    return match ? { title: match[1]!.trim(), index } : null;
  }).filter((heading): heading is { title: string; index: number } => heading !== null);
  if (headings.length !== 2 || headings[0]!.index !== 0) return;
  const [first, second] = headings as [typeof headings[number], typeof headings[number]];
  const pair = `${first.title.toLowerCase()}|${second.title.toLowerCase()}`;
  const pairs = new Set(["before|after", "pros|cons", "advantages|disadvantages", "option a|option b", "a|b", "之前|之后", "改进前|改进后", "优点|缺点", "优势|劣势", "方案a|方案b", "方案 a|方案 b"]);
  if (!pairs.has(pair)) return;
  const left = trimBlankLines(lines.slice(1, second.index).join("\n"));
  const right = trimBlankLines(lines.slice(second.index + 1).join("\n"));
  if (!left || !right) return;
  // Keep all source lines, including bullets, rather than fabricating symmetric points.
  return { kind: "comparison", columns: [
    { title: first.title, items: left.split(/\n[\t ]*\n+/) },
    { title: second.title, items: right.split(/\n[\t ]*\n+/) },
  ] };
}

function parseStat(text: string): TemplateContent | undefined {
  const scalar = "[+-]?(?:[$€£¥￥]\\s*)?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?(?:\\s*(?:%|％|倍|人|次|个|万|亿|元|ms|s|kg|MB|GB|k|M|B))?";
  const labeled = text.match(new RegExp(`^([^\\n:：]{1,80})[:：]\\s*(${scalar})$`, "i"));
  if (labeled) return { kind: "stat", label: labeled[1]!.trim(), value: labeled[2]! };
  const lines = text.split("\n");
  // A bare number on its own could be a year or an ID. A dedicated label is required.
  if (lines.length === 2 && new RegExp(`^${scalar}$`, "i").test(lines[0]!) && /^[^\d\n][^\n]{0,79}$/.test(lines[1]!)) {
    return { kind: "stat", value: lines[0]!, label: lines[1]! };
  }
  return;
}

function isRawCode(text: string): boolean {
  if (/^[\t ]*(?:`{3,}|~{3,})/m.test(text)) return false;
  if (/^(?:\$\s+\S|(?:curl|docker|git|kubectl)\s+\S)[^\n]*$/.test(text)) return true;
  if (classify(text) !== "code") return false;
  return /^\s*(?:\{[\s\S]*\}|\[[\s\S]*\])$/.test(text)
    || /^\s*(?:\$\s+\S|(?:curl|docker|git|kubectl)\s+\S|(?:const|let|var)\s+\w+\s*[=:]|(?:import|export)\s+.+["';{}]|(?:def|function|func|fn)\s+\w+\s*\(|(?:SELECT|INSERT|UPDATE|DELETE)\s+|#include\s*[<"])/m.test(text)
    || /^(?:Traceback \(most recent call last\)|\s+at .+:\d+:\d+\)?)/m.test(text)
    || /^\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/m.test(text)
    || /^\s*[A-Za-z_$][\w.$]*\([^\n]*\)[;]?\s*$/.test(text);
}

/** Minimal block Markdown: structure comes from complete syntax. Unrecognized
 * or incomplete markup stays visible as ordinary text rather than being lost. */
export function documentBlocks(text: string): DocumentBlock[] {
  const lines = text.split("\n");
  const blocks: DocumentBlock[] = [];
  let prose: string[] = [];
  const flush = () => { if (prose.length) { blocks.push({ kind: "paragraph", text: prose.join("\n") }); prose = []; } };
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (!line.trim()) { flush(); i++; continue; }
    const heading = line.match(/^(#{1,3})[\t ]+(\S.*)$/);
    if (heading) { flush(); blocks.push({ kind: "heading", level: heading[1]!.length as 1 | 2 | 3, text: heading[2]! }); i++; continue; }
    const fence = line.match(/^(`{3,}|~{3,})([\w.+#-]*)[\t ]*$/);
    if (fence) {
      const end = lines.findIndex((candidate, index) => index > i && candidate === fence[1]);
      if (end > i + 1) {
        flush(); blocks.push({ kind: "code", code: lines.slice(i + 1, end).join("\n"), ...(fence[2] ? { language: fence[2] } : {}) });
        i = end + 1; continue;
      }
    }
    if (/^[\t ]*(?:[-*•]|\d+[.)、])[\t ]+\S/.test(line)) {
      let end = i + 1;
      while (end < lines.length && /^[\t ]*(?:[-*•]|\d+[.)、])[\t ]+\S/.test(lines[end]!)) end++;
      const list = parseList(lines.slice(i, end).join("\n"));
      if (list?.kind === "list") { flush(); blocks.push(list); i = end; continue; }
      // Preserve the entire rejected group. Retrying from its second line
      // would turn nested children into a flat list and discard indentation.
      prose.push(...lines.slice(i, end)); i = end; continue;
    }
    prose.push(line); i++;
  }
  flush();
  return blocks;
}

/** Count graphemes up to `limit + 1`, so a huge clipboard costs no more than the limit. */
function exceedsGraphemes(text: string, limit: number): number | undefined {
  if (text.length <= limit) return; // A grapheme is at least one UTF-16 unit.
  let count = 0;
  for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    if (/^\s+$/u.test(part.segment)) continue;
    if (++count > limit) return count;
  }
}

/** Reject over-long input before any provider call, work-tree preparation or
 * layout. Only non-whitespace graphemes count. Markup the templates strip
 * (`**`, `|`, `#`) does count, so a markup-heavy source right at the limit
 * may be refused here; layout still enforces the exact rendered limit. */
export function assertTemplateLength(text: string): void {
  if (typeof text !== "string") return;
  if (exceedsGraphemes(text, TEMPLATE_MAX_GRAPHEMES) !== undefined) {
    throw new TemplateInputError(`This text has more than ${TEMPLATE_MAX_GRAPHEMES} characters, the maximum for one card. Split the source into smaller cards. No content was truncated.`);
  }
}
