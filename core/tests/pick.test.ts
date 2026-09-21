import { describe, expect, test } from "bun:test";
import { heuristicRank, HALF_LIFE_MS, recency, shouldPasteFor } from "../src/pick/heuristic.ts";
import { pick } from "../src/pick/index.ts";
import { buildPickRequest, MAX_PICK_CANDIDATES } from "../src/pick/question.ts";
import { formatBytes, summarizeContext, summarizeItem } from "../src/pick/summarize.ts";
import { CONTEXT_CHARS, PickError, type ClipItem, type Context, type PickAnswers, type PickDecider } from "../src/pick/types.ts";

const NOW = 1_800_000_000_000;
const SAFARI = "com.apple.Safari", SLACK = "com.tinyspeck.slackmacgap";

const item = (id: string, o: Partial<ClipItem> & { ageS?: number } = {}): ClipItem => {
  const { ageS = 0, ...rest } = o;
  const text = rest.text ?? `text ${id}`;
  return { id, kind: "text", text, preview: text, appBundleId: SAFARI, createdAt: NOW - ageS * 1000, ...rest };
};
const ctx = (o: Partial<Context> = {}): Context => ({ level: 2, appBundleId: SLACK, appName: "Slack", role: "AXTextArea", label: "Message #general", before: "here it is: ", after: "", ...o });
const stub = (answers: PickAnswers | null): PickDecider => ({ name: "stub", ask: async () => answers });
const throwing: PickDecider = { name: "down", ask: async () => { throw new Error("network: ECONNREFUSED"); } };
const criteriaOf = (q: unknown): Record<string, string> => (q as { criteria: Record<string, string> }).criteria;
const ids = (r: { ranked: readonly { item: ClipItem }[] }) => r.ranked.map((x) => x.item.id);

describe("summarizeItem", () => {
  test("collapses whitespace and strips control characters", () => {
    expect(summarizeItem(item("a", { text: "  first\n\n  second\t third \r\n" }))).toBe("first second third");
  });

  test("truncates to maxChars code points with an ellipsis", () => {
    const long = "word ".repeat(40).trim();
    const s = summarizeItem(item("a", { text: long }));
    expect([...s].length).toBeLessThanOrEqual(80);
    expect(s.endsWith("…")).toBe(true);
    expect(summarizeItem(item("a", { text: long }), 20).length).toBeLessThanOrEqual(20);
    expect(summarizeItem(item("a", { text: "short" }))).toBe("short");
  });

  test("counts code points, not UTF-16 units", () => {
    const cjk = "字".repeat(80);
    expect(summarizeItem(item("a", { text: cjk }))).toBe(cjk);
    const emoji = "😀".repeat(81);
    const s = summarizeItem(item("a", { text: emoji }));
    expect([...s].length).toBe(80);
    expect(s.endsWith("…")).toBe(true);
  });

  test("tags images with their size, files with their name", () => {
    expect(summarizeItem({ id: "i", kind: "image", preview: "", createdAt: NOW, bytes: 1_234_567 })).toBe("[image 1.2 MB]");
    expect(summarizeItem({ id: "i", kind: "image", preview: "1440×900", createdAt: NOW, bytes: 340_000 })).toBe("[image 340 kB] 1440×900");
    expect(summarizeItem({ id: "i", kind: "image", preview: "", createdAt: NOW })).toBe("[image]");
    expect(summarizeItem({ id: "f", kind: "file", preview: "/Users/nya/Downloads/report.pdf", createdAt: NOW })).toBe("[file report.pdf]");
    expect(summarizeItem({ id: "f", kind: "file", preview: "report.pdf", createdAt: NOW })).toBe("[file report.pdf]");
    expect(summarizeItem(item("r", { kind: "rtf", text: "bold   words" }))).toBe("[rtf] bold words");
    expect(summarizeItem(item("h", { kind: "html", text: "<b>x</b>" }))).toBe("[html] <b>x</b>");
  });

  test("empty text reads as (empty); preview stands in for missing text", () => {
    expect(summarizeItem(item("e", { text: "   " }))).toBe("(empty)");
    const noText: ClipItem = { id: "p", kind: "text", preview: "only a preview", createdAt: NOW };
    expect(summarizeItem(noText)).toBe("only a preview");
  });

  test("formatBytes uses decimal units", () => {
    expect(formatBytes(12)).toBe("12 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1000)).toBe("1 kB");
    expect(formatBytes(2_500_000)).toBe("2.5 MB");
    expect(formatBytes(3e9)).toBe("3.0 GB");
  });
});

describe("summarizeContext", () => {
  test("grows with the level", () => {
    expect(summarizeContext(ctx({ level: 0 }))).toBe("Slack");
    expect(summarizeContext(ctx({ level: 1 }))).toBe("Slack · AXTextArea “Message #general”");
    expect(summarizeContext(ctx({ level: 2 }))).toBe("Slack · AXTextArea “Message #general” · …here it is:|…");
  });

  test("falls back to the bundle id and a ? role", () => {
    expect(summarizeContext(ctx({ level: 1, appName: undefined, role: undefined, label: undefined }))).toBe(`${SLACK} · ?`);
  });

  test("caps each side of the caret", () => {
    const s = summarizeContext(ctx({ before: "b".repeat(100), after: "a".repeat(100) }), 10);
    expect(s.endsWith(`…${"b".repeat(10)}|${"a".repeat(10)}…`)).toBe(true);
  });
});

describe("buildPickRequest", () => {
  const three = [item("x"), item("y", { ageS: 60 }), item("z", { ageS: 120 })];

  test("L0 state has only the app and the candidates", () => {
    const { body, ids } = buildPickRequest(ctx({ level: 0 }), three);
    expect(Object.keys(body.state).sort()).toEqual(["app", "candidates"]);
    expect(body.state.app).toBe("Slack");
    expect(body.state.candidates).toEqual([{ i: 0, summary: "text x" }, { i: 1, summary: "text y" }, { i: 2, summary: "text z" }]);
    expect(ids).toEqual(["x", "y", "z"]);
  });

  test("L1 adds role and label but never the caret text", () => {
    const { body } = buildPickRequest(ctx({ level: 1 }), three);
    expect(Object.keys(body.state).sort()).toEqual(["app", "candidates", "label", "role"]);
    expect(body.state.role).toBe("AXTextArea");
    expect(body.state.label).toBe("Message #general");
    expect(body.state.before).toBeUndefined();
    expect(body.state.after).toBeUndefined();
  });

  test("L2 adds before and after, capped at CONTEXT_CHARS nearest the caret", () => {
    const { body } = buildPickRequest(ctx({ before: "x".repeat(300) + "END", after: "START" + "y".repeat(300) }), three);
    expect(body.state.before?.length).toBe(CONTEXT_CHARS);
    expect(body.state.before?.endsWith("END")).toBe(true);
    expect(body.state.after?.length).toBe(CONTEXT_CHARS);
    expect(body.state.after?.startsWith("START")).toBe(true);
    expect(buildPickRequest(ctx({ before: "ab", after: "" }), three).body.state).toMatchObject({ before: "ab", after: "" });
  });

  test("bundle id stands in for a missing app name", () => {
    expect(buildPickRequest(ctx({ level: 0, appName: undefined }), three).body.state.app).toBe(SLACK);
  });

  test("questions: a choice over c<i> plus none, and a noul", () => {
    const { body } = buildPickRequest(ctx(), three);
    expect(Object.keys(body.questions)).toEqual(["pick", "paste"]);
    const pickQ = body.questions.pick as { type: string; instructions: string };
    const pasteQ = body.questions.paste as { type: string; criteria: Record<string, string> };
    expect(pickQ.type).toBe("choice");
    expect(pickQ.instructions).toBeString();
    expect(Object.keys(criteriaOf(body.questions.pick))).toEqual(["c0", "c1", "c2", "none"]);
    expect(criteriaOf(body.questions.pick).c1).toBe(summarizeItem(three[1]!));
    expect(pasteQ.type).toBe("noul");
    expect(Object.keys(pasteQ.criteria).sort()).toEqual(["false", "true"]);
  });

  test("caps the candidates at MAX_PICK_CANDIDATES, or at the option", () => {
    const many = Array.from({ length: MAX_PICK_CANDIDATES + 4 }, (_, i) => item(`m${i}`, { ageS: i }));
    const { body, ids } = buildPickRequest(ctx(), many);
    expect(ids.length).toBe(MAX_PICK_CANDIDATES);
    expect(ids[0]).toBe("m0");
    expect(Object.keys(criteriaOf(body.questions.pick)).length).toBe(MAX_PICK_CANDIDATES + 1);
    expect(Object.keys(criteriaOf(body.questions.pick)).at(-1)).toBe("none");
    expect(buildPickRequest(ctx(), many, { maxCandidates: 3 }).ids).toEqual(["m0", "m1", "m2"]);
  });

  test("summaryChars shortens the criteria", () => {
    const { body } = buildPickRequest(ctx(), [item("l", { text: "a".repeat(100) })], { summaryChars: 10 });
    expect(criteriaOf(body.questions.pick).c0?.length).toBe(10);
  });

  test("a secure context throws PickError before anything is summarised", () => {
    expect(() => buildPickRequest(ctx({ secure: true }), three)).toThrow(PickError);
    expect(() => buildPickRequest(ctx({ secure: true, level: 0 }), [])).toThrow("secure field");
  });
});

describe("heuristicRank", () => {
  test("recency halves every HALF_LIFE_MS", () => {
    expect(recency(0)).toBe(1);
    expect(recency(HALF_LIFE_MS)).toBeCloseTo(0.5);
    expect(recency(2 * HALF_LIFE_MS)).toBeCloseTo(0.25);
    expect(recency(-5000)).toBe(1);
  });

  test("recent beats old", () => {
    const r = heuristicRank(ctx(), [item("old", { ageS: 600 }), item("new", { ageS: 5 })], NOW);
    expect(ids(r)).toEqual(["new", "old"]);
    expect(r.ranked[0]!.reason).toMatch(/^recency 0\.99/);
  });

  test("text beats a newer image in a single-line field, not in a text area", () => {
    const image: ClipItem = { id: "img", kind: "image", preview: "1440×900", createdAt: NOW - 10_000, bytes: 1e6, appBundleId: SAFARI };
    const text = item("txt", { ageS: 300 });
    expect(ids(heuristicRank(ctx({ role: "AXTextField" }), [image, text], NOW))).toEqual(["txt", "img"]);
    expect(ids(heuristicRank(ctx({ role: "AXTextArea" }), [image, text], NOW))).toEqual(["img", "txt"]);
    expect(heuristicRank(ctx({ role: "AXTextField" }), [image], NOW).ranked[0]!.reason).toContain("image in a line field −0.50");
  });

  test("long text is penalised in a single-line field only", () => {
    const long = item("long", { text: "x".repeat(201), ageS: 10 });
    const short = item("short", { text: "x".repeat(200), ageS: 120 });
    expect(ids(heuristicRank(ctx({ role: "AXTextField" }), [long, short], NOW))).toEqual(["short", "long"]);
    expect(ids(heuristicRank(ctx({ role: "AXTextArea" }), [long, short], NOW))).toEqual(["long", "short"]);
    expect(heuristicRank(ctx({ role: "AXTextField" }), [long], NOW).ranked[0]!.reason).toContain("long text in a single-line field −0.30");
  });

  test("a file is penalised in a web area", () => {
    const file: ClipItem = { id: "f", kind: "file", preview: "report.pdf", createdAt: NOW - 10_000, appBundleId: SAFARI };
    const text = item("t", { ageS: 60 });
    expect(ids(heuristicRank(ctx({ role: "AXWebArea" }), [file, text], NOW))).toEqual(["t", "f"]);
    expect(heuristicRank(ctx({ role: "AXWebArea" }), [file], NOW).ranked[0]!.reason).toContain("file in a web area −0.20");
  });

  test("pinned and cross-app items get their nudges", () => {
    const r = heuristicRank(ctx({ level: 0 }), [item("same", { appBundleId: SLACK }), item("other", { appBundleId: SAFARI }), item("pinned", { appBundleId: SAFARI, pinned: true })], NOW);
    expect(ids(r)).toEqual(["pinned", "other", "same"]);
    expect(r.ranked[0]!.reason).toContain("pinned +0.10");
    expect(r.ranked[1]!.reason).toContain("cross-app +0.15");
    expect(r.ranked[2]!.reason).not.toContain("cross-app");
  });

  test("shouldPaste by level and role", () => {
    expect(shouldPasteFor(ctx({ level: 0 }))).toBe(0.5);
    expect(shouldPasteFor(ctx({ level: 1, role: "AXTextField" }))).toBe(0.7);
    expect(shouldPasteFor(ctx({ level: 2, role: "AXTextArea" }))).toBe(0.7);
    expect(shouldPasteFor(ctx({ level: 1, role: "AXCell" }))).toBe(0.7);
    expect(shouldPasteFor(ctx({ level: 1, role: "AXWebArea" }))).toBe(0.5);
    expect(shouldPasteFor(ctx({ level: 1, role: undefined }))).toBe(0.1);
    expect(shouldPasteFor(ctx({ level: 2, role: "AXStaticText" }))).toBe(0.1);
    expect(heuristicRank(ctx({ level: 0 }), [], NOW)).toEqual({ ranked: [], shouldPaste: 0.5 });
  });
});

describe("pick", () => {
  const five = [item("c0"), item("c1", { ageS: 30 }), item("c2", { ageS: 60 }), item("c3", { ageS: 90 }), item("c4", { ageS: 120 })];
  const prefer = (key: string, p: number, extra: PickAnswers = {}): PickAnswers => {
    const probabilities: Record<string, number> = { none: 0.02 };
    for (let i = 0; i < 5; i++) probabilities[`c${i}`] = (1 - p - 0.02) / 4;
    probabilities[key] = p;
    return { pick: { choice: key, probabilities }, paste: { noul: 0.8 }, ...extra };
  };

  test("no decider: heuristic order, source heuristic, question attached", async () => {
    const r = await pick(ctx(), five, null, { now: NOW });
    expect(r.source).toBe("heuristic");
    expect(ids(r)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    expect(r.shouldPaste).toBe(0.7);
    expect(r.question?.state.app).toBe("Slack");
    expect(Object.keys(r.question?.questions ?? {})).toEqual(["pick", "paste"]);
  });

  test("a decider preferring c2 puts it first and reports the probability", async () => {
    const r = await pick(ctx(), five, stub(prefer("c2", 0.8)), { now: NOW });
    expect(r.source).toBe("decider");
    expect(ids(r)[0]).toBe("c2");
    expect(r.ranked[0]!.reason).toMatch(/^decider 0\.80 · recency/);
    expect(r.shouldPaste).toBeCloseTo(0.8 * 0.98);
    // the heuristic still orders the rest
    expect(ids(r).slice(1)).toEqual(["c0", "c1", "c3", "c4"]);
  });

  test("a decider that throws falls back to the heuristic", async () => {
    const r = await pick(ctx(), five, throwing, { now: NOW });
    expect(r.source).toBe("heuristic");
    expect(ids(r)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    expect(r.shouldPaste).toBe(0.7);
  });

  test("a null answer or an answer without pick falls back too", async () => {
    expect((await pick(ctx(), five, stub(null), { now: NOW })).source).toBe("heuristic");
    expect((await pick(ctx(), five, stub({ paste: { noul: 0.9 } }), { now: NOW })).source).toBe("heuristic");
    expect((await pick(ctx(), five, stub({ pick: {} }), { now: NOW })).source).toBe("heuristic");
  });

  test("none at 0.9 drops shouldPaste below 0.3", async () => {
    const answers: PickAnswers = { pick: { choice: "none", probabilities: { none: 0.9, c0: 0.05, c1: 0.05 } }, paste: { noul: 0.9 } };
    const r = await pick(ctx(), five, stub(answers), { now: NOW });
    expect(r.source).toBe("decider");
    expect(r.shouldPaste).toBeLessThan(0.3);
    expect(r.shouldPaste).toBeCloseTo(0.09);
  });

  test("shouldPaste comes from the paste noul, the heuristic when it is missing", async () => {
    expect((await pick(ctx(), five, stub(prefer("c0", 0.9, { paste: { noul: 0.35 } })), { now: NOW })).shouldPaste).toBeCloseTo(0.35 * 0.98);
    const noNoul: PickAnswers = { pick: { choice: "c0", probabilities: { c0: 1 } } };
    expect((await pick(ctx({ level: 0 }), five, stub(noNoul), { now: NOW })).shouldPaste).toBe(0.5);
  });

  test("a choice without probabilities counts as certainty", async () => {
    const r = await pick(ctx(), five, stub({ pick: { choice: "c3" } }), { now: NOW });
    expect(ids(r)[0]).toBe("c3");
    expect(r.source).toBe("decider");
  });

  test("candidates missing from the probabilities score 0 from the decider", async () => {
    const r = await pick(ctx(), five, stub({ pick: { choice: "c4", probabilities: { c4: 0.6, c3: 0.4 } } }), { now: NOW });
    expect(ids(r).slice(0, 2)).toEqual(["c4", "c3"]);
    expect(r.ranked[2]!.reason).toMatch(/^decider 0\.00/);
  });

  test("excluded items are dropped and never asked about", async () => {
    let seen: string[] = [];
    const spy: PickDecider = { name: "spy", ask: async (body) => { seen = Object.keys(criteriaOf(body.questions.pick)); return null; } };
    const r = await pick(ctx(), [item("ok"), item("secret", { excluded: true }), item("ok2", { ageS: 5 })], spy, { now: NOW });
    expect(ids(r)).toEqual(["ok", "ok2"]);
    expect(seen).toEqual(["c0", "c1", "none"]);
  });

  test("candidates past the cap are still ranked, by heuristic only", async () => {
    const many = Array.from({ length: 10 }, (_, i) => item(`m${i}`, { ageS: i * 10 }));
    const r = await pick(ctx(), many, stub({ pick: { choice: "c7", probabilities: { c7: 1 } } }), { now: NOW });
    expect(r.ranked.length).toBe(10);
    expect(ids(r)[0]).toBe("m7");
    expect(r.ranked.find((x) => x.item.id === "m9")!.reason).toMatch(/^not asked/);
  });

  test("no candidates: nothing asked, empty ranking", async () => {
    const r = await pick(ctx(), [], throwing, { now: NOW });
    expect(r).toMatchObject({ ranked: [], shouldPaste: 0.7, source: "heuristic" });
  });

  test("a secure context throws PickError even with a decider", async () => {
    await expect(pick(ctx({ secure: true }), five, stub(prefer("c0", 0.9)), { now: NOW })).rejects.toThrow(PickError);
  });
});
