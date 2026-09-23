/** Jev over TypeSafe, Vercel AI Gateway and OpenRouter with your own key; gateway generators. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { deciderFromEnv, PROVIDER_KINDS } from "../src/provider/decider/index.ts";
import { JEV_SERVICES, JEV_SERVICE_KINDS, jevApiDecider, type JevService } from "../src/provider/decider/jev-api.ts";
import { deciderConfigOf, generatorConfigOf, memorySecretStore, parseStoredDecider, parseStoredGenerator, SECRET_REFS } from "../src/provider/config.ts";
import { generatorFromEnv, GENERATOR_KINDS } from "../src/provider/generator/index.ts";
import { ProviderError } from "../src/provider/types.ts";
import { buildRequest } from "../src/questions.ts";

const ANSWERS = { kind: { type: "choice", choice: "plain", probabilities: { plain: 0.9 } }, animate: { type: "noul", noul: 0.1 } };

let server: ReturnType<typeof Bun.serve>;
let mode = "ok";
let seen = { auth: "", url: "", body: null as unknown };
beforeAll(() => {
  server = Bun.serve({ port: 0, async fetch(req) {
    seen = { auth: req.headers.get("authorization") ?? "", url: req.url, body: await req.json() };
    switch (mode) {
      case "ok": return Response.json({ model: "jev-1.13.0", answers: ANSWERS, usage: { input_tokens: 10, output_tokens: 0 } });
      case "auth": return Response.json({ message: "invalid api key", error_type: "authentication_error" }, { status: 401 });
      case "credit": return Response.json({ error: { message: "Insufficient credits", code: 402 } }, { status: 402 });
      case "rate": return Response.json({ error: { message: "Rate limit exceeded", code: 429 } }, { status: 429 });
      case "model": return Response.json({ message: "model not found" }, { status: 404 });
      case "invalid": return Response.json({ message: "questions.x.type: expected one of 'noul', 'choice', 'score'", error_type: "invalid_request" }, { status: 400 });
      case "empty": return Response.json({ model: "jev-1.13.0" });
      default: return new Response("boom", { status: 500 });
    }
  } });
});
afterAll(() => server.stop(true));

/** Send the service's real URL to the stub, keeping the path. */
async function viaStub<T>(run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    return real(`http://127.0.0.1:${server.port}${u.pathname}?host=${u.host}`, init);
  }) as typeof fetch;
  try { return await run(); } finally { globalThis.fetch = real; }
}

const body = buildRequest("hello world").body;

describe("Jev public APIs", () => {
  const expected: Record<JevService, { host: string; path: string; model: string }> = {
    typesafe: { host: "api.typesafe.ai", path: "/v1/systemone", model: "jev-latest" },
    vercel: { host: "ai-gateway.vercel.sh", path: "/typesafe/v1/systemone", model: "typesafe-ai/jev" },
    openrouter: { host: "openrouter.ai", path: "/api/alpha/decisions", model: "~typesafe/jev-latest" },
  };

  for (const service of JEV_SERVICE_KINDS) {
    test(`${service}: posts {model, state, questions} with a bearer key and returns the answers`, async () => {
      mode = "ok";
      expect(await viaStub(() => jevApiDecider(service, "key-1").ask(body))).toEqual(ANSWERS);
      const url = new URL(seen.url);
      expect(url.searchParams.get("host")).toBe(expected[service].host);
      expect(url.pathname).toBe(expected[service].path);
      expect(seen.auth).toBe("Bearer key-1");
      expect(seen.body).toEqual({ model: expected[service].model, state: body.state, questions: body.questions });
    });
  }

  test("a model override replaces the service default", async () => {
    mode = "ok";
    await viaStub(() => jevApiDecider("typesafe", "k", "jev-1.13.0").ask(body));
    expect((seen.body as { model: string }).model).toBe("jev-1.13.0");
  });

  const cases: [string, ProviderError["code"], RegExp][] = [
    ["auth", "auth", /invalid api key/], ["credit", "quota", /Insufficient credits/], ["rate", "quota", /Rate limit/],
    ["model", "model", /model not found/], ["server", "model", /HTTP 500/], ["invalid", "bad-response", /expected one of/],
    ["empty", "bad-response", /no answers in response/],
  ];
  for (const [m, code, message] of cases) {
    test(`${m} → ${code}, carrying the service's message`, async () => {
      mode = m;
      const error = await viaStub(() => jevApiDecider("openrouter", "k").ask(body)).catch((e) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).code).toBe(code);
      expect(String((error as Error).message)).toMatch(message);
    });
  }
});

describe("configuration", () => {
  test("the services are decider kinds, and the gateways generator kinds", () => {
    for (const k of JEV_SERVICE_KINDS) expect(PROVIDER_KINDS).toContain(k);
    expect(GENERATOR_KINDS).toContain("openrouter");
    expect(GENERATOR_KINDS).toContain("vercel");
    for (const s of Object.values(JEV_SERVICES)) expect(s.url.startsWith("https://")).toBe(true);
  });

  test("stored decider: a key reference and an optional model; the key resolves from the secret store", async () => {
    const stored = parseStoredDecider({ kind: "vercel", tokenRef: SECRET_REFS.vercelKey });
    expect(stored).toEqual({ kind: "vercel", tokenRef: "pocket-paste/vercel" });
    const secrets = memorySecretStore({ "pocket-paste/vercel": "vk" });
    expect(await deciderConfigOf(stored, secrets)).toEqual({ kind: "vercel", token: "vk" });
    expect(parseStoredDecider({ kind: "typesafe", tokenRef: "pocket-paste/typesafe", model: "jev-1.13.0" })).toEqual({ kind: "typesafe", tokenRef: "pocket-paste/typesafe", model: "jev-1.13.0" });
    expect(() => parseStoredDecider({ kind: "openrouter" })).toThrow(/tokenRef is required/);
    expect(() => parseStoredDecider({ kind: "openrouter", token: "raw" })).toThrow(/secrets do not belong/);
    await expect(deciderConfigOf({ kind: "openrouter", tokenRef: "pocket-paste/openrouter" }, memorySecretStore({}))).rejects.toThrow(/no secret named/);
  });

  test("stored gateway generator: becomes OpenAI-compatible at the gateway's URL with the shared key", async () => {
    const stored = parseStoredGenerator({ kind: "openrouter", model: "anthropic/claude-sonnet-5", apiKeyRef: SECRET_REFS.openrouterKey });
    const secrets = memorySecretStore({ "pocket-paste/openrouter": "ok" });
    expect(await generatorConfigOf(stored, secrets)).toEqual({ kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-5", apiKey: "ok" });
    const vercel = parseStoredGenerator({ kind: "vercel", model: "openai/gpt-5", apiKeyRef: SECRET_REFS.vercelKey });
    expect((await generatorConfigOf(vercel, memorySecretStore({ "pocket-paste/vercel": "vk" }))).kind).toBe("openai-compatible");
    expect(() => parseStoredGenerator({ kind: "vercel", apiKeyRef: "pocket-paste/vercel" })).toThrow(/model is required/);
  });

  test("environment: each service reads the key name its own docs use", () => {
    expect(deciderFromEnv({ PASTE_PROVIDER: "typesafe", TYPESAFE_API_KEY: "t" })).toEqual({ kind: "typesafe", token: "t" });
    expect(deciderFromEnv({ PASTE_PROVIDER: "vercel", AI_GATEWAY_API_KEY: "v", PASTE_JEV_MODEL: "typesafe-ai/jev" })).toEqual({ kind: "vercel", token: "v", model: "typesafe-ai/jev" });
    expect(() => deciderFromEnv({ PASTE_PROVIDER: "openrouter" })).toThrow(/OPENROUTER_API_KEY/);
    expect(generatorFromEnv({ PASTE_GENERATOR: "openrouter", PASTE_GEN_MODEL: "m", OPENROUTER_API_KEY: "o" })).toEqual({ kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "m", apiKey: "o" });
  });
});
