import type { Decider } from "./types.ts";

/** No decisions: the caller falls back to its heuristics (the plain card, most-recent-first). */
export const noneDecider: Decider = { name: "none", ask: async () => null };
