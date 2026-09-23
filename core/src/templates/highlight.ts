/**
 * Syntax colour for the code template: highlight.js (BSD-3-Clause) over a
 * fixed set of common languages, converted to one colour per grapheme.
 *
 * Colour only. The highlighter's text is decoded and compared with the source
 * line for line; any difference (or any highlighter error) falls back to the
 * small regex colouring in compose.ts, so a highlighter bug can never change,
 * drop or add a character.
 */
// highlight.js is loaded through non-literal specifiers on purpose: its type
// declarations start with `/// <reference lib="dom" />`, which would replace
// Bun's own Headers/ReadableStream types across the whole project. Only the
// small surface used here is typed.
interface HighlightResult { value: string; language?: string; relevance: number }
interface Hljs {
  registerLanguage(name: string, language: unknown): void;
  getLanguage(name: string): unknown;
  highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): HighlightResult;
  highlightAuto(code: string, subset?: readonly string[]): HighlightResult;
}
const load = (specifier: string): Promise<{ default: unknown }> => import(specifier);
const LANGUAGE_NAMES = ["bash", "c", "cpp", "csharp", "css", "diff", "dockerfile", "go", "ini", "java", "javascript", "json", "kotlin", "markdown", "php", "python", "ruby", "rust", "shell", "sql", "swift", "typescript", "xml", "yaml"] as const;
const hljs = (await load("highlight.js/lib/core")).default as Hljs;
const LANGUAGES = Object.fromEntries(await Promise.all(LANGUAGE_NAMES.map(async (name) => [name, (await load(`highlight.js/lib/languages/${name}`)).default] as const)));
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);
/** Languages `highlightAuto` chooses among (never the whole hljs catalogue). */
export const HIGHLIGHT_LANGUAGES: readonly string[] = Object.keys(LANGUAGES);

/** Colours a code style supplies, one per token class. */
export interface CodePalette {
  keyword: string; string: string; number: string; comment: string; function: string; type: string;
  property: string; literal: string; meta: string; punct: string;
}
export type PaletteKey = keyof CodePalette;

/** hljs scope → palette key. A scope not listed here tries its parent
 * (`title.function.invoke` → `title.function` → `title`); `null` resets to
 * the plain ink (a `${…}` substitution inside a string). */
const SCOPES: Record<string, PaletteKey | null> = {
  keyword: "keyword", "variable.language": "keyword",
  string: "string", regexp: "string", "char.escape": "string", link: "string", code: "string", addition: "string",
  number: "number",
  comment: "comment", doctag: "comment", quote: "comment",
  "title.function": "function", title: "function",
  type: "type", "title.class": "type", built_in: "type",
  attr: "property", attribute: "property", property: "property", variable: "property", params: "property", "template-variable": "property",
  literal: "literal", symbol: "literal", bullet: "literal",
  meta: "meta", tag: "meta", selector: "meta", "selector-tag": "meta", "selector-class": "meta", "selector-id": "meta",
  "selector-pseudo": "meta", "selector-attr": "meta", name: "meta", section: "meta", deletion: "meta",
  operator: "punct", punctuation: "punct",
  subst: null,
};

/** `hljs-title function_ invoke__` → `title.function.invoke`. */
function scopeOf(className: string): string | undefined {
  const parts = className.trim().split(/\s+/);
  if (!parts[0]?.startsWith("hljs-")) return undefined;
  return [parts[0].slice(5), ...parts.slice(1).map((p) => p.replace(/_+$/, ""))].join(".");
}
function paletteKey(scope: string): PaletteKey | null | undefined {
  for (let s = scope; s; s = s.includes(".") ? s.slice(0, s.lastIndexOf(".")) : "") if (s in SCOPES) return SCOPES[s];
  return undefined;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
function decode(html: string): string {
  return html.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") return String.fromCodePoint(name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Text and palette key per UTF-16 unit of hljs's HTML output. */
function flatten(html: string): { text: string; keys: (PaletteKey | undefined)[] } {
  let text = "";
  const keys: (PaletteKey | undefined)[] = [];
  const stack: (PaletteKey | undefined)[] = [undefined];
  for (const match of html.matchAll(/<span class="([^"]*)">|<\/span>|([^<]+)/g)) {
    if (match[1] !== undefined) {
      const scope = scopeOf(match[1]);
      const key = scope === undefined ? undefined : paletteKey(scope);
      stack.push(key === null ? undefined : key === undefined ? stack[stack.length - 1] : key);
    } else if (match[2] !== undefined) {
      const part = decode(match[2]);
      text += part;
      for (let i = 0; i < part.length; i++) keys.push(stack[stack.length - 1]);
    } else if (match[0] === "</span>") {
      if (stack.length > 1) stack.pop();
    } else throw new Error("unexpected highlighter markup");
  }
  return { text, keys };
}

export interface Highlighted {
  /** Palette key per grapheme, per source line (`source.split("\n")`). */
  readonly keys: (PaletteKey | undefined)[][];
  /** The hljs language used. */
  readonly language: string;
}

/** Snippets this short are left to the regex colouring unless the
 * detector is at least this sure (a fence language is always honoured). */
export const SHORT_SNIPPET = { lines: 2, chars: 40, relevance: 5 } as const;

const graphemes = (text: string): string[] => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment);

/**
 * Highlight `source` (already normalized; lines separated by "\n"). The fence
 * `language` is used when hljs knows it or its alias; otherwise the language is
 * detected among HIGHLIGHT_LANGUAGES. Undefined means "use the fallback":
 * detection too unsure on a short snippet, a highlighter error, or output
 * whose text differs from the source in any way.
 */
export function highlight(source: string, language?: string): Highlighted | undefined {
  try {
    const fence = language?.trim().toLowerCase();
    const known = fence && hljs.getLanguage(fence) ? fence : undefined;
    let result: { value: string; language?: string; relevance: number };
    if (known) result = hljs.highlight(source, { language: known, ignoreIllegals: true });
    else {
      result = hljs.highlightAuto(source, [...HIGHLIGHT_LANGUAGES]);
      const lines = source.split("\n").length;
      if (!result.language) return undefined;
      if (lines < SHORT_SNIPPET.lines && source.length < SHORT_SNIPPET.chars && result.relevance < SHORT_SNIPPET.relevance) return undefined;
    }
    const keys = graphemeKeys(result.value, source);
    return keys && { keys, language: result.language ?? known ?? "" };
  } catch {
    return undefined;
  }
}

/** hljs HTML → palette key per grapheme per line of `source`; undefined when
 * the decoded text differs from `source` in any way (line for line). */
export function graphemeKeys(html: string, source: string): (PaletteKey | undefined)[][] | undefined {
  const flat = flatten(html);
  if (flat.text !== source) return undefined;
  // One key per grapheme (its first code unit's), then split at the newlines.
  const out: (PaletteKey | undefined)[][] = [[]];
  let offset = 0;
  for (const glyph of graphemes(source)) {
    if (glyph === "\n") out.push([]);
    else out[out.length - 1]!.push(flat.keys[offset]);
    offset += glyph.length;
  }
  const lines = source.split("\n");
  if (out.length !== lines.length || out.some((keys, i) => keys.length !== graphemes(lines[i]!).length)) return undefined;
  return out;
}
