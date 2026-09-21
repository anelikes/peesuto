/**
 * The composer's pure parts: what a quote splits into, which number a stat
 * makes its hero, which scripts are refused, how text is normalised, wrapped
 * and cut. None of this needs the engine.
 */
import { describe, expect, test } from "bun:test";
import {
  ComposeError, cutAtBoundary, hardWrapLine, LIST_MARKER, normalizeText, pickHeroNumber, splitQuote, truncateLines, unsupportedScript,
} from "../src/render/compose.ts";

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);
const NBSP = cp(0xa0), ZWSP = cp(0x200b), ZWJ = cp(0x200d), BEL = cp(7), LS = cp(0x2028), BOM = cp(0xfeff);

describe("unsupportedScript", () => {
  test("names the scripts the face has no glyphs for", () => {
    expect(unsupportedScript("مرحبا بالعالم")).toBe("Arabic");
    expect(unsupportedScript("שלום עולם")).toBe("Hebrew");
    expect(unsupportedScript("สวัสดีชาวโลก")).toBe("Thai");
    expect(unsupportedScript("नमस्ते दुनिया")).toBe("Devanagari");
    expect(unsupportedScript("안녕하세요")).toBe("Hangul");
    expect(unsupportedScript("mostly latin, one word: שלום")).toBe("Hebrew");
  });
  test("passes CJK, Latin, Greek, Cyrillic and Japanese", () => {
    for (const t of ["确定性不是靠 lint 扫出来的", "plain english", "Ελληνικά", "Кириллица", "ひらがなカタカナ漢字", "繁體中文", "🎉 emoji"]) {
      expect(unsupportedScript(t)).toBeUndefined();
    }
  });
});

describe("normalizeText", () => {
  test("CRLF, CR and Unicode line separators become LF", () => {
    expect(normalizeText("a\r\nb\rc" + LS + "d", "plain")).toBe("a\nb\nc\nd");
  });
  test("tabs become four spaces in code and two elsewhere", () => {
    expect(normalizeText("\tx", "code")).toBe("    x");
    expect(normalizeText("a\tb", "plain")).toBe("a  b");
  });
  test("NBSP and other space separators become a plain space", () => {
    expect(normalizeText(`a${NBSP}b`, "plain")).toBe("a b");
  });
  test("control, zero-width and BOM characters are dropped", () => {
    expect(normalizeText(`${BOM}a${BEL}b${ZWSP}c`, "plain")).toBe("abc");
  });
  test("the ZWJ inside an emoji family survives", () => {
    const family = `👨${ZWJ}👩${ZWJ}👧`;
    expect(normalizeText(`we ${family}`, "plain")).toBe(`we ${family}`);
  });
  test("lone surrogates are dropped", () => {
    expect(normalizeText("a" + "\ud83d" + "b", "plain")).toBe("ab");
  });
  test("trailing whitespace per line goes and blank runs collapse", () => {
    expect(normalizeText("a  \n\n\n\nb \n", "plain")).toBe("a\n\nb\n");
  });
  test("is the identity on the five fixture texts", () => {
    for (const t of [
      "“过早的优化是万恶之源。” —— Donald Knuth",
      "本季度活跃用户增长了 37%，是过去三年最快的一次。",
      "1. 先量，再改\n2. 一次只改一个变量\n3. 把结果写进 baseline\n4. 让 CI 在另一台机器上复现",
      "const digest = await trace(comp, { frames: 60 });\nif (digest !== baseline) {\n  throw new Error(\"frame moved: \" + digest);\n}",
      "确定性不是靠 lint 扫出来的，是把能动像素的每一个输入都写进声明里，然后在另一台机器上把同一张图算出来。",
    ]) expect(normalizeText(t, t.startsWith("const") ? "code" : "plain")).toBe(t);
  });
});

describe("splitQuote", () => {
  test("the quote fixture: dash after the closing mark", () => {
    expect(splitQuote("“过早的优化是万恶之源。” —— Donald Knuth")).toEqual({ body: "过早的优化是万恶之源。", attribution: "Donald Knuth" });
  });
  test("em dash, double hyphen and single hyphen after a closing quote", () => {
    expect(splitQuote("\"We are what we repeatedly do.\" — Will Durant")).toEqual({ body: "We are what we repeatedly do.", attribution: "Will Durant" });
    expect(splitQuote("\"Less, but better.\" -- Dieter Rams")).toEqual({ body: "Less, but better.", attribution: "Dieter Rams" });
    expect(splitQuote("\"Simplicity is prerequisite for reliability.\" - Dijkstra")).toEqual({ body: "Simplicity is prerequisite for reliability.", attribution: "Dijkstra" });
  });
  test("an attribution on its own line", () => {
    expect(splitQuote("一个人只拥有此生此世是不够的，他还应该拥有诗意的世界。\n—— 王小波")).toEqual({ body: "一个人只拥有此生此世是不够的，他还应该拥有诗意的世界。", attribution: "王小波" });
  });
  test("a dash after a sentence end, without quote marks", () => {
    expect(splitQuote("Stay hungry, stay foolish. — Steve Jobs")).toEqual({ body: "Stay hungry, stay foolish.", attribution: "Steve Jobs" });
  });
  test("a dash inside the body is prose, not an attribution", () => {
    expect(splitQuote("“天才就是百分之一的灵感——加上百分之九十九的汗水。”")).toEqual({ body: "天才就是百分之一的灵感——加上百分之九十九的汗水。", attribution: "" });
    expect(splitQuote("路漫漫其修远兮——吾将上下而求索")).toEqual({ body: "路漫漫其修远兮——吾将上下而求索", attribution: "" });
  });
  test("an inner dash and a real attribution at the end coexist", () => {
    const r = splitQuote("\"Programs must be written for people to read — and only incidentally for machines to execute.\" — Abelson");
    expect(r.attribution).toBe("Abelson");
    expect(r.body).toBe("Programs must be written for people to read — and only incidentally for machines to execute.");
  });
  test("a tail longer than a name is not an attribution", () => {
    const tail = "a".repeat(41);
    expect(splitQuote(`“short.” —— ${tail}`).attribution).toBe("");
  });
  test("corner brackets are stripped too", () => {
    expect(splitQuote("「先量，再改。」——某位工程师")).toEqual({ body: "先量，再改。", attribution: "某位工程师" });
  });
});

describe("pickHeroNumber", () => {
  test("the stat fixture keeps its exact split", () => {
    expect(pickHeroNumber("本季度活跃用户增长了 37%，是过去三年最快的一次。")).toEqual({ hero: "37%", rest: "本季度活跃用户增长了 ，是过去三年最快的一次。" });
  });
  test("the first number with a unit wins over earlier plain numbers", () => {
    expect(pickHeroNumber("Since 2019 retention has risen to 62% of the cohort.")?.hero).toBe("62%");
    expect(pickHeroNumber("3 teams shipped 37%, 1.2万, $4,000 and 3x this quarter")?.hero).toBe("37%");
  });
  test("without a unit the largest number wins", () => {
    expect(pickHeroNumber("We raised $4,000 in 3 days from 41 people.")).toEqual({ hero: "$4,000", rest: "We raised in 3 days from 41 people." });
  });
  test("units: 万, 亿, 倍, x, k, M", () => {
    expect(pickHeroNumber("日活突破 1.2万，创新高。")?.hero).toBe("1.2万");
    expect(pickHeroNumber("营收 3.5亿")?.hero).toBe("3.5亿");
    expect(pickHeroNumber("快了 3倍")?.hero).toBe("3倍");
    expect(pickHeroNumber("v2 is 3x faster than v1")?.hero).toBe("3x");
    expect(pickHeroNumber("12k downloads in week 1 of 2026")?.hero).toBe("12k");
    expect(pickHeroNumber("5M rows")?.hero).toBe("5M");
  });
  test("a letter after k/M/x means it is not a unit, and a version number is not a number", () => {
    expect(pickHeroNumber("5MB of logs")?.hero).toBe("5");
    expect(pickHeroNumber("3xl shirts, 2 of them")?.hero).toBe("3");
    expect(pickHeroNumber("shipped v2 to 14 users")?.hero).toBe("14");
  });
  test("no number, no hero", () => {
    expect(pickHeroNumber("nothing numeric here")).toBeUndefined();
  });
});

describe("hardWrapLine", () => {
  const upTo = (n: number) => (s: string): boolean => [...s].length <= n;
  test("a line that fits is returned as is", () => {
    expect(hardWrapLine("short", upTo(10))).toEqual(["short"]);
  });
  test("breaks at the width and repeats the indentation", () => {
    const out = hardWrapLine("    abcdefghijklmnopqrstuvwxyz", upTo(12));
    expect(out).toEqual(["    abcdefgh", "    ijklmnop", "    qrstuvwx", "    yz"]);
    expect(out.join("").replace(/ /g, "")).toBe("abcdefghijklmnopqrstuvwxyz");
  });
  test("an indentation that does not leave room is dropped on continuation lines", () => {
    expect(hardWrapLine("          ab", upTo(10))).toEqual(["          a", "b"]);
    expect(hardWrapLine("          ab", upTo(11))).toEqual(["          a", "          b"]);
  });
  test("an ASCII sentence end counts only before a space or the end", () => {
    expect(cutAtBoundary("It works. Then it broke badly", ["It works. Then it", "broke"])).toBe("It works.…");
    expect(cutAtBoundary("Release 2.4.1 went out today and nothing", ["Release 2.4.1 went", "out"])).toBe("Release 2.4.1 went out…");
  });
  test("grapheme clusters are never split", () => {
    const family = `👨${ZWJ}👩${ZWJ}👧`;
    const out = hardWrapLine(`ab${family}cd`, upTo(3));
    expect(out.some((l) => l.includes(family))).toBe(true);
    expect(out.join("")).toBe(`ab${family}cd`);
  });
});

describe("cutAtBoundary", () => {
  test("cuts at the last sentence end inside what fits", () => {
    expect(cutAtBoundary("第一句。第二句。第三句。第四句。", ["第一句。第二句。", "第三"])).toBe("第一句。第二句。…");
  });
  test("falls back to a line break, then a word boundary", () => {
    expect(cutAtBoundary("line one\nline two\nline three", ["line one", "line tw"])).toBe("line one…");
    expect(cutAtBoundary("One two three four five six", ["One two thr"])).toBe("One two…");
    expect(cutAtBoundary("One two three four five six", ["One two three"])).toBe("One two three…");
  });
  test("counts characters, not the whitespace the wrap dropped", () => {
    expect(cutAtBoundary("alpha beta gamma delta", ["alpha", "beta"])).toBe("alpha beta…");
  });
  test("a trailing comma goes and an ellipsis is not doubled", () => {
    expect(cutAtBoundary("甲，乙，丙，丁", ["甲，乙，"])).toBe("甲，乙…");
    expect(cutAtBoundary("他走了……然后呢", ["他走了……"])).toBe("他走了……");
  });
});

describe("truncateLines", () => {
  const lines = ["one", "two", "three", "four", "five"];
  test("keeps the first lines and marks the last kept one", () => {
    expect(truncateLines(lines, 3, () => true)).toEqual(["one", "two", "three…"]);
  });
  test("the ellipsis takes its own line when it would not fit", () => {
    expect(truncateLines(lines, 2, (s) => !s.endsWith("…") || s.length <= 3)).toEqual(["one", "…"]);
  });
  test("at least one line survives", () => {
    expect(truncateLines(lines, 0, () => true)).toEqual(["one…"]);
  });
});

describe("LIST_MARKER", () => {
  test("strips the markers people actually type", () => {
    for (const [line, want] of [
      ["1. 先量，再改", "先量，再改"], ["2、一次只改一个变量", "一次只改一个变量"], ["一、总则", "总则"], ["（3）附则", "附则"],
      ["- [ ] write tests", "write tests"], ["- [x] ship", "ship"], ["• 要点", "要点"], ["12) twelve", "twelve"], ["③ 第三", "第三"], ["  - nested", "nested"],
    ] as const) expect(line.replace(LIST_MARKER, "")).toBe(want);
  });
  test("a plain line is untouched", () => {
    expect("no marker here".replace(LIST_MARKER, "")).toBe("no marker here");
  });
});

describe("ComposeError", () => {
  test("carries a code", () => {
    const e = new ComposeError("unsupported-script", "no Hangul glyphs");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("unsupported-script");
    expect(e.message).toBe("no Hangul glyphs");
  });
});
