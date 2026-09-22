import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classify } from "../src/render/classify.ts";

const CORPUS = join(import.meta.dir, "../fixtures/corpus");

/** What the slug says a sample is; `date` has no template and counts as plain, `event` is never produced. */
function expectedKind(f: string): string | null {
  const g = /^\d+-([a-z]+)-/.exec(f)?.[1] ?? "";
  return ({ chat: "plain", para: "plain", url: "plain", log: "plain", poem: "plain", tweet: "plain", email: "plain", address: "plain", markdown: "plain", date: "plain", code: "code", list: "list", quote: "quote", stat: "stat" } as Record<string, string>)[g] ?? null;
}

describe("classify", () => {
  test("one-liners", () => {
    expect(classify("https://example.com/a/b?c=1")).toBe("plain");
    expect(classify("本季度活跃用户增长了 37%，是过去三年最快的一次。")).toBe("stat");
    expect(classify("The new picker in v2 answers 3x faster than v1.")).toBe("stat");
    expect(classify("剪贴板是最常用却最少被设计的功能。")).toBe("plain");
  });
  test("code by fence, trace, braces or symbol density", () => {
    expect(classify("```js\nconsole.log(1)\n```")).toBe("code");
    expect(classify("Traceback (most recent call last):\n  File \"a.py\", line 1\nValueError: x")).toBe("code");
    expect(classify('{"a": 1, "b": [1, 2]}')).toBe("code");
    expect(classify("const a = 1;\nconst b = a + 1;\nexport { b };")).toBe("code");
  });
  test("lists need three marked lines", () => {
    expect(classify("- one\n- two\n- three")).toBe("list");
    expect(classify("1、确认范围\n2、写周报\n3、发出去")).toBe("list");
    expect(classify("- one\n- two")).not.toBe("list");
  });
  test("quotes carry an attribution or closing marks", () => {
    expect(classify("“其实地上本没有路，走的人多了，也便成了路。” —— 鲁迅")).toBe("quote");
    expect(classify('"Good design is as little design as possible." -- Dieter Rams')).toBe("quote");
    expect(classify("先量，再改；一次只改一个变量。")).toBe("plain");
  });
  test("the corpus: at least 85% of the scorable samples, by slug", () => {
    const files = readdirSync(CORPUS).filter((f) => f.endsWith(".txt"));
    let right = 0, total = 0;
    const wrong: string[] = [];
    for (const f of files) {
      const want = expectedKind(f);
      if (!want) continue;
      total++;
      const got = classify(readFileSync(join(CORPUS, f), "utf8"));
      if (got === want) right++; else wrong.push(`${f}: ${want} → ${got}`);
    }
    expect(total).toBeGreaterThan(60);
    expect(right / total, wrong.join("\n")).toBeGreaterThanOrEqual(0.85);
  });
});
