/**
 * What a model may see of a text. Detection is regular expressions and small
 * checks (Luhn, the ID-card checksum, entropy), never a model: it runs on
 * every decision, locally, in microseconds.
 *
 * Two sets of rules:
 *   built-in  secrets (on by default) and personal data (off by default),
 *             each with a typed placeholder such as [密钥] or [邮箱];
 *   user      a literal text, a keyword list or a regex, replaced by the
 *             user's own text; `alsoInOutput` also replaces it in what is
 *             rendered, not only in what the model sees.
 *
 * Offsets are UTF-16 code units of the original text (NSRange-compatible).
 * Overlapping matches: the earliest start wins, then the longest, then the
 * rule listed first (user rules before built-ins).
 */

export type ModelContentMode = "raw" | "redacted" | "structure";
export const MODEL_CONTENT_MODES: readonly ModelContentMode[] = ["raw", "redacted", "structure"];

export interface UserRule {
  readonly id: string;
  readonly name: string;
  readonly match: "text" | "keywords" | "regex";
  readonly pattern: string;
  readonly replacement: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly alsoInOutput: boolean;
  readonly enabled: boolean;
}

export interface PrivacyConfig {
  readonly modelContent: ModelContentMode;
  /** Overrides of built-in defaults, by rule id. */
  readonly builtins: Readonly<Record<string, boolean>>;
  readonly rules: readonly UserRule[];
}

export const DEFAULT_PRIVACY: PrivacyConfig = { modelContent: "redacted", builtins: {}, rules: [] };

/** Contract limits for user rules. */
export const PRIVACY_LIMITS = { rules: 100, pattern: 500, replacement: 100 } as const;

export interface Span {
  readonly start: number;
  readonly end: number;
  readonly ruleId: string;
  readonly replacement: string;
}

export class PrivacyConfigError extends Error {}

/* ---- built-in rules ------------------------------------------------------ */

interface Hit { readonly start: number; readonly end: number; readonly replacement?: string }

export interface BuiltinRule {
  readonly id: string;
  readonly name: string;
  readonly nameZh: string;
  readonly description: string;
  readonly descriptionZh: string;
  readonly defaultEnabled: boolean;
  /** A secret (counts for containsSecret) rather than personal data. */
  readonly secret: boolean;
  readonly replacement: string;
  find(text: string): Hit[];
}

function all(re: RegExp, text: string, group?: number, check?: (m: RegExpExecArray) => boolean): Hit[] {
  const out: Hit[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    if (check && !check(m)) continue;
    if (group === undefined) out.push({ start: m.index, end: m.index + m[0].length });
    else if (m[group]) {
      // Regexes with a group carry the `d` flag; without it the group is the match's tail.
      const start = m.indices?.[group]?.[0] ?? m.index + m[0].lastIndexOf(m[group]);
      out.push({ start, end: start + m[group].length });
    }
  }
  return out;
}

const API_KEY_PATTERNS: readonly RegExp[] = [
  // OpenAI (sk-, sk-proj-, sk-svcacct-) and Anthropic (sk-ant-…).
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9_])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,}/g,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}/g,
  /(?<![A-Za-z0-9-])xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9_])(?:sk|rk)_live_[A-Za-z0-9]{16,}/g,
];
const AWS_SECRET = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g;

function apiKeys(text: string): Hit[] {
  const hits = API_KEY_PATTERNS.flatMap((re) => all(re, text));
  // An AWS secret access key is 40 base64 characters; alone it is
  // indistinguishable from other data, so it needs context: an access key id
  // in the text or "aws"/"secret" shortly before it. Hex (a git SHA) never.
  const hasKeyId = /(?:AKIA|ASIA)[A-Z0-9]{16}/.test(text);
  hits.push(...all(AWS_SECRET, text, undefined, (m) => {
    if (/^[0-9a-f]+$/i.test(m[0]) || !/[A-Z]/.test(m[0]) || !/[a-z]/.test(m[0])) return false;
    return hasKeyId || /aws|secret/i.test(text.slice(Math.max(0, m.index - 100), m.index));
  }));
  return hits;
}

const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$(?![\s\S]))/g;
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const AUTH_HEADER = /\bAuthorization\s*[:=]\s*(?:(?:Bearer|Basic|Token|Digest|Bot)\s+)?([^\s"',;]{8,})/gdi;
const BEARER = /\b(?:Bearer|Token)\s+([A-Za-z0-9._~+/-]{12,}=*)/gd;

function bearerTokens(text: string): Hit[] {
  const plainWord = (s: string) => /^[A-Za-z]+$/.test(s) && !(/[a-z]/.test(s) && /[A-Z]/.test(s.slice(1)));
  return [
    ...all(AUTH_HEADER, text, 1),
    ...all(BEARER, text, 1, (m) => !plainWord(m[1]!)),
  ];
}

const CONNECTION = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/?#@]+:([^\s@/?#]+)@/gd;

const SECRET_KEY = String.raw`(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)`;
const ASSIGNMENT = new RegExp(
  String.raw`((?<![A-Za-z0-9])[A-Za-z0-9_.-]*?${SECRET_KEY}(?:[_.-][A-Za-z0-9_.-]*)?(?![A-Za-z0-9])|[\p{L}\p{N}_]*?(?:密码|密钥|口令|令牌))` +
  String.raw`["']?[\t ]*(?:=>|[:：]|=(?!=))[\t ]*(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"'，。；,;]+))`, "giu");
const NOT_A_VALUE = /^(?:\*+|x{3,}|<[^>]*>|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|null|none|nil|true|false|undefined|\[[^\]]*\]|["']+)$/i;

function assignmentReplacement(key: string): string {
  const k = key.toLowerCase();
  if (/password|passwd|pwd|密码|口令/.test(k)) return "[密码]";
  if (/token|令牌/.test(k)) return "[令牌]";
  return "[密钥]";
}

function secretAssignments(text: string): Hit[] {
  const out: Hit[] = [];
  ASSIGNMENT.lastIndex = 0;
  for (let m = ASSIGNMENT.exec(text); m; m = ASSIGNMENT.exec(text)) {
    const group = m[2] !== undefined ? 2 : m[3] !== undefined ? 3 : 4;
    const value = m[group]!;
    if (NOT_A_VALUE.test(value) || value.length < 3) continue;
    const start = m.index + m[0].lastIndexOf(value);
    out.push({ start, end: start + value.length, replacement: assignmentReplacement(m[1]!) });
  }
  return out;
}

/* random-looking tokens */
const TOKEN_RUN = /[A-Za-z0-9_+/-]{20,}={0,2}/g;
const URL_RUN = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'）)\]]+/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  const n = [...s].length;
  for (const k of counts.values()) { const p = k / n; h -= p * Math.log2(p); }
  return h;
}

/** Made of words: every separator-, case- or digit-delimited piece reads like a word or a small number. */
function wordish(s: string): boolean {
  const pieces = s.split(/[-_./+=]+/).filter(Boolean).flatMap((p) => p.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/));
  // Random strings fall apart into many one- or two-character pieces.
  if (pieces.length > s.length / 3.5) return false;
  return pieces.every((p) => /^[A-Z]?[a-z]{1,14}$/.test(p) || /^[A-Z]{1,8}s?$/.test(p) || /^\d{1,4}$/.test(p) || /^v\d+$/i.test(p));
}

export function looksRandom(s: string): boolean {
  if (s.length < 20) return false;
  const core = s.replace(/^[-_/+=]+|[-_/+=]+$/g, "");
  if (core.length < 20) return false;
  if (/^[0-9a-f]+$/i.test(core) && core.length <= 64) return false; // git SHAs and hashes
  if (UUID.test(core)) return false;
  if (/^\d+$/.test(core)) return false; // numbers are other rules' business
  if (wordish(core)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[_+/=-]/].filter((re) => re.test(core)).length;
  const alnum = core.replace(/[^A-Za-z0-9]/g, "");
  if (classes >= 3 && /\d/.test(core) && /[A-Za-z]/.test(core)) return true;
  // High entropy relative to what the length allows.
  return shannonEntropy(alnum) >= 0.85 * Math.log2(Math.min(alnum.length, 64));
}

function randomTokens(text: string): Hit[] {
  const urls = all(URL_RUN, text);
  const inUrl = (start: number, end: number) => urls.some((u) => start >= u.start && end <= u.end);
  return all(TOKEN_RUN, text, undefined, (m) => !inUrl(m.index, m.index + m[0].length) && looksRandom(m[0]));
}

const EMAIL = /(?<![\p{L}\p{N}._%+:/-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const CN_MOBILE = /(?<![\d+])(?:\+?86[-\s]?)?1[3-9]\d(?:[-\s]?\d{4}){2}(?!\d)/g;
const E164 = /(?<![\d\w+])\+[1-9]\d{0,3}(?:[-\s]?\(?\d{1,4}\)?){2,5}(?!\d)/g;

function phones(text: string): Hit[] {
  return [...all(CN_MOBILE, text), ...all(E164, text, undefined, (m) => { const d = m[0].replace(/\D/g, ""); return d.length >= 8 && d.length <= 15; })];
}

const ID_CARD = /(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])/g;
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
export function idCardValid(id: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(id)) return false;
  const sum = ID_WEIGHTS.reduce((s, w, i) => s + w * Number(id[i]), 0);
  return "10X98765432"[sum % 11] === id[17]!.toUpperCase();
}

const BANK_CARD = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

export const BUILTIN_RULES: readonly BuiltinRule[] = [
  { id: "api-keys", name: "API keys", nameZh: "API 密钥", defaultEnabled: true, secret: true, replacement: "[密钥]",
    description: "Well-known key formats: OpenAI, Anthropic, GitHub, AWS, Google, Slack, Stripe.",
    descriptionZh: "常见服务的密钥格式：OpenAI、Anthropic、GitHub、AWS、Google、Slack、Stripe。", find: apiKeys },
  { id: "private-keys", name: "Private keys", nameZh: "私钥", defaultEnabled: true, secret: true, replacement: "[私钥]",
    description: "PEM and OpenSSH private key blocks.", descriptionZh: "PEM、OpenSSH 等私钥块。", find: (t) => all(PRIVATE_KEY, t) },
  { id: "jwt", name: "JSON Web Tokens", nameZh: "JWT 令牌", defaultEnabled: true, secret: true, replacement: "[令牌]",
    description: "Tokens of the form eyJ….….….", descriptionZh: "形如 eyJ….….… 的登录令牌。", find: (t) => all(JWT, t) },
  { id: "bearer-tokens", name: "Authorization headers", nameZh: "授权头", defaultEnabled: true, secret: true, replacement: "[令牌]",
    description: "The value of Authorization headers and Bearer tokens.", descriptionZh: "Authorization 请求头与 Bearer 令牌的值。", find: bearerTokens },
  { id: "connection-strings", name: "Passwords in URLs", nameZh: "链接里的密码", defaultEnabled: true, secret: true, replacement: "[密码]",
    description: "The password in URLs and database strings like scheme://user:password@host.", descriptionZh: "scheme://用户:密码@主机 这类链接和数据库连接串里的密码。", find: (t) => all(CONNECTION, t, 1) },
  { id: "secret-assignments", name: "Passwords and secrets in settings", nameZh: "配置里的密码与密钥", defaultEnabled: true, secret: true, replacement: "[密码]",
    description: "The value after password=, token:, api_key=, 密码： and similar; the name stays.", descriptionZh: "password=、token:、api_key=、密码： 等后面的值；名称保留。", find: secretAssignments },
  { id: "random-tokens", name: "Random-looking tokens", nameZh: "随机字符串", defaultEnabled: true, secret: true, replacement: "[令牌]",
    description: "Long random strings (20+ characters). Git hashes, UUIDs, words and plain links are left alone.", descriptionZh: "20 位以上的随机字符串。Git 哈希、UUID、普通单词和不带密码的链接不算。", find: randomTokens },
  { id: "email", name: "Email addresses", nameZh: "邮箱地址", defaultEnabled: false, secret: false, replacement: "[邮箱]",
    description: "Email addresses.", descriptionZh: "电子邮箱地址。", find: (t) => all(EMAIL, t) },
  { id: "phone", name: "Phone numbers", nameZh: "手机号", defaultEnabled: false, secret: false, replacement: "[手机号]",
    description: "Mainland China mobile numbers and international +… numbers.", descriptionZh: "中国大陆手机号与 + 开头的国际号码。", find: phones },
  { id: "id-card", name: "ID card numbers", nameZh: "身份证号", defaultEnabled: false, secret: false, replacement: "[身份证号]",
    description: "18-digit resident ID numbers with a valid checksum.", descriptionZh: "校验位正确的 18 位居民身份证号。", find: (t) => all(ID_CARD, t, undefined, (m) => idCardValid(m[0])) },
  { id: "bank-card", name: "Bank card numbers", nameZh: "银行卡号", defaultEnabled: false, secret: false, replacement: "[银行卡号]",
    description: "13–19 digit card numbers that pass the Luhn check.", descriptionZh: "13–19 位、通过 Luhn 校验的银行卡号。",
    find: (t) => all(BANK_CARD, t, undefined, (m) => { const d = m[0].replace(/\D/g, ""); return d.length >= 13 && d.length <= 19 && luhnValid(d) && !idCardValid(d); }) },
];

export const BUILTIN_IDS = BUILTIN_RULES.map((r) => r.id);

/* ---- user rules ---------------------------------------------------------- */

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** A group that repeats something that itself repeats: `(a+)+`, `(\w*)*`, `(x|y+){2,}`. */
export function hasNestedQuantifier(source: string): boolean {
  const stack: boolean[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\\") { i++; continue; }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; continue; }
    if (c === "(") { stack.push(false); continue; }
    const quant = c === "*" || c === "+" || (c === "{" && /^\{\d+(,\d*)?\}/.test(source.slice(i)));
    if (c === ")") {
      const inner = stack.pop() ?? false;
      const next = source[i + 1];
      const outer = next === "*" || next === "+" || (next === "{" && /^\{\d+,\d*\}/.test(source.slice(i + 1)));
      if (inner && outer) return true;
      if (inner && stack.length) stack[stack.length - 1] = true;
      continue;
    }
    if (quant && stack.length) stack[stack.length - 1] = true;
  }
  return false;
}

interface CompiledRule {
  readonly id: string;
  readonly replacement: string;
  readonly secret: boolean;
  readonly find: (text: string) => Hit[];
}

function wordBoundaries(text: string): Set<number> {
  const set = new Set<number>([0, text.length]);
  for (const s of new Intl.Segmenter("zh", { granularity: "word" }).segment(text)) { set.add(s.index); set.add(s.index + s.segment.length); }
  return set;
}
const WORD_CHAR = /[\p{L}\p{N}_]/u;
/** A match is a whole word when each edge is a segmenter word boundary or sits next to a non-word character. */
function wholeWordAt(text: string, start: number, end: number, bounds: Set<number>): boolean {
  const before = start === 0 || !WORD_CHAR.test(text[start - 1]!) || !WORD_CHAR.test(text[start]!) || bounds.has(start);
  const after = end === text.length || !WORD_CHAR.test(text[end]!) || !WORD_CHAR.test(text[end - 1]!) || bounds.has(end);
  return before && after;
}

function compileUserRule(rule: UserRule): CompiledRule {
  let source: string;
  if (rule.match === "regex") source = rule.pattern;
  else {
    const words = (rule.match === "keywords" ? rule.pattern.split(/\r?\n/) : [rule.pattern]).map((w) => rule.match === "keywords" ? w.trim() : w).filter((w) => w.length > 0);
    if (!words.length) throw new PrivacyConfigError(`privacy rule "${rule.name}": nothing to match`);
    // Longest first so a keyword that contains another wins.
    source = words.sort((a, b) => b.length - a.length).map(escapeRegex).join("|");
  }
  if (rule.match === "regex" && hasNestedQuantifier(source)) {
    throw new PrivacyConfigError(`privacy rule "${rule.name}": the regex repeats a repeated group (like (a+)+), which can hang; simplify it`);
  }
  const flags = `g${rule.caseSensitive ? "" : "i"}`;
  let re: RegExp;
  try { re = new RegExp(source, `${flags}u`); }
  catch {
    try { re = new RegExp(source, flags); }
    catch (e) { throw new PrivacyConfigError(`privacy rule "${rule.name}": invalid regex: ${(e as Error).message}`); }
  }
  return {
    id: rule.id, replacement: rule.replacement, secret: false,
    find(text) {
      const bounds = rule.wholeWord ? wordBoundaries(text) : null;
      return all(re, text, undefined, (m) => !bounds || wholeWordAt(text, m.index, m.index + m[0].length, bounds));
    },
  };
}

/* ---- config -------------------------------------------------------------- */

export interface CompiledPrivacy {
  readonly config: PrivacyConfig;
  /** Every enabled rule, user rules first: what the model must not see. */
  readonly modelRules: readonly CompiledRule[];
  /** Enabled user rules with alsoInOutput: what the rendered output must not show. */
  readonly outputRules: readonly CompiledRule[];
  /** Enabled built-in secret rules. */
  readonly secretRules: readonly CompiledRule[];
  /** Stable over equal configs: a cache key component. */
  readonly fingerprint: string;
}

export function builtinEnabled(config: PrivacyConfig, id: string): boolean {
  const rule = BUILTIN_RULES.find((r) => r.id === id);
  return config.builtins[id] ?? rule?.defaultEnabled ?? false;
}

export function compilePrivacy(config: PrivacyConfig = DEFAULT_PRIVACY): CompiledPrivacy {
  const builtins: CompiledRule[] = BUILTIN_RULES.filter((r) => builtinEnabled(config, r.id)).map((r) => ({
    id: r.id, replacement: r.replacement, secret: r.secret, find: (t: string) => r.find(t),
  }));
  const user = config.rules.filter((r) => r.enabled).map((r) => ({ rule: r, compiled: compileUserRule(r) }));
  const fingerprint = new Bun.CryptoHasher("sha256").update(JSON.stringify({
    m: config.modelContent, b: BUILTIN_RULES.map((r) => [r.id, builtinEnabled(config, r.id)]), r: config.rules,
  })).digest("hex").slice(0, 16);
  return {
    config,
    modelRules: [...user.map((u) => u.compiled), ...builtins],
    outputRules: user.filter((u) => u.rule.alsoInOutput).map((u) => u.compiled),
    secretRules: builtins.filter((b) => b.secret),
    fingerprint,
  };
}

const bool = (v: unknown, where: string, fallback: boolean): boolean => {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") throw new PrivacyConfigError(`${where} must be true or false`);
  return v;
};

/** Validate `config.set`'s `privacy`; absent means the defaults. Throws PrivacyConfigError naming the rule. */
export function parsePrivacyConfig(raw: unknown): PrivacyConfig {
  if (raw === undefined || raw === null) return DEFAULT_PRIVACY;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new PrivacyConfigError("privacy must be an object");
  const o = raw as Record<string, unknown>;
  const modelContent = o.modelContent ?? "redacted";
  if (!MODEL_CONTENT_MODES.includes(modelContent as ModelContentMode)) throw new PrivacyConfigError(`privacy.modelContent must be one of ${MODEL_CONTENT_MODES.join(", ")}`);
  const builtins: Record<string, boolean> = {};
  if (o.builtins !== undefined) {
    if (!o.builtins || typeof o.builtins !== "object" || Array.isArray(o.builtins)) throw new PrivacyConfigError("privacy.builtins must be an object of rule id → true/false");
    for (const [id, v] of Object.entries(o.builtins)) {
      if (!BUILTIN_IDS.includes(id)) throw new PrivacyConfigError(`privacy.builtins: unknown rule ${id}; have ${BUILTIN_IDS.join(", ")}`);
      builtins[id] = bool(v, `privacy.builtins.${id}`, true);
    }
  }
  const rules: UserRule[] = [];
  if (o.rules !== undefined) {
    if (!Array.isArray(o.rules)) throw new PrivacyConfigError("privacy.rules must be an array");
    if (o.rules.length > PRIVACY_LIMITS.rules) throw new PrivacyConfigError(`privacy.rules: at most ${PRIVACY_LIMITS.rules} rules`);
    const ids = new Set<string>();
    o.rules.forEach((r, i) => {
      if (!r || typeof r !== "object" || Array.isArray(r)) throw new PrivacyConfigError(`privacy.rules[${i}] must be an object`);
      const x = r as Record<string, unknown>;
      const label = typeof x.name === "string" && x.name ? `privacy rule "${x.name}"` : `privacy.rules[${i}]`;
      if (typeof x.id !== "string" || !x.id) throw new PrivacyConfigError(`${label}: id is required`);
      if (ids.has(x.id)) throw new PrivacyConfigError(`${label}: duplicate id ${x.id}`);
      ids.add(x.id);
      if (typeof x.name !== "string") throw new PrivacyConfigError(`${label}: name must be a string`);
      if (x.match !== "text" && x.match !== "keywords" && x.match !== "regex") throw new PrivacyConfigError(`${label}: match must be text, keywords or regex`);
      if (typeof x.pattern !== "string" || x.pattern.length === 0) throw new PrivacyConfigError(`${label}: pattern is required`);
      if (x.pattern.length > PRIVACY_LIMITS.pattern) throw new PrivacyConfigError(`${label}: pattern is longer than ${PRIVACY_LIMITS.pattern} characters`);
      if (typeof x.replacement !== "string") throw new PrivacyConfigError(`${label}: replacement must be a string`);
      if (x.replacement.length > PRIVACY_LIMITS.replacement) throw new PrivacyConfigError(`${label}: replacement is longer than ${PRIVACY_LIMITS.replacement} characters`);
      const rule: UserRule = {
        id: x.id, name: x.name, match: x.match, pattern: x.pattern, replacement: x.replacement,
        caseSensitive: bool(x.caseSensitive, `${label}.caseSensitive`, false),
        wholeWord: bool(x.wholeWord, `${label}.wholeWord`, false),
        alsoInOutput: bool(x.alsoInOutput, `${label}.alsoInOutput`, false),
        enabled: bool(x.enabled, `${label}.enabled`, true),
      };
      compileUserRule(rule); // compile errors name the rule, even for a disabled one
      rules.push(rule);
    });
  }
  return { modelContent: modelContent as ModelContentMode, builtins, rules };
}

/* ---- applying ------------------------------------------------------------ */

/** Non-overlapping spans: earliest start, then longest, then the rule listed first. */
export function findSpans(text: string, rules: readonly CompiledRule[]): Span[] {
  const cands: (Span & { order: number })[] = [];
  rules.forEach((rule, order) => {
    for (const h of rule.find(text)) if (h.end > h.start) cands.push({ start: h.start, end: h.end, ruleId: rule.id, replacement: h.replacement ?? rule.replacement, order });
  });
  cands.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.order - b.order);
  const out: Span[] = [];
  let at = 0;
  for (const c of cands) {
    if (c.start < at) continue;
    out.push({ start: c.start, end: c.end, ruleId: c.ruleId, replacement: c.replacement });
    at = c.end;
  }
  return out;
}

export function applySpans(text: string, spans: readonly Span[]): string {
  let out = "";
  let at = 0;
  for (const s of spans) { out += text.slice(at, s.start) + s.replacement; at = s.end; }
  return out + text.slice(at);
}

export function redactForModel(text: string, privacy: CompiledPrivacy): { text: string; spans: Span[] } {
  const spans = findSpans(text, privacy.modelRules);
  return { text: applySpans(text, spans), spans };
}

/** The text to render: user rules marked alsoInOutput applied, nothing else. */
export function applyOutputRules(text: string, privacy: CompiledPrivacy): string {
  if (!privacy.outputRules.length) return text;
  return applySpans(text, findSpans(text, privacy.outputRules));
}

/** Any enabled built-in secret rule matched (personal-data rules do not count). */
export function containsSecret(text: string, privacy: CompiledPrivacy): boolean {
  return privacy.secretRules.some((r) => r.find(text).length > 0);
}

/** Shape without content: Latin letters → x/X, digits → 0, other letters (CJK…) → 字; whitespace, punctuation and length kept. */
export function structureOnly(text: string): string {
  let out = "";
  for (const c of text) {
    if (/\p{Script=Latin}/u.test(c) && /\p{L}/u.test(c)) out += c === c.toUpperCase() && c !== c.toLowerCase() ? "X" : "x";
    else if (/\p{Nd}/u.test(c)) out += "0";
    else if (/\p{L}/u.test(c)) out += "字";
    else out += c;
  }
  return out;
}

/** What the model receives of `text` under the mode. In structure mode the
 * placeholders stay readable ([密钥]); everything else loses its content. */
export function modelText(text: string, privacy: CompiledPrivacy, mode: ModelContentMode = privacy.config.modelContent): { text: string; spans: Span[] } {
  if (mode === "raw") return { text, spans: [] };
  const { spans } = redactForModel(text, privacy);
  if (mode === "redacted") return { text: applySpans(text, spans), spans };
  let out = "";
  let at = 0;
  for (const s of spans) { out += structureOnly(text.slice(at, s.start)) + s.replacement; at = s.end; }
  return { text: out + structureOnly(text.slice(at)), spans };
}

/** privacy.preview's answer. */
export function previewPrivacy(text: string, privacy: CompiledPrivacy, mode?: ModelContentMode) {
  const m = modelText(text, privacy, mode);
  return { modelText: m.text, outputText: applyOutputRules(text, privacy), spans: m.spans, containsSecret: containsSecret(text, privacy) };
}

/** privacy.rules' answer. */
export function describeBuiltins(config: PrivacyConfig) {
  return BUILTIN_RULES.map((r) => ({ id: r.id, name: r.name, nameZh: r.nameZh, description: r.description, descriptionZh: r.descriptionZh, defaultEnabled: r.defaultEnabled, enabled: builtinEnabled(config, r.id) }));
}
