/**
 * One-line summaries: what a candidate looks like inside a pick question and
 * what a context looks like in a log line. Both are as short as they can be
 * while still telling a small model what it is looking at.
 */
import type { ClipItem, Context } from "./types.ts";

/** Default length of a candidate summary, in code points. */
export const SUMMARY_CHARS = 80;

/** Whitespace runs to one space, then any remaining control character gone. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\p{Cc}/gu, "").trim();
}

/** At most `maxChars` code points, the last one an ellipsis when cut. */
export function truncate(s: string, maxChars: number): string {
  const chars = [...s];
  if (chars.length <= maxChars) return s;
  return chars.slice(0, Math.max(0, maxChars - 1)).join("").trimEnd() + "…";
}

/** Decimal units, as Finder shows them. */
export function formatBytes(n: number): string {
  if (n < 1000) return `${Math.max(0, Math.round(n))} B`;
  if (n < 1e6) return `${Math.round(n / 1000)} kB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}

const fileName = (p: string): string => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
const bodyOf = (item: ClipItem): string => oneLine(item.text ?? item.preview) || "(empty)";

/**
 * A candidate on one line. Text is the text; images and files become a tag
 * (`[image 1.2 MB]`, `[file report.pdf]`); rich text keeps its text behind a
 * `[rtf]` / `[html]` tag. Secure and excluded items never get here: the
 * caller filters them before anything is summarised.
 */
export function summarizeItem(item: ClipItem, maxChars = SUMMARY_CHARS): string {
  switch (item.kind) {
    case "image": {
      const tag = item.bytes === undefined ? "[image]" : `[image ${formatBytes(item.bytes)}]`;
      const caption = oneLine(item.preview);
      return truncate(caption ? `${tag} ${caption}` : tag, maxChars);
    }
    case "file": return truncate(`[file ${oneLine(fileName(item.preview))}]`, maxChars);
    case "rtf": case "html": return truncate(`[${item.kind}] ${bodyOf(item)}`, maxChars);
    case "text": return truncate(bodyOf(item), maxChars);
  }
}

const tail = (s: string, n: number): string => { const c = [...s]; return c.length > n ? c.slice(-n).join("") : s; };
const head = (s: string, n: number): string => { const c = [...s]; return c.length > n ? c.slice(0, n).join("") : s; };

/**
 * A context on one line, growing with the level:
 *   L0  `Slack`
 *   L1  `Slack · AXTextArea “Message #general”`
 *   L2  `Slack · AXTextArea “Message #general” · …here is the |…`
 * `side` caps each side of the caret; the request itself keeps CONTEXT_CHARS.
 */
export function summarizeContext(ctx: Context, side = 40): string {
  const app = ctx.appName ?? ctx.appBundleId;
  if (ctx.level === 0) return app;
  const label = ctx.label ? oneLine(ctx.label) : "";
  const where = [ctx.role ?? "?", label ? `“${label}”` : ""].filter(Boolean).join(" ");
  const l1 = `${app} · ${where}`;
  if (ctx.level === 1) return l1;
  return `${l1} · …${tail(oneLine(ctx.before ?? ""), side)}|${head(oneLine(ctx.after ?? ""), side)}…`;
}
