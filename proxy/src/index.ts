/**
 * jev-proxy: the worker behind Pocket Paste's `proxy` (dev) and `hosted`
 * providers. One worker, two modes, selected by the `MODE` var:
 *
 *   dev     — `wrangler dev` on localhost. No auth. POST `/` or `/v1/ask`
 *             with `{state, questions}`; the body is validated, forwarded to
 *             Workers AI `typesafe/jev`, and the answer comes back as
 *             `{ms, ...result}`. `POST /v1/generate` with `{prompt, system?,
 *             maxTokens?, temperature?}` runs the text model in `GEN_MODEL`
 *             and returns `{text, model, ms, usage?}`.
 *   hosted  — the subscription. Both `/v1/*` routes need `Authorization:
 *             Bearer <token>`; subscribers, monthly usage and a per-minute
 *             rate limit live in the `SUBS` KV namespace. Admin and
 *             billing-webhook routes maintain the subscriber records.
 *
 * Validation is the same in both modes: `/v1/ask` is pinned to the seven
 * questions a paste asks (core/src/questions.ts), so the worker cannot be
 * used as a general Jev relay; `/v1/generate` bounds prompt, system, token
 * and temperature values. Ask and generate each count as one call against
 * the same quota.
 *
 * Privacy: request bodies and clipboard text are never logged. Each request
 * writes exactly one log line: method, path, status, ms and the first eight
 * characters of the token hash (never the token).
 *
 * KV records (all values JSON or decimal strings):
 *   tok:<sha256hex(token)>     {plan, quota, resetDay?, active, label?, createdAt, updatedAt}
 *   use:<tokenhash>:<YYYY-MM>  calls made in that billing period (UTC)
 *   rl:<tokenhash>:<minute>    calls in that unix minute, TTL 120 s
 *
 * KV counters are eventually consistent: two edge locations can each read
 * `n` and both write `n + 1`, so a subscriber may get a handful of calls
 * past the quota or the rate limit. That is acceptable for a per-month
 * quota and a crude abuse brake; billing never depends on these counters.
 */

/** The narrow KV surface the worker needs; `KVNamespace` satisfies it, so does an in-memory stub. */
export interface Kv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Env {
  /** "dev" (default) or "hosted". */
  MODE?: string;
  /** Workers AI binding. */
  AI: { run(model: string, input: unknown): Promise<unknown> };
  /** Text-generation model for /v1/generate; default DEFAULT_GEN_MODEL. */
  GEN_MODEL?: string;
  /** hosted only: subscriber records, usage and rate-limit counters. */
  SUBS?: Kv;
  /** hosted only: bearer secret for `/admin/*`. */
  ADMIN_SECRET?: string;
  /** hosted only: HMAC key for `/webhooks/billing`. */
  BILLING_WEBHOOK_SECRET?: string;
}

export type Mode = "dev" | "hosted";

export interface SubscriberRecord {
  plan: string;
  /** Calls per billing period. */
  quota: number;
  /** Day of month (1–28, UTC) the period starts; default 1 = calendar month. */
  resetDay?: number;
  active: boolean;
  label?: string;
  createdAt?: string;
  updatedAt?: string;
}

export const JEV_MODEL = "typesafe/jev";
export const DEFAULT_GEN_MODEL = "@cf/meta/llama-3.1-8b-instruct";
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_CLIPBOARD_CHARS = 2000;
export const MAX_EMPHASIS_CRITERIA = 201;
export const MAX_PROMPT_CHARS = 8000;
export const MAX_SYSTEM_CHARS = 2000;
export const MAX_GEN_TOKENS = 2048;
export const DEFAULT_GEN_TOKENS = 512;
export const RATE_LIMIT_PER_MINUTE = 60;
export const USAGE_KEY_TTL_S = 70 * 24 * 3600;

/** The seven questions and the Jev question type each must carry. */
export const QUESTION_TYPES: Readonly<Record<string, "choice" | "score" | "noul">> = {
  kind: "choice", layout: "choice", palette: "choice", scale: "score", tone: "score", animate: "noul", emphasis: "choice",
};

export interface AskBody {
  state: { clipboard: string };
  questions: Record<string, { type: string; [k: string]: unknown }>;
}

export interface GenerateBody {
  prompt: string;
  system?: string;
  maxTokens: number;
  temperature?: number;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers });

/** An HTTP failure carried through the router: status, a short JSON body, optional headers. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>, readonly headers: Record<string, string> = {}) {
    super(String(body.error ?? status));
  }
  toResponse(): Response { return json(this.status, this.body, this.headers); }
}

const bad = (error: string): HttpError => new HttpError(400, { error });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** True when `s` has more than `max` code points (not UTF-16 units: one emoji is one character). Stops early. */
const longerThan = (s: string, max: number): boolean => {
  let n = 0;
  for (const _ of s) if (++n > max) return true;
  return false;
};

const parseJsonObject = (raw: ArrayBuffer): Record<string, unknown> => {
  if (raw.byteLength > MAX_BODY_BYTES) throw bad("body too large");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(raw)); } catch { throw bad("invalid json"); }
  if (!isObject(parsed)) throw bad("body must be an object");
  return parsed;
};

/**
 * Parse and validate a raw request body into the exact shape a paste sends.
 * Throws HttpError(400) with a short `{error}`; never echoes the input back.
 */
export function validateBody(raw: ArrayBuffer): AskBody {
  const { state, questions, ...rest } = parseJsonObject(raw);
  if (Object.keys(rest).length) throw bad("unknown top-level key");
  if (!isObject(state)) throw bad("state must be an object");
  const { clipboard, ...stateRest } = state;
  if (Object.keys(stateRest).length) throw bad("unknown state key");
  if (typeof clipboard !== "string") throw bad("state.clipboard must be a string");
  if (longerThan(clipboard, MAX_CLIPBOARD_CHARS)) throw bad(`state.clipboard longer than ${MAX_CLIPBOARD_CHARS} characters`);
  if (!isObject(questions)) throw bad("questions must be an object");
  const keys = Object.keys(questions);
  if (keys.length === 0) throw bad("no questions");
  for (const key of keys) {
    const want = QUESTION_TYPES[key];
    if (!want) throw bad(`unknown question: ${key.slice(0, 32)}`);
    const q = questions[key];
    if (!isObject(q)) throw bad(`question ${key} must be an object`);
    if (q.type !== want) throw bad(`question ${key} must have type ${want}`);
    if (key === "emphasis") {
      const c = q.criteria;
      const count = Array.isArray(c) ? c.length : isObject(c) ? Object.keys(c).length : -1;
      if (count < 0) throw bad("emphasis.criteria must be an object");
      if (count > MAX_EMPHASIS_CRITERIA) throw bad(`emphasis.criteria has more than ${MAX_EMPHASIS_CRITERIA} entries`);
    }
  }
  return { state: { clipboard }, questions: questions as AskBody["questions"] };
}

/** Parse and validate a /v1/generate body. Throws HttpError(400); never echoes the prompt. */
export function validateGenerateBody(raw: ArrayBuffer): GenerateBody {
  const { prompt, system, maxTokens, temperature, ...rest } = parseJsonObject(raw);
  if (Object.keys(rest).length) throw bad("unknown top-level key");
  if (typeof prompt !== "string" || !prompt) throw bad("prompt must be a non-empty string");
  if (longerThan(prompt, MAX_PROMPT_CHARS)) throw bad(`prompt longer than ${MAX_PROMPT_CHARS} characters`);
  const out: GenerateBody = { prompt, maxTokens: DEFAULT_GEN_TOKENS };
  if (system !== undefined) {
    if (typeof system !== "string") throw bad("system must be a string");
    if (longerThan(system, MAX_SYSTEM_CHARS)) throw bad(`system longer than ${MAX_SYSTEM_CHARS} characters`);
    out.system = system;
  }
  if (maxTokens !== undefined) {
    if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_GEN_TOKENS) throw bad(`maxTokens must be an integer 1–${MAX_GEN_TOKENS}`);
    out.maxTokens = maxTokens;
  }
  if (temperature !== undefined) {
    if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 1) throw bad("temperature must be a number 0–1");
    out.temperature = temperature;
  }
  return out;
}

// ---------------------------------------------------------------- crypto helpers

const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

const unhex = (s: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^[0-9a-fA-F]+$/.test(s) || s.length % 2) return null;
  const out = new Uint8Array(new ArrayBuffer(s.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** 32 random bytes as base64url: the plaintext subscriber token. */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time string equality: compare fixed-length digests, not the strings. */
async function secretEquals(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da.charCodeAt(i) ^ db.charCodeAt(i);
  return diff === 0;
}

/** HMAC-SHA256 over the raw bytes, signature given as hex. */
export async function hmacHex(secret: string, data: ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, data));
}

async function hmacVerify(secret: string, data: ArrayBuffer, sigHex: string): Promise<boolean> {
  const sig = unhex(sigHex.trim());
  if (!sig || sig.length !== 32) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sig, data);
}

// ---------------------------------------------------------------- billing periods

/**
 * The billing period containing `now`: periods start on `resetDay` (UTC) of
 * each month and are named by the year-month they start in, which is what
 * the `use:` key carries. resetDay is clamped to 1–28 so every month has it.
 */
export function period(now: Date, resetDay?: number): { id: string; resetsAt: string } {
  const d = Math.min(28, Math.max(1, Math.floor(Number(resetDay) || 1)));
  let y = now.getUTCFullYear(), m = now.getUTCMonth();
  if (now.getUTCDate() < d) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  return { id: `${y}-${String(m + 1).padStart(2, "0")}`, resetsAt: new Date(Date.UTC(y, m + 1, d)).toISOString() };
}

// ---------------------------------------------------------------- KV records

const isHash = (s: string): boolean => /^[0-9a-f]{64}$/.test(s);

async function readRecord(kv: Kv, hash: string): Promise<SubscriberRecord | null> {
  const raw = await kv.get(`tok:${hash}`);
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as SubscriberRecord;
    return isObject(r) ? r : null;
  } catch { return null; }
}

const writeRecord = (kv: Kv, hash: string, rec: SubscriberRecord): Promise<void> => kv.put(`tok:${hash}`, JSON.stringify(rec));

async function readCount(kv: Kv, key: string): Promise<number> {
  const n = Number(await kv.get(key));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

async function usage(kv: Kv, hash: string, rec: SubscriberRecord, now: Date): Promise<{ used: number; key: string; periodId: string; resetsAt: string }> {
  const p = period(now, rec.resetDay);
  const key = `use:${hash}:${p.id}`;
  return { used: await readCount(kv, key), key, periodId: p.id, resetsAt: p.resetsAt };
}

/** Fields an admin or a webhook may set on a record; validated, never trusted. */
function recordPatch(body: Record<string, unknown>, requirePlan: boolean): Partial<SubscriberRecord> {
  const out: Partial<SubscriberRecord> = {};
  if (body.plan !== undefined || requirePlan) {
    if (typeof body.plan !== "string" || !body.plan || body.plan.length > 64) throw bad("plan must be a short string");
    out.plan = body.plan;
  }
  if (body.quota !== undefined || requirePlan) {
    if (typeof body.quota !== "number" || !Number.isInteger(body.quota) || body.quota < 0 || body.quota > 1e9) throw bad("quota must be a non-negative integer");
    out.quota = body.quota;
  }
  if (body.resetDay !== undefined) {
    if (typeof body.resetDay !== "number" || !Number.isInteger(body.resetDay) || body.resetDay < 1 || body.resetDay > 28) throw bad("resetDay must be 1–28");
    out.resetDay = body.resetDay;
  }
  if (body.label !== undefined) {
    if (typeof body.label !== "string" || body.label.length > 200) throw bad("label must be a short string");
    out.label = body.label;
  }
  return out;
}

const readJsonObject = async (req: Request): Promise<Record<string, unknown>> => parseJsonObject(await req.arrayBuffer());

const bearer = (req: Request): string | null => {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m?.[1] ?? null;
};

// ---------------------------------------------------------------- handlers

interface Ctx {
  env: Env;
  mode: Mode;
  now: Date;
  /** First 8 chars of the token hash, for the log line. */
  who: string;
}

function subs(env: Env): Kv {
  if (!env.SUBS) throw new HttpError(500, { error: "SUBS namespace is not bound" });
  return env.SUBS;
}

/** The subscriber behind a hosted request; null in dev, where `/v1/*` is open. */
interface Subscriber { kv: Kv; hash: string; rec: SubscriberRecord }

/** hosted: bearer token → record (401), then the per-minute rate limit (429). Counts every authenticated request. */
async function authenticate(req: Request, c: Ctx): Promise<Subscriber | null> {
  if (c.mode !== "hosted") return null;
  const kv = subs(c.env);
  const token = bearer(req);
  if (!token) throw new HttpError(401, { error: "missing bearer token" });
  const hash = await sha256Hex(token);
  c.who = hash.slice(0, 8);
  const rec = await readRecord(kv, hash);
  if (!rec || !rec.active) throw new HttpError(401, { error: "unknown or inactive token" });

  const minute = Math.floor(c.now.getTime() / 60_000);
  const rlKey = `rl:${hash}:${minute}`;
  const inMinute = await readCount(kv, rlKey);
  if (inMinute >= RATE_LIMIT_PER_MINUTE) {
    const retry = 60 - Math.floor((c.now.getTime() / 1000) % 60);
    throw new HttpError(429, { error: "rate_limited", limit: RATE_LIMIT_PER_MINUTE, retryAfter: retry }, { "retry-after": String(retry) });
  }
  await kv.put(rlKey, String(inMinute + 1), { expirationTtl: 120 });
  return { kv, hash, rec };
}

/**
 * One call against the period's quota (402 when spent). Ask and generate
 * each cost 1. `commit` records the call and runs only after upstream
 * succeeded, so a failed model call is free.
 */
async function charge(s: Subscriber | null, c: Ctx): Promise<{ headers: Record<string, string>; commit: (() => Promise<void>) | null }> {
  if (!s) return { headers: {}, commit: null };
  const u = await usage(s.kv, s.hash, s.rec, c.now);
  if (u.used >= s.rec.quota) throw new HttpError(402, { error: "quota", used: u.used, quota: s.rec.quota, resetsAt: u.resetsAt });
  return {
    headers: { "x-quota-used": String(u.used + 1), "x-quota-limit": String(s.rec.quota) },
    commit: () => s.kv.put(u.key, String(u.used + 1), { expirationTtl: USAGE_KEY_TTL_S }),
  };
}

/** Run a Workers AI model; a binding failure is 502 with its error text (never the input). */
async function runModel(env: Env, model: string, input: unknown): Promise<{ out: unknown; ms: number }> {
  const t0 = Date.now();
  try {
    return { out: await env.AI.run(model, input), ms: Date.now() - t0 };
  } catch (e) {
    throw new HttpError(502, { error: String(e) });
  }
}

/** POST /v1/ask — forward one validated paste request to Jev; `{ms, ...result}`. */
async function ask(req: Request, c: Ctx): Promise<Response> {
  const s = await authenticate(req, c);
  const body = validateBody(await req.arrayBuffer());
  const { headers, commit } = await charge(s, c);
  const { out, ms } = await runModel(c.env, JEV_MODEL, body);
  if (commit) await commit();
  const result = isObject(out) ? out : { result: out };
  return json(200, { ms, ...result }, headers);
}

/** Workers AI's `usage` (`prompt_tokens`/`completion_tokens`) as `{in, out}`; undefined when absent. */
function usageOf(u: unknown): { in?: number; out?: number } | undefined {
  if (!isObject(u)) return undefined;
  const pick = (...keys: string[]): number | undefined => {
    for (const k of keys) if (typeof u[k] === "number") return u[k] as number;
    return undefined;
  };
  const inTok = pick("prompt_tokens", "in"), outTok = pick("completion_tokens", "out");
  if (inTok === undefined && outTok === undefined) return undefined;
  return { ...(inTok !== undefined ? { in: inTok } : {}), ...(outTok !== undefined ? { out: outTok } : {}) };
}

/**
 * POST /v1/generate — text generation through the model in GEN_MODEL.
 * Body `{prompt, system?, maxTokens?, temperature?}` → `{text, model, ms, usage?}`.
 * Workers AI text models answer `{response: string, usage?: {...}}`.
 */
async function generate(req: Request, c: Ctx): Promise<Response> {
  const s = await authenticate(req, c);
  const g = validateGenerateBody(await req.arrayBuffer());
  const { headers, commit } = await charge(s, c);
  const model = c.env.GEN_MODEL || DEFAULT_GEN_MODEL;
  const messages: { role: "system" | "user"; content: string }[] = [];
  if (g.system !== undefined) messages.push({ role: "system", content: g.system });
  messages.push({ role: "user", content: g.prompt });
  const input: Record<string, unknown> = { messages, max_tokens: g.maxTokens };
  if (g.temperature !== undefined) input.temperature = g.temperature;
  const { out, ms } = await runModel(c.env, model, input);
  const text = isObject(out) ? out.response : undefined;
  if (typeof text !== "string") throw new HttpError(502, { error: "model returned no text" });
  if (commit) await commit();
  const usage = usageOf(isObject(out) ? out.usage : undefined);
  return json(200, { text, model, ms, ...(usage ? { usage } : {}) }, headers);
}

async function requireAdmin(req: Request, env: Env): Promise<void> {
  const given = bearer(req);
  if (!env.ADMIN_SECRET || !given || !(await secretEquals(given, env.ADMIN_SECRET))) throw new HttpError(401, { error: "admin secret required" });
}

/** POST /admin/tokens — mint (or, with `token`, upsert) a subscriber. */
async function adminCreate(req: Request, c: Ctx): Promise<Response> {
  await requireAdmin(req, c.env);
  const kv = subs(c.env);
  const body = await readJsonObject(req);
  let token: string;
  if (body.token !== undefined) {
    if (typeof body.token !== "string" || body.token.length < 16 || body.token.length > 256) throw bad("token must be 16–256 characters");
    token = body.token;
  } else {
    token = randomToken();
  }
  const hash = await sha256Hex(token);
  c.who = hash.slice(0, 8);
  const existing = await readRecord(kv, hash);
  const patch = recordPatch(body, existing === null);
  const stamp = c.now.toISOString();
  const rec: SubscriberRecord = { ...(existing ?? { plan: "", quota: 0, createdAt: stamp }), ...patch, active: true, updatedAt: stamp } as SubscriberRecord;
  await writeRecord(kv, hash, rec);
  // The only response that ever carries the plaintext token.
  return json(existing ? 200 : 201, { token, hash, plan: rec.plan, quota: rec.quota });
}

/** GET /admin/tokens/<hash> — the record plus this period's usage. */
async function adminGet(req: Request, c: Ctx, hash: string): Promise<Response> {
  await requireAdmin(req, c.env);
  const kv = subs(c.env);
  c.who = hash.slice(0, 8);
  const rec = await readRecord(kv, hash);
  if (!rec) throw new HttpError(404, { error: "no such token" });
  const u = await usage(kv, hash, rec, c.now);
  return json(200, { hash, ...rec, used: u.used, period: u.periodId, resetsAt: u.resetsAt });
}

/** DELETE /admin/tokens/<hash> — deactivate; the record stays for audit. */
async function adminDelete(req: Request, c: Ctx, hash: string): Promise<Response> {
  await requireAdmin(req, c.env);
  const kv = subs(c.env);
  c.who = hash.slice(0, 8);
  const rec = await readRecord(kv, hash);
  if (!rec) throw new HttpError(404, { error: "no such token" });
  await writeRecord(kv, hash, { ...rec, active: false, updatedAt: c.now.toISOString() });
  return json(200, { hash, active: false });
}

/**
 * POST /webhooks/billing — provider-agnostic subscription events.
 *
 * Headers:  X-Signature: <hex HMAC-SHA256 over the raw body, key = BILLING_WEBHOOK_SECRET>
 * Body:     {
 *             event:      "subscription.activated" | "subscription.cancelled",
 *             token_hash: <sha256 hex of the subscriber's token>,
 *             plan:       string,        // activated: required
 *             quota:      number,        // activated: required, calls per period
 *             resetDay?:  1..28,         // billing anniversary (UTC); default 1
 *             label?:     string         // e.g. the provider's customer id
 *           }
 *
 * A Paddle or LemonSqueezy adapter (later) verifies the provider's own
 * signature, maps its event names and custom data onto this payload, and
 * either calls this route with our signature or writes the same KV records
 * directly. The worker only ever reads subscription state; it never bills.
 */
async function billingWebhook(req: Request, c: Ctx): Promise<Response> {
  const kv = subs(c.env);
  const secret = c.env.BILLING_WEBHOOK_SECRET;
  const raw = await req.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) throw bad("body too large");
  const sig = req.headers.get("x-signature");
  if (!secret || !sig || !(await hmacVerify(secret, raw, sig))) throw new HttpError(401, { error: "bad signature" });
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(raw)); } catch { throw bad("invalid json"); }
  if (!isObject(parsed)) throw bad("body must be an object");
  const hash = parsed.token_hash;
  if (typeof hash !== "string" || !isHash(hash)) throw bad("token_hash must be a sha256 hex string");
  c.who = hash.slice(0, 8);
  const existing = await readRecord(kv, hash);
  const stamp = c.now.toISOString();
  switch (parsed.event) {
    case "subscription.activated": {
      const patch = recordPatch(parsed, existing === null);
      const rec = { ...(existing ?? { plan: "", quota: 0, createdAt: stamp }), ...patch, active: true, updatedAt: stamp } as SubscriberRecord;
      await writeRecord(kv, hash, rec);
      return json(200, { ok: true, hash, active: true });
    }
    case "subscription.cancelled": {
      if (!existing) throw new HttpError(404, { error: "no such token" });
      await writeRecord(kv, hash, { ...existing, active: false, updatedAt: stamp });
      return json(200, { ok: true, hash, active: false });
    }
    default:
      throw bad("unknown event");
  }
}

// ---------------------------------------------------------------- router

function route(req: Request, c: Ctx): Promise<Response> | Response {
  const path = new URL(req.url).pathname;
  const method = req.method.toUpperCase();
  const only = (m: string, next: () => Promise<Response> | Response): Promise<Response> | Response =>
    method === m ? next() : new HttpError(405, { error: `use ${m}` }, { allow: m }).toResponse();

  if (path === "/healthz") return only("GET", () => json(200, { mode: c.mode }));
  if (path === "/v1/ask" || (c.mode === "dev" && path === "/")) return only("POST", () => ask(req, c));
  if (path === "/v1/generate") return only("POST", () => generate(req, c));

  if (c.mode === "hosted") {
    if (path === "/admin/tokens") return only("POST", () => adminCreate(req, c));
    const m = /^\/admin\/tokens\/([0-9a-f]{64})$/.exec(path);
    if (m) {
      const hash = m[1]!;
      if (method === "GET") return adminGet(req, c, hash);
      if (method === "DELETE") return adminDelete(req, c, hash);
      return new HttpError(405, { error: "use GET or DELETE" }, { allow: "GET, DELETE" }).toResponse();
    }
    if (path === "/webhooks/billing") return only("POST", () => billingWebhook(req, c));
  }
  return json(404, { error: "not found" });
}

/**
 * The fetch handler, with an injectable clock so tests can pin the minute
 * and the billing period. Production uses `Date.now`.
 */
export function createHandler(clock: () => number = Date.now): (req: Request, env: Env) => Promise<Response> {
  return async (req, env) => {
    const mode: Mode = env.MODE === "hosted" ? "hosted" : "dev";
    const c: Ctx = { env, mode, now: new Date(clock()), who: "-" };
    const t0 = Date.now();
    let res: Response;
    try {
      res = await route(req, c);
    } catch (e) {
      res = e instanceof HttpError ? e.toResponse() : json(500, { error: "internal error" });
      if (!(e instanceof HttpError)) console.error(`unhandled: ${(e as Error)?.name ?? "error"}`);
    }
    // The one log line per request. Never the body, never the token.
    console.log(`${req.method} ${new URL(req.url).pathname} ${res.status} ${Date.now() - t0}ms ${c.who}`);
    return res;
  };
}

export default { fetch: createHandler() };
