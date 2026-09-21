/**
 * The card DSL: every field except `text` is a value Jev can return — a
 * Choice over a fixed set, a Score 0..3, or a boolean. `text` is the
 * clipboard and comes from code. Line breaks and sizes are never in here;
 * they are measured at compose time.
 */
export const KINDS = ["quote", "code", "stat", "list", "plain"] as const;
export const LAYOUTS = ["center", "left", "split"] as const;
export const PALETTES = ["ink", "paper", "cyan", "amber"] as const;
export const ASPECTS = ["chat", "doc", "social"] as const;

export type Kind = (typeof KINDS)[number];
export type Layout = (typeof LAYOUTS)[number];
export type Palette = (typeof PALETTES)[number];
export type Aspect = (typeof ASPECTS)[number];
export type Level = 0 | 1 | 2 | 3;

export interface Dsl {
  readonly text: string;
  readonly kind: Kind;
  readonly layout: Layout;
  readonly palette: Palette;
  readonly aspect: Aspect;
  readonly scale: Level;
  readonly tone: Level;
  /** Index into the segmented words of `text`, or -1 for none. */
  readonly emphasis: number;
  readonly animate: boolean;
}

export class DslError extends Error {}

const oneOf = <T extends string>(set: readonly T[], v: unknown): v is T => typeof v === "string" && (set as readonly string[]).includes(v);

export function parseDsl(raw: unknown): Dsl {
  const bad = (m: string): never => { throw new DslError(`paste dsl: ${m}`); };
  if (typeof raw !== "object" || raw === null) return bad("must be an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.text !== "string" || !r.text.trim()) bad("text must be a non-empty string");
  if (!oneOf(KINDS, r.kind)) bad(`kind must be one of ${KINDS.join("|")}`);
  if (!oneOf(LAYOUTS, r.layout)) bad(`layout must be one of ${LAYOUTS.join("|")}`);
  if (!oneOf(PALETTES, r.palette)) bad(`palette must be one of ${PALETTES.join("|")}`);
  if (!oneOf(ASPECTS, r.aspect)) bad(`aspect must be one of ${ASPECTS.join("|")}`);
  for (const k of ["scale", "tone"]) if (![0, 1, 2, 3].includes(r[k] as number)) bad(`${k} must be 0..3`);
  if (!Number.isInteger(r.emphasis) || (r.emphasis as number) < -1) bad("emphasis must be -1 or a word index");
  if (typeof r.animate !== "boolean") bad("animate must be boolean");
  return raw as Dsl;
}

export const isAspect = (v: unknown): v is Aspect => oneOf(ASPECTS, v);
