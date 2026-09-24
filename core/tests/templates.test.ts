import { describe, expect, test } from "bun:test";
import { buildTemplateRequest, decideTemplate } from "../src/templates/decide.ts";
import { CUT_MAX_UNITS, parseLyricLine, parseLyrics, parseTemplates, splitCuts, templateIdList, withoutTemplates } from "../src/templates/parse.ts";
import { renderKeyParts } from "../src/daemon/precompose.ts";
import { DIFF_STYLES, ERROR_STYLES, LYRICS_MOTION, LYRICS_TIMING, STATS_STYLES, TEMPLATE_LIMITS, TEMPLATE_SCROLL, TIMELINE_STYLES, layoutTemplate, wrapTemplateText, type TemplateMeasure } from "../src/templates/compose.ts";
import { emphasisPaint, lyricsComposition, lyricsMaxMs, lyricsViolations, LYRICS_STYLES } from "../src/templates/lyrics.ts";
import { contrastRatio } from "../src/templates/checks.ts";
import { CODE_FONT, TEMPLATE_FACES, templateFaceNames } from "../src/templates/compose.ts";
import { TEMPLATE_GIF_FRAME_BUDGET } from "../src/templates/render.ts";
import { TEMPLATE_REGISTRY } from "../src/templates/registry.ts";
import { MOTIONS, SIGNATURE_MAX_GRAPHEMES, TEMPLATE_IDS, TemplateInputError, templateSignature, type TemplateContent } from "../src/templates/types.ts";
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
    // Fixed-template actions (paste-qr, paste-lyric) are never precomposed and never claim a precomposed card.
    expect(renderKeyParts({ ...spec, id: "paste-qr", render: { animate: "never", template: "qr" } } as never, { text: "x" })).toBeNull();
    expect(renderKeyParts(spec, { text: "x" })?.font).toBe("");
  });
});

describe("card signature", () => {
  test("the signature is one trimmed line of at most 40 graphemes; empty means none; QR never gets one; it keys precompose", async () => {
    expect(templateSignature("  @nya ·\n peesuto.com  ")).toBe("@nya · peesuto.com");
    expect(templateSignature("   ")).toBeUndefined();
    expect(templateSignature(42)).toBeUndefined();
    expect(templateSignature("签".repeat(50))).toBe("签".repeat(SIGNATURE_MAX_GRAPHEMES));
    expect((await decideTemplate("Short and sweet.", { ...base, signature: " @nya " })).plan.signature).toBe("@nya");
    expect((await decideTemplate("Short and sweet.", { ...base, signature: "" })).plan.signature).toBeUndefined();
    expect((await decideTemplate("Short and sweet.", base)).plan.signature).toBeUndefined();
    expect((await decideTemplate("https://peesuto.com", { ...base, signature: "@nya", override: { id: "qr" } })).plan.signature).toBeUndefined();
    const spec = { id: "paste-card", name: "x", needs: "render", output: "image" } as unknown as Parameters<typeof renderKeyParts>[0];
    expect(renderKeyParts(spec, { text: "x", templateSignature: " @nya " })?.signature).toBe("@nya");
    expect(renderKeyParts(spec, { text: "x" })?.signature).toBe("");
  });
  test("the footer is drawn once, small, below the content, and it never counts as content", () => {
    const measure: TemplateMeasure = { width: (t, size) => [...t].length * size * 0.6, lineHeight: (size) => size * 1.2 };
    const plan = { version: 1 as const, template: "list" as const, variant: "classic" as const, motion: "none" as const, sourceText: "- a\n- b", content: { kind: "list" as const, items: ["a", "b"], ordered: false }, aspect: "1:1" as const };
    const signed = layoutTemplate({ ...plan, signature: "@nya" }, measure);
    const footer = signed.lines.filter((line) => line.signature);
    expect(footer.map((line) => line.text)).toEqual(["@nya"]);
    expect(footer[0]!.size).toBe(32);
    expect(footer[0]!.y).toBeGreaterThan(Math.max(...signed.lines.filter((line) => !line.signature).map((line) => line.y + line.height)));
    expect(layoutTemplate(plan, measure).lines.some((line) => line.signature)).toBe(false);
  });
});

describe("changelog cards", () => {
  test("Markdown, Keep a Changelog, Chinese and commit-style release notes; headings and items verbatim", () => {
    const md = parseTemplates("## v1.2.0 — 2026-09-24\n### Added\n- Signature footer\n- Release notes cards\n### Fixed\n- Long lines wrap");
    expect(md.preferred).toBe("changelog");
    expect(md.candidates.get("changelog")).toEqual({ kind: "changelog", releases: [{ version: "v1.2.0", date: "2026-09-24", sections: [
      { title: "Added", type: "added", items: ["Signature footer", "Release notes cards"] }, { title: "Fixed", type: "fixed", items: ["Long lines wrap"] },
    ] }] });
    const kac = parseTemplates("# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-09-24\n### Security\n- Patched\n\n## [1.1.0] - 2026-08-01\n### Changed\n- Warmer");
    expect(kac.preferred).toBe("changelog");
    const content = kac.candidates.get("changelog");
    expect(content?.kind === "changelog" && content.title).toBe("Changelog");
    expect(content?.kind === "changelog" && content.releases.map((r) => [r.version, r.date ?? null, r.sections.map((s) => s.type)])).toEqual([["Unreleased", null, []], ["1.2.0", "2026-09-24", ["security"]], ["1.1.0", "2026-08-01", ["changed"]]]);
    const zh = parseTemplates("## 1.3.0 (2026-10-01)\n新增：\n- 签名\n修复：\n- 换行");
    expect(zh.candidates.get("changelog")).toEqual({ kind: "changelog", releases: [{ version: "1.3.0", date: "2026-10-01", sections: [
      { title: "新增", type: "added", items: ["签名"] }, { title: "修复", type: "fixed", items: ["换行"] }] }] });
    const commits = parseTemplates("v1.2.0\n- feat: add signature\n- docs: https://peesuto.com/spec");
    expect(commits.preferred).toBe("changelog"); // not an info card, despite the URL
    expect(commits.candidates.get("changelog")).toEqual({ kind: "changelog", releases: [{ version: "v1.2.0", sections: [{ type: "other", items: ["feat: add signature", "docs: https://peesuto.com/spec"] }] }] });
  });
  test("not release notes: documents, lists, section numbers, prose, empty sections, only Unreleased", () => {
    for (const source of [
      "# 周报\n\n- 一\n- 二", "## 3.5 Results\n- a\n- b", "- a\n- b", "v1.2.0\nSome prose here.", "## v2.0.0\n### Added",
      "## [Unreleased]\n### Added\n- x", "Intro line\n## v1.0.0\n- x", "## v1.0.0\n- a\n  - nested",
    ]) expect(parseTemplates(source).candidates.has("changelog")).toBe(false);
  });
  test("both styles lay out every release; the timeline stacks a version too wide for its column", () => {
    const measure: TemplateMeasure = { width: (t, size) => [...t].length * size * 0.6, lineHeight: (size) => size * 1.2 };
    const plan = (version: string, variant: "classic" | "editorial") => ({ version: 1 as const, template: "changelog" as const, variant, motion: "none" as const, aspect: "1:1" as const, sourceText: version,
      content: { kind: "changelog" as const, releases: [{ version, sections: [{ title: "Added", type: "added" as const, items: ["x"] }] }] } });
    const side = layoutTemplate(plan("v1.2.0", "editorial"), measure), stacked = layoutTemplate(plan("v2.0.0-beta.12", "editorial"), measure);
    const itemX = (l: ReturnType<typeof layoutTemplate>) => l.lines.find((line) => line.text === "x")!.x;
    expect(itemX(side)).toBeGreaterThan(itemX(stacked));
    expect(stacked.lines.find((line) => line.text.startsWith("v2"))!.text).toBe("v2.0.0-beta.12");
    const card = layoutTemplate(plan("v1.2.0", "classic"), measure);
    expect(card.lines[0]!.text).toBe("v1.2.0");
    expect(card.shapes.some((shape) => shape.color === "#dcefe2")).toBe(true); // the Added tint
  });
});

describe("terminal sessions", () => {
  test("prompts, commands, output, error tones and the exit line, verbatim; code stays the alternative", () => {
    const session = parseTemplates("$ npm test\n> jest\nnpm ERR! Test failed.\nwarning: 2 skipped\n$ echo done\ndone\n[exit 1]");
    expect(session.preferred).toBe("terminal");
    expect(session.candidates.has("code")).toBe(true);
    expect(session.candidates.get("terminal")).toEqual({ kind: "terminal", lines: [
      { kind: "prompt", prompt: "$ ", command: "npm test" }, { kind: "output", text: "> jest" },
      { kind: "output", text: "npm ERR! Test failed.", tone: "error" }, { kind: "output", text: "warning: 2 skipped", tone: "warning" },
      { kind: "prompt", prompt: "$ ", command: "echo done" }, { kind: "output", text: "done" }, { kind: "exit", text: "[exit 1]", ok: false },
    ] });
    // user@host, PowerShell, a venv prefix, zsh ❯ and a fenced console block.
    for (const [source, prompt] of [
      ["nya@mbp:~/项目$ ls\n部署.sh", "nya@mbp:~/项目$ "], ["PS C:\\Users\\nya> dir\n\n    Directory: C:\\Users\\nya", "PS C:\\Users\\nya> "],
      ["(venv) ~/app $ python run.py\nok", "(venv) ~/app $ "], ["❯ cargo build\nerror[E0425]: cannot find value `x`", "❯ "],
      ["```console\n$ git status\nOn branch main\n```", "$ "],
    ] as const) {
      const parsed = parseTemplates(source);
      expect(parsed.preferred).toBe("terminal");
      const content = parsed.candidates.get("terminal");
      expect(content?.kind === "terminal" && content.lines[0]).toMatchObject({ kind: "prompt", prompt });
    }
    const denied = parseTemplates("$ ./deploy.sh\nbash: ./deploy.sh: Permission denied").candidates.get("terminal");
    expect(denied?.kind === "terminal" && denied.lines[1]).toEqual({ kind: "output", text: "bash: ./deploy.sh: Permission denied", tone: "error" });
  });
  test("not a session: a lone command, code, prose with $ or %, output before any prompt, unknown bare commands", () => {
    for (const source of [
      "git log --oneline -5", "$ npm install peesuto", "const a = 1;\nconst b = 2;", "$ 100 off today\nonly this week", "% of users grew\nlast quarter",
      "Output first\n$ ls", "$ Hello there\nhow are you", "```ts\n$ foo\nbar\n```", "价格 $ 5\n很便宜",
    ]) expect(parseTemplates(source).candidates.has("terminal")).toBe(false);
  });
  test("both styles: the command bold after its prompt, output dimmed, errors coloured, wraps hang", () => {
    const measure: TemplateMeasure = { width: (t, size) => [...t].length * size * 0.6, lineHeight: (size) => size * 1.2 };
    const content = { kind: "terminal" as const, lines: [{ kind: "prompt" as const, prompt: "$ ", command: "git push" },
      { kind: "output" as const, text: "error: failed to push some refs to github.com:example/repository-with-a-long-name", tone: "error" as const }] };
    for (const variant of ["classic", "editorial"] as const) {
      const layout = layoutTemplate({ version: 1, template: "terminal", variant, motion: "none", aspect: "1:1", sourceText: "x", content }, measure);
      const command = layout.lines.find((line) => line.text === "$ git push")!;
      expect(command.boldAt).toEqual([false, false, true, true, true, true, true, true, true, true]);
      const error = layout.lines.filter((line) => line.text.includes("push some") || line.text.includes("github"));
      expect(error.length).toBeGreaterThan(1);
      expect(error[1]!.x).toBeGreaterThan(error[0]!.x); // the hanging indent
      expect(new Set(error.map((line) => line.color)).size).toBe(1);
      expect(error[0]!.color).not.toBe(command.color);
    }
  });
});

describe("diff cards", () => {
  const gitDiff = "diff --git a/src/a.ts b/src/a.ts\nindex 3f2a1c9..8b7e4d0 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@ export {}\n const a = 1;\n-const b = 2;\n+const b = 3;\n--- c\n";
  test("git diff: the path as title, header lines as syntax, hunk lines verbatim; the counts tell a removed '---' line from a header", () => {
    const source = "diff --git a/src/a.ts b/src/a.ts\nindex 3f2a1c9..8b7e4d0 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,2 @@ export {}\n const a = 1;\n-const b = 2;\n--- c\n\\ No newline at end of file";
    const parsed = parseTemplates(source);
    expect(parsed.preferred).toBe("diff");
    expect(parsed.candidates.has("code")).toBe(true); // the highlighted code card stays the alternative
    expect(parsed.candidates.get("diff")).toEqual({ kind: "diff", files: [{ path: "src/a.ts", meta: [], hunks: [{ header: "@@ -1,3 +1,2 @@ export {}", lines: [
      { type: "context", text: " const a = 1;" }, { type: "del", text: "-const b = 2;" }, { type: "del", text: "--- c" }, { type: "note", text: "\\ No newline at end of file" },
    ] }] }] });
    expect(parseTemplates(gitDiff).preferred).toBe("diff");
  });
  test("diff -u, a bare hunk, a fenced ```diff, renames and binaries", () => {
    const u = parseTemplates("--- old/说明.md\t2026-09-24\n+++ new/说明.md\t2026-09-24\n@@ -1 +1 @@\n-旧\n+新").candidates.get("diff");
    expect(u?.kind === "diff" && [u.files[0]!.path, u.files[0]!.oldPath]).toEqual(["new/说明.md", "old/说明.md"]);
    expect(parseTemplates("@@ -1,2 +1,2 @@\n a\n-b\n+c").preferred).toBe("diff");
    const fenced = parseTemplates("```diff\n@@ -1 +1 @@\n-a\n+b\n```");
    expect(fenced.preferred).toBe("diff");
    expect(fenced.candidates.get("code")).toEqual({ kind: "code", code: "@@ -1 +1 @@\n-a\n+b", language: "diff" });
    const rename = parseTemplates("diff --git a/x.md b/y.md\nsimilarity index 90%\nrename from x.md\nrename to y.md\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/l.png b/l.png\nnew file mode 100644\nBinary files /dev/null and b/l.png differ").candidates.get("diff");
    expect(rename?.kind === "diff" && rename.files.map((f) => [f.path, f.oldPath ?? null, f.meta.length, f.hunks.length])).toEqual([["y.md", null, 3, 1], ["l.png", null, 2, 0]]);
  });
  test("not a diff: lists with + and -, Markdown rules, headers without hunks, stray lines, context only", () => {
    for (const source of [
      "- one\n- two\n+ three", "--- \ntitle\n---", "--- a/x\n+++ b/x", "@@ -1 +1 @@\n-a\n+b\nSome prose after it.", "@@ -1,2 +1,2 @@\n a\n b",
      "Pros:\n+ fast\n- expensive", "```ts\n@@ -1 +1 @@\n-a\n+b\n```",
    ]) expect(parseTemplates(source).candidates.has("diff")).toBe(false);
  });
  const body = "diff --git a/src/a.ts b/src/a.ts\nindex 3f2a1c9..8b7e4d0 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;";
  const show = "commit 8d829cc1f2e3a4b5c6d7e8f90a1b2c3d4e5f6a7b (HEAD -> main, origin/main)\nAuthor: 林小雨 <lin@example.com>\nDate:   Wed Sep 24 10:12:03 2026 +0800\n\n    fix(a): b is three\n\n    It was two.\n    Now it is three.\n\n" + body;
  const patch = "From 8d829cc1f2e3a4b5c6d7e8f90a1b2c3d4e5f6a7b Mon Sep 17 00:00:00 2001\nFrom: Lin <lin@example.com>\nDate: Wed, 24 Sep 2026 10:12:03 +0800\nSubject: [PATCH] fix(a): b is three, a subject\n folded onto a second line\nMIME-Version: 1.0\nContent-Type: text/plain; charset=UTF-8\nContent-Transfer-Encoding: 8bit\n\nIt was two.\n---\n src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n\n" + body + "\n-- \n2.50.1 (Apple Git-155)\n";
  test("a git show or format-patch header above the diff: its lines as written, the diff as before", () => {
    const plain = parseTemplates(body).candidates.get("diff") as Extract<TemplateContent, { kind: "diff" }>;
    const shown = parseTemplates(show);
    expect(shown.preferred).toBe("diff");
    expect(shown.candidates.get("diff")).toEqual({ kind: "diff", commit: [
      { text: "commit 8d829cc1f2e3a4b5c6d7e8f90a1b2c3d4e5f6a7b (HEAD -> main, origin/main)", role: "commit" },
      { text: "Author: 林小雨 <lin@example.com>", role: "field" }, { text: "Date:   Wed Sep 24 10:12:03 2026 +0800", role: "field" },
      { text: "fix(a): b is three", role: "subject" }, { text: "It was two.", role: "message" }, { text: "Now it is three.", role: "message" },
    ], files: plain.files });
    const mailed = parseTemplates(patch);
    expect(mailed.preferred).toBe("diff");
    // MIME headers, the ---, the diffstat and the signature are syntax; the folded Subject is one line.
    expect(mailed.candidates.get("diff")).toEqual({ kind: "diff", commit: [
      { text: "From 8d829cc1f2e3a4b5c6d7e8f90a1b2c3d4e5f6a7b Mon Sep 17 00:00:00 2001", role: "commit" },
      { text: "From: Lin <lin@example.com>", role: "field" }, { text: "Date: Wed, 24 Sep 2026 10:12:03 +0800", role: "field" },
      { text: "Subject: [PATCH] fix(a): b is three, a subject folded onto a second line", role: "subject" }, { text: "It was two.", role: "message" },
    ], files: plain.files });
    // --stat and --format=fuller, a merge line, a short sha; a patch with no message.
    const fuller = parseTemplates("commit 8d829cc\nMerge: 1a2b3c4 5d6e7f8\nAuthor:     Lin <lin@example.com>\nAuthorDate: Wed Sep 24 10:12:03 2026 +0800\nCommit:     Lin <lin@example.com>\nCommitDate: Wed Sep 24 10:12:03 2026 +0800\n\n    Merge branch 'b'\n\n src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n\n" + body).candidates.get("diff");
    expect(fuller?.kind === "diff" && fuller.commit?.map((l) => l.role)).toEqual(["commit", "field", "field", "field", "field", "field", "subject"]);
    const bare = parseTemplates("From 8d829cc1f2e3a4b5c6d7e8f90a1b2c3d4e5f6a7b Mon Sep 17 00:00:00 2001\nFrom: Lin <lin@example.com>\nSubject: [PATCH 2/3] Bump\n\n---\n" + body).candidates.get("diff");
    expect(bare?.kind === "diff" && bare.commit?.map((l) => l.text)).toEqual(["From 8d829cc1f2e3a4b5c6d7e8f90a1b2c3d4e5f6a7b Mon Sep 17 00:00:00 2001", "From: Lin <lin@example.com>", "Subject: [PATCH 2/3] Bump"]);
  });
  test("not a diff with a header: a log without patches, a header over prose, broken headers, two commits", () => {
    for (const source of [
      "commit 8d829cc1f2e3a4b5c6d7e8f90a1b2c3d4e5f6a7b\nAuthor: Lin <lin@example.com>\nDate:   Wed Sep 24 10:12:03 2026 +0800\n\n    fix(a): b is three",
      "commit 8d829cc1f2e3a4b5c6d7e8f90a1b2c3d4e5f6a7b\nAuthor: Lin <lin@example.com>\n\n    fix\n\nSome prose after the log.",
      "commit 8d829cc\n\n    no fields\n\n" + body, "commit 8d829cc\nAuthor: Lin\n\n" + body, "commit not-a-sha\nAuthor: Lin\n\n    fix\n\n" + body,
      "commit 8d829cc\nAuthor: Lin\nDate: today\n    fix\n\n" + body,
      "From 8d829cc1f2e3a4b5c6d7e8f90a1b2c3d4e5f6a7b Mon Sep 17 00:00:00 2001\nFrom: Lin <lin@example.com>\n\nIt was two.\n---\n" + body,
      "From 8d829cc1f2e3a4b5c6d7e8f90a1b2c3d4e5f6a7b Mon Sep 17 00:00:00 2001\nFrom: Lin\nSubject: x\nnot a header\n\n---\n" + body,
      "From 8d829cc1f2e3a4b5c6d7e8f90a1b2c3d4e5f6a7b Mon Sep 17 00:00:00 2001\nFrom: Lin\nSubject: [PATCH] x\n\nJust a message, no patch.",
      show + "\n\ncommit 1a2b3c4\nAuthor: Lin\n\n    second\n\n" + body,
    ]) expect(parseTemplates(source).candidates.has("diff")).toBe(false);
  });
  test("the commit header is drawn above the files: the subject like a title, the sha, fields and message small", () => {
    const measure: TemplateMeasure = { width: (t, size) => [...t].length * size * 0.6, lineHeight: (size) => size * 1.2 };
    const content = parseTemplates(show).candidates.get("diff")!;
    for (const variant of ["classic", "editorial"] as const) {
      const layout = layoutTemplate({ version: 1, template: "diff", variant, motion: "none", aspect: "1:1", sourceText: show, content }, measure);
      const S = DIFF_STYLES[variant], line = (text: string) => layout.lines.find((l) => l.text.startsWith(text))!;
      expect([line("fix(a)").bold, line("fix(a)").size, line("fix(a)").color]).toEqual([true, Math.min(S.title.size, 40), S.title.color]);
      expect(line("commit 8d829cc").size).toBe(S.meta.size);
      expect(line("Author:").y).toBeLessThan(line("fix(a)").y);
      expect(line("Now it is three.").y).toBeLessThan(line("src/a.ts").y);
      expect(layout.lines.some((l) => /^ *(?:diff --git|index )/.test(l.text))).toBe(false);
    }
  });
  test("both styles: tinted rows with the sign in a gutter, and a +N −M summary of generated counts with shape signs", () => {
    const measure: TemplateMeasure = { width: (t, size) => [...t].length * size * 0.6, lineHeight: (size) => size * 1.2 };
    const content = parseTemplates(gitDiff).candidates.get("diff")!;
    for (const variant of ["classic", "editorial"] as const) {
      const layout = layoutTemplate({ version: 1, template: "diff", variant, motion: "none", aspect: "1:1", sourceText: gitDiff, content }, measure);
      expect(layout.lines.filter((line) => line.generated).map((line) => line.text).sort()).toEqual(["1", "2"]);
      expect(layout.lines.some((line) => line.text === "src/a.ts" && line.bold)).toBe(true);
      expect(layout.lines.some((line) => /diff --git|^index |^\+\+\+ /.test(line.text))).toBe(false);
      const plus = layout.lines.find((line) => line.text === "+")!, body = layout.lines.find((line) => line.text === "const b = 3;")!;
      expect(body.x).toBeGreaterThan(plus.x);
      expect(layout.shapes.some((shape) => shape.y <= body.y && shape.y + shape.height >= body.y + body.height && shape.color === DIFF_STYLES[variant].add.fill)).toBe(true);
    }
  });
});

describe("error cards", () => {
  test("JavaScript, Java, C#, Go and Rust put the error first; Python last; frames verbatim, own frames told from libraries", () => {
    const node = parseTemplates("TypeError: Cannot read properties of undefined (reading 'map')\n    at render (/app/src/App.tsx:12:20)\n    at renderWithHooks (/app/node_modules/react-dom/cjs/react-dom.development.js:16305:18)");
    expect(node.preferred).toBe("error");
    expect(node.candidates.has("code")).toBe(true);
    expect(node.candidates.get("error")).toEqual({ kind: "error", type: "TypeError", message: "Cannot read properties of undefined (reading 'map')", trace: [
      { text: "at render (/app/src/App.tsx:12:20)", role: "frame", own: true },
      { text: "at renderWithHooks (/app/node_modules/react-dom/cjs/react-dom.development.js:16305:18)", role: "frame", own: false },
    ] });
    const py = parseTemplates("Traceback (most recent call last):\n  File \"/srv/应用.py\", line 3, in <module>\n    x = {}['a']\n        ~~^^^^^\n  File \"/usr/lib/python3.12/json/__init__.py\", line 293, in load\n    return loads(fp.read())\nKeyError: 'a'").candidates.get("error");
    expect(py).toEqual({ kind: "error", type: "KeyError", message: "'a'", trace: [
      { text: "Traceback (most recent call last):", role: "note", own: false }, { text: "File \"/srv/应用.py\", line 3, in <module>", role: "frame", own: true },
      { text: "x = {}['a']", role: "code", own: true }, { text: "    ~~^^^^^", role: "code", own: true },
      { text: "File \"/usr/lib/python3.12/json/__init__.py\", line 293, in load", role: "frame", own: false }, { text: "return loads(fp.read())", role: "code", own: false },
    ] });
    const java = parseTemplates("Exception in thread \"main\" java.lang.IllegalStateException: boom\n\tat com.example.App.run(App.java:12)\nCaused by: java.io.IOException: disk full\n\tat java.base/java.io.FileOutputStream.write(FileOutputStream.java:354)\n\t... 2 more").candidates.get("error");
    expect(java?.kind === "error" && [java.lead, java.type, java.message, java.trace.map((l) => `${l.role}:${l.own}`)]).toEqual(["Exception in thread \"main\"", "java.lang.IllegalStateException", "boom", ["frame:true", "note:false", "frame:false", "note:false"]]);
    const go = parseTemplates("panic: runtime error: index out of range [5] with length 3\n\ngoroutine 1 [running]:\nmain.main()\n\t/tmp/prog.go:8 +0x1d\nexit status 2").candidates.get("error");
    expect(go?.kind === "error" && [go.type, go.message, go.trace.map((l) => l.role)]).toEqual(["panic", "runtime error: index out of range [5] with length 3", ["note", "frame", "code", "note"]]);
    const rust = parseTemplates("thread 'main' panicked at src/main.rs:4:5:\nindex out of bounds: the len is 3 but the index is 5\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace").candidates.get("error");
    expect(rust?.kind === "error" && [rust.lead, rust.type, rust.message]).toEqual(["thread 'main' panicked at src/main.rs:4:5", undefined, "index out of bounds: the len is 3 but the index is 5"]);
    const cs = parseTemplates("Unhandled exception. System.InvalidOperationException: Sequence contains no elements\n   at System.Linq.ThrowHelper.ThrowNoElementsException()\n   at Program.Main() in /app/Program.cs:line 5").candidates.get("error");
    expect(cs?.kind === "error" && cs.trace.map((l) => l.own)).toEqual([false, true]);
  });
  test("Ruby and PHP: the location in the heading is the top frame; gems/ and vendor/ frames are dimmed", () => {
    const ruby = parseTemplates("app.rb:12:in 'Integer#/': divided by 0 (ZeroDivisionError)\n\tfrom app.rb:12:in 'Object#divide'\n\tfrom /usr/local/bundle/gems/rack-3.0.8/lib/rack/builder.rb:12:in 'block in Rack::Builder#call'\n\tfrom app.rb:20:in '<main>'");
    expect(ruby.preferred).toBe("error");
    expect(ruby.candidates.get("error")).toEqual({ kind: "error", type: "ZeroDivisionError", message: "divided by 0", trace: [
      { text: "app.rb:12:in 'Integer#/'", role: "frame", own: true }, { text: "from app.rb:12:in 'Object#divide'", role: "frame", own: true },
      { text: "from /usr/local/bundle/gems/rack-3.0.8/lib/rack/builder.rb:12:in 'block in Rack::Builder#call'", role: "frame", own: false },
      { text: "from app.rb:20:in '<main>'", role: "frame", own: true },
    ] });
    // Before 3.4: backquotes, namespaced classes; error_highlight's snippet under the heading; internal frames.
    const old = parseTemplates("app/models/user.rb:3:in `full_name': undefined method `upcase' for nil:NilClass (NoMethodError)\n\tfrom /Users/lin/.rbenv/versions/3.3.0/lib/ruby/3.3.0/json/common.rb:9:in `parse'\n\tfrom app.rb:5:in `<main>'").candidates.get("error");
    expect(old?.kind === "error" && [old.type, old.message, old.trace.map((l) => l.own)]).toEqual(["NoMethodError", "undefined method `upcase' for nil:NilClass", [true, false, true]]);
    const highlight = parseTemplates("test.rb:2:in '<main>': undefined method 'foo' for nil (NoMethodError)\n\nnil.foo\n   ^^^^\n\tfrom <internal:kernel>:187:in 'loop'\n\tfrom test.rb:1:in '<main>'").candidates.get("error");
    expect(highlight?.kind === "error" && highlight.trace.map((l) => `${l.role}:${l.own}:${l.text}`)).toEqual([
      "frame:true:test.rb:2:in '<main>'", "code:true:nil.foo", "code:true:   ^^^^", "frame:false:from <internal:kernel>:187:in 'loop'", "frame:true:from test.rb:1:in '<main>'"]);
    const scoped = parseTemplates("app/jobs/sync.rb:8:in 'perform': Couldn't find User with 'id'=7 (ActiveRecord::RecordNotFound)\n\tfrom app.rb:3:in '<main>'").candidates.get("error");
    expect(scoped?.kind === "error" && scoped.type).toBe("ActiveRecord::RecordNotFound");
    const reversed = parseTemplates("Traceback (most recent call last):\n\t2: from app.rb:20:in `<main>'\n\t1: from app.rb:12:in `divide'\napp.rb:12:in `/': divided by 0 (ZeroDivisionError)").candidates.get("error");
    expect(reversed?.kind === "error" && [reversed.type, reversed.message, reversed.trace.map((l) => l.text)]).toEqual(["ZeroDivisionError", "divided by 0",
      ["Traceback (most recent call last):", "2: from app.rb:20:in `<main>'", "1: from app.rb:12:in `divide'", "app.rb:12:in `/'"]]);

    const php = parseTemplates("PHP Fatal error:  Uncaught Exception: Payment failed in /var/www/app/src/Checkout.php:42\nStack trace:\n#0 /var/www/app/src/Controller.php(17): App\\Checkout->pay()\n#1 /var/www/app/vendor/laravel/framework/src/Illuminate/Routing/Route.php(205): App\\Controller->store()\n#2 [internal function]: App\\Kernel->handle()\n#3 {main}\n  thrown in /var/www/app/src/Checkout.php on line 42");
    expect(php.preferred).toBe("error");
    expect(php.candidates.get("error")).toEqual({ kind: "error", lead: "PHP Fatal error: Uncaught", type: "Exception", message: "Payment failed", trace: [
      { text: "/var/www/app/src/Checkout.php:42", role: "frame", own: true }, { text: "Stack trace:", role: "note", own: false },
      { text: "#0 /var/www/app/src/Controller.php(17): App\\Checkout->pay()", role: "frame", own: true },
      { text: "#1 /var/www/app/vendor/laravel/framework/src/Illuminate/Routing/Route.php(205): App\\Controller->store()", role: "frame", own: false },
      { text: "#2 [internal function]: App\\Kernel->handle()", role: "frame", own: false }, { text: "#3 {main}", role: "frame", own: false },
      { text: "thrown in /var/www/app/src/Checkout.php on line 42", role: "note", own: false },
    ] });
    // The CLI form without "PHP ", a message that itself says "in", a namespaced class, a chained exception.
    const cli = parseTemplates("Fatal error: Uncaught App\\Billing\\CardDeclined: Card declined in store 12 in /srv/app/src/Billing.php:88\nStack trace:\n#0 /srv/app/public/index.php(9): App\\Billing->charge()\n#1 {main}\n  thrown in /srv/app/src/Billing.php on line 88").candidates.get("error");
    expect(cli?.kind === "error" && [cli.lead, cli.type, cli.message, cli.trace[0]!.text]).toEqual(["Fatal error: Uncaught", "App\\Billing\\CardDeclined", "Card declined in store 12", "/srv/app/src/Billing.php:88"]);
    const next = parseTemplates("PHP Fatal error:  Uncaught Exception: inner in /a.php:3\nStack trace:\n#0 {main}\n\nNext RuntimeException: outer in /a.php:5\nStack trace:\n#0 {main}\n  thrown in /a.php on line 5").candidates.get("error");
    expect(next?.kind === "error" && next.trace.map((l) => l.role)).toEqual(["frame", "note", "frame", "note", "note", "frame", "note"]);
  });
  test("not a Ruby or PHP error card: a heading alone or over prose, warnings, fatal errors without a trace", () => {
    for (const source of [
      "app.rb:12:in 'divide': divided by 0 (ZeroDivisionError)", "app.rb:12:in 'divide': divided by 0 (ZeroDivisionError)\nThen I fixed it by checking b.",
      "app.rb:12: warning: possibly useless use of == in void context\napp.rb:13: warning: unused variable", "app.rb:12:in 'divide': divided by 0\n\tfrom app.rb:20:in '<main>'",
      "PHP Fatal error:  Uncaught Exception: boom in /a.php:3", "PHP Fatal error:  Uncaught Exception: boom in /a.php:3\nand then some prose",
      "Warning: Undefined variable $x in /a.php on line 3\nWarning: Undefined variable $y in /a.php on line 4",
      "PHP Fatal error:  Allowed memory size of 134217728 bytes exhausted in /a.php on line 12\nPHP Stack trace:",
      "Traceback (most recent call last):\napp.rb:12:in `/': divided by 0 (ZeroDivisionError)",
    ]) expect(parseTemplates(source).candidates.has("error")).toBe(false);
  });
  test("not an error card: an error line alone or with prose, logs, a lone Python heading, code that names an error", () => {
    for (const source of [
      "TypeError: x is undefined", "ValueError: bad\nSome prose explaining.", "Error: something\nnot a frame here", "Traceback (most recent call last):\nKeyError: 'a'",
      "2026-09-21 14:03:12 ERROR upload failed\n2026-09-21 14:03:14 INFO retrying", "class ParseError extends Error {}\nthrow new ParseError()",
      "Errors: 0\nWarnings: 2", "```ts\nthrow new TypeError(\"x\");\n```", "```css\nError: x\n    at f (a.ts:1:1)\n```",
    ]) expect(parseTemplates(source).candidates.has("error")).toBe(false);
  });
  test("both styles: the type in the error colour, the message large, own frames bold and marked, library frames dimmed", () => {
    const measure: TemplateMeasure = { width: (t, size) => [...t].length * size * 0.6, lineHeight: (size) => size * 1.2 };
    const content = parseTemplates("Error: boom\n    at mine (/app/src/a.ts:1:1)\n    at theirs (/app/node_modules/x/index.js:2:2)").candidates.get("error")!;
    for (const variant of ["classic", "editorial"] as const) {
      const layout = layoutTemplate({ version: 1, template: "error", variant, motion: "none", aspect: "1:1", sourceText: "x", content }, measure);
      const S = ERROR_STYLES[variant], line = (text: string) => layout.lines.find((l) => l.text.startsWith(text))!;
      expect(line("Error").color).toBe(S.type.color);
      expect(line("boom").size).toBeGreaterThan(line("at mine").size);
      expect([line("at mine").bold, line("at mine").color]).toEqual([true, S.trace.own]);
      expect([line("at theirs").bold, line("at theirs").color]).toEqual([false, S.trace.lib]);
      expect(layout.shapes.filter((shape) => shape.color === S.mark.color)).toHaveLength(1);
    }
  });
});

describe("schedule (timeline) cards", () => {
  test("times, ranges, dates, periods and Chinese times; the title, list markers and separators", () => {
    expect(parseTemplates("周五发布日程\n09:00 冻结代码\n10:30–11:00 回归测试\n下午5点 发布").candidates.get("timeline")).toEqual({ kind: "timeline", title: "周五发布日程", events: [
      { time: "09:00", text: "冻结代码" }, { time: "10:30–11:00", text: "回归测试" }, { time: "下午5点", text: "发布" }] });
    const en = parseTemplates("## Launch day\n- 9:00am - Doors open\n- 9:30 am | Keynote: What's next\n- 2pm Workshops");
    expect(en.preferred).toBe("timeline"); // a bulleted schedule is not a plain list
    expect(en.candidates.get("timeline")).toEqual({ kind: "timeline", title: "Launch day", events: [
      { time: "9:00am", text: "Doors open" }, { time: "9:30 am", text: "Keynote: What's next" }, { time: "2pm", text: "Workshops" }] });
    for (const source of ["2026-09-24 v0.2.0\nQ1 2027 Windows beta", "第一周 需求\n第二周 开发", "Sep 24 Launch\nOct 1 Holiday", "2019 Founded\n2026 Peesuto", "周一 例会\n周三 评审", "9/24 14:00 Review\n9/25 Ship"]) {
      expect(parseTemplates(source).preferred).toBe("timeline");
    }
  });
  test("not a schedule: chat transcripts, logs, metrics, recipes, prose and a single event", () => {
    for (const source of [
      "nok\n22:10\n你好\n\nshybee\n22:11\n在吗", "Alice 10:21\nhi\nBob 10:22\nhello",
      "2026-09-21 14:03:12 INFO started\n2026-09-21 14:03:13 WARN slow", "10:21 INFO started\n10:22 WARN slow", "10:21 id=1 status=ok\n10:22 id=2 status=503",
      "2026-09-21T14:03:12Z started\n2026-09-21T14:03:13Z stopped", "Q3: 12%\nQ4: 15%", "1/2 cup sugar\n3/4 cup milk",
      "09:00 Standup", "Meeting at 10:00 tomorrow\nThen lunch", "09:00 Standup\nThen we go to lunch together.",
    ]) expect(parseTemplates(source).candidates.has("timeline")).toBe(false);
  });
  test("both styles: a dot per event on one line; Agenda puts times in a right-aligned column, Milestones above the text", () => {
    const measure: TemplateMeasure = { width: (t, size) => [...t].length * size * 0.6, lineHeight: (size) => size * 1.2 };
    const content = parseTemplates("09:00 Doors open\n10:30 Keynote\n14:00 Workshops").candidates.get("timeline")!;
    for (const variant of ["classic", "editorial"] as const) {
      const layout = layoutTemplate({ version: 1, template: "timeline", variant, motion: "none", aspect: "1:1", sourceText: "x", content }, measure);
      const S = TIMELINE_STYLES[variant];
      expect(layout.shapes.filter((shape) => shape.color === S.dot.color)).toHaveLength(3);
      const time = layout.lines.find((l) => l.text === "10:30")!, text = layout.lines.find((l) => l.text === "Keynote")!;
      if (variant === "classic") { expect(time.x + time.width).toBeLessThan(text.x); expect(Math.abs(time.y - text.y)).toBeLessThan(text.size); }
      else { expect(time.x).toBe(text.x); expect(time.y).toBeLessThan(text.y); }
    }
  });
});

describe("metrics (stats) cards", () => {
  test("label: number lines with units, currency and changes; the title; parentheses around a change are syntax", () => {
    expect(parseTemplates("Weekly metrics\nDAU: 12,480 (+8%)\nRevenue: $48.2k (−3.1% WoW)\nChurn: 2.4% ↓0.3pp\nNPS: 61").candidates.get("stats")).toEqual({ kind: "stats", title: "Weekly metrics", metrics: [
      { label: "DAU", value: "12,480", delta: "+8%" }, { label: "Revenue", value: "$48.2k", delta: "−3.1% WoW" }, { label: "Churn", value: "2.4%", delta: "↓0.3pp" }, { label: "NPS", value: "61" }] });
    const zh = parseTemplates("本周数据：\n日活：12,480（+8%）\n收入：¥32.5万\n评分：4.8/5");
    expect(zh.preferred).toBe("stats");
    expect(zh.candidates.get("stats")).toEqual({ kind: "stats", title: "本周数据", metrics: [
      { label: "日活", value: "12,480", delta: "+8%" }, { label: "收入", value: "¥32.5万" }, { label: "评分", value: "4.8/5" }] });
    expect(parseTemplates("A: 5\nB: 7").preferred).toBe("stats"); // numbers, not a conversation
    expect(parseTemplates("Weekly active users: 12,480").preferred).toBe("stat"); // one metric keeps the single-number card
  });
  test("the boundary with info cards: contact details, identifiers, phone-like digits and mixed values are info", () => {
    for (const [source, preferred] of [
      ["Phone: 13800138000\nQQ: 12345678", "info"], ["订单信息\n订单号：202609240001\n金额：¥128\n电话：13800138000", "info"],
      ["Revenue: $12,480\nContact: ops@example.com", "info"], ["Host: db.internal\nPort: 5432", "info"],
      ["Price: $12\nAmount: 3", "stats"], ["Stars: 1,204\nForks: 88\nIssues: 12", "stats"],
    ] as const) expect(parseTemplates(source).preferred).toBe(preferred);
    for (const source of ["Port: 5432\nTimeout: 30s", "User ID: 1024\nScore: 88", "DAU: 12,480\nDAU: 12,500", "Revenue: $12k\nSome prose line after it."]) {
      expect(parseTemplates(source).candidates.has("stats")).toBe(false);
    }
  });
  test("both styles: a grid of two or three columns; the change coloured by its sign only", () => {
    const measure: TemplateMeasure = { width: (t, size) => [...t].length * size * 0.6, lineHeight: (size) => size * 1.2 };
    const plan = (metrics: { label: string; value: string; delta?: string }[], variant: "classic" | "editorial") => layoutTemplate({ version: 1, template: "stats", variant, motion: "none", aspect: "1:1", sourceText: "x", content: { kind: "stats", metrics } }, measure);
    for (const variant of ["classic", "editorial"] as const) {
      const S = STATS_STYLES[variant];
      const four = plan([{ label: "a", value: "1", delta: "+8%" }, { label: "b", value: "2", delta: "−3%" }, { label: "c", value: "3", delta: "(5)" }, { label: "d", value: "4" }], variant);
      const xs = (l: typeof four) => new Set(l.lines.filter((line) => /^\d$/.test(line.text)).map((line) => Math.round(line.x))).size;
      expect(xs(four)).toBe(2);
      expect(xs(plan([{ label: "a", value: "1" }, { label: "b", value: "2" }, { label: "c", value: "3" }, { label: "d", value: "4" }, { label: "e", value: "5" }], variant))).toBe(3);
      const color = (text: string) => four.lines.find((line) => line.text === text)!.color;
      expect([color("+8%"), color("−3%"), color("(5)")]).toEqual([S.delta.up, S.delta.down, S.delta.flat]);
      expect(four.lines.find((line) => line.text === "1")!.size).toBeGreaterThan(four.lines.find((line) => line.text === "a")!.size);
    }
  });
});

describe("lyrics cards", () => {
  const lyricsOf = (text: string) => parseTemplates(text).candidates.get("lyrics");
  // Sample lyrics are written for these tests (never a real song). "夜明けの色を/覚えてる", "*透明*" and
  // "I remember/the dawn" are the markup examples in JIZURA's README (MIT, https://github.com/852wa/JIZURA).
  const ZH = "旧站台的白铃兰\n从那年夏天开到现在\n你折好的纸飞机\n还停在我窗前的风里\n\n踩着单车穿过雨巷\n我听见心跳慢慢靠近";
  const JA = "夜明けの色を/覚えてる\n*透明*な傘をたたんで\n坂道の途中で笑った!\n\nまだ眠い町の灯り";
  const EN = "I remember the dawn\nPaper lanterns on the river\nWe were counting every bridge back home\n\nOh, *stay awake* with me\nStay awake with me!";
  const LRC = "[ti:纸飞机]\n[ar:Peesuto]\n[00:12.34]旧站台的白铃兰\n[00:15.80]从那年夏天开到现在\n[00:19.20]你折好的纸飞机\n[00:22.60]还停在我窗前的风里";
  const measure: TemplateMeasure = { width: (t, size) => [...t].reduce((n, c) => n + size * (/[\x00-\x7f]/.test(c) ? 0.6 : 1), 0), lineHeight: (size) => size * 1.45 };
  const plan = (text: string, variant: "classic" | "editorial" = "classic", motion: "none" | "reveal" | "typewriter" = "reveal", aspect: "1:1" | "9:16" | "16:9" = "1:1") =>
    ({ version: 1 as const, template: "lyrics" as const, variant, motion, aspect, sourceText: text, content: lyricsOf(text)! });

  test("song lyrics in Chinese, Japanese and English keep their lines; lyric motion is never chosen automatically", () => {
    for (const text of [ZH, JA, EN]) {
      expect(parseTemplates(text).preferred).not.toBe("lyrics");
      expect(parseLyrics(text)).toBeDefined();
      expect(lyricsOf(text)).not.toHaveProperty("prose");
    }
    expect(lyricsOf(ZH)).toMatchObject({ kind: "lyrics", stanzas: [{ lines: [{ text: "旧站台的白铃兰" }, {}, {}, {}] }, { lines: [{}, { text: "我听见心跳慢慢靠近" }] }] });
    // Short prose stays an alternative.
    expect(parseTemplates(EN).candidates.has("text")).toBe(true);
  });
  test("JIZURA markup is syntax: / cuts, *emphasis*, a note after |, a trailing ! stays", () => {
    expect(parseLyricLine("夜明けの色を/覚えてる")).toEqual({ text: "夜明けの色を覚えてる", breaks: [6] });
    expect(parseLyricLine("I remember/the dawn")).toEqual({ text: "I remember the dawn", breaks: [11] });
    expect(parseLyricLine("I remember / the dawn")).toEqual({ text: "I remember the dawn", breaks: [11] });
    expect(parseLyricLine("*透明*な傘をたたんで")).toEqual({ text: "透明な傘をたたんで", emphasis: [[0, 2]] });
    expect(parseLyricLine("Oh, *stay awake* with me")).toEqual({ text: "Oh, stay awake with me", emphasis: [[4, 14]] });
    expect(parseLyricLine("坂道の途中で笑った!|さかみち")).toEqual({ text: "坂道の途中で笑った!", note: "さかみち" });
    // A date, a fraction or a URL keeps its slash.
    expect(parseLyricLine("9/24 the night we met")).toEqual({ text: "9/24 the night we met" });
    expect(parseLyricLine("a * b")).toEqual({ text: "a * b" });
    expect(lyricsOf(JA)).toMatchObject({ stanzas: [{ lines: [{ text: "夜明けの色を覚えてる", breaks: [6] }, { emphasis: [[0, 2]] }, { text: "坂道の途中で笑った!" }] }, { lines: [{}] }] });
  });
  test("LRC: timestamps give the timing and are syntax; [ti:] and [ar:] are the title and credit; never a chat or a schedule", () => {
    const parsed = parseTemplates(LRC);
    // Lyric motion is manual: an LRC file is a document unless the user asks.
    expect(parsed.preferred).toBe("document");
    expect(parsed.candidates.has("chat")).toBe(false);
    expect(parsed.candidates.has("timeline")).toBe(false);
    expect(parsed.candidates.get("lyrics")).toEqual({ kind: "lyrics", title: "纸飞机", credit: "Peesuto", stanzas: [{ lines: [
      { text: "旧站台的白铃兰", at: 12340, until: 15800 }, { text: "从那年夏天开到现在", at: 15800, until: 19200 },
      { text: "你折好的纸飞机", at: 19200, until: 22600 }, { text: "还停在我窗前的风里", at: 22600 }] }] });
    // Repeated stamps repeat the line in time order; an empty stamp ends a stanza; word timings are dropped.
    expect(lyricsOf("[00:01.00][00:05.00]La la\n[00:03.00]<00:03.10>Hey <00:03.50>you\n[00:07.00]\n[00:08.00]Bye now")).toMatchObject({ stanzas: [
      { lines: [{ text: "La la", at: 1000 }, { text: "Hey you", at: 3000 }, { text: "La la", at: 5000, until: 7000 }] }, { lines: [{ text: "Bye now", at: 8000 }] }] });
    // A line that is not LRC in an LRC block: not lyrics at all (lyric motion reads it as prose).
    expect(parseLyrics("[00:01.00]one\n[00:02.00]two\nthree")).toBeUndefined();
    // A long LRC line is cut at its punctuation; the pieces share its time by length.
    expect(lyricsOf("[00:01.00]We walked along the river until the lights came on, and nobody said a word\n[00:09.00]Bye now")).toMatchObject({ stanzas: [{ lines: [
      { text: "We walked along the river", at: 1000 }, { at: expect.any(Number) }, { text: "and nobody said a word", until: 9000 }, { text: "Bye now", at: 9000 }] }] });
  });
  test("a classical poem is a poem card, with its title and author or an attribution", () => {
    expect(parseTemplates("床前明月光，\n疑是地上霜。\n举头望明月，\n低头思故乡。").preferred).toBe("text");
    expect(lyricsOf("床前明月光，\n疑是地上霜。\n举头望明月，\n低头思故乡。")).toMatchObject({ poem: true });
    expect(lyricsOf("静夜思\n李白\n床前明月光，疑是地上霜。\n举头望明月，低头思故乡。")).toEqual({ kind: "lyrics", title: "静夜思", credit: "李白", poem: true,
      stanzas: [{ lines: [{ text: "床前明月光，疑是地上霜。" }, { text: "举头望明月，低头思故乡。" }] }] });
    expect(lyricsOf("白日依山尽，黄河入海流。\n欲穷千里目，更上一层楼。\n—— 王之涣")).toMatchObject({ credit: "王之涣", poem: true });
    // A quoted poem with an attribution is a quote automatically, and a poem as lyric motion.
    expect(parseTemplates("春眠不觉晓，处处闻啼鸟。\n夜来风雨声，花落知多少。\n—— 孟浩然").preferred).toBe("quote");
    expect(lyricsOf("春眠不觉晓，处处闻啼鸟。\n夜来风雨声，花落知多少。\n—— 孟浩然")).toMatchObject({ credit: "孟浩然", poem: true });
  });
  test("negatives: lists, chat, schedules, code, fields and short prose are not lyric-shaped (lyric motion cuts them as prose, or marks them unfit)", () => {
    for (const text of [
      "Buy milk\nCall mom\nFix bike\nPay rent", "- one\n- two\n- three\n- four", "1. one\n2. two\n3. three",
      "Alice: hi\nBob: hello\nAlice: how are you\nBob: fine", "09:00 Doors open\n10:30 Keynote\n14:00 Workshops\n18:00 Party",
      "const a = 1;\nconst b = 2;\nconsole.log(a + b);\nexport default a;", "Name: Lin\nPhone: 13800138000\nEmail: lin@example.com",
      "Make room for a clearer thought.", "明天下午三点，老地方见。\n记得带上那本书。",
      "We shipped the release today. Thanks everyone.\nThe notes are in the wiki. Ping me with questions.\nNext week we plan the roadmap. See you then.\nIt was a long week. Rest well.",
      "https://peesuto.com\nhttps://example.com\nhttps://github.com\nhttps://x.com",
      "这是第一段比较长的说明文字，它显然不是歌词而是一段普通的文章内容，读起来像散文。\n第二段也很长，同样是普通的叙述文字。",
      "| a | b |\n|---|---|\n| 1 | 2 |",
      "Call my mom\nBuy milk for you\nPick up the kids\nWalk the dog", "Meeting notes\nAPI review\nDB migration\n\nAction items\nShip v2\nFix login",
      "会议纪要\n接口评审\n数据库迁移\n\n待办事项\n发布二版\n修复登录",
    ]) {
      expect(parseLyrics(text)).toBeUndefined();
      const content = lyricsOf(text)!;
      expect(content.kind).toBe("lyrics");
      if (/const a|\| a \||^https:/.test(text)) expect(content).toMatchObject({ unfit: "structure", stanzas: [] });
      else expect(content).toMatchObject({ prose: true });
    }
  });
  test("lyric motion is manual: every text is a candidate, rules and the model never pick it, an override does", async () => {
    const PROSE = "We shipped the release today. Thanks to everyone who tested it.";
    for (const text of [PROSE, ZH, LRC, "const a = 1;\nconsole.log(a);", "少即是多。"]) {
      const parsed = parseTemplates(text);
      expect(parsed.candidates.has("lyrics")).toBe(true);
      expect(parsed.preferred).not.toBe("lyrics");
      expect(Object.keys((buildTemplateRequest(parsed, true).questions.template as { criteria: Record<string, string> }).criteria)).not.toContain("lyrics");
    }
    const jev = decider({ template: choice("lyrics", 0.99), variant: choice("lyrics.classic", 0.99), motion: choice("reveal", 0.99) });
    expect((await decideTemplate(ZH, { ...base, decider: jev })).plan.template).not.toBe("lyrics");
    const chosen = await decideTemplate(PROSE, { ...base, override: { id: "lyrics" } });
    expect(chosen.plan).toMatchObject({ template: "lyrics", content: { kind: "lyrics", prose: true } });
    expect(chosen.availableTemplates).toContain("lyrics");
  });
  test("prose is cut at sentence ends and clause marks, short clauses kept together, long ones broken between words", () => {
    expect(splitCuts("We shipped the release today. Thanks everyone who tested it, filed bugs, and stayed late on Friday — you made this one happen."))
      .toEqual(["We shipped the release today.", "Thanks everyone who tested it,", "filed bugs,", "and stayed late on Friday —", "you made this one happen."]);
    expect(splitCuts("我们今天发布了新版本，感谢每一位参与测试、提交问题、在周五加班到深夜的朋友。没有你们，就没有这一版。"))
      .toEqual(["我们今天发布了新版本，", "感谢每一位参与测试、提交问题、", "在周五加班到深夜的朋友。", "没有你们，", "就没有这一版。"]);
    expect(splitCuts("今日は新しいバージョンをリリースしました。テストに協力してくれたみなさん、本当にありがとうございます。"))
      .toEqual(["今日は新しいバージョンを", "リリースしました。", "テストに協力してくれたみなさん、", "本当にありがとうございます。"]);
    // A slogan stays one cut; short clauses of one sentence share a cut.
    expect(splitCuts("Make room for a clearer thought.")).toEqual(["Make room for a clearer thought."]);
    expect(splitCuts("少即是多。")).toEqual(["少即是多。"]);
    expect(splitCuts("春天来了，花都开了，我们在河边走了很久。")).toEqual(["春天来了，花都开了，", "我们在河边走了很久。"]);
    // Numbers, abbreviations, URLs and emphasis are never cut.
    expect(splitCuts("It is 3.14, e.g. pi, and 1,000 is more.")).toEqual(["It is 3.14, e.g. pi,", "and 1,000 is more."]);
    for (const piece of splitCuts("Read more at https://peesuto.com/templates/lyrics/, it is fun.")) expect(piece.includes("peesuto") ? piece.includes("https://peesuto.com/templates/lyrics/") : true).toBe(true);
    expect(splitCuts("Oh, tell me *everything you remember about the summer* we spent by the sea and the long drive home.").some((p) => p.includes("*everything you remember about the summer*"))).toBe(true);
    // `/` marks are cuts of their own.
    expect(splitCuts("夜明けの色を/覚えてる")).toEqual(["夜明けの色を", "覚えてる"]);
    // Never a word split, never text lost, pieces within the cap unless one word is longer.
    const units = (t: string) => [...t].reduce((n, c) => n + (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(c) ? 1 : 0.5), 0);
    for (const line of ["The quick brown fox jumps over the lazy dog because it was bored and the afternoon was long and warm and nobody came to play.",
      "直到太阳落山的时候才想起来还没有吃晚饭而且大家都已经很累了所以我们决定明天再来这里看看", "言葉にできない気持ちを短い一行にたくしてあなたに届けたいと思っているけれど、まだ書けない。"]) {
      const pieces = splitCuts(line);
      expect(pieces.join("").replace(/\s/g, "")).toBe(line.replace(/\s/g, ""));
      for (const piece of pieces) expect(units(piece) <= CUT_MAX_UNITS || !/\s/.test(piece.trim())).toBe(true);
      if (!/\p{Script=Han}/u.test(line)) for (const piece of pieces) expect(line.includes(piece)).toBe(true);
    }
  });
  test("prose as lyric motion: paragraphs are stanzas, markup still works, nothing dropped", () => {
    const content = lyricsOf("# Launch day\nOh, *stay awake* with me tonight, and tell me everything.|a note\n\nSee you / tomorrow!")!;
    expect(content).toMatchObject({ kind: "lyrics", title: "Launch day", prose: true, stanzas: [
      { lines: [{ text: "Oh, stay awake with me tonight,", emphasis: [[4, 14]] }, { text: "and tell me everything.", note: "a note" }] },
      { lines: [{ text: "See you" }, { text: "tomorrow!" }] }] });
  });
  test("lyric motion refuses code and tables and too much text with explicit errors; prose cuts hold long enough to read", () => {
    const code = "const a = 1;\nconst b = 2;\nconsole.log(a + b);";
    expect(() => layoutTemplate(plan(code, "classic", "reveal"), measure, { format: "mp4" })).toThrow(expect.objectContaining({ code: "lyric-unfit" }));
    expect(() => layoutTemplate(plan(code, "classic", "none"), measure)).toThrow(expect.objectContaining({ code: "lyric-unfit" }));
    const essay = Array.from({ length: 12 }, (_, i) => `这是第${i + 1}句比较完整的叙述，它会占用一个画面。`).join("");
    expect(() => layoutTemplate(plan(essay), measure, { format: "mp4" })).toThrow(expect.objectContaining({ code: "lyric-too-long" }));
    // The poster holds it.
    expect(layoutTemplate(plan(essay, "classic", "none"), measure).lines.map((l) => l.text).join("")).toContain("第12句");
    const tweet = "我们今天发布了新版本，感谢每一位参与测试、提交问题、在周五加班到深夜的朋友。没有你们，就没有这一版。";
    const layout = layoutTemplate(plan(tweet), measure, { format: "mp4" }), program = layout.lyrics!;
    expect(program.cuts.length).toBeGreaterThan(3);
    expect(program.durationMs).toBeLessThanOrEqual(LYRICS_TIMING.maxMs);
    for (const cut of program.cuts) {
      const chars = cut.text.map((i) => layout.lines[i]!.text).join("").replace(/\s/g, "").length;
      expect(cut.hold).toBeGreaterThanOrEqual(Math.max(LYRICS_TIMING.minCutMs, chars * LYRICS_TIMING.proseCjkMs) - 1);
    }
  });
  test("the poster: every lyric drawn once, markup never drawn, emphasis in the accent; Paper sets CJK verse in columns", () => {
    for (const variant of ["classic", "editorial"] as const) {
      const layout = layoutTemplate(plan(JA, variant, "none"), measure);
      const drawn = layout.lines.map((l) => l.text).join("");
      expect(drawn.replace(/\s/g, "")).toBe("夜明けの色を覚えてる透明な傘をたたんで坂道の途中で笑った!まだ眠い町の灯り");
      expect(drawn).not.toMatch(/[*/|]/);
      const accent = layout.lines.find((l) => l.text === "透明")!;
      expect(accent.emphasis).toBe(true);
      expect(accent.color).not.toBe(layout.lines.find((l) => l.text.includes("たたんで"))!.color);
    }
    const poem = layoutTemplate(plan("静夜思\n李白\n床前明月光，疑是地上霜。\n举头望明月，低头思故乡。", "editorial", "none"), measure);
    // One glyph per line, in columns right to left.
    expect(poem.lines.every((l) => [...l.text].length === 1)).toBe(true);
    const x = (c: string) => poem.lines.find((l) => l.text === c)!.x;
    expect(x("床")).toBeGreaterThan(x("疑"));
    expect(x("静")).toBeGreaterThan(x("床"));
    // The comma sits in the corner of its cell, drawn offset from its box.
    expect(poem.lines.find((l) => l.text === "，")!.offset).toBeDefined();
  });
  test("the video: a cut per line and per / piece, a title card, timing within the cap, deterministic, each cut passing the checks", () => {
    for (const variant of ["classic", "editorial"] as const) {
      const p = plan(JA, variant);
      const layout = layoutTemplate(p, measure, { format: "mp4" });
      const program = layout.lyrics!;
      expect(program.cuts.length).toBe(5);
      expect(program.durationMs).toBeLessThanOrEqual(LYRICS_TIMING.maxMs);
      expect(program.cuts.map((c) => c.start)).toEqual([...program.cuts.map((c) => c.start)].sort((a, b) => a - b));
      expect(program.cuts.at(-1)!.bang || program.cuts.some((c) => c.bang)).toBe(true);
      expect(lyricsViolations(layout, program, p)).toEqual([]);
      // The same lyrics give the same video.
      expect(JSON.stringify(layoutTemplate(p, measure, { format: "mp4" }))).toBe(JSON.stringify(layout));
      // Every cut but the first changes colour.
      for (let i = 1; i < program.cuts.length; i++) expect(program.cuts[i]!.palette.bg).not.toBe(program.cuts[i - 1]!.palette.bg);
      const composition = lyricsComposition(layout, program, measure, variant);
      expect(composition.frames).toBe(Math.ceil(program.durationMs / 1000 * 30) + 1);
      expect(composition.body).not.toMatch(/\{"[*/|]"\}/);
    }
    const titled = layoutTemplate(plan(LRC), measure, { format: "mp4" }).lyrics!;
    expect(titled.cuts.length).toBe(5); // the title card and four lines
    // LRC timing: each line holds until the next timestamp (when the whole fits the cap).
    const timed = layoutTemplate(plan("[00:10.00]one line here\n[00:12.50]and the second\n[00:16.00]the third one"), measure, { format: "mp4" }).lyrics!;
    expect(timed.cuts[1]!.start - timed.cuts[0]!.start).toBe(2500 + LYRICS_MOTION.classic.transitionMs);
    expect(timed.cuts[2]!.start - timed.cuts[1]!.start).toBe(3500 + LYRICS_MOTION.classic.transitionMs);
    // Typewriter types every cut.
    expect(layoutTemplate(plan(EN, "classic", "typewriter"), measure, { format: "gif" }).lyrics!.cuts.every((c) => c.entrance === "type")).toBe(true);
  });
  test("long lyrics share screens, a GIF is capped by its frame budget, and what cannot fit is an explicit error", () => {
    const long = Array.from({ length: 14 }, (_, i) => `我唱第${i + 1}句到天亮`).join("\n");
    // An MP4 runs to 30 s: a cut per line. A GIF keeps to 14.4 s: two lines a screen.
    const program = layoutTemplate(plan(long), measure, { format: "mp4" }).lyrics!;
    expect(program.cuts.length).toBe(14);
    expect(program.durationMs).toBeLessThanOrEqual(LYRICS_TIMING.maxMs);
    const gif = layoutTemplate(plan(long), measure, { format: "gif" }).lyrics!;
    expect(gif.cuts.length).toBe(7);
    expect(gif.durationMs).toBeLessThanOrEqual(LYRICS_TIMING.gifMaxMs);
    expect(lyricsMaxMs(1080, 1920, "gif")).toBeLessThan(lyricsMaxMs(1080, 1080, "gif"));
    expect<number>(lyricsMaxMs(1080, 1080, "mp4")).toBe(LYRICS_TIMING.maxMs);
    const tall = layoutTemplate(plan(ZH, "classic", "reveal", "9:16"), measure, { format: "gif" }).lyrics!;
    expect(tall.durationMs).toBeLessThanOrEqual(lyricsMaxMs(1080, 1920, "gif"));
    const huge = Array.from({ length: 60 }, (_, i) => `我唱第${i + 1}句到天亮`).join("\n");
    expect(() => layoutTemplate(plan(huge), measure, { format: "mp4" })).toThrow(/No content was dropped/);
    expect(() => layoutTemplate(plan(huge), measure, { format: "mp4" })).toThrow(expect.objectContaining({ code: "lyric-too-long" }));
    // The PNG poster holds all of it (the canvas grows).
    expect(layoutTemplate(plan(huge, "classic", "none"), measure).lines.map((l) => l.text).join("")).toContain("我唱第60句到天亮");
  });
  test("engine paint: Stage gilds emphasis with a gradient and a glow, Paper inks it heavier; stops keep contrast; no glow on a light ground or in a GIF", () => {
    for (const pal of LYRICS_STYLES.classic.motion.palette) {
      const paint = emphasisPaint(LYRICS_STYLES.classic.engine, pal, 172, 1080, "mp4")!;
      expect(paint.gradient).toBeDefined();
      for (const stop of [paint.gradient!.from, paint.gradient!.to]) expect(contrastRatio(stop, pal.bg)).toBeGreaterThanOrEqual(3);
      // A glow is light: only where the accent is lighter than the ground.
      expect(Boolean(paint.glow)).toBe(contrastRatio(pal.accent, "#000000") > contrastRatio(pal.bg, "#000000"));
      expect(emphasisPaint(LYRICS_STYLES.classic.engine, pal, 172, 1080, "gif")!.glow).toBeUndefined();
    }
    const paper = emphasisPaint(LYRICS_STYLES.editorial.engine, LYRICS_STYLES.editorial.motion.palette[0]!, 172, 1080, "png")!;
    expect(paper).toEqual({ stroke: { width: 2, color: LYRICS_STYLES.editorial.motion.palette[0]!.accent, position: "outside" } });
    // The layout carries the paint on emphasised runs only, in poster and video alike.
    for (const [variant, motion] of [["classic", "none"], ["classic", "reveal"], ["editorial", "none"], ["editorial", "reveal"]] as const) {
      const layout = layoutTemplate(plan(JA, variant, motion), measure, { format: motion === "none" ? "png" : "mp4" });
      expect(layout.lines.filter((l) => l.paint).every((l) => l.emphasis)).toBe(true);
      expect(layout.lines.some((l) => l.paint)).toBe(true);
    }
    // The video: gradient stops animate from the ink at the punch, the entrance blurs in, the big disc is a soft radial light.
    const p = plan(JA, "classic");
    const layout = layoutTemplate(p, measure, { format: "mp4" });
    const composition = lyricsComposition(layout, layout.lyrics!, measure, "classic");
    expect(composition.body).toContain("bg-clip-text");
    expect(JSON.stringify(composition.keyframes)).toContain("gradFrom");
    expect(JSON.stringify(composition.keyframes)).toContain("\"blur\"");
    expect(lyricsViolations(layout, layout.lyrics!, p)).toEqual([]);
  });
  test("named faces: none ship, so nothing changes; a registered face in a style's slot is asked for", () => {
    expect(Object.keys(TEMPLATE_FACES)).toEqual([]);
    expect(templateFaceNames({ template: "lyrics", variant: "classic" })).toEqual([]);
    const engine = LYRICS_STYLES.classic.engine as unknown as { faces: unknown };
    TEMPLATE_FACES.display = CODE_FONT; engine.faces = { display: "display", text: "display" };
    try {
      expect(templateFaceNames({ template: "lyrics", variant: "classic" })).toEqual(["display"]);
      expect(templateFaceNames({ template: "text", variant: "classic" })).toEqual([]);
      const layout = layoutTemplate(plan(EN, "classic", "none"), measure, { faces: ["display"] });
      expect(layout.lines.filter((l) => !l.signature).every((l) => l.face === "display")).toBe(true);
      // Not measured (or lacking a glyph): the card's own pair.
      expect(layoutTemplate(plan(EN, "classic", "none"), measure).lines.some((l) => l.face)).toBe(false);
    } finally { delete TEMPLATE_FACES.display; engine.faces = null; }
  });
  test("the caps match the limits they stand for", () => {
    expect<number>(LYRICS_TIMING.gifMaxMs).toBe(TEMPLATE_SCROLL.startMs + TEMPLATE_SCROLL.maxMs + TEMPLATE_SCROLL.endMs);
    expect<number>(LYRICS_TIMING.gifFrameBudget).toBe(TEMPLATE_GIF_FRAME_BUDGET);
    expect<number>(LYRICS_TIMING.fps).toBe(TEMPLATE_LIMITS.fps);
  });
});
