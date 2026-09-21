import { ProviderError } from "../types.ts";
import type { Generator } from "./types.ts";

/** No generator: every generating action fails with a pointer to Settings. */
export const noneGenerator: Generator = {
  name: "none",
  async generate() {
    throw new ProviderError("unavailable", "no generator configured: choose an OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, a cloud API), Anthropic, or the hosted service");
  },
};
