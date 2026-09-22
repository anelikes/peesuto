/** Types and helpers shared by the three pages. The Core-facing shapes mirror core/src/pick/types.ts and core/src/actions/types.ts. */
import { load, type Store } from "@tauri-apps/plugin-store";

export type Aspect = "chat" | "doc" | "social";
export const ASPECTS: readonly Aspect[] = ["chat", "doc", "social"];

/** One history item, as the shell stores it (`store.rs`) and Core reads it. */
export interface ClipItem {
  id: string;
  kind: "text" | "image" | "file";
  text?: string;
  preview: string;
  appBundleId?: string;
  appName?: string;
  createdAt: number;
  pinned: boolean;
  bytes: number;
  types: string[];
  image?: { width: number; height: number };
}

export type HistoryStatus =
  | { state: "ok"; items: number; retention_days: number }
  | { state: "locked"; detail: string; retention_days: number }
  | { state: "memory"; retention_days: number }
  | { state: "opening"; retention_days: number };

/** The focused field as `context.rs` saw it. */
export interface Context {
  level: 0 | 1 | 2;
  appBundleId: string;
  appName?: string;
  windowTitle?: string;
  role?: string;
  subrole?: string;
  label?: string;
  before?: string;
  after?: string;
  secure?: boolean;
}

export interface Session {
  context: Context;
  smart: boolean;
  note?: string;
  trusted: boolean;
  capturedAt: number;
  ms: number;
}

export interface RankedItem {
  item: ClipItem;
  score: number;
  reason: string;
}

export interface PickResult {
  ranked: RankedItem[];
  shouldPaste: number;
  source: "decider" | "heuristic";
}

export interface PasteFailure {
  kind: "accessibility" | "pasteboard" | "event" | "missing";
  message: string;
}

export function isPasteFailure(e: unknown): e is PasteFailure {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

/** A rendered card, as relayed by the shell. */
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

export function isPasteError(e: unknown): e is PasteError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

export interface ActionMeta {
  id: string;
  name: string;
  needs: "decider" | "generator" | "render" | "none";
  output: "text" | "image" | "gif" | "video" | "file";
}

export type ResultState =
  | { state: "working"; action: ActionMeta; input: string; aspect: Aspect }
  | { state: "text"; action: ActionMeta; input: string; text: string; model: string | null; ms: number }
  | { state: "card"; action: ActionMeta; input: string; aspect: Aspect; result: PasteResult; copied: "image" | "file" | "path" | "none" }
  | { state: "error"; action: ActionMeta; input: string; aspect: Aspect; kind: string; message: string };

export interface ActionSpec {
  id: string;
  name: string;
  description?: string;
  trigger?: { hotkey?: string; menu?: boolean };
  input: "clipboard" | "item";
  needs: ActionMeta["needs"];
  output: ActionMeta["output"];
  builtin?: boolean;
  pack?: string;
  prompt?: string;
}

export interface HotkeyReport {
  action: string;
  hotkey: string;
  ok: boolean;
  problem?: string;
}

export interface ActionsInfo {
  actions: ActionSpec[];
  problems: { file: string; message: string }[];
  hotkeys: HotkeyReport[];
  folder: string;
}

export interface SidecarInfo {
  mode: string;
  bun: string | null;
  dev_daemon: string;
  dev_daemon_present: boolean;
  bundled_binary: string;
  bundled_present: boolean;
  resources: string;
  resources_present: boolean;
}

export interface UpdaterConfig {
  enabled: boolean;
  endpoint: string;
}

export interface AppInfo {
  version: string;
  identifier: string;
  debug: boolean;
  updater: UpdaterConfig;
  app_data: string;
  cards_dir: string;
  log: string;
  sidecar: SidecarInfo;
}

export interface DaemonStatus {
  alive: boolean;
  ready: boolean;
  fallback: boolean;
  version: string | null;
  engine: string | null;
}

export type Decider =
  | { kind: "none" }
  | { kind: "rules" }
  | { kind: "laya"; url?: string }
  | { kind: "proxy"; url: string; tokenRef?: string }
  | { kind: "cloudflare"; accountId: string; tokenRef: string }
  | { kind: "hosted"; tokenRef: string; url?: string };

export type Generator =
  | { kind: "none" }
  | { kind: "openai-compatible"; baseUrl: string; model: string; apiKeyRef?: string; reasoning?: "none" | "low" | "medium" | "high"; timeoutMs?: number }
  | { kind: "anthropic"; apiKeyRef: string; model?: string }
  | { kind: "hosted"; tokenRef: string; url?: string };

export interface ProvidersConfig {
  decider: Decider;
  generator: Generator;
  offline: boolean;
}

/** `ProvidersForm` in providers.rs: the config plus the four Keychain secrets. */
export interface ProvidersForm {
  config: ProvidersConfig;
  proxyToken: string;
  cloudflareToken: string;
  hostedToken: string;
  generatorApiKey: string;
}

/** `SECRET_REFS` in core/src/provider/config.ts. */
export const SECRET_REFS = {
  proxyToken: "pocket-paste/proxy",
  cloudflareToken: "pocket-paste/cloudflare",
  hostedToken: "pocket-paste/hosted",
  generatorApiKey: "pocket-paste/generator",
} as const;

export const DEFAULT_OPENAI_BASE_URL = "http://localhost:11434/v1";
export const DEFAULT_HOSTED_URL = "https://api.peesuto.com";
export const DEFAULT_LAYA_URL = "http://127.0.0.1:8790/";

export interface SubscriptionForm {
  key: string;
  baseUrl: string;
  defaultBaseUrl: string;
  hostedActive: boolean;
}

/** `GET /v1/me` */
export interface SubscriptionMe {
  plan: string;
  quota: number;
  used: number;
  resetsAt: string;
  label?: string;
  active: boolean;
}

/** One entry of `GET /v1/packs`. */
export interface PackEntry {
  id: string;
  name: string;
  version: string;
  kind: "actions" | "styles";
  minApp?: string;
  bytes: number;
  sha256: string;
  url: string;
  requiresPlan?: string[];
}

/** `health.packs` from Core. */
export interface InstalledPack {
  id: string;
  name: string;
  version: string;
  kind: "actions" | "styles";
}

export interface InstallReport {
  id: string;
  path: string;
  problems: { file: string; message: string }[];
}

export interface PrivacyInfo {
  destinations: string[];
  egress_log: string;
  egress_lines: string[];
  answer_cache: string;
  offline: boolean;
}

export interface Settings {
  hotkey: string;
  aspect: Aspect;
  sidecar_mode: "dev" | "bundled";
  dev_repo_path: string;
  onboarded: boolean;
  retention_days: number;
  blacklist: string[];
  smart_paste: boolean;
  hosted_url: string;
}

export const DEFAULT_BLACKLIST = [
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.bitwarden.desktop",
  "com.apple.keychainaccess",
];

export const DEFAULTS: Settings = {
  hotkey: "CmdOrCtrl+Shift+V",
  aspect: "chat",
  sidecar_mode: "dev",
  dev_repo_path: "/Users/nya/codes/github/pocket-paste",
  onboarded: false,
  retention_days: 30,
  blacklist: DEFAULT_BLACKLIST,
  smart_paste: true,
  hosted_url: "",
};

export const ACCESSIBILITY_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

export function openSettingsStore(): Promise<Store> {
  return load("settings.json", { autoSave: false });
}

export async function readSettings(store: Store): Promise<Settings> {
  const s: Settings = { ...DEFAULTS, blacklist: [...DEFAULT_BLACKLIST] };
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const v = await store.get<unknown>(key);
    if (v === undefined || v === null || v === "") continue;
    (s as unknown as Record<string, unknown>)[key] = v;
  }
  return s;
}

/** Core's error kinds (plus the shell's own) as short sentences. */
export function humanError(kind: string, message: string): { title: string; detail: string; settings: boolean } {
  switch (kind) {
    case "empty": return { title: "Nothing to work on", detail: message || "Copy some text, then try again.", settings: false };
    case "usage": case "input": case "action:input": return { title: "This text could not be used.", detail: message, settings: false };
    case "provider:config": return { title: "The provider is not set up.", detail: message, settings: true };
    case "provider:auth": return { title: "Your API credential was rejected.", detail: "Check Settings → Providers.", settings: true };
    case "provider:network": return { title: "The provider could not be reached.", detail: "Check your connection and the URL in Settings → Providers.", settings: true };
    case "provider:timeout": return { title: "The provider took too long.", detail: "Try again in a moment.", settings: false };
    case "provider:model": return { title: "The model is unavailable right now.", detail: message, settings: false };
    case "provider:bad-response": return { title: "The provider answered with something unexpected.", detail: message, settings: false };
    case "provider:quota": return { title: "Your quota is used up.", detail: "Check your plan, or switch providers in Settings.", settings: true };
    case "provider:offline": return { title: "Offline mode is on.", detail: "Nothing is sent to any provider while it is on. Turn it off in Settings → Privacy.", settings: true };
    case "provider:unavailable": return { title: "No provider for this.", detail: message, settings: true };
    case "action:needs": return { title: "This action needs a provider.", detail: `${message}. Configure one in Settings → Providers.`, settings: true };
    case "action:spec": return { title: "This action is not valid.", detail: message, settings: true };
    case "action:run": return { title: "The action did not finish.", detail: message, settings: false };
    case "compose": return { title: "This text does not fit a card.", detail: message, settings: false };
    case "engine": return { title: "The render engine is not set up.", detail: message, settings: true };
    case "sidecar": return { title: "Core could not start.", detail: message, settings: true };
    case "timeout": return { title: "It took too long.", detail: message || "It was stopped. Try again.", settings: false };
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

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
