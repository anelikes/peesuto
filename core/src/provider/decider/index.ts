/**
 * Decider configuration. The user-facing kinds are the CLI's flags and stay
 * `none | proxy | cloudflare | hosted`; they map onto three implementations:
 * `none`, `jev-endpoint` (proxy and hosted) and `jev-cloudflare`.
 */
import { hostedUrl } from "../hosted.ts";
import { ProviderConfigError } from "../types.ts";
import { cloudflareDecider } from "./cloudflare.ts";
import { endpointDecider } from "./endpoint.ts";
import { noneDecider } from "./none.ts";
import type { Decider } from "./types.ts";

export type ProviderConfig =
  | { readonly kind: "none" }
  | { readonly kind: "proxy"; readonly url: string; readonly token?: string }
  | { readonly kind: "cloudflare"; readonly accountId: string; readonly token: string }
  | { readonly kind: "hosted"; readonly token: string; readonly url?: string };

export const PROVIDER_KINDS = ["none", "proxy", "cloudflare", "hosted"] as const;
export const DEV_PROXY_URL = "http://localhost:8787/";

export function createDecider(cfg: ProviderConfig): Decider {
  switch (cfg.kind) {
    case "none": return noneDecider;
    case "proxy": return endpointDecider(cfg.url, cfg.token, "proxy");
    case "cloudflare": return cloudflareDecider(cfg.accountId, cfg.token);
    case "hosted": return endpointDecider(hostedUrl(cfg.url, "ask"), cfg.token, "hosted");
  }
}
export const createProvider = createDecider;

/**
 * Decider from the environment:
 *   PASTE_PROVIDER=none|proxy|cloudflare|hosted (default proxy)
 *   proxy:      PASTE_PROXY_URL (default the dev proxy), PASTE_TOKEN
 *   cloudflare: PASTE_CF_ACCOUNT_ID, PASTE_CF_TOKEN
 *   hosted:     PASTE_TOKEN, PASTE_HOSTED_URL (a base URL)
 */
export function deciderFromEnv(env: Record<string, string | undefined> = process.env): ProviderConfig {
  const kind = env.PASTE_PROVIDER ?? "proxy";
  switch (kind) {
    case "none": return { kind };
    case "proxy": return { kind, url: env.PASTE_PROXY_URL ?? DEV_PROXY_URL, token: env.PASTE_TOKEN };
    case "cloudflare": {
      if (!env.PASTE_CF_ACCOUNT_ID || !env.PASTE_CF_TOKEN) throw new ProviderConfigError("cloudflare needs PASTE_CF_ACCOUNT_ID and PASTE_CF_TOKEN");
      return { kind, accountId: env.PASTE_CF_ACCOUNT_ID, token: env.PASTE_CF_TOKEN };
    }
    case "hosted": {
      if (!env.PASTE_TOKEN) throw new ProviderConfigError("hosted needs PASTE_TOKEN");
      return { kind, token: env.PASTE_TOKEN, url: env.PASTE_HOSTED_URL };
    }
    default: throw new ProviderConfigError(`PASTE_PROVIDER must be one of ${PROVIDER_KINDS.join(", ")}, got ${kind}`);
  }
}
export const providerFromEnv = deciderFromEnv;
