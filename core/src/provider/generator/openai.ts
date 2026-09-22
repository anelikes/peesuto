/**
 * `openai-compatible`: `POST {baseUrl}/chat/completions`, non-streaming.
 * One implementation covers Ollama (`http://localhost:11434/v1`), vLLM,
 * LM Studio, OpenAI, DeepSeek and every other server that speaks the
 * chat-completions shape; the key is optional because local servers take
 * none.
 *
 * Thinking models. Ollama's recent defaults (qwen3.5, gemma4, …) reason
 * before they answer, and the OpenAI-compatible endpoint returns that
 * reasoning in `message.reasoning` with an EMPTY `content` once
 * `max_tokens` runs out — which, for an action-sized budget on a laptop,
 * is every time. `reasoning_effort: "none"` switches the thinking off
 * (Ollama ≥ 0.12; OpenAI's newer models take the same field), but older
 * servers and some hosted APIs reject the parameter with a 400, so it is
 * not sent blindly:
 *   - `reasoning` set in the options → sent on every request, no guessing;
 *   - otherwise the first request goes plain; when the answer is a thinking
 *     model's empty content (or the request timed out, which is what a slow
 *     thinking model looks like from outside), the request is retried once
 *     with `reasoning_effort: "none"`, and a generator that succeeded that
 *     way sends the field from then on, so the daemon pays the detour once.
 */
import { egress } from "../egress.ts";
import { ProviderError } from "../types.ts";
import { DEFAULT_GENERATE_TIMEOUT_MS, DEFAULT_MAX_TOKENS, errorDetail, httpError, usageOf, type GenerateResult, type Generator } from "./types.ts";

export const REASONING_EFFORTS = ["none", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const isReasoningEffort = (v: unknown): v is ReasoningEffort => (REASONING_EFFORTS as readonly unknown[]).includes(v);

export interface OpenAiCompatibleOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly name?: string;
  /** Sent as `reasoning_effort` on every request; unset means "learn" (above). */
  readonly reasoning?: ReasoningEffort;
  /** Per-request timeout; local models on a laptop may need more than the default. */
  readonly timeoutMs?: number;
}

interface ChatMessage {
  content?: unknown;
  /** Ollama's name for the thinking; `reasoning_content` is DeepSeek's and vLLM's. */
  reasoning?: unknown;
  reasoning_content?: unknown;
}

interface ChatCompletion {
  choices?: { message?: ChatMessage; finish_reason?: unknown }[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof (p as { text?: unknown })?.text === "string" ? (p as { text: string }).text : "")).join("");
  return null;
}

/** An answer with nothing in `content` but something in the thinking fields, or cut off by the budget while still empty. */
function thoughtAndSaidNothing(r: ChatCompletion | null): boolean {
  const c = r?.choices?.[0];
  if (!c) return false;
  const text = textOf(c.message?.content);
  if (text !== null && text.trim() !== "") return false;
  const m = c.message;
  const reasoned = (typeof m?.reasoning === "string" && m.reasoning !== "") || (typeof m?.reasoning_content === "string" && m.reasoning_content !== "");
  return reasoned || c.finish_reason === "length";
}

/** A 400 whose message names the parameter we added: the server does not know it. */
function rejectsReasoningEffort(status: number, json: unknown): boolean {
  return status === 400 && /reasoning[_ ]?effort/i.test(errorDetail(json));
}

export function openaiCompatibleGenerator(o: OpenAiCompatibleOptions): Generator {
  const baseUrl = o.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;
  const name = o.name ?? "openai-compatible";
  const timeoutMs = o.timeoutMs ?? DEFAULT_GENERATE_TIMEOUT_MS;
  /** What the last successful request had to do about thinking; starts from the options. */
  let learned: ReasoningEffort | undefined = o.reasoning;

  const thinkingError = (detail: string): ProviderError =>
    new ProviderError("model", `${name}: ${o.model} is a thinking model and spent the whole answer reasoning (${detail}); pick a non-thinking model, raise the action's maxTokens, or set the generator's reasoning to "none" if the server supports reasoning_effort`);

  async function once(req: Parameters<Generator["generate"]>[0], reasoning: ReasoningEffort | undefined): Promise<{ status: number; json: unknown }> {
    const messages: { role: "system" | "user"; content: string }[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.prompt });
    const body = {
      model: o.model,
      messages,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      ...(reasoning === undefined ? {} : { reasoning_effort: reasoning }),
    };
    return egress.post(url, body, {
      headers: o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {},
      timeoutMs,
      purpose: `generator:${name}`,
    });
  }

  function resultOf(json: unknown): GenerateResult {
    const r = json as ChatCompletion | null;
    const text = textOf(r?.choices?.[0]?.message?.content);
    if (text === null) throw new ProviderError("bad-response", `${name}: no choices[0].message.content in the response: ${JSON.stringify(json)?.slice(0, 300)}`);
    if (text.trim() === "") throw new ProviderError("bad-response", `${name}: ${o.model} answered with empty content`);
    return { text, model: r?.model ?? o.model, usage: usageOf(r?.usage?.prompt_tokens, r?.usage?.completion_tokens) };
  }

  return {
    name,
    async generate(req) {
      // Pinned by the options, or learned earlier: one request, no guessing.
      if (learned !== undefined) {
        const { status, json } = await once(req, learned);
        if (status >= 400) throw httpError(name, status, errorDetail(json));
        if (thoughtAndSaidNothing(json as ChatCompletion)) throw thinkingError(`even with reasoning_effort ${JSON.stringify(learned)}`);
        return resultOf(json);
      }

      let first: { status: number; json: unknown } | null = null;
      let timedOut = false;
      try {
        first = await once(req, undefined);
      } catch (e) {
        if (e instanceof ProviderError && e.code === "timeout") timedOut = true;
        else throw e;
      }
      if (first !== null) {
        if (first.status >= 400) throw httpError(name, first.status, errorDetail(first.json));
        if (!thoughtAndSaidNothing(first.json as ChatCompletion)) return resultOf(first.json);
      }

      // A thinking model, or a request that looked like one. Try once with the thinking off.
      const why = timedOut ? `no answer within ${timeoutMs} ms` : "empty content, the budget went to reasoning";
      const retry = await once(req, "none");
      if (rejectsReasoningEffort(retry.status, retry.json)) {
        if (timedOut) throw new ProviderError("timeout", `${name}: no answer from ${o.model} within ${timeoutMs} ms`);
        throw thinkingError(`${why}; the server rejects reasoning_effort`);
      }
      if (retry.status >= 400) throw httpError(name, retry.status, errorDetail(retry.json));
      if (thoughtAndSaidNothing(retry.json as ChatCompletion)) throw thinkingError(`${why}, and reasoning_effort "none" changed nothing`);
      const result = resultOf(retry.json);
      learned = "none";
      return result;
    },
  };
}
