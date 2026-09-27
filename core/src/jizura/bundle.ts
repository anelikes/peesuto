/**
 * The vendored engine, vendor/jizura/jizura.js: JIZURA's src/*.js at the
 * commit jizura.json pins, joined as its build.py does and unmodified
 * (scripts/jizura.ts builds and checks it). Found, in order:
 *   PEESUTO_JIZURA_BUNDLE   an explicit path (tests, tools)
 *   <repo>/vendor/jizura    a checkout (this file is core/src/jizura/bundle.ts)
 *   <resources>/vendor/jizura  the app bundle (Core is copied to <resources>/core)
 *
 * The source is read once per thread; realm.ts evaluates it once per thread
 * inside a vm context and makes engine instances from it.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JizuraUnavailableError } from "./canvas.ts";

const CANDIDATES = [
  new URL("../../../vendor/jizura/jizura.js", import.meta.url),
  new URL("../../vendor/jizura/jizura.js", import.meta.url),
].map((u) => fileURLToPath(u));

/** Where the engine bundle is (JizuraUnavailableError when nowhere). */
export function jizuraBundlePath(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.PEESUTO_JIZURA_BUNDLE?.trim();
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    throw new JizuraUnavailableError(`PEESUTO_JIZURA_BUNDLE points at ${explicit}, which does not exist`);
  }
  const found = CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new JizuraUnavailableError("the JIZURA engine bundle (vendor/jizura/jizura.js) is missing");
  return found;
}

export interface JizuraBundleInfo {
  readonly path: string;
  readonly version: string;
  readonly commit: string;
}

const read = new Map<string, { source: string; info: JizuraBundleInfo }>();

/** The engine's source at `path` (read once per thread), and the version and commit its header names. */
export function jizuraSource(path: string): { source: string; info: JizuraBundleInfo } {
  let hit = read.get(path);
  if (hit) return hit;
  let source: string;
  try { source = readFileSync(path, "utf8"); }
  catch (e) { throw new JizuraUnavailableError(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`); }
  const head = source.slice(0, 600);
  const version = /JIZURA (\d+\.\d+\.\d+)/.exec(head)?.[1] ?? "unknown";
  const commit = /at ([0-9a-f]{40})/.exec(head)?.[1] ?? "unknown";
  hit = { source, info: { path, version, commit } };
  read.set(path, hit);
  return hit;
}
