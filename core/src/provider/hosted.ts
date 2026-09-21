import { proxyProvider } from "./proxy.ts";
import type { Provider } from "./types.ts";

/**
 * The subscription: our deployed proxy, gated by a subscriber token. Same
 * wire shape as the dev proxy, so `proxy/` serves both.
 */
export const DEFAULT_HOSTED_URL = "https://jev.pocketpaste.dev/v1/ask";

export function hostedProvider(token: string, url = DEFAULT_HOSTED_URL): Provider {
  return proxyProvider(url, token, "hosted");
}
