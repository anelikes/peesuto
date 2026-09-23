import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCENARIOS } from "../../scripts/studio/scenarios.ts";
import { Daemon, type DaemonHost } from "../src/daemon/server.ts";
import { pick } from "../src/pick/index.ts";
import { deciderForModel, privateDecider, rewriteForModel } from "../src/privacy/decider.ts";
import {
  applyOutputRules, BUILTIN_RULES, compilePrivacy, containsSecret, DEFAULT_PRIVACY, hasNestedQuantifier, idCardValid, luhnValid,
  modelText, parsePrivacyConfig, PrivacyConfigError, redactForModel, structureOnly, type PrivacyConfig,
} from "../src/privacy/rules.ts";
import type { JevRequest } from "../src/questions.ts";
import { decideTemplate } from "../src/templates/decide.ts";

// Every secret below is fake: made up for these tests, valid for nothing.
const FAKE = {
  openai: "sk-proj-FAKEfake0000FAKEfake1111FAKE",
  anthropic: "sk-ant-api03-FAKEfakeFAKEfake0000000000",
  github: "ghp_FAKEfakeFAKEfakeFAKEfakeFAKEfake0000",
  githubPat: "github_pat_FAKE0000fake1111FAKE2222fake",
  awsId: "AKIAFAKEFAKEFAKE0000",
  awsSecret: "FAKEfake/FAKEfake+FAKEfake0000FAKEfake00",
  google: "AIzaFAKEfakeFAKEfakeFAKEfakeFAKEfake000",
  slack: "xoxb-0000-FAKE-fakefakefake",
  stripe: "sk_live_FAKEfakeFAKEfake0000",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJGQUtFIn0.FAKEsignatureFAKEsignature00",
  random: "a8Fk3mQz9LpW2xRt7Yb5",
};

const defaults = compilePrivacy();
const everything = compilePrivacy({ ...DEFAULT_PRIVACY, builtins: { email: true, phone: true, "id-card": true, "bank-card": true } });
const redact = (t: string, p = defaults) => redactForModel(t, p).text;
const ruleIds = (t: string, p = defaults) => redactForModel(t, p).spans.map((s) => s.ruleId);

describe("built-in rules", () => {
  test("the list the contract names, secrets on and personal data off", () => {
    expect(BUILTIN_RULES.map((r) => [r.id, r.defaultEnabled])).toEqual([
      ["api-keys", true], ["private-keys", true], ["jwt", true], ["bearer-tokens", true], ["connection-strings", true],
      ["secret-assignments", true], ["random-tokens", true], ["email", false], ["phone", false], ["id-card", false], ["bank-card", false],
    ]);
    for (const r of BUILTIN_RULES) expect(r.nameZh && r.descriptionZh && r.name && r.description && r.replacement.startsWith("[")).toBeTruthy();
  });

  test("api-keys: well-known formats", () => {
    for (const key of [FAKE.openai, FAKE.anthropic, FAKE.github, FAKE.githubPat, FAKE.awsId, FAKE.google, FAKE.slack, FAKE.stripe]) {
      expect(redact(`key ${key} here`)).toBe("key [密钥] here");
      expect(ruleIds(`key ${key} here`)).toEqual(["api-keys"]);
    }
    expect(redact("the sk-short prefix and ghp_ alone")).toBe("the sk-short prefix and ghp_ alone");
    expect(redact("desk-lamp-and-a-very-long-product-name")).toBe("desk-lamp-and-a-very-long-product-name");
  });

  test("api-keys: an AWS secret needs context and is never hex", () => {
    expect(redact(`${FAKE.awsId}\n${FAKE.awsSecret}`)).toBe("[密钥]\n[密钥]");
    expect(redact(`aws secret: ${FAKE.awsSecret}`)).not.toContain(FAKE.awsSecret);
    expect(ruleIds(`nothing about clouds ${FAKE.awsSecret.replace(/[/+]/g, "")}xy`)).not.toContain("api-keys");
  });

  test("private-keys: PEM and OpenSSH blocks, also cut off", () => {
    const block = "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKEFAKEFAKE\nfakefake\n-----END OPENSSH PRIVATE KEY-----";
    expect(redact(`key:\n${block}\nthanks`)).toBe("key:\n[私钥]\nthanks");
    expect(redact("-----BEGIN RSA PRIVATE KEY-----\nFAKE")).toBe("[私钥]");
    expect(redact("-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----")).toContain("PUBLIC KEY");
  });

  test("jwt", () => {
    expect(redact(`token ${FAKE.jwt}`)).toBe("token [令牌]");
    expect(ruleIds(`t ${FAKE.jwt}`)).toEqual(["jwt"]);
    expect(redact("eyJ is how JSON starts in base64")).toBe("eyJ is how JSON starts in base64");
  });

  test("bearer-tokens: header values; plain words are not tokens", () => {
    expect(redact("Authorization: Bearer abc.def-ghi_jkl123456")).toBe("Authorization: Bearer [令牌]");
    expect(redact("authorization: Basic ZmFrZTpmYWtlZmFrZQ==")).toBe("authorization: Basic [令牌]");
    expect(redact("curl -H 'Bearer FAKEfake0000FAKE'")).not.toContain("FAKEfake0000FAKE");
    expect(redact("Bearer tokens are great and Basic information matters")).toBe("Bearer tokens are great and Basic information matters");
  });

  test("connection-strings: only the password", () => {
    expect(redact("postgres://admin:fakepass123@db.example.com:5432/app")).toBe("postgres://admin:[密码]@db.example.com:5432/app");
    expect(redact("https://example.com/a/long-path/that-goes-on-and-on?x=1")).toBe("https://example.com/a/long-path/that-goes-on-and-on?x=1");
  });

  test("secret-assignments: the value only, the name stays", () => {
    expect(redact('db_password = "correct horse battery"')).toBe('db_password = "[密码]"');
    expect(redact("GITHUB_TOKEN=fake-value-123")).toBe("GITHUB_TOKEN=[令牌]");
    expect(redact("apiKey: fakevalue99")).toBe("apiKey: [密钥]");
    expect(redact("client_secret: 'fakesecret'")).toBe("client_secret: '[密钥]'");
    expect(redact("数据库密码：abc12345，谢谢")).toBe("数据库密码：[密码]，谢谢");
    expect(redact("WiFi 口令: fake8888")).toBe("WiFi 口令: [密码]");
    // A hash in a secret assignment is a secret; the same hash alone is not.
    expect(redact("secret=3f786850e387550fdab836ed7e6dc881de23001b")).toBe("secret=[密钥]");
    // Not assignments: a count, a placeholder, a comparison, a longer word.
    for (const t of ["max_tokens: 1024", "password: ********", "api_key=${API_KEY}", "if password == other", "secretary: Jane Doe", "passwords: many"]) expect(redact(t)).toBe(t);
  });

  test("random-tokens: random strings yes; SHAs, UUIDs, words, paths, links no", () => {
    expect(redact(`value ${FAKE.random} end`)).toBe("value [令牌] end");
    expect(redact("x Zm9vYmFyZmFrZWZha2VmYWtlZmFrZQ== y")).toBe("x [令牌] y");
    const negatives = [
      "commit 3f786850e387550fdab836ed7e6dc881de23001b fixed it",
      "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "id 123e4567-e89b-12d3-a456-426614174000 ok",
      "internationalization and counterrevolutionaries are ordinary words",
      "Hello-World-Program-2024 getElementByIdAndSomethingElse",
      "path /Users/someone/codes/github/pocket-paste/core/src",
      "https://example.com/assets/Zm9vYmFyZmFrZWZha2VmYWtl/image.png",
      "order 12345678901234567890",
    ];
    for (const t of negatives) expect(redact(t)).toBe(t);
  });

  test("email and phone are off by default, on when enabled", () => {
    const t = "mail alice.fake@example.com or call 13812345678 or +44 20 7946 0958";
    expect(redact(t)).toBe(t);
    expect(redact(t, everything)).toBe("mail [邮箱] or call [手机号] or [手机号]");
    expect(redact("138-1234-5678", everything)).toBe("[手机号]");
    expect(redact("version 1.2.3 and 2024-09-23", everything)).toBe("version 1.2.3 and 2024-09-23");
  });

  test("ID card checksum and bank card Luhn", () => {
    expect(idCardValid("11010519491231002X")).toBe(true);
    expect(idCardValid("110105194912310021")).toBe(false);
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(redact("身份证 11010519491231002X", everything)).toBe("身份证 [身份证号]");
    expect(redact("身份证 110105194912310021", everything)).toBe("身份证 110105194912310021");
    expect(redact("卡号 4111 1111 1111 1111", everything)).toBe("卡号 [银行卡号]");
    expect(redact("卡号 4111 1111 1111 1112", everything)).toBe("卡号 4111 1111 1111 1112");
    expect(redact("身份证 11010519491231002X")).toBe("身份证 11010519491231002X"); // off by default
  });

  test("containsSecret counts secrets, not personal data", () => {
    expect(containsSecret(`k ${FAKE.openai}`, defaults)).toBe(true);
    expect(containsSecret("mail alice.fake@example.com 13812345678", everything)).toBe(false);
    expect(containsSecret(`k ${FAKE.openai}`, compilePrivacy({ ...DEFAULT_PRIVACY, builtins: { "api-keys": false, "random-tokens": false } }))).toBe(false);
  });

  test("the Studio's ordinary scenarios trigger nothing", () => {
    for (const s of SCENARIOS.filter((x) => x.group !== "隐私")) expect({ id: s.id, spans: redactForModel(s.text, defaults).spans }).toEqual({ id: s.id, spans: [] });
  });
});

describe("modes and structure", () => {
  test("structureOnly keeps shape, whitespace, punctuation and length", () => {
    expect(structureOnly("Hello, 世界 42!\n- ok")).toBe("Xxxxx, 字字 00!\n- xx");
    expect([...structureOnly("项目 ABC")].length).toBe([..."项目 ABC"].length);
  });

  test("structure mode keeps typed placeholders readable", () => {
    expect(modelText("项目 ABC 的密码: hunter22, 见 123", defaults, "structure").text).toBe("字字 XXX 字字字: [密码], 字 000");
    expect(modelText(`k ${FAKE.openai}`, defaults, "raw").text).toBe(`k ${FAKE.openai}`);
  });
});

const rule = (over: Partial<PrivacyConfig["rules"][number]> & { pattern: string }) => ({ id: over.id ?? "r1", name: over.name ?? "rule", match: "text" as const, replacement: "[代号]", ...over });
const withRules = (rules: unknown[], extra: Record<string, unknown> = {}) => compilePrivacy(parsePrivacyConfig({ rules, ...extra }));

describe("user rules", () => {
  test("text, case-insensitive by default, case-sensitive when asked", () => {
    expect(redact("Project Aurora and project aurora", withRules([rule({ pattern: "project aurora" })]))).toBe("[代号] and [代号]");
    expect(redact("Project Aurora and project aurora", withRules([rule({ pattern: "project aurora", caseSensitive: true })]))).toBe("Project Aurora and [代号]");
  });

  test("keywords: one per line, blank lines ignored, the longer keyword wins", () => {
    const p = withRules([rule({ match: "keywords", pattern: "北极星\n\n  北极星计划 \nAcme", replacement: "某项目" })]);
    expect(redact("北极星计划由 ACME 负责，北极星上线", p)).toBe("某项目由 某项目 负责，某项目上线");
  });

  test("wholeWord: Unicode-aware in Chinese and English", () => {
    const zh = withRules([rule({ pattern: "中国", wholeWord: true, replacement: "某国" })]);
    expect(redact("我在中国。", zh)).toBe("我在某国。");
    expect(redact("我爱中国人", zh)).toBe("我爱中国人");
    const en = withRules([rule({ pattern: "cat", wholeWord: true, replacement: "pet" })]);
    expect(redact("cat, concatenate, the cat's toy", en)).toBe("pet, concatenate, the pet's toy");
    expect(redact("concatenate", withRules([rule({ pattern: "cat", replacement: "pet" })]))).toBe("conpetenate");
  });

  test("regex rules, and a user rule wins a tie with a built-in", () => {
    const p = withRules([rule({ match: "regex", pattern: String.raw`INV-\d{4}`, replacement: "[单号]" })]);
    expect(redact("发票 INV-2024 和 inv-0001", p)).toBe("发票 [单号] 和 [单号]");
    const tie = withRules([rule({ match: "regex", pattern: "sk-proj-\\w+", replacement: "[OpenAI]" })]);
    expect(redact(`k ${FAKE.openai}`, tie)).toBe("k [OpenAI]");
  });

  test("overlaps: the earliest start wins, then the longest", () => {
    const p = withRules([rule({ id: "a", pattern: "alpha beta", replacement: "[AB]" }), rule({ id: "b", pattern: "beta gamma delta", replacement: "[BGD]" }), rule({ id: "c", pattern: "alpha", replacement: "[A]" })]);
    expect(redact("alpha beta gamma delta", p)).toBe("[AB] gamma delta");
  });

  test("invalid rules are usage errors naming the rule", () => {
    const bad = (rules: unknown[]) => { try { parsePrivacyConfig({ rules }); } catch (e) { return e; } return null; };
    const e1 = bad([rule({ name: "发票号", match: "regex", pattern: "INV-(\\d+" })]);
    expect(e1).toBeInstanceOf(PrivacyConfigError);
    expect((e1 as Error).message).toContain("发票号");
    expect((bad([rule({ name: "slow", match: "regex", pattern: "(a+)+b" })]) as Error).message).toContain("slow");
    expect((bad([rule({ name: "long", pattern: "x".repeat(501) })]) as Error).message).toContain("500");
    expect((bad([rule({ name: "rep", pattern: "x", replacement: "y".repeat(101) })]) as Error).message).toContain("100");
    expect(bad(Array.from({ length: 101 }, (_, i) => rule({ id: `r${i}`, pattern: "x" })))).toBeInstanceOf(PrivacyConfigError);
    expect(bad([rule({ id: "same", pattern: "x" }), rule({ id: "same", pattern: "y" })])).toBeInstanceOf(PrivacyConfigError);
    expect(() => parsePrivacyConfig({ modelContent: "everything" })).toThrow(PrivacyConfigError);
    expect(() => parsePrivacyConfig({ builtins: { nope: true } })).toThrow(PrivacyConfigError);
    expect(hasNestedQuantifier("(\\w+)*")).toBe(true);
    expect(hasNestedQuantifier("(ab)+[x+]*\\d+")).toBe(false);
  });

  test("disabled rules do nothing; alsoInOutput rules change the rendered text", () => {
    const p = withRules([
      rule({ id: "a", pattern: "Aurora", replacement: "某项目", alsoInOutput: true }),
      rule({ id: "b", pattern: "Zhang", replacement: "某人" }),
      rule({ id: "c", pattern: "Mars", replacement: "X", enabled: false }),
    ]);
    const t = "Aurora by Zhang on Mars";
    expect(redact(t, p)).toBe("某项目 by 某人 on Mars");
    expect(applyOutputRules(t, p)).toBe("某项目 by Zhang on Mars");
    expect(applyOutputRules(t, defaults)).toBe(t);
  });
});

/** A network decider that records what it was sent. */
function recorder(answers: unknown = null) {
  const bodies: JevRequest[] = [];
  return { bodies, decider: { name: "stub", async ask(body: JevRequest) { bodies.push(structuredClone(body)); return answers as never; } } };
}

describe("what the model receives", () => {
  const text = `部署说明：OPENAI_API_KEY=${FAKE.openai}\n密码: hunter2fake\n联系 alice.fake@example.com`;

  test("redacted mode: no secret in the body; keys, instructions and names unchanged", async () => {
    const r = recorder();
    const d = privateDecider(r.decider, defaults);
    const body: JevRequest = { state: { clipboard: text }, questions: { q: { type: "choice", instructions: "Pick one", criteria: { keep: `the word "${FAKE.openai}"`, other: "hunter2fake" } } } };
    await d.ask(body);
    const sent = JSON.stringify(r.bodies[0]);
    for (const secret of [FAKE.openai, "hunter2fake"]) expect(sent).not.toContain(secret);
    expect(r.bodies[0]!.state.clipboard).toBe("部署说明：OPENAI_API_KEY=[密钥]\n密码: [密码]\n联系 alice.fake@example.com");
    expect(Object.keys((r.bodies[0]!.questions.q as { criteria: object }).criteria)).toEqual(["keep", "other"]);
    expect((r.bodies[0]!.questions.q as { instructions: string }).instructions).toBe("Pick one");
    expect(body.state.clipboard).toBe(text); // the caller's body is not mutated
  });

  test("structure mode: shape only, placeholders kept, content-derived descriptions structured", async () => {
    const r = recorder();
    const p = compilePrivacy({ ...DEFAULT_PRIVACY, modelContent: "structure" });
    await privateDecider(r.decider, p).ask({ state: { clipboard: "Meet Alice at 5pm", nested: [{ s: "Hi Bob" }] } as never, questions: { q: { type: "choice", criteria: { w0: "Alice", none: "no accent" } } } });
    const body = r.bodies[0]!;
    expect(body.state.clipboard).toBe("Xxxx Xxxxx xx 0xx");
    expect((body.state as unknown as { nested: { s: string }[] }).nested[0]!.s).toBe("Xx Xxx");
    expect((body.questions.q as { criteria: Record<string, string> }).criteria).toEqual({ w0: "Xxxxx", none: "no accent" });
  });

  test("raw mode sends the text as it is; local deciders are never wrapped", async () => {
    const r = recorder();
    await privateDecider(r.decider, compilePrivacy({ ...DEFAULT_PRIVACY, modelContent: "raw" })).ask({ state: { clipboard: text }, questions: {} });
    expect(r.bodies[0]!.state.clipboard).toBe(text);
    const local = recorder();
    for (const kind of ["rules", "none", "laya"]) expect(deciderForModel(local.decider, kind, defaults)).toBe(local.decider);
    for (const kind of ["cloudflare", "proxy", "hosted", "endpoint"]) expect(deciderForModel(local.decider, kind, defaults)).not.toBe(local.decider);
  });

  test("a word cut out of a secret by the segmenter becomes the placeholder", () => {
    const out = rewriteForModel({ state: { clipboard: `key ${FAKE.random}` }, questions: { e: { type: "choice", criteria: { w1: FAKE.random.slice(0, 6) } } } }, defaults);
    expect((out.questions.e as { criteria: Record<string, string> }).criteria.w1).toBe("[令牌]");
  });

  test("template decisions: emphasis never offers a redacted word; structure mode asks no emphasis", async () => {
    const short = "今天的口令: bluefakeword 记得保密";
    const redacted = recorder();
    await decideTemplate(short, { output: "image", decider: privateDecider(redacted.decider, defaults) });
    const sent = redacted.bodies[0]!;
    expect(JSON.stringify(sent)).not.toContain("bluefakeword");
    const emphasis = sent.questions.emphasis as { criteria: Record<string, string> } | undefined;
    expect(emphasis).toBeDefined();
    expect(Object.keys(emphasis!.criteria)).not.toContain("bluefakeword");

    const raw = recorder();
    await decideTemplate(short, { output: "image", decider: raw.decider });
    expect(Object.keys((raw.bodies[0]!.questions.emphasis as { criteria: object }).criteria)).toContain("bluefakeword");

    const structure = recorder();
    await decideTemplate(short, { output: "image", decider: privateDecider(structure.decider, compilePrivacy({ ...DEFAULT_PRIVACY, modelContent: "structure" })) });
    expect(structure.bodies[0]!.questions.emphasis).toBeUndefined();
    expect(structure.bodies[0]!.state.clipboard).toBe("字字字字字: [密码] 字字字字");
  });

  test("an answer naming a redacted word is not used as emphasis", async () => {
    const r = recorder({ template: { choice: "text", probabilities: { text: 0.9 } }, emphasis: { choice: "bluefakeword", probabilities: { bluefakeword: 0.99 } } });
    const d = await decideTemplate("今天的口令: bluefakeword 记得保密", { output: "image", decider: privateDecider(r.decider, defaults) });
    expect(d.plan.emphasis).toBeUndefined();
  });

  test("smart paste: candidates are redacted before summaries cut them", async () => {
    const r = recorder();
    const long = `${"x ".repeat(30)}token=${FAKE.random}${FAKE.random}${FAKE.random}`;
    await pick({ level: 2, appBundleId: "app", before: `pwd: fakepass1 ${FAKE.jwt}` }, [{ id: "a", kind: "text", text: long, preview: long, createdAt: Date.now() }], privateDecider(r.decider, defaults));
    const sent = JSON.stringify(r.bodies[0]);
    expect(sent).not.toContain(FAKE.random.slice(0, 12));
    expect(sent).not.toContain("fakepass1");
    expect(sent).not.toContain(FAKE.jwt.slice(0, 20));
  });
});

describe("daemon: privacy commands and config", () => {
  const host = async (sent: JevRequest[]): Promise<DaemonHost> => ({
    version: "test", appData: await mkdtemp(join(tmpdir(), "paste-privacy-")), engine: null, coreVersion: "t",
    async resolveProviders(cfg) {
      const kind = (cfg.decider as { kind?: string } | undefined)?.kind ?? "none";
      const decider = kind === "none" ? null : { name: kind, async ask(body: JevRequest) { sent.push(structuredClone(body)); return null; } };
      return { decider: decider as never, generator: null, names: { decider: kind, generator: "none", offline: false } };
    },
  });

  test("privacy.rules lists the built-ins with their state", async () => {
    const d = new Daemon(await host([])); await d.init();
    await d.handle({ id: 1, cmd: "config.set", privacy: { modelContent: "redacted", builtins: { email: true, "random-tokens": false } } });
    const r = await d.handle({ id: 2, cmd: "privacy.rules" });
    if (!r.ok || r.cmd !== "privacy.rules") throw new Error("no rules");
    const byId = Object.fromEntries(r.builtins.map((b) => [b.id, b]));
    expect(byId.email).toMatchObject({ defaultEnabled: false, enabled: true, nameZh: "邮箱地址" });
    expect(byId["random-tokens"]).toMatchObject({ defaultEnabled: true, enabled: false });
    expect(byId["api-keys"]).toMatchObject({ enabled: true });
  });

  test("privacy.preview shows model text, output text, spans", async () => {
    const d = new Daemon(await host([])); await d.init();
    await d.handle({ id: 1, cmd: "config.set", privacy: { rules: [{ id: "p", name: "项目", match: "text", pattern: "Aurora", replacement: "某项目", alsoInOutput: true }] } });
    const text = `Aurora key ${FAKE.openai}`;
    const r = await d.handle({ id: 2, cmd: "privacy.preview", text });
    expect(r).toMatchObject({ ok: true, cmd: "privacy.preview", modelText: "某项目 key [密钥]", outputText: `某项目 key ${FAKE.openai}`, containsSecret: true });
    if (!r.ok || r.cmd !== "privacy.preview") throw new Error("no preview");
    expect(r.spans).toEqual([{ start: 0, end: 6, ruleId: "p", replacement: "某项目" }, { start: 11, end: 11 + FAKE.openai.length, ruleId: "api-keys", replacement: "[密钥]" }]);
    await d.handle({ id: 3, cmd: "config.set", privacy: { modelContent: "structure" } });
    expect(await d.handle({ id: 4, cmd: "privacy.preview", text: "Hi 42" })).toMatchObject({ modelText: "Xx 00", outputText: "Hi 42", spans: [], containsSecret: false });
    expect(await d.handle({ id: 5, cmd: "privacy.preview" } as never)).toMatchObject({ ok: false, kind: "usage" });
  });

  test("config.set rejects a bad rule by name and keeps the previous config", async () => {
    const d = new Daemon(await host([])); await d.init();
    await d.handle({ id: 1, cmd: "config.set", privacy: { modelContent: "structure" } });
    const bad = await d.handle({ id: 2, cmd: "config.set", privacy: { rules: [{ id: "x", name: "坏规则", match: "regex", pattern: "([", replacement: "" }] } });
    expect(bad).toMatchObject({ ok: false, kind: "usage" });
    expect(!bad.ok && bad.message).toContain("坏规则");
    expect(await d.handle({ id: 3, cmd: "privacy.preview", text: "Hi" })).toMatchObject({ modelText: "Xx" });
    expect(await d.handle({ id: 4, cmd: "config.set", precompose: { outputs: ["png"] } } as never)).toMatchObject({ ok: false, kind: "usage" });
  });

  test("network deciders get redacted text, local ones the original", async () => {
    const sent: JevRequest[] = [];
    const d = new Daemon(await host(sent)); await d.init();
    const context = { level: 0 as const, appBundleId: "app" };
    const candidates = [{ id: "a", kind: "text" as const, text: `key ${FAKE.openai}`, preview: `key ${FAKE.openai}`, createdAt: Date.now() }];
    await d.handle({ id: 1, cmd: "config.set", decider: { kind: "cloudflare" } });
    await d.handle({ id: 2, cmd: "pick", context, candidates });
    expect(JSON.stringify(sent.pop())).not.toContain(FAKE.openai);
    await d.handle({ id: 3, cmd: "config.set", decider: { kind: "laya" } });
    await d.handle({ id: 4, cmd: "pick", context, candidates });
    expect(JSON.stringify(sent.pop())).toContain(FAKE.openai);
  });
});

test("a secret assignment never reaches across a line break", async () => {
  const { compilePrivacy, previewPrivacy } = await import("../src/privacy/rules.ts");
  const text = "部署前记得换掉测试密钥：\nOPENAI_API_KEY=sk-proj-FAKEfake1234567890abcdefGHIJKLmnopqrstuv";
  expect(previewPrivacy(text, compilePrivacy(), "redacted").modelText).toBe("部署前记得换掉测试密钥：\nOPENAI_API_KEY=[密钥]");
});

