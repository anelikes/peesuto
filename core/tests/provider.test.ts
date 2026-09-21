import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createProvider, DEV_PROXY_URL, ProviderError, providerFromEnv } from "../src/provider/index.ts";
import { proxyProvider } from "../src/provider/proxy.ts";
import { answersOf } from "../src/provider/types.ts";
import { buildRequest, type Answers } from "../src/questions.ts";

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
  test("throws bad-response on anything else", () => {
    for (const raw of [null, "text", {}, { error: "nope" }, { result: {} }, { answers: {} }, { answers: "x" }, []]) {
      let err: unknown;
      try { answersOf(raw, "origin"); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe("bad-response");
      expect((err as ProviderError).message).toContain("origin");
    }
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

describe("proxyProvider", () => {
  type Mode = "ok" | "bare" | "not-json" | 401 | 403 | 402 | 429 | 500 | 503;
  let mode: Mode = "ok";
  let seen: { auth: string | null; body: unknown } | null = null;
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        seen = { auth: req.headers.get("authorization"), body: await req.json() };
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

  test("accepts a bare {answers} envelope too", async () => {
    mode = "bare";
    expect(await proxyProvider(url()).ask(body())).toEqual(ANSWERS);
  });

  test("sends the bearer token when given", async () => {
    mode = "ok";
    await proxyProvider(url(), "s3cret").ask(body());
    expect(seen?.auth).toBe("Bearer s3cret");
  });

  test("401 and 403 → auth", async () => {
    mode = 401;
    expect(await codeOf(proxyProvider(url()).ask(body()))).toBe("auth");
    mode = 403;
    expect(await codeOf(proxyProvider(url()).ask(body()))).toBe("auth");
  });

  test("429 and 402 → quota", async () => {
    mode = 429;
    expect(await codeOf(proxyProvider(url()).ask(body()))).toBe("quota");
    mode = 402;
    expect(await codeOf(proxyProvider(url()).ask(body()))).toBe("quota");
  });

  test("500 and 503 → model", async () => {
    mode = 500;
    expect(await codeOf(proxyProvider(url()).ask(body()))).toBe("model");
    mode = 503;
    expect(await codeOf(proxyProvider(url()).ask(body()))).toBe("model");
  });

  test("a non-JSON 5xx is still model, not a crash", async () => {
    mode = "not-json";
    expect(await codeOf(proxyProvider(url()).ask(body()))).toBe("model");
  });

  test("a closed port → network", async () => {
    expect(await codeOf(proxyProvider("http://127.0.0.1:1/").ask(body()))).toBe("network");
  });

  test("a custom name shows up in the error", async () => {
    mode = 401;
    let err: unknown;
    try { await proxyProvider(url(), undefined, "hosted").ask(body()); } catch (e) { err = e; }
    expect((err as ProviderError).message).toContain("hosted");
  });
});
