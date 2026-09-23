#!/usr/bin/env bun
/**
 * paste-daemon: the long-lived Core the desktop app talks to.
 *
 *   paste-daemon --app-data <dir> [--engine-resources <dir>] [--idle-minutes 10]
 *
 * JSON lines in on stdin, JSON lines out on stdout (protocol.ts). Exits when
 * stdin closes, on `shutdown`, or after `--idle-minutes` without pending work
 * (the shell restarts it on demand). Logs go to stderr only; stdout carries
 * nothing but responses and explicitly requested task lifecycle events.
 */
import { join, resolve } from "node:path";
import { Daemon, parseRequest, type DaemonHost } from "./daemon/server.ts";
import { assertEngine, bunIsOnPath, bunOnPath, engineMissing, engineRoot, installEngine, REPO_ROOT } from "./engine.ts";
import { resolveProviders, type ProvidersConfig } from "./provider/config.ts";
import { setEgressLog, setOffline } from "./provider/egress.ts";
import { memorySecretStore } from "./provider/config.ts";

const VERSION = "0.1.0";

function flag(argv: readonly string[], n: string): string | undefined { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; }

async function engineFor(appData: string, resources: string | undefined): Promise<string | null> {
  try {
    const root = resources ? await installEngine(resources, appData) : engineRoot();
    assertEngine(root);
    return root;
  } catch (e) {
    console.error(`daemon: rendering unavailable: ${(e as Error).message}`);
    return null;
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const appData = resolve(flag(argv, "app-data") ?? process.env.PASTE_APP_DATA ?? join(REPO_ROOT, ".work/app-data"));
  if (!bunIsOnPath() && !process.env.PASTE_REEXEC) {
    const { PATH } = await bunOnPath(join(appData, "bin"));
    const p = Bun.spawn([process.execPath, ...process.argv.slice(1)], { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, PATH, PASTE_REEXEC: "1" } });
    return await p.exited;
  }
  const idleMs = Number(flag(argv, "idle-minutes") ?? 10) * 60_000;
  const resources = flag(argv, "engine-resources") ?? process.env.POCKET_ENGINE_RESOURCES;
  const engine = await engineFor(appData, resources);
  if (engine && engineMissing(engine).length) console.error("daemon: engine incomplete");

  // The bundle's VERSION names the engine and core commits: the precompose cache key's code version.
  let bundled: string | undefined;
  try { if (resources) bundled = `${VERSION}+${(await Bun.file(join(resources, "VERSION")).text()).trim()}`; } catch { /* dev tree: hashed from core/src */ }
  const host: DaemonHost = {
    version: VERSION, appData, engine, ...(bundled ? { coreVersion: bundled } : {}), emojiBundle: resources ? join(resources, "emoji") : join(REPO_ROOT, ".work/emoji-all"),
    async resolveProviders(cfg) {
      const providers: ProvidersConfig = {
        decider: (cfg.decider as ProvidersConfig["decider"]) ?? { kind: "none" },
        generator: (cfg.generator as ProvidersConfig["generator"]) ?? { kind: "none" },
        offline: cfg.offline ?? false,
      };
      setOffline(providers.offline);
      setEgressLog(cfg.egressLog ?? join(appData, "egress.log"));
      const r = await resolveProviders(providers, memorySecretStore(cfg.secrets ?? {}), { cacheDir: join(appData, "answers") });
      return { decider: r.decider as never, generator: r.generator, names: { decider: providers.decider.kind, generator: providers.generator.kind, offline: providers.offline } };
    },
  };
  const daemon = new Daemon(host);
  await daemon.init();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => { stop = resolve; });
  const pauseIdle = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const touch = () => {
    pauseIdle();
    if (idleMs > 0) timer = setTimeout(() => {
      // Precompose work in the background is pending work too.
      if (daemon.busy()) { touch(); return; }
      console.error("daemon: idle, exiting"); stop(0);
    }, idleMs);
  };
  touch();

  const out = (o: unknown) => { process.stdout.write(JSON.stringify(o) + "\n"); };
  out({ id: 0, ok: true, cmd: "ready", version: VERSION, engine });

  (async () => {
    const reader = Bun.stdin.stream().getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done: eof } = await reader.read();
      if (eof) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        // A model/render task is active work even while it awaits a child or
        // network response. Start the idle deadline only after it finishes.
        pauseIdle();
        const req = parseRequest(line);
        if ("ok" in req) { out(req); touch(); continue; }
        const res = await daemon.handle(req, out);
        out(res);
        if (req.cmd === "shutdown") { stop(0); return; }
        touch();
      }
    }
    stop(0);
  })().catch((e) => { console.error(`daemon: ${(e as Error).message}`); stop(1); });

  try { return await done; }
  finally { pauseIdle(); }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
