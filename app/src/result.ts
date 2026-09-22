/** The result window: what an action produced — text (paste, copy, the model) or a card (aspect, another take, paste, copy, save, reveal). */
import { t, actionName } from "./i18n";
import { initLocale, onLocaleChange } from "./locale";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { $, ASPECTS, humanError, isPasteFailure, type Aspect, type ResultState } from "./shared";

const title = $("title");
const status = $("status");
const card = $<HTMLImageElement>("card");
const textOut = $("text-out");
const spinner = $("spinner");
const errorBox = $("error");
const errorTitle = $("error-title");
const errorDetail = $("error-detail");
const errorSettings = $<HTMLButtonElement>("error-settings");
const cardRow = $("card-row");
const textRow = $("text-row");
const model = $("model");
const aspectGroup = $("aspect");
const another = $<HTMLButtonElement>("another");
const again = $<HTMLButtonElement>("again");
const pasteBtn = $<HTMLButtonElement>("paste");
const copyBtn = $<HTMLButtonElement>("copy");
const saveBtn = $<HTMLButtonElement>("save");
const revealBtn = $<HTMLButtonElement>("reveal");
const timing = $("timing");

let current: ResultState | null = null;
let statusTimer: number | undefined;

function say(text: string, sticky = false): void {
  status.textContent = text;
  window.clearTimeout(statusTimer);
  if (!sticky) statusTimer = window.setTimeout(() => { if (status.textContent === text) status.textContent = ""; }, 1800);
}

function setAspect(aspect: Aspect): void {
  for (const b of aspectGroup.querySelectorAll<HTMLButtonElement>("button")) {
    b.setAttribute("aria-checked", String(b.dataset.aspect === aspect));
  }
}

function apply(st: ResultState | null): void {
  current = st;
  const working = st?.state === "working";
  const isCard = st?.state === "card";
  const isText = st?.state === "text";
  const rendersCard = !!st && (st.action.output === "image" || st.action.output === "gif");
  spinner.hidden = !working;
  card.hidden = !isCard;
  textOut.hidden = !isText;
  errorBox.hidden = st?.state !== "error";
  cardRow.hidden = !rendersCard;
  textRow.hidden = rendersCard || !st;
  for (const b of aspectGroup.querySelectorAll("button")) b.disabled = working || !st || !st.input;
  another.disabled = working || !st || !st.input;
  again.disabled = working || !st || !st.input;
  pasteBtn.disabled = !(isCard || isText);
  copyBtn.disabled = !(isCard || isText);
  saveBtn.disabled = !isCard;
  revealBtn.disabled = !isCard;
  saveBtn.hidden = !rendersCard;
  revealBtn.hidden = !rendersCard;
  timing.textContent = "";
  model.textContent = "";
  title.textContent = st ? actionName(st.action) : t("Result");
  if (!st) { say("", true); return; }

  if (st.state === "working") {
    setAspect(st.aspect);
    say(rendersCard ? t("Rendering…") : t("Working…"), true);
  } else if (st.state === "card") {
    setAspect(st.aspect);
    const r = st.result;
    card.src = convertFileSrc(r.path);
    say({ image: t("Copied as image"), file: t("GIF copied as file"), path: t("Path copied"), none: t("Not copied") }[st.copied], true);
    const ms = r.ms;
    const total = ms.total ?? 0;
    const parts = [
      `${(total / 1000).toFixed(1)} s`,
      ms.compose !== undefined && ms.compose !== null ? t("compose {0}", [ms.compose]) : "",
      ms.build !== undefined && ms.build !== null ? t("build {0}", [ms.build]) : "",
      ms.frame !== undefined && ms.frame !== null ? `${r.format} ${ms.frame}` : "",
    ].filter(Boolean);
    const provider = r.decided?.provider ? ` · ${r.decided.provider}${r.decided.jevMs ? ` ${r.decided.jevMs} ms` : ""}` : "";
    timing.textContent = t("{0} ms{1} · {2}px · {3} frames", [parts.join(" · "), provider, r.size, r.frames]);
  } else if (st.state === "text") {
    textOut.textContent = st.text;
    model.textContent = [st.model ?? "", `${(st.ms / 1000).toFixed(1)} s`].filter(Boolean).join(" · ");
    say(t("Ready"), true);
  } else {
    if (rendersCard) setAspect(st.aspect);
    const h = humanError(st.kind, st.message);
    errorTitle.textContent = h.title;
    errorDetail.textContent = h.detail;
    errorSettings.hidden = !h.settings;
    say("", true);
  }
}

function hide(): void {
  void invoke("hide_result");
}

aspectGroup.addEventListener("click", (e) => {
  const aspect = (e.target as HTMLElement).closest<HTMLButtonElement>("button")?.dataset.aspect as Aspect | undefined;
  if (!aspect || !ASPECTS.includes(aspect) || !current?.input) return;
  void invoke("action_rerun", { aspect });
});

// Another take bypasses the answer cache: `fresh: true` on the action input.
another.addEventListener("click", () => {
  if (current?.input) void invoke("action_rerun", { fresh: true });
});
again.addEventListener("click", () => {
  if (current?.input) void invoke("action_rerun", { fresh: true });
});

pasteBtn.addEventListener("click", async () => {
  if (!current) return;
  try {
    if (current.state === "card") {
      const { path, format } = current.result;
      await invoke("paste_card", { path, format });
    } else if (current.state === "text") {
      await invoke("paste_text", { text: current.text });
    }
  } catch (e) {
    say(isPasteFailure(e) && e.kind === "accessibility" ? t("Copied — allow Accessibility to paste automatically") : String(isPasteFailure(e) ? t(e.message) : e), true);
  }
});

copyBtn.addEventListener("click", async () => {
  if (!current) return;
  try {
    if (current.state === "card") {
      const { path, format } = current.result;
      const how = await invoke<string>("copy_card", { path, format });
      say(how === "image" ? t("Copied") : how === "file" ? t("Copied as file") : t("Path copied"));
    } else if (current.state === "text") {
      await writeText(current.text);
      say(t("Copied"));
    }
  } catch (e) {
    say(t("Copy failed: {0}", [e]), true);
  }
});

saveBtn.addEventListener("click", async () => {
  if (current?.state !== "card") return;
  const { path, format } = current.result;
  const name = path.split("/").pop() ?? `card.${format}`;
  await invoke("result_hold", { hold: true });
  try {
    const dest = await save({
      title: t("Save card"),
      defaultPath: `pocket-paste-${name}`,
      filters: [{ name: format === "gif" ? "GIF" : t("PNG image"), extensions: [format] }],
    });
    if (dest) {
      await invoke("save_card", { path, dest });
      say(t("Saved"));
    }
  } catch (e) {
    say(t("Save failed: {0}", [e]), true);
  } finally {
    await invoke("result_hold", { hold: false });
  }
});

revealBtn.addEventListener("click", () => {
  if (current?.state === "card") void revealItemInDir(current.result.path);
});

errorSettings.addEventListener("click", () => void invoke("open_settings"));
$("close").addEventListener("click", hide);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); hide(); }
});

void listen<ResultState>("result:state", (e) => apply(e.payload));
onLocaleChange(() => apply(current));
void initLocale().then(() => invoke<ResultState | null>("result_state")).then(apply);
