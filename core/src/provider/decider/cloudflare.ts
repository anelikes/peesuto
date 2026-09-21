/**
 * `jev-cloudflare`: your own Cloudflare account, Workers AI's REST endpoint
 * for `typesafe/jev`. Needs the account ID and an API token with the
 * Workers AI read permission. The envelope is `{ success, result, errors }`;
 * `result` carries Jev's `answers`.
 */
import { egress } from "../egress.ts";
import { ProviderError } from "../types.ts";
import { answersOf, type Decider } from "./types.ts";

export const JEV_MODEL = "typesafe/jev";

export function cloudflareDecider(accountId: string, token: string, name = "cloudflare"): Decider {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${JEV_MODEL}`;
  return {
    name,
    async ask(body) {
      const { status, json } = await egress.post(url, body, { headers: { authorization: `Bearer ${token}` }, purpose: `decider:${name}` });
      const env = json as { success?: boolean; errors?: { code?: number; message?: string }[] } | null;
      const errors = env?.errors?.map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join("; ") ?? "";
      const tail = errors ? `: ${errors}` : "";
      if (status === 401 || status === 403 || /authentication|authorization|invalid.*token/i.test(errors)) throw new ProviderError("auth", `${name}: credential rejected (HTTP ${status}${tail})`);
      if (status === 429 || /rate limit|quota|neurons/i.test(errors)) throw new ProviderError("quota", `${name}: quota or rate limit (HTTP ${status}${tail})`);
      if (status === 404 || /no such model|not found/i.test(errors)) throw new ProviderError("model", `${name}: ${JEV_MODEL} is not reachable on this account (HTTP ${status}${tail})`);
      if (status >= 500) throw new ProviderError("model", `${name}: HTTP ${status}${tail}`);
      if (status >= 400 || env?.success === false) throw new ProviderError("bad-response", `${name}: HTTP ${status}${tail}`);
      return answersOf(json, name);
    },
  };
}
