import { describe, expect, test } from "bun:test";
import { pick } from "../src/pick/index.ts";
import type { ClipItem, Context } from "../src/pick/types.ts";
import { createDecider, DEFAULT_LAYA_URL, deciderFromEnv, LAYA_PICK_WEIGHT, PROVIDER_KINDS } from "../src/provider/decider/index.ts";
import { rulesAnswers, rulesDecider } from "../src/provider/decider/rules.ts";
import { DEFAULT_PROVIDERS_CONFIG, deciderConfigOf, memorySecretStore, parseProvidersConfig } from "../src/provider/config.ts";
import { answersToDsl, buildRequest, fallbackDsl, isCardAnswers, type JevRequest } from "../src/questions.ts";
import { decideCard } from "../src/render/pipeline.ts";

const CODE = "const a = 1;\nconst b = a + 1;\nexport { b };";
const LIST = "- history first\n- pick second\n- cards third";
const PROSE = "剪贴板是最常用却最少被设计的功能。每一次粘贴都是用户在一秒内做出的决定。";

describe("rules decider", () => {
  test("answers the seven card questions in the shape the card path needs", async () => {
    const a = await rulesDecider.ask(buildRequest(CODE).body);
    expect(isCardAnswers(a)).toBe(true);
    expect(a!.kind!.choice).toBe("code");
    expect(a!.kind!.probabilities).toEqual({ code: 1 });
    expect(a!.emphasis!.choice).toBe("none");
    expect(a!.animate!.noul).toBe(0);
  });
  test("the DSL is the fallback's geometry with the classified kind", async () => {
    for (const text of [CODE, LIST, PROSE]) {
      const { dsl } = answersToDsl(text, rulesAnswers(text) as never, "chat");
      const fb = fallbackDsl(text, "chat");
      expect({ ...dsl, kind: "plain" }).toEqual(fb);
    }
    expect((await decideCard(LIST, { aspect: "chat", decider: rulesDecider })).dsl.kind).toBe("list");
    const d = await decideCard(PROSE, { aspect: "social", decider: rulesDecider });
    expect(d.decided.provider).toBe("rules");
    expect(d.dsl.aspect).toBe("social");
    expect(d.dsl.animate).toBe(false);
  });
  test("a pick request gets null, so the heuristic ranks", async () => {
    const ctx: Context = { level: 0, appBundleId: "com.apple.Notes" };
    const items: ClipItem[] = [
      { id: "a", kind: "text", text: "newest", preview: "newest", appBundleId: "com.apple.Safari", createdAt: Date.now() - 1000 },
      { id: "b", kind: "text", text: "older", preview: "older", appBundleId: "com.apple.Safari", createdAt: Date.now() - 60_000 },
    ];
    const r = await pick(ctx, items, rulesDecider);
    expect(r.source).toBe("heuristic");
    expect(await rulesDecider.ask({ state: { clipboard: "   " }, questions: { kind: {}, emphasis: {} } })).toBeNull();
  });
  test("empty and whitespace clipboards are not answered", async () => {
    expect(await rulesDecider.ask({ state: { clipboard: "" }, questions: { kind: {}, emphasis: {} } })).toBeNull();
  });
});

describe("rules and laya as provider kinds", () => {
  test("the kinds list and the factory", () => {
    expect(PROVIDER_KINDS).toEqual(["rules", "none", "laya", "proxy", "cloudflare", "typesafe", "vercel", "openrouter", "hosted"]);
    expect(createDecider({ kind: "rules" }).name).toBe("rules");
    const laya = createDecider({ kind: "laya" });
    expect(laya.name).toBe("laya");
    expect(laya.pickWeight).toBe(LAYA_PICK_WEIGHT);
    expect(createDecider({ kind: "proxy", url: "http://x/" }).pickWeight).toBeUndefined();
  });
  test("from the environment", () => {
    expect(deciderFromEnv({ PASTE_PROVIDER: "rules" })).toEqual({ kind: "rules" });
    expect(deciderFromEnv({ PASTE_PROVIDER: "laya" })).toEqual({ kind: "laya" });
    expect(deciderFromEnv({ PASTE_PROVIDER: "laya", PASTE_LAYA_URL: "http://127.0.0.1:9000/" })).toEqual({ kind: "laya", url: "http://127.0.0.1:9000/" });
    expect(DEFAULT_LAYA_URL).toBe("http://127.0.0.1:8790/");
  });
  test("stored config: rules is the default; laya carries an optional url and no secret", async () => {
    expect(DEFAULT_PROVIDERS_CONFIG.decider).toEqual({ kind: "rules" });
    expect(parseProvidersConfig({ decider: { kind: "rules" } }).decider).toEqual({ kind: "rules" });
    expect(parseProvidersConfig({ decider: { kind: "laya" } }).decider).toEqual({ kind: "laya" });
    expect(parseProvidersConfig({ decider: { kind: "laya", url: "http://127.0.0.1:8790/" } }).decider).toEqual({ kind: "laya", url: "http://127.0.0.1:8790/" });
    expect(() => parseProvidersConfig({ decider: { kind: "laya", url: 7 } })).toThrow(/decider\.url/);
    const secrets = memorySecretStore({});
    expect(await deciderConfigOf({ kind: "rules" }, secrets)).toEqual({ kind: "rules" });
    expect(await deciderConfigOf({ kind: "laya", url: "http://h/" }, secrets)).toEqual({ kind: "laya", url: "http://h/" });
  });
});

describe("pick blend weight", () => {
  const ctx: Context = { level: 0, appBundleId: "com.apple.Notes" };
  const now = 1_700_000_000_000;
  const items: ClipItem[] = [
    { id: "new", kind: "text", text: "the newest text", preview: "the newest text", appBundleId: "com.apple.Safari", createdAt: now - 1000 },
    { id: "old", kind: "text", text: "an older text", preview: "an older text", appBundleId: "com.apple.Safari", createdAt: now - 20 * 60_000 },
  ];
  const favoursOld = (pickWeight?: number) => ({
    name: "stub", pickWeight,
    ask: async (body: JevRequest) => {
      const q = body.questions as { pick: { criteria: Record<string, string> } };
      const keys = Object.keys(q.pick.criteria).filter((k) => k !== "none");
      return { pick: { choice: keys[1], probabilities: { [keys[0]!]: 0.05, [keys[1]!]: 0.95 } }, paste: { noul: 0.9 } };
    },
  });
  test("a decider's own pickWeight is used when the caller passes none", async () => {
    const strong = await pick(ctx, items, favoursOld(), { now });
    expect(strong.ranked[0]!.item.id).toBe("old");
    const nudge = await pick(ctx, items, favoursOld(0.1), { now });
    expect(nudge.ranked[0]!.item.id).toBe("new");
    const overridden = await pick(ctx, items, favoursOld(0.1), { now, deciderWeight: 0.9 });
    expect(overridden.ranked[0]!.item.id).toBe("old");
  });
});
