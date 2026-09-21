import type { Answers, JevRequest } from "../questions.ts";

export type ProviderErrorCode = "auth" | "network" | "timeout" | "model" | "bad-response" | "quota";

export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, message: string) { super(message); }
}

/** Where a paste's typed questions go. `null` answers mean "no decision was made". */
export interface Provider {
  readonly name: string;
  ask(body: JevRequest): Promise<Answers | null>;
}

export const DEFAULT_TIMEOUT_MS = 8000;

/** Pull Jev's answers out of a proxy or REST envelope; throw on anything else. */
export function answersOf(raw: unknown, origin: string): Answers {
  const r = raw as { result?: { answers?: Answers }; answers?: Answers; error?: unknown; errors?: unknown; success?: boolean };
  const a = r?.result?.answers ?? r?.answers;
  if (a && typeof a === "object" && "kind" in a) return a;
  const why = r?.error ?? r?.errors ?? raw;
  throw new ProviderError("bad-response", `${origin}: no answers in response: ${(JSON.stringify(why) ?? String(why)).slice(0, 300)}`);
}

/** POST JSON with a timeout, mapping fetch failures to ProviderError. */
export async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ status: number; json: unknown }> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new ProviderError("timeout", `${url}: no answer within ${timeoutMs} ms`);
    throw new ProviderError("network", `${url}: ${(e as Error).message}`);
  }
  let json: unknown = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = { error: text.slice(0, 300) }; }
  return { status: res.status, json };
}
