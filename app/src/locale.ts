/** The native store is the authority; an event updates all long-lived webviews. */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { applyTranslations, resolveLocale, setLocale, type Language, type Locale } from "./i18n";

export interface LocaleState { language: Language; locale: Locale }
let state: LocaleState = { language: "system", locale: resolveLocale("system", navigator.language) };
let initialized = false;
const subscribers = new Set<(state: LocaleState) => void>();
export function onLocaleChange(callback: (state: LocaleState) => void): void { subscribers.add(callback); }
function apply(next: LocaleState): void {
  if (initialized && state.language === next.language && state.locale === next.locale) return;
  initialized = true;
  state = next;
  setLocale(next.locale);
  applyTranslations();
  for (const callback of subscribers) callback(next);
}
export function localeState(): LocaleState { return state; }
export async function initLocale(): Promise<void> {
  // Register first so a second window cannot miss an update during startup.
  let revision = 0;
  await listen<LocaleState>("locale:changed", ({ payload }) => { revision++; apply(payload); });
  const initialRevision = revision;
  const initial = await invoke<LocaleState>("locale_get");
  if (revision === initialRevision) apply(initial);
}
export async function changeLanguage(language: Language): Promise<void> {
  apply(await invoke<LocaleState>("locale_set", { language }));
}
