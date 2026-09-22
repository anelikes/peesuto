/**
 * Smart pick: what the shell hands Core when the paste hotkey fires, and what
 * comes back. Plain data — these are the shapes that cross the JSON-line
 * protocol (`pick`), so nothing here has methods.
 */
import type { JevRequest } from "../questions.ts";

export type ClipKind = "text" | "image" | "file" | "rtf" | "html";

/** One entry of the clipboard history, as the shell stores it. */
export interface ClipItem {
  readonly id: string;
  readonly kind: ClipKind;
  /** Full text for text-like kinds; absent for images and files. */
  readonly text?: string;
  /** What the history panel shows: a first line, a file name or path, an image caption. */
  readonly preview: string;
  /** Bundle id of the app the item was copied from, when the shell knew it. */
  readonly appBundleId?: string;
  /** ms since the epoch. */
  readonly createdAt: number;
  readonly pinned?: boolean;
  readonly bytes?: number;
  /** Set by the shell's exclusion rules (concealed type, blacklisted app); pick never offers such an item. */
  readonly excluded?: boolean;
}

export type ContextLevel = 0 | 1 | 2;

/** The focused input as the shell's AX collection saw it, graded by how much it could read. */
export interface Context {
  /** 0: only the app. 1: + role and label of the focused element. 2: + text around the caret. */
  readonly level: ContextLevel;
  readonly appBundleId: string;
  readonly appName?: string;
  readonly windowTitle?: string;
  /** AX role of the focused element: AXTextField, AXTextArea, AXWebArea, AXCell… (L1+). */
  readonly role?: string;
  /** AX title, description or placeholder of the focused element (L1+). */
  readonly label?: string;
  /** Text before / after the caret, each at most CONTEXT_CHARS (L2). */
  readonly before?: string;
  readonly after?: string;
  /** A secure field (AXSecureTextField or the like): nothing is collected and nothing may be picked. */
  readonly secure?: boolean;
}

/** The most caret context a request carries on each side. */
export const CONTEXT_CHARS = 200;

export interface RankedItem {
  readonly item: ClipItem;
  readonly score: number;
  /** Why it scored so, for the confirm bar's tooltip and the probe table. */
  readonly reason: string;
}

export interface PickResult {
  /** Best first. Every non-excluded candidate is here, asked or not. */
  readonly ranked: readonly RankedItem[];
  /** 0..1: how much this looks like a place where a paste makes sense right now. */
  readonly shouldPaste: number;
  readonly source: "decider" | "heuristic";
  /** The request the decider was (or would have been) asked, for logging and caching. */
  readonly question?: PickRequest;
}

/** `state` of a pick request: what Jev sees. Redacted per level by buildPickRequest. */
export interface PickState {
  readonly app: string;
  readonly role?: string;
  readonly label?: string;
  readonly before?: string;
  readonly after?: string;
  readonly candidates: readonly { readonly i: number; readonly summary: string }[];
}

/**
 * A pick request has Jev's `{state, questions}` shape with a pick state where
 * a card request has `{clipboard}`. `JevRequest` in questions.ts still types
 * its state as `{clipboard}`; index.ts casts at the one place a body reaches
 * a Provider.
 */
export interface PickRequest {
  readonly state: PickState;
  readonly questions: Record<string, unknown>;
}

/** Answers to a pick request, in the loose shape every provider returns. */
export type PickAnswers = Record<string, { choice?: string; probabilities?: Record<string, number>; score?: number; noul?: number }>;

/**
 * What pick needs of a decider: the `Decider` (alias `Provider`) of
 * core/src/provider satisfies this structurally, so does a test stub. The
 * answers come back untyped and are read defensively.
 */
export interface PickDecider {
  readonly name: string;
  ask(body: JevRequest): Promise<unknown>;
  /** This decider's share of the blend (0..1); unset means DECIDER_WEIGHT. */
  readonly pickWeight?: number;
}

/** A pick that must not happen (a secure field). Never thrown for a decider failure. */
export class PickError extends Error {}
