/**
 * The generator track: a prompt in, text out. Every LLM behind an action
 * (translate, summarise, a user's own prompt) is one of these.
 */
import { ProviderError } from "../types.ts";

export interface GenerateRequest {
  readonly system?: string;
  readonly prompt: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface GenerateResult {
  readonly text: string;
  /** The model that answered, as the server names it. */
  readonly model: string;
  readonly usage?: { readonly in: number; readonly out: number };
}

export interface Generator {
  readonly name: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

/** Enough for a translation or a summary of a card-sized clipboard. */
export const DEFAULT_MAX_TOKENS = 2048;
/** Generation takes seconds, a local model on a laptop tens of them. */
export const DEFAULT_GENERATE_TIMEOUT_MS = 60_000;

/** The message an error body carries, whatever its shape, or "". */
export function errorDetail(json: unknown): string {
  const r = json as { error?: { message?: unknown } | string; message?: unknown } | null;
  const e = r?.error;
  const m = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : typeof r?.message === "string" ? r.message : "";
  return m.slice(0, 300);
}

/** HTTP status → ProviderError, the same for every chat-completion-shaped API. */
export function httpError(name: string, status: number, detail: string): ProviderError {
  const tail = detail ? `: ${detail}` : "";
  if (status === 401 || status === 403) return new ProviderError("auth", `${name}: credential rejected (HTTP ${status}${tail})`);
  if (status === 402 || status === 429) return new ProviderError("quota", `${name}: quota or rate limit (HTTP ${status}${tail})`);
  if (status === 404) return new ProviderError("model", `${name}: not found (HTTP 404${tail})`);
  if (status >= 500) return new ProviderError("model", `${name}: HTTP ${status}${tail}`);
  return new ProviderError("bad-response", `${name}: HTTP ${status}${tail}`);
}

export function usageOf(inTokens: unknown, outTokens: unknown): GenerateResult["usage"] {
  return typeof inTokens === "number" && typeof outTokens === "number" ? { in: inTokens, out: outTokens } : undefined;
}
