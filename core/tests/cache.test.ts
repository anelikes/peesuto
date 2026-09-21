import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerKey, cachedProvider } from "../src/provider/cache.ts";
import type { Provider } from "../src/provider/types.ts";
import { buildRequest } from "../src/questions.ts";

const answers = (n: number) => ({ kind: { choice: "plain", probabilities: { plain: 0.9 } }, layout: { choice: "left" }, palette: { choice: "ink" }, scale: { score: n }, tone: { score: 0 }, animate: { noul: 0 }, emphasis: { choice: "none" } });

describe("answer cache", () => {
  test("same text → same key; different text or question set → different key", () => {
    const a = buildRequest("一段文字").body, b = buildRequest("一段文字").body, c = buildRequest("另一段").body;
    expect(answerKey(a)).toBe(answerKey(b));
    expect(answerKey(a)).not.toBe(answerKey(c));
    expect(answerKey({ ...a, questions: { ...a.questions, extra: {} } })).not.toBe(answerKey(a));
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
