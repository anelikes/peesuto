/**
 * Peesuto Studio: a local page for reviewing and iterating on the templates.
 *
 *   bun scripts/studio.ts [--port 4455] [--engine <prepared engine>] [--ffmpeg <path>] [--fresh-engine] [--no-open]
 *
 * Binds 127.0.0.1 only. The engine checkout (default .work/native-engine) is
 * copied once into .work/studio/.engine because its build tools write caches;
 * --fresh-engine copies it again. Renders are cached in .work/studio/cache by
 * content and template code version. See docs/studio.md.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startStudio } from "./studio/server.ts";

import { resolveVideoEncoder, videoAvailable } from "../core/src/render/video.ts";
const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const REPO = resolve(import.meta.dir, "..");
const root = join(REPO, ".work/studio");
const sourceEngine = resolve(flag("engine", join(REPO, ".work/native-engine"))!);
const port = Number(flag("port", "4455"));
const ffmpeg = flag("ffmpeg") ?? Bun.which("ffmpeg") ?? undefined;
// MP4: the native PeesutoEncoder (swift build) when built, else ffmpeg.
const mp4 = videoAvailable({ ffmpeg });

if (!existsSync(join(sourceEngine, "package.json"))) {
  console.error(`studio: no prepared engine at ${sourceEngine} (pass --engine <prepared pocket-motion checkout>)`);
  process.exit(1);
}

/** Copy the engine unless the copy already comes from the same checkout at the same commit. */
async function prepareEngine(): Promise<string> {
  const engine = join(root, ".engine");
  const marker = join(root, ".engine-source");
  const head = Bun.spawnSync(["git", "-C", sourceEngine, "rev-parse", "HEAD"]).stdout.toString().trim();
  const want = `${sourceEngine}\n${head}`;
  const have = existsSync(marker) ? await readFile(marker, "utf8") : "";
  if (argv.includes("--fresh-engine") || !existsSync(join(engine, "package.json")) || have !== want) {
    console.log(`studio: copying engine ${sourceEngine} → ${engine}`);
    await mkdir(root, { recursive: true });
    await rm(engine, { recursive: true, force: true });
    await cp(sourceEngine, engine, { recursive: true });
    await writeFile(marker, want);
  }
  return engine;
}

const studio = await startStudio({ repo: REPO, root, engine: await prepareEngine(), ffmpeg, video: mp4, port });
console.log(`studio: ${studio.url}  (code ${studio.version()}, ${mp4 ? `MP4 via ${resolveVideoEncoder({ ffmpeg }).kind}` : "no video encoder: MP4 off"}, Jev ${process.env.PASTE_CF_TOKEN && process.env.PASTE_CF_ACCOUNT_ID ? "available" : "off"})`);
if (!argv.includes("--no-open")) Bun.spawn(["open", studio.url]);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { studio.stop(); process.exit(0); });
