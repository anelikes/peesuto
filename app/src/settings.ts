/** Settings and first-run onboarding. */
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Store } from "@tauri-apps/plugin-store";
import {
  $, ACCESSIBILITY_URL, DEFAULTS, humanError, openSettingsStore, readSettings,
  type AppInfo, type Aspect, type PasteError, type PasteResult, type Settings,
} from "./shared";

const intro = $("intro");
const axStatus = $("ax-status");
const hotkey = $<HTMLInputElement>("hotkey");
const providerKind = $<HTMLSelectElement>("provider-kind");
const providerProxy = $("provider-proxy");
const providerUrl = $<HTMLInputElement>("provider-url");
const providerToken = $<HTMLInputElement>("provider-token");
const aspect = $<HTMLSelectElement>("aspect");
const sidecarMode = $<HTMLSelectElement>("sidecar-mode");
const repoField = $("repo-field");
const devRepo = $<HTMLInputElement>("dev-repo");
const sidecarInfo = $("sidecar-info");
const autostart = $<HTMLInputElement>("autostart");
const status = $("status");
const testResult = $("test-result");
const testCard = $<HTMLImageElement>("test-card");
const testText = $("test-text");

let store: Store;

function say(text: string, kind: "" | "ok" | "err" = ""): void {
  status.textContent = text;
  status.className = `status ${kind}`;
}

function syncVisibility(): void {
  providerProxy.hidden = providerKind.value !== "proxy";
  repoField.hidden = sidecarMode.value !== "dev";
}

async function refreshAccessibility(): Promise<void> {
  const trusted = await invoke<boolean>("accessibility_status").catch(() => false);
  axStatus.textContent = trusted ? "Allowed" : "Not allowed";
  axStatus.className = `pill ${trusted ? "ok" : "warn"}`;
}

async function refreshInfo(): Promise<void> {
  try {
    const info = await invoke<AppInfo>("app_info");
    const s = info.sidecar;
    const mark = (ok: boolean) => (ok ? "✓" : "✗");
    sidecarInfo.textContent = [
      `dev: bun ${s.bun ?? "not found"} · ${mark(s.dev_cli_present)} ${s.dev_cli}`,
      `bundled: ${mark(s.bundled_present)} ${s.bundled_binary} · ${mark(s.resources_present)} ${s.resources}`,
      `cards: ${info.cards_dir}`,
    ].join("\n");
  } catch (e) {
    sidecarInfo.textContent = String(e);
  }
}

function collect(): Settings {
  return {
    hotkey: hotkey.value.trim() || DEFAULTS.hotkey,
    aspect: aspect.value as Aspect,
    provider_kind: providerKind.value as Settings["provider_kind"],
    provider_url: providerUrl.value.trim(),
    sidecar_mode: sidecarMode.value as Settings["sidecar_mode"],
    dev_repo_path: devRepo.value.trim() || DEFAULTS.dev_repo_path,
    onboarded: true,
  };
}

async function saveAll(): Promise<boolean> {
  const s = collect();
  for (const [k, v] of Object.entries(s)) await store.set(k, v);
  await store.save();
  await invoke("secret_set", { name: "provider_token", value: providerToken.value });
  let ok = true;
  try {
    await invoke("apply_hotkey", { hotkey: s.hotkey });
  } catch (e) {
    say(`Saved, but the shortcut could not be registered: ${e}`, "err");
    ok = false;
  }
  try {
    if (autostart.checked) await enable();
    else await disable();
  } catch (e) {
    say(`Saved, but launch at login failed: ${e}`, "err");
    ok = false;
  }
  intro.hidden = true;
  if (ok) say("Saved", "ok");
  void refreshInfo();
  return ok;
}

async function test(): Promise<void> {
  await saveAll();
  say("Rendering…");
  testResult.hidden = false;
  testCard.hidden = true;
  testText.textContent = "";
  try {
    const r = await invoke<PasteResult>("render_test", { text: "Hello, pocket-paste" });
    testCard.src = convertFileSrc(r.path);
    testCard.hidden = false;
    testText.textContent = `${r.format} · ${r.size}px · ${r.frames} frame${r.frames === 1 ? "" : "s"} · ${r.ms.total ?? "?"} ms · ${r.decided.provider ?? ""}\n${r.path}`;
    say("Rendered", "ok");
  } catch (e) {
    const err = e as PasteError;
    const h = humanError(err.kind ?? "error", err.message ?? String(e));
    testText.textContent = `${h.title} ${h.detail}`;
    say("Failed", "err");
  }
}

// --- hotkey capture ---
const MODIFIERS = new Set(["Meta", "Control", "Alt", "Shift"]);
const NAMED: Record<string, string> = {
  Space: "Space", Enter: "Enter", Escape: "Escape", Tab: "Tab", Backspace: "Backspace", Delete: "Delete",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Comma: ",",
  Period: ".", Slash: "/", Backslash: "\\", Backquote: "`",
};
function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return NAMED[code] ?? null;
}
hotkey.addEventListener("keydown", (e) => {
  e.preventDefault();
  if (MODIFIERS.has(e.key)) return;
  const mods: string[] = [];
  if (e.metaKey) mods.push("CmdOrCtrl");
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  const key = keyName(e.code);
  if (mods.length === 0 || !key) return;
  hotkey.value = [...mods, key].join("+");
});

// --- wiring ---
providerKind.addEventListener("change", syncVisibility);
sidecarMode.addEventListener("change", syncVisibility);
$("save").addEventListener("click", () => void saveAll());
$("test").addEventListener("click", () => void test());
$("ax-recheck").addEventListener("click", () => void refreshAccessibility());
$("ax-allow").addEventListener("click", async () => {
  await invoke("accessibility_prompt");
  window.setTimeout(() => void refreshAccessibility(), 800);
});
$("ax-open").addEventListener("click", () => void openUrl(ACCESSIBILITY_URL));
void getCurrentWindow().onFocusChanged(({ payload }) => { if (payload) void refreshAccessibility(); });

async function init(): Promise<void> {
  store = await openSettingsStore();
  const s = await readSettings(store);
  hotkey.value = s.hotkey;
  aspect.value = s.aspect;
  providerKind.value = s.provider_kind;
  providerUrl.value = s.provider_url;
  sidecarMode.value = s.sidecar_mode;
  devRepo.value = s.dev_repo_path;
  providerToken.value = (await invoke<string | null>("secret_get", { name: "provider_token" }).catch(() => null)) ?? "";
  autostart.checked = await isEnabled().catch(() => false);
  intro.hidden = s.onboarded;
  syncVisibility();
  await Promise.all([refreshAccessibility(), refreshInfo()]);
}
void init();
