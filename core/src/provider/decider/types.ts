/**
 * The decider track: typed questions in, one answer per question out. Jev
 * is the model behind every implementation today; the shape is Jev's, the
 * transport differs.
 */
import type { JevAnswers, JevRequest } from "../../questions.ts";
import { ProviderError } from "../types.ts";

export type { JevAnswer, JevAnswers } from "../../questions.ts";

/** Where a request's typed questions go. `null` answers mean "no decision was made". */
export interface Decider {
  readonly name: string;
  ask(body: JevRequest): Promise<JevAnswers | null>;
  /** How much of the pick ranking this decider's answer gets (0..1); unset means the default blend. */
  readonly pickWeight?: number;
}

/** The card path's name for a decider. */
export type Provider = Decider;

function isAnswers(a: unknown): a is JevAnswers {
  if (!a || typeof a !== "object" || Array.isArray(a)) return false;
  const values = Object.values(a);
  return values.length > 0 && values.every((v) => !!v && typeof v === "object" && !Array.isArray(v));
}

/** Pull the answers out of a proxy or REST envelope; throw on anything else. */
export function answersOf(raw: unknown, origin: string): JevAnswers {
  const r = raw as { result?: { answers?: unknown }; answers?: unknown; error?: unknown; errors?: unknown } | null;
  const a = r?.result?.answers ?? r?.answers;
  if (isAnswers(a)) return a;
  const why = r?.error ?? r?.errors ?? raw;
  throw new ProviderError("bad-response", `${origin}: no answers in response: ${(JSON.stringify(why) ?? String(why)).slice(0, 300)}`);
}
