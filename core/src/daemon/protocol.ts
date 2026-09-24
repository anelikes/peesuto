/**
 * The daemon protocol: JSON lines over stdin/stdout between the shell and
 * a long-lived Core. One request per line, one response per line, matched
 * by `id`. Requests are handled one at a time, in order. Long tasks may opt
 * into lifecycle events with `events: true`; their final response is unchanged.
 *
 *   → {"id":1,"cmd":"health"}
 *   ← {"id":1,"ok":true,"version":"0.1.0","engine":"…","providers":{…}}
 *   → {"id":2,"cmd":"pick","context":{…},"candidates":[…]}
 *   ← {"id":2,"ok":true,"ranked":[…],"shouldPaste":0.8,"source":"decider"}
 *   ← {"id":3,"ok":false,"kind":"provider:auth","message":"…"}
 *
 * Secrets never touch the disk on Core's side: the shell, which owns the
 * Keychain, sends them with `config.set`, and Core keeps them in memory.
 */
import type { ActionInput, ActionResult, ActionSpec } from "../actions/types.ts";
import type { Dsl } from "../dsl.ts";
import type { ClipItem, Context, PickResult } from "../pick/types.ts";
import type { TEMPLATE_REGISTRY } from "../templates/registry.ts";

export type Request =
  | { id: number; cmd: "health" }
  | { id: number; cmd: "config.set"; decider?: unknown; generator?: unknown; offline?: boolean; secrets?: Record<string, string>; egressLog?: string; privacy?: PrivacySettings; precompose?: PrecomposeSettings }
  | { id: number; cmd: "pick"; context: Context; candidates: ClipItem[]; fresh?: boolean }
  | { id: number; cmd: "actions.list" }
  | { id: number; cmd: "actions.reload" }
  | { id: number; cmd: "templates.list" }
  | { id: number; cmd: "run-action"; action: string; input: ActionInput; candidates?: ClipItem[]; events?: boolean }
  | { id: number; cmd: "render"; dsl: Dsl; out?: string; events?: boolean }
  | { id: number; cmd: "privacy.rules" }
  | { id: number; cmd: "privacy.preview"; text: string }
  | { id: number; cmd: "precompose"; text: string; frames?: { image?: string; gif?: string; video?: string }; templatePreferences?: Readonly<Record<string, string>>; disabledTemplates?: readonly string[]; templateFont?: string; templateSignature?: string }
  | { id: number; cmd: "shutdown" };

/** `config.set`'s privacy section; absent means the defaults (mode "redacted", built-in defaults, no rules). */
export interface PrivacySettings {
  readonly modelContent?: "raw" | "redacted" | "structure";
  readonly builtins?: Readonly<Record<string, boolean>>;
  readonly rules?: readonly {
    readonly id: string; readonly name: string;
    readonly match: "text" | "keywords" | "regex";
    readonly pattern: string; readonly replacement: string;
    readonly caseSensitive?: boolean; readonly wholeWord?: boolean; readonly alsoInOutput?: boolean; readonly enabled?: boolean;
  }[];
}

/** `config.set`'s precompose section; absent means off. */
export interface PrecomposeSettings {
  readonly outputs?: readonly ("image" | "gif" | "video")[];
  readonly useModel?: boolean;
  readonly skipSecrets?: boolean;
  readonly maxChars?: number;
}

export type Response =
  | { id: number; ok: true; cmd: "health"; version: string; engine: string | null; providers: { decider: string; generator: string; offline: boolean }; uptimeMs: number; packs: { id: string; name: string; version: string; kind: "actions" | "styles" }[] }
  | { id: number; ok: true; cmd: "config.set"; providers: { decider: string; generator: string; offline: boolean } }
  | { id: number; ok: true; cmd: "pick"; result: PickResult }
  | { id: number; ok: true; cmd: "actions.list" | "actions.reload"; actions: ActionSpec[]; problems: { file: string; message: string }[] }
  | { id: number; ok: true; cmd: "templates.list"; templates: typeof TEMPLATE_REGISTRY }
  | { id: number; ok: true; cmd: "run-action"; result: ActionResult; pick?: PickResult }
  | { id: number; ok: true; cmd: "render"; path: string; format: string; frames: number; ms: Record<string, number> }
  | { id: number; ok: true; cmd: "privacy.rules"; builtins: { id: string; name: string; nameZh: string; description: string; descriptionZh: string; defaultEnabled: boolean; enabled: boolean }[] }
  | { id: number; ok: true; cmd: "privacy.preview"; modelText: string; outputText: string; spans: { start: number; end: number; ruleId: string; replacement: string }[]; containsSecret: boolean }
  | { id: number; ok: true; cmd: "precompose"; queued: true }
  | { id: number; ok: true; cmd: "precompose"; queued: false; skipped: "off" | "secret" | "too-long" | "empty" }
  | { id: number; ok: true; cmd: "shutdown" }
  | { id: number; ok: false; cmd?: string; kind: string; message: string; code?: string; characters?: string[] };

/** Opt-in, content-free task lifecycle. No percentage or render-stage estimate. */
export interface TaskEvent {
  readonly id: number;
  readonly event: "task";
  readonly cmd: "run-action" | "render";
  readonly state: "accepted" | "running" | "completed" | "failed";
}

/** `kind` values a shell can map to messages; the same as the CLI's. */
export const ERROR_KINDS = ["usage", "input", "provider:config", "provider:auth", "provider:network", "provider:timeout", "provider:model", "provider:bad-response", "provider:quota", "provider:offline", "provider:unavailable", "action:spec", "action:needs", "action:input", "action:run", "compose", "engine", "error"] as const;
