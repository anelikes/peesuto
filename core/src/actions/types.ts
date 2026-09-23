/**
 * An action: one thing pocket-paste can do with a piece of text on the way
 * from the clipboard into an input. Declared as JSON so users can write
 * their own and packs can ship them; the built-ins use the same shape.
 */
import type { Aspect } from "../dsl.ts";
import type { ClipItem, Context } from "../pick/types.ts";
import type { TemplateOverride } from "../templates/types.ts";

export type ActionNeeds = "decider" | "generator" | "render" | "none";
export type ActionOutput = "text" | "image" | "gif" | "video" | "file";

export interface ActionSpec {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly trigger?: { readonly hotkey?: string; readonly menu?: boolean };
  /** What the action works on. `clipboard` is the current text; `item` is a history item handed in. */
  readonly input: "clipboard" | "item";
  readonly needs: ActionNeeds;
  /** Generator actions: the prompt, with `{{input}}`, `{{context}}`, `{{app}}` placeholders. */
  readonly prompt?: string;
  readonly system?: string;
  readonly maxTokens?: number;
  readonly output: ActionOutput;
  /** Render actions. */
  readonly render?: { readonly aspect?: Aspect; readonly animate?: "auto" | "always" | "never" };
  /** Set on shipped actions; user files cannot claim it. */
  readonly builtin?: boolean;
  /** The pack an action came from, when it did. */
  readonly pack?: string;
}

export interface ActionInput {
  readonly text: string;
  readonly item?: ClipItem;
  readonly context?: Context;
  /** Overrides for render actions from the UI (aspect toggle, another take). */
  readonly aspect?: Aspect;
  readonly fresh?: boolean;
  /** Explicit presentation overrides; content is always parsed from text. */
  readonly template?: TemplateOverride;
  /** Per-template styles explicitly chosen by the user, never model guesses. */
  readonly templatePreferences?: Readonly<Record<string, string>>;
}

export type ActionResult =
  | { readonly output: "text"; readonly text: string; readonly model?: string; readonly ms: number }
  | { readonly output: "image" | "gif" | "video" | "file"; readonly path: string; readonly format: string; readonly ms: number; readonly meta?: Record<string, unknown> };

export class ActionError extends Error {
  constructor(readonly kind: "spec" | "needs" | "input" | "run", message: string) { super(message); }
}
