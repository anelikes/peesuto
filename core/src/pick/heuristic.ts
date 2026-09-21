/**
 * The ranking a pick gets with no decider, and the prior the decider's
 * answer is blended with. Recency carries it; the rest are small nudges read
 * off the focused element's AX role and the item's kind.
 *
 * Assumptions, until paste history exists (the shell does not yet record
 * where an item was pasted):
 *   - Cross-app is the common paste: copy in a browser, paste in Slack. An
 *     item copied in the target app itself was more often an in-app move
 *     that is already done. So an item from another app gets +0.15; same-app
 *     affinity will replace this once "pasted into" is recorded.
 *   - AXWebArea is ambiguous (a contenteditable, or just the page): text is
 *     given the fit bonus, a file the penalty, and shouldPaste sits at 0.5.
 */
import type { ClipItem, Context, RankedItem } from "./types.ts";

/** Recency halves every ten minutes. */
export const HALF_LIFE_MS = 10 * 60_000;
/** Text longer than this does not belong in a single-line field. */
export const LONG_TEXT_CHARS = 200;
export const CROSS_APP_BONUS = 0.15;
export const TEXT_FIT_BONUS = 0.2;
export const PINNED_BONUS = 0.1;
export const LONG_TEXT_PENALTY = 0.3;

/** How the focused element takes a paste, read off its AX role. */
export type Slot = "line" | "block" | "web" | "cell" | "other";

export function slotOf(role: string | undefined): Slot {
  switch (role) {
    case "AXTextField": case "AXSearchField": case "AXComboBox": return "line";
    case "AXTextArea": return "block";
    case "AXWebArea": return "web";
    case "AXCell": return "cell";
    default: return "other";
  }
}

export const isTextInput = (role: string | undefined): boolean => {
  const s = slotOf(role);
  return s === "line" || s === "block" || s === "cell";
};

/** 2^(-age / half-life); 1 for anything not yet created. */
export function recency(ageMs: number, halfLifeMs = HALF_LIFE_MS): number {
  return Math.pow(2, -Math.max(0, ageMs) / halfLifeMs);
}

const isTextLike = (item: ClipItem): boolean => item.kind === "text" || item.kind === "rtf" || item.kind === "html";
const textLength = (item: ClipItem): number => [...(item.text ?? item.preview)].length;
const signed = (n: number): string => `${n < 0 ? "−" : "+"}${Math.abs(n).toFixed(2)}`;

/** How well `item.kind` fits the slot: [delta, why]. */
function kindFit(item: ClipItem, slot: Slot): [number, string] | null {
  if (isTextLike(item)) return slot === "other" ? null : [TEXT_FIT_BONUS, "text fits"];
  if (item.kind === "image") {
    if (slot === "line") return [-0.5, "image in a line field"];
    if (slot === "cell") return [-0.5, "image in a cell"];
    return null;
  }
  // file
  if (slot === "web") return [-0.2, "file in a web area"];
  if (slot === "line" || slot === "cell") return [-0.3, `file in a ${slot === "line" ? "line field" : "cell"}`];
  return null;
}

export function heuristicScore(ctx: Context, item: ClipItem, now: number): { score: number; reason: string } {
  const slot = slotOf(ctx.role);
  const parts: string[] = [];
  let score = recency(now - item.createdAt);
  parts.push(`recency ${score.toFixed(2)}`);
  const add = (delta: number, why: string) => { score += delta; parts.push(`${why} ${signed(delta)}`); };
  if (item.appBundleId && item.appBundleId !== ctx.appBundleId) add(CROSS_APP_BONUS, "cross-app");
  const fit = kindFit(item, slot);
  if (fit) add(fit[0], fit[1]);
  if (item.pinned) add(PINNED_BONUS, "pinned");
  if ((slot === "line" || slot === "cell") && isTextLike(item) && textLength(item) > LONG_TEXT_CHARS) add(-LONG_TEXT_PENALTY, "long text in a single-line field");
  return { score, reason: parts.join(" · ") };
}

/** 0.5 knowing only the app; 0.7 in a text input; 0.5 in a web area; 0.1 anywhere else. */
export function shouldPasteFor(ctx: Context): number {
  if (ctx.level === 0) return 0.5;
  if (isTextInput(ctx.role)) return 0.7;
  if (slotOf(ctx.role) === "web") return 0.5;
  return 0.1;
}

/** Best first; ties go to the newer item. */
export function heuristicRank(ctx: Context, candidates: readonly ClipItem[], now = Date.now()): { ranked: RankedItem[]; shouldPaste: number } {
  const ranked = candidates
    .map((item) => ({ item, ...heuristicScore(ctx, item, now) }))
    .sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt);
  return { ranked, shouldPaste: shouldPasteFor(ctx) };
}
