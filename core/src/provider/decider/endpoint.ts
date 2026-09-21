/**
 * `jev-endpoint`: any URL that accepts `{state, questions}` and returns
 * Jev's answers, optionally behind a bearer token. `proxy/` in this
 * repository is one such worker — unauthenticated under `wrangler dev`,
 * token-gated when hosted — and the subscription is the same thing at our
 * URL. Self-hosting is a URL and an optional credential, nothing more.
 */
import { egress } from "../egress.ts";
import { ProviderError } from "../types.ts";
import { answersOf, type Decider } from "./types.ts";

export function endpointDecider(url: string, token?: string, name = "endpoint"): Decider {
  return {
    name,
    async ask(body) {
      const { status, json } = await egress.post(url, body, { headers: token ? { authorization: `Bearer ${token}` } : {}, purpose: `decider:${name}` });
      if (status === 401 || status === 403) throw new ProviderError("auth", `${name}: rejected the credential (HTTP ${status})`);
      if (status === 429 || status === 402) throw new ProviderError("quota", `${name}: quota exhausted (HTTP ${status})`);
      if (status >= 500) throw new ProviderError("model", `${name}: HTTP ${status} ${JSON.stringify(json).slice(0, 200)}`);
      if (status >= 400) throw new ProviderError("bad-response", `${name}: HTTP ${status} ${(JSON.stringify(json) ?? "").slice(0, 200)}`);
      return answersOf(json, name);
    },
  };
}
