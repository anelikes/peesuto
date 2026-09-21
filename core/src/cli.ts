#!/usr/bin/env bun
/**
 * paste: clipboard text → Jev (typed decisions) → Pocket Motion (a card).
 *
 *   paste "some text" [--aspect chat|doc|social] [--out card.png]
 *   pbpaste | paste --stdin
 *   paste --dsl job.json            # skip Jev, render a DSL as-is
 *   paste --provider none "text"    # no decisions: the fallback card
 *
 * Provider: --provider none|proxy|cloudflare|hosted (default proxy at
 * http://localhost:8787/, i.e. `wrangler dev` in proxy/); --proxy-url,
 * --account-id, --token, --hosted-url; or the environment PASTE_PROVIDER,
 * PASTE_PROXY_URL, PASTE_CF_ACCOUNT_ID, PASTE_CF_TOKEN, PASTE_TOKEN,
 * PASTE_HOSTED_URL. Answers are cached by text (--fresh asks again).
 * Engine: POCKET_ENGINE, else <repo>/engine, else ../pocketjs-motion.
 * Work tree: --work (default <repo>/.work/tree). --json prints the result
 * as one JSON object for a host program.
 *
 * Packaged: --app-data <dir> (or PASTE_APP_DATA) puts the work tree, caches
 * and the installed engine under one directory, and --engine-resources <dir>
 * (or POCKET_ENGINE_RESOURCES) names the read-only sidecar resource tree the
 * engine is installed from on first run.
 */
import { join } from "node:path";
import { isAspect, parseDsl, type Dsl } from "./dsl.ts";
import { assertEngine, bunIsOnPath, bunOnPath, engineRoot, EngineError, installEngine, REPO_ROOT } from "./engine.ts";
import { cachedProvider, createProvider, DEV_PROXY_URL, PROVIDER_KINDS, providerFromEnv, ProviderConfigError, ProviderError, type ProviderConfig } from "./provider/index.ts";
import { answersToDsl, buildRequest, fallbackDsl } from "./questions.ts";
import { ComposeError } from "./render/compose.ts";
import { renderCard } from "./render/card.ts";

function parseArgv(argv: readonly string[]) {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (["stdin", "json", "keep", "help", "fresh"].includes(name) || next === undefined || next.startsWith("--")) flags.set(name, true);
    else { flags.set(name, next); i++; }
  }
  const str = (n: string): string | undefined => { const v = flags.get(n); return typeof v === "string" ? v : undefined; };
  return { flags, positional, str };
}

export async function main(argv: readonly string[]): Promise<number> {
  const { flags, positional, str } = parseArgv(argv);
  if (flags.has("help")) { console.log(USAGE); return 0; }
  const appData = str("app-data") ?? process.env.PASTE_APP_DATA;

  // The engine and the measurer spawn `bun` by name. Packaged, the executable
  // is called `paste` and nothing on PATH is called bun, so run once more
  // with a shim directory first on PATH. Before any other side effect.
  if (!bunIsOnPath() && !process.env.PASTE_REEXEC) {
    const { PATH } = await bunOnPath(join(appData ?? join(REPO_ROOT, ".work"), "bin"));
    const p = Bun.spawn([process.execPath, ...process.argv.slice(1)], { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, PATH, PASTE_REEXEC: "1" } });
    return await p.exited;
  }
  const json = flags.has("json");
  const log = (s: string) => { if (!json) console.log(s); };

  const aspectRaw = str("aspect") ?? "chat";
  if (!isAspect(aspectRaw)) throw new UsageError(`--aspect must be chat, doc or social`);
  const aspect = aspectRaw;

  // --- what to render ---
  let dsl: Dsl;
  let decided: { provider: string; kindP?: number; jevMs?: number } = { provider: "dsl" };
  const dslFile = str("dsl");
  if (dslFile) {
    dsl = parseDsl(await Bun.file(dslFile).json());
  } else {
    const text = flags.has("stdin") ? await Bun.stdin.text() : positional[0];
    if (!text?.trim()) throw new UsageError("no text: pass it as an argument, --stdin, or --dsl <job.json>");
    const length = [...text].length;
    if (length > MAX_TEXT_CHARS) throw new InputError(`text is ${length} characters; a card takes at most ${MAX_TEXT_CHARS}`);
    const cfg = providerConfig(str, flags.has("provider") ? undefined : process.env);
    const cacheDir = str("cache-dir") ?? join(appData ?? join(REPO_ROOT, ".work"), "answers");
    const provider = cfg.kind === "none" ? createProvider(cfg) : cachedProvider(createProvider(cfg), cacheDir, { fresh: flags.has("fresh") });
    const t0 = performance.now();
    const { body } = buildRequest(text);
    const answers = await provider.ask(body);
    const jevMs = Math.round(performance.now() - t0);
    if (answers) {
      const r = answersToDsl(text, answers, aspect);
      dsl = r.dsl;
      decided = { provider: provider.name, kindP: r.kindP, jevMs };
      log(`jev ${jevMs} ms → ${JSON.stringify({ ...dsl, text: undefined })}  (kind p=${r.kindP.toFixed(2)})`);
    } else {
      dsl = fallbackDsl(text, aspect);
      decided = { provider: provider.name };
      log(`no provider → ${JSON.stringify({ ...dsl, text: undefined })}`);
    }
  }

  // --- render ---
  const resources = str("engine-resources") ?? process.env.POCKET_ENGINE_RESOURCES;
  const engine = resources ? await installEngine(resources, appData ?? join(REPO_ROOT, ".work")) : engineRoot();
  assertEngine(engine);
  const work = str("work") ?? (appData ? join(appData, "work") : join(REPO_ROOT, ".work/tree"));
  const t1 = performance.now();
  const r = await renderCard(dsl, { engine, work, emojiCache: appData ? join(appData, "emoji") : join(work, "..", "emoji"), out: str("out"), outDir: appData ? join(appData, "cards") : join(REPO_ROOT, "out") });
  const total = Math.round(performance.now() - t1);
  log(`paste: ${dsl.kind}/${dsl.layout}/${dsl.palette}/${dsl.aspect} scale=${dsl.scale} tone=${dsl.tone} → ${r.lines} line(s) at ${r.size}px, ${r.frames} frame(s)${r.emoji ? `, ${r.emoji} emoji` : ""}`);
  log(`render ${total} ms (compose ${r.ms.compose}, build ${r.ms.build}, ${r.format} ${r.ms.frame}) → ${r.path}`);
  if (json) console.log(JSON.stringify({ ok: true, path: r.path, format: r.format, frames: r.frames, lines: r.lines, size: r.size, dsl, decided, ms: { ...r.ms, total } }));
  return 0;
}

/** Longer than this and it is a document, not a card. */
export const MAX_TEXT_CHARS = 2000;

function providerConfig(str: (n: string) => string | undefined, env?: NodeJS.ProcessEnv): ProviderConfig {
  const kind = str("provider");
  const e = process.env;
  if (kind === undefined) return providerFromEnv(env ?? {});
  switch (kind) {
    case "none": return { kind };
    case "proxy": return { kind, url: str("proxy-url") ?? e.PASTE_PROXY_URL ?? DEV_PROXY_URL, token: str("token") ?? e.PASTE_TOKEN };
    case "cloudflare": {
      const accountId = str("account-id") ?? e.PASTE_CF_ACCOUNT_ID, token = str("token") ?? e.PASTE_CF_TOKEN;
      if (!accountId || !token) throw new ProviderConfigError("cloudflare needs --account-id and --token (or PASTE_CF_ACCOUNT_ID, PASTE_CF_TOKEN)");
      return { kind, accountId, token };
    }
    case "hosted": {
      const token = str("token") ?? e.PASTE_TOKEN;
      if (!token) throw new ProviderConfigError("hosted needs --token (or PASTE_TOKEN)");
      return { kind, token, url: str("hosted-url") ?? e.PASTE_HOSTED_URL };
    }
    default: throw new UsageError(`--provider must be one of ${PROVIDER_KINDS.join(", ")}`);
  }
}

export class UsageError extends Error {}
export class InputError extends Error {}

const USAGE = `paste "text" [--aspect chat|doc|social] [--out file] [--json] [--fresh]
      [--provider none|proxy|cloudflare|hosted] [--proxy-url URL] [--account-id ID] [--token T] [--hosted-url URL]
      [--work DIR] [--app-data DIR] [--engine-resources DIR] [--cache-dir DIR]
pbpaste | paste --stdin
paste --dsl job.json`;

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (e) {
    const json = process.argv.includes("--json");
    const kind = e instanceof UsageError ? "usage" : e instanceof InputError ? "input" : e instanceof ProviderConfigError ? "provider:config"
      : e instanceof ProviderError ? `provider:${e.code}` : e instanceof ComposeError ? "compose" : e instanceof EngineError ? "engine" : "error";
    const message = e instanceof Error ? e.message : String(e);
    if (json) console.log(JSON.stringify({ ok: false, kind, message }));
    else console.error(`${kind}: ${message}${kind === "usage" ? `\n\n${USAGE}` : ""}`);
    process.exit(kind === "usage" ? 2 : 1);
  }
}
