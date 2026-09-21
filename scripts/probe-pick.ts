#!/usr/bin/env bun
/**
 * Hit rate of the smart pick over thirty synthetic scenarios: a context at
 * some level, five to eight candidates, and the one the user meant. Each
 * scenario is picked by the heuristic alone and, when the dev proxy at
 * PASTE_PROXY_URL (default http://localhost:8787/) answers, by the decider
 * too. The scenarios are written to .work/pick-scenarios.json (gitignored)
 * and one table line per scenario is printed; the summary goes into
 * baselines/pick.md by hand.
 *
 *   bun scripts/probe-pick.ts
 *
 * The scenarios are made up, not recorded; they say what the heuristic gets
 * right by construction and where a decider would have to earn its keep.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { pick } from "../core/src/pick/index.ts";
import type { ClipItem, Context, PickDecider } from "../core/src/pick/types.ts";

const NOW = Date.parse("2026-09-22T10:00:00Z");
const PROXY_URL = process.env.PASTE_PROXY_URL ?? "http://localhost:8787/";
const OUT = ".work/pick-scenarios.json";

interface Scenario { readonly name: string; readonly ctx: Context; readonly candidates: ClipItem[]; readonly answer: number }

const A = {
  chrome: "com.google.Chrome", safari: "com.apple.Safari", slack: "com.tinyspeck.slackmacgap", terminal: "com.apple.Terminal",
  iterm: "com.googlecode.iterm2", notes: "com.apple.Notes", mail: "com.apple.mail", finder: "com.apple.finder",
  numbers: "com.apple.iWork.Numbers", keynote: "com.apple.iWork.Keynote", excel: "com.microsoft.Excel", vscode: "com.microsoft.VSCode",
  xcode: "com.apple.dt.Xcode", contacts: "com.apple.Contacts", messages: "com.apple.MobileSMS", maps: "com.apple.Maps",
  figma: "com.figma.Desktop", notion: "notion.id", zoom: "us.zoom.xos", discord: "com.hnc.Discord", photoshop: "com.adobe.Photoshop",
  spotlight: "com.apple.Spotlight", obsidian: "md.obsidian", reminders: "com.apple.reminders", calendar: "com.apple.iCal", pages: "com.apple.iWork.Pages",
  preview: "com.apple.Preview",
} as const;

let seq = 0;
const text = (s: string, from: string, ageS: number, o: Partial<ClipItem> = {}): ClipItem =>
  ({ id: `i${seq++}`, kind: "text", text: s, preview: s.split("\n")[0]!.slice(0, 60), appBundleId: from, createdAt: NOW - ageS * 1000, ...o });
const image = (caption: string, from: string, ageS: number, bytes: number): ClipItem =>
  ({ id: `i${seq++}`, kind: "image", preview: caption, appBundleId: from, createdAt: NOW - ageS * 1000, bytes });
const file = (path: string, from: string, ageS: number, bytes: number): ClipItem =>
  ({ id: `i${seq++}`, kind: "file", preview: path, appBundleId: from, createdAt: NOW - ageS * 1000, bytes });

const ctx = (level: 0 | 1 | 2, app: keyof typeof A, appName: string, o: Partial<Context> = {}): Context => ({ level, appBundleId: A[app], appName, ...o });

/** Candidates newest first, as the shell hands them; `answer` is the index of `right` after sorting. */
function scenario(name: string, c: Context, items: ClipItem[], right: ClipItem): Scenario {
  const candidates = [...items].sort((a, b) => b.createdAt - a.createdAt);
  return { name, ctx: c, candidates, answer: candidates.indexOf(right) };
}

const URL_PR = "https://github.com/qianiaoo/pocket-paste/pull/42";
const URL_DOC = "https://developers.cloudflare.com/workers-ai/models/";
const URL_MEET = "https://zoom.us/j/93412345678?pwd=Zm9v";
const URL_API = "https://api.example.com/v1/ask";
const STACK = "TypeError: Cannot read properties of undefined (reading 'choice')\n    at answersToDsl (core/src/questions.ts:71:29)\n    at run (core/src/cli.ts:58:21)\n    at async main (core/src/cli.ts:112:3)";
const CMD = "brew install ffmpeg";
const CMD_GIT = "git log --oneline -20";
const PROSE_LONG = "The pick request is built per context level: at L0 the decider only sees the app and the candidate summaries, at L1 the focused control's role and label are added, and at L2 the text around the caret. Nothing about a secure field is ever collected.";
const PROSE_SHORT = "Can we move the sync to 3pm? I have a dentist appointment at 2.";
const PROSE_LUNCH = "lunch at 12:30? the ramen place";
const EMAIL = "ana.ruiz@example.com";
const PHONE = "+1 415 555 0134";
const NUMBER = "1,284.50";
const NUMBER2 = "12,940";
const MONEY = "$4.2M";
const ADDRESS = "221B Baker Street, London NW1 6XE";
const HEX = "#1E6BFF";
const FORMULA = "=SUM(B2:B11)";
const HOST = "deploy@10.0.4.12";
const JSON_BODY = "{\"state\":{\"clipboard\":\"hi\"},\"questions\":{\"kind\":{\"type\":\"choice\"}}}";
const CODE_TS = "const provider = createProvider(providerFromEnv());\nconst answers = await provider.ask(body);";
const SWIFT = "let session = URLSession(configuration: .ephemeral)";
const COMMIT = "fix(pick): penalise long text in a single-line field";
const HEADLINE = "Ship faster with fewer meetings";
const QUIP = "Every clipboard is a to-do list you didn't ask for.";
const REMINDER = "Call dentist re: crown";
const NOTE_SHORT = "See you at 7 at Nopa";
const SEARCH = "Activity Monitor";
const FILENAME = "report-q3-final";
const SHOT = (from: keyof typeof A, ageS: number) => image("Screenshot 1440x900", A[from], ageS, 1_240_000);
const MEME = (ageS: number) => image("meme.png 800x600", A.chrome, ageS, 320_000);
const PDF = (ageS: number) => file("/Users/nya/Downloads/report.pdf", A.finder, ageS, 2_300_000);
const INVOICE = (ageS: number) => file("/Users/nya/Documents/invoice-0922.pdf", A.finder, ageS, 230_000);
const DECK = (ageS: number) => file("/Users/nya/Desktop/deck.key", A.finder, ageS, 48_000_000);

function scenarios(): Scenario[] {
  const out: Scenario[] = [];
  const add = (name: string, c: Context, items: ClipItem[], right: number) => out.push(scenario(name, c, items, items[right]!));

  add("Slack: PR link into the message box", ctx(2, "slack", "Slack", { role: "AXTextArea", label: "Message #eng-frontend", before: "here's the PR: ", after: "" }),
    [text(URL_PR, A.chrome, 30), text(STACK, A.terminal, 300), text(PROSE_LUNCH, A.slack, 720), SHOT("chrome", 120), text(CMD, A.chrome, 480)], 0);
  add("Terminal: install command among prose", ctx(2, "terminal", "Terminal", { role: "AXTextArea", label: "", before: "nya@mbp ~ % ", after: "" }),
    [text(PROSE_LONG, A.notes, 20), text(CMD, A.chrome, 180), text(URL_DOC, A.chrome, 360), text(STACK, A.terminal, 600), text(EMAIL, A.contacts, 1800)], 1);
  add("Numbers: a figure into a cell", ctx(1, "numbers", "Numbers", { role: "AXCell", label: "B7" }),
    [text(NUMBER, A.chrome, 45), text(PROSE_SHORT, A.slack, 120), text(URL_DOC, A.chrome, 240), SHOT("chrome", 420), PDF(900)], 0);
  add("Mail: address into the To field", ctx(2, "mail", "Mail", { role: "AXTextField", label: "To:", before: "", after: "" }),
    [text(PROSE_LONG, A.pages, 10), text(EMAIL, A.contacts, 90), text(URL_PR, A.slack, 300), SHOT("safari", 480), text(PHONE, A.contacts, 1200)], 1);
  add("VS Code: snippet from the docs", ctx(2, "vscode", "Code", { role: "AXTextArea", label: "cli.ts - pocket-paste", before: "  // wire the provider\n  ", after: "\n" }),
    [text(CODE_TS, A.chrome, 40), text(STACK, A.terminal, 180), text(URL_DOC, A.chrome, 360), text(PROSE_SHORT, A.slack, 540), SHOT("chrome", 720)], 0);
  add("GitHub issue comment: the stack trace", ctx(1, "chrome", "Google Chrome", { role: "AXTextArea", label: "Comment" }),
    [text(STACK, A.terminal, 25), SHOT("terminal", 60), text(CMD_GIT, A.terminal, 120), text(URL_PR, A.chrome, 180), text(PROSE_SHORT, A.slack, 300)], 0);
  add("Finder: renaming a file", ctx(2, "finder", "Finder", { role: "AXTextField", label: "", before: "Screenshot 2026-09-22", after: ".png" }),
    [text(FILENAME, A.notes, 15), text(URL_DOC, A.chrome, 120), text(PROSE_SHORT, A.slack, 240), PDF(360), SHOT("safari", 480)], 0);
  add("Safari: a URL into the address bar", ctx(1, "safari", "Safari", { role: "AXTextField", label: "Address and Search" }),
    [text(PROSE_SHORT, A.mail, 20), text(URL_DOC, A.slack, 50), text(CMD, A.chrome, 180), SHOT("chrome", 300), text(NUMBER, A.numbers, 420)], 1);
  add("Chrome with no accessibility: newest wins", ctx(0, "chrome", "Google Chrome"),
    [text(URL_PR, A.slack, 60), text(PROSE_SHORT, A.notes, 180), SHOT("safari", 300), text(CMD, A.terminal, 420), PDF(600), text(EMAIL, A.contacts, 900)], 0);
  add("Messages: a short reply", ctx(2, "messages", "Messages", { role: "AXTextArea", label: "iMessage", before: "", after: "" }),
    [text(NOTE_SHORT, A.notes, 30), SHOT("safari", 120), text(URL_DOC, A.chrome, 240), text(PHONE, A.contacts, 480), text(PROSE_LONG, A.pages, 720)], 0);
  add("Terminal: host after ssh", ctx(2, "terminal", "Terminal", { role: "AXTextArea", label: "", before: "nya@mbp ~ % ssh ", after: "" }),
    [text(PROSE_SHORT, A.slack, 10), text(HOST, A.notes, 120, { pinned: true }), text(URL_DOC, A.chrome, 240), text(CMD, A.chrome, 360), SHOT("chrome", 540)], 1);
  add("Xcode: URL inside a string literal", ctx(2, "xcode", "Xcode", { role: "AXTextArea", label: "Client.swift", before: "let url = URL(string: \"", after: "\")!" }),
    [text(SWIFT, A.chrome, 15), text(URL_API, A.safari, 120), text(STACK, A.xcode, 300), text(PROSE_SHORT, A.slack, 480), SHOT("xcode", 600)], 1);
  add("Excel: a formula into a cell", ctx(1, "excel", "Microsoft Excel", { role: "AXCell", label: "D12" }),
    [text(FORMULA, A.chrome, 20), text(NUMBER, A.chrome, 60), text(PROSE_SHORT, A.mail, 180), SHOT("chrome", 300), PDF(420)], 0);
  add("Notes: an address after a label", ctx(2, "notes", "Notes", { role: "AXTextArea", label: "Trip", before: "Hotel\nAddress: ", after: "\n" }),
    [SHOT("maps", 30), text(ADDRESS, A.maps, 120), text(URL_DOC, A.chrome, 240), text(PROSE_SHORT, A.slack, 360), PDF(540)], 1);
  add("Figma: a headline into a text layer", ctx(1, "figma", "Figma", { role: "AXTextArea", label: "" }),
    [text(HEADLINE, A.notion, 40), MEME(120), text(URL_PR, A.chrome, 180), text(PROSE_LONG, A.notion, 300), text(HEX, A.chrome, 480)], 0);
  add("Figma: a colour into the fill field", ctx(2, "figma", "Figma", { role: "AXTextField", label: "Fill", before: "", after: "" }),
    [text(PROSE_SHORT, A.slack, 20), text(HEX, A.chrome, 240), text(URL_DOC, A.chrome, 360), SHOT("chrome", 480), text(NUMBER, A.numbers, 600)], 1);
  add("Zoom chat: the meeting link", ctx(1, "zoom", "zoom.us", { role: "AXTextArea", label: "Type message here" }),
    [text(URL_MEET, A.calendar, 25), SHOT("chrome", 60), text(PROSE_SHORT, A.slack, 180), text(CMD, A.terminal, 300), DECK(420)], 0);
  add("Finder: a file onto the Desktop", ctx(1, "finder", "Finder", { role: "AXList", label: "Desktop" }),
    [PDF(30), text(FILENAME, A.notes, 60), SHOT("safari", 120), text(URL_DOC, A.chrome, 240), text(PROSE_SHORT, A.slack, 360)], 0);
  add("Discord: a link into the message box", ctx(1, "discord", "Discord", { role: "AXTextArea", label: "Message #general" }),
    [text(URL_DOC, A.chrome, 30), MEME(60), text(PROSE_SHORT, A.slack, 240), text(CMD, A.terminal, 360), text(STACK, A.terminal, 480), PDF(600)], 0);
  add("Photoshop with no accessibility: the image", ctx(0, "photoshop", "Adobe Photoshop"),
    [text(HEADLINE, A.notion, 30), SHOT("safari", 120), text(URL_DOC, A.chrome, 240), DECK(360), text(PROSE_SHORT, A.slack, 480)], 1);
  add("Keynote: a figure after a label", ctx(2, "keynote", "Keynote", { role: "AXTextArea", label: "", before: "Q3 revenue: ", after: "" }),
    [text(URL_PR, A.slack, 20), text(MONEY, A.numbers, 180), text(PROSE_SHORT, A.mail, 300), SHOT("numbers", 420), DECK(600)], 1);
  add("Spotlight: an app name", ctx(1, "spotlight", "Spotlight", { role: "AXTextField", label: "Spotlight Search" }),
    [text(SEARCH, A.notes, 10), text(URL_DOC, A.chrome, 120), text(PROSE_SHORT, A.slack, 240), SHOT("chrome", 360), PDF(480)], 0);
  add("Obsidian: a paragraph into meeting notes", ctx(2, "obsidian", "Obsidian", { role: "AXTextArea", label: "2026-09-22.md", before: "## Meeting notes\n- ", after: "" }),
    [text(PROSE_LONG, A.slack, 15), text(URL_PR, A.chrome, 120), SHOT("chrome", 240), text(CODE_TS, A.vscode, 360), PDF(540)], 0);
  add("Gmail compose: a screenshot into the body", ctx(1, "chrome", "Google Chrome", { role: "AXTextArea", label: "Message Body" }),
    [SHOT("preview", 20), text(PROSE_SHORT, A.notes, 120), text(URL_DOC, A.chrome, 300), INVOICE(420), text(PHONE, A.contacts, 540)], 0);
  add("Terminal: the commit message", ctx(2, "terminal", "Terminal", { role: "AXTextArea", label: "", before: "nya@mbp pocket-paste % git commit -m \"", after: "" }),
    [text(STACK, A.terminal, 20), text(COMMIT, A.notes, 60), text(URL_PR, A.chrome, 180), text(CMD_GIT, A.chrome, 300), SHOT("chrome", 420)], 1);
  add("Twitter compose with no accessibility", ctx(0, "chrome", "Google Chrome"),
    [text(QUIP, A.notes, 40), MEME(180), text(URL_DOC, A.chrome, 360), text(PROSE_LONG, A.notion, 480), PDF(600)], 0);
  add("Numbers: a figure while a paragraph is newer", ctx(2, "numbers", "Numbers", { role: "AXTextField", label: "", before: "", after: "" }),
    [text(PROSE_LONG, A.pages, 25), text(NUMBER2, A.chrome, 60), text(URL_DOC, A.chrome, 180), SHOT("chrome", 300), PDF(420)], 1);
  add("Mail: the attachment after 'attached'", ctx(2, "mail", "Mail", { role: "AXTextArea", label: "", before: "Please find the invoice attached.\n\n", after: "" }),
    [INVOICE(30), text(PROSE_SHORT, A.slack, 120), text(URL_DOC, A.chrome, 240), SHOT("chrome", 360), text(PHONE, A.contacts, 480)], 0);
  add("iTerm2: the endpoint after curl", ctx(2, "iterm", "iTerm2", { role: "AXTextArea", label: "", before: "$ curl -X POST ", after: "" }),
    [text(PROSE_SHORT, A.slack, 10), text(URL_API, A.chrome, 120), text(JSON_BODY, A.vscode, 240), SHOT("chrome", 360), PDF(480)], 1);
  add("Reminders: a short title while a paragraph is newer", ctx(1, "reminders", "Reminders", { role: "AXTextField", label: "New Reminder" }),
    [text(PROSE_LONG, A.mail, 15), text(REMINDER, A.messages, 180), text(URL_DOC, A.chrome, 300), SHOT("chrome", 420), PDF(540)], 1);
  return out;
}

/** Any HTTP response at all means something is listening. */
async function proxyUp(url: string): Promise<boolean> {
  try { await fetch(url, { method: "GET", signal: AbortSignal.timeout(1500) }); return true; } catch { return false; }
}

let deciderErrors = 0;
let firstError = "";
const proxy: PickDecider = {
  name: "proxy",
  async ask(body) {
    try {
      const res = await fetch(PROXY_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
      const json = (await res.json().catch(() => null)) as { result?: { answers?: unknown }; answers?: unknown } | null;
      if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(json ?? "").slice(0, 160)}`);
      const answers = json?.result?.answers ?? json?.answers ?? null;
      if (!answers) throw new Error(`no answers in ${JSON.stringify(json ?? "").slice(0, 160)}`);
      return answers;
    } catch (e) {
      deciderErrors++;
      if (!firstError) firstError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  },
};

const all = scenarios();
await mkdir(".work", { recursive: true });
await writeFile(OUT, JSON.stringify({ now: NOW, scenarios: all }, null, 2));

const up = await proxyUp(PROXY_URL);
if (!up) console.log(`warning: no dev proxy at ${PROXY_URL}; heuristic only (cd proxy && npx wrangler dev --port 8787)`);

const hit = (ids: string[], want: string, n: number): boolean => ids.slice(0, n).includes(want);
const mark = (b: boolean | null): string => (b === null ? "  -  " : b ? " hit " : " miss");
const pad = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

let h1 = 0, h3 = 0, d1 = 0, d3 = 0, decided = 0;
console.log(`${"#".padStart(2)}  ${pad("scenario", 50)} L  heur@1 heur@3 dec@1 dec@3     ms`);
for (const [n, s] of all.entries()) {
  const want = s.candidates[s.answer]!.id;
  const t0 = performance.now();
  const h = await pick(s.ctx, s.candidates, null, { now: NOW });
  let ms = performance.now() - t0;
  const hIds = h.ranked.map((r) => r.item.id);
  const hh1 = hit(hIds, want, 1), hh3 = hit(hIds, want, 3);
  h1 += hh1 ? 1 : 0; h3 += hh3 ? 1 : 0;
  let dd1: boolean | null = null, dd3: boolean | null = null;
  if (up) {
    const t1 = performance.now();
    const d = await pick(s.ctx, s.candidates, proxy, { now: NOW });
    ms = performance.now() - t1;
    if (d.source === "decider") {
      decided++;
      const dIds = d.ranked.map((r) => r.item.id);
      dd1 = hit(dIds, want, 1); dd3 = hit(dIds, want, 3);
      d1 += dd1 ? 1 : 0; d3 += dd3 ? 1 : 0;
    }
  }
  console.log(`${String(n + 1).padStart(2)}  ${pad(s.name, 50)} ${s.ctx.level}  ${mark(hh1)}  ${mark(hh3)}  ${mark(dd1)} ${mark(dd3)} ${ms.toFixed(1).padStart(6)}`);
}
const pct = (k: number, n: number): string => `${k}/${n} (${Math.round((100 * k) / n)}%)`;
console.log(`\nheuristic: top-1 ${pct(h1, all.length)}, top-3 ${pct(h3, all.length)}`);
if (up && decided > 0) console.log(`decider:   top-1 ${pct(d1, decided)}, top-3 ${pct(d3, decided)} over ${decided} answered`);
if (up && deciderErrors > 0) console.log(`warning: the proxy failed ${deciderErrors}/${all.length} pick requests (first: ${firstError}); those rows fell back to the heuristic`);
console.log(`scenarios written to ${OUT}`);
