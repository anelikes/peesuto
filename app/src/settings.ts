/** Settings and first-run onboarding: General, Providers (two tracks), Actions, Privacy, Exclusions. */
import { t, actionName, getLocale, type Language } from "./i18n";
import { initLocale, onLocaleChange, localeState, changeLanguage } from "./locale";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { open as pickPath } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Store } from "@tauri-apps/plugin-store";
import {
  $, ACCESSIBILITY_URL, DEFAULT_BLACKLIST, DEFAULT_OPENAI_BASE_URL, DEFAULTS, el, humanError, isPasteError, openSettingsStore, readSettings,
  formatBytes,
  type ActionsInfo, type AppInfo, type Aspect, type ClipItem, type Context, type DaemonStatus, type HistoryStatus, type HotkeyReport,
  type InstalledPack, type InstallReport, type PackEntry, type PickResult, type PrivacyInfo, type ProvidersForm, type Settings,
  type SubscriptionForm, type SubscriptionMe,
} from "./shared";

const intro = $("intro");
const axStatus = $("ax-status");
const hotkey = $<HTMLInputElement>("hotkey");
const smartPaste = $<HTMLInputElement>("smart-paste");
const aspect = $<HTMLSelectElement>("aspect");
const sidecarMode = $<HTMLSelectElement>("sidecar-mode");
const repoField = $("repo-field");
const devRepo = $<HTMLInputElement>("dev-repo");
const sidecarInfo = $("sidecar-info");
const daemonStatus = $("daemon-status");
const appInfo = $("app-info");
const autostart = $<HTMLInputElement>("autostart");
const status = $("status");

const deciderKind = $<HTMLSelectElement>("decider-kind");
const generatorKind = $<HTMLSelectElement>("generator-kind");
const offline = $<HTMLInputElement>("offline");
const offlinePrivacy = $<HTMLInputElement>("offline-privacy");
const retention = $<HTMLInputElement>("retention");
const blacklistEl = $<HTMLUListElement>("blacklist");
const blacklistAdd = $<HTMLInputElement>("blacklist-add");

let store: Store;
let loaded: Settings = { ...DEFAULTS };
let blacklist: string[] = [...DEFAULT_BLACKLIST];

function say(text: string, kind: "" | "ok" | "err" = ""): void {
  status.textContent = text;
  status.className = `status ${kind}`;
}

// ---- panes ----
for (const tab of document.querySelectorAll<HTMLButtonElement>(".tabs button")) {
  tab.addEventListener("click", () => showPane(tab.dataset.pane ?? "general"));
}
function showPane(name: string): void {
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tabs button")) tab.setAttribute("aria-selected", String(tab.dataset.pane === name));
  for (const pane of document.querySelectorAll<HTMLElement>(".pane")) pane.hidden = pane.id !== `pane-${name}`;
  if (name === "privacy") void refreshPrivacy();
  if (name === "actions") void refreshActions();
  if (name === "general") void refreshDaemon();
  if (name === "subscription") void refreshSubscription();
  try { localStorage.setItem("pane", name); } catch { /* fine */ }
}

function syncVisibility(): void {
  repoField.hidden = sidecarMode.value !== "dev";
  for (const box of document.querySelectorAll<HTMLElement>("[data-decider]")) box.hidden = box.dataset.decider !== deciderKind.value;
  for (const box of document.querySelectorAll<HTMLElement>("[data-generator]")) box.hidden = box.dataset.generator !== generatorKind.value;
}

// ---- general ----
async function refreshAccessibility(): Promise<void> {
  const trusted = await invoke<boolean>("accessibility_status").catch(() => false);
  axStatus.textContent = trusted ? t("Allowed") : t("Not allowed");
  axStatus.className = `pill ${trusted ? "ok" : "warn"}`;
}

async function refreshInfo(): Promise<void> {
  try {
    const info = await invoke<AppInfo>("app_info");
    const s = info.sidecar;
    const mark = (ok: boolean) => (ok ? "✓" : "✗");
    sidecarInfo.textContent = [
      t("dev: bun {0} · {1} {2}", [s.bun ?? t("not found"), mark(s.dev_daemon_present), s.dev_daemon]),
      t("bundled: {0} {1} · {2} {3}", [mark(s.bundled_present), s.bundled_binary, mark(s.resources_present), s.resources]),
    ].join("\n");
    appInfo.textContent = t("{0} {1}{2}\ndata: {3}\nlog: {4}\nupdates: {5}", [info.identifier, info.version, info.debug ? t(" (debug)") : "", info.app_data, info.log, info.updater.enabled ? info.updater.endpoint : t("not configured in this build")]);
    $("packs-from-folder").hidden = !info.debug;
  } catch (e) {
    sidecarInfo.textContent = String(e);
  }
}

async function refreshDaemon(): Promise<void> {
  try {
    const d = await invoke<DaemonStatus>("daemon_status");
    const label = d.fallback ? t("Core: gave up (CLI fallback)") : d.ready ? t("Core: ready{0}{1}", [d.version ? ` ${d.version}` : "", d.engine ? "" : t(" · no engine")]) : d.alive ? t("Core: starting…") : t("Core: idle (starts on demand)");
    daemonStatus.textContent = label;
    daemonStatus.className = `pill ${d.fallback ? "warn" : d.ready ? "ok" : ""}`;
  } catch (e) {
    daemonStatus.textContent = String(e);
  }
}

// ---- providers ----
type Reasoning = "none" | "low" | "medium" | "high";
const isReasoning = (s: string): s is Reasoning => s === "none" || s === "low" || s === "medium" || s === "high";
/** The timeout field is seconds for people; the config carries milliseconds. Blank or nonsense → unset. */
function timeoutMsOf(seconds: string): number | undefined {
  const n = Number(seconds);
  return seconds !== "" && Number.isFinite(n) && n >= 1 ? Math.round(n) * 1000 : undefined;
}

function readProvidersForm(): ProvidersForm {
  const v = (id: string) => $<HTMLInputElement>(id).value.trim();
  const opt = (s: string) => (s ? s : undefined);
  // Rules is the default, so an unknown kind (a select with no matching option) falls back to it.
  const decider: ProvidersForm["config"]["decider"] =
    deciderKind.value === "none" ? { kind: "none" }
    : deciderKind.value === "laya" ? { kind: "laya", url: opt(v("laya-url")) }
    : deciderKind.value === "proxy" ? { kind: "proxy", url: v("proxy-url") || "http://localhost:8787/" }
    : deciderKind.value === "cloudflare" ? { kind: "cloudflare", accountId: v("cf-account"), tokenRef: "" }
    : deciderKind.value === "hosted" ? { kind: "hosted", tokenRef: "", url: opt(v("hosted-url")) }
    : { kind: "rules" };
  const generator: ProvidersForm["config"]["generator"] =
    generatorKind.value === "openai-compatible" ? {
      kind: "openai-compatible", baseUrl: v("oai-url") || DEFAULT_OPENAI_BASE_URL, model: v("oai-model"),
      ...(isReasoning(v("oai-reasoning")) ? { reasoning: v("oai-reasoning") as Reasoning } : {}),
      ...(timeoutMsOf(v("oai-timeout")) === undefined ? {} : { timeoutMs: timeoutMsOf(v("oai-timeout")) }),
    }
    : generatorKind.value === "anthropic" ? { kind: "anthropic", apiKeyRef: "", model: opt(v("anthropic-model")) }
    : generatorKind.value === "hosted" ? { kind: "hosted", tokenRef: "", url: opt(v("gen-hosted-url")) }
    : { kind: "none" };
  const hostedToken = deciderKind.value === "hosted" ? v("hosted-token") || v("gen-hosted-token") : v("gen-hosted-token") || v("hosted-token");
  const generatorApiKey = generatorKind.value === "anthropic" ? v("anthropic-key") : v("oai-key") || v("anthropic-key");
  return { config: { decider, generator, offline: offline.checked }, proxyToken: v("proxy-token"), cloudflareToken: v("cf-token"), hostedToken, generatorApiKey };
}

function fillProvidersForm(f: ProvidersForm): void {
  const set = (id: string, value: string | undefined) => { $<HTMLInputElement>(id).value = value ?? ""; };
  const d = f.config.decider;
  deciderKind.value = d.kind;
  if (d.kind === "laya") set("laya-url", d.url);
  if (d.kind === "proxy") set("proxy-url", d.url);
  if (d.kind === "cloudflare") set("cf-account", d.accountId);
  if (d.kind === "hosted") set("hosted-url", d.url);
  const g = f.config.generator;
  generatorKind.value = g.kind;
  if (g.kind === "openai-compatible") { set("oai-url", g.baseUrl); set("oai-model", g.model); set("oai-reasoning", g.reasoning); set("oai-timeout", g.timeoutMs === undefined ? undefined : String(Math.round(g.timeoutMs / 1000))); }
  if (g.kind === "anthropic") set("anthropic-model", g.model);
  if (g.kind === "hosted") set("gen-hosted-url", g.url);
  set("proxy-token", f.proxyToken);
  set("cf-token", f.cloudflareToken);
  set("hosted-token", f.hostedToken);
  set("gen-hosted-token", f.hostedToken);
  set("oai-key", f.generatorApiKey);
  set("anthropic-key", f.generatorApiKey);
  offline.checked = f.config.offline;
  offlinePrivacy.checked = f.config.offline;
  if (!$<HTMLInputElement>("oai-url").value) $<HTMLInputElement>("oai-url").value = DEFAULT_OPENAI_BASE_URL;
}

const TEST_SENTENCE = "Peesuto keeps what you copy and pastes what fits.";
const LAYA_GUIDE_URL = "https://github.com/anelikes/peesuto/blob/main/docs/laya.md";

async function testDecider(): Promise<void> {
  const out = $("test-decider-out");
  out.textContent = t("Saving and asking…");
  if (!(await saveAll())) { out.textContent = t("Fix the save first."); return; }
  const now = Date.now();
  const candidates: ClipItem[] = [
    { id: "t1", kind: "text", text: "https://example.com/report.pdf", preview: "https://example.com/report.pdf", createdAt: now - 60_000, pinned: false, bytes: 30, types: [] },
    { id: "t2", kind: "text", text: "Dear team, please find the report attached.", preview: "Dear team, please find the report attached.", createdAt: now - 5_000, pinned: false, bytes: 43, types: [] },
  ];
  const context: Context = { level: 2, appBundleId: "com.apple.mail", appName: "Mail", role: "AXTextArea", label: "Message body", before: "Here is the link: ", after: "" };
  try {
    const t0 = performance.now();
    const r = await invoke<PickResult>("daemon_pick", { context, candidates, fresh: true });
    const top = r.ranked[0];
    // Rules only decides cards (the pick keeps its heuristic), so say so rather than look unused.
    const note = deciderKind.value === "rules" ? t("rules decide cards locally · pick ") : "";
    out.textContent = t("{0}{1} · top: “{2}” ({3}) · shouldPaste {4} % · {5} ms", [note, t(r.source), top?.item.preview ?? "?", top?.reason ?? "", (r.shouldPaste * 100).toFixed(0), Math.round(performance.now() - t0)]);
    out.className = "help ok";
  } catch (e) {
    const err = isPasteError(e) ? e : { kind: "error", message: String(e) };
    const h = humanError(err.kind, err.message);
    out.textContent = `${h.title} ${h.detail}`;
    out.className = "help err";
  }
}

async function testGenerator(): Promise<void> {
  const out = $("test-generator-out");
  out.textContent = t("Saving and asking…");
  if (!(await saveAll())) { out.textContent = t("Fix the save first."); return; }
  try {
    const t0 = performance.now();
    const r = await invoke<{ result: { output: string; text?: string; model?: string } }>("daemon_run_action", { action: "paste-summary", input: { text: TEST_SENTENCE, fresh: true } });
    out.textContent = `${r.result.model ?? "model"} · ${Math.round(performance.now() - t0)} ms: ${r.result.text ?? ""}`;
    out.className = "help ok";
  } catch (e) {
    const err = isPasteError(e) ? e : { kind: "error", message: String(e) };
    const h = humanError(err.kind, err.message);
    out.textContent = `${h.title} ${h.detail}`;
    out.className = "help err";
  }
}

// ---- actions ----
function renderActions(info: ActionsInfo): void {
  const body = $("actions-table").querySelector("tbody")!;
  const reports = new Map(info.hotkeys.map((h) => [h.action, h]));
  body.replaceChildren(...info.actions.map((a) => {
    const tr = el("tr");
    const name = el("td");
    name.append(el("div", "", actionName(a)), el("div", "help mono", a.id));
    if (a.description) name.title = a.builtin ? t(a.description) : a.description;
    const hk = el("td");
    const r: HotkeyReport | undefined = reports.get(a.id);
    const key = a.needs === "decider" ? hotkey.value : a.trigger?.hotkey;
    if (key) {
      hk.append(el("span", "mono", key));
      if (r && !r.ok) { const p = el("div", "help err", t(r.problem ?? "not registered")); hk.append(p); }
      else if (r?.ok) hk.append(el("span", "pill ok tiny", t("on")));
    } else hk.textContent = "—";
    const source = a.builtin ? t("built-in") : a.pack ? t("pack {0}", [a.pack]) : t("your file");
    tr.append(name, el("td", "", t(a.needs)), el("td", "", t(a.output)), hk, el("td", "", source));
    return tr;
  }));
  const problems = $("actions-problems");
  problems.replaceChildren(...info.problems.map((p) => el("li", "err", `${p.file}: ${p.message}`)));
  $("actions-status").textContent = t("{0} action(s) · {1}", [info.actions.length, info.folder]);
}

async function refreshActions(reload = false): Promise<void> {
  try {
    renderActions(await invoke<ActionsInfo>(reload ? "actions_reload" : "actions_list"));
  } catch (e) {
    $("actions-status").textContent = String(e);
  }
}

// ---- privacy ----
const PRIVACY_ROWS: { data: string; stored: string; leaves: string; sw: string; pane?: string }[] = [
  { data: "clipboard text, RTF, HTML", stored: "encrypted SQLite in App Support; key in Keychain", leaves: "only as part of a decider question or a generator prompt, and only for the item you act on; never with decider = rules, and only to the local Laya URL with decider = laya", sw: "decider = rules or none, generator = none, or Offline", pane: "providers" },
  { data: "images, files copied", stored: "thumbnail + original under App Support (encrypted)", leaves: "never", sw: "retention / clear all", pane: "exclusions" },
  { data: "app bundle id per item", stored: "with the item", leaves: "as part of the pick question's state (bundle id only); the pick stays local with decider = rules or none", sw: "decider = rules or none", pane: "providers" },
  { data: "focused field context (role, label, text around the caret)", stored: "never", leaves: "as part of the pick question, redacted per level; the pick stays local with decider = rules or none", sw: "smart paste off, or decider = rules or none", pane: "general" },
  { data: "history search queries", stored: "never", leaves: "never", sw: "—" },
  { data: "provider credentials", stored: "Keychain", leaves: "to the provider they belong to", sw: "—", pane: "providers" },
  { data: "egress log (host, purpose, bytes, status)", stored: "App Support/egress.log", leaves: "never", sw: "Clear log (below)" },
  { data: "answer cache (decider answers keyed by text hash)", stored: "App Support/answers/", leaves: "never", sw: "Clear answer cache (below)" },
  { data: "emoji codepoints", stored: "cached PNGs", leaves: "to jsdelivr on first use of an emoji not in the bundled set", sw: "ship the bundled set" },
];

function renderPrivacyTable(): void {
  const body = $("privacy-table").querySelector("tbody")!;
  body.replaceChildren(...PRIVACY_ROWS.map((r) => {
    const tr = el("tr");
    const sw = el("td");
    if (r.pane) {
      const b = el("button", "link", t(r.sw));
      const pane = r.pane;
      b.addEventListener("click", () => showPane(pane));
      sw.append(b);
    } else sw.textContent = t(r.sw);
    tr.append(el("td", "", t(r.data)), el("td", "", t(r.stored)), el("td", "", t(r.leaves)), sw);
    return tr;
  }));
}

async function refreshPrivacy(): Promise<void> {
  try {
    const p = await invoke<PrivacyInfo>("privacy_info");
    $("destinations").replaceChildren(...p.destinations.map((d) => {
      const [kind, ...host] = d.split(" → ");
      return el("li", "", host.length ? `${t(kind)} → ${t(host.join(" → "))}` : d);
    }));
    $("egress-path").textContent = p.egress_log;
    $("egress-log").textContent = p.egress_lines.length ? p.egress_lines.join("\n") : t("(empty — nothing has left this Mac)");
    offlinePrivacy.checked = p.offline;
  } catch (e) {
    $("privacy-status").textContent = String(e);
  }
}

// ---- exclusions ----
function renderBlacklist(): void {
  blacklistEl.replaceChildren(...blacklist.map((b) => {
    const li = el("li");
    li.append(el("span", "mono", b));
    const x = el("button", "icon", "×");
    x.title = t("Remove");
    x.addEventListener("click", () => { blacklist = blacklist.filter((v) => v !== b); renderBlacklist(); });
    li.append(x);
    return li;
  }));
}

function addBlacklist(): void {
  const v = blacklistAdd.value.trim();
  if (!v) return;
  if (!blacklist.includes(v)) blacklist.push(v);
  blacklistAdd.value = "";
  renderBlacklist();
}

async function refreshHistoryStatus(): Promise<void> {
  try {
    const s = await invoke<HistoryStatus>("history_status");
    $("history-status").textContent = s.state === "ok" ? t("{0} item(s) in the encrypted history.", [s.items]) : s.state === "locked" ? t("History locked: {0}", [t(s.detail)]) : s.state === "opening" ? t("Opening the history…") : t("History is kept in memory only (no Keychain key).");
  } catch { /* fine */ }
}

// ---- subscription & packs ----
const subKey = $<HTMLInputElement>("sub-key");
const subBase = $<HTMLInputElement>("sub-base");
const subStatus = $("sub-status");
const subUseHosted = $<HTMLButtonElement>("sub-use-hosted");
const packsStatus = $("packs-status");
let subscription: SubscriptionForm | null = null;
let subscriptionMe: SubscriptionMe | null = null;
let packIndex: PackEntry[] | null = null;

function errText(e: unknown): string {
  return isPasteError(e) ? e.message : String(e);
}

async function refreshSubscription(): Promise<void> {
  try {
    subscription = await invoke<SubscriptionForm>("subscription_get");
    subKey.value = subscription.key;
    subBase.value = subscription.baseUrl;
    subBase.placeholder = subscription.defaultBaseUrl;
    subUseHosted.disabled = !subscription.key;
    subUseHosted.textContent = subscription.hostedActive ? t("Hosted is active for both tracks") : t("Use hosted for both tracks");
  } catch (e) {
    subStatus.textContent = errText(e);
  }
  await refreshInstalledPacks();
}

function showMe(me: SubscriptionMe): void {
  subscriptionMe = me;
  $("sub-me").hidden = false;
  $("sub-plan").textContent = `${me.plan}${me.label ? ` (${me.label})` : ""}${me.active ? "" : t(" — inactive")}`;
  $("sub-quota").textContent = t("{0} of {1} calls used this period", [me.used, me.quota]);
  $("sub-resets").textContent = me.resetsAt ? new Date(me.resetsAt).toLocaleString(getLocale()) : "—";
}

async function activate(): Promise<void> {
  subStatus.textContent = t("Checking the key…");
  subStatus.className = "help";
  try {
    const me = await invoke<SubscriptionMe>("subscription_activate", { key: subKey.value.trim(), baseUrl: subBase.value.trim() || subBase.placeholder });
    showMe(me);
    subStatus.textContent = t("Activated.");
    subStatus.className = "help ok";
    subUseHosted.disabled = false;
  } catch (e) {
    subscriptionMe = null;
    $("sub-me").hidden = true;
    subStatus.textContent = errText(e);
    subStatus.className = "help err";
  }
}

async function useHosted(): Promise<void> {
  subStatus.textContent = t("Switching both tracks to hosted…");
  try {
    const providers = await invoke<{ decider: string; generator: string; offline: boolean }>("subscription_use_hosted");
    subStatus.textContent = t("Core now uses {0} / {1}.", [providers.decider, providers.generator]);
    subStatus.className = "help ok";
    if (subscription) subscription.hostedActive = true;
    subUseHosted.textContent = t("Hosted is active for both tracks");
    try { fillProvidersForm(await invoke<ProvidersForm>("providers_get")); syncVisibility(); } catch { /* the pane refreshes on open */ }
  } catch (e) {
    subStatus.textContent = errText(e);
    subStatus.className = "help err";
  }
}

function showProblems(problems: { file: string; message: string }[]): void {
  $("packs-problems").replaceChildren(...problems.map((p) => el("li", "err", `${p.file}: ${p.message}`)));
}

async function refreshInstalledPacks(): Promise<void> {
  try {
    const packs = await invoke<InstalledPack[]>("packs_installed");
    const list = $("packs-installed");
    list.replaceChildren(...packs.map((p) => {
      const li = el("li");
      li.append(el("span", "", `${p.name} ${p.version} · ${t(p.kind)} `), el("span", "help mono", p.id));
      const rm = el("button", "link danger", t("Remove"));
      rm.addEventListener("click", async () => {
        packsStatus.textContent = t("Removing {0}…", [p.id]);
        try { showProblems(await invoke<{ file: string; message: string }[]>("packs_remove", { id: p.id })); packsStatus.textContent = t("Removed {0}.", [p.id]); }
        catch (e) { packsStatus.textContent = errText(e); }
        await refreshInstalledPacks();
      });
      li.append(rm);
      return li;
    }));
    if (packs.length === 0) list.replaceChildren(el("li", "help", t("No packs installed.")));
  } catch (e) {
    packsStatus.textContent = errText(e);
  }
}

function renderPackIndex(index: PackEntry[]): void {
  packIndex = index;
  const body = $("packs-index").querySelector("tbody")!;
  body.replaceChildren(...index.map((p) => {
    const tr = el("tr");
    const name = el("td");
    name.append(el("div", "", p.name), el("div", "help mono", p.id));
    const act = el("td");
    const b = el("button", "", t("Install"));
    b.addEventListener("click", async () => {
      b.disabled = true;
      packsStatus.textContent = t("Installing {0}…", [p.name]);
      try {
        const r = await invoke<InstallReport>("packs_install", { id: p.id, url: p.url, sha256: p.sha256 });
        showProblems(r.problems);
        packsStatus.textContent = t("Installed {0}{1}.", [r.id, r.problems.length ? t(" with {0} problem(s)", [r.problems.length]) : ""]);
        packsStatus.className = r.problems.length ? "help err" : "help ok";
      } catch (e) {
        packsStatus.textContent = `${p.name}: ${errText(e)}`;
        packsStatus.className = "help err";
      } finally {
        b.disabled = false;
        await refreshInstalledPacks();
      }
    });
    act.append(b);
    tr.append(name, el("td", "", p.version), el("td", "", t(p.kind)), el("td", "", formatBytes(p.bytes)), act);
    return tr;
  }));
}

async function browsePacks(): Promise<void> {
  packsStatus.textContent = t("Loading the pack index…");
  packsStatus.className = "help";
  try {
    const index = await invoke<PackEntry[]>("packs_index");
    renderPackIndex(index);
    $("packs-index-wrap").hidden = false;
    packsStatus.textContent = t("{0} pack(s) available.", [index.length]);
  } catch (e) {
    packsStatus.textContent = errText(e);
    packsStatus.className = "help err";
  }
}

async function installFromFolder(): Promise<void> {
  const dir = await pickPath({ directory: true, multiple: false, title: t("Choose a pack folder (with pack.json)") });
  if (!dir) return;
  packsStatus.textContent = t("Installing from {0}…", [dir]);
  try {
    const r = await invoke<InstallReport>("packs_install_from_folder", { path: dir });
    showProblems(r.problems);
    packsStatus.textContent = t("Installed {0} → {1}", [r.id, r.path]);
    packsStatus.className = r.problems.length ? "help err" : "help ok";
  } catch (e) {
    packsStatus.textContent = errText(e);
    packsStatus.className = "help err";
  }
  await refreshInstalledPacks();
}

$("sub-activate").addEventListener("click", () => void activate());
subUseHosted.addEventListener("click", () => void useHosted());
$("packs-browse").addEventListener("click", () => void browsePacks());
$("packs-folder").addEventListener("click", () => void invoke("packs_open_folder").catch((e) => { packsStatus.textContent = errText(e); }));
$("packs-from-folder").addEventListener("click", () => void installFromFolder());

// ---- save ----
function collect(): Settings {
  return {
    hotkey: hotkey.value.trim() || DEFAULTS.hotkey,
    aspect: aspect.value as Aspect,
    sidecar_mode: sidecarMode.value as Settings["sidecar_mode"],
    dev_repo_path: devRepo.value.trim() || DEFAULTS.dev_repo_path,
    onboarded: true,
    retention_days: Math.max(0, Math.min(3650, Number.parseInt(retention.value, 10) || 0)),
    blacklist: [...blacklist],
    smart_paste: smartPaste.checked,
    hosted_url: subBase.value.trim(),
  };
}

async function saveAll(): Promise<boolean> {
  const s = collect();
  for (const [k, v] of Object.entries(s)) await store.set(k, v);
  await store.save();
  const restart = s.sidecar_mode !== loaded.sidecar_mode || s.dev_repo_path !== loaded.dev_repo_path;
  loaded = s;
  let ok = true;
  say(t("Saving…"));
  try {
    await invoke("providers_set", { form: readProvidersForm() });
  } catch (e) {
    const err = isPasteError(e) ? e : { kind: "error", message: String(e) };
    say(t("Saved, but Core rejected the providers: {0}", [err.message]), "err");
    ok = false;
  }
  try {
    const reports = await invoke<HotkeyReport[]>("settings_apply", { restart });
    const bad = reports.filter((r) => !r.ok);
    if (bad.length) {
      say(t("Saved. Shortcut problems: {0}", [bad.map((b) => `${b.action} (${b.hotkey}): ${b.problem}`).join("; ")]), "err");
      ok = false;
    }
  } catch (e) {
    say(t("Saved, but applying failed: {0}", [isPasteError(e) ? e.message : e]), "err");
    ok = false;
  }
  try {
    if (autostart.checked) await enable();
    else await disable();
  } catch (e) {
    say(t("Saved, but launch at login failed: {0}", [e]), "err");
    ok = false;
  }
  intro.hidden = true;
  if (ok) say(t("Saved"), "ok");
  void refreshInfo();
  void refreshDaemon();
  void refreshActions();
  void refreshHistoryStatus();
  return ok;
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
deciderKind.addEventListener("change", syncVisibility);
generatorKind.addEventListener("change", syncVisibility);
sidecarMode.addEventListener("change", syncVisibility);
offline.addEventListener("change", () => { offlinePrivacy.checked = offline.checked; });
offlinePrivacy.addEventListener("change", () => { offline.checked = offlinePrivacy.checked; });
$("save").addEventListener("click", () => void saveAll());
$("test-decider").addEventListener("click", () => void testDecider());
$("test-generator").addEventListener("click", () => void testGenerator());
$("ax-recheck").addEventListener("click", () => void refreshAccessibility());
$("ax-allow").addEventListener("click", async () => {
  await invoke("accessibility_prompt");
  window.setTimeout(() => void refreshAccessibility(), 800);
});
$("ax-open").addEventListener("click", () => void openUrl(ACCESSIBILITY_URL));
$("laya-guide").addEventListener("click", () => void openUrl(LAYA_GUIDE_URL));
$("ax-probe").addEventListener("click", async () => {
  const out = $("ax-probe-out");
  out.textContent = "…";
  try {
    const c = await invoke<Context>("context_probe");
    out.textContent = t("level {0} · {1}{2}{3}{4}{5}", [c.level, c.appName ?? c.appBundleId, c.role ? ` · ${c.role}` : "", c.label ? ` “${c.label}”` : "", c.secure ? t(" · secure") : "", c.before !== undefined ? t(" · {0}+{1} chars around the caret", [c.before.length, (c.after ?? "").length]) : ""]);
  } catch (e) {
    out.textContent = String(e);
  }
});
$("daemon-restart").addEventListener("click", async () => { await invoke("daemon_restart"); window.setTimeout(() => void refreshDaemon(), 1500); });
$("daemon-refresh").addEventListener("click", () => void refreshDaemon());
$("actions-folder").addEventListener("click", () => void invoke("actions_open_folder").catch((e) => { $("actions-status").textContent = String(e); }));
$("actions-new").addEventListener("click", () => void invoke<string>("actions_new").then((p) => { $("actions-status").textContent = t("Created {0} — save it, then Reload.", [p]); }).catch((e) => { $("actions-status").textContent = String(e); }));
$("actions-reload").addEventListener("click", () => void refreshActions(true));
$("egress-refresh").addEventListener("click", () => void refreshPrivacy());
$("egress-clear").addEventListener("click", async () => { await invoke("egress_log_clear"); await refreshPrivacy(); $("privacy-status").textContent = t("Log cleared."); });
$("cache-clear").addEventListener("click", async () => { const n = await invoke<number>("answer_cache_clear"); $("privacy-status").textContent = t("Answer cache cleared ({0} entries).", [n]); });
$("blacklist-add-btn").addEventListener("click", addBlacklist);
blacklistAdd.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addBlacklist(); } });
$("blacklist-reset").addEventListener("click", () => { blacklist = [...DEFAULT_BLACKLIST]; renderBlacklist(); });
void getCurrentWindow().onFocusChanged(({ payload }) => { if (payload) { void refreshAccessibility(); void refreshDaemon(); } });

async function init(): Promise<void> {
  store = await openSettingsStore();
  const s = await readSettings(store);
  loaded = s;
  hotkey.value = s.hotkey;
  smartPaste.checked = s.smart_paste;
  aspect.value = s.aspect;
  sidecarMode.value = s.sidecar_mode;
  devRepo.value = s.dev_repo_path;
  retention.value = String(s.retention_days);
  blacklist = [...s.blacklist];
  renderBlacklist();
  renderPrivacyTable();
  autostart.checked = await isEnabled().catch(() => false);
  intro.hidden = s.onboarded;
  try {
    fillProvidersForm(await invoke<ProvidersForm>("providers_get"));
  } catch (e) {
    say(t("Could not read providers: {0}", [e]), "err");
  }
  syncVisibility();
  let pane = "general";
  try { pane = localStorage.getItem("pane") ?? "general"; } catch { /* fine */ }
  showPane(s.onboarded ? pane : "general");
  await Promise.all([refreshAccessibility(), refreshInfo(), refreshDaemon(), refreshActions(), refreshHistoryStatus()]);
}
const language = $<HTMLSelectElement>("language");
language.addEventListener("change", async () => {
  language.disabled = true;
  try { await changeLanguage(language.value as Language); }
  catch (e) { language.value = localeState().language; say(t("Failed to change language: {0}", [e]), "err"); }
  finally { language.disabled = false; }
});
onLocaleChange(({ language: preference }) => {
  language.value = preference;
  // Re-render labels without reloading the window or overwriting unsaved inputs.
  renderBlacklist();
  renderPrivacyTable();
  void refreshAccessibility();
  void refreshInfo();
  void refreshDaemon();
  void refreshActions();
  void refreshHistoryStatus();
  void refreshInstalledPacks();
  if (subscriptionMe) showMe(subscriptionMe);
  if (packIndex) renderPackIndex(packIndex);
  if (!$("pane-privacy").hidden) void refreshPrivacy();
  subUseHosted.textContent = t(subscription?.hostedActive ? "Hosted is active for both tracks" : "Use hosted for both tracks");
  for (const id of ["status", "test-decider-out", "test-generator-out", "ax-probe-out", "privacy-status", "sub-status", "packs-status"]) $(id).textContent = "";
});
void initLocale().then(init);
