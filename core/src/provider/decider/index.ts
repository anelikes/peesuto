/**
 * Decider configuration. The user-facing kinds are the CLI's flags:
 * `rules | none | laya | proxy | cloudflare | hosted`. They map onto four
 * implementations: `rules` (local heuristics), `none`, `jev-endpoint`
 * (laya, proxy and hosted: a URL that speaks {state, questions} → answers)
 * and `jev-cloudflare`.
 */
import { hostedUrl } from "../hosted.ts";
import { ProviderConfigError } from "../types.ts";
import { cloudflareDecider } from "./cloudflare.ts";
import { endpointDecider } from "./endpoint.ts";
import { noneDecider } from "./none.ts";
import { rulesDecider } from "./rules.ts";
import type { Decider } from "./types.ts";

export type ProviderConfig =
  | { readonly kind: "rules" }
  | { readonly kind: "none" }
  | { readonly kind: "laya"; readonly url?: string }
  | { readonly kind: "proxy"; readonly url: string; readonly token?: string }
  | { readonly kind: "cloudflare"; readonly accountId: string; readonly token: string }
  | { readonly kind: "hosted"; readonly token: string; readonly url?: string };

export const PROVIDER_KINDS = ["rules", "none", "laya", "proxy", "cloudflare", "hosted"] as const;
export const DEV_PROXY_URL = "http://localhost:8787/";
/** Where scripts/laya/server.py listens by default. */
export const DEFAULT_LAYA_URL = "http://127.0.0.1:8790/";
/**
 * How much of the pick ranking a Laya answer gets against the heuristic.
 * Zero-shot it ranks below the heuristic alone; the sweep in
 * baselines/laya.md peaks at 0.15–0.3, so it is a nudge, not the verdict.
 */
export const LAYA_PICK_WEIGHT = 0.3;

export function createDecider(cfg: ProviderConfig): Decider {
  switch (cfg.kind) {
    case "rules": return rulesDecider;
    case "none": return noneDecider;
    case "laya": return { ...endpointDecider(cfg.url ?? DEFAULT_LAYA_URL, undefined, "laya"), pickWeight: LAYA_PICK_WEIGHT };
    case "proxy": return endpointDecider(cfg.url, cfg.token, "proxy");
    case "cloudflare": return cloudflareDecider(cfg.accountId, cfg.token);
    case "hosted": return endpointDecider(hostedUrl(cfg.url, "ask"), cfg.token, "hosted");
  }
}
export const createProvider = createDecider;

/**
 * Decider from the environment:
 *   PASTE_PROVIDER=rules|none|laya|proxy|cloudflare|hosted (default proxy)
 *   laya:       PASTE_LAYA_URL (default http://127.0.0.1:8790/)
 *   proxy:      PASTE_PROXY_URL (default the dev proxy), PASTE_TOKEN
 *   cloudflare: PASTE_CF_ACCOUNT_ID, PASTE_CF_TOKEN
 *   hosted:     PASTE_TOKEN, PASTE_HOSTED_URL (a base URL)
 */
export function deciderFromEnv(env: Record<string, string | undefined> = process.env): ProviderConfig {
  const kind = env.PASTE_PROVIDER ?? "proxy";
  switch (kind) {
    case "rules":
    case "none": return { kind };
    case "laya": return { kind, ...(env.PASTE_LAYA_URL ? { url: env.PASTE_LAYA_URL } : {}) };
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
