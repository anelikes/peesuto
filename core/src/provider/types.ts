/**
 * What both provider tracks share: the error every provider throws, the
 * error the factories throw for a configuration they cannot use, and the
 * default timeout for one ask.
 */
export type ProviderErrorCode =
  | "auth"          // the credential was rejected
  | "network"       // the host could not be reached
  | "timeout"       // the host was reached, but gave no answer in time
  | "model"         // the host answered, the model did not (missing, overloaded, 5xx)
  | "bad-response"  // an answer in a shape we do not understand
  | "quota"         // rate limit or subscription exhausted
  | "offline"       // offline mode is on: nothing was sent
  | "unavailable";  // nothing is configured for this track

export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, message: string) { super(message); this.name = "ProviderError"; }
}

/** A configuration that cannot become a provider: a missing credential, an unknown kind. */
export class ProviderConfigError extends Error {
  constructor(message: string) { super(message); this.name = "ProviderConfigError"; }
}

/** Deciders answer in well under a second; this is the ceiling for one ask. */
export const DEFAULT_TIMEOUT_MS = 8000;
