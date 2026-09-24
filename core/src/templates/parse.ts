import { classify } from "../render/classify.ts";
import { parseArrowChains, parseMermaid } from "./diagram.ts";
import { TEMPLATE_MAX_GRAPHEMES, TEXT_MAX_GRAPHEMES, TemplateInputError, type ChangeType, type ChangelogRelease, type ChangelogSection, type DocumentBlock, type InfoField, type InfoFieldType, type TemplateContent, type TemplateId, type TerminalLine } from "./types.ts";

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
  // Shell sessions are read from the raw text, or from a fence whose language
  // allows one (```console, ```sh…); the fenced source stays available as code.
  const inner = code?.kind === "code" ? code : undefined;
  const terminal = inner ? (!inner.language || SESSION_FENCES.test(inner.language) ? parseTerminal(inner.code) : undefined) : parseTerminal(text);
  // A Mermaid flowchart, fenced as ```mermaid or bare, is a diagram; the
  // fenced source stays available as code.
  const mermaid = code?.kind === "code" && (!code.language || /^mermaid$/i.test(code.language)) ? parseMermaid(code.code) : parseMermaid(text.trim());
  if (mermaid) candidates.set("diagram", mermaid);
  if (code) candidates.set("code", code);
  else if (!mermaid) {
    const table = parseTable(text) ?? parseBoxTable(text);
    const comparison = parseComparison(text);
    const quote = isRawCode(text) ? undefined : parseQuote(text);
    const list = parseList(text);
    const chat = parseChat(text) ?? parseTranscript(text);
    const stat = parseStat(text);
    const info = parseInfo(text);
    const changelog = parseChangelog(text);
    for (const content of [table, comparison, quote, list, chat, stat, info, changelog]) {
      if (content) candidates.set(content.kind, content);
    }
    // The legacy classifier also understands commands, JSON and stack traces.
    // Keep those capabilities without treating malformed tables or mixed
    // Markdown containing a fence as one large code block.
    // A shell session keeps code as its alternative.
    if (candidates.size === 1 && (terminal || isRawCode(text.trim()))) candidates.set("code", { kind: "code", code: normalized });
    // Arrow chains: every line "A → B → C". Code (JS `=>`) never qualifies.
    if (!candidates.has("code")) {
      const chains = parseArrowChains(text);
      if (chains) candidates.set("diagram", chains);
    }
  }
  if (terminal) candidates.set("terminal", terminal);
  const prose = parseText(text, candidates);
  if (prose) candidates.set("text", prose);
  // Anything can be a QR code: the exact source (surrounding whitespace aside),
  // not the cleaned text. It is never preferred.
  candidates.set("qr", { kind: "qr", data: sourceText.replace(/^\s+|\s+$/g, "") });
  return { sourceText, preferred: preferredTemplate(candidates), candidates };
}

/** Which recognized structure wins when several parse. */
const PREFERENCE: readonly TemplateId[] = ["diagram", "terminal", "code", "table", "comparison", "changelog", "info", "quote", "list", "chat", "stat"];

/** Strings from a list that arrived as JSON; anything else is no list. */
export function templateIdList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))].sort() : [];
}

/** A recognized structure wins; short plain prose is typography; the rest is a document. */
function preferredTemplate(candidates: ReadonlyMap<TemplateId, unknown>): TemplateId {
  return PREFERENCE.find((id) => candidates.has(id)) ?? (candidates.has("text") ? "text" : "document");
}

/**
 * The candidates automatic choice may use when the user turned some
 * templates off. Document is the fallback and cannot be removed; the full
 * set stays available for choosing by hand.
 */
export function withoutTemplates(parsed: ParsedTemplates, disabled: unknown): ParsedTemplates {
  const off = new Set(templateIdList(disabled).filter((id) => id !== "document"));
  if (![...parsed.candidates.keys()].some((id) => off.has(id))) return parsed;
  const candidates = new Map([...parsed.candidates].filter(([id]) => !off.has(id)));
  return { ...parsed, candidates, preferred: preferredTemplate(candidates) };
}

/** Short prose with no structure of its own: at most TEXT_MAX_GRAPHEMES visible
 * characters and eight paragraphs, no Markdown blocks, and no structure a
 * specialized template would lose (code, table, list, chat, comparison).
 * Quotes and statistics keep text as an alternative. */
function parseText(text: string, candidates: ReadonlyMap<TemplateId, TemplateContent>): TemplateContent | undefined {
  if (["code", "terminal", "table", "list", "chat", "comparison"].some((id) => candidates.has(id as TemplateId))) return;
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

/** Labels that mark a line as a field (contact details, accounts, servers, orders). */
const INFO_LABELS = /^(?:姓名|名字|名称|name|full name|手机|手机号|手机号码|电话|座机|tel|phone|mobile|cell|邮箱|电子邮件|电子邮箱|e-?mail|mail|地址|address|网址|网站|主页|website|web|url|link|链接|微信|微信号|wechat|qq|telegram|whatsapp|公司|company|organization|org|职位|职务|title|role|部门|department|账号|帐号|账户|用户名|用户|user|username|login|account|id|密码|口令|password|passwd|pwd|pass|密钥|秘钥|key|api key|apikey|secret|secret key|token|access key|access token|host|hostname|主机|服务器|server|ip|端口|port|数据库|database|db|region|区域|环境|env|environment|endpoint|base url|订单号|订单|order|order id|快递单号|单号|tracking|金额|amount|price|日期|date|时间|time|备注|note|notes)$/i;
const EMAIL_VALUE = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/;
const URL_VALUE = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+$/i;
const SECRET_LABEL = /密码|口令|密钥|秘钥|pass|pwd|secret|token|api[ _-]?key|access[ _-]?key|private[ _-]?key/i;
const SECRET_VALUE = /^(?:sk-[\w-]{16,}|ghp_\w{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)$/;

/** A postal address: Chinese place units (two or more of 省 市 区 县 路 街 号…), or a
 * house number and a street word. Only used for lines without a label. */
export function looksLikeAddress(value: string): boolean {
  if ([...value].length > 60) return false;
  const units = value.match(/[省市区县镇乡村路街道巷弄号楼栋室座]|大厦|大道|广场|小区/g) ?? [];
  if (/[\u4e00-\u9fff]/.test(value) && new Set(units).size >= 2 && !/[，。！？；]/.test(value)) return true;
  return /^\d+[A-Za-z]?\s+[\w .'-]+\b(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Hwy|Highway)\b\.?(?:,|$)/i.test(value);
}

/** How a field is styled; the value itself is never changed. */
export function infoFieldType(label: string | undefined, value: string): InfoFieldType {
  if (EMAIL_VALUE.test(value)) return "email";
  if (URL_VALUE.test(value)) return "url";
  const digits = value.replace(/\D/g, "").length;
  if (/^\+?[\d\s()-]{7,24}$/.test(value) && digits >= 7 && digits <= 15 && !/\d{4}-\d{2}-\d{2}/.test(value)) return label && !/phone|mobile|tel|cell|手机|电话|座机/i.test(label) ? "plain" : "phone";
  if (SECRET_VALUE.test(value) || (label && SECRET_LABEL.test(label) && !/\s/.test(value))) return "secret";
  if (label ? /地址|住址|address|addr/i.test(label) : looksLikeAddress(value)) return "address";
  return "plain";
}

/**
 * Labelled fields, one per line ("手机：138…", "API Key: sk-…", or dotenv's
 * "OPENAI_API_KEY=sk-…"), optionally led by a title line (a "# comment"
 * titles an env block, its marker dropped like a Markdown heading's); bare
 * emails, URLs, phone numbers and keys count as fields too. Every other line would be dropped, so any other line means
 * this is not an info card. At least two fields, labels unique (a returning
 * label is a conversation), and some label or value must be recognizable.
 */
export function parseInfo(text: string): TemplateContent | undefined {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2 || lines.length > 24) return;
  const fields: InfoField[] = [];
  let title: string | undefined;
  let env = 0;
  for (const [index, line] of lines.entries()) {
    const assignment = line.match(/^(?:export[\t ]+)?([A-Z][A-Z0-9_]{0,63})=(\S.*)$/);
    if (assignment) {
      const label = assignment[1]!, value = assignment[2]!;
      fields.push({ label, value, type: infoFieldType(label.replace(/_/g, " "), value) });
      env++;
      continue;
    }
    const comment = index === 0 ? line.match(/^(?:#|\/\/)[\t ]+(\S.{0,39})$/) : null;
    if (comment) { title = comment[1]!.trim(); continue; }
    const m = line.match(/^([^:：\n]{1,24}?)[\t ]*[:：][\t ]*(\S.*)$/);
    if (m && !/^(?:https?|ftp|mailto)$/i.test(m[1]!.trim()) && !m[2]!.startsWith("//")) {
      const label = m[1]!.trim(), value = m[2]!.trim();
      fields.push({ label, value, type: infoFieldType(label, value) });
      continue;
    }
    const type = infoFieldType(undefined, line);
    if (type !== "plain") fields.push({ value: line, type });
    else if (index === 0 && [...line].length <= 40) title = line;
    else return;
  }
  if (fields.length < 2) return;
  const labels = fields.flatMap((field) => field.label ? [field.label.toLowerCase()] : []);
  if (new Set(labels).size !== labels.length) return;
  if (fields.some((field) => [...field.value].length > 200)) return;
  // Two dotenv assignments are shape enough; otherwise a label or value must be recognizable.
  const known = env >= 2 || fields.some((field) => field.type !== "plain" || (field.label && INFO_LABELS.test(field.label.replace(/\s+/g, " "))));
  if (!known) return;
  return { kind: "info", ...(title ? { title } : {}), fields };
}

/** A version as release notes write it: v1.2 or longer with a "v", 1.2.3 or
 * longer without one (1.2 alone is a section number), with an optional
 * pre-release or build suffix, optionally after "Version", "Release", "版本". */
const VERSION = String.raw`(?:(?:version|release|版本|发布)\s*)?(?:v\d+(?:\.\d+)+|\d+\.\d+\.\d+(?:\.\d+)*)(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.]+)?`;
const RELEASE_DATE = String.raw`\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}`;
/** "## v1.2.0 — 2026-09-24", "## [1.2.0] - 2026-09-24", "1.2.0 (2026-09-24)",
 * "v1.2.0", "## [Unreleased]". Brackets, dashes and parentheses are syntax. */
const RELEASE_HEADING = new RegExp(String.raw`^(#{1,3}[\t ]+)?\[?(${VERSION}|Unreleased|未发布)\]?(?:[\t ]*(?:[-–—:：·|][\t ]*)?\(?(${RELEASE_DATE})\)?)?$`, "i");
/** Section titles recognized without a Markdown heading marker ("Added", "修复:"). */
const SECTION_TYPES: readonly (readonly [ChangeType, RegExp])[] = [
  ["added", /^(?:added|add|new|new features?|features?|新增|新功能|新特性|功能)$/i],
  ["fixed", /^(?:fixed|fix|fixes|bug ?fixes|bugfix(?:es)?|修复|问题修复|修正|缺陷修复)$/i],
  ["changed", /^(?:changed|changes|improved|improvements?|enhancements?|performance|updated|变更|更改|改进|优化|更新|调整|性能)$/i],
  ["removed", /^(?:removed|deprecated|删除|移除|废弃|弃用)$/i],
  ["security", /^(?:security|breaking(?: changes?)?|安全|破坏性变更|不兼容变更)$/i],
  ["other", /^(?:other|others|misc|miscellaneous|docs|documentation|chores?|其他|其它|文档)$/i],
];
export function changeType(title: string): ChangeType | undefined {
  return SECTION_TYPES.find(([, re]) => re.test(title.trim()))?.[0];
}

/**
 * Release notes: an optional "# Title" line, then one or more releases. A
 * release starts at a version-like heading and holds sections (a "###"
 * heading with any short title, or a bare known title such as "Added" or
 * "修复"), each with "-", "*" or "•" items; items right under the version
 * form an untitled section. Every non-blank line must be one of these, else
 * it is not release notes (a document keeps it). At least one real version
 * (not only "Unreleased") and one item; items at one indentation.
 */
export function parseChangelog(text: string): TemplateContent | undefined {
  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length < 2 || lines.length > 120) return;
  let title: string | undefined;
  const releases: { version: string; date?: string; sections: { title?: string; type: ChangeType; items: string[] }[] }[] = [];
  let indent: string | undefined, versions = 0, items = 0;
  for (const [index, raw] of lines.entries()) {
    const line = raw.trimEnd();
    const release = line.trim().match(RELEASE_HEADING);
    if (release && (release[1] || !/^(?:unreleased|未发布)$/i.test(release[2]!))) {
      if (!/^(?:unreleased|未发布)$/i.test(release[2]!)) versions++;
      releases.push({ version: release[2]!, ...(release[3] ? { date: release[3] } : {}), sections: [] });
      continue;
    }
    const heading = line.match(/^(#{1,4})[\t ]+(\S.*?)[\t ]*[:：]?$/);
    if (index === 0 && heading && heading[1] === "#" && [...heading[2]!].length <= 40) { title = heading[2]!; continue; }
    const current = releases.at(-1);
    if (!current) return;
    if (heading && heading[1]!.length >= 2 && [...heading[2]!].length <= 30) {
      current.sections.push({ title: heading[2]!, type: changeType(heading[2]!) ?? "other", items: [] });
      continue;
    }
    const bare = line.match(/^[\t ]*(\S[^:：]{0,29}?)[\t ]*[:：]?$/);
    const known = bare ? changeType(bare[1]!) : undefined;
    if (bare && known && !/^[\t ]*[-*•][\t ]/.test(line)) {
      current.sections.push({ title: bare[1]!, type: known, items: [] });
      continue;
    }
    const item = line.match(/^([\t ]*)[-*•][\t ]+(\S.*)$/);
    if (!item) return;
    if (indent === undefined) indent = item[1]!;
    else if (item[1] !== indent) return;
    // Items right under the version: an untitled section.
    if (!current.sections.length) current.sections.push({ type: "other", items: [] });
    current.sections.at(-1)!.items.push(item[2]!.trim());
    items++;
  }
  if (!versions || !items) return;
  // A titled section left empty would draw a tag over nothing: not release notes.
  if (releases.some((r) => r.sections.some((s) => !s.items.length))) return;
  return { kind: "changelog", ...(title ? { title } : {}), releases: releases.map((r): ChangelogRelease => ({
    version: r.version, ...(r.date ? { date: r.date } : {}),
    sections: r.sections.map((s): ChangelogSection => ({ ...(s.title ? { title: s.title } : {}), type: s.type, items: s.items })),
  })) };
}

/** Fence languages a shell session may be written under. */
const SESSION_FENCES = /^(?:console|shell-session|shellsession|terminal|term|sh|bash|zsh|fish|shell|powershell|pwsh|ps1?|cmd|bat|text|txt|plaintext)$/i;
/** A prompt as shells print it, then the command: `$ `, `% `, `# ` only after
 * a user@host or path, `❯ `, `➜  dir`, `user@host:~/p$ `, `[user@host dir]$ `,
 * `bash-5.2$ `, `PS C:\> `, `C:\Users> `, an optional `(venv) ` in front. */
const PROMPT = new RegExp("^((?:\\([\\w.@-]{1,40}\\)[\\t ]+)?(?:"
  + String.raw`\[?[\w.-]+@[\w.-]+(?:[: ][^\s$#%>]*)?\]?[\t ]?[$#%>]`
  + String.raw`|(?:~|\/)[^\s$#%]*[\t ]?[$#%❯]`
  + String.raw`|(?:ba|z|fi|k)?sh-\d+(?:\.\d+)*[$#]`
  + String.raw`|PS [A-Za-z]:\\[^>\n]*>|[A-Za-z]:\\[^>\n]*>`
  + String.raw`|➜[\t ]+[^\s]+(?:[\t ]+git:\([^)\n]*\))?(?:[\t ]+✗)?`
  + String.raw`|❯+|[$%]` + ")[\\t ]+)(\\S.*)?$");
/** Commands a bare `$ ` / `% ` / `❯ ` session must start one of (a user@host,
 * path or PowerShell prompt is evidence enough on its own). */
const KNOWN_COMMANDS = new Set(("git gh npm npx pnpm yarn bun bunx deno node tsc vite python python3 pip pip3 uv poetry pytest ruff cargo rustc rustup go "
  + "make cmake gcc clang swift xcodebuild xcrun brew apt apt-get yum dnf pacman docker podman kubectl helm terraform aws gcloud az ssh scp rsync "
  + "curl wget ls ll cd pwd cat echo printf grep rg find fd sed awk head tail less wc sort uniq xargs mkdir rm cp mv chmod chown touch ln ps kill "
  + "top df du tar zip unzip gzip ping dig nslookup ifconfig ip netstat lsof which whoami sudo su export source env java javac mvn gradle ruby "
  + "gem bundle rails php composer dotnet psql mysql sqlite3 redis-cli open code vim nano man tree diff file stat date uname hostname systemctl "
  + "journalctl launchctl defaults codesign security openssl ssh-keygen nvm pyenv conda flutter dart adb time watch jq yq bat eza exa history clear").split(" "));

/** Output lines drawn in the error or warning colour. Colour only. */
const ERROR_OUTPUT = /^\s*(?:error\b|fatal\b|panic:|npm ERR!|ERR!|E:|✖|✗|FAILED\b|FAIL\b)|command not found|Permission denied|No such file or directory|cannot find|not recognized as/i;
const WARNING_OUTPUT = /^\s*(?:warning\b|warn\b|npm WARN|W:|⚠)/i;
/** A final exit status line: `[exit 1]`, `exit status 2`, `Process exited with code 0`… */
const EXIT_LINE = /^\[?(?:process (?:exited|completed|finished)(?: with)?(?: exit)?(?: code| status)|exit(?:ed)?(?: with)?(?: code| status)?|exit code|return code|status)[:=]?[\t ]*(-?\d{1,3})\]?\.?$/i;

/**
 * A shell session: the first line is a prompt, and every other line is a
 * prompt or output (blank lines kept). It needs a prompt with a command and
 * an output line, or two prompts with commands; a command's first word must
 * look like one (`$ 100 off` is prose). A last line like `exit status 1` is
 * the exit status.
 */
export function parseTerminal(text: string): TemplateContent | undefined {
  const lines = trimBlankLines(text).split("\n");
  if (lines.length < 2 || lines.length > 200) return;
  const out: TerminalLine[] = [];
  let commands = 0, outputs = 0, evidence = false;
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\s+$/, "");
    const prompt = line.match(PROMPT);
    const command = prompt?.[2]?.trimEnd() ?? "";
    if (prompt && (!command || /^[\w./~@:+\\-]/.test(command) && !/^[\d,.]+(?:\s|$)/.test(command))) {
      out.push({ kind: "prompt", prompt: prompt[1]!, command });
      if (command) commands++;
      const bare = /^[$%❯]+[\t ]+$/.test(prompt[1]!);
      if (!bare || KNOWN_COMMANDS.has(command.split(/\s/)[0]!) || /^(?:\.{0,2}\/|~\/)/.test(command)) evidence = true;
      continue;
    }
    if (!index) return;
    const exit = index === lines.length - 1 ? line.trim().match(EXIT_LINE) : null;
    if (exit) { out.push({ kind: "exit", text: line.trim(), ok: Number(exit[1]) === 0 }); continue; }
    const tone = ERROR_OUTPUT.test(line) ? "error" as const : WARNING_OUTPUT.test(line) ? "warning" as const : undefined;
    out.push({ kind: "output", text: line, ...(tone ? { tone } : {}) });
    if (line.trim()) outputs++;
  }
  if (!evidence || !(commands >= 2 || (commands >= 1 && outputs >= 1))) return;
  return { kind: "terminal", lines: out };
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

/** Box-drawing tables as terminals, CLIs and databases print them: Unicode
 * frames (light, heavy, double, rounded), ASCII `+---+` with `|`, and psql's
 * `---+---` header rule. Rows are separated by rule lines when every row has
 * one (a cell wrapped over several lines is joined back); otherwise each text
 * line is a row. Cell text is kept; only padding and frame characters go. */
const BOX_BAR = /[│┃║|]/;
const BOX_RULE = /^[\s┌┐└┘├┤┬┴┼─━═╔╗╚╝╠╣╦╩╬╒╕╘╛╞╡╤╧╪╓╖╙╜╟╢╥╨╫╭╮╰╯┏┓┗┛┣┫┳┻╋┠┨┯┷┿╂+\-=:|│┃║]+$/;
function parseBoxTable(text: string): TemplateContent | undefined {
  const lines = text.split("\n").map((line) => line.replace(/\s+$/, "")).filter((line) => line.trim());
  if (lines.length < 3) return;
  const isRule = (line: string) => BOX_RULE.test(line) && (line.match(/[─━═\-]/g)?.length ?? 0) >= 3;
  if (!lines.some(isRule) || !/[─━═┌╔╭+]|-{3,}/.test(text)) return;
  const groups: string[][][] = [];
  let current: string[][] = [];
  let width: number | undefined;
  for (const line of lines) {
    if (isRule(line)) { if (current.length) { groups.push(current); current = []; } continue; }
    if (!BOX_BAR.test(line)) return;
    const inner = line.trim().replace(/^[│┃║|]/, "").replace(/[│┃║|]$/, "");
    const cells = inner.split(BOX_BAR).map((cell) => cell.trim());
    if (width === undefined) width = cells.length;
    if (cells.length !== width || width < 2) return;
    current.push(cells);
  }
  if (current.length) groups.push(current);
  const dataLines = groups.reduce((n, g) => n + g.length, 0);
  if (dataLines < 2) return;
  const joinWrapped = (parts: string[]) => parts.filter(Boolean).reduce((acc, part) => {
    if (!acc) return part;
    const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}，。、；：！？）」』》]$/u.test(acc) && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}（「『《]/u.test(part);
    return acc + (cjk ? "" : " ") + part;
  }, "");
  const merge = (group: string[][]) => group[0]!.map((_, c) => joinWrapped(group.map((row) => row[c]!)));
  let rows: string[][];
  // A rule after every row: each group is one row, its lines one wrapped row.
  if (groups.length >= 3) rows = groups.map(merge);
  // Only a header rule: the header may wrap; every body line is its own row.
  else if (groups.length === 2) rows = [merge(groups[0]!), ...groups[1]!];
  else rows = groups[0]!;
  const [headers, ...body] = rows;
  if (!headers || !body.length || headers.every((cell) => !cell)) return;
  return { kind: "table", headers, rows: body };
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
