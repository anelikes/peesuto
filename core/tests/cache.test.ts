import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerKey, cachedProvider, canonicalJson } from "../src/provider/cache.ts";
import type { Provider } from "../src/provider/index.ts";
import { buildRequest, type JevRequest } from "../src/questions.ts";

const answers = (n: number) => ({ kind: { choice: "plain", probabilities: { plain: 0.9 } }, layout: { choice: "left" }, palette: { choice: "ink" }, scale: { score: n }, tone: { score: 0 }, animate: { noul: 0 }, emphasis: { choice: "none" } });

/** A pick-shaped request: no clipboard, a candidate set as choice criteria. */
const pick = (state: Record<string, unknown>, candidates: string[]): JevRequest => ({
  state: state as never,
  questions: {
    pick: { type: "choice", instructions: "Which candidate?", criteria: Object.fromEntries([...candidates.map((c, i) => [`c${i}`, c]), ["none", "none fit"]]) },
    here: { type: "noul", instructions: "Paste here?", criteria: { true: "yes", false: "no" } },
  },
});

describe("canonicalJson", () => {
  test("sorts keys at every level and drops undefined like JSON.stringify", () => {
    expect(canonicalJson({ b: [{ z: 1, y: undefined, x: 2 }], a: "s", u: undefined })).toBe('{"a":"s","b":[{"x":2,"z":1}]}');
    expect(canonicalJson([undefined, null, 1])).toBe("[null,null,1]");
  });
});

describe("answer cache", () => {
  test("same text → same key; different text or question set → different key", () => {
    const a = buildRequest("一段文字").body, b = buildRequest("一段文字").body, c = buildRequest("另一段").body;
    expect(answerKey(a)).toBe(answerKey(b));
    expect(answerKey(a)).not.toBe(answerKey(c));
    expect(answerKey({ ...a, questions: { ...a.questions, extra: {} } })).not.toBe(answerKey(a));
  });
  test("the whole state counts, in any key order; a card and a pick never collide", () => {
    const s1 = pick({ app: "com.tinyspeck.slackmacgap", role: "AXTextArea", before: "hi " }, ["a", "b"]);
    const s1b = pick({ before: "hi ", role: "AXTextArea", app: "com.tinyspeck.slackmacgap" }, ["a", "b"]);
    const s2 = pick({ app: "com.apple.Notes", role: "AXTextArea", before: "hi " }, ["a", "b"]);
    expect(answerKey(s1)).toBe(answerKey(s1b));
    expect(answerKey(s1)).not.toBe(answerKey(s2));
    expect(answerKey(s1)).not.toBe(answerKey(buildRequest("hi ").body));
  });
  test("a different candidate set (choice criteria) is a different key, same question names", () => {
    const state = { app: "x", role: "AXTextField" };
    expect(answerKey(pick(state, ["a", "b"]))).not.toBe(answerKey(pick(state, ["a", "b", "c"])));
    expect(answerKey(pick(state, ["a", "b"]))).toBe(answerKey(pick(state, ["a", "b"])));
  });
  test("first answer is kept, fresh asks again, none-answers are not cached", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-cache-"));
    let calls = 0;
    const inner: Provider = { name: "stub", ask: async () => (calls++ , calls > 2 ? null : answers(calls)) };
    const body = buildRequest("cached text").body;
    const p = cachedProvider(inner, dir);
    expect(await p.ask(body)).toEqual(answers(1));
    expect(await p.ask(body)).toEqual(answers(1));
    expect(calls).toBe(1);
    expect(await cachedProvider(inner, dir, { fresh: true }).ask(body)).toEqual(answers(2));
    expect(await p.ask(body)).toEqual(answers(2));
    expect(calls).toBe(2);
    const nothing = buildRequest("uncached").body;
    expect(await cachedProvider(inner, dir).ask(nothing)).toBeNull();
    expect((await readdir(dir)).length).toBe(1);
  });
});
