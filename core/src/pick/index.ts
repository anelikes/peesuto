/**
 * pick(): the one call the daemon makes when the paste hotkey fires. It
 * filters what may not be offered, asks the decider when there is one, and
 * blends its answer with the heuristic. A decider that errors, times out or
 * declines simply leaves the heuristic ranking in place — a paste must never
 * fail because a model did.
 */
import type { JevRequest } from "../questions.ts";
import { modelContentOf } from "../privacy/decider.ts";
import { heuristicRank } from "./heuristic.ts";
import { buildPickRequest, NONE, type BuildOptions } from "./question.ts";
import { PickError, type ClipItem, type Context, type PickAnswers, type PickDecider, type PickResult, type RankedItem } from "./types.ts";

/** Weight of the decider's probability against the heuristic when both exist. */
export const DECIDER_WEIGHT = 0.7;

export interface PickOptions extends BuildOptions {
  /** ms since the epoch; recency is measured from here (tests pin it). */
  readonly now?: number;
  readonly deciderWeight?: number;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/** The `pick` choice as per-criterion probabilities, or null when there is no usable answer. */
function pickProbabilities(answers: PickAnswers | null): Record<string, number> | null {
  const a = answers?.pick;
  if (!a || typeof a !== "object") return null;
  if (a.probabilities && typeof a.probabilities === "object") return a.probabilities;
  if (typeof a.choice === "string") return { [a.choice]: 1 };
  return null;
}

/**
 * Rank `candidates` (most recent first) for pasting into `ctx`. Excluded
 * items are dropped; a secure context throws PickError — the shell should
 * never have opened a pick there. With a decider, the ranking is
 * DECIDER_WEIGHT × its probability (scaled so its favourite is 1) plus the
 * rest × the heuristic (shifted and scaled to 0..1); `none` scales
 * shouldPaste down, and the `paste` noul supplies shouldPaste itself.
 */
export async function pick(ctx: Context, candidates: readonly ClipItem[], decider: PickDecider | null, opts: PickOptions = {}): Promise<PickResult> {
  if (ctx.secure) throw new PickError("secure field");
  const kept = candidates.filter((c) => !c.excluded);
  const now = opts.now ?? Date.now();
  const heuristic = heuristicRank(ctx, kept, now);
  // Behind a privacy-wrapped decider, redact before summaries cut the text:
  // a key truncated at 80 characters may no longer match its rule.
  const mc = modelContentOf(decider);
  const hide = mc && mc.mode !== "raw" ? mc.redact : null;
  const { body, ids } = hide
    ? buildPickRequest({ ...ctx, ...(ctx.label !== undefined ? { label: hide(ctx.label) } : {}), ...(ctx.before !== undefined ? { before: hide(ctx.before) } : {}), ...(ctx.after !== undefined ? { after: hide(ctx.after) } : {}) },
      kept.map((c) => ({ ...c, preview: hide(c.preview), ...(c.text !== undefined ? { text: hide(c.text) } : {}) })), opts)
    : buildPickRequest(ctx, kept, opts);
  const fallback: PickResult = { ranked: heuristic.ranked, shouldPaste: heuristic.shouldPaste, source: "heuristic", question: body };
  if (!decider || ids.length === 0) return fallback;

  let answers: PickAnswers | null;
  try {
    // Decider.ask is typed for the card questions; a pick body is the same envelope with another state.
    answers = (await decider.ask(body as unknown as JevRequest)) as PickAnswers | null;
  } catch {
    return fallback; // ProviderError or anything else: the heuristic stands
  }
  const probs = pickProbabilities(answers);
  if (!probs) return fallback;

  const asked = new Map(ids.map((id, i) => [id, i] as const));
  const p = (item: ClipItem): number | null => {
    const i = asked.get(item.id);
    return i === undefined ? null : clamp01(Number(probs[`c${i}`] ?? 0));
  };
  const none = clamp01(Number(probs[NONE] ?? 0));
  const dMax = Math.max(0, ...heuristic.ranked.map((r) => p(r.item) ?? 0));
  const hs = heuristic.ranked.map((r) => r.score);
  const lo = Math.min(0, ...hs);
  const span = Math.max(...hs) - lo;
  const w = clamp01(opts.deciderWeight ?? decider.pickWeight ?? DECIDER_WEIGHT);

  const ranked: RankedItem[] = heuristic.ranked
    .map((r) => {
      const d = p(r.item);
      const dNorm = d === null || dMax === 0 ? 0 : d / dMax;
      const hNorm = span > 0 ? (r.score - lo) / span : 1;
      return { item: r.item, score: w * dNorm + (1 - w) * hNorm, reason: `${d === null ? "not asked" : `decider ${d.toFixed(2)}`} · ${r.reason}` };
    })
    .sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt);

  const noul = answers?.paste?.noul;
  const base = typeof noul === "number" ? clamp01(noul) : heuristic.shouldPaste;
  return { ranked, shouldPaste: clamp01(base * (1 - none)), source: "decider", question: body };
}

export { heuristicRank, heuristicScore, recency, shouldPasteFor, slotOf, HALF_LIFE_MS } from "./heuristic.ts";
export { buildPickRequest, MAX_PICK_CANDIDATES, NONE, type BuildOptions } from "./question.ts";
export { summarizeContext, summarizeItem, SUMMARY_CHARS } from "./summarize.ts";
export * from "./types.ts";
