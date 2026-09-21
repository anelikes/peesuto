/**
 * `openai-compatible`: `POST {baseUrl}/chat/completions`, non-streaming.
 * One implementation covers Ollama (`http://localhost:11434/v1`), vLLM,
 * LM Studio, OpenAI, DeepSeek and every other server that speaks the
 * chat-completions shape; the key is optional because local servers take
 * none.
 */
import { egress } from "../egress.ts";
import { ProviderError } from "../types.ts";
import { DEFAULT_GENERATE_TIMEOUT_MS, DEFAULT_MAX_TOKENS, errorDetail, httpError, usageOf, type Generator } from "./types.ts";

export interface OpenAiCompatibleOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly name?: string;
}

interface ChatCompletion {
  choices?: { message?: { content?: unknown } }[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof (p as { text?: unknown })?.text === "string" ? (p as { text: string }).text : "")).join("");
  return null;
}

export function openaiCompatibleGenerator(o: OpenAiCompatibleOptions): Generator {
  const baseUrl = o.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;
  const name = o.name ?? "openai-compatible";
  return {
    name,
    async generate(req) {
      const messages: { role: "system" | "user"; content: string }[] = [];
      if (req.system) messages.push({ role: "system", content: req.system });
      messages.push({ role: "user", content: req.prompt });
      const body = {
        model: o.model,
        messages,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      };
      const { status, json } = await egress.post(url, body, {
        headers: o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {},
        timeoutMs: DEFAULT_GENERATE_TIMEOUT_MS,
        purpose: `generator:${name}`,
      });
      if (status >= 400) {
        const detail = errorDetail(json);
        throw httpError(name, status, status === 404 ? (detail || `no model ${JSON.stringify(o.model)} at ${baseUrl}, or that is not a chat-completions endpoint`) : detail);
      }
      const r = json as ChatCompletion | null;
      const text = textOf(r?.choices?.[0]?.message?.content);
      if (text === null) throw new ProviderError("bad-response", `${name}: no choices[0].message.content in the response: ${JSON.stringify(json)?.slice(0, 300)}`);
      return { text, model: r?.model ?? o.model, usage: usageOf(r?.usage?.prompt_tokens, r?.usage?.completion_tokens) };
    },
  };
}
