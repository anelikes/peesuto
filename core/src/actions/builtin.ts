import type { ActionSpec } from "./types.ts";

/** The shipped actions. Users may duplicate and edit; ids are reserved. */
export const BUILTIN_ACTIONS: readonly ActionSpec[] = [
  {
    id: "paste-smart", name: "Smart paste", builtin: true,
    description: "Pick the history item that fits where you are pasting; you confirm with Enter.",
    trigger: { hotkey: "CmdOrCtrl+Shift+V", menu: true },
    input: "clipboard", needs: "decider", output: "text",
  },
  {
    id: "paste-card", name: "Paste as card", builtin: true,
    description: "Render the text as a still card (PNG) through Pocket Motion.",
    trigger: { menu: true },
    input: "clipboard", needs: "render", output: "image", render: { aspect: "chat", animate: "never" },
  },
  {
    id: "paste-gif", name: "Paste as GIF", builtin: true,
    description: "Render the text as a short animated card (GIF).",
    trigger: { menu: true },
    input: "clipboard", needs: "render", output: "gif", render: { aspect: "chat", animate: "always" },
  },
  {
    id: "paste-video", name: "Paste as video", builtin: true,
    description: "Render the text as a short animated video (MP4). Requires ffmpeg.",
    trigger: { menu: true },
    input: "clipboard", needs: "render", output: "video", render: { aspect: "chat", animate: "always" },
  },
  {
    id: "paste-translate", name: "Paste translation", builtin: true,
    description: "Translate the text to English (edit the prompt for another language).",
    trigger: { menu: true },
    input: "clipboard", needs: "generator", output: "text", maxTokens: 1024,
    system: "You are a precise translator. Output only the translation, no preamble, no quotes.",
    prompt: "Translate the following text into English. Keep formatting, line breaks and code untouched.\n\n{{input}}",
  },
  {
    id: "paste-summary", name: "Paste summary", builtin: true,
    description: "Summarise the text in its own language, three sentences at most.",
    trigger: { menu: true },
    input: "clipboard", needs: "generator", output: "text", maxTokens: 512,
    system: "You summarise text faithfully. Output only the summary, in the same language as the input.",
    prompt: "Summarise the following in at most three sentences.\n\n{{input}}",
  },
];
