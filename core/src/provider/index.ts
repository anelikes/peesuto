/**
 * Two tracks behind one door.
 *
 *   decider/    typed questions → answers (Jev): jev-cloudflare, jev-endpoint, none
 *   generator/  prompt → text (an LLM): openai-compatible, anthropic, hosted, none
 *   egress.ts   the only fetch in core: offline switch, destination log
 *   cache.ts    decider answers cached by content hash
 *   config.ts   both tracks in one file, secrets by reference
 */
export { ProviderConfigError, ProviderError, DEFAULT_TIMEOUT_MS, type ProviderErrorCode } from "./types.ts";
export { egress, egressLogPath, isLocalHost, isOffline, setEgressLog, setOffline, type EgressLogLine, type EgressOptions, type EgressResponse } from "./egress.ts";
export { DEFAULT_HOSTED_URL, hostedUrl, type HostedRoute } from "./hosted.ts";

export { answersOf, type Decider, type JevAnswer, type JevAnswers, type Provider } from "./decider/types.ts";
export { createDecider, createProvider, deciderFromEnv, DEV_PROXY_URL, PROVIDER_KINDS, providerFromEnv, type ProviderConfig } from "./decider/index.ts";
export { answerKey, cachedProvider } from "./cache.ts";

export { type GenerateRequest, type GenerateResult, type Generator, DEFAULT_MAX_TOKENS, DEFAULT_GENERATE_TIMEOUT_MS } from "./generator/types.ts";
export { createGenerator, DEFAULT_OLLAMA_URL, GENERATOR_KINDS, generatorFromEnv, type GeneratorConfig } from "./generator/index.ts";
export { DEFAULT_ANTHROPIC_MODEL } from "./generator/anthropic.ts";
export { isReasoningEffort, REASONING_EFFORTS, type ReasoningEffort } from "./generator/openai.ts";

export {
  DEFAULT_PROVIDERS_CONFIG, SECRET_REFS, deciderConfigOf, envSecretName, envSecretStore, generatorConfigOf, memorySecretStore,
  parseProvidersConfig, readProvidersConfig, resolveProviders, writeProvidersConfig,
  type ProvidersConfig, type SecretStore, type StoredGeneratorConfig, type StoredProviderConfig,
} from "./config.ts";
