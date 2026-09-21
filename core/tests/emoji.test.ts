import { describe, expect, test } from "bun:test";
import { countEmoji, EMOJI, notoKey, splitEmoji, stripEmoji, type Run } from "../src/render/emoji.ts";

const LINE = "今天的发布很顺利 🎉🚀 大家辛苦了";
const emojiRuns = (runs: Run[]) => runs.filter((r): r is Extract<Run, { emoji: string }> => "emoji" in r);

describe("splitEmoji", () => {
  test("text / emoji / emoji / text, in order, with Noto keys", () => {
    expect(splitEmoji(LINE)).toEqual([
      { text: "今天的发布很顺利 " },
      { emoji: "🎉", key: "1f389" },
      { emoji: "🚀", key: "1f680" },
      { text: " 大家辛苦了" },
    ]);
  });

  test("a line without emoji is one text run; an empty line is no run", () => {
    expect(splitEmoji("只有文字")).toEqual([{ text: "只有文字" }]);
    expect(splitEmoji("")).toEqual([]);
  });

  test("a line that is only an emoji is one emoji run", () => {
    expect(splitEmoji("🚀")).toEqual([{ emoji: "🚀", key: "1f680" }]);
  });

  test("a skin-toned thumbs up keeps its modifier in the key", () => {
    expect(emojiRuns(splitEmoji("👍🏻"))).toEqual([{ emoji: "👍🏻", key: "1f44d_1f3fb" }]);
  });

  test("a VS16 heart drops FE0F from the key", () => {
    const runs = emojiRuns(splitEmoji("❤️"));
    expect(runs.length).toBe(1);
    expect(runs[0]?.emoji).toBe("❤️");
    expect(runs[0]?.key).toBe("2764");
  });

  test("a keycap sequence is one emoji run", () => {
    const runs = splitEmoji("按 1️⃣ 开始");
    expect(runs.length).toBe(3);
    const e = emojiRuns(runs);
    expect(e.length).toBe(1);
    expect(e[0]?.emoji).toBe("1️⃣");
    expect(e[0]?.key).not.toContain("fe0f");
  });

  test("a ZWJ family is one emoji run", () => {
    const e = emojiRuns(splitEmoji("👨‍👩‍👧"));
    expect(e).toEqual([{ emoji: "👨‍👩‍👧", key: "1f468_200d_1f469_200d_1f467" }]);
  });
});

describe("notoKey", () => {
  test("lower-case hex joined by _", () => {
    expect(notoKey("🎉")).toBe("1f389");
    expect(notoKey("👍🏻")).toBe("1f44d_1f3fb");
    expect(notoKey("❤️")).toBe("2764");
  });
});

describe("stripEmoji / countEmoji", () => {
  test("stripEmoji removes every emoji and keeps the text", () => {
    expect(stripEmoji(LINE)).toBe("今天的发布很顺利  大家辛苦了");
    expect(stripEmoji("👍🏻❤️1️⃣")).toBe("");
    expect(stripEmoji("no emoji here")).toBe("no emoji here");
  });

  test("countEmoji counts sequences, not code points", () => {
    expect(countEmoji(LINE)).toBe(2);
    expect(countEmoji("👍🏻❤️")).toBe(2);
    expect(countEmoji("1️⃣")).toBe(1);
    expect(countEmoji("👨‍👩‍👧")).toBe(1);
    expect(countEmoji("plain")).toBe(0);
  });

  test("EMOJI is a global regex, safe to reuse across calls", () => {
    expect(EMOJI.global).toBe(true);
    expect(countEmoji(LINE)).toBe(countEmoji(LINE));
    expect(splitEmoji(LINE)).toEqual(splitEmoji(LINE));
  });
});
