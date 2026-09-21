/**
 * The two questions a pick asks Jev: a Choice over the candidates plus
 * "none", and a Noul on whether a paste belongs here at all. The state is
 * redacted by context level — at L0 the model sees only the app and the
 * candidates — and never holds more than CONTEXT_CHARS on either side of the
 * caret. Pure; the caller decides whether to send it.
 */
import { SUMMARY_CHARS, summarizeItem } from "./summarize.ts";
import { CONTEXT_CHARS, PickError, type ClipItem, type Context, type PickRequest, type PickState } from "./types.ts";

/** At most this many candidates are offered; the rest are ranked by heuristic only. */
export const MAX_PICK_CANDIDATES = 8;
/** The criterion that means "no candidate fits". */
export const NONE = "none";

export interface BuildOptions {
  readonly maxCandidates?: number;
  readonly summaryChars?: number;
}

const tail = (s: string, n: number): string => { const c = [...s]; return c.length > n ? c.slice(-n).join("") : s; };
const head = (s: string, n: number): string => { const c = [...s]; return c.length > n ? c.slice(0, n).join("") : s; };

/**
 * Build the request for `candidates` (most recent first, as the shell hands
 * them; only the first `maxCandidates` are asked about). `ids` are the
 * candidate ids in criterion order, so `c3` is `ids[3]`. Throws PickError
 * for a secure context: nothing about a password field may be summarised.
 */
export function buildPickRequest(ctx: Context, candidates: readonly ClipItem[], opts: BuildOptions = {}): { readonly body: PickRequest; readonly ids: string[] } {
  if (ctx.secure) throw new PickError("secure field");
  const kept = candidates.slice(0, opts.maxCandidates ?? MAX_PICK_CANDIDATES);
  const summaries = kept.map((c) => summarizeItem(c, opts.summaryChars ?? SUMMARY_CHARS));

  const state: { -readonly [K in keyof PickState]: PickState[K] } = {
    app: ctx.appName ?? ctx.appBundleId,
    candidates: summaries.map((summary, i) => ({ i, summary })),
  };
  if (ctx.level >= 1) {
    if (ctx.role) state.role = ctx.role;
    if (ctx.label) state.label = ctx.label;
  }
  if (ctx.level >= 2) {
    if (ctx.before !== undefined) state.before = tail(ctx.before, CONTEXT_CHARS);
    if (ctx.after !== undefined) state.after = head(ctx.after, CONTEXT_CHARS);
  }

  const criteria: Record<string, string> = Object.fromEntries(summaries.map((s, i) => [`c${i}`, s]));
  criteria[NONE] = "nothing here fits; the user will choose";
  const body: PickRequest = {
    state,
    questions: {
      pick: { type: "choice", instructions: "Which clipboard item is the user about to paste here?", criteria },
      paste: { type: "noul", instructions: "Is this a place where pasting one of these makes sense right now?", criteria: { true: "yes, a paste belongs here", false: "no, nothing should be pasted here" } },
    },
  };
  return { body, ids: kept.map((c) => c.id) };
}
