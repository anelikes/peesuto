import { answersOf, postJson, ProviderError, type Provider } from "./types.ts";

/**
 * A proxy that forwards `{state, questions}` to Jev and returns its answers,
 * optionally behind a bearer token. `proxy/` in this repository is one such
 * worker: unauthenticated under `wrangler dev`, token-gated when hosted.
 */
export function proxyProvider(url: string, token?: string, name = "proxy"): Provider {
  return {
    name,
    async ask(body) {
      const { status, json } = await postJson(url, body, token ? { authorization: `Bearer ${token}` } : {});
      if (status === 401 || status === 403) throw new ProviderError("auth", `${name}: rejected the credential (HTTP ${status})`);
      if (status === 429 || status === 402) throw new ProviderError("quota", `${name}: quota exhausted (HTTP ${status})`);
      if (status >= 500) throw new ProviderError("model", `${name}: HTTP ${status} ${JSON.stringify(json).slice(0, 200)}`);
      if (status >= 400) throw new ProviderError("bad-response", `${name}: HTTP ${status} ${(JSON.stringify(json) ?? "").slice(0, 200)}`);
      return answersOf(json, name);
    },
  };
}
