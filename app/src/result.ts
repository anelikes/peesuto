/** The result window: what an action produced — text (paste, copy, the model) or a card (aspect, another take, paste, copy, save, reveal). */
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
  title.textContent = st ? st.action.name : "Result";
  if (!st) { say("", true); return; }

  if (st.state === "working") {
    setAspect(st.aspect);
    say(rendersCard ? "Rendering…" : "Working…", true);
  } else if (st.state === "card") {
    setAspect(st.aspect);
    const r = st.result;
    card.src = convertFileSrc(r.path);
    say({ image: "Copied as image", file: "GIF copied as file", path: "Path copied", none: "Not copied" }[st.copied], true);
    const ms = r.ms;
    const total = ms.total ?? 0;
    const parts = [
      `${(total / 1000).toFixed(1)} s`,
      ms.compose !== undefined && ms.compose !== null ? `compose ${ms.compose}` : "",
      ms.build !== undefined && ms.build !== null ? `build ${ms.build}` : "",
      ms.frame !== undefined && ms.frame !== null ? `${r.format} ${ms.frame}` : "",
    ].filter(Boolean);
    const provider = r.decided?.provider ? ` · ${r.decided.provider}${r.decided.jevMs ? ` ${r.decided.jevMs} ms` : ""}` : "";
    timing.textContent = `${parts.join(" · ")} ms${provider} · ${r.size}px · ${r.frames} frame${r.frames === 1 ? "" : "s"}`;
  } else if (st.state === "text") {
    textOut.textContent = st.text;
    model.textContent = [st.model ?? "", `${(st.ms / 1000).toFixed(1)} s`].filter(Boolean).join(" · ");
    say("Ready", true);
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
    say(isPasteFailure(e) && e.kind === "accessibility" ? "Copied — allow Accessibility to paste automatically" : String(isPasteFailure(e) ? e.message : e), true);
  }
});

copyBtn.addEventListener("click", async () => {
  if (!current) return;
  try {
    if (current.state === "card") {
      const { path, format } = current.result;
      const how = await invoke<string>("copy_card", { path, format });
      say(how === "image" ? "Copied" : how === "file" ? "Copied as file" : "Path copied");
    } else if (current.state === "text") {
      await writeText(current.text);
      say("Copied");
    }
  } catch (e) {
    say(`Copy failed: ${e}`, true);
  }
});

saveBtn.addEventListener("click", async () => {
  if (current?.state !== "card") return;
  const { path, format } = current.result;
  const name = path.split("/").pop() ?? `card.${format}`;
  await invoke("result_hold", { hold: true });
  try {
    const dest = await save({
      title: "Save card",
      defaultPath: `pocket-paste-${name}`,
      filters: [{ name: format === "gif" ? "GIF" : "PNG image", extensions: [format] }],
    });
    if (dest) {
      await invoke("save_card", { path, dest });
      say("Saved");
    }
  } catch (e) {
    say(`Save failed: ${e}`, true);
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
void invoke<ResultState | null>("result_state").then(apply);
