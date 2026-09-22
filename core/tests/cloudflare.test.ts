import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cloudflareDecider } from "../src/provider/decider/cloudflare.ts";
import { ProviderError } from "../src/provider/types.ts";
import { buildRequest } from "../src/questions.ts";

const ANSWERS = { kind: { choice: "plain", probabilities: { plain: 0.9 } }, layout: { choice: "left" }, palette: { choice: "ink" }, scale: { score: 1 }, tone: { score: 0 }, animate: { noul: 0.1 }, emphasis: { choice: "none" } };

let server: ReturnType<typeof Bun.serve>;
let mode = "ok";
let seenAuth = "", seenPath = "", seenBody: unknown = null;
beforeAll(() => {
  server = Bun.serve({ port: 0, async fetch(req) {
    seenAuth = req.headers.get("authorization") ?? ""; seenPath = new URL(req.url).pathname; seenBody = await req.json();
    switch (mode) {
      case "ok": return Response.json({ success: true, result: { answers: ANSWERS }, errors: [] });
      case "auth": return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 401 });
      case "model": return Response.json({ success: false, errors: [{ code: 5007, message: "No such model typesafe/jev" }] }, { status: 404 });
      case "quota": return Response.json({ success: false, errors: [{ code: 3040, message: "Rate limited" }] }, { status: 429 });
      case "envelope-fail": return Response.json({ success: false, errors: [{ code: 1, message: "odd" }] }, { status: 200 });
      default: return new Response("boom", { status: 500 });
    }
  } });
});
afterAll(() => server.stop(true));

// The provider builds the real Cloudflare URL; point fetch at the stub by
// rewriting the host through a tiny wrapper.
const withStub = (p: ReturnType<typeof cloudflareDecider>) => ({
  ...p,
  ask: async (body: ReturnType<typeof buildRequest>["body"]) => {
    const real = globalThis.fetch;
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => real(String(url).replace("https://api.cloudflare.com", `http://127.0.0.1:${server.port}`), init)) as typeof fetch;
    try { return await p.ask(body); } finally { globalThis.fetch = real; }
  },
});

describe("cloudflare provider", () => {
  const p = withStub(cloudflareDecider("acct-123", "tok-abc"));
  const body = buildRequest("hello world").body;
  test("posts {model, input} to /accounts/<id>/ai/run with a bearer token and unwraps result.answers", async () => {
    mode = "ok";
    expect(await p.ask(body)).toEqual(ANSWERS);
    expect(seenPath).toBe("/client/v4/accounts/acct-123/ai/run");
    expect(seenBody).toEqual({ model: "typesafe/jev", input: body });
    expect(seenAuth).toBe("Bearer tok-abc");
  });
  const cases: [string, ProviderError["code"]][] = [["auth", "auth"], ["model", "model"], ["quota", "quota"], ["server", "model"], ["envelope-fail", "bad-response"]];
  for (const [m, code] of cases) test(`${m} → ProviderError(${code})`, async () => {
    mode = m;
    await expect(p.ask(body)).rejects.toMatchObject({ code } satisfies Partial<ProviderError>);
  });
});
