import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { anthropicGenerator, ANTHROPIC_VERSION, DEFAULT_ANTHROPIC_MODEL } from "../src/provider/generator/anthropic.ts";
import { hostedGenerator } from "../src/provider/generator/hosted.ts";
import { openaiCompatibleGenerator } from "../src/provider/generator/openai.ts";
import { DEFAULT_MAX_TOKENS, type Generator } from "../src/provider/generator/types.ts";
import { createGenerator, DEFAULT_OLLAMA_URL, generatorFromEnv, ProviderError } from "../src/provider/index.ts";

type Mode = "openai" | "parts" | "no-choices" | "anthropic" | "hosted" | "html" | number;
let mode: Mode = "openai";
let seen: { path: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      seen = { path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body: (await req.json()) as Record<string, unknown> };
      if (typeof mode === "number") return Response.json({ error: { message: `stub says ${mode}`, type: "stub_error" } }, { status: mode });
      switch (mode) {
        case "openai": return Response.json({ id: "chatcmpl-1", model: "qwen3:8b", choices: [{ index: 0, message: { role: "assistant", content: "Bonjour" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
        case "parts": return Response.json({ choices: [{ message: { content: [{ type: "text", text: "Bon" }, { type: "text", text: "jour" }] } }] });
        case "no-choices": return Response.json({ id: "x" });
        case "anthropic": return Response.json({ id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Hola" }, { type: "text", text: " mundo" }], stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 4 } });
        case "hosted": return Response.json({ text: "Hallo", model: "hosted/qwen", usage: { in: 5, out: 2 } });
        case "html": return new Response("<html>bad gateway</html>", { status: 502 });
      }
    },
  });
});
afterAll(() => server.stop(true));

const base = () => `http://127.0.0.1:${server.port}`;

/** The ProviderError code a promise rejects with, or "resolved". */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) {
    if (e instanceof ProviderError) return e.code;
    throw e;
  }
  return "resolved";
}

describe("openai-compatible generator", () => {
  const gen = () => openaiCompatibleGenerator({ baseUrl: `${base()}/v1`, model: "qwen3:8b", apiKey: "k-1" });

  test("posts the chat-completions shape to <base>/chat/completions and returns text, model and usage", async () => {
    mode = "openai";
    const r = await gen().generate({ system: "Translate to French.", prompt: "Hello", maxTokens: 64, temperature: 0.2 });
    expect(r).toEqual({ text: "Bonjour", model: "qwen3:8b", usage: { in: 12, out: 3 } });
    expect(seen?.path).toBe("/v1/chat/completions");
    expect(seen?.headers.authorization).toBe("Bearer k-1");
    expect(seen?.headers["content-type"]).toBe("application/json");
    expect(seen?.body).toEqual({ model: "qwen3:8b", messages: [{ role: "system", content: "Translate to French." }, { role: "user", content: "Hello" }], max_tokens: 64, temperature: 0.2 });
  });

  test("no key, no system, no temperature: nothing is sent for them", async () => {
    mode = "openai";
    await openaiCompatibleGenerator({ baseUrl: `${base()}/v1/`, model: "m" }).generate({ prompt: "Hi" });
    expect(seen?.path).toBe("/v1/chat/completions");
    expect(seen?.headers.authorization).toBeUndefined();
    expect(seen?.body).toEqual({ model: "m", messages: [{ role: "user", content: "Hi" }], max_tokens: DEFAULT_MAX_TOKENS });
  });

  test("content given as parts is joined; the model falls back to the configured one", async () => {
    mode = "parts";
    expect(await gen().generate({ prompt: "x" })).toEqual({ text: "Bonjour", model: "qwen3:8b", usage: undefined });
  });

  test("no choices → bad-response", async () => {
    mode = "no-choices";
    expect(await codeOf(gen().generate({ prompt: "x" }))).toBe("bad-response");
  });

  const cases: [Mode, ProviderError["code"]][] = [[401, "auth"], [403, "auth"], [404, "model"], [429, "quota"], [500, "model"], [503, "model"], ["html", "model"], [400, "bad-response"]];
  for (const [m, code] of cases) test(`${m} → ${code}`, async () => {
    mode = m;
    expect(await codeOf(gen().generate({ prompt: "x" }))).toBe(code);
  });

  test("404 names the model and the base URL when the server says nothing useful", async () => {
    mode = 404;
    let err: unknown;
    try { await gen().generate({ prompt: "x" }); } catch (e) { err = e; }
    expect((err as ProviderError).message).toContain("stub says 404");
    expect((err as ProviderError).message).toContain("openai-compatible");
  });

  test("connection refused → network", async () => {
    expect(await codeOf(openaiCompatibleGenerator({ baseUrl: "http://127.0.0.1:1/v1", model: "m" }).generate({ prompt: "x" }))).toBe("network");
  });
});

// The generator builds the real Anthropic URL; point fetch at the stub by
// rewriting the host through a tiny wrapper, as cloudflare.test.ts does.
const withStub = (g: Generator): Generator => ({
  ...g,
  generate: async (req) => {
    const real = globalThis.fetch;
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => real(String(url).replace("https://api.anthropic.com", base()), init)) as typeof fetch;
    try { return await g.generate(req); } finally { globalThis.fetch = real; }
  },
});

describe("anthropic generator", () => {
  const gen = (model?: string) => withStub(anthropicGenerator({ apiKey: "sk-test", model }));

  test("posts /v1/messages with x-api-key and the version header; text is content[].text joined", async () => {
    mode = "anthropic";
    const r = await gen().generate({ system: "Be brief.", prompt: "Hi", maxTokens: 100, temperature: 0.5 });
    expect(r).toEqual({ text: "Hola mundo", model: "claude-sonnet-5", usage: { in: 20, out: 4 } });
    expect(seen?.path).toBe("/v1/messages");
    expect(seen?.headers["x-api-key"]).toBe("sk-test");
    expect(seen?.headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(seen?.headers.authorization).toBeUndefined();
    expect(seen?.body).toEqual({ model: DEFAULT_ANTHROPIC_MODEL, max_tokens: 100, system: "Be brief.", messages: [{ role: "user", content: "Hi" }] });
    expect("temperature" in (seen?.body ?? {})).toBe(false);
  });

  test("the default model is the current Sonnet; a configured one passes through", async () => {
    expect(DEFAULT_ANTHROPIC_MODEL).toBe("claude-sonnet-5");
    mode = "anthropic";
    await gen("claude-opus-5").generate({ prompt: "Hi" });
    expect(seen?.body.model).toBe("claude-opus-5");
    expect(seen?.body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect("system" in (seen?.body ?? {})).toBe(false);
  });

  const cases: [Mode, ProviderError["code"]][] = [[401, "auth"], [403, "auth"], [404, "model"], [429, "quota"], [529, "model"], [500, "model"], [400, "bad-response"]];
  for (const [m, code] of cases) test(`${m} → ${code}`, async () => {
    mode = m;
    expect(await codeOf(gen().generate({ prompt: "x" }))).toBe(code);
  });

  test("a body without content[] → bad-response", async () => {
    mode = "no-choices";
    expect(await codeOf(gen().generate({ prompt: "x" }))).toBe("bad-response");
  });
});

describe("hosted generator", () => {
  test("posts {prompt, system, maxTokens} to <base>/v1/generate with the subscriber token", async () => {
    mode = "hosted";
    const r = await hostedGenerator("sub-1", base()).generate({ system: "S", prompt: "P", maxTokens: 50 });
    expect(r).toEqual({ text: "Hallo", model: "hosted/qwen", usage: { in: 5, out: 2 } });
    expect(seen?.path).toBe("/v1/generate");
    expect(seen?.headers.authorization).toBe("Bearer sub-1");
    expect(seen?.body).toEqual({ prompt: "P", system: "S", maxTokens: 50 });
  });

  test("a base given as the old full ask URL still lands on /v1/generate", async () => {
    mode = "hosted";
    await hostedGenerator("t", `${base()}/v1/ask`).generate({ prompt: "P" });
    expect(seen?.path).toBe("/v1/generate");
    expect(seen?.body).toEqual({ prompt: "P" });
  });

  const cases: [Mode, ProviderError["code"]][] = [[401, "auth"], [402, "quota"], [429, "quota"], [500, "model"], ["no-choices", "bad-response"]];
  for (const [m, code] of cases) test(`${m} → ${code}`, async () => {
    mode = m;
    expect(await codeOf(hostedGenerator("t", base()).generate({ prompt: "x" }))).toBe(code);
  });
});

describe("none generator", () => {
  test("throws unavailable without touching the network", async () => {
    const g = createGenerator({ kind: "none" });
    expect(g.name).toBe("none");
    let err: unknown;
    try { await g.generate({ prompt: "x" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("unavailable");
    expect((err as ProviderError).message).toContain("no generator configured");
  });
});

describe("generatorFromEnv", () => {
  test("defaults to none", () => expect(generatorFromEnv({})).toEqual({ kind: "none" }));
  test("openai-compatible needs a model and defaults the base URL to Ollama", () => {
    expect(() => generatorFromEnv({ PASTE_GENERATOR: "openai-compatible" })).toThrow(/PASTE_GEN_MODEL/);
    expect(generatorFromEnv({ PASTE_GENERATOR: "openai-compatible", PASTE_GEN_MODEL: "qwen3:8b" })).toEqual({ kind: "openai-compatible", baseUrl: DEFAULT_OLLAMA_URL, model: "qwen3:8b" });
    expect(generatorFromEnv({ PASTE_GENERATOR: "openai-compatible", PASTE_GEN_MODEL: "gpt", PASTE_GEN_BASE_URL: "https://api.openai.com/v1", PASTE_GEN_API_KEY: "k" }))
      .toEqual({ kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt", apiKey: "k" });
  });
  test("anthropic needs a key; hosted needs a token; unknown kinds throw", () => {
    expect(() => generatorFromEnv({ PASTE_GENERATOR: "anthropic" })).toThrow(/PASTE_GEN_API_KEY/);
    expect(generatorFromEnv({ PASTE_GENERATOR: "anthropic", PASTE_GEN_API_KEY: "k", PASTE_GEN_MODEL: "claude-opus-5" })).toEqual({ kind: "anthropic", apiKey: "k", model: "claude-opus-5" });
    expect(() => generatorFromEnv({ PASTE_GENERATOR: "hosted" })).toThrow(/PASTE_TOKEN/);
    expect(generatorFromEnv({ PASTE_GENERATOR: "hosted", PASTE_TOKEN: "t", PASTE_HOSTED_URL: "https://h.example" })).toEqual({ kind: "hosted", token: "t", url: "https://h.example" });
    expect(() => generatorFromEnv({ PASTE_GENERATOR: "bogus" })).toThrow(/PASTE_GENERATOR/);
  });
  test("createGenerator names each kind", () => {
    expect(createGenerator({ kind: "openai-compatible", baseUrl: "http://x/v1", model: "m" }).name).toBe("openai-compatible");
    expect(createGenerator({ kind: "anthropic", apiKey: "k" }).name).toBe("anthropic");
    expect(createGenerator({ kind: "hosted", token: "t" }).name).toBe("hosted");
  });
});
