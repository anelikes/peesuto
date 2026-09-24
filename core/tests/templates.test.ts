import { describe, expect, test } from "bun:test";
import { buildTemplateRequest, decideTemplate } from "../src/templates/decide.ts";
import { parseTemplates, templateIdList, withoutTemplates } from "../src/templates/parse.ts";
import { renderKeyParts } from "../src/daemon/precompose.ts";
import { layoutTemplate, wrapTemplateText, type TemplateMeasure } from "../src/templates/compose.ts";
import { TEMPLATE_REGISTRY } from "../src/templates/registry.ts";
import { MOTIONS, TEMPLATE_IDS, TemplateInputError } from "../src/templates/types.ts";
import { ProviderError } from "../src/provider/types.ts";

const base = { aspect: "chat" as const, output: "gif" as const, decider: null };
const choice = (value: string, confidence = 0.9) => ({ choice: value, probabilities: { [value]: confidence } });
const decider = (answers: unknown) => ({ name: "fixture", ask: async () => answers });

describe("template registry", () => {
  test("each template exposes at least two distinct styles and motion choices; only text has poster", () => {
    expect(TEMPLATE_REGISTRY.map((template) => template.id)).toEqual([...TEMPLATE_IDS]);
    for (const entry of TEMPLATE_REGISTRY) {
      expect(entry.variants.length).toBeGreaterThanOrEqual(2);
      expect(new Set(entry.variants.map((variant) => variant.id)).size).toBe(entry.variants.length);
      expect(entry.motions.every((m) => MOTIONS.includes(m))).toBe(true);
      expect(entry.motions).toContain("none");
      if (entry.id !== "qr") expect(entry.motions).toEqual([...MOTIONS]);
      expect(entry.nameZh.length).toBeGreaterThan(0);
      expect(entry.variants.some((variant) => variant.id === "poster")).toBe(entry.id === "text");
    }
  });
});

describe("source-backed content parsing", () => {
  const fixtures = [
    ["text", "Ordinary prose.\nStill the same paragraph.\n\nA new paragraph."],
    ["document", "# Notes\n\nOrdinary prose.\n\nA new paragraph."],
    ["quote", "“Simplicity is a choice.” — Ada"],
    ["code", "```typescript\nconst greeting = 'hello';\n  console.log(greeting);\n```"],
    ["stat", "Conversion rate: 42.5%"],
    ["list", "1. First item\n2. Second item"],
    ["chat", "Alice: Hello.\nBob: Hi!\nAlice: Good to see you."],
    ["table", "| Name | Score |\n| --- | ---: |\n| Ada | 42 |\n| Bob | 37 |"],
    ["comparison", "Before:\n- Two windows\n- Extra clicks\n\nAfter:\n- One window\n- Direct action"],
  ] as const;
  for (const [kind, source] of fixtures) {
    test(`recognizes ${kind} and retains original source`, () => {
      const parsed = parseTemplates(source);
      expect(parsed.sourceText).toBe(source);
      expect(parsed.preferred).toBe(kind);
      expect(parsed.candidates.get(kind)?.kind).toBe(kind);
      expect(parsed.candidates.has("document")).toBe(true);
    });
  }
  test("preserves source line endings and indentation; code content is not rewritten", () => {
    const source = "```swift\r\n  let x = 1\r\n    print(x)\r\n```\r\n";
    expect(parseTemplates(source).sourceText).toBe(source);
    expect(parseTemplates(source).candidates.get("code")).toEqual({ kind: "code", language: "swift", code: "  let x = 1\n    print(x)" });
  });
  test("quote attribution is optional and never manufactured", () => {
    expect(parseTemplates("“A thought without attribution.”").candidates.get("quote"))
      .toEqual({ kind: "quote", text: "A thought without attribution." });
    expect(parseTemplates("> First line\n> Second line\n— A real source").candidates.get("quote"))
      .toEqual({ kind: "quote", text: "First line\nSecond line", author: "A real source" });
    expect(parseTemplates("“正文。”——作者").candidates.get("quote"))
      .toEqual({ kind: "quote", text: "正文。", author: "作者" });
    expect(parseTemplates('“Mismatched quotation"').preferred).toBe("text");
  });
  test("raw commands and code preserve their complete source", () => {
    for (const source of ["const x = 42;\nconsole.log(x);", "git status --short", "curl https://example.com", '{ "key": "value" }']) {
      expect(parseTemplates(source).candidates.get("code")).toEqual({ kind: "code", code: source });
    }
  });
  test("raw code retains boundary whitespace and relative indentation", () => {
    const source = "\r\n    def nested():\r\n        return 1\r\n";
    const parsed = parseTemplates(source);
    expect(parsed.sourceText).toBe(source);
    expect(parsed.candidates.get("code")).toEqual({ kind: "code", code: "\n    def nested():\n        return 1\n" });
    const document = parsed.candidates.get("document");
    expect(document?.kind === "document" ? document.blocks : []).toEqual([
      { kind: "paragraph", text: "    def nested():\n        return 1" },
    ]);
  });
  test("nested lists keep the entire indented group in the document fallback", () => {
    const source = "  - Parent\n    - First child\n    - Second child";
    const parsed = parseTemplates(source);
    expect(parsed.preferred).toBe("document");
    expect(parsed.candidates.get("document")).toEqual({ kind: "document", paragraphs: [source], blocks: [{ kind: "paragraph", text: source }] });
  });
  test("TSV trailing empty cells survive boundary parsing", () => {
    expect(parseTemplates("Name\tScore\nAda\t\n").candidates.get("table"))
      .toEqual({ kind: "table", headers: ["Name", "Score"], rows: [["Ada", ""]] });
  });
  test("mixed Markdown retains headings, paragraphs, lists and fenced code as separate blocks", () => {
    const source = "# A title\n\nA paragraph with **original inline markers**.\n\n- One\n- Two\n\n```js\n  const value = 1;\n```\n\n## Final thought\nNothing omitted.";
    const content = parseTemplates(source).candidates.get("document");
    expect(parseTemplates(source).preferred).toBe("document");
    expect(content?.kind === "document" ? content.blocks : []).toEqual([
      { kind: "heading", level: 1, text: "A title" },
      { kind: "paragraph", text: "A paragraph with **original inline markers**." },
      { kind: "list", ordered: false, items: ["One", "Two"] },
      { kind: "code", language: "js", code: "  const value = 1;" },
      { kind: "heading", level: 2, text: "Final thought" },
      { kind: "paragraph", text: "Nothing omitted." },
    ]);
  });
  test("multiple fenced blocks do not collapse into one code template", () => {
    const parsed = parseTemplates("```js\nconst a = 1;\n```\n\n```js\nconst b = 2;\n```");
    expect(parsed.preferred).toBe("document");
    const content = parsed.candidates.get("document");
    expect(content?.kind === "document" ? content.blocks?.length : 0).toBe(2);
  });
  test("explicit speaker labels preserve turns without inventing names", () => {
    expect(parseTemplates("[林]: 你好\n[陈]: 下午见").candidates.get("chat"))
      .toEqual({ kind: "chat", turns: [{ speaker: "林", text: "你好" }, { speaker: "陈", text: "下午见" }] });
  });
  test("escaped table pipes and empty body cells retain their content", () => {
    expect(parseTemplates("| Value | Note |\n| --- | --- |\n| A\\|B | | ").candidates.get("table"))
      .toEqual({ kind: "table", headers: ["Value", "Note"], rows: [["A|B", ""]] });
  });
  test("tab-separated columns require a rectangular table", () => {
    expect(parseTemplates("Name\tScore\nAda\t42").preferred).toBe("table");
    expect(parseTemplates("Name\tScore\nAda\t42\textra").preferred).toBe("document");
    expect(parseTemplates("Name\tScore\nAda\t42\textra").candidates.has("text")).toBe(false);
  });
  const ambiguous = [
    "Someone said this sentence yesterday.", "Name: Ada\nAge: 32\nName: Bob", "Hello: world\nAnother: field",
    "A: A single speaker line", "Before:\nOnly one side", "Left column\nRight column",
    "Title A:\nSomething\nTitle B:\nSomething else", "| A | B |\n| x | y |", "| A | B |\n| --- | --- |\n| x |",
    "- parent\n  - child", "3. Third\n7. Seventh", "1. First\n- Second", "```js\nunterminated",
  ];
  // Ambiguous input never becomes a specialized structure. Short plain prose is
  // typography (text); anything layout-bearing stays a document.
  const plainProse = new Set(["Someone said this sentence yesterday.", "A: A single speaker line", "Left column\nRight column"]);
  for (const source of ambiguous) test(`keeps ambiguous input unstructured: ${source.split("\n")[0]}`, () => {
    expect(parseTemplates(source).preferred).toBe(plainProse.has(source) ? "text" : "document");
  });
  test("text: short plain prose only, source paragraphs kept verbatim", () => {
    expect(parseTemplates("把复杂的想法，讲得简单。\n\n先记录，再整理。 \n").candidates.get("text"))
      .toEqual({ kind: "text", paragraphs: ["把复杂的想法，讲得简单。", "先记录，再整理。"] });
    expect(parseTemplates("x".repeat(281)).candidates.has("text")).toBe(false);
    expect(parseTemplates("x".repeat(280)).preferred).toBe("text");
    for (const source of ["# Title\n\nBody", "A **bold** claim", "Line one\n  indented", "- a\n- b", "```js\nx\n```", "a | b"]) {
      expect(parseTemplates(source).candidates.has("text")).toBe(false);
    }
    // A quote or a statistic wins but keeps text as an alternative.
    const quote = parseTemplates("“Simplicity is a choice.” — Ada");
    expect(quote.preferred).toBe("quote");
    expect(quote.candidates.has("text")).toBe(true);
  });
  test("rejects empty input", () => { expect(() => parseTemplates(" \n ")).toThrow(TemplateInputError); });
});

describe("constrained template decisions", () => {
  test("local rules and none providers never invoke ask", async () => {
    for (const name of ["rules", "none"]) {
      let called = false;
      const result = await decideTemplate("- one\n- two", { ...base, decider: { name, ask: async () => { called = true; throw new Error("must not call"); } } });
      expect(called).toBe(false);
      expect(result.plan.template).toBe("list");
      expect(result.decisionSource).toBe("rules");
    }
  });
  test("Jev sees only source-compatible templates and registered style ids", () => {
    const request = buildTemplateRequest(parseTemplates("Alice: Hello\nBob: Hi"), true);
    const questions = request.questions as Record<string, { criteria: Record<string, string> }>;
    expect(Object.keys(questions.template!.criteria)).toEqual(["document", "chat"]);
    expect(Object.keys(questions.variant!.criteria)).toEqual(["document.classic", "document.editorial", "chat.classic", "chat.editorial"]);
    expect(Object.keys((buildTemplateRequest(parseTemplates("Text"), false).questions.motion as { criteria: object }).criteria)).toEqual(["none"]);
  });
  test("confident valid decisions select presentation while content comes only from source", async () => {
    const source = "Alice: Hello\nBob: Hi";
    const result = await decideTemplate(source, { ...base, decider: decider({
      template: choice("chat"), variant: choice("chat.editorial"), motion: choice("typewriter"),
      content: { turns: [{ speaker: "invented", text: "forged" }] },
    }) });
    expect(result.plan).toMatchObject({ version: 1, template: "chat", variant: "editorial", motion: "typewriter", sourceText: source });
    expect(result.plan.content).toEqual(parseTemplates(source).candidates.get("chat")!);
    expect(result.decisionSource).toBe("jev");
  });
  test("a model cannot select a template absent from the parsed source", async () => {
    const result = await decideTemplate("No named speakers here.", { ...base, decider: decider({ template: choice("chat"), variant: choice("chat.editorial"), motion: choice("typewriter") }) });
    expect(result.plan.template).toBe("text");
    expect(result.decisionSource).toBe("fallback");
  });
  for (const answer of [null, {}, { template: { choice: "quote" } }, { template: choice("quote", 0.2) }, { template: choice("quote", 3) }, { template: choice("quote", NaN) }]) {
    test(`malformed/low-confidence answers safely retain local structure: ${JSON.stringify(answer)}`, async () => {
      const result = await decideTemplate("“A quote.”", { ...base, decider: decider(answer) });
      expect(result.plan.template).toBe("quote");
      expect(result.plan.variant).toBe("classic");
      expect(result.decisionSource).toBe("fallback");
    });
  }
  test("provider failures fall back locally without losing text", async () => {
    const result = await decideTemplate("Revenue: $42", { ...base, decider: { name: "offline", ask: async () => { throw new Error("offline"); } } });
    expect(result.plan.content).toEqual({ kind: "stat", label: "Revenue", value: "$42" });
    expect(result.decisionSource).toBe("fallback");
  });
  test("a cross-template style is ignored", async () => {
    const result = await decideTemplate("“A quote.”", { ...base, decider: decider({ template: choice("quote"), variant: choice("chat.editorial"), motion: choice("unsupported") }) });
    expect(result.plan.variant).toBe("classic");
    expect(result.plan.motion).toBe("reveal");
  });
  test("saved style overrides model style, explicit style overrides saved style", async () => {
    const result = await decideTemplate("“A quote.”", { ...base, preferences: { quote: "editorial" }, decider: decider({ template: choice("quote"), variant: choice("quote.classic") }) });
    expect(result.plan.variant).toBe("editorial");
    const explicit = await decideTemplate("“A quote.”", { ...base, preferences: { quote: "editorial" }, override: { id: "quote", variant: "classic" } });
    expect(explicit.plan.variant).toBe("classic");
    expect(explicit.decisionSource).toBe("override");
    expect((await decideTemplate("“A quote.”", { ...base, preferences: { quote: "invalid" } })).plan.variant).toBe("classic");
  });
  test("manual style rerenders do not call the provider", async () => {
    let called = false;
    const result = await decideTemplate("“A quote.”", { ...base, override: { id: "quote", variant: "editorial", motion: "typewriter" }, decider: { name: "remote", ask: async () => { called = true; return null; } } });
    expect(called).toBe(false);
    expect(result.plan.motion).toBe("typewriter");
  });
  test("incompatible or unknown manual overrides fail explicitly", async () => {
    await expect(decideTemplate("Ordinary paragraph.", { ...base, override: { id: "chat" } })).rejects.toThrow("explicit structure");
    await expect(decideTemplate("text", { ...base, override: { variant: "unknown" as never } })).rejects.toThrow("Unknown template style");
    await expect(decideTemplate("text", { ...base, override: { motion: "unknown" as never } })).rejects.toThrow("Unknown template motion");
  });
  test("PNG always has motion none, including explicit motion overrides", async () => {
    const result = await decideTemplate("Text", { ...base, output: "image", override: { motion: "typewriter" } });
    expect(result.plan.motion).toBe("none");
  });
  test("GIF/MP4 cannot be made static by an override or a model answer", async () => {
    for (const output of ["gif", "video"] as const) {
      expect((await decideTemplate("Text", { ...base, output, override: { motion: "none" } })).plan.motion).toBe("reveal");
      expect((await decideTemplate("Text", { ...base, output, animate: "always", override: { motion: "none" } })).plan.motion).toBe("reveal");
      expect((await decideTemplate("Text", { ...base, output, override: { motion: "typewriter" } })).plan.motion).toBe("typewriter");
      const answered = await decideTemplate("“A quote.”", { ...base, output, decider: decider({ template: choice("quote"), motion: choice("none") }) });
      expect(answered.decisionSource).toBe("jev");
      expect(answered.plan.motion).toBe("reveal");
    }
    const request = buildTemplateRequest(parseTemplates("Text"), true, true);
    expect(Object.keys((request.questions.motion as { criteria: object }).criteria)).toEqual(["reveal", "typewriter"]);
  });
  test("an explicitly static animation action keeps motion none", async () => {
    const result = await decideTemplate("Text", { ...base, output: "gif", animate: "never", override: { motion: "typewriter" } });
    expect(result.plan.motion).toBe("none");
  });
  test("over-long input is refused before the decider or any render work", async () => {
    let called = false;
    const ask = async () => { called = true; return null; };
    const long = "字".repeat(2401);
    await expect(decideTemplate(long, { ...base, decider: { name: "remote", ask } })).rejects.toThrow(TemplateInputError);
    await expect(decideTemplate(long, { ...base, decider: { name: "remote", ask } })).rejects.toThrow("2400");
    expect(called).toBe(false);
    expect(() => parseTemplates("x".repeat(1_000_000))).toThrow(TemplateInputError);
    // Whitespace does not count toward the visible limit.
    expect(parseTemplates(`${"a ".repeat(2400)}`).sourceText.length).toBe(4800);
    await decideTemplate("字".repeat(2400), { ...base, decider: { name: "remote", ask } });
    expect(called).toBe(true);
  });
  test("a failed decider still renders with the fallback and reports why", async () => {
    for (const code of ["auth", "quota", "offline", "timeout"] as const) {
      const result = await decideTemplate("Revenue: $42", { ...base, decider: { name: "remote", ask: async () => { throw new ProviderError(code, `${code} failed`); } } });
      expect(result.decisionSource).toBe("fallback");
      expect(result.plan.template).toBe("stat");
      expect(result.decisionError).toEqual({ kind: `provider:${code}`, message: `${code} failed` });
    }
    const other = await decideTemplate("Text", { ...base, decider: { name: "remote", ask: async () => { throw new TypeError("boom"); } } });
    expect(other.decisionError).toEqual({ kind: "error", message: "boom" });
    const ok = await decideTemplate("“A quote.”", { ...base, decider: decider({ template: choice("quote") }) });
    expect("decisionError" in ok).toBe(false);
    const lowConfidence = await decideTemplate("“A quote.”", { ...base, decider: decider(null) });
    expect(lowConfidence.decisionSource).toBe("fallback");
    expect("decisionError" in lowConfidence).toBe(false);
  });
  test("text: poster is a text style only; a Jev accent must be a source word", async () => {
    const poster = await decideTemplate("把复杂留给自己，把简单留给别人。", { ...base, override: { variant: "poster" } });
    expect(poster.plan).toMatchObject({ template: "text", variant: "poster" });
    await expect(decideTemplate("“Simplicity is a choice.” — Ada", { ...base, override: { variant: "poster" } })).rejects.toThrow(TemplateInputError);
    const source = "Good design leaves the complexity to itself.";
    const accented = await decideTemplate(source, { ...base, decider: decider({ template: choice("text"), emphasis: choice("complexity") }) });
    expect(accented.plan.emphasis).toBe("complexity");
    const invented = await decideTemplate(source, { ...base, decider: decider({ template: choice("text"), emphasis: choice("simplicity") }) });
    expect(invented.plan.emphasis).toBeUndefined();
    const none = await decideTemplate(source, { ...base, decider: decider({ template: choice("text"), emphasis: choice("none") }) });
    expect(none.plan.emphasis).toBeUndefined();
    // A saved poster preference for another template is ignored rather than failing.
    const saved = await decideTemplate("“Simplicity is a choice.” — Ada", { ...base, preferences: { quote: "poster" } });
    expect(saved.plan).toMatchObject({ template: "quote", variant: "classic" });
  });
  test("text: the emphasis question offers only words from the source", () => {
    const request = buildTemplateRequest(parseTemplates("把复杂的想法，讲得简单。Keep it simple."), true);
    const criteria = Object.keys((request.questions.emphasis as { criteria: Record<string, string> }).criteria);
    expect(criteria[0]).toBe("none");
    for (const word of criteria.slice(1)) expect("把复杂的想法，讲得简单。Keep it simple.".includes(word)).toBe(true);
    expect(buildTemplateRequest(parseTemplates("| A | B |\n| --- | --- |\n| 1 | 2 |"), true).questions.emphasis).toBeUndefined();
  });
  test("chat-app copies (speaker, time, message) become a conversation with times kept verbatim", () => {
    const wechat = "nok\n2026年09月22日 22:10\n如果ty不去武汉的话我整一个看看\n\nshybee\n2026年09月23日  0:10\n@nok \n\nshybee\n2026年09月23日  0:11\n明天吃这个不";
    const parsed = parseTemplates(wechat);
    expect(parsed.preferred).toBe("chat");
    expect(parsed.candidates.get("chat")).toEqual({ kind: "chat", turns: [
      { speaker: "nok", time: "2026年09月22日 22:10", text: "如果ty不去武汉的话我整一个看看" },
      { speaker: "shybee", time: "2026年09月23日  0:10", text: "@nok" },
      { speaker: "shybee", time: "2026年09月23日  0:11", text: "明天吃这个不" },
    ] });
    // Name and time on one line, no blank lines between messages.
    expect(parseTemplates("Alice 10:21 AM\nHi there\nsecond line\nBob 10:22 AM\nYo").candidates.get("chat")).toEqual({ kind: "chat", turns: [
      { speaker: "Alice", time: "10:21 AM", text: "Hi there\nsecond line" }, { speaker: "Bob", time: "10:22 AM", text: "Yo" },
    ] });
    for (const source of [
      "Some intro\nAlice\n10:21\nHi\nBob\n10:22\nYo", // text before the first header
      "Alice\n10:21\n\nBob\n10:22\nYo", // an empty message
      "Alice\n10:21\nHi", // one message is not a conversation
    ]) expect(parseTemplates(source).preferred).not.toBe("chat");
  });
  test("invisible characters chat apps insert are cleaned; emoji joiners stay", () => {
    const parsed = parseTemplates("@nok 明天​吃这个不 👨‍👩‍👧");
    const text = parsed.candidates.get("text");
    expect(text).toEqual({ kind: "text", paragraphs: ["@nok 明天吃这个不 👨‍👩‍👧"] });
    expect(parsed.sourceText).toContain(" ");
  });
  test("frames: legacy names map, animated outputs never use auto, defaults follow the output", async () => {
    const d = (output: "image" | "gif" | "video", aspect?: string) => decideTemplate("少即是多。", { output, decider: null, ...(aspect ? { aspect } : {}) }).then((r) => r.plan.aspect);
    expect(await d("image")).toBe("auto");
    expect(await d("gif")).toBe("1:1");
    expect(await d("video")).toBe("1:1");
    expect(await d("gif", "auto")).toBe("1:1");
    expect(await d("image", "doc")).toBe("16:9");
    expect(await d("video", "4:5")).toBe("4:5");
    await expect(d("image", "2:3")).rejects.toThrow(TemplateInputError);
  });
});


describe("box-drawing tables", () => {
  test("Unicode, rounded, ASCII and psql frames become tables; wrapped cells join; nothing but frames is dropped", () => {
    const unicode = "┌──────┬────────────┐\n│ 检查 │    结果    │\n├──────┼────────────┤\n│ 公证 │ 通过       │\n├──────┼────────────┤\n│ 安装 │ 放行，判定 │\n│      │ 为已公证   │\n└──────┴────────────┘";
    expect(parseTemplates(unicode).candidates.get("table")).toEqual({ kind: "table", headers: ["检查", "结果"], rows: [["公证", "通过"], ["安装", "放行，判定为已公证"]] });
    expect(parseTemplates(unicode).preferred).toBe("table");
    const rounded = "╭──────┬──────────────╮\n│ Name │ Note         │\n├──────┼──────────────┤\n│ a    │ a long cell  │\n│      │ that wraps   │\n├──────┼──────────────┤\n│ b    │ short        │\n╰──────┴──────────────╯";
    expect(parseTemplates(rounded).candidates.get("table")).toEqual({ kind: "table", headers: ["Name", "Note"], rows: [["a", "a long cell that wraps"], ["b", "short"]] });
    const ascii = "+----+-------+\n| id | name  |\n+----+-------+\n|  1 | Ada   |\n|  2 | Bob   |\n+----+-------+";
    expect(parseTemplates(ascii).candidates.get("table")).toEqual({ kind: "table", headers: ["id", "name"], rows: [["1", "Ada"], ["2", "Bob"]] });
    expect(parseTemplates(" id | name \n----+------\n  1 | Ada\n  2 | Bob").candidates.get("table")).toEqual({ kind: "table", headers: ["id", "name"], rows: [["1", "Ada"], ["2", "Bob"]] });
  });
  test("a stray rule, a footer or ragged columns stay a document", () => {
    for (const source of ["──────\n段落文字\n──────", " id | name \n----+------\n  1 | Ada\n(1 row)", "┌───┬───┐\n│ a │ b │\n│ c │\n└───┴───┘"]) {
      expect(parseTemplates(source).candidates.has("table")).toBe(false);
    }
  });
});

describe("templates turned off in Settings", () => {
  const table = "| name | score |\n|---|---|\n| Ada | 9 |\n| Lin | 8 |";

  test("rules skip a disabled template and fall back to the next candidate; document cannot be turned off", async () => {
    expect((await decideTemplate(table, base)).plan.template).toBe("table");
    const off = await decideTemplate(table, { ...base, disabled: ["table"] });
    expect(off.plan.template).not.toBe("table");
    expect(off.availableTemplates).toContain("table"); // still there to choose by hand
    const everything = await decideTemplate(table, { ...base, disabled: [...TEMPLATE_IDS] });
    expect(everything.plan.template).toBe("document");
    expect((await decideTemplate("Short and sweet.", { ...base, disabled: ["text"] })).plan.template).toBe("document");
  });

  test("the model is neither offered nor allowed a disabled template", async () => {
    let asked: Record<string, unknown> = {};
    const result = await decideTemplate(table, { ...base, disabled: ["table"], decider: { name: "fixture", ask: async (body) => {
      asked = (body.questions.template as { criteria: Record<string, unknown> }).criteria;
      return { template: choice("table") };
    } } });
    expect(Object.keys(asked)).not.toContain("table");
    expect(result.plan.template).not.toBe("table");
    expect(result.decisionSource).toBe("fallback");
  });

  test("choosing by hand still reaches a disabled template", async () => {
    expect((await decideTemplate(table, { ...base, disabled: ["table"], override: { id: "table" } })).plan.template).toBe("table");
  });

  test("malformed lists are ignored; the precompose key changes with the list", () => {
    expect(templateIdList("table")).toEqual([]);
    expect(templateIdList(["table", 3, "table", "code"])).toEqual(["code", "table"]);
    expect(withoutTemplates(parseTemplates(table), { table: true }).preferred).toBe("table");
    const spec = { id: "paste-card", name: "x", needs: "render", output: "image" } as unknown as Parameters<typeof renderKeyParts>[0];
    const a = renderKeyParts(spec, { text: table });
    const b = renderKeyParts(spec, { text: table, disabledTemplates: ["table", "code"] });
    expect(a?.disabled).toEqual([]);
    expect(b?.disabled).toEqual(["code", "table"]);
  });
});

describe("larger type never splits a word", () => {
  const metrics: TemplateMeasure = { width: (text, size, bold) => [...text].length * size * (bold ? 0.62 : 0.56), lineHeight: (size) => size * 1.2 };
  const source = "Before:\nCopy, screenshot, crop, paste\nAfter:\nCopy, press a shortcut";
  test("a Latin word moves to the next line whole, even past the half-line limit; commas never start a line", () => {
    const w = (text: string) => metrics.width(text, 40, false);
    expect(wrapTemplateText("Copy, screenshot", w("Copy, screensh"), 40, false, metrics)).toEqual(["Copy, ", "screenshot"]);
    expect(wrapTemplateText("Copy, screenshot, crop, paste", w("Copy, screenshot, cro"), 40, false, metrics)).toEqual(["Copy, screenshot, ", "crop, paste"]);
    // Chinese still breaks between characters and keeps kinsoku.
    expect(wrapTemplateText("复制，截图，裁剪", w("复制，截图"), 40, false, metrics).join("")).toBe("复制，截图，裁剪");
  });
  for (const variant of ["classic", "editorial"] as const) {
    test(`comparison ${variant} at 1:1: every word stays whole`, async () => {
      const { plan } = await decideTemplate(source, { aspect: "1:1", output: "image", decider: null, override: { id: "comparison", variant } });
      const words = new Set(source.split(/[\s,:]+/).filter(Boolean));
      for (const line of layoutTemplate(plan, metrics).lines) {
        for (const token of line.text.split(/[\s,:]+/).filter(Boolean)) expect(words.has(token)).toBe(true);
      }
    });
  }
});

describe("info cards", () => {
  test("labelled fields with a title; types style, never rewrite", () => {
    const source = "测试环境账号\n用户名: admin\n密码: P@ssw0rd!2026\nAPI Key: sk-proj-4f8a2c9e1b7d3a6f0e5c8b2a\nHost: https://staging.example.com\n手机：13800138000\nzhang@example.com";
    const parsed = parseTemplates(source);
    expect(parsed.preferred).toBe("info");
    expect(parsed.candidates.get("info")).toEqual({ kind: "info", title: "测试环境账号", fields: [
      { label: "用户名", value: "admin", type: "plain" },
      { label: "密码", value: "P@ssw0rd!2026", type: "secret" },
      { label: "API Key", value: "sk-proj-4f8a2c9e1b7d3a6f0e5c8b2a", type: "secret" },
      { label: "Host", value: "https://staging.example.com", type: "url" },
      { label: "手机", value: "13800138000", type: "phone" },
      { value: "zhang@example.com", type: "email" },
    ] });
    expect(parseTemplates("Name: Ada\nAge: 32").preferred).toBe("info");
  });

  test("unlabelled contact lines: a name, a phone, an email and an address make a card (icons stand in for labels)", async () => {
    const { looksLikeAddress } = await import("../src/templates/parse.ts");
    expect(parseTemplates("张三\n13800138000\nzhangsan@example.com\n杭州市西湖区文三路 90 号").candidates.get("info")).toEqual({ kind: "info", title: "张三", fields: [
      { value: "13800138000", type: "phone" }, { value: "zhangsan@example.com", type: "email" }, { value: "杭州市西湖区文三路 90 号", type: "address" },
    ] });
    for (const address of ["杭州市西湖区文三路 90 号", "221B Baker Street, London", "1600 Amphitheatre Parkway"]) expect(looksLikeAddress(address)).toBe(true);
    for (const prose of ["今天去市区逛街了，路上很堵。", "我在楼下", "Meet me on the street"]) expect(looksLikeAddress(prose)).toBe(false);
    // A dotenv block with a comment title; any scheme:// is a link.
    expect(parseTemplates("# 本地开发配置\nOPENAI_API_KEY=sk-proj-FAKEfake0000FAKEfake1111\nDATABASE_URL=postgres://app@db:5432/app\nDEBUG=true").candidates.get("info")).toEqual({ kind: "info", title: "本地开发配置", fields: [
      { label: "OPENAI_API_KEY", value: "sk-proj-FAKEfake0000FAKEfake1111", type: "secret" },
      { label: "DATABASE_URL", value: "postgres://app@db:5432/app", type: "url" },
      { label: "DEBUG", value: "true", type: "plain" },
    ] });
    expect(parseTemplates("x=1\ny=2").preferred).not.toBe("info");
  });

  test("not an info card: prose, conversations, a single field, unknown labels", () => {
    for (const source of [
      "Name: Ada\nAge: 32\nName: Bob", "Hello: world\nAnother: field", "Phone: 13800138000",
      "张三\n今天下午三点开会，记得带电脑。\n邮箱：a@b.co",
      "Lin: Can this chat become an image?\nAsh: Yes.\nLin: Nice.",
    ]) expect(parseTemplates(source).preferred).not.toBe("info");
  });

  test("phone digits group 3-4-4 for Chinese mobiles only; the groups join back to the value", async () => {
    const { phoneGroups } = await import("../src/templates/compose.ts");
    expect(phoneGroups("13800138000")).toEqual(["138", "0013", "8000"]);
    expect(phoneGroups("+8613800138000")).toEqual(["+86", "138", "0013", "8000"]);
    expect(phoneGroups("+1 415 555 0100")).toEqual(["+1 415 555 0100"]);
  });
});

describe("card font", () => {
  test("the chosen font travels in the plan; unknown values fall back to the default; it keys precompose", async () => {
    expect((await decideTemplate("Short and sweet.", { ...base, font: "noto" })).plan.font).toBe("noto");
    expect((await decideTemplate("Short and sweet.", { ...base, font: "comic-sans" })).plan.font).toBeUndefined();
    const spec = { id: "paste-card", name: "x", needs: "render", output: "image" } as unknown as Parameters<typeof renderKeyParts>[0];
    expect(renderKeyParts(spec, { text: "x", templateFont: "noto" })?.font).toBe("noto");
    expect(renderKeyParts(spec, { text: "x" })?.font).toBe("");
  });
});
