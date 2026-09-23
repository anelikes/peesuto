/**
 * Running an action. The runtime knows four kinds of need and nothing about
 * any particular action: a generator action is a prompt, a render action is
 * the card chain with the action's overrides, smart paste is the pick.
 */
import { rm } from "node:fs/promises";
import type { Catalog } from "../catalog.ts";
import type { JevRequest } from "../questions.ts";
import { pick } from "../pick/index.ts";
import type { ClipItem, Context, PickResult } from "../pick/types.ts";
import { summarizeContext } from "../pick/summarize.ts";
import type { RenderOptions } from "../render/card.ts";
import type { CardDecider } from "../render/pipeline.ts";
import { resolveFFmpeg, VideoUnavailableError } from "../render/video.ts";
import { decideTemplate } from "../templates/decide.ts";
import { renderTemplate } from "../templates/render.ts";
import { TemplateInputError } from "../templates/types.ts";
import { ActionError, type ActionInput, type ActionResult, type ActionSpec } from "./types.ts";

export interface GeneratorLike {
  generate(req: { system?: string; prompt: string; maxTokens?: number }): Promise<{ text: string; model: string }>;
}

export interface ActionDeps {
  readonly decider: (CardDecider & { ask(body: JevRequest): Promise<unknown> }) | null;
  readonly generator: GeneratorLike | null;
  /** Render options without `out`; the runtime names the output file. */
  readonly render: Omit<RenderOptions, "out"> | null;
  /** History candidates for smart paste, most recent first. */
  readonly candidates?: () => Promise<ClipItem[]> | ClipItem[];
  /** The catalog with style packs merged in. */
  readonly catalog?: Catalog;
}

export function fillTemplate(template: string, input: ActionInput): string {
  const ctx = input.context;
  return template
    .replaceAll("{{input}}", input.text)
    .replaceAll("{{context}}", ctx ? summarizeContext(ctx) : "")
    .replaceAll("{{app}}", ctx?.appName ?? ctx?.appBundleId ?? "");
}

export async function runAction(spec: ActionSpec, input: ActionInput, deps: ActionDeps): Promise<ActionResult | (ActionResult & { pick: PickResult })> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  if (!input.text?.trim() && spec.needs !== "decider") throw new ActionError("input", `${spec.id}: nothing to work on`);
  switch (spec.needs) {
    case "none":
      return { output: "text", text: input.text, ms: ms() };
    case "generator": {
      if (!deps.generator) throw new ActionError("needs", `${spec.id} needs a generator; none is configured`);
      const r = await deps.generator.generate({ system: spec.system, prompt: fillTemplate(spec.prompt ?? "{{input}}", input), maxTokens: spec.maxTokens });
      const text = r.text.trim();
      if (text === "") throw new ActionError("run", `${spec.id}: ${r.model} returned nothing`);
      return { output: "text", text, model: r.model, ms: ms() };
    }
    case "render": {
      if (!deps.render) throw new ActionError("needs", `${spec.id} needs the render engine; it is not available`);
      if (spec.output !== "image" && spec.output !== "gif" && spec.output !== "video") throw new ActionError("spec", `${spec.id}: a render action outputs image, gif or video`);
      let ffmpeg: string | undefined;
      if (spec.output === "video") {
        try { ffmpeg = resolveFFmpeg({ executable: deps.render.ffmpeg }); }
        catch (error) {
          if (error instanceof VideoUnavailableError) throw new ActionError("needs", error.message);
          throw error;
        }
      }
      const aspect = input.aspect ?? spec.render?.aspect ?? "chat";
      let decision;
      try {
        decision = await decideTemplate(input.text, { aspect, decider: deps.decider, output: spec.output,
          override: input.template, preferences: input.templatePreferences, animate: spec.render?.animate });
      } catch (error) {
        if (error instanceof TemplateInputError) throw new ActionError("input", error.message);
        throw error;
      }
      const { plan, decisionSource, availableTemplates, decisionError } = decision;
      const format = spec.output === "video" ? "mp4" : spec.output === "gif" ? "gif" : "png";
      const r = await renderTemplate(plan, { ...deps.render, catalog: deps.catalog, format, ffmpeg });
      // GIF/MP4 must animate unless the action is explicitly static ("never").
      if (format !== "png" && spec.render?.animate !== "never" && (r.format !== format || plan.motion === "none" || r.frames <= 1)) {
        await rm(r.path, { force: true });
        throw new ActionError("run", `${spec.id}: the card came out static`);
      }
      return { output: spec.output, path: r.path, format: r.format, ms: ms(), meta: {
        template: { id: plan.template, variant: plan.variant, motion: plan.motion, decisionSource, availableTemplates, ...(decisionError ? { decisionError } : {}) },
        lines: r.lines, size: r.size, frames: r.frames, render: r.ms,
      } };
    }
    case "decider": {
      const candidates = deps.candidates ? await deps.candidates() : input.item ? [input.item] : [];
      const ctx: Context = input.context ?? { level: 0, appBundleId: "" };
      const result = await pick(ctx, candidates, deps.decider as never);
      const top = result.ranked[0];
      return { output: "text", text: top?.item.text ?? input.text, ms: ms(), pick: result };
    }
  }
}
