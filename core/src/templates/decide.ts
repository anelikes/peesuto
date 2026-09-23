import { isAspect, type Aspect } from "../dsl.ts";
import type { JevRequest } from "../questions.ts";
import type { CardDecider } from "../render/pipeline.ts";
import { parseTemplates, type ParsedTemplates } from "./parse.ts";
import { templateRegistration } from "./registry.ts";
import { MOTIONS, TEMPLATE_IDS, VARIANT_IDS, TemplateInputError, type TemplateDecision, type TemplateId, type TemplateMotion, type TemplateOverride, type VariantId } from "./types.ts";

export const TEMPLATE_CONFIDENCE = 0.65;

export interface TemplateDecisionOptions {
  readonly aspect: Aspect;
  readonly decider: CardDecider | null;
  readonly output: "image" | "gif" | "video";
  readonly override?: TemplateOverride;
  readonly preferences?: Readonly<Record<string, string>>;
  /** Custom actions can opt out of motion independently from their container. */
  readonly animate?: "auto" | "always" | "never";
}

export function buildTemplateRequest(parsed: ParsedTemplates, allowMotion: boolean): JevRequest {
  const eligible = [...parsed.candidates.keys()];
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
        criteria: allowMotion ? { none: "one still composition", reveal: "reveal content groups in reading order", typewriter: "reveal the existing text progressively" } : { none: "still image" },
      },
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

/** Jev can select only presentation metadata. Content never comes from its answer. */
export async function decideTemplate(text: string, options: TemplateDecisionOptions): Promise<TemplateDecision> {
  if (!isAspect(options.aspect)) throw new TemplateInputError("Unknown card aspect.");
  const parsed = parseTemplates(text);
  const availableTemplates = [...parsed.candidates.keys()];
  const override = validateOverride(options.override);
  if (override.id && !parsed.candidates.has(override.id)) {
    throw new TemplateInputError(`The source does not contain the explicit structure required by the ${override.id} template. Use document to preserve the original text.`);
  }
  let template: TemplateId = override.id ?? parsed.preferred;
  let variant: VariantId = "classic";
  const allowMotion = options.output !== "image" && options.animate !== "never";
  let motion: TemplateMotion = allowMotion ? "reveal" : "none";
  let decisionSource: TemplateDecision["decisionSource"] = "rules";
  const hasOverride = override.id !== undefined || override.variant !== undefined || override.motion !== undefined;
  // Manual rerendering must be stable and must not launch another provider call.
  if (hasOverride) decisionSource = "override";
  else if (options.decider && !["rules", "none"].includes(options.decider.name)) {
    try {
      const answers = await options.decider.ask(buildTemplateRequest(parsed, allowMotion));
      const choice = confidentChoice(answers, "template", availableTemplates) as TemplateId | undefined;
      if (choice) {
        template = choice;
        const selectedVariant = confidentChoice(answers, "variant", templateRegistration(template).variants.map((v) => `${template}.${v.id}`));
        if (selectedVariant) variant = selectedVariant.slice(template.length + 1) as VariantId;
        const selectedMotion = confidentChoice(answers, "motion", allowMotion ? MOTIONS : ["none"]);
        if (selectedMotion) motion = selectedMotion as TemplateMotion;
        decisionSource = "jev";
      } else decisionSource = "fallback";
    } catch { decisionSource = "fallback"; }
  }
  const preferred = options.preferences?.[template];
  if (preferred && VARIANT_IDS.includes(preferred as VariantId)) variant = preferred as VariantId;
  if (override.variant) variant = override.variant;
  if (override.motion) motion = override.motion;
  if (!allowMotion) motion = "none";
  return {
    plan: { version: 1, template, variant, motion, sourceText: parsed.sourceText, content: parsed.candidates.get(template)!, aspect: options.aspect },
    decisionSource,
    availableTemplates,
  };
}
