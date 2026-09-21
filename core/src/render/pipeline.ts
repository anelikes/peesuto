/**
 * Text → DSL: the card decision, shared by the CLI, the actions and the daemon.
 * The decider answers the seven questions (or does not); the DSL is what the
 * composer renders. `force` lets an action pin what the decider would decide
 * — "paste as GIF" wants motion whatever Jev thinks of the text.
 */
import type { Catalog } from "../catalog.ts";
import type { Aspect, Dsl, Level } from "../dsl.ts";
import type { JevRequest } from "../questions.ts";
import { answersToDsl, buildRequest, fallbackDsl, isCardAnswers } from "../questions.ts";

/** The decider surface the card needs: the old Provider shape. */
export interface CardDecider { readonly name: string; ask(body: JevRequest): Promise<unknown> }

export interface CardDecision { readonly dsl: Dsl; readonly decided: { provider: string; kindP?: number; ms: number } }

export async function decideCard(text: string, o: { aspect: Aspect; decider: CardDecider | null; force?: { animate?: boolean; minTone?: Level }; catalog?: Catalog }): Promise<CardDecision> {
  const t0 = performance.now();
  let dsl: Dsl, decided: CardDecision["decided"];
  const answers = o.decider ? await o.decider.ask(buildRequest(text, o.catalog).body) : null;
  if (isCardAnswers(answers)) {
    const r = answersToDsl(text, answers, o.aspect, o.catalog);
    dsl = r.dsl;
    decided = { provider: o.decider!.name, kindP: r.kindP, ms: Math.round(performance.now() - t0) };
  } else {
    dsl = fallbackDsl(text, o.aspect);
    decided = { provider: o.decider?.name ?? "none", ms: Math.round(performance.now() - t0) };
  }
  if (o.force?.animate !== undefined) {
    const animate = o.force.animate;
    const tone = animate ? (Math.max(o.force.minTone ?? 1, dsl.tone) as Level) : dsl.tone;
    dsl = { ...dsl, animate, tone };
  }
  return { dsl, decided };
}
