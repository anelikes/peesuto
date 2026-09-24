/**
 * Precompose: render every copied text in the background so the paste
 * shortcut returns at once. The shell sends `precompose` after a text lands in
 * history; the daemon renders it for each configured output, one task at a
 * time, at low priority, and keeps the results in memory (the files live in
 * the normal output directory, so the usual pruning applies).
 *
 * Latest only: a new text replaces queued work and cancels the running task
 * (killing the engine's process group). A foreground render (`run-action`)
 * returns a cached result when there is one, waits for a running task with
 * the same key, and otherwise pauses the worker, cancelling what runs, for as
 * long as it renders: both use the same engine work tree.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActionInput, ActionResult, ActionSpec } from "../actions/types.ts";
import { REPO_ROOT } from "../engine.ts";
import { canonicalJson } from "../provider/cache.ts";
import { DEFAULT_ASPECT, templateAspect, templateSignature } from "../templates/types.ts";
import { templateIdList } from "../templates/parse.ts";

export const PRECOMPOSE_OUTPUTS = ["image", "gif", "video"] as const;
export type PrecomposeOutput = (typeof PRECOMPOSE_OUTPUTS)[number];

export interface PrecomposeConfig {
  readonly outputs: readonly PrecomposeOutput[];
  readonly useModel: boolean;
  readonly skipSecrets: boolean;
  readonly maxChars: number;
}

export const DEFAULT_PRECOMPOSE: PrecomposeConfig = { outputs: [], useModel: false, skipSecrets: true, maxChars: 1200 };

/** Precomposed results kept in memory. */
export const PRECOMPOSE_CACHE_SIZE = 20;

export type SkipReason = "off" | "secret" | "too-long" | "empty";

export class PrecomposeConfigError extends Error {}

export function parsePrecomposeConfig(raw: unknown): PrecomposeConfig {
  if (raw === undefined || raw === null) return DEFAULT_PRECOMPOSE;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new PrecomposeConfigError("precompose must be an object");
  const o = raw as Record<string, unknown>;
  const outputs = o.outputs ?? [];
  if (!Array.isArray(outputs) || outputs.some((x) => !(PRECOMPOSE_OUTPUTS as readonly unknown[]).includes(x))) throw new PrecomposeConfigError(`precompose.outputs must be a list of ${PRECOMPOSE_OUTPUTS.join(", ")}`);
  for (const k of ["useModel", "skipSecrets"] as const) if (o[k] !== undefined && typeof o[k] !== "boolean") throw new PrecomposeConfigError(`precompose.${k} must be true or false`);
  const maxChars = o.maxChars ?? DEFAULT_PRECOMPOSE.maxChars;
  if (typeof maxChars !== "number" || !Number.isInteger(maxChars) || maxChars <= 0) throw new PrecomposeConfigError("precompose.maxChars must be a positive whole number");
  return {
    outputs: PRECOMPOSE_OUTPUTS.filter((x) => outputs.includes(x)),
    useModel: (o.useModel as boolean | undefined) ?? DEFAULT_PRECOMPOSE.useModel,
    skipSecrets: (o.skipSecrets as boolean | undefined) ?? DEFAULT_PRECOMPOSE.skipSecrets,
    maxChars,
  };
}

/** Grapheme clusters that are not whitespace. */
export function visibleChars(text: string): number {
  let n = 0;
  for (const g of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) if (!/^\s+$/u.test(g.segment)) n++;
  return n;
}

/** The frame a render of `output` uses: the aspect normalized as decideTemplate does. */
export function normalizedFrame(output: PrecomposeOutput, aspect: string | undefined): string {
  if (aspect === undefined) return DEFAULT_ASPECT[output];
  return templateAspect(aspect, output) ?? `invalid:${aspect}`;
}

export interface KeyParts {
  readonly core: string;
  readonly text: string;
  readonly output: PrecomposeOutput;
  readonly frame: string;
  readonly animate: string;
  readonly preferences: Readonly<Record<string, string>>;
  readonly disabled: readonly string[];
  readonly font: string;
  /** The card signature as templateSignature() normalizes it; "" when none. */
  readonly signature: string;
  readonly privacy: string;
  readonly precompose: PrecomposeConfig;
  /** The decider precompose used: "rules", or the configured one when useModel. */
  readonly decider: string;
  readonly packs: string;
}

export function precomposeKey(p: KeyParts): string {
  return new Bun.CryptoHasher("sha256").update(canonicalJson(p)).digest("hex");
}

/** The key parts of a render request, from the action spec and its input. */
export function renderKeyParts(spec: ActionSpec, input: ActionInput): Pick<KeyParts, "text" | "output" | "frame" | "animate" | "preferences" | "disabled" | "font" | "signature"> | null {
  if (spec.needs !== "render" || !(PRECOMPOSE_OUTPUTS as readonly string[]).includes(spec.output)) return null;
  const output = spec.output as PrecomposeOutput;
  return { text: input.text, output, frame: normalizedFrame(output, input.aspect ?? spec.render?.aspect), animate: spec.render?.animate ?? "auto", preferences: { ...(input.templatePreferences ?? {}) }, disabled: templateIdList(input.disabledTemplates), font: typeof input.templateFont === "string" ? input.templateFont : "", signature: templateSignature(input.templateSignature) ?? "" };
}

/** A version of the code that renders: the bundle's VERSION, else a hash of core/src, else the daemon version. */
export async function coreVersion(fallback: string): Promise<string> {
  const root = join(REPO_ROOT, "core/src");
  if (!existsSync(root)) return fallback;
  try {
    const hasher = new Bun.CryptoHasher("sha256");
    const walk = async (dir: string, rel: string): Promise<void> => {
      for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.isDirectory()) await walk(join(dir, e.name), `${rel}${e.name}/`);
        else if (e.isFile()) hasher.update(`${rel}${e.name}\0`).update(await readFile(join(dir, e.name))).update("\0");
      }
    };
    await walk(root, "");
    return `${fallback}+${hasher.digest("hex").slice(0, 12)}`;
  } catch { return fallback; }
}

export interface PrecomposeTask {
  readonly key: string;
  readonly text: string;
  readonly spec: ActionSpec;
  readonly input: ActionInput;
}

interface Running { readonly task: PrecomposeTask; readonly abort: AbortController; readonly done: Promise<void> }

export type TaskRunner = (task: PrecomposeTask, signal: AbortSignal) => Promise<ActionResult>;

export class Precomposer {
  private queue: PrecomposeTask[] = [];
  private running: Running | null = null;
  private holds = 0;
  private readonly cache = new Map<string, ActionResult>();
  /** Keys rendered so far (tests count renders). */
  readonly rendered: string[] = [];

  constructor(private readonly runTask: TaskRunner, private readonly limit = PRECOMPOSE_CACHE_SIZE) {}

  /** Replace all pending work with `tasks` (one text, one task per output). */
  submit(tasks: readonly PrecomposeTask[]): void {
    const current = this.running?.task.key;
    if (this.running && !tasks.some((t) => t.key === current)) this.running.abort.abort();
    this.queue = tasks.filter((t) => t.key !== current);
    this.pump();
  }

  /** A cached result whose file still exists; a vanished file is a miss. */
  lookup(key: string): ActionResult | null {
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (hit.output !== "text" && !existsSync(hit.path)) { this.cache.delete(key); return null; }
    // Most recently used last.
    this.cache.delete(key); this.cache.set(key, hit);
    return hit;
  }

  /** For a foreground render: a hit, after waiting for a running task with the same key. */
  async claim(key: string): Promise<ActionResult | null> {
    const hit = this.lookup(key);
    if (hit) return hit;
    if (this.running?.task.key === key) {
      await this.running.done;
      return this.lookup(key);
    }
    return null;
  }

  /**
   * Pause the worker for a foreground render of `text`. Work for another text
   * is dropped; work for the same text (another output) resumes afterwards.
   * Resolves once nothing runs; call the returned function when done.
   */
  async hold(text: string): Promise<() => void> {
    this.holds++;
    let released = false;
    const release = () => { if (released) return; released = true; this.holds--; this.pump(); };
    this.queue = this.queue.filter((t) => t.text === text);
    const running = this.running;
    if (running) {
      running.abort.abort();
      if (running.task.text === text && !this.queue.some((t) => t.key === running.task.key)) this.queue.unshift(running.task);
      await running.done;
    }
    return release;
  }

  /** Drop everything pending and stop what runs. */
  cancelAll(): void {
    this.queue = [];
    this.running?.abort.abort();
  }

  clear(): void { this.cache.clear(); }

  busy(): boolean { return this.running !== null || (this.queue.length > 0 && this.holds === 0); }

  /** Resolves when the worker is idle (tests). */
  async idle(): Promise<void> {
    while (this.running || (this.queue.length && this.holds === 0)) await (this.running?.done ?? Bun.sleep(1));
  }

  private pump(): void {
    if (this.running || this.holds > 0) return;
    const task = this.queue.shift();
    if (!task) return;
    const abort = new AbortController();
    const done = (async () => {
      // Yield first: requests already waiting are answered before work starts.
      await Bun.sleep(0);
      if (abort.signal.aborted || this.lookup(task.key)) return;
      const result = await this.runTask(task, abort.signal);
      if (abort.signal.aborted) return;
      this.rendered.push(task.key);
      this.cache.set(task.key, result);
      while (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value!);
    })().catch(() => { /* cancelled or failed: the shortcut renders it in the foreground */ }).finally(() => {
      if (this.running?.done === done) this.running = null;
      this.pump();
    });
    this.running = { task, abort, done };
  }
}
