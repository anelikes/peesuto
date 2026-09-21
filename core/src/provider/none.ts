import type { Provider } from "./types.ts";

/** No decisions: every paste gets the fallback card. */
export const noneProvider: Provider = { name: "none", ask: async () => null };
