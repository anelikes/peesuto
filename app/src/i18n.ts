/** English source messages are stable keys and the fallback for unknown diagnostics.
 * Only explicitly marked UI strings are translated, never user content or prompts.
 */
import chinese from "./locales/zh-CN.json";

export type Language = "system" | "en" | "zh-CN";
export type Locale = Exclude<Language, "system">;
export const messages: Readonly<Record<string, string>> = Object.freeze(Object.assign(Object.create(null), chinese));
let locale: Locale = "en";

export function resolveLocale(language: string, systemLanguage: string): Locale {
  if (language === "en" || language === "zh-CN") return language;
  return /^zh(?:[-_]|$)/i.test(systemLanguage) ? "zh-CN" : "en";
}
export function setLocale(value: Locale): void { locale = value; }
export function getLocale(): Locale { return locale; }
export function t(message: string, args: readonly unknown[] = []): string {
  const translated = locale === "zh-CN" ? messages[message] ?? message : message;
  return translated.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < args.length ? String(args[Number(index)]) : match);
}
export function actionName(action: { name: string; builtin?: boolean }): string {
  return action.builtin ? t(action.name) : action.name;
}
export function applyTranslations(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n!);
  }
  for (const attribute of ["placeholder", "title", "aria-label", "data-empty"]) {
    for (const element of root.querySelectorAll<HTMLElement>(`[data-i18n-${attribute}]`)) {
      element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)!));
    }
  }
  document.documentElement.lang = locale;
}
