/**
 * `rules`: card decisions without a model. The kind comes from the rule
 * classifier (core/src/render/classify.ts), the geometry from the same
 * length heuristics the no-decider fallback uses, and nothing is animated.
 * On the corpus that is 91% on the kind against Laya's 35–41% zero-shot
 * (baselines/laya.md), so it is the open-source first run: instant, offline,
 * nothing to configure.
 *
 * It answers only the card questions. A pick request gets `null`, which is
 * the decider's way of saying "use the heuristic" (core/src/pick/index.ts).
 */
import { classify } from "../../render/classify.ts";
import { fallbackDsl, type JevAnswers, type JevRequest } from "../../questions.ts";
import type { Decider } from "./types.ts";

/** A card request carries the clipboard text and the seven questions; a pick carries candidates. */
function clipboardOf(body: JevRequest): string | null {
  const q = body.questions;
  if (!q || typeof q !== "object" || !("kind" in q) || !("emphasis" in q)) return null;
  const text = (body.state as { clipboard?: unknown } | undefined)?.clipboard;
  return typeof text === "string" && text.trim() !== "" ? text : null;
}

export function rulesAnswers(text: string): JevAnswers {
  const kind = classify(text);
  const geometry = fallbackDsl(text, "chat");
  return {
    kind: { choice: kind, probabilities: { [kind]: 1 } },
    layout: { choice: geometry.layout },
    palette: { choice: geometry.palette },
    scale: { score: geometry.scale },
    tone: { score: 0 },
    animate: { noul: 0 },
    emphasis: { choice: "none" },
  };
}

export const rulesDecider: Decider = {
  name: "rules",
  async ask(body) {
    const text = clipboardOf(body);
    return text === null ? null : rulesAnswers(text);
  },
};
