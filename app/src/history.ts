/** The history panel: search, arrow keys, ⏎ pastes, ⌘⌫ deletes. */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { $, ACCESSIBILITY_URL, isPasteFailure, relativeTime, type ClipItem } from "./shared";

const search = $<HTMLInputElement>("search");
const list = $<HTMLUListElement>("list");
const empty = $("empty");
const confirmBar = $("confirm");
const confirmText = $("confirm-text");
const axBanner = $("ax-banner");
const clearConfirm = $("clear-confirm");
const moreMenu = $("more-menu");
const context = $("context");

let items: ClipItem[] = [];
let selected = 0;
let contextItem: ClipItem | null = null;

async function refresh(): Promise<void> {
  items = await invoke<ClipItem[]>("history_list", { query: search.value });
  if (selected >= items.length) selected = Math.max(0, items.length - 1);
  render();
}

function render(): void {
  list.replaceChildren(...items.map(row));
  empty.hidden = items.length > 0;
  confirmBar.classList.toggle("muted", items.length === 0);
  const cur = items[selected];
  confirmText.textContent = cur ? cur.preview : "nothing yet";
  list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

function iconButton(title: string, glyph: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "icon";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.textContent = glyph;
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function row(it: ClipItem, i: number): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "item" + (i === selected ? " selected" : "") + (it.pinned ? " pinned" : "");
  li.setAttribute("role", "option");
  li.setAttribute("aria-selected", String(i === selected));

  const main = document.createElement("div");
  main.className = "item-main";
  const text = document.createElement("div");
  text.className = "item-text";
  text.textContent = it.preview || "(empty)";
  const meta = document.createElement("div");
  meta.className = "item-meta";
  const badges = it.types.filter((t) => t !== "file-url").map((t) => t.toUpperCase());
  if (it.kind === "file") badges.unshift("FILE");
  meta.textContent = [it.app_name ?? it.app_bundle_id ?? "", relativeTime(it.created_at), ...badges].filter(Boolean).join(" · ");
  main.append(text, meta);

  const tools = document.createElement("div");
  tools.className = "item-tools";
  tools.append(
    iconButton(it.pinned ? "Unpin" : "Pin", it.pinned ? "★" : "☆", () => void invoke("history_pin", { id: it.id, pinned: !it.pinned })),
    iconButton("Paste as card", "▣", () => void invoke("card_from_item", { id: it.id })),
    iconButton("Delete", "×", () => void invoke("history_delete", { id: it.id })),
  );

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
  context.hidden = false;
  const maxX = window.innerWidth - context.offsetWidth - 8;
  const maxY = window.innerHeight - context.offsetHeight - 8;
  context.style.left = `${Math.min(x, maxX)}px`;
  context.style.top = `${Math.min(y, maxY)}px`;
}

context.addEventListener("click", (e) => {
  const action = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-action]")?.dataset.action;
  const it = contextItem;
  closeMenus();
  if (!action || !it) return;
  if (action === "paste") void paste(it);
  if (action === "card") void invoke("card_from_item", { id: it.id });
  if (action === "pin") void invoke("history_pin", { id: it.id, pinned: !it.pinned });
  if (action === "delete") void invoke("history_delete", { id: it.id });
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
$("clear-yes").addEventListener("click", () => { clearConfirm.hidden = true; void invoke("history_clear"); });
$("clear-no").addEventListener("click", () => { clearConfirm.hidden = true; });
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

search.addEventListener("input", () => { selected = 0; void refresh(); });

async function checkAccessibility(): Promise<void> {
  const trusted = await invoke<boolean>("accessibility_status").catch(() => true);
  axBanner.hidden = trusted;
}

void listen("history:changed", () => void refresh());

const win = getCurrentWindow();
void win.onFocusChanged(({ payload: focused }) => {
  if (focused) {
    selected = 0;
    void refresh();
    void checkAccessibility();
    search.focus();
    search.select();
  } else {
    closeMenus();
    clearConfirm.hidden = true;
    search.value = "";
  }
});

void refresh();
void checkAccessibility();
search.focus();
