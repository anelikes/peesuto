/**
 * The long-lived Core: reads JSON-line requests, answers JSON lines. Kept
 * free of process concerns (stdin, exit) so tests can drive it with strings.
 */
import { join } from "node:path";
import { BUILTIN_ACTIONS, loadActions, renderAction, runAction, ActionError, type ActionDeps, type ActionResult, type ActionSpec, type LoadedActions } from "../actions/index.ts";
import { parseDsl } from "../dsl.ts";
import { EngineError } from "../engine.ts";
import { deciderForModel } from "../privacy/decider.ts";
import { applyOutputRules, compilePrivacy, containsSecret, describeBuiltins, parsePrivacyConfig, previewPrivacy, PrivacyConfigError, type CompiledPrivacy } from "../privacy/rules.ts";
import { rulesDecider } from "../provider/decider/rules.ts";
import { resolveFFmpeg } from "../render/video.ts";
import { renderTemplate } from "../templates/render.ts";
import { templateAspect } from "../templates/types.ts";
import { coreVersion, DEFAULT_PRECOMPOSE, parsePrecomposeConfig, precomposeKey, PrecomposeConfigError, Precomposer, PRECOMPOSE_OUTPUTS, renderKeyParts, visibleChars, type PrecomposeConfig, type PrecomposeOutput, type PrecomposeTask } from "./precompose.ts";
import { BASE_CATALOG } from "../catalog.ts";
import { loadPacks, type LoadedPacks } from "../packs.ts";
import { pick } from "../pick/index.ts";
import { ComposeError } from "../render/compose.ts";
import { renderCard, type RenderOptions } from "../render/card.ts";
import { ProviderError } from "../provider/types.ts";
import type { Request, Response, TaskEvent } from "./protocol.ts";
import { TEMPLATE_REGISTRY } from "../templates/registry.ts";

export interface DaemonHost {
  readonly version: string;
  readonly appData: string;
  /** Engine root, or null when rendering is unavailable in this install. */
  readonly engine: string | null;
  /** A bundled Noto Emoji set, when the install carries one. */
  readonly emojiBundle?: string;
  /** Build the providers from a config the shell sent; secrets stay in memory. */
  resolveProviders(cfg: { decider?: unknown; generator?: unknown; offline?: boolean; secrets?: Record<string, string>; egressLog?: string }): Promise<{ decider: ActionDeps["decider"]; generator: ActionDeps["generator"]; names: { decider: string; generator: string; offline: boolean } }>;
  /** The version of the code that renders (precompose cache key); computed when absent. */
  readonly coreVersion?: string;
  /** Substitute template renderer (tests). */
  readonly renderTemplate?: typeof renderTemplate;
}

/** The built-in render action for each precompose output. */
const PRECOMPOSE_SPECS: Readonly<Record<PrecomposeOutput, ActionSpec>> = {
  image: BUILTIN_ACTIONS.find((a) => a.id === "paste-card")!,
  gif: BUILTIN_ACTIONS.find((a) => a.id === "paste-gif")!,
  video: BUILTIN_ACTIONS.find((a) => a.id === "paste-video")!,
};

export class Daemon {
  private providers: Awaited<ReturnType<DaemonHost["resolveProviders"]>> | null = null;
  private actions: LoadedActions = { actions: [], problems: [] };
  private packs: LoadedPacks = { catalog: BASE_CATALOG, packs: [], problems: [] };
  private readonly started = Date.now();
  private privacy: CompiledPrivacy = compilePrivacy();
  private precompose: PrecomposeConfig = DEFAULT_PRECOMPOSE;
  private core = "";
  private readonly precomposer: Precomposer;
  constructor(private readonly host: DaemonHost) {
    this.precomposer = new Precomposer((task, signal) => renderAction(task.spec, task.input, this.deps(this.precompose.useModel ? this.providers?.decider ?? null : rulesDecider), { signal, lowPriority: true }));
  }

  /** Background work in progress (the idle timer waits for it). */
  busy(): boolean { return this.precomposer.busy(); }
  /** Resolves when precompose work is done (tests). */
  idle(): Promise<void> { return this.precomposer.idle(); }

  private async reload(): Promise<void> {
    this.packs = await loadPacks(join(this.host.appData, "packs"));
    this.actions = await loadActions({ userDir: join(this.host.appData, "actions"), packsDir: join(this.host.appData, "packs") });
    this.actions = { actions: this.actions.actions, problems: [...this.actions.problems, ...this.packs.problems] };
  }

  async init(): Promise<void> {
    await this.reload();
    this.providers = await this.host.resolveProviders({});
    this.core = this.host.coreVersion ?? await coreVersion(this.host.version);
  }

  private deps(decider: ActionDeps["decider"], candidates?: ActionDeps["candidates"]): ActionDeps {
    const privacy = this.privacy;
    return { decider, generator: this.providers?.generator ?? null, render: this.render(), candidates, catalog: this.packs.catalog,
      outputText: (text) => applyOutputRules(text, privacy), ...(this.host.renderTemplate ? { renderTemplate: this.host.renderTemplate } : {}) };
  }

  /** The precompose cache key of a render request, or null when it cannot be precomposed. */
  private keyOf(spec: ActionSpec, input: { text: string; aspect?: string; templatePreferences?: Readonly<Record<string, string>>; disabledTemplates?: readonly string[]; templateFont?: string; templateSignature?: string }): string | null {
    const parts = renderKeyParts(spec, input);
    if (!parts) return null;
    return precomposeKey({ ...parts, core: this.core, privacy: this.privacy.fingerprint, precompose: this.precompose,
      decider: this.precompose.useModel ? this.providers?.names.decider ?? "none" : "rules", packs: this.packs.packs.map((p) => `${p.id}@${p.version}`).join(",") });
  }

  private skipReason(text: string): "off" | "secret" | "too-long" | "empty" | null {
    if (!this.precompose.outputs.length || !this.render()) return "off";
    if (!text.trim()) return "empty";
    if (visibleChars(text) > this.precompose.maxChars) return "too-long";
    if (this.precompose.skipSecrets && containsSecret(text, this.privacy)) return "secret";
    return null;
  }

  private async runRender(spec: ActionSpec, input: Extract<Request, { cmd: "run-action" }>["input"], candidates?: ActionDeps["candidates"]): Promise<ActionResult> {
    const started = performance.now();
    const key = !input.template && !input.fresh && input.text?.trim() ? this.keyOf(spec, input) : null;
    if (key) {
      const hit = await this.precomposer.claim(key);
      if (hit && hit.output !== "text") return { ...hit, ms: Math.round(performance.now() - started), meta: { ...(hit.meta ?? {}), precomposed: true } };
    }
    const release = await this.precomposer.hold(input.text ?? "");
    try { return await runAction(spec, input, this.deps(this.providers?.decider ?? null, candidates)); }
    finally { release(); }
  }

  private render(): Omit<RenderOptions, "out"> | null {
    if (!this.host.engine) return null;
    return { engine: this.host.engine, work: join(this.host.appData, "work"), emojiCache: join(this.host.appData, "emoji"), emojiBundle: this.host.emojiBundle, outDir: join(this.host.appData, "cards") };
  }

  private spec(id: string): ActionSpec {
    const s = this.actions.actions.find((a) => a.id === id);
    if (!s) throw new ActionError("spec", `no action ${id}`);
    return s;
  }

  async handle(req: Request, emit?: (event: TaskEvent) => void): Promise<Response> {
    // Existing clients receive no additional output unless they opt in.
    const notify = (state: TaskEvent["state"]) => {
      if ((req.cmd === "run-action" || req.cmd === "render") && req.events === true) {
        emit?.({ id: req.id, event: "task", cmd: req.cmd, state });
      }
    };
    notify("accepted");
    notify("running");
    const response = await this.execute(req);
    notify(response.ok ? "completed" : "failed");
    return response;
  }

  private async execute(req: Request): Promise<Response> {
    const id = req.id;
    try {
      switch (req.cmd) {
        case "health":
          return { id, ok: true, cmd: "health", version: this.host.version, engine: this.host.engine, providers: this.providers?.names ?? { decider: "none", generator: "none", offline: false }, uptimeMs: Date.now() - this.started, packs: this.packs.packs };
        case "config.set": {
          // Validate everything before anything changes.
          const privacy = compilePrivacy(parsePrivacyConfig(req.privacy));
          const precompose = parsePrecomposeConfig(req.precompose);
          const resolved = await this.host.resolveProviders(req);
          // Network deciders see only what the privacy mode allows; local ones the original text.
          this.providers = { ...resolved, decider: deciderForModel(resolved.decider, resolved.names.decider, privacy) };
          if (privacy.fingerprint !== this.privacy.fingerprint || JSON.stringify(precompose) !== JSON.stringify(this.precompose)) this.precomposer.cancelAll();
          this.privacy = privacy;
          this.precompose = precompose;
          return { id, ok: true, cmd: "config.set", providers: this.providers.names };
        }
        case "privacy.rules":
          return { id, ok: true, cmd: "privacy.rules", builtins: describeBuiltins(this.privacy.config) };
        case "privacy.preview": {
          if (typeof req.text !== "string") throw new PrivacyConfigError("privacy.preview needs {text}");
          return { id, ok: true, cmd: "privacy.preview", ...previewPrivacy(req.text, this.privacy) };
        }
        case "precompose": {
          if (typeof req.text !== "string") throw new PrecomposeConfigError("precompose needs {text, frames}");
          const frames = req.frames ?? {};
          if (typeof frames !== "object" || Array.isArray(frames)) throw new PrecomposeConfigError("precompose.frames must be an object");
          for (const output of PRECOMPOSE_OUTPUTS) {
            const f = (frames as Record<string, unknown>)[output];
            if (f !== undefined && (typeof f !== "string" || !templateAspect(f, output))) throw new PrecomposeConfigError(`precompose.frames.${output}: use auto, 1:1, 4:5, 16:9 or 9:16`);
          }
          const skipped = this.skipReason(req.text);
          if (skipped) return { id, ok: true, cmd: "precompose", queued: false, skipped };
          const tasks: PrecomposeTask[] = [];
          for (const output of this.precompose.outputs) {
            if (output === "video") { try { resolveFFmpeg({ executable: this.render()?.ffmpeg }); } catch { continue; } }
            const spec = PRECOMPOSE_SPECS[output];
            const input = { text: req.text, ...(frames[output] ? { aspect: frames[output] } : {}), ...(req.templatePreferences ? { templatePreferences: req.templatePreferences } : {}), ...(req.disabledTemplates ? { disabledTemplates: req.disabledTemplates } : {}), ...(typeof req.templateFont === "string" ? { templateFont: req.templateFont } : {}), ...(typeof req.templateSignature === "string" ? { templateSignature: req.templateSignature } : {}) };
            tasks.push({ key: this.keyOf(spec, input)!, text: req.text, spec, input });
          }
          this.precomposer.submit(tasks);
          return { id, ok: true, cmd: "precompose", queued: true };
        }
        case "pick": {
          const result = await pick(req.context, req.candidates, this.providers?.decider as never);
          return { id, ok: true, cmd: "pick", result };
        }
        case "actions.list":
          return { id, ok: true, cmd: "actions.list", actions: this.actions.actions, problems: this.actions.problems };
        case "templates.list":
          return { id, ok: true, cmd: "templates.list", templates: TEMPLATE_REGISTRY };
        case "actions.reload":
          await this.reload();
          this.precomposer.cancelAll();
          this.precomposer.clear();
          return { id, ok: true, cmd: "actions.reload", actions: this.actions.actions, problems: this.actions.problems };
        case "run-action": {
          const spec = this.spec(req.action);
          const candidates = req.candidates ? () => req.candidates! : undefined;
          const r = spec.needs === "render" ? await this.runRender(spec, req.input, candidates) : await runAction(spec, req.input, this.deps(this.providers?.decider ?? null, candidates));
          const { pick: p, ...result } = r as typeof r & { pick?: unknown };
          return { id, ok: true, cmd: "run-action", result, ...(p ? { pick: p as never } : {}) };
        }
        case "render": {
          const render = this.render();
          if (!render) throw new EngineError("rendering is not available in this install");
          const release = await this.precomposer.hold("");
          let r;
          try { r = await renderCard(parseDsl(req.dsl), { ...render, out: req.out, catalog: this.packs.catalog }); }
          finally { release(); }
          return { id, ok: true, cmd: "render", path: r.path, format: r.format, frames: r.frames, ms: r.ms };
        }
        case "shutdown":
          this.precomposer.cancelAll();
          return { id, ok: true, cmd: "shutdown" };
        default:
          return { id, ok: false, kind: "usage", message: `unknown cmd ${(req as { cmd?: string }).cmd}` };
      }
    } catch (e) {
      return { id, ok: false, cmd: req.cmd, ...errorOf(e) };
    }
  }
}

export function errorOf(e: unknown): { kind: string; message: string; code?: string; characters?: string[] } {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof ProviderError) return { kind: `provider:${e.code}`, message };
  if (e instanceof ActionError) return { kind: `action:${e.kind}`, message };
  if (e instanceof ComposeError) return { kind: "compose", code: e.code, message, ...(e.characters ? { characters: [...e.characters] } : {}) };
  if (e instanceof EngineError) return { kind: "engine", message };
  if (e instanceof PrivacyConfigError || e instanceof PrecomposeConfigError) return { kind: "usage", message };
  if (e instanceof Error && e.constructor.name === "DslError") return { kind: "usage", message };
  return { kind: "error", message };
}

const COMMANDS: readonly Request["cmd"][] = ["health", "config.set", "pick", "actions.list", "actions.reload", "templates.list", "run-action", "render", "privacy.rules", "privacy.preview", "precompose", "shutdown"];

/** Parse one request line. A malformed line gets an error response carrying
 * the request's id when one is readable, otherwise id -1. */
export function parseRequest(line: string): Request | Response {
  let r: Partial<Request> | null;
  try { r = JSON.parse(line) as Partial<Request> | null; }
  catch (e) { return { id: -1, ok: false, kind: "usage", message: `not JSON: ${(e as Error).message}` }; }
  if (typeof r !== "object" || r === null || Array.isArray(r)) return { id: -1, ok: false, kind: "usage", message: "a request is {id: number, cmd: string, …}" };
  const id = typeof r.id === "number" && Number.isFinite(r.id) ? r.id : -1;
  if (id === -1 || typeof r.cmd !== "string") return { id, ok: false, kind: "usage", message: "a request is {id: number, cmd: string, …}" };
  if (!COMMANDS.includes(r.cmd)) return { id, ok: false, cmd: r.cmd, kind: "usage", message: `unknown cmd ${r.cmd}` };
  return r as Request;
}
