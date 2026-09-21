import { describe, expect, test } from "bun:test";
import { answersToDsl, buildRequest, fallbackDsl, KIND_CONFIDENCE, MAX_EMPHASIS_WORDS, segmentWords, type Answers } from "../src/questions.ts";

const BASE: Answers = {
  kind: { choice: "quote", probabilities: { quote: 0.9, plain: 0.1 } },
  layout: { choice: "center" },
  palette: { choice: "paper" },
  scale: { score: 2 },
  tone: { score: 2 },
  animate: { noul: 0.1 },
  emphasis: { choice: "none" },
};
const answers = (o: Partial<Answers> = {}): Answers => ({ ...BASE, ...o });
const kindOf = (choice: string, p: number): Answers["kind"] => ({ choice, probabilities: { [choice]: p } });
const criteriaOf = (q: unknown): Record<string, string> => (q as { criteria: Record<string, string> }).criteria;
const TEXT = "“过早的优化是万恶之源。” —— Donald Knuth";

describe("buildRequest", () => {
  test("offers every segmented word as w<i> plus none", () => {
    const { body, words } = buildRequest(TEXT);
    expect(words).toEqual(segmentWords(TEXT));
    expect(words.length).toBeGreaterThan(0);
    const criteria = criteriaOf(body.questions.emphasis);
    expect(Object.keys(criteria)).toEqual([...words.map((_, i) => `w${i}`), "none"]);
    words.forEach((w, i) => expect(criteria[`w${i}`]).toBe(w));
    expect(criteria.none).toBeString();
    expect(body.state.clipboard).toBe(TEXT);
    expect(Object.keys(body.questions).sort()).toEqual(["animate", "emphasis", "kind", "layout", "palette", "scale", "tone"]);
  });

  test("caps the emphasis candidates at MAX_EMPHASIS_WORDS", () => {
    const many = Array.from({ length: MAX_EMPHASIS_WORDS + 50 }, (_, i) => `word${i}`).join(" ");
    const { body, words } = buildRequest(many);
    expect(words.length).toBe(MAX_EMPHASIS_WORDS);
    const keys = Object.keys(criteriaOf(body.questions.emphasis));
    expect(keys.length).toBe(MAX_EMPHASIS_WORDS + 1);
    expect(keys).toContain(`w${MAX_EMPHASIS_WORDS - 1}`);
    expect(keys).not.toContain(`w${MAX_EMPHASIS_WORDS}`);
    expect(keys.at(-1)).toBe("none");
  });

  test("segmentWords drops punctuation and whitespace", () => {
    expect(segmentWords("a, b —— c")).toEqual(["a", "b", "c"]);
    expect(segmentWords("1. 先量，再改")).toEqual(["1", "先", "量", "再", "改"]);
  });
});

describe("answersToDsl", () => {
  test("passes text and aspect through", () => {
    const { dsl } = answersToDsl(TEXT, answers(), "doc");
    expect(dsl.text).toBe(TEXT);
    expect(dsl.aspect).toBe("doc");
    expect(dsl.kind).toBe("quote");
    expect(dsl.layout).toBe("center");
    expect(dsl.palette).toBe("paper");
  });

  test("a kind below KIND_CONFIDENCE becomes plain, and the probability is reported", () => {
    const low = KIND_CONFIDENCE - 0.05;
    const { dsl, kindP } = answersToDsl(TEXT, answers({ kind: kindOf("quote", low) }), "chat");
    expect(dsl.kind).toBe("plain");
    expect(kindP).toBe(low);
    expect(answersToDsl(TEXT, answers({ kind: kindOf("quote", KIND_CONFIDENCE) }), "chat").dsl.kind).toBe("quote");
  });

  test("a kind with no probabilities counts as 0 and becomes plain", () => {
    const { dsl, kindP } = answersToDsl(TEXT, answers({ kind: { choice: "quote" } }), "chat");
    expect(dsl.kind).toBe("plain");
    expect(kindP).toBe(0);
  });

  test("event becomes plain even when confident", () => {
    expect(answersToDsl(TEXT, answers({ kind: kindOf("event", 0.97) }), "chat").dsl.kind).toBe("plain");
  });

  test("an unknown kind name becomes plain", () => {
    expect(answersToDsl(TEXT, answers({ kind: kindOf("poem", 0.97) }), "chat").dsl.kind).toBe("plain");
  });

  test("animate above 0.5 with tone 0 gets tone 1", () => {
    const { dsl } = answersToDsl(TEXT, answers({ animate: { noul: 0.8 }, tone: { score: 0 } }), "chat");
    expect(dsl.animate).toBe(true);
    expect(dsl.tone).toBe(1);
  });

  test("animate at or below 0.5 keeps the tone as scored, rounded and clamped", () => {
    const at = (noul: number, score: number) => answersToDsl(TEXT, answers({ animate: { noul }, tone: { score } }), "chat").dsl;
    expect(at(0.5, 0)).toMatchObject({ animate: false, tone: 0 });
    expect(at(0.2, 2.4)).toMatchObject({ animate: false, tone: 2 });
    expect(at(0.2, 1.5)).toMatchObject({ animate: false, tone: 2 });
    expect(at(0.2, 3.7)).toMatchObject({ animate: false, tone: 3 });
    expect(at(0.2, -0.4)).toMatchObject({ animate: false, tone: 0 });
    expect(at(0.9, 2.6)).toMatchObject({ animate: true, tone: 3 });
  });

  test("emphasis: none → -1, w7 → 7, garbage → -1", () => {
    const at = (choice: string) => answersToDsl(TEXT, answers({ emphasis: { choice } }), "chat").dsl.emphasis;
    expect(at("none")).toBe(-1);
    expect(at("w7")).toBe(7);
    expect(at("w0")).toBe(0);
    expect(at("garbage")).toBe(-1);
    expect(at("w")).toBe(-1);
    expect(at("7")).toBe(-1);
    expect(at("w-1")).toBe(-1);
    expect(at("")).toBe(-1);
  });

  test("scale is rounded and clamped to 0..3", () => {
    const at = (score: number) => answersToDsl(TEXT, answers({ scale: { score } }), "chat").dsl.scale;
    expect(at(2.6)).toBe(3);
    expect(at(-1)).toBe(0);
    expect(at(9)).toBe(3);
    expect(at(1.2)).toBe(1);
  });

  test("an unknown layout or palette falls back to left / ink", () => {
    const { dsl } = answersToDsl(TEXT, answers({ layout: { choice: "diagonal" }, palette: { choice: "neon" } }), "chat");
    expect(dsl.layout).toBe("left");
    expect(dsl.palette).toBe("ink");
  });
});

describe("fallbackDsl", () => {
  const always = { kind: "plain", palette: "ink", tone: 0, emphasis: -1, animate: false } as const;

  test("short text: centred and huge", () => {
    const dsl = fallbackDsl("你好，世界", "chat");
    expect(dsl).toMatchObject({ ...always, layout: "center", scale: 3, aspect: "chat", text: "你好，世界" });
  });

  test("multi-line text is left-aligned", () => {
    expect(fallbackDsl("a\nb", "doc")).toMatchObject({ ...always, layout: "left", scale: 3, aspect: "doc" });
  });

  test("long text: left-aligned and small", () => {
    const long = "确".repeat(161);
    expect(fallbackDsl(long, "social")).toMatchObject({ ...always, layout: "left", scale: 0 });
  });

  test("scale steps at 20, 60 and 160 characters; layout at 60", () => {
    const at = (n: number) => fallbackDsl("字".repeat(n), "chat");
    expect(at(20)).toMatchObject({ scale: 3, layout: "center" });
    expect(at(21)).toMatchObject({ scale: 2, layout: "center" });
    expect(at(60)).toMatchObject({ scale: 2, layout: "center" });
    expect(at(61)).toMatchObject({ scale: 1, layout: "left" });
    expect(at(160)).toMatchObject({ scale: 1, layout: "left" });
    expect(at(161)).toMatchObject({ scale: 0, layout: "left" });
  });

  test("surrounding whitespace does not count", () => {
    expect(fallbackDsl("  hi  \n", "chat")).toMatchObject({ layout: "center", scale: 3 });
  });
});
