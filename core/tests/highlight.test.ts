/** Code template: highlight.js colours (text never changes), fence language,
 * fallback to the regex colouring, and the code font chooser. */
import { describe, expect, test } from "bun:test";
import { HIGHLIGHT_LANGUAGES, graphemeKeys, highlight } from "../src/templates/highlight.ts";
import { CODE_FONT, CODE_FONT_DIR, CODE_STYLES, MONO_TEMPLATES, chooseTemplateFont, codeColors, fontFaces, layoutTemplate, syntaxColors, type TemplateMeasure } from "../src/templates/compose.ts";
import { normalizeText } from "../src/render/compose.ts";
import { TEMPLATE_IDS } from "../src/templates/types.ts";
import { samplePlan } from "./fixtures/templates.ts";

const graphemes = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((p) => p.segment);
const metrics: TemplateMeasure = {
  width: (text, size) => graphemes(text).reduce((n, g) => n + size * (/^[\x00-\x7f]+$/.test(g) ? 0.55 : 1), 0),
  lineHeight: (size) => size * 1.2,
};

const SAMPLES: Record<string, string> = {
  python: "def 求和(a: int, b: int) -> int:\n    # 计算两个数的和 🎉\n    \"\"\"文档 <b> & 'x'\"\"\"\n    return a + b  # 结果\n\n@cache\nclass Point:\n    x: float = 1.5e3",
  typescript: "interface User<T> { id: number; name: string }\nexport const greet = async (u: User<string>): Promise<void> => {\n  // 问候 👋\n  console.log(`Hello, ${u.name} & <you>`);\n};",
  sql: "SELECT u.id, count(*) AS n -- 用户数\nFROM users u\nWHERE u.name LIKE '%张%' AND u.age > 18\nGROUP BY u.id;",
  bash: "$ export PATH=\"$HOME/bin:$PATH\"\n$ for f in *.ts; do echo \"$f\"; done  # 遍历\nif [ -f ~/.zshrc ]; then source ~/.zshrc; fi",
  json: "{\n  \"名字\": \"Peesuto\",\n  \"version\": 1.2,\n  \"ok\": true,\n  \"tags\": [\"剪贴板\", null]\n}",
  go: "package main\n\nimport \"fmt\"\n\n// 主函数\nfunc main() {\n\tfmt.Println(\"你好, 世界\")\n}",
  diff: "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2; // 改\n context",
  xml: "<div class=\"卡片\" data-x='1'>\n  <!-- 注释 -->\n  <p>A &amp; B &lt; C</p>\n</div>",
  rust: "fn main() {\n    let v: Vec<i32> = vec![1, 2, 3]; // 向量\n    println!(\"{:?} 🦀\", v);\n}",
  yaml: "name: 构建\non: [push]\njobs:\n  test:\n    runs-on: macos-15 # 注释\n    steps:\n      - run: bun test",
};

/** The concatenation of a layout's code lines, as the layout draws them. */
function drawnLines(code: string, language?: string): string[] {
  const layout = layoutTemplate(samplePlan({ kind: "code", code, ...(language ? { language } : {}) }), metrics);
  const numbers = [CODE_STYLES.classic.lineNumbers.color, CODE_STYLES.editorial.lineNumbers.color] as string[];
  return layout.lines.filter((line) => line.text !== language && !numbers.includes(line.color)).map((line) => line.text);
}

describe("highlight.js colouring", () => {
  test("registers the common languages", () => {
    for (const name of ["typescript", "javascript", "python", "go", "rust", "java", "kotlin", "swift", "c", "cpp", "csharp", "ruby", "php", "sql", "bash", "shell", "json", "yaml", "xml", "css", "markdown", "diff", "dockerfile", "ini"]) {
      expect(HIGHLIGHT_LANGUAGES).toContain(name);
    }
  });

  test("reconstructs the text exactly, line for line, in every sample language (Chinese comments, emoji, entities)", () => {
    for (const [language, raw] of Object.entries(SAMPLES)) {
      const source = normalizeText(raw, "code");
      const result = highlight(source, language);
      if (!result) throw new Error(`${language}: no highlight`);
      const lines = source.split("\n");
      expect(result.keys).toHaveLength(lines.length);
      result.keys.forEach((keys, i) => expect(keys).toHaveLength(graphemes(lines[i]!).length));
      expect(result.keys.flat().filter(Boolean).length).toBeGreaterThan(0);
      // The drawn text is the source, whatever the colours (long lines may wrap).
      expect(drawnLines(raw, language).join("")).toBe(source.replace(/\n/g, ""));
    }
  });

  test("maps token classes onto the palette", () => {
    const s = CODE_STYLES.classic.syntax;
    const line = normalizeText(SAMPLES.python!, "code");
    const colors = codeColors(line, "python", s);
    const first = colors[0]!; // def 求和(a: int, b: int) -> int:
    expect(first[0]).toBe(s.keyword);
    expect(first[4]).toBe(s.function);
    const comment = colors[1]!;
    expect(comment.slice(4).every((c) => c === s.comment)).toBe(true);
    const ts = codeColors(normalizeText(SAMPLES.typescript!, "code"), "ts", s);
    expect(ts[0]![0]).toBe(s.keyword); // interface
    expect(ts[0]!.includes(s.type)).toBe(true); // number / string
    const diff = codeColors(normalizeText(SAMPLES.diff!, "code"), "diff", s);
    expect(diff[3]![0]).toBe(s.meta); // deletion
    expect(diff[4]![0]).toBe(s.string); // addition
    // Every colour used comes from the style's palette.
    const palette = new Set<string>(Object.values(s));
    for (const sample of Object.entries(SAMPLES)) for (const row of codeColors(normalizeText(sample[1], "code"), sample[0], s)) for (const c of row) if (c) expect(palette.has(c)).toBe(true);
  });

  test("the fence language is honoured, aliases included", () => {
    // Valid Python and valid Ruby: the fence decides.
    const source = "puts = 1\nprint(puts)";
    expect(highlight(source, "ruby")!.language).toBe("ruby");
    expect(highlight(source, "python")!.language).toBe("python");
    expect(highlight(source, "py")).toBeDefined();
    expect(highlight("const a: number = 1;", "ts")).toBeDefined();
    expect(highlight("<a href=\"x\">y</a>", "html")).toBeDefined();
    expect(highlight("[tool]\nname = \"x\"", "toml")).toBeDefined();
    expect(highlight("ls -la", "sh")).toBeDefined();
  });

  test("an unknown fence language is detected among the registered languages", () => {
    const result = highlight(normalizeText(SAMPLES.go!, "code"), "golangish");
    expect(result).toBeDefined();
    expect(HIGHLIGHT_LANGUAGES).toContain(result!.language);
    const auto = highlight("SELECT id, name FROM users WHERE age > 18 ORDER BY name;\nSELECT 1;");
    expect(auto?.language).toBe("sql");
  });

  test("short low-confidence snippets and garbage fall back to the regex colouring", () => {
    expect(highlight("hello")).toBeUndefined();
    const garbage = "£¥ 〄〄 ¶¶ ::: ~~";
    const s = CODE_STYLES.editorial.syntax;
    const colors = codeColors(garbage, undefined, s);
    expect(colors).toEqual([syntaxColors(garbage, s)]);
    const layout = layoutTemplate(samplePlan({ kind: "code", code: garbage }), metrics);
    expect(layout.lines.filter((l) => l.color !== CODE_STYLES.classic.lineNumbers.color).map((l) => l.text).join("")).toBe(garbage);
  });

  test("any mismatch between highlighter text and source falls back (never alters text)", () => {
    const source = "a < b\nc";
    expect(graphemeKeys('a <span class="hljs-operator">&lt;</span> b\nc', source)).toEqual([[undefined, undefined, "punct", undefined, undefined], [undefined]]);
    expect(graphemeKeys('a <span class="hljs-operator">&lt;=</span> b\nc', source)).toBeUndefined(); // a character added
    expect(graphemeKeys("a &lt; b c", source)).toBeUndefined(); // a newline lost
    expect(graphemeKeys("a &lt; b\n", source)).toBeUndefined(); // a character dropped
    const odd = "a\u0000b = 1\nc = 'x'";
    const colors = codeColors(odd, "python", CODE_STYLES.classic.syntax);
    expect(colors.map((c) => c.length)).toEqual(odd.split("\n").map((l) => graphemes(l).length));
  });
});

describe("code font", () => {
  test("Maple Mono by default for every template, Noto Sans SC when chosen (never for code, shell sessions and diffs) or a glyph is missing", () => {
    expect(MONO_TEMPLATES).toEqual(["code", "terminal", "diff"]);
    for (const id of TEMPLATE_IDS) {
      // Code, shell sessions and diffs keep Chinese at two columns; every other card uses Peesuto Text (Chinese at 1em).
      const mono = MONO_TEMPLATES.includes(id);
      expect(chooseTemplateFont(id, [])).toBe(mono ? "peesuto-code" : "peesuto-text");
      expect(chooseTemplateFont(id, ["한"])).toBe("noto-sans-sc");
      expect(chooseTemplateFont(id, [], "noto")).toBe(mono ? "peesuto-code" : "noto-sans-sc");
    }
  });

  test("font paths: absolute for the measurer, work-tree relative without '..' for the composition", async () => {
    const code = fontFaces("peesuto-code", "/engine");
    expect(code.measure.regular).toBe(`${CODE_FONT_DIR.replace(/\/$/, "")}/${CODE_FONT.regular}`);
    for (const path of Object.values(code.composition)) {
      expect(path.startsWith("/")).toBe(false);
      expect(path.split("/")).not.toContain("..");
      expect(path.startsWith("compositions/paste/")).toBe(true);
    }
    expect(await Bun.file(code.measure.regular).exists()).toBe(true);
    expect(await Bun.file(code.measure.bold).exists()).toBe(true);
    const text = fontFaces("peesuto-text", "/engine");
    for (const path of [text.measure.regular, text.measure.bold]) expect(await Bun.file(path).exists()).toBe(true);
    expect(text.composition.regular.startsWith("compositions/paste/")).toBe(true);
    expect(fontFaces("noto-sans-sc", "/engine").composition.regular).toBe("assets/fonts/NotoSansSC-Regular.otf");
  });
});
