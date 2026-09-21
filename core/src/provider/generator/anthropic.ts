/**
 * `anthropic`: your own key against the Messages API. Raw HTTP rather than
 * the SDK, because every byte that leaves the machine goes through
 * `egress.ts` and nothing else may call fetch.
 *
 * `temperature` is deliberately not forwarded: the current models reject
 * sampling parameters with a 400, and an action's prompt is what steers
 * the output.
 */
import { egress } from "../egress.ts";
import { ProviderError } from "../types.ts";
import { DEFAULT_GENERATE_TIMEOUT_MS, DEFAULT_MAX_TOKENS, errorDetail, httpError, usageOf, type Generator } from "./types.ts";

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";

interface MessagesResponse {
  content?: { type?: string; text?: string }[];
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function anthropicGenerator(o: { readonly apiKey: string; readonly model?: string }): Generator {
  const model = o.model ?? DEFAULT_ANTHROPIC_MODEL;
  const name = "anthropic";
  return {
    name,
    async generate(req) {
      const body = {
        model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: "user", content: req.prompt }],
      };
      const { status, json } = await egress.post(ANTHROPIC_URL, body, {
        headers: { "x-api-key": o.apiKey, "anthropic-version": ANTHROPIC_VERSION },
        timeoutMs: DEFAULT_GENERATE_TIMEOUT_MS,
        purpose: `generator:${name}`,
      });
      if (status >= 400) throw httpError(name, status, errorDetail(json));
      const r = json as MessagesResponse | null;
      if (!Array.isArray(r?.content)) throw new ProviderError("bad-response", `${name}: no content[] in the response: ${JSON.stringify(json)?.slice(0, 300)}`);
      const text = r.content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
      return { text, model: r.model ?? model, usage: usageOf(r.usage?.input_tokens, r.usage?.output_tokens) };
    },
  };
}
