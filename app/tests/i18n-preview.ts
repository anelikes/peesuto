/** Browser-only QA harness. Native APIs use synthetic data; no real clipboard or credentials. */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { resolveLocale, type Language } from "../src/i18n";
import { BUILTIN_ACTIONS } from "../../core/src/actions/builtin";

const page = new URLSearchParams(location.search).get("page") ?? "settings";
if (!["settings", "history", "result"].includes(page)) throw new Error("Unknown preview page");
const html = await (await fetch(page === "history" ? "/index.html" : `/${page}.html`)).text();
const parsed = new DOMParser().parseFromString(html, "text/html");
parsed.querySelectorAll("script").forEach(script => script.remove());
document.body.className = parsed.body.className;
document.body.replaceChildren(...parsed.body.childNodes);
mockWindows(page);
const channel = new BroadcastChannel("peesuto-i18n-test");
channel.onmessage = ({ data }) => void emit("locale:changed", data);
const state = () => {
  const language = (localStorage.getItem("qa-language") ?? "system") as Language;
  return { language, locale: resolveLocale(language, "zh-CN") };
};
const actions = [...BUILTIN_ACTIONS, { ...BUILTIN_ACTIONS[1], builtin: false, id: "custom", name: "Settings", description: "Do not translate my custom name." }];
const providers = { config: { decider: { kind: "rules" }, generator: { kind: "none" }, offline: false }, proxyToken: "", cloudflareToken: "", hostedToken: "", generatorApiKey: "" };
mockIPC(async (command, args: Record<string, unknown> = {}) => {
  switch (command) {
    case "locale_get": return state();
    case "locale_set": {
      localStorage.setItem("qa-language", String(args.language));
      const next = state();
      await emit("locale:changed", next);
      channel.postMessage(next);
      return next;
    }
    case "plugin:store|load": return 1;
    case "plugin:store|get": return [null, false];
    case "plugin:autostart|is_enabled": return false;
    case "accessibility_status": return false;
    case "providers_get": return providers;
    case "daemon_status": return { alive: true, ready: true, fallback: false, version: "0.1.0", engine: "mock" };
    case "actions_list": case "actions_reload": return { actions, problems: [], hotkeys: [], folder: "/mock/actions" };
    case "history_status": return { state: "ok", items: 1, retention_days: 30 };
    case "history_list": case "history_recent": return [{ id: "one", kind: "text", text: "Settings", preview: "Settings", createdAt: Date.now() - 120000, pinned: false, bytes: 8, types: [], appName: "Notes" }];
    case "privacy_info": return { destinations: ["decider → nowhere (rules)", "generator → nowhere (not configured)"], egress_log: "/mock/egress.log", egress_lines: [], offline: false };
    case "subscription_get": return { key: "", baseUrl: "", defaultBaseUrl: "https://api.peesuto.com", hostedActive: false };
    case "packs_installed": return [];
    case "app_info": return { version: "0.1.0", identifier: "com.peesuto.desktop", debug: true, updater: { enabled: false }, app_data: "/mock/data", log: "/mock/log", sidecar: { dev_daemon: "/mock/core", dev_daemon_present: true, bundled_binary: "/mock/bun", bundled_present: true, resources: "/mock/resources", resources_present: true } };
    case "result_state": return { state: "text", action: actions.find(action => action.id === "paste-summary"), input: "Settings", text: "Settings", model: "mock model", ms: 1000 };
    case "settings_apply": return [];
    default: return null;
  }
}, { shouldMockEvents: true });
if (page === "settings") await import("../src/settings");
if (page === "history") await import("../src/history");
if (page === "result") await import("../src/result");
