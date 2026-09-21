import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHandler, hmacHex, period, sha256Hex, validateBody, validateGenerateBody, type Env, type Kv } from "../src/index.ts";

// ---------------------------------------------------------------- stubs

const ANSWERS = {
  kind: { choice: "plain", probabilities: { plain: 0.9 } },
  layout: { choice: "left" }, palette: { choice: "ink" },
  scale: { score: 1 }, tone: { score: 0 }, animate: { noul: 0 }, emphasis: { choice: "none" },
};

/** In-memory KV: get/put/delete; expirationTtl is accepted and ignored. */
function memKv(): Kv & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(k) { return store.get(k) ?? null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

const GENERATED = { response: "generated text", usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } };

/** The AI binding: records calls, answers per model with a canned envelope (or throws). */
function stubAi(fail = false, gen: unknown = GENERATED) {
  const calls: { model: string; input: unknown }[] = [];
  return {
    calls,
    async run(model: string, input: unknown) {
      calls.push({ model, input });
      if (fail) throw new Error("model down");
      return model === "typesafe/jev" ? { answers: ANSWERS } : gen;
    },
  };
}

const ADMIN = "admin-secret-for-tests";
const HOOK = "hook-secret-for-tests";
const T0 = Date.UTC(2026, 8, 22, 12, 30, 15); // 2026-09-22T12:30:15Z

function world(mode: "dev" | "hosted", o: { fail?: boolean; clock?: () => number; secrets?: boolean; gen?: unknown } = {}) {
  const ai = stubAi(o.fail, o.gen);
  const kv = memKv();
  const env: Env = {
    MODE: mode, AI: ai, SUBS: kv,
    ...(o.secrets === false ? {} : { ADMIN_SECRET: ADMIN, BILLING_WEBHOOK_SECRET: HOOK }),
  };
  const handle = createHandler(o.clock ?? (() => T0));
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handle(new Request(`http://worker${path}`, {
      method, headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }), env);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const mint = async (fields: Record<string, unknown> = {}) => {
    const res = await call("POST", "/admin/tokens", { plan: "solo", quota: 1000, ...fields }, bearer(ADMIN));
    expect(res.status).toBe(201);
    return (await res.json()) as { token: string; hash: string; plan: string; quota: number };
  };
  return { ai, kv, env, handle, call, bearer, mint };
}

/** A legitimate paste request, as core's buildRequest shapes it. */
function askBody(clipboard = "hello", o: { emphasisWords?: number } = {}) {
  const words = o.emphasisWords ?? 3;
  const wordCriteria: Record<string, string> = Object.fromEntries(Array.from({ length: words }, (_, i) => [`w${i}`, `word${i}`]));
  wordCriteria["none"] = "no single word deserves emphasis";
  return {
    state: { clipboard },
    questions: {
      kind: { type: "choice", instructions: "What kind?", criteria: { plain: "plain text", quote: "a quotation", event: "an appointment" } },
      layout: { type: "choice", instructions: "Which layout?", criteria: { left: "left", center: "center" } },
      palette: { type: "choice", instructions: "Which palette?", criteria: { ink: "ink", dawn: "dawn" } },
      scale: { type: "score", instructions: "How large?", criteria: ["small", "medium", "large", "huge"] },
      tone: { type: "score", instructions: "How emphatic?", criteria: ["none", "gentle", "emphatic", "dramatic"] },
      animate: { type: "noul", instructions: "Does it read in sequence?", criteria: { true: "yes", false: "no" } },
      emphasis: { type: "choice", instructions: "Which word?", criteria: wordCriteria },
    },
  };
}

// Silence the worker's one-line log during tests, but keep every line for the privacy check.
let logged: string[] = [];
const realLog = console.log;
beforeEach(() => { logged = []; console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); }; });
afterEach(() => { console.log = realLog; });

// ---------------------------------------------------------------- dev mode

describe("dev mode", () => {
  test("POST / forwards the validated body to typesafe/jev and returns {ms, ...result}", async () => {
    const w = world("dev");
    const body = askBody("a paste");
    const res = await w.call("POST", "/", body);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { ms: number; answers: unknown };
    expect(typeof out.ms).toBe("number");
    expect(out.answers).toEqual(ANSWERS);
    expect(w.ai.calls).toEqual([{ model: "typesafe/jev", input: body }]);
  });
  test("POST /v1/ask works too, and no token is needed", async () => {
    const w = world("dev");
    expect((await w.call("POST", "/v1/ask", askBody())).status).toBe(200);
  });
  test("an AI failure is a 502 with the error text", async () => {
    const w = world("dev", { fail: true });
    const res = await w.call("POST", "/", askBody());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Error: model down" });
  });
  test("GET /healthz reports the mode; wrong methods are 405; hosted routes are 404", async () => {
    const w = world("dev");
    const h = await w.call("GET", "/healthz");
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual({ mode: "dev" });
    expect((await w.call("GET", "/")).status).toBe(405);
    expect((await w.call("POST", "/healthz")).status).toBe(405);
    expect((await w.call("POST", "/admin/tokens", {}, w.bearer(ADMIN))).status).toBe(404);
    expect((await w.call("POST", "/webhooks/billing", {})).status).toBe(404);
    expect((await w.call("GET", "/nowhere")).status).toBe(404);
  });
  test("MODE unset means dev", async () => {
    const w = world("dev");
    delete w.env.MODE;
    expect(await (await w.call("GET", "/healthz")).json()).toEqual({ mode: "dev" });
  });
});

// ---------------------------------------------------------------- validation (both modes)

describe("request validation", () => {
  const cases: [string, unknown, string][] = [
    ["clipboard of 2001 code points", askBody("😀".repeat(2001)), "2000"],
    ["clipboard that is not a string", { ...askBody(), state: { clipboard: 5 } }, "string"],
    ["unknown question key", { ...askBody(), questions: { ...askBody().questions, mood: { type: "choice", criteria: {} } } }, "unknown question: mood"],
    ["wrong question type", { ...askBody(), questions: { ...askBody().questions, kind: { type: "score", criteria: [] } } }, "type choice"],
    ["emphasis with 202 criteria", askBody("x", { emphasisWords: 201 }), "201"],
    ["extra top-level key", { ...askBody(), model: "anything" }, "top-level"],
    ["extra state key", { ...askBody(), state: { clipboard: "x", extra: 1 } }, "state key"],
    ["no questions", { ...askBody(), questions: {} }, "no questions"],
    ["not an object", "[1,2]", "object"],
    ["invalid json", "{nope", "json"],
  ];
  for (const [name, body, snippet] of cases) {
    test(`400 on ${name} (dev)`, async () => {
      const w = world("dev");
      const res = await w.call("POST", "/", body);
      expect(res.status).toBe(400);
      const out = (await res.json()) as { error: string };
      expect(out.error).toContain(snippet);
      expect(w.ai.calls.length).toBe(0);
    });
  }
  test("2000 astral code points is exactly the limit (UTF-16 length is irrelevant)", () => {
    const b = askBody("😀".repeat(2000));
    expect(validateBody(new TextEncoder().encode(JSON.stringify(b)).buffer as ArrayBuffer).state.clipboard.length).toBe(4000);
  });
  test("201 emphasis criteria (200 words + none) passes", async () => {
    const w = world("dev");
    expect((await w.call("POST", "/", askBody("x", { emphasisWords: 200 }))).status).toBe(200);
  });
  test("a body over 64 KB is refused before parsing", async () => {
    const w = world("dev");
    const res = await w.call("POST", "/", "x".repeat(64 * 1024 + 1));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("large");
  });
  test("validation applies in hosted mode too, after auth", async () => {
    const w = world("hosted");
    const { token } = await w.mint();
    const res = await w.call("POST", "/v1/ask", askBody("😀".repeat(2001)), w.bearer(token));
    expect(res.status).toBe(400);
    expect(w.ai.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------- hosted: auth

describe("hosted auth", () => {
  test("401 without a token", async () => {
    const w = world("hosted");
    const res = await w.call("POST", "/v1/ask", askBody());
    expect(res.status).toBe(401);
    expect(w.ai.calls.length).toBe(0);
  });
  test("401 with an unknown token", async () => {
    const w = world("hosted");
    const res = await w.call("POST", "/v1/ask", askBody(), w.bearer("not-a-real-token-at-all"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unknown or inactive token" });
  });
  test("401 with a deactivated token", async () => {
    const w = world("hosted");
    const { token, hash } = await w.mint();
    expect((await w.call("POST", "/v1/ask", askBody(), w.bearer(token))).status).toBe(200);
    const del = await w.call("DELETE", `/admin/tokens/${hash}`, undefined, w.bearer(ADMIN));
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ hash, active: false });
    expect((await w.call("POST", "/v1/ask", askBody(), w.bearer(token))).status).toBe(401);
  });
  test("POST / is not an ask route in hosted mode", async () => {
    const w = world("hosted");
    expect((await w.call("POST", "/", askBody())).status).toBe(404);
  });
  test("500 when SUBS is not bound", async () => {
    const w = world("hosted");
    delete w.env.SUBS;
    expect((await w.call("POST", "/v1/ask", askBody(), w.bearer("x"))).status).toBe(500);
  });
});

// ---------------------------------------------------------------- hosted: admin + ask

describe("hosted admin and ask", () => {
  test("admin mints a token; asking with it succeeds and counts", async () => {
    const w = world("hosted");
    const minted = await w.mint({ label: "alice" });
    expect(minted.plan).toBe("solo");
    expect(minted.quota).toBe(1000);
    expect(minted.token.length).toBeGreaterThanOrEqual(43);
    expect(minted.hash).toBe(await sha256Hex(minted.token));
    // Stored under the hash, never in plaintext.
    expect([...w.kv.store.keys()]).toEqual([`tok:${minted.hash}`]);
    expect([...w.kv.store.values()].join("")).not.toContain(minted.token);

    const res = await w.call("POST", "/v1/ask", askBody("clip"), w.bearer(minted.token));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { answers: unknown }).answers).toEqual(ANSWERS);
    expect(res.headers.get("x-quota-used")).toBe("1");
    expect(res.headers.get("x-quota-limit")).toBe("1000");
    expect(w.kv.store.get(`use:${minted.hash}:2026-09`)).toBe("1");

    const got = await w.call("GET", `/admin/tokens/${minted.hash}`, undefined, w.bearer(ADMIN));
    expect(got.status).toBe(200);
    const rec = (await got.json()) as Record<string, unknown>;
    expect(rec).toMatchObject({ hash: minted.hash, plan: "solo", quota: 1000, active: true, label: "alice", used: 1, period: "2026-09", resetsAt: "2026-10-01T00:00:00.000Z" });
    expect(rec).not.toHaveProperty("token");
  });
  test("a given token is upserted under its hash, keeping fields not resent", async () => {
    const w = world("hosted");
    const token = "my-own-preexisting-token-value";
    const first = await w.call("POST", "/admin/tokens", { token, plan: "team", quota: 5, label: "bob" }, w.bearer(ADMIN));
    expect(first.status).toBe(201);
    const again = await w.call("POST", "/admin/tokens", { token, quota: 50 }, w.bearer(ADMIN));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ token, hash: await sha256Hex(token), plan: "team", quota: 50 });
    const rec = JSON.parse(w.kv.store.get(`tok:${await sha256Hex(token)}`)!);
    expect(rec).toMatchObject({ plan: "team", quota: 50, label: "bob", active: true });
  });
  test("admin routes need the admin secret", async () => {
    const w = world("hosted");
    expect((await w.call("POST", "/admin/tokens", { plan: "x", quota: 1 })).status).toBe(401);
    expect((await w.call("POST", "/admin/tokens", { plan: "x", quota: 1 }, w.bearer("wrong"))).status).toBe(401);
    expect((await w.call("GET", `/admin/tokens/${"a".repeat(64)}`, undefined, w.bearer("wrong"))).status).toBe(401);
    expect((await w.call("GET", `/admin/tokens/${"a".repeat(64)}`, undefined, w.bearer(ADMIN))).status).toBe(404);
    expect((await w.call("GET", "/admin/tokens/short", undefined, w.bearer(ADMIN))).status).toBe(404);
    expect((await w.call("PUT", `/admin/tokens/${"a".repeat(64)}`, undefined, w.bearer(ADMIN))).status).toBe(405);
  });
  test("admin routes are closed when ADMIN_SECRET is unset", async () => {
    const w = world("hosted", { secrets: false });
    expect((await w.call("POST", "/admin/tokens", { plan: "x", quota: 1 }, w.bearer(""))).status).toBe(401);
  });
  test("admin body validation", async () => {
    const w = world("hosted");
    for (const body of [{ quota: 1 }, { plan: "x" }, { plan: "x", quota: -1 }, { plan: "x", quota: 1.5 }, { plan: "x", quota: 1, resetDay: 31 }, { plan: "x", quota: 1, token: "short" }]) {
      expect((await w.call("POST", "/admin/tokens", body, w.bearer(ADMIN))).status).toBe(400);
    }
  });
  test("an AI failure does not consume quota", async () => {
    const w = world("hosted", { fail: true });
    const { token, hash } = await w.mint();
    expect((await w.call("POST", "/v1/ask", askBody(), w.bearer(token))).status).toBe(502);
    expect(w.kv.store.has(`use:${hash}:2026-09`)).toBe(false);
  });
});

// ---------------------------------------------------------------- hosted: quota + rate limit

describe("hosted limits", () => {
  test("402 once the period's quota is used up", async () => {
    const w = world("hosted");
    const { token, hash } = await w.mint({ quota: 2 });
    expect((await w.call("POST", "/v1/ask", askBody(), w.bearer(token))).status).toBe(200);
    expect((await w.call("POST", "/v1/ask", askBody(), w.bearer(token))).status).toBe(200);
    const res = await w.call("POST", "/v1/ask", askBody(), w.bearer(token));
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "quota", used: 2, quota: 2, resetsAt: "2026-10-01T00:00:00.000Z" });
    expect(w.ai.calls.length).toBe(2);
    expect(w.kv.store.get(`use:${hash}:2026-09`)).toBe("2");
  });
  test("quota 0 refuses the first call", async () => {
    const w = world("hosted");
    const { token } = await w.mint({ quota: 0 });
    expect((await w.call("POST", "/v1/ask", askBody(), w.bearer(token))).status).toBe(402);
  });
  test("a new period starts the count over", async () => {
    let now = T0;
    const w = world("hosted", { clock: () => now });
    const { token } = await w.mint({ quota: 1 });
    expect((await w.call("POST", "/v1/ask", askBody(), w.bearer(token))).status).toBe(200);
    expect((await w.call("POST", "/v1/ask", askBody(), w.bearer(token))).status).toBe(402);
    now = Date.UTC(2026, 9, 1, 0, 0, 1);
    expect((await w.call("POST", "/v1/ask", askBody(), w.bearer(token))).status).toBe(200);
  });
  test("429 after 60 calls in one minute, cleared the next minute", async () => {
    let now = T0;
    const w = world("hosted", { clock: () => now });
    const { token, hash } = await w.mint({ quota: 1000 });
    for (let i = 0; i < 60; i++) expect((await w.call("POST", "/v1/ask", askBody(), w.bearer(token))).status).toBe(200);
    const res = await w.call("POST", "/v1/ask", askBody(), w.bearer(token));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("45");
    expect(await res.json()).toEqual({ error: "rate_limited", limit: 60, retryAfter: 45 });
    expect(w.ai.calls.length).toBe(60);
    expect(w.kv.store.get(`use:${hash}:2026-09`)).toBe("60");
    now += 60_000;
    expect((await w.call("POST", "/v1/ask", askBody(), w.bearer(token))).status).toBe(200);
  });
  test("the rate limit counts refused requests too", async () => {
    const w = world("hosted");
    const { token, hash } = await w.mint({ quota: 0 });
    for (let i = 0; i < 60; i++) expect((await w.call("POST", "/v1/ask", askBody(), w.bearer(token))).status).toBe(402);
    expect((await w.call("POST", "/v1/ask", askBody(), w.bearer(token))).status).toBe(429);
    expect(w.kv.store.get(`rl:${hash}:${Math.floor(T0 / 60_000)}`)).toBe("60");
  });
});

// ---------------------------------------------------------------- hosted: billing webhook

describe("billing webhook", () => {
  const sign = async (body: string, secret = HOOK) => ({ "x-signature": await hmacHex(secret, new TextEncoder().encode(body).buffer as ArrayBuffer) });
  const activated = (token_hash: string) => JSON.stringify({ event: "subscription.activated", token_hash, plan: "pro", quota: 300, label: "cust_1" });

  test("401 without or with a bad signature", async () => {
    const w = world("hosted");
    const hash = await sha256Hex("webhook-token");
    const body = activated(hash);
    expect((await w.call("POST", "/webhooks/billing", body)).status).toBe(401);
    expect((await w.call("POST", "/webhooks/billing", body, await sign(body, "wrong secret"))).status).toBe(401);
    expect((await w.call("POST", "/webhooks/billing", body, { "x-signature": "zz" })).status).toBe(401);
    // A valid signature over a different body does not carry over.
    expect((await w.call("POST", "/webhooks/billing", body + " ", await sign(body))).status).toBe(401);
    expect(w.kv.store.size).toBe(0);
  });
  test("401 when no BILLING_WEBHOOK_SECRET is configured", async () => {
    const w = world("hosted", { secrets: false });
    const body = activated(await sha256Hex("t"));
    expect((await w.call("POST", "/webhooks/billing", body, await sign(body))).status).toBe(401);
  });
  test("a good signature activates a token; cancelled deactivates it", async () => {
    const w = world("hosted");
    const token = "token-the-app-already-holds";
    const hash = await sha256Hex(token);
    expect((await w.call("POST", "/v1/ask", askBody(), w.bearer(token))).status).toBe(401);

    const on = activated(hash);
    const res = await w.call("POST", "/webhooks/billing", on, await sign(on));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, hash, active: true });
    expect(JSON.parse(w.kv.store.get(`tok:${hash}`)!)).toMatchObject({ plan: "pro", quota: 300, label: "cust_1", active: true });
    const ok = await w.call("POST", "/v1/ask", askBody(), w.bearer(token));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-quota-limit")).toBe("300");

    const off = JSON.stringify({ event: "subscription.cancelled", token_hash: hash });
    expect((await w.call("POST", "/webhooks/billing", off, await sign(off))).status).toBe(200);
    expect((await w.call("POST", "/v1/ask", askBody(), w.bearer(token))).status).toBe(401);
    expect(JSON.parse(w.kv.store.get(`tok:${hash}`)!)).toMatchObject({ plan: "pro", active: false });
  });
  test("bad payloads are 400, cancelling an unknown token is 404", async () => {
    const w = world("hosted");
    for (const body of [
      JSON.stringify({ event: "subscription.activated", token_hash: "nope", plan: "p", quota: 1 }),
      JSON.stringify({ event: "subscription.activated", token_hash: "a".repeat(64) }),
      JSON.stringify({ event: "subscription.renamed", token_hash: "a".repeat(64) }),
      "not json",
    ]) {
      expect((await w.call("POST", "/webhooks/billing", body, await sign(body))).status).toBe(400);
    }
    const off = JSON.stringify({ event: "subscription.cancelled", token_hash: "b".repeat(64) });
    expect((await w.call("POST", "/webhooks/billing", off, await sign(off))).status).toBe(404);
  });
});

// ---------------------------------------------------------------- generate

describe("generate", () => {
  const GEN = "@cf/meta/llama-3.1-8b-instruct";

  test("dev: POST /v1/generate runs GEN_MODEL with the prompt and returns {text, model, ms, usage}", async () => {
    const w = world("dev");
    const res = await w.call("POST", "/v1/generate", { prompt: "say hi" });
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out).toMatchObject({ text: "generated text", model: GEN, usage: { in: 12, out: 5 } });
    expect(typeof out.ms).toBe("number");
    expect(w.ai.calls).toEqual([{ model: GEN, input: { messages: [{ role: "user", content: "say hi" }], max_tokens: 512 } }]);
  });
  test("system, maxTokens and temperature are passed through; GEN_MODEL var picks the model", async () => {
    const w = world("dev");
    w.env.GEN_MODEL = "@cf/some/other-model";
    const res = await w.call("POST", "/v1/generate", { prompt: "p", system: "be terse", maxTokens: 64, temperature: 0.2 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { model: string }).model).toBe("@cf/some/other-model");
    expect(w.ai.calls[0]).toEqual({ model: "@cf/some/other-model", input: { messages: [{ role: "system", content: "be terse" }, { role: "user", content: "p" }], max_tokens: 64, temperature: 0.2 } });
  });
  test("usage is omitted when upstream gives none; 502 when there is no response text", async () => {
    const bare = world("dev", { gen: { response: "just text" } });
    const out = (await (await bare.call("POST", "/v1/generate", { prompt: "p" })).json()) as Record<string, unknown>;
    expect(out).toEqual({ text: "just text", model: GEN, ms: expect.any(Number) });
    const broken = world("dev", { gen: { result: "wrong shape" } });
    const res = await broken.call("POST", "/v1/generate", { prompt: "p" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "model returned no text" });
  });
  test("a binding failure is 502 with the error text", async () => {
    const w = world("dev", { fail: true });
    const res = await w.call("POST", "/v1/generate", { prompt: "p" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Error: model down" });
  });

  const bad: [string, unknown, string][] = [
    ["prompt of 8001 code points", { prompt: "😀".repeat(8001) }, "8000"],
    ["missing prompt", { system: "x" }, "prompt"],
    ["empty prompt", { prompt: "" }, "prompt"],
    ["prompt not a string", { prompt: 5 }, "prompt"],
    ["system of 2001 code points", { prompt: "p", system: "😀".repeat(2001) }, "2000"],
    ["system not a string", { prompt: "p", system: [] }, "system"],
    ["maxTokens 0", { prompt: "p", maxTokens: 0 }, "maxTokens"],
    ["maxTokens 2049", { prompt: "p", maxTokens: 2049 }, "maxTokens"],
    ["maxTokens 1.5", { prompt: "p", maxTokens: 1.5 }, "maxTokens"],
    ["maxTokens as a string", { prompt: "p", maxTokens: "5" }, "maxTokens"],
    ["temperature 1.5", { prompt: "p", temperature: 1.5 }, "temperature"],
    ["temperature -0.1", { prompt: "p", temperature: -0.1 }, "temperature"],
    ["unknown key", { prompt: "p", model: "@cf/anything" }, "top-level"],
    ["not json", "{", "json"],
  ];
  for (const [name, body, snippet] of bad) {
    test(`400 on ${name}`, async () => {
      const w = world("dev");
      const res = await w.call("POST", "/v1/generate", body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(snippet);
      expect(w.ai.calls.length).toBe(0);
    });
  }
  test("8000 astral code points and maxTokens 2048 are exactly the limits", () => {
    const enc = (b: unknown) => new TextEncoder().encode(JSON.stringify(b)).buffer as ArrayBuffer;
    const g = validateGenerateBody(enc({ prompt: "😀".repeat(8000), system: "😀".repeat(2000), maxTokens: 2048, temperature: 1 }));
    expect(g.prompt.length).toBe(16000);
    expect(g).toMatchObject({ maxTokens: 2048, temperature: 1 });
    expect(validateGenerateBody(enc({ prompt: "p" }))).toEqual({ prompt: "p", maxTokens: 512 });
  });

  test("hosted: 401 without a token, 200 with one, and it shares the ask quota", async () => {
    const w = world("hosted");
    expect((await w.call("POST", "/v1/generate", { prompt: "p" })).status).toBe(401);
    expect((await w.call("POST", "/v1/generate", { prompt: "p" }, w.bearer("nope"))).status).toBe(401);
    const { token, hash } = await w.mint({ quota: 2 });
    const ok = await w.call("POST", "/v1/generate", { prompt: "p" }, w.bearer(token));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-quota-used")).toBe("1");
    expect((await w.call("POST", "/v1/ask", askBody(), w.bearer(token))).status).toBe(200);
    expect(w.kv.store.get(`use:${hash}:2026-09`)).toBe("2");
    const spent = await w.call("POST", "/v1/generate", { prompt: "p" }, w.bearer(token));
    expect(spent.status).toBe(402);
    expect(await spent.json()).toEqual({ error: "quota", used: 2, quota: 2, resetsAt: "2026-10-01T00:00:00.000Z" });
    expect((await w.call("POST", "/v1/ask", askBody(), w.bearer(token))).status).toBe(402);
  });
  test("hosted: the rate limit spans ask and generate", async () => {
    const w = world("hosted");
    const { token } = await w.mint({ quota: 1000 });
    for (let i = 0; i < 30; i++) expect((await w.call("POST", "/v1/ask", askBody(), w.bearer(token))).status).toBe(200);
    for (let i = 0; i < 30; i++) expect((await w.call("POST", "/v1/generate", { prompt: "p" }, w.bearer(token))).status).toBe(200);
    expect((await w.call("POST", "/v1/generate", { prompt: "p" }, w.bearer(token))).status).toBe(429);
    expect((await w.call("POST", "/v1/ask", askBody(), w.bearer(token))).status).toBe(429);
  });
  test("hosted: a failed or textless model call is not billed", async () => {
    const w = world("hosted", { gen: {} });
    const { token, hash } = await w.mint();
    expect((await w.call("POST", "/v1/generate", { prompt: "p" }, w.bearer(token))).status).toBe(502);
    expect(w.kv.store.has(`use:${hash}:2026-09`)).toBe(false);
  });
  test("the log line never contains the prompt or the system text", async () => {
    const w = world("hosted");
    const { token, hash } = await w.mint();
    logged = [];
    await w.call("POST", "/v1/generate", { prompt: "PROMPT-SECRET-71c2", system: "SYSTEM-SECRET-0b9e" }, w.bearer(token));
    expect(logged).toEqual([expect.stringMatching(new RegExp(`^POST /v1/generate 200 \\d+ms ${hash.slice(0, 8)}$`))]);
    expect(logged[0]).not.toContain("SECRET");
    expect(logged[0]).not.toContain(token);
  });
  test("GET /v1/generate is 405", async () => {
    expect((await world("dev").call("GET", "/v1/generate")).status).toBe(405);
  });
});

// ---------------------------------------------------------------- privacy + periods

describe("privacy", () => {
  test("one log line per request; never the clipboard, never the token", async () => {
    const w = world("hosted");
    const { token, hash } = await w.mint();
    const secret = "SECRET-CLIPBOARD-TEXT-9f3a";
    logged = [];
    await w.call("POST", "/v1/ask", askBody(secret), w.bearer(token));
    expect(logged.length).toBe(1);
    expect(logged[0]).toMatch(new RegExp(`^POST /v1/ask 200 \\d+ms ${hash.slice(0, 8)}$`));
    expect(logged[0]).not.toContain(secret);
    expect(logged[0]).not.toContain(token);
    logged = [];
    await w.call("POST", "/v1/ask", askBody(secret));
    expect(logged).toEqual([expect.stringMatching(/^POST \/v1\/ask 401 \d+ms -$/)]);
  });
});

describe("period", () => {
  const at = (iso: string) => new Date(iso);
  test("default: calendar months, UTC", () => {
    expect(period(at("2026-09-22T12:00:00Z"))).toEqual({ id: "2026-09", resetsAt: "2026-10-01T00:00:00.000Z" });
    expect(period(at("2026-12-31T23:59:59Z"))).toEqual({ id: "2026-12", resetsAt: "2027-01-01T00:00:00.000Z" });
  });
  test("resetDay: the period starts on that day and is named by the month it starts in", () => {
    expect(period(at("2026-09-22T00:00:00Z"), 15)).toEqual({ id: "2026-09", resetsAt: "2026-10-15T00:00:00.000Z" });
    expect(period(at("2026-09-10T00:00:00Z"), 15)).toEqual({ id: "2026-08", resetsAt: "2026-09-15T00:00:00.000Z" });
    expect(period(at("2027-01-05T00:00:00Z"), 15)).toEqual({ id: "2026-12", resetsAt: "2027-01-15T00:00:00.000Z" });
    expect(period(at("2026-09-15T00:00:00Z"), 15).id).toBe("2026-09");
  });
  test("resetDay is clamped to 1–28", () => {
    expect(period(at("2026-02-27T00:00:00Z"), 31)).toEqual({ id: "2026-01", resetsAt: "2026-02-28T00:00:00.000Z" });
    expect(period(at("2026-02-27T00:00:00Z"), 0).id).toBe("2026-02");
  });
});
