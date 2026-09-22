/**
 * Both tracks in one settings file, and the secrets out of it.
 *
 * The file (App Support/providers.json) holds kinds, URLs, model names and
 * the offline switch. Credentials never land in it: a field named `*Ref`
 * names an item in a `SecretStore` — the app's is the Keychain, the CLI's
 * the environment, tests use memory — and `resolveProviders` looks them up
 * on the way to a live decider and generator.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { cachedProvider } from "./cache.ts";
import { createDecider, PROVIDER_KINDS, type ProviderConfig } from "./decider/index.ts";
import type { Decider } from "./decider/types.ts";
import { setOffline } from "./egress.ts";
import { createGenerator, GENERATOR_KINDS, type GeneratorConfig } from "./generator/index.ts";
import { isReasoningEffort, REASONING_EFFORTS, type ReasoningEffort } from "./generator/openai.ts";
import type { Generator } from "./generator/types.ts";
import { ProviderConfigError } from "./types.ts";

export interface SecretStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
}

/** For tests and one-off resolution. */
export function memorySecretStore(init: Record<string, string> = {}): SecretStore {
  const m = new Map(Object.entries(init));
  return { get: async (n) => m.get(n), set: async (n, v) => { m.set(n, v); } };
}

/** `pocket-paste/generator` → `POCKET_PASTE_GENERATOR`. */
export function envSecretName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/** The environment: an item is the variable with its own name, else the upper-cased one. */
export function envSecretStore(env: Record<string, string | undefined> = process.env): SecretStore {
  return {
    get: async (n) => env[n] ?? env[envSecretName(n)],
    set: async (n, v) => { env[envSecretName(n)] = v; },
  };
}

/** Conventional Keychain item names, so the app and the CLI agree. */
export const SECRET_REFS = {
  proxyToken: "pocket-paste/proxy",
  cloudflareToken: "pocket-paste/cloudflare",
  hostedToken: "pocket-paste/hosted",
  generatorApiKey: "pocket-paste/generator",
} as const;

export type StoredProviderConfig =
  | { readonly kind: "rules" }
  | { readonly kind: "none" }
  | { readonly kind: "laya"; readonly url?: string }
  | { readonly kind: "proxy"; readonly url: string; readonly tokenRef?: string }
  | { readonly kind: "cloudflare"; readonly accountId: string; readonly tokenRef: string }
  | { readonly kind: "hosted"; readonly tokenRef: string; readonly url?: string };

export type StoredGeneratorConfig =
  | { readonly kind: "openai-compatible"; readonly baseUrl: string; readonly model: string; readonly apiKeyRef?: string; readonly reasoning?: ReasoningEffort; readonly timeoutMs?: number }
  | { readonly kind: "anthropic"; readonly apiKeyRef: string; readonly model?: string }
  | { readonly kind: "hosted"; readonly tokenRef: string; readonly url?: string }
  | { readonly kind: "none" };

export interface ProvidersConfig {
  readonly decider: StoredProviderConfig;
  readonly generator: StoredGeneratorConfig;
  readonly offline: boolean;
}

/** A fresh install: rule-based card decisions, heuristic picks, no generator, nothing leaves the machine. */
export const DEFAULT_PROVIDERS_CONFIG: ProvidersConfig = { decider: { kind: "rules" }, generator: { kind: "none" }, offline: false };

const RAW_SECRET_FIELDS = ["token", "apiKey", "api_key", "secret", "password"];

function section(raw: unknown, where: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProviderConfigError(`${where} must be an object`);
  const o = raw as Record<string, unknown>;
  for (const k of RAW_SECRET_FIELDS) if (k in o) throw new ProviderConfigError(`${where}.${k}: secrets do not belong in this file; store it in the secret store and name it in ${where}.${k}Ref`);
  return o;
}

function optional(o: Record<string, unknown>, k: string, where: string): string | undefined {
  const v = o[k];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new ProviderConfigError(`${where}.${k} must be a string`);
  return v;
}

function required(o: Record<string, unknown>, k: string, where: string): string {
  const v = optional(o, k, where);
  if (v === undefined) throw new ProviderConfigError(`${where}.${k} is required`);
  return v;
}

const opt = <K extends string>(k: K, v: string | undefined): { [P in K]?: string } => (v === undefined ? {} : ({ [k]: v } as { [P in K]?: string }));

/** `reasoning`, when present, is one of the reasoning_effort values. */
function reasoningOf(v: unknown, where: string): { reasoning?: ReasoningEffort } {
  if (v === undefined) return {};
  if (!isReasoningEffort(v)) throw new ProviderConfigError(`${where}.reasoning must be one of ${REASONING_EFFORTS.join(", ")}`);
  return { reasoning: v };
}

/** `timeoutMs`, when present, is a positive whole number of milliseconds. */
function timeoutOf(v: unknown, where: string): { timeoutMs?: number } {
  if (v === undefined) return {};
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new ProviderConfigError(`${where}.timeoutMs must be a positive whole number of milliseconds`);
  return { timeoutMs: v };
}

export function parseStoredDecider(raw: unknown): StoredProviderConfig {
  const o = section(raw, "decider");
  const kind = required(o, "kind", "decider");
  switch (kind) {
    case "rules":
    case "none": return { kind };
    case "laya": return { kind, ...opt("url", optional(o, "url", "decider")) };
    case "proxy": return { kind, url: required(o, "url", "decider"), ...opt("tokenRef", optional(o, "tokenRef", "decider")) };
    case "cloudflare": return { kind, accountId: required(o, "accountId", "decider"), tokenRef: required(o, "tokenRef", "decider") };
    case "hosted": return { kind, tokenRef: required(o, "tokenRef", "decider"), ...opt("url", optional(o, "url", "decider")) };
    default: throw new ProviderConfigError(`decider.kind must be one of ${PROVIDER_KINDS.join(", ")}, got ${kind}`);
  }
}

export function parseStoredGenerator(raw: unknown): StoredGeneratorConfig {
  const o = section(raw, "generator");
  const kind = required(o, "kind", "generator");
  switch (kind) {
    case "none": return { kind };
    case "openai-compatible": return {
      kind, baseUrl: required(o, "baseUrl", "generator"), model: required(o, "model", "generator"),
      ...opt("apiKeyRef", optional(o, "apiKeyRef", "generator")),
      ...reasoningOf(o.reasoning, "generator"),
      ...timeoutOf(o.timeoutMs, "generator"),
    };
    case "anthropic": return { kind, apiKeyRef: required(o, "apiKeyRef", "generator"), ...opt("model", optional(o, "model", "generator")) };
    case "hosted": return { kind, tokenRef: required(o, "tokenRef", "generator"), ...opt("url", optional(o, "url", "generator")) };
    default: throw new ProviderConfigError(`generator.kind must be one of ${GENERATOR_KINDS.join(", ")}, got ${kind}`);
  }
}

/** Validate a parsed file; missing sections take the defaults, anything malformed throws. */
export function parseProvidersConfig(raw: unknown): ProvidersConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProviderConfigError("providers config must be a JSON object");
  const o = raw as Record<string, unknown>;
  if (o.offline !== undefined && typeof o.offline !== "boolean") throw new ProviderConfigError("offline must be true or false");
  return {
    decider: o.decider === undefined ? DEFAULT_PROVIDERS_CONFIG.decider : parseStoredDecider(o.decider),
    generator: o.generator === undefined ? DEFAULT_PROVIDERS_CONFIG.generator : parseStoredGenerator(o.generator),
    offline: o.offline ?? false,
  };
}

/** The config in `file`, or the defaults when there is no file yet. */
export async function readProvidersConfig(file: string): Promise<ProvidersConfig> {
  let text: string;
  try { text = await readFile(file, "utf8"); } catch (e) {
    if ((e as { code?: string })?.code === "ENOENT") return DEFAULT_PROVIDERS_CONFIG;
    throw e;
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new ProviderConfigError(`${file}: not JSON: ${(e as Error).message}`); }
  return parseProvidersConfig(raw);
}

/** Write `cfg` (validated first, so a raw secret never reaches the disk); the file is owner-readable only. */
export async function writeProvidersConfig(file: string, cfg: ProvidersConfig): Promise<void> {
  const clean = parseProvidersConfig(cfg);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
}

async function secret(secrets: SecretStore, ref: string, what: string): Promise<string> {
  const v = await secrets.get(ref);
  if (!v) throw new ProviderConfigError(`${what}: no secret named ${JSON.stringify(ref)} in the secret store`);
  return v;
}

export async function deciderConfigOf(s: StoredProviderConfig, secrets: SecretStore): Promise<ProviderConfig> {
  switch (s.kind) {
    case "rules": return { kind: "rules" };
    case "none": return { kind: "none" };
    case "laya": return { kind: "laya", ...opt("url", s.url) };
    case "proxy": return { kind: "proxy", url: s.url, ...(s.tokenRef ? { token: await secret(secrets, s.tokenRef, "decider proxy") } : {}) };
    case "cloudflare": return { kind: "cloudflare", accountId: s.accountId, token: await secret(secrets, s.tokenRef, "decider cloudflare") };
    case "hosted": return { kind: "hosted", token: await secret(secrets, s.tokenRef, "decider hosted"), ...opt("url", s.url) };
  }
}

export async function generatorConfigOf(s: StoredGeneratorConfig, secrets: SecretStore): Promise<GeneratorConfig> {
  switch (s.kind) {
    case "none": return { kind: "none" };
    case "openai-compatible": return {
      kind: "openai-compatible", baseUrl: s.baseUrl, model: s.model,
      ...(s.apiKeyRef ? { apiKey: await secret(secrets, s.apiKeyRef, "generator openai-compatible") } : {}),
      ...(s.reasoning === undefined ? {} : { reasoning: s.reasoning }),
      ...(s.timeoutMs === undefined ? {} : { timeoutMs: s.timeoutMs }),
    };
    case "anthropic": return { kind: "anthropic", apiKey: await secret(secrets, s.apiKeyRef, "generator anthropic"), ...opt("model", s.model) };
    case "hosted": return { kind: "hosted", token: await secret(secrets, s.tokenRef, "generator hosted"), ...opt("url", s.url) };
  }
}

/**
 * Live providers from a stored config: secrets resolved, factories run, and
 * the offline switch set to what the config says. A track configured as
 * `none` resolves to `null`. With `cacheDir`, a model decider's answers are
 * cached by content hash (cache.ts); `fresh` asks again regardless.
 */
export async function resolveProviders(cfg: ProvidersConfig, secrets: SecretStore, o: { cacheDir?: string; fresh?: boolean } = {}): Promise<{ decider: Decider | null; generator: Generator | null }> {
  let decider: Decider | null = null;
  if (cfg.decider.kind !== "none") {
    const bare = createDecider(await deciderConfigOf(cfg.decider, secrets));
    // Rules answer in microseconds and never differ; caching them would only fill the directory.
    decider = o.cacheDir && cfg.decider.kind !== "rules" ? cachedProvider(bare, o.cacheDir, { fresh: o.fresh }) : bare;
  }
  const generator = cfg.generator.kind === "none" ? null : createGenerator(await generatorConfigOf(cfg.generator, secrets));
  setOffline(cfg.offline);
  return { decider, generator };
}
