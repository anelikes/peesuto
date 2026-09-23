/**
 * The Studio's use of core: decide a text the way the app does, expand the
 * decision into render jobs (every style of the chosen template, every style of
 * the other candidates, each motion as GIF, one MP4), and render one job.
 *
 * Templates, styles and motions come from TEMPLATE_REGISTRY at run time, so a
 * template added to core shows up without changes here. Used in-process by the
 * static gallery and by the Studio's worker subprocess (which is restarted when
 * core's template code changes, so it always runs the current code).
 */
import { join } from "node:path";
import type { Aspect } from "../../core/src/dsl.ts";
import { cachedProvider, createProvider } from "../../core/src/provider/index.ts";
import type { CardDecider } from "../../core/src/render/pipeline.ts";
import { decideTemplate } from "../../core/src/templates/decide.ts";
import { TEMPLATE_REGISTRY, templateRegistration } from "../../core/src/templates/registry.ts";
import { renderTemplate } from "../../core/src/templates/render.ts";
import type { TemplateId, TemplateMotion, TemplatePlan, VariantId } from "../../core/src/templates/types.ts";

export type Format = "png" | "gif" | "mp4";
export type DeciderKind = "rules" | "jev";
export type JobGroup = "chosen" | "other" | "motion" | "video";

/** Which parts of the grid to render. */
export interface Formats { readonly png: boolean; readonly others: boolean; readonly gif: boolean; readonly mp4: boolean }
export const ALL_FORMATS: Formats = { png: true, others: true, gif: true, mp4: true };

export interface JobSpec {
  readonly template: string;
  readonly variant: string;
  readonly motion: string;
  readonly format: Format;
  readonly group: JobGroup;
  readonly label: string;
  /** The automatic decision itself (the first PNG). */
  readonly auto: boolean;
  readonly plan: TemplatePlan;
}

export interface DecisionInfo {
  readonly template: string;
  readonly templateName: string;
  readonly variant: string;
  readonly variantName: string;
  readonly candidates: readonly { readonly id: string; readonly name: string }[];
  readonly decisionSource: string;
  readonly decisionError?: { readonly kind: string; readonly message: string };
  readonly emphasis?: string;
  readonly decider: DeciderKind;
  readonly ms: number;
}

export interface PlanResult { readonly decision: DecisionInfo; readonly jobs: readonly JobSpec[] }

export interface RenderMeta {
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  readonly scroll: boolean;
  readonly ms: number;
  readonly bytes: number;
}

const MOTION_ZH: Record<string, string> = { none: "静止", reveal: "逐段出现", typewriter: "打字机" };
const FORMAT_ZH: Record<Format, string> = { png: "PNG", gif: "GIF", mp4: "视频" };
export const motionName = (motion: string) => MOTION_ZH[motion] ?? motion;
export const templateName = (id: string) => templateRegistration(id as TemplateId)?.nameZh ?? id;
export const variantName = (id: string, variant: string) => templateRegistration(id as TemplateId)?.variants.find((v) => v.id === variant)?.nameZh ?? variant;
export const jobLabel = (template: string, variant: string, motion: string, format: Format) =>
  [templateName(template), variantName(template, variant), ...(format === "png" ? [] : [motionName(motion)]), FORMAT_ZH[format]].join(" · ");

/** Registry summary for the page (names only). */
export function registrySummary() {
  return TEMPLATE_REGISTRY.map((t) => ({ id: t.id, name: t.nameZh, variants: t.variants.map((v) => ({ id: v.id, name: v.nameZh })), motions: t.motions.map((m) => ({ id: m, name: motionName(m) })) }));
}

/** null is the app's local rules decision. "jev" needs PASTE_CF_TOKEN and PASTE_CF_ACCOUNT_ID. */
export function makeDecider(kind: DeciderKind, answersDir: string): CardDecider | null {
  if (kind === "rules") return null;
  const accountId = process.env.PASTE_CF_ACCOUNT_ID, token = process.env.PASTE_CF_TOKEN;
  if (!accountId || !token) throw new Error("Jev (Cloudflare) 需要环境变量 PASTE_CF_TOKEN 和 PASTE_CF_ACCOUNT_ID（仓库根 .env）");
  return cachedProvider(createProvider({ kind: "cloudflare", accountId, token }), answersDir);
}
export const jevAvailable = () => Boolean(process.env.PASTE_CF_TOKEN && process.env.PASTE_CF_ACCOUNT_ID);

/**
 * Decide `text` and expand the decision into jobs. With `autoOnly`, only the
 * automatic PNG. Jev's style and emphasis are kept for the chosen template's
 * GIF/MP4 (its plan is reused with another motion, not re-decided).
 */
export async function planText(text: string, o: { aspect: Aspect; decider: DeciderKind; answersDir: string; formats: Formats; video: boolean; autoOnly?: boolean }): Promise<PlanResult> {
  const started = performance.now();
  const auto = await decideTemplate(text, { aspect: o.aspect, output: "image", decider: makeDecider(o.decider, o.answersDir) });
  const ms = Math.round(performance.now() - started);
  const chosen = auto.plan.template;
  const registration = templateRegistration(chosen);
  const jobs: JobSpec[] = [];
  const add = (plan: TemplatePlan, format: Format, group: JobGroup, isAuto = false) =>
    jobs.push({ template: plan.template, variant: plan.variant, motion: plan.motion, format, group, auto: isAuto, label: jobLabel(plan.template, plan.variant, plan.motion, format), plan });

  add(auto.plan, "png", "chosen", true);
  if (!o.autoOnly) {
    if (o.formats.png) for (const v of registration.variants) if (v.id !== auto.plan.variant) add({ ...auto.plan, variant: v.id }, "png", "chosen");
    if (o.formats.others) {
      for (const other of auto.availableTemplates.filter((id) => id !== chosen)) {
        const base = await decideTemplate(text, { aspect: o.aspect, output: "image", decider: null, override: { id: other } });
        for (const v of templateRegistration(other).variants) add({ ...base.plan, variant: v.id as VariantId }, "png", "other");
      }
    }
    const motions = registration.motions.filter((m) => m !== "none") as TemplateMotion[];
    if (o.formats.gif) for (const motion of motions) add({ ...auto.plan, motion }, "gif", "motion");
    if (o.formats.mp4 && o.video && motions[0]) add({ ...auto.plan, motion: motions[0] }, "mp4", "video");
  }
  return {
    decision: {
      template: chosen, templateName: registration.nameZh, variant: auto.plan.variant, variantName: variantName(chosen, auto.plan.variant),
      candidates: auto.availableTemplates.map((id) => ({ id, name: templateName(id) })),
      decisionSource: auto.decisionSource, ...(auto.decisionError ? { decisionError: auto.decisionError } : {}),
      ...(auto.plan.emphasis ? { emphasis: auto.plan.emphasis } : {}), decider: o.decider, ms,
    },
    jobs,
  };
}

export interface EngineOptions { readonly engine: string; readonly root: string; readonly repo: string; readonly ffmpeg?: string }

/** Render one job to `out`. Throws ComposeError / TemplateInputError / EngineError as core does. */
export async function renderJob(plan: TemplatePlan, format: Format, out: string, o: EngineOptions): Promise<RenderMeta> {
  const started = performance.now();
  const r = await renderTemplate(plan, {
    engine: o.engine, work: join(o.root, ".tree"), emojiCache: join(o.root, ".emoji"), emojiBundle: join(o.repo, ".work/emoji-all"),
    ffmpeg: o.ffmpeg, format, out,
  });
  return { width: r.width, height: r.height, frames: r.frames, scroll: r.scroll, ms: Math.round(performance.now() - started), bytes: Bun.file(out).size };
}

/** A render error as `{kind, message}`; kind is the error class (ComposeError, EngineError, …). */
export function errorOf(error: unknown): { kind: string; message: string } {
  if (error instanceof Error) return { kind: (error as { code?: unknown }).code ? `${error.constructor.name}:${String((error as { code?: unknown }).code)}` : error.constructor.name, message: error.message };
  return { kind: "Error", message: String(error) };
}
