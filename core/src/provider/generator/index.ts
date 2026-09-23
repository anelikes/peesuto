/**
 * Generator configuration: four kinds, each a base URL and/or a credential.
 */
import { ProviderConfigError } from "../types.ts";
import { anthropicGenerator } from "./anthropic.ts";
import { hostedGenerator } from "./hosted.ts";
import { noneGenerator } from "./none.ts";
import { isReasoningEffort, openaiCompatibleGenerator, REASONING_EFFORTS, type ReasoningEffort } from "./openai.ts";
import type { Generator } from "./types.ts";

export type GeneratorConfig =
  | { readonly kind: "openai-compatible"; readonly baseUrl: string; readonly model: string; readonly apiKey?: string; readonly reasoning?: ReasoningEffort; readonly timeoutMs?: number }
  | { readonly kind: "anthropic"; readonly apiKey: string; readonly model?: string }
  | { readonly kind: "hosted"; readonly token: string; readonly url?: string }
  | { readonly kind: "none" };

export const GENERATOR_KINDS = ["none", "openai-compatible", "anthropic", "openrouter", "vercel", "hosted"] as const;
/** Gateways whose chat API is OpenAI-compatible; stored as their own kinds so one key serves Jev and text. */
export const GATEWAY_BASE_URLS = { openrouter: "https://openrouter.ai/api/v1", vercel: "https://ai-gateway.vercel.sh/v1" } as const;
export type GatewayKind = keyof typeof GATEWAY_BASE_URLS;
/** Ollama's OpenAI-compatible endpoint, the local default. */
export const DEFAULT_OLLAMA_URL = "http://localhost:11434/v1";

export function createGenerator(cfg: GeneratorConfig): Generator {
  switch (cfg.kind) {
    case "none": return noneGenerator;
    case "openai-compatible": return openaiCompatibleGenerator({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey, reasoning: cfg.reasoning, timeoutMs: cfg.timeoutMs });
    case "anthropic": return anthropicGenerator({ apiKey: cfg.apiKey, model: cfg.model });
    case "hosted": return hostedGenerator(cfg.token, cfg.url);
  }
}

/**
 * Generator from the environment:
 *   PASTE_GENERATOR=none|openai-compatible|anthropic|openrouter|vercel|hosted (default none)
 *   openai-compatible: PASTE_GEN_BASE_URL (default Ollama), PASTE_GEN_MODEL, PASTE_GEN_API_KEY,
 *                      PASTE_GEN_REASONING=none|low|medium|high (default: learn, see openai.ts),
 *                      PASTE_GEN_TIMEOUT_MS
 *   anthropic:         PASTE_GEN_API_KEY, PASTE_GEN_MODEL (default claude-sonnet-5)
 *   openrouter, vercel: PASTE_GEN_MODEL, and PASTE_GEN_API_KEY or OPENROUTER_API_KEY / AI_GATEWAY_API_KEY
 *   hosted:            PASTE_TOKEN, PASTE_HOSTED_URL (a base URL)
 */
export function generatorFromEnv(env: Record<string, string | undefined> = process.env): GeneratorConfig {
  const kind = env.PASTE_GENERATOR ?? "none";
  switch (kind) {
    case "none": return { kind };
    case "openai-compatible": {
      if (!env.PASTE_GEN_MODEL) throw new ProviderConfigError(`openai-compatible needs PASTE_GEN_MODEL (PASTE_GEN_BASE_URL defaults to ${DEFAULT_OLLAMA_URL})`);
      const reasoning = env.PASTE_GEN_REASONING;
      if (reasoning !== undefined && !isReasoningEffort(reasoning)) throw new ProviderConfigError(`PASTE_GEN_REASONING must be one of ${REASONING_EFFORTS.join(", ")}, got ${reasoning}`);
      const timeoutMs = env.PASTE_GEN_TIMEOUT_MS === undefined ? undefined : Number(env.PASTE_GEN_TIMEOUT_MS);
      if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) throw new ProviderConfigError(`PASTE_GEN_TIMEOUT_MS must be a positive whole number of milliseconds, got ${env.PASTE_GEN_TIMEOUT_MS}`);
      return {
        kind, baseUrl: env.PASTE_GEN_BASE_URL ?? DEFAULT_OLLAMA_URL, model: env.PASTE_GEN_MODEL,
        ...(env.PASTE_GEN_API_KEY ? { apiKey: env.PASTE_GEN_API_KEY } : {}),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      };
    }
    case "anthropic": {
      if (!env.PASTE_GEN_API_KEY) throw new ProviderConfigError("anthropic needs PASTE_GEN_API_KEY");
      return { kind, apiKey: env.PASTE_GEN_API_KEY, ...(env.PASTE_GEN_MODEL ? { model: env.PASTE_GEN_MODEL } : {}) };
    }
    case "openrouter":
    case "vercel": {
      const apiKey = env.PASTE_GEN_API_KEY ?? env[kind === "openrouter" ? "OPENROUTER_API_KEY" : "AI_GATEWAY_API_KEY"];
      if (!env.PASTE_GEN_MODEL || !apiKey) throw new ProviderConfigError(`${kind} needs PASTE_GEN_MODEL and an API key`);
      return { kind: "openai-compatible", baseUrl: GATEWAY_BASE_URLS[kind], model: env.PASTE_GEN_MODEL, apiKey };
    }
    case "hosted": {
      if (!env.PASTE_TOKEN) throw new ProviderConfigError("hosted needs PASTE_TOKEN");
      return { kind, token: env.PASTE_TOKEN, ...(env.PASTE_HOSTED_URL ? { url: env.PASTE_HOSTED_URL } : {}) };
    }
    default: throw new ProviderConfigError(`PASTE_GENERATOR must be one of ${GENERATOR_KINDS.join(", ")}, got ${kind}`);
  }
}
