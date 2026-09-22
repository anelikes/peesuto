/**
 * The history panel: search, arrow keys, ⏎ pastes, ⌘⌫ deletes — and, when
 * it was opened by the hotkey, the smart pick: the items are reordered by
 * Core's ranking, the top one is preselected, and the confirm bar shows
 * where the order came from. Typing in the search drops the pick order.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  $, ACCESSIBILITY_URL, el, formatBytes, isPasteFailure, relativeTime,
  type ActionSpec, type ActionsInfo, type ClipItem, type HistoryStatus, type PickResult, type Session,
} from "./shared";

const PICK_CANDIDATES = 50;

const search = $<HTMLInputElement>("search");
const list = $<HTMLUListElement>("list");
const empty = $("empty");
const confirmBar = $("confirm");
const confirmText = $("confirm-text");
const pickDot = $("pick-dot");
const pickSpinner = $("pick-spinner");
const pickSource = $("pick-source");
const note = $("note");
const noteText = $("note-text");
const axBanner = $("ax-banner");
const locked = $("locked");
const lockedText = $("locked-text");
const freshConfirm = $("fresh-confirm");
const clearConfirm = $("clear-confirm");
const moreMenu = $("more-menu");
const context = $("context");
const contextActions = $("context-actions");

let items: ClipItem[] = [];
let selected = 0;
let contextItem: ClipItem | null = null;
/** Ids in pick order while a pick result is applied; null = recency order. */
let pickOrder: string[] | null = null;
let pickToken = 0;
let itemActions: ActionSpec[] = [];
const thumbs = new Map<string, string>();
let status: HistoryStatus | null = null;

async function refresh(): Promise<void> {
  const fetched = await invoke<ClipItem[]>("history_list", { query: search.value });
  items = pickOrder ? ordered(fetched, pickOrder) : fetched;
  if (selected >= items.length) selected = Math.max(0, items.length - 1);
  render();
}

function ordered(all: ClipItem[], order: string[]): ClipItem[] {
  const byId = new Map(all.map((i) => [i.id, i]));
  const head = order.map((id) => byId.get(id)).filter((i): i is ClipItem => !!i);
  const seen = new Set(order);
  return [...head, ...all.filter((i) => !seen.has(i.id))];
}

function render(): void {
  list.replaceChildren(...items.map(row));
  const isLocked = status?.state === "locked" || status?.state === "opening";
  empty.hidden = items.length > 0 || isLocked;
  empty.textContent = search.value ? "No match." : "Nothing copied yet.";
  confirmBar.classList.toggle("muted", items.length === 0);
  const cur = items[selected];
  confirmText.textContent = cur ? cur.preview : isLocked ? "history locked" : "nothing yet";
  list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

function iconButton(title: string, glyph: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", "icon", glyph);
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function thumbnail(it: ClipItem): HTMLElement {
  const img = el("img", "thumb");
  img.alt = it.preview;
  const cached = thumbs.get(it.id);
  if (cached) img.src = cached;
  else {
    void invoke<string>("history_thumbnail", { id: it.id })
      .then((b64) => { const url = `data:image/png;base64,${b64}`; thumbs.set(it.id, url); img.src = url; })
      .catch(() => { img.remove(); });
  }
  return img;
}

function row(it: ClipItem, i: number): HTMLLIElement {
  const li = el("li", "item" + (i === selected ? " selected" : "") + (it.pinned ? " pinned" : "") + (it.kind === "image" ? " image" : ""));
  li.setAttribute("role", "option");
  li.setAttribute("aria-selected", String(i === selected));

  if (it.kind === "image") li.append(thumbnail(it));
  const main = el("div", "item-main");
  const text = el("div", "item-text", it.preview || "(empty)");
  const meta = el("div", "item-meta");
  const badges = it.types.filter((t) => t !== "file-url" && !(it.kind === "image" && t === "image")).map((t) => t.toUpperCase());
  if (it.kind === "file") badges.unshift("FILE");
  if (it.kind === "image") badges.unshift(formatBytes(it.bytes));
  meta.textContent = [it.appName ?? it.appBundleId ?? "", relativeTime(it.createdAt), ...badges].filter(Boolean).join(" · ");
  main.append(text, meta);

  const tools = el("div", "item-tools");
  tools.append(iconButton(it.pinned ? "Unpin" : "Pin", it.pinned ? "★" : "☆", () => void invoke("history_pin", { id: it.id, pinned: !it.pinned })));
  if (it.kind !== "image") tools.append(iconButton("Actions", "▸", () => { const r = li.getBoundingClientRect(); selected = i; render(); openContext(r.right - 160, r.bottom, it); }));
  tools.append(iconButton("Delete", "×", () => void invoke("history_delete", { id: it.id })));

  li.append(main, tools);
  li.addEventListener("click", () => { selected = i; render(); });
  li.addEventListener("dblclick", () => void paste(it));
  li.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    selected = i;
    render();
    openContext(e.clientX, e.clientY, it);
  });
  return li;
}

function move(delta: number): void {
  if (items.length === 0) return;
  selected = (selected + delta + items.length) % items.length;
  render();
}

async function paste(it: ClipItem | undefined): Promise<void> {
  if (!it) return;
  try {
    await invoke("paste_item", { id: it.id });
  } catch (e) {
    if (isPasteFailure(e) && e.kind === "accessibility") {
      axBanner.hidden = false;
    } else {
      confirmText.textContent = isPasteFailure(e) ? e.message : String(e);
    }
  }
}

// ---- the smart pick ----

function showPick(state: "idle" | "working" | "done", result?: PickResult): void {
  pickSpinner.hidden = state !== "working";
  pickSource.hidden = state !== "done";
  pickDot.hidden = state !== "done";
  if (state === "done" && result) {
    pickSource.textContent = result.source;
    pickSource.title = result.ranked[0]?.reason ?? "";
    const p = result.shouldPaste;
    pickDot.className = `dot ${p >= 0.6 ? "hi" : p >= 0.3 ? "mid" : "lo"}`;
    pickDot.title = `Looks like a place to paste: ${(p * 100).toFixed(0)} %`;
  }
}

function cancelPick(): void {
  pickToken++;
  pickOrder = null;
  showPick("idle");
}

async function startPick(s: Session): Promise<void> {
  const token = ++pickToken;
  showPick("working");
  let result: PickResult | null = null;
  try {
    const candidates = await invoke<ClipItem[]>("history_recent", { limit: PICK_CANDIDATES });
    if (token !== pickToken) return;
    if (candidates.length === 0) { showPick("idle"); return; }
    result = await invoke<PickResult>("daemon_pick", { context: s.context, candidates });
  } catch (e) {
    console.warn("pick failed; recency order", e);
  }
  if (token !== pickToken || search.value) return;
  if (!result) { showPick("idle"); return; }
  pickOrder = result.ranked.map((r) => r.item.id);
  selected = 0;
  showPick("done", result);
  await refresh();
}

function onOpen(s: Session): void {
  note.hidden = !s.note;
  noteText.textContent = s.note ?? "";
  if (s.smart) void startPick(s);
  else cancelPick();
}

// ---- menus ----

function hide(): void {
  closeMenus();
  void invoke("hide_history_cmd");
}

function closeMenus(): void {
  moreMenu.hidden = true;
  context.hidden = true;
  contextItem = null;
}

function openContext(x: number, y: number, it: ClipItem): void {
  contextItem = it;
  const pin = context.querySelector<HTMLButtonElement>('[data-action="pin"]');
  if (pin) pin.textContent = it.pinned ? "Unpin" : "Pin";
  contextActions.replaceChildren(...(it.kind === "image" ? [] : itemActions.map((a) => {
    const b = el("button", "", a.name);
    b.dataset.action = `run:${a.id}`;
    b.title = a.description ?? "";
    return b;
  })));
  context.hidden = false;
  const maxX = window.innerWidth - context.offsetWidth - 8;
  const maxY = window.innerHeight - context.offsetHeight - 8;
  context.style.left = `${Math.max(4, Math.min(x, maxX))}px`;
  context.style.top = `${Math.max(4, Math.min(y, maxY))}px`;
}

context.addEventListener("click", (e) => {
  const action = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-action]")?.dataset.action;
  const it = contextItem;
  closeMenus();
  if (!action || !it) return;
  if (action === "paste") void paste(it);
  else if (action === "pin") void invoke("history_pin", { id: it.id, pinned: !it.pinned });
  else if (action === "delete") void invoke("history_delete", { id: it.id });
  else if (action.startsWith("run:")) void invoke("action_run", { id: action.slice(4), itemId: it.id });
});

$("more").addEventListener("click", (e) => {
  e.stopPropagation();
  context.hidden = true;
  moreMenu.hidden = !moreMenu.hidden;
});
moreMenu.addEventListener("click", (e) => {
  const action = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-action]")?.dataset.action;
  closeMenus();
  if (action === "clear") clearConfirm.hidden = false;
  if (action === "settings") void invoke("open_settings");
});
$("clear-yes").addEventListener("click", () => { clearConfirm.hidden = true; thumbs.clear(); void invoke("history_clear"); });
$("clear-no").addEventListener("click", () => { clearConfirm.hidden = true; });
$("locked-fresh").addEventListener("click", () => { freshConfirm.hidden = false; });
$("fresh-no").addEventListener("click", () => { freshConfirm.hidden = true; });
$("fresh-yes").addEventListener("click", async () => {
  freshConfirm.hidden = true;
  try {
    await invoke("history_start_fresh");
  } catch (e) {
    lockedText.textContent = `Could not start fresh: ${e}`;
  }
  await checkStatus();
  await refresh();
});
$("ax-allow").addEventListener("click", () => void invoke("accessibility_prompt"));
$("ax-settings").addEventListener("click", () => void openUrl(ACCESSIBILITY_URL));

document.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest(".dropdown, .menu-anchor")) closeMenus();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    if (!moreMenu.hidden || !context.hidden) closeMenus();
    else hide();
    return;
  }
  if (e.key === "ArrowDown") { e.preventDefault(); move(1); return; }
  if (e.key === "ArrowUp") { e.preventDefault(); move(-1); return; }
  if (e.key === "Enter") { e.preventDefault(); void paste(items[selected]); return; }
  if (e.key === "Backspace" && e.metaKey) {
    e.preventDefault();
    const cur = items[selected];
    if (cur) void invoke("history_delete", { id: cur.id });
    return;
  }
  if (e.key === "p" && e.metaKey) {
    e.preventDefault();
    const cur = items[selected];
    if (cur) void invoke("history_pin", { id: cur.id, pinned: !cur.pinned });
  }
});

search.addEventListener("input", () => {
  selected = 0;
  if (pickOrder || !pickSpinner.hidden) cancelPick();
  void refresh();
});

async function checkAccessibility(): Promise<void> {
  const trusted = await invoke<boolean>("accessibility_status").catch(() => true);
  axBanner.hidden = trusted;
}

async function checkStatus(): Promise<void> {
  status = await invoke<HistoryStatus>("history_status").catch(() => null);
  const isLocked = status?.state === "locked" || status?.state === "opening";
  locked.hidden = !isLocked;
  $("locked-fresh").hidden = status?.state !== "locked";
  if (status?.state === "locked") lockedText.textContent = status.detail;
  if (status?.state === "opening") lockedText.textContent = "Unlocking the history… (the Keychain may be asking you to allow Peesuto)";
}

async function loadActions(): Promise<void> {
  try {
    const info = await invoke<ActionsInfo>("actions_list");
    itemActions = info.actions.filter((a) => a.needs !== "decider" && (a.output === "text" || a.output === "image" || a.output === "gif"));
  } catch {
    itemActions = [];
  }
}

void listen("history:changed", () => void refresh());
void listen<Session>("history:open", (e) => onOpen(e.payload));

const win = getCurrentWindow();
void win.onFocusChanged(({ payload: focused }) => {
  if (focused) {
    selected = 0;
    void checkStatus().then(refresh);
    void checkAccessibility();
    void loadActions();
    search.focus();
    search.select();
  } else {
    closeMenus();
    clearConfirm.hidden = true;
    freshConfirm.hidden = true;
    note.hidden = true;
    search.value = "";
    cancelPick();
  }
});

void checkStatus().then(refresh);
void checkAccessibility();
void loadActions();
search.focus();
