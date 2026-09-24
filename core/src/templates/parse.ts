import { classify } from "../render/classify.ts";
import { parseArrowChains, parseMermaid } from "./diagram.ts";
import { TEMPLATE_MAX_GRAPHEMES, TEXT_MAX_GRAPHEMES, TemplateInputError, type ChangeType, type ChangelogRelease, type ChangelogSection, type DocumentBlock, type InfoField, type InfoFieldType, type DiffCommitLine, type DiffFile, type DiffLine, type ErrorTraceLine, type LyricLine, type LyricStanza, type StatsMetric, type TemplateContent, type TemplateId, type TerminalLine } from "./types.ts";

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
  const error = inner ? (!inner.language || /^(?:text|txt|plaintext|console|log|python|pytb|traceback|js|javascript|ts|typescript|java|go|rust|csharp|cs|kotlin|ruby|rb|php)$/i.test(inner.language) ? parseError(inner.code) : undefined) : parseError(text);
  const diff = inner ? (!inner.language || /^(?:diff|patch|udiff|git)$/i.test(inner.language) ? parseDiff(inner.code) : undefined) : parseDiff(text);
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
    // LRC timestamps are lyrics, never a conversation (`[00:12.34]` reads as a speaker) or a schedule.
    const lyrics = parseLyrics(text);
    const lrc = lyrics?.kind === "lyrics" && lyrics.stanzas.some((stanza) => stanza.lines.some((line) => line.at !== undefined));
    const chat = lrc ? undefined : parseChat(text) ?? parseTranscript(text);
    const stat = parseStat(text);
    const info = parseInfo(text);
    const changelog = parseChangelog(text);
    // Chat apps copy a time with every message: a conversation is never a schedule.
    const timeline = chat || lrc ? undefined : parseTimeline(text);
    const stats = parseStats(text);
    for (const content of [table, comparison, quote, list, chat, stat, info, changelog, timeline, stats]) {
      if (content) candidates.set(content.kind, content);
    }
    // The legacy classifier also understands commands, JSON and stack traces.
    // Keep those capabilities without treating malformed tables or mixed
    // Markdown containing a fence as one large code block.
    // A shell session, a diff or a stack trace keeps code as its alternative.
    if (candidates.size === 1 && (terminal || diff || error || isRawCode(text.trim()))) candidates.set("code", { kind: "code", code: normalized });
    // Arrow chains: every line "A → B → C". Code (JS `=>`) never qualifies.
    if (!candidates.has("code")) {
      const chains = parseArrowChains(text);
      if (chains) candidates.set("diagram", chains);
    }
  }
  if (terminal) candidates.set("terminal", terminal);
  if (diff) candidates.set("diff", diff);
  if (error) candidates.set("error", error);
  const prose = parseText(text, candidates);
  if (prose) candidates.set("text", prose);
  // Lyric motion takes any text (lyrics keep their lines, prose is cut at its
  // punctuation); code, tables and diagrams are marked unfit. Never preferred.
  candidates.set("lyrics", lyricMotion(text, candidates));
  // Anything can be a QR code: the exact source (surrounding whitespace aside),
  // not the cleaned text. It is never preferred.
  candidates.set("qr", { kind: "qr", data: sourceText.replace(/^\s+|\s+$/g, "") });
  return { sourceText, preferred: preferredTemplate(candidates), candidates };
}

/** Which recognized structure wins when several parse. */
const PREFERENCE: readonly TemplateId[] = ["diagram", "terminal", "diff", "error", "code", "table", "comparison", "changelog", "stats", "info", "timeline", "quote", "list", "chat", "stat"];

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
  if (["code", "terminal", "diff", "error", "timeline", "stats", "table", "list", "chat", "comparison"].some((id) => candidates.has(id as TemplateId))) return;
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

/** File header lines of a diff that carry meaning and are drawn as written. */
const DIFF_META = /^(?:(?:new|deleted) file mode \d+|old mode \d+|new mode \d+|similarity index \d+%|dissimilarity index \d+%|rename (?:from|to) .+|copy (?:from|to) .+|Binary files .+ differ|GIT binary patch)$/;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
/** A path from a `---`/`+++` line or `diff --git`: the a/ b/ prefix and a trailing timestamp are syntax. */
const diffPath = (raw: string): string | undefined => {
  const path = raw.replace(/\t.*$/, "").trim().replace(/^"(.*)"$/, "$1");
  return path === "/dev/null" ? undefined : path.replace(/^[ab]\//, "");
};

/**
 * A unified diff (`git diff`, `diff -u`, a patch): optional `diff --git` and
 * `index` lines, mode, rename and binary lines, `---`/`+++` headers, and `@@`
 * hunks of lines starting with `+`, `-`, a space or `\` (blank lines count as
 * context). Every line must be one of these, with at least one hunk and one
 * added or removed line; the hunk header's counts decide whether a `---` line
 * is a removed line or the next file's header. A `git show` or
 * `git format-patch` commit header may sit above it (`commitHeader`).
 */
export function parseDiff(text: string): TemplateContent | undefined {
  const lines = trimBlankLines(text).split("\n");
  const header = commitHeader(lines);
  if (header === null) return;
  const diff = parseDiffLines(header ? header.rest : lines);
  return diff && header ? { kind: "diff", commit: header.commit, files: diff.files } : diff;
}

/** `commit <sha>` (with its refs) at the top of `git show` / `git log -p`. */
const COMMIT_LINE = /^commit [0-9a-f]{7,64}(?: \(.+\))?$/;
/** The mbox separator `git format-patch` writes first (its date is fixed). */
const MBOX_FROM = /^From [0-9a-f]{7,64} Mon Sep 17 00:00:00 2001$/;
/** Fields under the commit line, any `--format` (`fuller` adds the dates and committer). */
const COMMIT_FIELD = /^(?:Merge|Author|AuthorDate|Commit|CommitDate|Date):[\t ]*\S.*$/;
/** Mail headers of a patch that are drawn; the others (MIME, Message-Id…) are transport and syntax. */
const MAIL_DRAWN = /^(?:From|Date|To|Cc):/i;
/** `--stat` lines between the message and the diff: recomputed by the card's summary, syntax. */
const DIFFSTAT = /^ \S.*\| +(?:\d+ ?[+\-]*|Bin(?: .*)?)$|^ \d+ files? changed(?:, \d+ insertions?\(\+\))?(?:, \d+ deletions?\(-\))?$|^ (?:create|delete) mode \d+ \S.*$|^ (?:rename|copy) .+ \(\d+%\)$|^ mode change \d+ => \d+ .+$/;

/**
 * A commit header above a diff, from `git show` (`commit <sha>`, fields such as
 * `Author:` and `Date:`, a blank line, the message indented four spaces) or
 * `git format-patch` (`From <sha> Mon Sep 17 00:00:00 2001`, mail headers with
 * `From:` and `Subject:`, a blank line, the message, `---`). An optional
 * diffstat follows; a patch's `-- ` signature (git's version) ends it. Returns
 * undefined when the text starts with no header, null when it starts like one
 * but the header is broken (then it is not a diff at all).
 */
function commitHeader(lines: readonly string[]): { commit: DiffCommitLine[]; rest: string[] } | null | undefined {
  const first = lines[0] ?? "", commit: DiffCommitLine[] = [{ text: first, role: "commit" }];
  let i = 1;
  const skipStat = () => { while (i < lines.length && (DIFFSTAT.test(lines[i]!) || !lines[i]!.trim())) i++; };
  if (COMMIT_LINE.test(first)) {
    for (; i < lines.length && COMMIT_FIELD.test(lines[i]!); i++) commit.push({ text: lines[i]!, role: "field" });
    if (commit.length < 2 || lines[i]?.trim() !== "") return null;
    for (; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim()) continue;
      if (!line.startsWith("    ")) break;
      commit.push({ text: line.slice(4).trimEnd(), role: commit.some((l) => l.role === "subject") ? "message" : "subject" });
    }
    if (!commit.some((l) => l.role === "subject")) return null;
    skipStat();
    return { commit, rest: lines.slice(i) };
  }
  if (!MBOX_FROM.test(first)) return undefined;
  let drawn = false, subject = false, from = false;
  for (; i < lines.length && lines[i]!.trim(); i++) {
    const line = lines[i]!;
    if (/^[\t ]/.test(line)) {
      // A folded header continues on an indented line; the fold is syntax.
      if (drawn) { const last = commit.at(-1)!; commit[commit.length - 1] = { ...last, text: `${last.text} ${line.trim()}` }; }
      continue;
    }
    if (!/^[A-Za-z][\w-]*:(?:[\t ]|$)/.test(line)) return null;
    drawn = /^Subject:/i.test(line) || MAIL_DRAWN.test(line);
    if (/^Subject:/i.test(line)) { subject = true; commit.push({ text: line, role: "subject" }); }
    else if (drawn) { from ||= /^From:/i.test(line); commit.push({ text: line, role: "field" }); }
  }
  if (!subject || !from) return null;
  for (i++; i < lines.length && lines[i] !== "---" && !/^diff --git /.test(lines[i]!); i++) if (lines[i]!.trim()) commit.push({ text: lines[i]!.trimEnd(), role: "message" });
  if (lines[i] === "---") i++;
  skipStat();
  const rest = lines.slice(i);
  // The patch's signature: "-- " and git's version under it.
  const sig = rest.findLastIndex((line) => /^-- ?$/.test(line));
  if (sig > 0 && rest.length - sig <= 3 && rest.slice(sig + 1).every((line) => !line || /^\d+\.\d+/.test(line))) rest.length = sig;
  return { commit, rest: trimBlankLines(rest.join("\n")).split("\n") };
}

function parseDiffLines(lines: readonly string[]): { kind: "diff"; files: DiffFile[] } | undefined {
  if (lines.length < 2 || lines.length > 600) return;
  const files: { path?: string; oldPath?: string; meta: string[]; hunks: { header: string; lines: DiffLine[] }[] }[] = [];
  let file: (typeof files)[number] | undefined, hunk: (typeof files)[number]["hunks"][number] | undefined;
  let oldLeft = 0, newLeft = 0, changes = 0;
  const start = () => { file = { meta: [], hunks: [] }; files.push(file); hunk = undefined; return file; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const inHunk = hunk && (oldLeft > 0 || newLeft > 0);
    if (inHunk && /^[ +\-]|^$/.test(line)) {
      const type = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "context";
      if (type !== "add") oldLeft--;
      if (type !== "del") newLeft--;
      if (type !== "context") changes++;
      hunk!.lines.push({ type, text: line });
      continue;
    }
    if (hunk && line.startsWith("\\")) { hunk.lines.push({ type: "note", text: line }); continue; }
    const git = line.match(/^diff --git (\S+) (\S+)$/);
    if (git) { const f = start(); f.path = diffPath(git[2]!); const old = diffPath(git[1]!); if (old && old !== f.path) f.oldPath = old; continue; }
    if (/^index [0-9a-f]+\.\.[0-9a-f]+(?: \d+)?$/.test(line) || /^diff (?:-\S+ )*\S+ \S+$/.test(line)) { if (!file || file.hunks.length) start(); continue; }
    if (DIFF_META.test(line)) { (file && !file.hunks.length ? file : start()).meta.push(line); continue; }
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      const f = file && !file.hunks.length ? file : start();
      const from = diffPath(line.slice(4)), to = diffPath(lines[i + 1]!.slice(4));
      f.path = to ?? from;
      if (from && to && from !== to) f.oldPath = from; else delete f.oldPath;
      i++; continue;
    }
    const header = line.match(HUNK);
    if (header) {
      const f = file ?? start();
      hunk = { header: line, lines: [] };
      f.hunks.push(hunk);
      oldLeft = header[2] === undefined ? 1 : Number(header[2]); newLeft = header[4] === undefined ? 1 : Number(header[4]);
      continue;
    }
    // Past the counts: a trimmed or hand-edited hunk still reads as one.
    if (hunk && /^[+\-]/.test(line) && !/^(?:\+\+\+|---) /.test(line)) { hunk.lines.push({ type: line[0] === "+" ? "add" : "del", text: line }); changes++; continue; }
    if (hunk && line.startsWith(" ")) { hunk.lines.push({ type: "context", text: line }); continue; }
    return;
  }
  if (!changes || !files.length || files.some((f) => !f.hunks.length && !f.meta.length)) return;
  if (!files.some((f) => f.hunks.length)) return;
  // A rename's "rename from" line already names the old path.
  for (const f of files) if (f.meta.some((m) => m.startsWith("rename from "))) delete f.oldPath;
  return { kind: "diff", files: files.map((f): DiffFile => ({ ...(f.path ? { path: f.path } : {}), ...(f.oldPath ? { oldPath: f.oldPath } : {}), meta: f.meta, hunks: f.hunks })) };
}

/** An error type: `TypeError`, `java.lang.IllegalStateException`, `System.IO.IOException`,
 * `requests.exceptions.ConnectionError`, Node's `Error [ERR_X]`… */
const ERROR_TYPE = String.raw`(?:[A-Za-z_$][\w$]*\.)*(?:[A-Z][\w$]*(?:Error|Exception|Exit|Interrupt|Failure|Fault|Panic)|Error|Exception)(?: \[[\w.-]+\])?`;
const ERROR_HEADING = new RegExp(String.raw`^(?:(Uncaught(?: \(in promise\))?|Unhandled exception\.|Exception in thread "[^"\n]*"|Caused by:)[\t ]+)?(${ERROR_TYPE})(?::[\t ]*(\S.*))?$`);
/** A PHP class, namespaced with backslashes: `Exception`, `App\\Exceptions\\PaymentFailed`. */
const PHP_CLASS = String.raw`\\?(?:[A-Za-z_]\w*\\)*[A-Za-z_]\w*`;
/** Ruby: `file.rb:12:in 'method': message (ErrorClass)` (backquote before Ruby 3.4). The location is the top frame. */
const RUBY_HEADING = /^(\S.*?:\d+:in [`'][^'\n]*'): (.*?) ?\(((?:[A-Z]\w*::)*[A-Z]\w*)\)$/;
/** PHP: `PHP Fatal error:  Uncaught Exception: message in /path/file.php:42` (the `PHP ` prefix only in the log/stderr form). */
const PHP_HEADING = new RegExp(String.raw`^((?:PHP )?Fatal error:[\t ]+Uncaught)[\t ]+(${PHP_CLASS})(?::[\t ]*(.*?))?[\t ]+in[\t ]+(\S+:\d+)$`);
/** Frames and the lines around them, trimmed. */
const TRACE_FRAME = /^(?:(?:\d+:[\t ]+)?from[\t ]+\S+:\d+(?::in[\t ]+.*)?|at[\t ]+\S.*|File "[^"\n]+", line \d+.*|#\d+[\t ]+\S.*|\d+:[\t ]+\S.*|[\w$.\/*()[\]<>-]+\(.*\)(?:[\t ]+.*)?|created by \S.*)$/;
const TRACE_NOTE = new RegExp(String.raw`^(?:\.\.\.[\t ]+\d+[\t ]+more|\.\.\.[\t ]*\d+ (?:lines|frames).*|Caused by:.*|Suppressed:.*|Traceback \(most recent call last\):|During handling of the above exception, another exception occurred:|The above exception was the direct cause of the following exception:|goroutine \d+ \[[^\]]+\]:|stack backtrace:|Stack trace:|note: .*|exit status \d+|\[CIRCULAR\]|\{main\}|thrown in .*|\.\.\. \d+ levels\.\.\.|Next ${PHP_CLASS}(?::.*)? in \S+:\d+)$`);
/** Where a frame points into dependencies, the standard library or the runtime (dimmed). */
const LIBRARY_FRAME = /node_modules|\/gems\/|\/lib\/ruby\/|<internal:|\/vendor\/|^#\d+[\t ]+(?:\{main\}|\[internal function\])|site-packages|dist-packages|\/usr\/(?:local\/)?lib\/|\/lib\/python\d|<frozen |node:|\binternal\/|<anonymous>|\/rustc\/|\.cargo\/registry|\/usr\/local\/go\/|\/go\/src\/|GOROOT|Python\.framework|\/opt\/homebrew\/|webpack\/bootstrap|^at (?:java|javax|jdk|sun|kotlin|kotlinx|scala|org\.junit|org\.springframework|org\.apache|com\.sun|android|dalvik)\.|^at System\.|^at Microsoft\.|^\d+:[\t ]+(?:std|core|alloc|rust_begin_unwind|__rust|_start|__libc)|^runtime\.|^(?:main\.)?goexit|^created by runtime/;

/**
 * An error and its stack trace. JavaScript, Java, C#, Go and Rust put the
 * error first (`TypeError: …`, `Exception in thread "main" …`, `panic: …`,
 * `thread 'main' panicked at …` with the message under it); Python puts it
 * last, under `Traceback (most recent call last):`. Ruby starts with the
 * top frame (`app.rb:12:in 'm': message (ErrorClass)`, then `from …` frames;
 * Ruby 2.5–2.7 on a terminal reverses them under `Traceback`); PHP with
 * `PHP Fatal error:  Uncaught Exception: message in /path:42`, then
 * `Stack trace:` and `#0 …` frames. At least one frame, and
 * every line a frame, a Python source line under its frame, or a known note
 * (`... 3 more`, `Caused by:`, `goroutine 1 [running]:`…).
 */
export function parseError(text: string): TemplateContent | undefined {
  const lines = trimBlankLines(text).split("\n").map((line) => line.replace(/\s+$/, ""));
  if (lines.length < 2 || lines.length > 300) return;
  let lead: string | undefined, type: string | undefined, message: string | undefined, body: string[];
  const first = lines[0]!.trim();
  const trace: ErrorTraceLine[] = [];
  let frames = 0, innermost: string | undefined;
  if (/^Traceback \(most recent call last\):$/.test(first)) {
    const last = lines.at(-1)!.trim(), ruby = last.match(RUBY_HEADING);
    if (ruby && !lines.at(-1)!.match(/^\s/)) {
      // Ruby 2.5–2.7 on a terminal: the frames reversed ("2: from …"), the error last; its location is the innermost frame.
      type = ruby[3]!; message = ruby[2] || undefined; body = lines.slice(0, -1); innermost = ruby[1]!;
    } else {
      // Python: the last line is the exception.
      const m = last.match(/^([A-Za-z_][\w.]*)(?::[\t ]*(\S.*))?$/);
      if (!m || lines.at(-1)!.match(/^\s/)) return;
      type = m[1]!; message = m[2]; body = lines.slice(0, -1);
    }
  } else if (RUBY_HEADING.test(first)) {
    // Ruby: the location first (a frame), then the message and (ErrorClass); error_highlight's snippet and
    // "Did you mean?" lines may sit between it and the "from" frames.
    const m = first.match(RUBY_HEADING)!;
    type = m[3]!; message = m[2] || undefined;
    const own = !LIBRARY_FRAME.test(m[1]!);
    trace.push({ text: m[1]!, role: "frame", own }); frames++;
    let i = 1;
    for (; i < lines.length && !TRACE_FRAME.test(lines[i]!.trim()); i++) if (lines[i]!.trim()) trace.push({ text: lines[i]!, role: "code", own });
    if (i === lines.length) return;
    body = lines.slice(i);
  } else if (PHP_HEADING.test(first)) {
    // PHP: "Uncaught" after the error level is the lead; " in /path:line" names the top frame.
    const m = first.match(PHP_HEADING)!;
    lead = m[1]!.replace(/[\t ]+/g, " "); type = m[2]!; message = m[3]?.trim() || undefined;
    trace.push({ text: m[4]!, role: "frame", own: !LIBRARY_FRAME.test(m[4]!) }); frames++;
    body = lines.slice(1);
  } else if (first.startsWith("panic: ") || first.startsWith("fatal error: ")) {
    const at = first.indexOf(": ");
    type = first.slice(0, at); message = first.slice(at + 2).trim() || undefined; body = lines.slice(1);
  } else if (/^thread '[^'\n]*' panicked at .+:$/.test(first) && lines[1]?.trim() && !TRACE_NOTE.test(lines[1].trim())) {
    lead = first.slice(0, -1); message = lines[1]!.trim(); body = lines.slice(2);
  } else if (/^thread '[^'\n]*' panicked at .+$/.test(first)) {
    lead = first; body = lines.slice(1);
  } else {
    const m = first.match(ERROR_HEADING);
    if (!m || m[1] === "Caused by:") return;
    lead = m[1]; type = m[2]; message = m[3]?.trim(); body = lines.slice(1);
  }
  let own: boolean | undefined, frameIndent = -1, codeIndent = -1;
  for (const raw of body) {
    const line = raw.trim(), indent = raw.length - raw.trimStart().length;
    if (!line) continue;
    if (TRACE_NOTE.test(line) || (type && trace.length && ERROR_HEADING.test(line) && !/^at /.test(line))) { trace.push({ text: line, role: "note", own: false }); own = undefined; continue; }
    if (TRACE_FRAME.test(line) && !(own !== undefined && indent > frameIndent && /^File "/.test(trace.at(-1)?.text ?? "") )) {
      own = !LIBRARY_FRAME.test(line); frameIndent = indent; codeIndent = -1;
      trace.push({ text: line, role: "frame", own }); frames++;
      continue;
    }
    // A line under a frame, indented further: Python's source line and carets, Go's file:line, Rust's "at file:line".
    // Relative indentation under a frame is kept (Python's carets point at columns of the line above).
    if (own !== undefined && indent > frameIndent) {
      if (codeIndent < 0) codeIndent = indent;
      trace.push({ text: raw.slice(Math.min(indent, codeIndent)).replace(/^\t+/, ""), role: "code", own: own && !LIBRARY_FRAME.test(line) });
      continue;
    }
    return;
  }
  if (innermost && !frames) return;
  if (innermost) { trace.push({ text: innermost, role: "frame", own: !LIBRARY_FRAME.test(innermost) }); frames++; }
  // A Rust panic names its location in the heading; a backtrace is optional.
  if (!frames && !(lead && /panicked at/.test(lead) && message)) return;
  return { kind: "error", ...(lead ? { lead } : {}), ...(type ? { type } : {}), ...(message ? { message } : {}), trace };
}

const MONTHS = String.raw`(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?`;
const WEEKDAYS = String.raw`(?:Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)[a-z]*\.?`;
/** A clock time without seconds: 09:00, 9:30am, 9 am, 下午3点, 15点半. */
const SCHEDULE_CLOCK = String.raw`(?:(?:上午|下午|早上|晚上|中午|凌晨|傍晚)\s*)?(?:\d{1,2}:\d{2}(?!:\d)(?:\s*[AaPp]\.?[Mm]\.?)?|\d{1,2}\s*[AaPp]\.?[Mm]\.?|\d{1,2}(?:点(?:半|\d{1,2}分?)?|时))`;
/** A date or a period: 2026-09-24, 2026年9月, 9月24日, 9/24, Sep 24, 24 Sep, Q3 2026, H2, 周一, 星期三, Monday, 第一周, Day 3, Week 2, 2019, today… */
const SCHEDULE_DATE = String.raw`(?:(?:${WEEKDAYS},?\s+)?(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}年\d{1,2}月(?:\d{1,2}[日号])?|\d{1,2}月\d{1,2}[日号]|\d{1,2}月(?:上旬|中旬|下旬|底|初)?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|${MONTHS}\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}\s+${MONTHS}(?:\s+\d{4})?|${MONTHS}\s+\d{4})`
  + String.raw`|(?:Q[1-4]|H[12])(?:\s*\d{4})?|\d{4}\s*(?:Q[1-4]|H[12])|(?:19|20)\d{2}年?|周[一二三四五六日天末]|星期[一二三四五六日天]|(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\.?(?=[\t ])`
  + String.raw`|第[一二三四五六七八九十百\d]+(?:周|天|日|月|季度|阶段|期|轮)|(?:Day|Week|Sprint|Phase|Month|Stage)\s+\d+|W\d{1,2}|今天|明天|后天|昨天|Today|Tomorrow|Tonight)`;
const RANGE = String.raw`\s*(?:-|–|—|~|～|to|至|到)\s*`;
const SCHEDULE_TIME = String.raw`(?:${SCHEDULE_DATE}(?:${RANGE}${SCHEDULE_DATE})?(?:[\s,]+${SCHEDULE_CLOCK}(?:${RANGE}${SCHEDULE_CLOCK})?)?|${SCHEDULE_CLOCK}(?:${RANGE}${SCHEDULE_CLOCK})?)`;
/** An event line: an optional list marker, the time, a separator (spaces, a dash, a colon, a bar, an arrow), the text. */
const EVENT_LINE = new RegExp(String.raw`^(?:[-*•][\t ]+)?(${SCHEDULE_TIME})(?:[\t ]*(?:[-–—:：|｜·•、]|->|→)[\t ]*|[\t ]+)(\S.*)$`, "i");
/** Log lines (a level after the time) and key=value records are logs, not a schedule. */
const LOG_TEXT = /^(?:\[?(?:INFO|WARN|WARNING|ERROR|ERR|DEBUG|TRACE|FATAL|NOTICE|CRITICAL|CRIT)\]?|信息|警告|错误|调试)(?:\b|\s|:)/i;

/**
 * A schedule or milestones: an optional title line (a `#` heading marker is
 * syntax), then at least two lines that each start with a time or a date and
 * have text after it. Every other line means it is not a timeline. Times
 * with seconds, log levels after the time and key=value text are logs; a
 * number or percentage after a label is a metric; fractions before cooking
 * units are a recipe.
 */
export function parseTimeline(text: string): TemplateContent | undefined {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2 || lines.length > 40) return;
  let title: string | undefined;
  const events: { time: string; text: string }[] = [];
  for (const [index, line] of lines.entries()) {
    if (/\d{1,2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T\d/.test(line.slice(0, 40))) return;
    const m = line.match(EVENT_LINE);
    if (m) {
      const time = m[1]!.trim(), body = m[2]!.trim();
      if (LOG_TEXT.test(body) || (body.match(/\b\w+=\S/g) ?? []).length >= 2) return;
      if (/^[+-]?[$€£¥￥]?\d[\d,.]*\s*(?:%|％|[kKmMbB万亿]|x|倍)?$/.test(body)) return;
      if (/^\d{1,2}\/\d{1,2}$/.test(time) && /^(?:cups?|tsp|tbsp|teaspoons?|tablespoons?|oz|lbs?|g|kg|ml|l|inch(?:es)?|in|of)\b/i.test(body)) return;
      events.push({ time, text: body });
      continue;
    }
    if (index === 0 && !events.length) {
      const heading = line.replace(/^#{1,3}[\t ]+/, "");
      if ([...heading].length <= 40) { title = heading; continue; }
    }
    return;
  }
  if (events.length < 2) return;
  return { kind: "timeline", ...(title ? { title } : {}), events };
}

/** A metric's value: a number as written, with currency, grouping, decimals, a unit or a ratio. */
const METRIC_VALUE = String.raw`(?:[≈~约]\s*)?[+\-−]?(?:[$€£¥￥]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?`
  + String.raw`(?:\s*(?:%|％|‰|pp|倍|x|×|[kKMBW]\b|万|亿|千|百万|元|美元|人|次|个|单|件|笔|天|小时|分钟|秒|ms|s\b|min|h\b|GB|MB|KB|TB|kg|km|pts?|users|people|orders|visits|views|downloads|stars|days|hours|mins?|secs?)(?![A-Za-z]))?`;
/** A change: signed (`+8%`, `−3.2%`, `↑12`, `▼ 2 pts`), optionally with a period (`WoW`, `环比`), or anything numeric in parentheses. */
const METRIC_DELTA = String.raw`(?:[(（]\s*(?:[+\-−–↑↓▲▼]\s*)?[$€£¥￥]?\d[\d,.]*\s*(?:%|％|pp|pts?|bps|x|倍)?(?:\s*(?:WoW|MoM|YoY|QoQ|DoD|w\/w|m\/m|y\/y|环比|同比))?\s*[)）]|(?:环比|同比)?\s*[+\-−–↑↓▲▼]\s*[$€£¥￥]?\d[\d,.]*\s*(?:%|％|pp|pts?|bps|x|倍)?(?:\s*(?:WoW|MoM|YoY|QoQ|DoD|环比|同比))?)`;
const METRIC_LINE = new RegExp(String.raw`^(?:[-*•][\t ]+)?([^:：\n]{1,40}?)[\t ]*[:：][\t ]*(${METRIC_VALUE})(?:[\t ]*(${METRIC_DELTA}))?$`);
/** Labels of identifiers and contact details: a number under one of these is an info field, not a metric. */
const IDENTIFIER_LABEL = /(?:^|\s)(?:phone|mobile|tel|cell|fax|qq|wechat|id|uid|pin|code|zip|postal|postcode|port|order|order id|order no|tracking|invoice|account|acct|card|user|username|password|passwd|ext|extension|room|version|year|手机|电话|座机|邮编|端口|订单|订单号|单号|快递单号|账号|帐号|卡号|身份证|工号|学号|验证码|密码|编号|房间|版本|年份)(?:\s|$)|号$/i;

/**
 * Several metrics: an optional title line (a `#` marker is syntax), then at
 * least two `label: number` lines, each value a number as written (currency,
 * grouping, units, %, a ratio) with an optional change after it. Every value
 * must be a number: a block that mixes in text, contact details, identifiers
 * (phone, order number, port…) or phone-like digit strings is an info card.
 * Labels are unique; `- ` list markers are syntax.
 */
export function parseStats(text: string): TemplateContent | undefined {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2 || lines.length > 13) return;
  let title: string | undefined;
  const metrics: StatsMetric[] = [];
  for (const [index, line] of lines.entries()) {
    const m = line.match(METRIC_LINE);
    if (m && !/^[\d\s.,:]+$/.test(m[1]!)) {
      const label = m[1]!.trim(), value = m[2]!.trim(), delta = m[3]?.trim().replace(/^[(（]\s*([\s\S]*?)\s*[)）]$/, "$1");
      if (IDENTIFIER_LABEL.test(label.toLowerCase()) || /^\+?\d{7,}$/.test(value.replace(/[\s-]/g, "")) && !/[,.$€£¥￥%]/.test(value)) return;
      metrics.push({ label, value, ...(delta ? { delta } : {}) });
      continue;
    }
    if (index === 0) {
      const heading = line.replace(/^#{1,3}[\t ]+/, "");
      // A trailing colon after the title is syntax.
      if ([...heading].length <= 40 && !/[:：]\s*\S/.test(heading)) { title = heading.replace(/[\t ]*[:：]$/, ""); continue; }
    }
    return;
  }
  if (metrics.length < 2 || metrics.length > 12) return;
  const labels = metrics.map((metric) => metric.label.toLowerCase());
  if (new Set(labels).size !== labels.length) return;
  return { kind: "stats", ...(title ? { title } : {}), metrics };
}

/** An LRC timestamp: `[mm:ss]`, `[mm:ss.xx]`, `[mm:ss:xx]`. */
const LRC_STAMP = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const LRC_LINE = /^((?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\][\t ]*)+)(.*)$/;
/** LRC header tags: file metadata, syntax like the timestamps (the title and artist are drawn). */
const LRC_TAG = /^\[(ti|ar|al|au|by|offset|length|re|ve|tool|la|#):([^\]\n]*)\]$/i;
/** Enhanced LRC word timings inside a line. */
const LRC_WORD = /<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g;
/** A section label on its own line: `[Chorus]`, `[Verse 1]`, `【副歌】`. */
const SECTION_LABEL = /^(?:\[[^\]\n\d:][^\]\n]{0,29}\]|【[^】\n]{1,20}】)$/;
/** Characters one lyric line may hold, counting a CJK character as one and anything else as a half. */
export const LYRIC_LINE_UNITS = 20;
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
const lineUnits = (text: string) => [...text].reduce((n, c) => n + (WIDE.test(c) ? 1 : 0.5), 0);
/** Words that give a line a lyric voice: people, feelings, night and sky. */
const LYRIC_VOICE = /\b(?:i|i'm|i'll|i've|i'd|me|my|mine|you|you're|you'll|your|yours|we|we're|us|our|love|heart|baby|night|tonight|dream|dreams|forever|oh|ooh|yeah|sky|stars?|rain|fire|soul|dance|alone|remember)\b|[我你她爱心梦夜风雨月星泪]|回忆|永远|世界|天空|君|僕|私|あなた|夢|恋|涙|空|愛|心|夜/i;
/** Classical verse: phrases of Han characters between these marks. */
const POEM_MARKS = /[，。？！、；：,.?!;:]/u;

/** Grapheme offsets and text of one lyric line with its markup read and removed. */
export function parseLyricLine(raw: string): LyricLine | undefined {
  let body = raw.replace(LRC_WORD, "").trim();
  let note: string | undefined;
  // `lyric|note`: one bar with text on both sides.
  const bar = body.match(/^([^|]*\S)[\t ]*\|[\t ]*(\S[^|]*)$/);
  if (bar) { body = bar[1]!.trim(); note = bar[2]!.trim(); }
  // `/` cuts the line where it stands between letters (never between digits, in `//` or a URL).
  const pieces = slashPieces(body);
  const out: string[] = [], breaks: number[] = [], emphasis: [number, number][] = [];
  let length = 0;
  const count = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
  for (const [index, piece] of pieces.entries()) {
    if (index) {
      // Two Latin words either side of a bare `/` keep a space between them.
      const space = /[\p{Script=Latin}\d'’,.!?)]$/u.test(out.at(-1)!) && /^[\p{Script=Latin}\d'‘(]/u.test(piece) ? " " : "";
      out.push(space); length += count(space); breaks.push(length);
    }
    let cursor = 0;
    for (const m of piece.matchAll(/\*([^*\s](?:[^*]*[^*\s])?)\*/g)) {
      const before = piece.slice(cursor, m.index);
      out.push(before); length += count(before);
      const start = length;
      out.push(m[1]!); length += count(m[1]!);
      emphasis.push([start, length]);
      cursor = m.index! + m[0].length;
    }
    const rest = piece.slice(cursor);
    out.push(rest); length += count(rest);
  }
  const text = out.join("");
  if (!text.trim()) return;
  return { text, ...(breaks.length ? { breaks } : {}), ...(emphasis.length ? { emphasis } : {}), ...(note ? { note } : {}) };
}

/** Classical Chinese verse: every line one or two phrases of 4–7 Han characters, all phrases the same length, an even number of them. */
function poemLines(lines: readonly string[]): boolean {
  const phrases: number[] = [];
  for (const line of lines) {
    if (!/^[\p{Script=Han}，。？！、；：,.?!;:]+$/u.test(line) || !/\p{Script=Han}/u.test(line)) return false;
    const parts = line.split(POEM_MARKS).filter(Boolean);
    if (parts.length < 1 || parts.length > 2) return false;
    phrases.push(...parts.map((part) => [...part].length));
  }
  return phrases.length >= 4 && phrases.length <= 32 && phrases.length % 2 === 0 && phrases.every((n) => n === phrases[0]) && phrases[0]! >= 4 && phrases[0]! <= 7;
}

/**
 * Song lyrics and poems. Three ways in:
 * - LRC: every non-blank line is a timestamped line or a header tag, at least
 *   two with text. Timestamps give the timing and are syntax.
 * - A classical poem: equal phrases of 4–7 Han characters (床前明月光，…), an
 *   even number, optionally under a title line and an author line, or with a
 *   `—— author` line at the end.
 * - Lyrics: at least three lines (four without markup), each short (at most
 *   LYRIC_LINE_UNITS: 20 CJK or 40 Latin characters), almost no sentence
 *   punctuation, nothing that marks another structure (list markers, `key:
 *   value` fields, times, URLs, code), and some evidence of a song: JIZURA
 *   markup (`/` cuts, `*emphasis*`, `lyric|note`); stanzas between blank
 *   lines or a repeated line, with a lyric voice (I, you, love, night; 我, 你,
 *   夢…) somewhere; or at least six lines, 60% of them in that voice. `[Chorus]` lines label their stanza; a first
 *   `# ` line is the title.
 */
export function parseLyrics(text: string): TemplateContent | undefined {
  const raw = text.split("\n").map((line) => line.trim());
  const filled = raw.filter(Boolean);
  if (filled.length < 2 || filled.length > 160) return;
  const lrc = filled.filter((line) => LRC_LINE.test(line)).length;
  if (lrc) return lrc >= 2 && filled.every((line) => LRC_LINE.test(line) || LRC_TAG.test(line)) ? parseLrc(filled) : undefined;
  // A classical poem, with its title and author lines or an attribution.
  let body = filled, credit: string | undefined, title: string | undefined;
  const attribution = body.at(-1)!.match(/^(?:——|—|--)[\t ]*(\S.{0,39})$/);
  if (attribution) { credit = attribution[1]!.trim(); body = body.slice(0, -1); }
  for (let head = 0; head <= 2 && head < body.length; head++) {
    const verse = body.slice(head);
    if (!poemLines(verse)) continue;
    const header = body.slice(0, head);
    if (header.some((line) => [...line].length > 16 || POEM_MARKS.test(line.slice(-1)))) break;
    if (head === 2 && credit) break;
    const poemTitle = header[0], author = header[1] ?? credit;
    const stanzas: LyricStanza[] = [];
    let current: LyricLine[] = [];
    // Blank lines inside the verse split stanzas.
    let seen = 0;
    for (const line of raw) {
      if (!line) { if (current.length) { stanzas.push({ lines: current }); current = []; } continue; }
      if (seen++ < head || !verse.includes(line)) continue;
      current.push({ text: line });
    }
    if (current.length) stanzas.push({ lines: current });
    return { kind: "lyrics", ...(poemTitle ? { title: poemTitle } : {}), ...(author ? { credit: author } : {}), poem: true, stanzas };
  }
  credit = undefined;
  // Lyrics.
  const stanzas: { label?: string; lines: LyricLine[] }[] = [];
  let current: { label?: string; lines: LyricLine[] } | undefined;
  let markup = false, prose = 0, lines = 0, voice = 0;
  const seenLines = new Map<string, number>();
  let fields = 0;
  for (const [index, line] of raw.entries()) {
    if (!line) { current = undefined; continue; }
    if (index === raw.findIndex(Boolean) && /^#[\t ]+\S/.test(line)) { title = line.replace(/^#[\t ]+/, ""); continue; }
    if (SECTION_LABEL.test(line)) {
      if (current?.lines.length) current = undefined;
      current ??= (stanzas.push({ lines: [] }), stanzas.at(-1)!);
      if (current.label) return;
      current.label = line; continue;
    }
    // Other structures and prose.
    if (/^(?:[-*•+]|\d+[.)、])[\t ]|^>|^#|^(?:`{3,}|~{3,})|^\||\|$|\t/.test(line)) return;
    if (/https?:\/\/|www\.|\S+@\S+\.\w|[{};=<>`]|=>|->|→|\$\s/.test(line)) return;
    if (/^[^:：]{1,24}[:：][\t ]*\S/.test(line) && ++fields >= 2) return;
    if (EVENT_LINE.test(line) && /^\d|^(?:上午|下午|早上|晚上|周|星期|Q[1-4])/.test(line)) return;
    const parsed = parseLyricLine(line);
    if (!parsed) return;
    if (parsed.text.length > 0 && (parsed.text.match(/\d/g)?.length ?? 0) / [...parsed.text].length > 0.3) return;
    if (lineUnits(parsed.text) > LYRIC_LINE_UNITS || (parsed.note && lineUnits(parsed.note) > LYRIC_LINE_UNITS)) return;
    if (parsed.breaks || parsed.emphasis || parsed.note) markup = true;
    // Sentence punctuation: a line ending in a full stop, or a sentence ending inside it.
    if (/(?<![.…])[.。．;；:：]$/.test(parsed.text) || /(?<!\.)[.。;；](?!\.)[\t ]*\S/.test(parsed.text.replace(/\d\.\d/g, ""))) prose++;
    if (LYRIC_VOICE.test(parsed.text)) voice++;
    const key = parsed.text.toLowerCase().replace(/[\s\p{P}]+/gu, "");
    seenLines.set(key, (seenLines.get(key) ?? 0) + 1);
    current ??= (stanzas.push({ lines: [] }), stanzas.at(-1)!);
    current.lines.push(parsed); lines++;
  }
  if (lines < (markup ? 3 : 4) || lines > 120) return;
  if (stanzas.some((stanza) => !stanza.lines.length)) return;
  if (prose > Math.max(1, Math.floor(lines * 0.2))) return;
  const repeated = [...seenLines.values()].some((n) => n >= 2);
  const verses = stanzas.filter((stanza) => stanza.lines.length >= 2).length >= 2;
  // Stanzas or a chorus need a lyric voice somewhere (two blocks of notes have none); voice alone needs six lines, most of them in it.
  if (!markup && !((verses || repeated) && voice >= 1) && !(lines >= 6 && voice >= lines * 0.6)) return;
  return { kind: "lyrics", ...(title ? { title } : {}), stanzas: stanzas.map((stanza) => ({ ...(stanza.label ? { label: stanza.label } : {}), lines: stanza.lines })) };
}

/** LRC: timestamped lines (one per timestamp, in time order), `[ti:]` the title and `[ar:]` the artist. A timestamp with no text ends the line before it and starts a new stanza. */
function parseLrc(lines: readonly string[]): TemplateContent | undefined {
  let title: string | undefined, credit: string | undefined;
  const entries: { at: number; text: string; order: number }[] = [];
  for (const line of lines) {
    const tag = line.match(LRC_TAG);
    if (tag) {
      const key = tag[1]!.toLowerCase(), value = tag[2]!.trim();
      if (key === "ti" && value) title = value;
      if (key === "ar" && value) credit = value;
      continue;
    }
    const m = line.match(LRC_LINE)!;
    const words = m[2]!.trim();
    for (const stamp of m[1]!.matchAll(LRC_STAMP)) {
      const fraction = stamp[3] ? Number(stamp[3].padEnd(3, "0")) : 0;
      entries.push({ at: Number(stamp[1]) * 60000 + Number(stamp[2]) * 1000 + fraction, text: words, order: entries.length });
    }
  }
  entries.sort((a, b) => a.at - b.at || a.order - b.order);
  const stanzas: { lines: LyricLine[] }[] = [];
  let current: LyricLine[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!entry.text) { if (current.length) { stanzas.push({ lines: current }); current = []; } continue; }
    const next = entries[index + 1];
    // A long line is cut at its punctuation; the pieces share its time by length.
    const pieces = lineUnits(entry.text) > LYRIC_LINE_UNITS ? splitCuts(entry.text) : [entry.text];
    const parsed = pieces.map(parseLyricLine).filter((line): line is LyricLine => Boolean(line));
    if (!parsed.length) continue;
    const span = next ? next.at - entry.at : undefined;
    const total = parsed.reduce((n, line) => n + visibleLength(line.text), 0) || 1;
    let at = entry.at;
    for (const [k, line] of parsed.entries()) {
      const until = k + 1 < parsed.length && span !== undefined ? at + Math.round(span * visibleLength(line.text) / total) : next?.at;
      current.push({ ...line, at, ...(until !== undefined ? { until } : {}) });
      if (until !== undefined) at = until;
    }
  }
  if (current.length) stanzas.push({ lines: current });
  if (stanzas.reduce((n, stanza) => n + stanza.lines.length, 0) < 2) return;
  return { kind: "lyrics", ...(title ? { title } : {}), ...(credit ? { credit } : {}), stanzas };
}

/* ───────────── Lyric motion: any text as cuts ───────────── */

/** Structures kinetic type cannot carry: their layout is their meaning. */
const LYRIC_UNFIT: readonly TemplateId[] = ["code", "terminal", "diff", "error", "diagram", "table"];

/**
 * The lyric-motion candidate for any text. Lyrics, LRC and poems keep their
 * own lines (parseLyrics); other text is prose, cut at its punctuation
 * (splitCuts); code, tables and diagrams are marked unfit, and composing them
 * is an explicit error.
 */
export function lyricMotion(text: string, candidates: ReadonlyMap<TemplateId, TemplateContent>): TemplateContent {
  const lyrics = LYRIC_UNFIT.some((id) => candidates.has(id)) ? undefined : parseLyrics(text);
  if (lyrics) return lyrics;
  // Recognised structures, and what the legacy classifier calls code (CSS, minified scripts, logs).
  // Links alone are addresses, not words.
  const links = text.split("\n").filter((line) => line.trim()).every((line) => /^\s*(?:[a-z][\w+.-]*:\/\/|www\.)\S+\s*$/i.test(line));
  if (LYRIC_UNFIT.some((id) => candidates.has(id)) || classify(text) === "code" || links) return { kind: "lyrics", unfit: "structure", stanzas: [] };
  return proseLyrics(text) ?? { kind: "lyrics", unfit: "structure", stanzas: [] };
}

/** Prose as lyric cuts: paragraphs are stanzas, a first `# ` line the title, `[Chorus]` lines labels, every other line cut by splitCuts. */
function proseLyrics(text: string): TemplateContent | undefined {
  const stanzas: { label?: string; lines: LyricLine[] }[] = [];
  let current: { label?: string; lines: LyricLine[] } | undefined;
  let title: string | undefined;
  const raw = text.split("\n").map((line) => line.trim());
  for (const [index, line] of raw.entries()) {
    if (!line) { current = undefined; continue; }
    if (index === raw.findIndex(Boolean) && /^#[\t ]+\S/.test(line)) { title = line.replace(/^#[\t ]+/, ""); continue; }
    if (SECTION_LABEL.test(line) && !current?.lines.length && !current?.label) {
      current ??= (stanzas.push({ lines: [] }), stanzas.at(-1)!);
      current.label = line; continue;
    }
    // `lyric|note`: the note goes with the line's last cut.
    const bar = line.match(/^([^|]*\S)[\t ]*\|[\t ]*(\S[^|]*)$/);
    const body = bar ? bar[1]!.trim() : line;
    const cuts = splitCuts(body).map(parseLyricLine).filter((cut): cut is LyricLine => Boolean(cut));
    if (!cuts.length) continue;
    if (bar) cuts[cuts.length - 1] = { ...cuts.at(-1)!, note: bar[2]!.trim() };
    current ??= (stanzas.push({ lines: [] }), stanzas.at(-1)!);
    current.lines.push(...cuts);
  }
  const filled = stanzas.filter((stanza) => stanza.lines.length);
  if (!filled.length) return;
  return { kind: "lyrics", ...(title ? { title } : {}), prose: true, stanzas: filled.map((stanza) => ({ ...(stanza.label ? { label: stanza.label } : {}), lines: stanza.lines })) };
}

/** Units (a CJK character one, anything else a half) one cut may hold; longer clauses are broken between words. */
export const CUT_MAX_UNITS = 16;
/** Clauses of one sentence share a cut while it stays within this many units. */
export const CUT_JOIN_UNITS = 10;
/** A clause this short (an "Oh," or a "嗯，") always joins the next one of its sentence, within CUT_MAX_UNITS. */
const CUT_TINY_UNITS = 3;
const visibleLength = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].filter((g) => g.segment.trim()).length;
/** Latin abbreviations whose full stop ends no sentence. */
const ABBREVIATION = /(?:^|[\s(])(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|cf|no|fig|approx|inc|ltd|co)\.$/i;
/** Closing marks that stay with the clause before them. */
const CLOSERS = /^[”’"'」』）)\]】》〉〕…·—‥~～!！?？.。]$/u;

/**
 * One line of prose as cuts (raw text, markup kept). Boundaries: sentence
 * ends (。！？!?. …) always; clause marks (，、；：,;: and a dash) join
 * neighbours up to CUT_JOIN_UNITS; a Latin mark counts only before a space (so
 * 3.14, 1,000 and URLs stay whole), an abbreviation's full stop never.
 * Explicit `/` cut marks are kept as boundaries. A clause over CUT_MAX_UNITS
 * is broken between words (ICU; Japanese after a particle, Chinese before a
 * conjunction or after 的/了, English before a conjunction or preposition),
 * never inside a word or an `*emphasis*` run.
 */
export function splitCuts(line: string): string[] {
  const text = line.trim();
  if (!text) return [];
  // Explicit cut marks first (the same rule as parseLyricLine).
  const marked = slashPieces(text);
  if (marked.length > 1) return marked.flatMap(splitCuts);
  const protectedAt = protectedRanges(text);
  const inside = (i: number) => protectedAt.some(([a, b]) => i > a && i < b);
  // Clauses: [text, ends a sentence].
  const clauses: { text: string; end: boolean; series?: boolean }[] = [];
  const chars = [...text];
  let start = 0, offset = 0;
  const offsets: number[] = [];
  for (const c of chars) { offsets.push(offset); offset += c.length; }
  offsets.push(offset);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!, next = chars[i + 1];
    let kind: "sentence" | "clause" | "series" | undefined;
    if (/[。！？!?…‥]/u.test(c)) kind = "sentence";
    else if (/[，；：]/u.test(c)) kind = "clause";
    else if (c === "、") kind = "series";
    else if (c === "." && (next === undefined || /\s/.test(next)) && !ABBREVIATION.test(text.slice(0, offsets[i + 1])) && !/\.\.$/.test(text.slice(0, offsets[i + 1]))) kind = "sentence";
    else if (c === "." && next === undefined) kind = "sentence";
    else if (/[,;:]/.test(c) && next !== undefined && /\s/.test(next)) kind = "clause";
    else if (/[—–]/.test(c) && (next === undefined || /\s|[—–]/.test(next)) && i > 0 && /\s|[—–]/.test(chars[i - 1]!)) kind = "clause";
    if (!kind || next === undefined || inside(offsets[i]!)) continue;
    // Closing quotes, brackets and repeated marks stay with the clause.
    let j = i + 1;
    while (j < chars.length && CLOSERS.test(chars[j]!)) j++;
    if (j >= chars.length) break;
    if (inside(offsets[j]!)) continue;
    const piece = text.slice(offsets[start], offsets[j]).trim();
    if (piece) clauses.push({ text: piece, end: kind === "sentence", series: kind === "series" });
    start = j; i = j - 1;
  }
  const rest = text.slice(offsets[start]).trim();
  if (rest) clauses.push({ text: rest, end: true });
  // Join clauses of one sentence while the cut stays short.
  const joined: string[] = [];
  let cut = "", cutEnds = true, series = false;
  const glue = (a: string, b: string) => (a && /[\p{Script=Latin}\d,;:.!?'’"”)\]]$/u.test(a) && /^[\p{Script=Latin}\d'‘"“(\[*]/u.test(b) ? `${a} ${b}` : a + b);
  for (const clause of clauses) {
    const merged = glue(cut, clause.text);
    // Items of a series (、) stay together up to the full cut.
    const room = series || units(cut) <= CUT_TINY_UNITS ? CUT_MAX_UNITS : CUT_JOIN_UNITS;
    if (cut && !cutEnds && units(merged) <= room) { cut = merged; cutEnds = clause.end; series = Boolean(clause.series); continue; }
    if (cut) joined.push(cut);
    cut = clause.text; cutEnds = clause.end; series = Boolean(clause.series);
  }
  if (cut) joined.push(cut);
  return joined.flatMap((piece) => (units(piece) > CUT_MAX_UNITS ? breakClause(piece) : [piece]));
}

/** A cut's units as drawn (emphasis marks are syntax). */
const units = (text: string) => lineUnits(text.replace(/\*([^*\s](?:[^*]*[^*\s])?)\*/g, "$1"));

/** A line split at its `/` cut marks: between letters, never between digits, in `//`, or inside a URL or an address. */
export function slashPieces(text: string): string[] {
  const protectedAt = protectedRanges(text).filter(([a, b]) => !/^\*/.test(text.slice(a, b)));
  const pieces: string[] = [];
  let from = 0;
  for (const m of text.matchAll(/(?<![\d/:])[\t ]*\/[\t ]*(?![\d/])/g)) {
    const at = m.index!;
    if (protectedAt.some(([a, b]) => at >= a && at < b)) continue;
    pieces.push(text.slice(from, at)); from = at + m[0].length;
  }
  pieces.push(text.slice(from));
  return pieces.map((piece) => piece.trim()).filter(Boolean);
}

/** Character offsets (UTF-16) of `*emphasis*` runs and URLs: no cut falls inside them. */
function protectedRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/\*([^*\s](?:[^*]*[^*\s])?)\*|https?:\/\/\S+|www\.\S+|\S+@\S+\.\w+/g)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

const JA_PARTICLE_END = /(?:は|が|を|に|で|と|も|へ|や|の|から|まで|より|って|ても|ては|ので|けど|けれど|ながら|ば|て|し)$/u;
const ZH_BREAK_BEFORE = /^(?:和|与|跟|但|但是|而|而且|或|或者|因为|所以|如果|就|才|都|也|还|却|并|并且|然后|可是|虽然|只要|只是|于是|即使|直到|让|把|被|在|从|向|对)$/u;
const ZH_BREAK_AFTER = /(?:了|着|过)$/u;
/** English words a cut should not end on: articles, possessives, prepositions and subject pronouns lead into what follows. */
const EN_NO_END = /^(?:the|a|an|my|your|his|her|our|their|its|this|these|those|to|of|in|on|at|for|with|from|by|i|we|they|he|she|and|or|but|very|so|not|no)$/i;
const EN_BREAK_BEFORE = /^(?:and|but|or|nor|so|yet|because|that|which|who|whom|whose|when|where|while|with|without|to|for|of|in|on|at|from|into|onto|than|as|if|unless|until|after|before|since|through|about|like|over|under)$/i;

/** A clause over CUT_MAX_UNITS broken between words into near-even pieces, preferring natural points. */
function breakClause(clause: string): string[] {
  const locale = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(clause) ? "ja" : /\p{Script=Han}/u.test(clause) ? "zh" : "en";
  const protectedAt = protectedRanges(clause);
  const words = [...new Intl.Segmenter(locale, { granularity: "word" }).segment(clause)].map((part) => ({ text: part.segment, index: part.index }));
  // Break candidates: offsets between segments, never in a protected run, before closing punctuation or after an opening bracket, and between Latin words only at a space.
  const breaks: { at: number; good: boolean; bad: boolean }[] = [];
  for (let k = 1; k < words.length; k++) {
    const at = words[k]!.index, before = words[k - 1]!.text, after = words[k]!.text;
    if (protectedAt.some(([a, b]) => at > a && at < b)) continue;
    if (/^[\s]*$/.test(before) && k < 2) continue;
    if (/^[，。、；：？！）」』”’》〉】〕…—·,.;:?!)\]}%％‰~～]/u.test(after.trimStart()) || /[（「『“‘《〈【〔(\[{]$/u.test(before)) continue;
    const latinJoin = /[\p{Script=Latin}\d'’]$/u.test(before) && /^[\p{Script=Latin}\d'‘]/u.test(after);
    if (latinJoin) continue;
    if (locale === "en" && !/\s$/.test(before) && !/^\s/.test(after)) continue;
    if (/^\s+$/.test(after)) continue;
    const word = after.trim();
    // The word before the break (ICU gives spaces their own segment).
    let back = k - 1;
    while (back > 0 && !words[back]!.text.trim()) back--;
    const previous = words[back]!.text.trim();
    const good = locale === "ja" ? JA_PARTICLE_END.test(previous) && !/^[\p{Script=Hiragana}ー]/u.test(word)
      : locale === "zh" ? ZH_BREAK_BEFORE.test(word) || (ZH_BREAK_AFTER.test(previous) && /\p{Script=Han}/u.test(word))
      : EN_BREAK_BEFORE.test(word) || /[,;:]$/.test(previous);
    const bad = locale === "en" && EN_NO_END.test(previous) || locale === "zh" && /[的地得]$/u.test(previous);
    breaks.push({ at, good: good && !bad, bad });
  }
  const pieces: string[] = [];
  let from = 0;
  while (units(clause.slice(from)) > CUT_MAX_UNITS) {
    const left = units(clause.slice(from));
    const target = left / Math.ceil(left / CUT_MAX_UNITS);
    let best: { at: number; cost: number } | undefined;
    for (const b of breaks) {
      if (b.at <= from) continue;
      const n = units(clause.slice(from, b.at).trim());
      if (n > CUT_MAX_UNITS && best) break;
      if (n < Math.min(4, target * 0.5)) continue;
      const cost = Math.abs(n - target) - (b.good ? target * 0.35 : 0) + (b.bad ? target * 0.5 : 0) + (n > CUT_MAX_UNITS ? 100 + n : 0);
      if (!best || cost < best.cost) best = { at: b.at, cost };
    }
    if (!best) break;
    pieces.push(clause.slice(from, best.at).trim());
    from = best.at;
  }
  const rest = clause.slice(from).trim();
  if (rest) pieces.push(rest);
  return pieces.filter(Boolean);
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
