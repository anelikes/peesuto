import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endpointDecider } from "../src/provider/decider/endpoint.ts";
import {
  answersOf, createGenerator, createProvider, DEV_PROXY_URL, DEFAULT_HOSTED_URL, envSecretName, envSecretStore, hostedUrl, isOffline, memorySecretStore,
  parseProvidersConfig, ProviderConfigError, ProviderError, providerFromEnv, readProvidersConfig, resolveProviders, setOffline, writeProvidersConfig,
  type ProvidersConfig,
} from "../src/provider/index.ts";
import { buildRequest, isCardAnswers, type Answers } from "../src/questions.ts";

const ANSWERS: Answers = {
  kind: { choice: "stat", probabilities: { stat: 0.8, plain: 0.2 } },
  layout: { choice: "left" },
  palette: { choice: "cyan" },
  scale: { score: 1.2 },
  tone: { score: 2.7 },
  animate: { noul: 0.9 },
  emphasis: { choice: "w3" },
};

/** The ProviderError code a promise rejects with, or "resolved". */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) {
    if (e instanceof ProviderError) return e.code;
    throw e;
  }
  return "resolved";
}

describe("answersOf", () => {
  test("unwraps {result: {answers}}", () => expect(answersOf({ result: { answers: ANSWERS } }, "t")).toEqual(ANSWERS));
  test("unwraps {answers}", () => expect(answersOf({ answers: ANSWERS }, "t")).toEqual(ANSWERS));
  test("accepts any question set, not only the card's", () => {
    const pick = { pick: { choice: "c2", probabilities: { c1: 0.1, c2: 0.9 } }, here: { noul: 0.7 } };
    expect(answersOf({ answers: pick }, "t")).toEqual(pick);
  });
  test("throws bad-response on anything else", () => {
    for (const raw of [null, "text", {}, { error: "nope" }, { result: {} }, { answers: {} }, { answers: "x" }, { answers: { kind: "stat" } }, { answers: [ANSWERS] }, []]) {
      let err: unknown;
      try { answersOf(raw, "origin"); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe("bad-response");
      expect((err as ProviderError).message).toContain("origin");
    }
  });
});

describe("isCardAnswers", () => {
  test("accepts the seven answers in their shapes", () => expect(isCardAnswers(ANSWERS)).toBe(true));
  test("accepts answers without kind probabilities", () => expect(isCardAnswers({ ...ANSWERS, kind: { choice: "plain" } })).toBe(true));
  test("rejects a missing question, a wrong field type, and non-objects", () => {
    const { emphasis: _e, ...six } = ANSWERS;
    expect(isCardAnswers(six)).toBe(false);
    expect(isCardAnswers({ ...ANSWERS, scale: { choice: "big" } })).toBe(false);
    expect(isCardAnswers({ ...ANSWERS, animate: { noul: "yes" } })).toBe(false);
    expect(isCardAnswers({ ...ANSWERS, tone: { score: Number.NaN } })).toBe(false);
    expect(isCardAnswers({ pick: { choice: "c1" } })).toBe(false);
    for (const v of [null, undefined, "x", 3, [], {}]) expect(isCardAnswers(v)).toBe(false);
  });
});

describe("hostedUrl", () => {
  test("routes off a base URL, with or without a trailing slash", () => {
    expect(hostedUrl(undefined, "ask")).toBe(`${DEFAULT_HOSTED_URL}/v1/ask`);
    expect(hostedUrl("https://x.example/", "generate")).toBe("https://x.example/v1/generate");
    expect(hostedUrl("https://x.example/base", "ask")).toBe("https://x.example/base/v1/ask");
  });
  test("re-routes a full route URL from an older config", () => {
    expect(hostedUrl("https://x.example/v1/ask", "generate")).toBe("https://x.example/v1/generate");
    expect(hostedUrl("https://x.example/v1/generate", "ask")).toBe("https://x.example/v1/ask");
  });
});

describe("providerFromEnv", () => {
  test("defaults to the dev proxy", () => {
    expect(providerFromEnv({})).toEqual({ kind: "proxy", url: DEV_PROXY_URL, token: undefined });
  });
  test("honours PASTE_PROVIDER=none", () => {
    expect(providerFromEnv({ PASTE_PROVIDER: "none" })).toEqual({ kind: "none" });
  });
  test("reads the proxy url and token", () => {
    expect(providerFromEnv({ PASTE_PROVIDER: "proxy", PASTE_PROXY_URL: "https://jev.example/", PASTE_TOKEN: "t0k" }))
      .toEqual({ kind: "proxy", url: "https://jev.example/", token: "t0k" });
  });
  test("throws on an unknown value, and on a known kind missing its credentials", () => {
    expect(() => providerFromEnv({ PASTE_PROVIDER: "bogus" })).toThrow(/PASTE_PROVIDER/);
    expect(() => providerFromEnv({ PASTE_PROVIDER: "cloudflare" })).toThrow(/PASTE_CF_ACCOUNT_ID/);
    expect(() => providerFromEnv({ PASTE_PROVIDER: "hosted" })).toThrow(/PASTE_TOKEN/);
    expect(providerFromEnv({ PASTE_PROVIDER: "cloudflare", PASTE_CF_ACCOUNT_ID: "a", PASTE_CF_TOKEN: "t" })).toEqual({ kind: "cloudflare", accountId: "a", token: "t" });
  });
  test("createProvider(none) answers null", async () => {
    const p = createProvider({ kind: "none" });
    expect(p.name).toBe("none");
    expect(await p.ask(buildRequest("hi").body)).toBeNull();
  });
});

describe("endpointDecider", () => {
  type Mode = "ok" | "bare" | "not-json" | 401 | 403 | 402 | 429 | 500 | 503;
  let mode: Mode = "ok";
  let seen: { path: string; auth: string | null; body: unknown } | null = null;
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        seen = { path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body: await req.json() };
        if (mode === "ok") return Response.json({ result: { answers: ANSWERS }, ms: 12 });
        if (mode === "bare") return Response.json({ answers: ANSWERS });
        if (mode === "not-json") return new Response("<html>gateway</html>", { status: 502 });
        return Response.json({ error: `stub says ${mode}` }, { status: mode });
      },
    });
  });
  afterAll(() => { server.stop(true); });

  const url = () => `http://127.0.0.1:${server.port}/`;
  const body = () => buildRequest("本季度活跃用户增长了 37%").body;

  test("returns the answers on 200 and forwards the request body", async () => {
    mode = "ok";
    const p = createProvider({ kind: "proxy", url: url() });
    expect(p.name).toBe("proxy");
    expect(await p.ask(body())).toEqual(ANSWERS);
    expect(seen?.body).toEqual(body());
    expect(seen?.auth).toBeNull();
  });

  test("the hosted kind is the same decider at <base>/v1/ask with the subscriber token", async () => {
    mode = "ok";
    const p = createProvider({ kind: "hosted", token: "sub-1", url: url() });
    expect(p.name).toBe("hosted");
    expect(await p.ask(body())).toEqual(ANSWERS);
    expect(seen?.path).toBe("/v1/ask");
    expect(seen?.auth).toBe("Bearer sub-1");
  });

  test("accepts a bare {answers} envelope too", async () => {
    mode = "bare";
    expect(await endpointDecider(url()).ask(body())).toEqual(ANSWERS);
  });

  test("sends the bearer token when given", async () => {
    mode = "ok";
    await endpointDecider(url(), "s3cret").ask(body());
    expect(seen?.auth).toBe("Bearer s3cret");
  });

  test("401 and 403 → auth", async () => {
    mode = 401;
    expect(await codeOf(endpointDecider(url()).ask(body()))).toBe("auth");
    mode = 403;
    expect(await codeOf(endpointDecider(url()).ask(body()))).toBe("auth");
  });

  test("429 and 402 → quota", async () => {
    mode = 429;
    expect(await codeOf(endpointDecider(url()).ask(body()))).toBe("quota");
    mode = 402;
    expect(await codeOf(endpointDecider(url()).ask(body()))).toBe("quota");
  });

  test("500 and 503 → model", async () => {
    mode = 500;
    expect(await codeOf(endpointDecider(url()).ask(body()))).toBe("model");
    mode = 503;
    expect(await codeOf(endpointDecider(url()).ask(body()))).toBe("model");
  });

  test("a non-JSON 5xx is still model, not a crash", async () => {
    mode = "not-json";
    expect(await codeOf(endpointDecider(url()).ask(body()))).toBe("model");
  });

  test("a closed port → network", async () => {
    expect(await codeOf(endpointDecider("http://127.0.0.1:1/").ask(body()))).toBe("network");
  });

  test("a custom name shows up in the error", async () => {
    mode = 401;
    let err: unknown;
    try { await endpointDecider(url(), undefined, "hosted").ask(body()); } catch (e) { err = e; }
    expect((err as ProviderError).message).toContain("hosted");
  });
});

describe("providers config", () => {
  afterEach(() => setOffline(false));

  const cfg: ProvidersConfig = {
    decider: { kind: "cloudflare", accountId: "acct", tokenRef: "pocket-paste/cloudflare" },
    generator: { kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "qwen3:8b" },
    offline: false,
  };

  test("a missing file is the defaults: nothing configured, online", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-cfg-"));
    expect(await readProvidersConfig(join(dir, "providers.json"))).toEqual({ decider: { kind: "none" }, generator: { kind: "none" }, offline: false });
  });

  test("write → read round-trips, and the file is owner-only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-cfg-"));
    const file = join(dir, "sub", "providers.json");
    await writeProvidersConfig(file, cfg);
    expect(await readProvidersConfig(file)).toEqual(cfg);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).not.toContain("token\"");
  });

  test("a partial file fills in the defaults; a malformed one throws with the field named", () => {
    expect(parseProvidersConfig({ offline: true })).toEqual({ decider: { kind: "none" }, generator: { kind: "none" }, offline: true });
    expect(() => parseProvidersConfig({ decider: { kind: "cloudflare", accountId: "a" } })).toThrow(/decider\.tokenRef/);
    expect(() => parseProvidersConfig({ generator: { kind: "openai-compatible", baseUrl: "u" } })).toThrow(/generator\.model/);
    expect(() => parseProvidersConfig({ generator: { kind: "openai-compatible", baseUrl: "u", model: "m", reasoning: "off" } })).toThrow(/generator\.reasoning/);
    expect(() => parseProvidersConfig({ generator: { kind: "openai-compatible", baseUrl: "u", model: "m", timeoutMs: "60" } })).toThrow(/generator\.timeoutMs/);
    expect(() => parseProvidersConfig({ generator: { kind: "openai-compatible", baseUrl: "u", model: "m", timeoutMs: 0 } })).toThrow(/generator\.timeoutMs/);
    expect(parseProvidersConfig({ generator: { kind: "openai-compatible", baseUrl: "u", model: "m", reasoning: "none", timeoutMs: 180000 } }).generator)
      .toEqual({ kind: "openai-compatible", baseUrl: "u", model: "m", reasoning: "none", timeoutMs: 180000 });
    expect(() => parseProvidersConfig({ generator: { kind: "bogus" } })).toThrow(/generator\.kind/);
    expect(() => parseProvidersConfig({ offline: "yes" })).toThrow(/offline/);
    expect(() => parseProvidersConfig([])).toThrow(ProviderConfigError);
  });

  test("a raw secret in the file is refused, on read and on write", async () => {
    expect(() => parseProvidersConfig({ decider: { kind: "proxy", url: "u", token: "sk-live" } })).toThrow(/tokenRef/);
    expect(() => parseProvidersConfig({ generator: { kind: "anthropic", apiKey: "sk-live" } })).toThrow(/apiKeyRef/);
    const dir = await mkdtemp(join(tmpdir(), "paste-cfg-"));
    await expect(writeProvidersConfig(join(dir, "p.json"), { ...cfg, generator: { kind: "anthropic", apiKey: "sk-live" } as never })).rejects.toThrow(/apiKeyRef/);
  });

  test("resolveProviders looks secrets up by reference and applies the offline switch", async () => {
    const secrets = memorySecretStore({ "pocket-paste/cloudflare": "cf-token", "pocket-paste/generator": "sk-1" });
    const r = await resolveProviders({ ...cfg, generator: { kind: "anthropic", apiKeyRef: "pocket-paste/generator" }, offline: true }, secrets);
    expect(r.decider?.name).toBe("cloudflare");
    expect(r.generator?.name).toBe("anthropic");
    expect(isOffline()).toBe(true);
    expect(await resolveProviders({ decider: { kind: "none" }, generator: { kind: "none" }, offline: false }, secrets)).toEqual({ decider: null, generator: null });
    expect(isOffline()).toBe(false);
  });

  test("a reference with no secret behind it is a config error naming the reference", async () => {
    await expect(resolveProviders(cfg, memorySecretStore())).rejects.toThrow(/pocket-paste\/cloudflare/);
    await expect(resolveProviders(cfg, memorySecretStore())).rejects.toBeInstanceOf(ProviderConfigError);
  });

  test("envSecretStore reads the variable by its own name or the upper-cased one, and sets the latter", async () => {
    expect(envSecretName("pocket-paste/generator")).toBe("POCKET_PASTE_GENERATOR");
    const env: Record<string, string | undefined> = { POCKET_PASTE_GENERATOR: "from-env", PASTE_TOKEN: "direct" };
    const s = envSecretStore(env);
    expect(await s.get("pocket-paste/generator")).toBe("from-env");
    expect(await s.get("PASTE_TOKEN")).toBe("direct");
    expect(await s.get("pocket-paste/missing")).toBeUndefined();
    await s.set("pocket-paste/hosted", "new");
    expect(env.POCKET_PASTE_HOSTED).toBe("new");
  });

  test("createGenerator(none) is the unavailable generator", async () => {
    expect(await codeOf(createGenerator({ kind: "none" }).generate({ prompt: "x" }))).toBe("unavailable");
  });
});

describe("resolveProviders with a cache dir", () => {
  test("wraps a real decider in the answer cache and leaves none alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-cfg-"));
    const secrets = memorySecretStore({ "pocket-paste/proxy": "t" });
    const cached = await resolveProviders({ decider: { kind: "proxy", url: "http://127.0.0.1:1/", tokenRef: "pocket-paste/proxy" }, generator: { kind: "none" }, offline: false }, secrets, { cacheDir: dir });
    expect(cached.decider?.name).toBe("proxy");
    const none = await resolveProviders({ decider: { kind: "none" }, generator: { kind: "none" }, offline: false }, secrets, { cacheDir: dir });
    expect(none).toEqual({ decider: null, generator: null });
  });
});
