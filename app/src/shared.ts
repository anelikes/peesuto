/** Types and helpers shared by the three pages. */
import { load, type Store } from "@tauri-apps/plugin-store";

export type Aspect = "chat" | "doc" | "social";
export const ASPECTS: readonly Aspect[] = ["chat", "doc", "social"];

export interface ClipItem {
  id: number;
  kind: "text" | "file";
  text: string;
  preview: string;
  types: string[];
  app_bundle_id: string | null;
  app_name: string | null;
  created_at: number;
  pinned: boolean;
}

export interface PasteFailure {
  kind: "accessibility" | "pasteboard" | "event" | "missing";
  message: string;
}

export function isPasteFailure(e: unknown): e is PasteFailure {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

/** The `paste --json` success line, as relayed by the shell. */
export interface PasteResult {
  path: string;
  format: "png" | "gif";
  frames: number;
  lines: number;
  size: number;
  dsl: Record<string, unknown>;
  decided: { provider?: string; kindP?: number; jevMs?: number };
  ms: { compose?: number; build?: number; frame?: number; total?: number };
}

export interface PasteError {
  kind: string;
  message: string;
}

export type ResultState =
  | { state: "working"; text: string; aspect: Aspect }
  | { state: "ready"; result: PasteResult; copied: "image" | "file" | "path" | "none"; aspect: Aspect; text: string }
  | { state: "error"; kind: string; message: string; aspect: Aspect; text: string };

export interface SidecarInfo {
  mode: string;
  bun: string | null;
  dev_cli: string;
  dev_cli_present: boolean;
  bundled_binary: string;
  bundled_present: boolean;
  resources: string;
  resources_present: boolean;
}

export interface AppInfo {
  version: string;
  app_data: string;
  cards_dir: string;
  sidecar: SidecarInfo;
}

export interface Settings {
  hotkey: string;
  aspect: Aspect;
  provider_kind: "none" | "proxy" | "cloudflare" | "hosted";
  provider_url: string;
  sidecar_mode: "dev" | "bundled";
  dev_repo_path: string;
  onboarded: boolean;
}

export const DEFAULTS: Settings = {
  hotkey: "CmdOrCtrl+Shift+V",
  aspect: "chat",
  provider_kind: "none",
  provider_url: "",
  sidecar_mode: "dev",
  dev_repo_path: "/Users/nya/codes/github/pocket-paste",
  onboarded: false,
};

export const ACCESSIBILITY_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

export function openSettingsStore(): Promise<Store> {
  return load("settings.json", { autoSave: false });
}

export async function readSettings(store: Store): Promise<Settings> {
  const s: Settings = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const v = await store.get<unknown>(key);
    if (v === undefined || v === null || v === "") continue;
    (s as unknown as Record<string, unknown>)[key] = v;
  }
  return s;
}

/** The CLI's error kinds (plus the shell's own) as short sentences. */
export function humanError(kind: string, message: string): { title: string; detail: string; settings: boolean } {
  switch (kind) {
    case "empty": return { title: "Nothing to paste", detail: "Copy some text, then try again.", settings: false };
    case "usage": return { title: "This text could not be rendered.", detail: message, settings: false };
    case "provider:auth": return { title: "Your API credential was rejected.", detail: "Check Settings.", settings: true };
    case "provider:network": return { title: "The provider could not be reached.", detail: "Check your connection and the proxy URL in Settings.", settings: true };
    case "provider:timeout": return { title: "The provider took too long.", detail: "Try again in a moment.", settings: false };
    case "provider:model": return { title: "The model is unavailable right now.", detail: message, settings: false };
    case "provider:bad-response": return { title: "The provider answered with something unexpected.", detail: message, settings: false };
    case "provider:quota": return { title: "Your quota is used up.", detail: "Check your plan, or switch providers in Settings.", settings: true };
    case "compose": return { title: "This text does not fit a card.", detail: message, settings: false };
    case "engine": return { title: "The render engine is not set up.", detail: message, settings: true };
    case "sidecar": return { title: "The renderer could not start.", detail: message, settings: true };
    case "timeout": return { title: "Rendering took too long.", detail: "It was stopped. Try again.", settings: false };
    default: return { title: "Something went wrong.", detail: message, settings: false };
  }
}

export function relativeTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString();
}

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}
