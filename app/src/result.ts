/** The result window: the card from "Paste as card", with aspect, retry, paste, copy, save, reveal. */
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { $, ASPECTS, humanError, isPasteFailure, type Aspect, type ResultState } from "./shared";

const status = $("status");
const card = $<HTMLImageElement>("card");
const spinner = $("spinner");
const errorBox = $("error");
const errorTitle = $("error-title");
const errorDetail = $("error-detail");
const errorSettings = $<HTMLButtonElement>("error-settings");
const aspectGroup = $("aspect");
const another = $<HTMLButtonElement>("another");
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
  const ready = st?.state === "ready";
  spinner.hidden = !working;
  card.hidden = !ready;
  errorBox.hidden = st?.state !== "error";
  for (const b of aspectGroup.querySelectorAll("button")) b.disabled = working || !st || !st.text;
  another.disabled = working || !st || !st.text;
  pasteBtn.disabled = !ready;
  copyBtn.disabled = !ready;
  saveBtn.disabled = !ready;
  revealBtn.disabled = !ready;
  timing.textContent = "";
  if (!st) { say("", true); return; }
  setAspect(st.aspect);

  if (st.state === "working") {
    say("Rendering…", true);
  } else if (st.state === "ready") {
    const r = st.result;
    card.src = convertFileSrc(r.path);
    say({ image: "Copied as image", file: "GIF copied as file", path: "Path copied", none: "Not copied" }[st.copied], true);
    const ms = r.ms;
    const total = ms.total ?? 0;
    const parts = [
      `${(total / 1000).toFixed(1)} s`,
      ms.compose !== undefined ? `compose ${ms.compose}` : "",
      ms.build !== undefined ? `build ${ms.build}` : "",
      ms.frame !== undefined ? `${r.format} ${ms.frame}` : "",
    ].filter(Boolean);
    const provider = r.decided.provider ? ` · ${r.decided.provider}${r.decided.jevMs ? ` ${r.decided.jevMs} ms` : ""}` : "";
    timing.textContent = `${parts.join(" · ")} ms${provider} · ${r.size}px · ${r.frames} frame${r.frames === 1 ? "" : "s"}`;
  } else {
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
  if (!aspect || !ASPECTS.includes(aspect) || !current?.text) return;
  void invoke("card_rerun", { aspect });
});

another.addEventListener("click", () => {
  // TODO: `--fresh` (bypass the answer cache) once the CLI has it; today this returns the same take.
  if (current?.text) void invoke("card_rerun", { aspect: current.aspect });
});

pasteBtn.addEventListener("click", async () => {
  if (current?.state !== "ready") return;
  const { path, format } = current.result;
  try {
    await invoke("paste_card", { path, format });
  } catch (e) {
    say(isPasteFailure(e) && e.kind === "accessibility" ? "Copied — allow Accessibility to paste automatically" : String(isPasteFailure(e) ? e.message : e), true);
  }
});

copyBtn.addEventListener("click", async () => {
  if (current?.state !== "ready") return;
  const { path, format } = current.result;
  try {
    const how = await invoke<string>("copy_card", { path, format });
    say(how === "image" ? "Copied" : how === "file" ? "Copied as file" : "Path copied");
  } catch (e) {
    say(`Copy failed: ${e}`, true);
  }
});

saveBtn.addEventListener("click", async () => {
  if (current?.state !== "ready") return;
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
  if (current?.state === "ready") void revealItemInDir(current.result.path);
});

errorSettings.addEventListener("click", () => void invoke("open_settings"));
$("close").addEventListener("click", hide);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); hide(); }
});

void listen<ResultState>("result:state", (e) => apply(e.payload));
void invoke<ResultState | null>("result_state").then(apply);
