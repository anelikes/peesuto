/**
 * Loading actions: the built-ins, then `<dir>/*.json` user files, then packs
 * (`<packsDir>/<pack>/pack.json` + `<packsDir>/<pack>/actions/*.json`). A
 * user file may override a built-in by id, except it cannot mark itself
 * builtin. Bad files are reported, not fatal: one broken action must not
 * take the others down.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ASPECTS } from "../dsl.ts";
import { BUILTIN_ACTIONS } from "./builtin.ts";
import { ActionError, type ActionSpec } from "./types.ts";

const NEEDS = ["decider", "generator", "render", "none"] as const;
const OUTPUTS = ["text", "image", "gif", "video", "file"] as const;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parseActionSpec(raw: unknown, origin = "action"): ActionSpec {
  const bad = (m: string): never => { throw new ActionError("spec", `${origin}: ${m}`); };
  if (typeof raw !== "object" || raw === null) return bad("must be a JSON object");
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID.test(r.id)) bad("id must be lowercase letters, digits and dashes");
  if (typeof r.name !== "string" || !r.name.trim()) bad("name must be a non-empty string");
  if (r.input !== "clipboard" && r.input !== "item") bad("input must be clipboard or item");
  if (!NEEDS.includes(r.needs as never)) bad(`needs must be one of ${NEEDS.join("|")}`);
  if (!OUTPUTS.includes(r.output as never)) bad(`output must be one of ${OUTPUTS.join("|")}`);
  if (r.needs === "generator") {
    if (typeof r.prompt !== "string" || !r.prompt.includes("{{input}}")) bad("a generator action needs a prompt containing {{input}}");
    if (r.output !== "text") bad("a generator action outputs text");
  }
  if (r.needs === "render") {
    if (!["image", "gif", "video"].includes(r.output as string)) bad("a render action outputs image, gif or video");
    const ren = (r.render ?? {}) as Record<string, unknown>;
    if (ren.aspect !== undefined && !ASPECTS.includes(ren.aspect as never)) bad(`render.aspect must be one of ${ASPECTS.join("|")}`);
    if (ren.animate !== undefined && !["auto", "always", "never"].includes(ren.animate as string)) bad("render.animate must be auto, always or never");
  }
  if (r.trigger !== undefined) {
    if (typeof r.trigger !== "object" || r.trigger === null) bad("trigger must be an object");
    const t = r.trigger as Record<string, unknown>;
    if (t.hotkey !== undefined && typeof t.hotkey !== "string") bad("trigger.hotkey must be a string");
  }
  if (r.maxTokens !== undefined && (!Number.isInteger(r.maxTokens) || (r.maxTokens as number) <= 0)) bad("maxTokens must be a positive integer");
  const { builtin: _b, pack: _p, ...rest } = r;
  return rest as unknown as ActionSpec;
}

export interface LoadedActions {
  readonly actions: ActionSpec[];
  readonly problems: { readonly file: string; readonly message: string }[];
}

async function jsonFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((f) => f.endsWith(".json")).sort().map((f) => join(dir, f));
}

/** Built-ins, then user files, then packs; later definitions win by id. */
export async function loadActions(o: { userDir?: string; packsDir?: string } = {}): Promise<LoadedActions> {
  const byId = new Map<string, ActionSpec>(BUILTIN_ACTIONS.map((a) => [a.id, a]));
  const problems: LoadedActions["problems"] = [];
  const take = async (file: string, pack?: string) => {
    try {
      const spec = parseActionSpec(JSON.parse(await readFile(file, "utf8")), basename(file));
      byId.set(spec.id, pack ? { ...spec, pack } : spec);
    } catch (e) {
      problems.push({ file, message: e instanceof Error ? e.message : String(e) });
    }
  };
  if (o.userDir) for (const f of await jsonFiles(o.userDir)) await take(f);
  if (o.packsDir && existsSync(o.packsDir)) {
    for (const pack of (await readdir(o.packsDir)).sort()) {
      const manifest = join(o.packsDir, pack, "pack.json");
      if (!existsSync(manifest)) continue;
      let id = pack;
      try { id = (JSON.parse(await readFile(manifest, "utf8")) as { id?: string }).id ?? pack; } catch (e) { problems.push({ file: manifest, message: e instanceof Error ? e.message : String(e) }); continue; }
      for (const f of await jsonFiles(join(o.packsDir, pack, "actions"))) await take(f, id);
    }
  }
  return { actions: [...byId.values()], problems };
}
