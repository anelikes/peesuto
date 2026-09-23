/**
 * The one choke point between a decision request and a network model. A
 * wrapped decider rewrites every string in `body.state` (recursively) and
 * every criterion *description* per the mode; criterion keys, instructions
 * and question names are never touched (they are ours, and answers name
 * keys). Local deciders (rules, none, laya) are not wrapped: they see the
 * original text, which never leaves the machine.
 *
 *   raw        unchanged
 *   redacted   redactForModel
 *   structure  redact, then structureOnly outside the placeholders
 *
 * Criterion descriptions are redacted like the state. Two extra steps keep a
 * secret from leaking through a question built from the content: a
 * description that is a fragment of something redacted in the state (a word
 * the segmenter cut out of a key) becomes that placeholder, and in structure
 * mode a description that occurs verbatim in the state (a candidate summary,
 * an emphasis word) is structured too.
 */
import type { JevRequest } from "../questions.ts";
import { modelText, redactForModel, type CompiledPrivacy, type ModelContentMode, type Span } from "./rules.ts";

/** Decider kinds that run on this machine and get the original text. */
export const LOCAL_DECIDER_KINDS = ["rules", "none", "laya"] as const;
export const isLocalDecider = (kind: string): boolean => (LOCAL_DECIDER_KINDS as readonly string[]).includes(kind);

/** What a wrapped decider tells request builders about itself. */
export interface ModelContentInfo {
  readonly mode: ModelContentMode;
  /** Spans the model will not see in `text`. */
  spans(text: string): Span[];
  /** Redacted text, for builders that cut text before sending (summaries). */
  redact(text: string): string;
}

export interface Askable {
  readonly name: string;
  ask(body: JevRequest): Promise<unknown>;
  readonly pickWeight?: number;
}

export function modelContentOf(decider: unknown): ModelContentInfo | undefined {
  return (decider as { modelContent?: ModelContentInfo } | null | undefined)?.modelContent;
}

export function rewriteForModel<T extends { state: unknown; questions: Record<string, unknown> }>(body: T, privacy: CompiledPrivacy, mode: ModelContentMode = privacy.config.modelContent): T {
  if (mode === "raw") return body;
  const originals: { text: string; replacement: string }[] = [];
  const sources: string[] = [];
  const text = (s: string): string => {
    const m = modelText(s, privacy, mode);
    sources.push(s);
    for (const span of m.spans) originals.push({ text: s.slice(span.start, span.end), replacement: span.replacement });
    return m.text;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const state = walk(body.state);
  const description = (d: string): string => {
    const token = d.trim();
    if (token && !/\s/.test(token)) {
      const inside = originals.find((o) => o.text.includes(token));
      if (inside) return inside.replacement;
    }
    const redacted = redactForModel(d, privacy);
    let out = redacted.text;
    for (const o of originals) if (o.text.length >= 4) out = out.split(o.text).join(o.replacement);
    if (mode === "structure" && token.length >= 2 && sources.some((s) => s.includes(token))) return modelText(d, privacy, "structure").text;
    return out;
  };
  const questions = Object.fromEntries(Object.entries(body.questions).map(([name, q]) => {
    if (!q || typeof q !== "object" || Array.isArray(q)) return [name, q];
    const { criteria, ...rest } = q as { criteria?: unknown };
    if (criteria === undefined) return [name, q];
    const next = Array.isArray(criteria) ? criteria.map((c) => typeof c === "string" ? description(c) : c)
      : criteria && typeof criteria === "object" ? Object.fromEntries(Object.entries(criteria).map(([k, c]) => [k, typeof c === "string" ? description(c) : c]))
      : criteria;
    return [name, { ...rest, criteria: next }];
  }));
  return { ...body, state, questions };
}

/** Wrap a network decider so everything it sends goes through the privacy rules. */
export function privateDecider<D extends Askable>(inner: D, privacy: CompiledPrivacy): D & { readonly modelContent: ModelContentInfo } {
  const mode = privacy.config.modelContent;
  const modelContent: ModelContentInfo = {
    mode,
    spans: (t) => mode === "raw" ? [] : redactForModel(t, privacy).spans,
    redact: (t) => mode === "raw" ? t : redactForModel(t, privacy).text,
  };
  return {
    ...inner,
    name: inner.name,
    modelContent,
    ask: (body: JevRequest) => inner.ask(rewriteForModel(body, privacy, mode)),
  } as D & { readonly modelContent: ModelContentInfo };
}

/** Wrap `decider` when its kind is a network one; local kinds and null pass through. */
export function deciderForModel<D extends Askable>(decider: D | null, kind: string, privacy: CompiledPrivacy): D | null {
  if (!decider || isLocalDecider(kind)) return decider;
  return privateDecider(decider, privacy);
}
