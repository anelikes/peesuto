import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { actionName, messages, resolveLocale, setLocale, t } from "../src/i18n";
import { BUILTIN_ACTIONS } from "../../core/src/actions/builtin";

afterEach(() => setLocale("en"));

test("system language defaults and explicit overrides", () => {
  for (const language of ["zh", "zh-CN", "zh-Hans", "zh-Hant-TW", "zh_HK"]) expect(resolveLocale("system", language)).toBe("zh-CN");
  expect(resolveLocale("system", "fr-FR")).toBe("en");
  expect(resolveLocale("en", "zh-CN")).toBe("en");
  expect(resolveLocale("zh-CN", "en-US")).toBe("zh-CN");
  expect(resolveLocale("invalid", "zh-CN")).toBe("zh-CN");
});

test("interpolation preserves arbitrary content and fallback diagnostics", () => {
  setLocale("zh-CN");
  expect(t("Copy failed: {0}", ["$& <b>{1}</b>"])).toBe("复制失败：$& <b>{1}</b>");
  expect(t("unknown diagnostic")).toBe("unknown diagnostic");
  expect(t("constructor")).toBe("constructor");
  expect(t("toString")).toBe("toString");
  setLocale("en");
  expect(t("Copy failed: {0}", ["offline"])).toBe("Copy failed: offline");
});

test("translate built-ins only, including when a user overrides a built-in ID", () => {
  setLocale("zh-CN");
  for (const action of BUILTIN_ACTIONS) {
    expect(messages[action.name]).toBeDefined();
    expect(messages[action.description!]).toBeDefined();
    expect(actionName(action)).toBe(messages[action.name]!);
    expect(actionName({ ...action, builtin: false })).toBe(action.name);
  }
});

test("all placeholders survive translation", () => {
  const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map(m => m[0]).sort();
  for (const [key, value] of Object.entries(messages)) {
    expect(value.trim(), key).not.toBe("");
    expect(placeholders(value), key).toEqual(placeholders(key));
  }
});

test("all static HTML labels and source translation calls have a Chinese message", () => {
  const unescape = (s: string) => s.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
  for (const page of ["index", "result", "settings"]) {
    const html = readFileSync(new URL(`../${page}.html`, import.meta.url), "utf8");
    for (const match of html.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)) expect(messages[unescape(match[1]!)], `${page}: ${match[1]}`).toBeDefined();
    expect(html).not.toMatch(/\/\s+data-i18n/);
  }
  for (const name of ["history", "result", "settings", "shared"]) {
    const source = ts.createSourceFile(name, readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "t" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        expect(messages[node.arguments[0].text], node.arguments[0].text).toBeDefined();
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});
