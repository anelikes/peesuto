/**
 * The seven questions a paste asks Jev, and how the answers become a DSL.
 *
 * Jev (TypeSafe AI) answers typed questions only: a Choice over named
 * criteria, a Score over an ordered list, a Noul (a calibrated yes/no). Every
 * option here is a name; the numbers behind the names live in the composer.
 * Pure functions — nothing here touches the network or the disk.
 */
import { BASE_CATALOG, criteriaOf, type Catalog } from "./catalog.ts";
import { type Aspect, type Dsl, type Kind, type Level, KINDS } from "./dsl.ts";

export interface JevRequest {
  readonly state: { readonly clipboard: string };
  readonly questions: Record<string, unknown>;
}

export interface Answers {
  readonly kind: { readonly choice: string; readonly probabilities?: Record<string, number> };
  readonly layout: { readonly choice: string };
  readonly palette: { readonly choice: string };
  readonly scale: { readonly score: number };
  readonly tone: { readonly score: number };
  readonly animate: { readonly noul: number };
  readonly emphasis: { readonly choice: string };
}

/** Words as Jev may name them: segmented for zh-CN, letters or digits only. */
export function segmentWords(text: string): string[] {
  return [...new Intl.Segmenter("zh-CN", { granularity: "word" }).segment(text)]
    .map((s) => s.segment)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
}

/** At most this many words are offered as emphasis candidates. */
export const MAX_EMPHASIS_WORDS = 200;

export function buildRequest(text: string, catalog: Catalog = BASE_CATALOG): { readonly body: JevRequest; readonly words: string[] } {
  const words = segmentWords(text).slice(0, MAX_EMPHASIS_WORDS);
  const wordCriteria: Record<string, string> = Object.fromEntries(words.map((w, i) => [`w${i}`, w]));
  wordCriteria["none"] = "no single word deserves emphasis";
  const body: JevRequest = {
    state: { clipboard: text },
    questions: {
      // `event` is offered so that appointments are not forced into another
      // kind; it has no template yet and renders as plain (answersToDsl).
      kind: { type: "choice", instructions: "What kind of text is on the clipboard?", criteria: {
        ...criteriaOf(catalog.kinds), event: "a time, a place, an appointment" } },
      layout: { type: "choice", instructions: "Which layout suits it as a card?", criteria: criteriaOf(catalog.layouts) },
      palette: { type: "choice", instructions: "Which palette suits the content's mood?", criteria: criteriaOf(catalog.palettes) },
      scale: { type: "score", instructions: "How large should the type be, given how much text there is?", criteria: ["small: many lines", "medium", "large: a few lines", "huge: a few words"] },
      tone: { type: "score", instructions: "How emphatic should the entrance animation be?", criteria: ["none: static or informational", "gentle", "emphatic", "dramatic"] },
      animate: { type: "noul", instructions: "Does the content read in a sequence that motion would reveal (steps, a count, typing)?", criteria: { true: "yes, it has an intrinsic order", false: "no, it is one static thought" } },
      emphasis: { type: "choice", instructions: "Which single word carries the point and should be coloured?", criteria: wordCriteria },
    },
  };
  return { body, words };
}

/** Below this probability the kind falls back to plain: a wrong template is worse than a plain one. */
export const KIND_CONFIDENCE = 0.6;

const clamp = (v: number): Level => Math.max(0, Math.min(3, Math.round(v))) as Level;

/**
 * Answers → DSL. `animate` and `tone` are answered independently (Jev never
 * conditions one question on another), so "yes, animate" with tone 0 is a
 * real combination that would render static: motion gets at least the
 * gentle tone. `event` has no template yet and renders as plain.
 */
export function answersToDsl(text: string, a: Answers, aspect: Aspect, catalog: Catalog = BASE_CATALOG): { readonly dsl: Dsl; readonly kindP: number } {
  const kindP = a.kind.probabilities?.[a.kind.choice] ?? 0;
  // A kind must be in the catalog AND have a template in the composer (KINDS);
  // a pack can add descriptions, templates still land in code.
  const known = a.kind.choice in catalog.kinds && (KINDS as readonly string[]).includes(a.kind.choice);
  const kind: Kind = kindP < KIND_CONFIDENCE || !known ? "plain" : (a.kind.choice as Kind);
  const emphasis = a.emphasis.choice === "none" || !/^w\d+$/.test(a.emphasis.choice) ? -1 : Number(a.emphasis.choice.slice(1));
  const animate = a.animate.noul > 0.5;
  const tone = animate ? (Math.max(1, clamp(a.tone.score)) as Level) : clamp(a.tone.score);
  const layout = (a.layout.choice in catalog.layouts ? a.layout.choice : "left") as Dsl["layout"];
  const palette = (a.palette.choice in catalog.palettes ? a.palette.choice : "ink") as Dsl["palette"];
  return { dsl: { text, kind, layout, palette, aspect, scale: clamp(a.scale.score), tone, emphasis, animate }, kindP };
}

/**
 * The card a paste gets with no decision provider at all: plain kind, a
 * layout and scale read off the text's length. Dumb, but never wrong.
 */
export function fallbackDsl(text: string, aspect: Aspect): Dsl {
  const chars = [...text.trim()].length;
  const multiline = text.trim().includes("\n");
  return {
    text, kind: "plain", aspect, palette: "ink",
    layout: multiline || chars > 60 ? "left" : "center",
    scale: chars <= 20 ? 3 : chars <= 60 ? 2 : chars <= 160 ? 1 : 0,
    tone: 0, emphasis: -1, animate: false,
  };
}
