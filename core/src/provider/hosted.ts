/**
 * The subscription: our deployed proxy/ in hosted mode, gated by a
 * subscriber token. One base URL serves both tracks — deciders POST
 * `/v1/ask`, generators POST `/v1/generate`.
 */
export const DEFAULT_HOSTED_URL = "https://api.peesuto.com";

export type HostedRoute = "ask" | "generate";

/**
 * The URL for one route. `base` is an origin or a base path; a full route
 * URL from an older config (`…/v1/ask`) is accepted and re-routed.
 */
export function hostedUrl(base: string | undefined, route: HostedRoute): string {
  const b = (base ?? DEFAULT_HOSTED_URL).replace(/\/+$/, "").replace(/\/v1\/(ask|generate)$/, "");
  return `${b}/v1/${route}`;
}
