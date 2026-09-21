import { answersOf, postJson, ProviderError, type Provider } from "./types.ts";

/**
 * Your own Cloudflare account: Workers AI's REST endpoint for `typesafe/jev`.
 * Needs the account ID and an API token with the Workers AI read permission.
 * The response envelope is `{ success, result, errors }`; `result` carries
 * Jev's `answers`.
 */
export const JEV_MODEL = "typesafe/jev";

export function cloudflareProvider(accountId: string, token: string): Provider {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${JEV_MODEL}`;
  return {
    name: "cloudflare",
    async ask(body) {
      const { status, json } = await postJson(url, body, { authorization: `Bearer ${token}` });
      const env = json as { success?: boolean; errors?: { code?: number; message?: string }[] } | null;
      const errors = env?.errors?.map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join("; ") ?? "";
      if (status === 401 || status === 403 || /authentication|authorization|invalid.*token/i.test(errors)) throw new ProviderError("auth", `cloudflare: credential rejected (HTTP ${status}${errors ? `: ${errors}` : ""})`);
      if (status === 429 || /rate limit|quota|neurons/i.test(errors)) throw new ProviderError("quota", `cloudflare: quota or rate limit (HTTP ${status}${errors ? `: ${errors}` : ""})`);
      if (status === 404 || /no such model|not found/i.test(errors)) throw new ProviderError("model", `cloudflare: ${JEV_MODEL} is not reachable on this account (HTTP ${status}${errors ? `: ${errors}` : ""})`);
      if (status >= 500) throw new ProviderError("model", `cloudflare: HTTP ${status}${errors ? `: ${errors}` : ""}`);
      if (status >= 400 || env?.success === false) throw new ProviderError("bad-response", `cloudflare: HTTP ${status}${errors ? `: ${errors}` : ""}`);
      return answersOf(json, "cloudflare");
    },
  };
}
