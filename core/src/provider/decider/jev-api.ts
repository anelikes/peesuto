/**
 * Jev over its public HTTP APIs, with your own key. Three services speak
 * TypeSafe's System One shape — `POST {model, state, questions}` with a
 * bearer key, `{answers}` back — and differ only in URL and model ID
 * (checked against each service's docs, 2026-09-24):
 *
 *   typesafe    TypeSafe's own API, key from console.typesafe.ai
 *   vercel      Vercel AI Gateway's TypeSafe-compatible API, an AI Gateway key
 *   openrouter  OpenRouter's Decisions endpoint (alpha), an OpenRouter key
 *
 * Output tokens are free on all three; input is billed to the key's account.
 */
import { egress } from "../egress.ts";
import { ProviderError } from "../types.ts";
import { answersOf, type Decider } from "./types.ts";

export const JEV_SERVICES = {
  typesafe: { label: "TypeSafe", url: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", keyUrl: "https://console.typesafe.ai" },
  vercel: { label: "Vercel AI Gateway", url: "https://ai-gateway.vercel.sh/typesafe/v1/systemone", model: "typesafe-ai/jev", keyUrl: "https://vercel.com/ai-gateway" },
  openrouter: { label: "OpenRouter", url: "https://openrouter.ai/api/alpha/decisions", model: "~typesafe/jev-latest", keyUrl: "https://openrouter.ai/keys" },
} as const;

export type JevService = keyof typeof JEV_SERVICES;
export const JEV_SERVICE_KINDS = Object.keys(JEV_SERVICES) as JevService[];
export const isJevService = (kind: string): kind is JevService => Object.hasOwn(JEV_SERVICES, kind);

/** The service's message from TypeSafe's `{message}`, OpenRouter's `{error: {message}}` or plain text. */
function messageOf(json: unknown): string {
  const o = json as { message?: unknown; error?: unknown } | null;
  const e = o?.error as { message?: unknown } | string | undefined;
  const m = o?.message ?? (typeof e === "string" ? e : e?.message);
  return typeof m === "string" ? m : (JSON.stringify(json) ?? "").slice(0, 200);
}

export function jevApiDecider(service: JevService, token: string, model?: string): Decider {
  const { url, model: defaultModel } = JEV_SERVICES[service];
  const name = service;
  return {
    name,
    async ask(body) {
      const { status, json } = await egress.post(url, { model: model ?? defaultModel, ...body }, { headers: { authorization: `Bearer ${token}` }, purpose: `decider:${name}` });
      if (status >= 400) {
        const why = `HTTP ${status}: ${messageOf(json)}`;
        if (status === 401 || status === 403) throw new ProviderError("auth", `${name}: key rejected (${why})`);
        if (status === 402 || status === 429) throw new ProviderError("quota", `${name}: out of credit or rate limited (${why})`);
        if (status === 404) throw new ProviderError("model", `${name}: model ${model ?? defaultModel} is not available (${why})`);
        if (status >= 500) throw new ProviderError("model", `${name}: ${why}`);
        throw new ProviderError("bad-response", `${name}: ${why}`);
      }
      return answersOf(json, name);
    },
  };
}
