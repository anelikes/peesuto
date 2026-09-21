/**
 * The daemon protocol: JSON lines over stdin/stdout between the shell and
 * a long-lived Core. One request per line, one response per line, matched
 * by `id`. Requests are handled one at a time, in order.
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

export type Request =
  | { id: number; cmd: "health" }
  | { id: number; cmd: "config.set"; decider?: unknown; generator?: unknown; offline?: boolean; secrets?: Record<string, string>; egressLog?: string }
  | { id: number; cmd: "pick"; context: Context; candidates: ClipItem[]; fresh?: boolean }
  | { id: number; cmd: "actions.list" }
  | { id: number; cmd: "actions.reload" }
  | { id: number; cmd: "run-action"; action: string; input: ActionInput; candidates?: ClipItem[] }
  | { id: number; cmd: "render"; dsl: Dsl; out?: string }
  | { id: number; cmd: "shutdown" };

export type Response =
  | { id: number; ok: true; cmd: "health"; version: string; engine: string | null; providers: { decider: string; generator: string; offline: boolean }; uptimeMs: number; packs: { id: string; name: string; version: string; kind: "actions" | "styles" }[] }
  | { id: number; ok: true; cmd: "config.set"; providers: { decider: string; generator: string; offline: boolean } }
  | { id: number; ok: true; cmd: "pick"; result: PickResult }
  | { id: number; ok: true; cmd: "actions.list" | "actions.reload"; actions: ActionSpec[]; problems: { file: string; message: string }[] }
  | { id: number; ok: true; cmd: "run-action"; result: ActionResult; pick?: PickResult }
  | { id: number; ok: true; cmd: "render"; path: string; format: string; frames: number; ms: Record<string, number> }
  | { id: number; ok: true; cmd: "shutdown" }
  | { id: number; ok: false; cmd?: string; kind: string; message: string };

/** `kind` values a shell can map to messages; the same as the CLI's. */
export const ERROR_KINDS = ["usage", "input", "provider:config", "provider:auth", "provider:network", "provider:timeout", "provider:model", "provider:bad-response", "provider:quota", "provider:offline", "provider:unavailable", "action:spec", "action:needs", "action:input", "action:run", "compose", "engine", "error"] as const;
