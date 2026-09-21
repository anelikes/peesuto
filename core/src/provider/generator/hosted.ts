/**
 * `hosted`: the subscription's generator, our proxy/ in hosted mode. The
 * proxy side is built separately; this is the wire shape it serves:
 *
 *   POST {base}/v1/generate
 *   Authorization: Bearer <subscriber token>
 *   Content-Type: application/json
 *   → { prompt: string, system?: string, maxTokens?: number, temperature?: number }
 *   ← 200 { text: string, model: string, usage?: { in: number, out: number } }
 *   ← 401 / 403 { error }   the token is unknown or revoked
 *   ← 402 / 429 { error }   the subscription's quota or rate limit
 *   ← 5xx       { error }   the upstream model failed
 *
 * The proxy never logs prompts or completions; the client never sends
 * anything but the fields above.
 */
import { egress } from "../egress.ts";
import { hostedUrl } from "../hosted.ts";
import { ProviderError } from "../types.ts";
import { DEFAULT_GENERATE_TIMEOUT_MS, errorDetail, httpError, type Generator } from "./types.ts";

export function hostedGenerator(token: string, base?: string): Generator {
  const url = hostedUrl(base, "generate");
  const name = "hosted";
  return {
    name,
    async generate(req) {
      const body = {
        prompt: req.prompt,
        ...(req.system === undefined ? {} : { system: req.system }),
        ...(req.maxTokens === undefined ? {} : { maxTokens: req.maxTokens }),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      };
      const { status, json } = await egress.post(url, body, { headers: { authorization: `Bearer ${token}` }, timeoutMs: DEFAULT_GENERATE_TIMEOUT_MS, purpose: `generator:${name}` });
      if (status >= 400) throw httpError(name, status, errorDetail(json));
      const r = json as { text?: unknown; model?: unknown; usage?: { in?: unknown; out?: unknown } } | null;
      if (typeof r?.text !== "string") throw new ProviderError("bad-response", `${name}: no text in the response: ${JSON.stringify(json)?.slice(0, 300)}`);
      const usage = typeof r.usage?.in === "number" && typeof r.usage.out === "number" ? { in: r.usage.in, out: r.usage.out } : undefined;
      return { text: r.text, model: typeof r.model === "string" ? r.model : "hosted", usage };
    },
  };
}
