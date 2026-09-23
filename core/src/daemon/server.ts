/**
 * The long-lived Core: reads JSON-line requests, answers JSON lines. Kept
 * free of process concerns (stdin, exit) so tests can drive it with strings.
 */
import { join } from "node:path";
import { loadActions, runAction, ActionError, type ActionDeps, type ActionSpec, type LoadedActions } from "../actions/index.ts";
import { parseDsl } from "../dsl.ts";
import { EngineError } from "../engine.ts";
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
}

export class Daemon {
  private providers: Awaited<ReturnType<DaemonHost["resolveProviders"]>> | null = null;
  private actions: LoadedActions = { actions: [], problems: [] };
  private packs: LoadedPacks = { catalog: BASE_CATALOG, packs: [], problems: [] };
  private readonly started = Date.now();
  constructor(private readonly host: DaemonHost) {}

  private async reload(): Promise<void> {
    this.packs = await loadPacks(join(this.host.appData, "packs"));
    this.actions = await loadActions({ userDir: join(this.host.appData, "actions"), packsDir: join(this.host.appData, "packs") });
    this.actions = { actions: this.actions.actions, problems: [...this.actions.problems, ...this.packs.problems] };
  }

  async init(): Promise<void> {
    await this.reload();
    this.providers = await this.host.resolveProviders({});
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
        case "config.set":
          this.providers = await this.host.resolveProviders(req);
          return { id, ok: true, cmd: "config.set", providers: this.providers.names };
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
          return { id, ok: true, cmd: "actions.reload", actions: this.actions.actions, problems: this.actions.problems };
        case "run-action": {
          const deps: ActionDeps = { decider: this.providers?.decider ?? null, generator: this.providers?.generator ?? null, render: this.render(), candidates: req.candidates ? () => req.candidates! : undefined, catalog: this.packs.catalog };
          const r = await runAction(this.spec(req.action), req.input, deps);
          const { pick: p, ...result } = r as typeof r & { pick?: unknown };
          return { id, ok: true, cmd: "run-action", result, ...(p ? { pick: p as never } : {}) };
        }
        case "render": {
          const render = this.render();
          if (!render) throw new EngineError("rendering is not available in this install");
          const r = await renderCard(parseDsl(req.dsl), { ...render, out: req.out, catalog: this.packs.catalog });
          return { id, ok: true, cmd: "render", path: r.path, format: r.format, frames: r.frames, ms: r.ms };
        }
        case "shutdown":
          return { id, ok: true, cmd: "shutdown" };
        default:
          return { id, ok: false, kind: "usage", message: `unknown cmd ${(req as { cmd?: string }).cmd}` };
      }
    } catch (e) {
      return { id, ok: false, cmd: req.cmd, ...errorOf(e) };
    }
  }
}

export function errorOf(e: unknown): { kind: string; message: string } {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof ProviderError) return { kind: `provider:${e.code}`, message };
  if (e instanceof ActionError) return { kind: `action:${e.kind}`, message };
  if (e instanceof ComposeError) return { kind: "compose", message };
  if (e instanceof EngineError) return { kind: "engine", message };
  if (e instanceof Error && e.constructor.name === "DslError") return { kind: "usage", message };
  return { kind: "error", message };
}

const COMMANDS: readonly Request["cmd"][] = ["health", "config.set", "pick", "actions.list", "actions.reload", "templates.list", "run-action", "render", "shutdown"];

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
