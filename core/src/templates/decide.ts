import type { JevRequest } from "../questions.ts";
import type { CardDecider } from "../render/pipeline.ts";
import { parseTemplates, type ParsedTemplates } from "./parse.ts";
import { MANUAL_TEMPLATES, templateHasVariant, templateRegistration } from "./registry.ts";
import { ProviderError } from "../provider/types.ts";
import { modelContentOf, type ModelContentInfo } from "../privacy/decider.ts";
import { DEFAULT_ASPECT, MOTIONS, TEMPLATE_IDS, VARIANT_IDS, TemplateInputError, templateAspect, type TemplateAspect, type TemplateDecision, type TemplateId, type TemplateMotion, type TemplateOverride, type VariantId } from "./types.ts";

export const TEMPLATE_CONFIDENCE = 0.65;

export interface TemplateDecisionOptions {
  /** A TemplateAspect or a legacy name (chat, doc, social); absent means the output's default. */
  readonly aspect?: string;
  readonly decider: CardDecider | null;
  readonly output: "image" | "gif" | "video";
  readonly override?: TemplateOverride;
  readonly preferences?: Readonly<Record<string, string>>;
  /** Custom actions can opt out of motion independently from their container. */
  readonly animate?: "auto" | "always" | "never";
}

/** Motion choices offered to the model. When motion is required (a GIF or MP4
 * that is not explicitly static) "none" is not a choice at all. */
function motionChoices(allowMotion: boolean, requireMotion: boolean): Record<string, string> {
  if (!allowMotion) return { none: "still image" };
  const animated = { reveal: "reveal content groups in reading order", typewriter: "reveal the existing text progressively" };
  return requireMotion ? animated : { none: "one still composition", ...animated };
}

/** Words the text template may accent, in source order. Only whole words that
 * occur verbatim in the source are offered, so an answer cannot add text. */
export function emphasisCandidates(paragraphs: readonly string[], limit = 12, exclude?: (paragraph: string, start: number, end: number) => boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const paragraph of paragraphs) {
    for (const part of new Intl.Segmenter(undefined, { granularity: "word" }).segment(paragraph)) {
      if (!part.isWordLike) continue;
      const word = part.segment;
      if (exclude?.(paragraph, part.index, part.index + word.length)) continue;
      const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(word);
      if (cjk ? [...word].length < 2 : word.length < 4 && !/\d/.test(word)) continue;
      const key = word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key); out.push(word);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Emphasis words a model may be offered. Behind a privacy-wrapped decider no
 * word inside a redacted span is offered (the criterion key is the word
 * itself, and keys are sent as they are), and in structure mode none at all.
 */
export function modelEmphasisCandidates(paragraphs: readonly string[], sourceText: string, modelContent?: ModelContentInfo): string[] {
  if (!modelContent || modelContent.mode === "raw") return emphasisCandidates(paragraphs);
  if (modelContent.mode === "structure") return [];
  const hidden = modelContent.spans(sourceText).map((s) => sourceText.slice(s.start, s.end));
  const byParagraph = new Map<string, { start: number; end: number }[]>();
  return emphasisCandidates(paragraphs, 12, (paragraph, start, end) => {
    if (!byParagraph.has(paragraph)) byParagraph.set(paragraph, modelContent.spans(paragraph));
    const word = paragraph.slice(start, end);
    return byParagraph.get(paragraph)!.some((s) => s.start < end && start < s.end) || hidden.some((h) => h.includes(word));
  });
}

export function buildTemplateRequest(parsed: ParsedTemplates, allowMotion: boolean, requireMotion = false, modelContent?: ModelContentInfo): JevRequest {
  const eligible = [...parsed.candidates.keys()].filter((id) => !MANUAL_TEMPLATES.includes(id));
  const text = parsed.candidates.get("text");
  const words = text?.kind === "text" ? modelEmphasisCandidates(text.paragraphs, parsed.sourceText, modelContent) : [];
  return {
    state: { clipboard: parsed.sourceText },
    questions: {
      template: {
        type: "choice", instructions: "Choose a presentation only from the source-validated candidates. Do not invent speakers, authors, metrics, rows or comparison points. Use document when uncertain.",
        criteria: Object.fromEntries(eligible.map((id) => [id, templateRegistration(id).name])),
      },
      variant: {
        type: "choice", instructions: "Choose a registered visual style belonging to the template you selected.",
        criteria: Object.fromEntries(eligible.flatMap((id) => templateRegistration(id).variants.map((variant) => [`${id}.${variant.id}`, `${templateRegistration(id).name}: ${variant.name}`]))),
      },
      motion: {
        type: "choice", instructions: "Choose how the existing content appears; never change its words. Still images require none.",
        criteria: motionChoices(allowMotion, requireMotion),
      },
      ...(words.length ? { emphasis: {
        type: "choice", instructions: "If the text template is used, the one word that carries the message, to be accented. Choose none unless one word clearly stands out.",
        criteria: { none: "no accent", ...Object.fromEntries(words.map((word) => [word, `the word "${word}"`])) },
      } } : {}),
    },
  };
}

function confidentChoice(answers: unknown, key: string, allowed: readonly string[]): string | undefined {
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) return;
  const answer = (answers as Record<string, unknown>)[key];
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return;
  const { choice, probabilities } = answer as { choice?: unknown; probabilities?: unknown };
  if (typeof choice !== "string" || !allowed.includes(choice) || !probabilities || typeof probabilities !== "object" || Array.isArray(probabilities)) return;
  const values = Object.values(probabilities);
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) return;
  const confidence = (probabilities as Record<string, unknown>)[choice];
  return typeof confidence === "number" && confidence >= TEMPLATE_CONFIDENCE ? choice : undefined;
}

function validateOverride(override: TemplateOverride | undefined): TemplateOverride {
  if (override === undefined) return {};
  if (override === null || typeof override !== "object" || Array.isArray(override)) throw new TemplateInputError("Template override must be an object.");
  if (override.id !== undefined && !TEMPLATE_IDS.includes(override.id)) throw new TemplateInputError("Unknown template.");
  if (override.variant !== undefined && !VARIANT_IDS.includes(override.variant)) throw new TemplateInputError("Unknown template style.");
  if (override.motion !== undefined && !MOTIONS.includes(override.motion)) throw new TemplateInputError("Unknown template motion.");
  return override;
}

/** Why a model decision could not be used; rendering continued with the local fallback. */
function decisionErrorOf(error: unknown): NonNullable<TemplateDecision["decisionError"]> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ProviderError) return { kind: `provider:${error.code}`, message };
  return { kind: "error", message };
}

/** Jev can select only presentation metadata. Content never comes from its answer. */
export async function decideTemplate(text: string, options: TemplateDecisionOptions): Promise<TemplateDecision> {
  const aspect: TemplateAspect | undefined = options.aspect === undefined ? DEFAULT_ASPECT[options.output] : templateAspect(options.aspect, options.output);
  if (!aspect) throw new TemplateInputError("Unknown card frame. Use auto, 1:1, 4:5, 16:9 or 9:16.");
  const parsed = parseTemplates(text);
  const availableTemplates = [...parsed.candidates.keys()];
  const override = validateOverride(options.override);
  if (override.id && !parsed.candidates.has(override.id)) {
    throw new TemplateInputError(`The source does not contain the explicit structure required by the ${override.id} template. Use document to preserve the original text.`);
  }
  let template: TemplateId = override.id ?? parsed.preferred;
  if (override.variant !== undefined && !templateHasVariant(template, override.variant)) {
    throw new TemplateInputError(`The ${template} template has no ${override.variant} style.`);
  }
  let variant: VariantId = "classic";
  let emphasis: string | undefined;
  const allowMotion = options.output !== "image" && options.animate !== "never";
  // A GIF or MP4 action must animate unless its author explicitly chose "never".
  const requireMotion = allowMotion;
  const DEFAULT_MOTION: TemplateMotion = "reveal";
  let motion: TemplateMotion = allowMotion ? DEFAULT_MOTION : "none";
  let decisionSource: TemplateDecision["decisionSource"] = "rules";
  let decisionError: TemplateDecision["decisionError"];
  const hasOverride = override.id !== undefined || override.variant !== undefined || override.motion !== undefined;
  // Manual rerendering must be stable and must not launch another provider call.
  if (hasOverride) decisionSource = "override";
  else if (options.decider && !["rules", "none"].includes(options.decider.name)) {
    try {
      const modelContent = modelContentOf(options.decider);
      const answers = await options.decider.ask(buildTemplateRequest(parsed, allowMotion, requireMotion, modelContent));
      const choice = confidentChoice(answers, "template", availableTemplates.filter((id) => !MANUAL_TEMPLATES.includes(id))) as TemplateId | undefined;
      if (choice) {
        template = choice;
        const selectedVariant = confidentChoice(answers, "variant", templateRegistration(template).variants.map((v) => `${template}.${v.id}`));
        if (selectedVariant) variant = selectedVariant.slice(template.length + 1) as VariantId;
        const allowedMotions = !allowMotion ? ["none"] : requireMotion ? MOTIONS.filter((m) => m !== "none") : MOTIONS;
        const selectedMotion = confidentChoice(answers, "motion", allowedMotions);
        if (selectedMotion) motion = selectedMotion as TemplateMotion;
        const content = parsed.candidates.get(template);
        if (content?.kind === "text") {
          const accent = confidentChoice(answers, "emphasis", modelEmphasisCandidates(content.paragraphs, parsed.sourceText, modelContent));
          if (accent) emphasis = accent;
        }
        decisionSource = "jev";
      } else decisionSource = "fallback";
    } catch (error) {
      // Keep rendering with the local decision, but tell the caller why.
      decisionSource = "fallback";
      decisionError = decisionErrorOf(error);
    }
  }
  const preferred = options.preferences?.[template];
  if (preferred && templateHasVariant(template, preferred)) variant = preferred;
  if (override.variant) variant = override.variant;
  // A "none" override cannot make a required animation static.
  if (override.motion && !(requireMotion && override.motion === "none")) motion = override.motion;
  if (!allowMotion) motion = "none";
  if (requireMotion && motion === "none") motion = DEFAULT_MOTION;
  // A template that registers fewer motions takes its closest one.
  if (!templateRegistration(template).motions.includes(motion)) motion = allowMotion ? DEFAULT_MOTION : "none";
  return {
    plan: { version: 1, template, variant, motion, sourceText: parsed.sourceText, content: parsed.candidates.get(template)!, aspect, ...(emphasis ? { emphasis } : {}) },
    decisionSource,
    availableTemplates,
    ...(decisionError ? { decisionError } : {}),
  };
}
