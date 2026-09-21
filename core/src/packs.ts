/**
 * Packs: directories under `<appData>/packs/` with a `pack.json`. An
 * actions pack carries `actions/*.json` (loaded by actions/load.ts); a
 * styles pack carries `catalog.json`, a fragment of the catalog merged over
 * the base — more palettes, later more layouts and kinds. Anyone can put a
 * pack there by hand; the subscription only installs the official ones.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BASE_CATALOG, mergeCatalog, type Catalog, type Colors } from "./catalog.ts";

export interface PackManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: "actions" | "styles";
  readonly minApp?: string;
}

export interface LoadedPacks {
  readonly catalog: Catalog;
  readonly packs: PackManifest[];
  readonly problems: { readonly file: string; readonly message: string }[];
}

export class PackError extends Error {}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEX = /^#[0-9a-f]{6}$/i;

export function parsePackManifest(raw: unknown, origin = "pack.json"): PackManifest {
  const bad = (m: string): never => { throw new PackError(`${origin}: ${m}`); };
  if (typeof raw !== "object" || raw === null) return bad("must be a JSON object");
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID.test(r.id)) bad("id must be lowercase letters, digits and dashes");
  if (typeof r.name !== "string" || !r.name.trim()) bad("name must be a non-empty string");
  if (typeof r.version !== "string" || !r.version.trim()) bad("version must be a non-empty string");
  if (r.kind !== "actions" && r.kind !== "styles") bad("kind must be actions or styles");
  if (r.minApp !== undefined && typeof r.minApp !== "string") bad("minApp must be a string");
  return { id: r.id, name: r.name, version: r.version, kind: r.kind, ...(r.minApp !== undefined ? { minApp: r.minApp } : {}) } as PackManifest;
}

/** A catalog fragment: today palettes only; layouts and kinds need templates in code. */
export function parseCatalogFragment(raw: unknown, origin = "catalog.json"): Partial<Catalog> {
  const bad = (m: string): never => { throw new PackError(`${origin}: ${m}`); };
  if (typeof raw !== "object" || raw === null) return bad("must be a JSON object");
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (k !== "palettes") bad(`unknown key ${k} (a fragment carries palettes)`);
  const palettes: Record<string, { description: string; colors: Colors }> = {};
  const src = (r.palettes ?? {}) as Record<string, unknown>;
  if (typeof src !== "object" || src === null || Array.isArray(src)) bad("palettes must be an object");
  for (const [name, entry] of Object.entries(src)) {
    if (!ID.test(name)) bad(`palette name ${name} must be lowercase letters, digits and dashes`);
    const e = entry as { description?: unknown; colors?: Record<string, unknown> };
    if (typeof e?.description !== "string" || !e.description.trim()) bad(`palette ${name}: description must be a sentence for the decider`);
    const c = e.colors ?? {};
    for (const role of ["bg", "bg2", "ink", "muted", "accent"] as const) if (typeof c[role] !== "string" || !HEX.test(c[role] as string)) bad(`palette ${name}: colors.${role} must be #rrggbb`);
    palettes[name] = { description: e.description as string, colors: { bg: c.bg as string, bg2: c.bg2 as string, ink: c.ink as string, muted: c.muted as string, accent: c.accent as string } };
  }
  return { palettes };
}

/** Every pack under `packsDir`, and the catalog with the style packs merged in (later packs win by name). */
export async function loadPacks(packsDir: string | undefined, base: Catalog = BASE_CATALOG): Promise<LoadedPacks> {
  let catalog = base;
  const packs: PackManifest[] = [];
  const problems: LoadedPacks["problems"] = [];
  if (!packsDir || !existsSync(packsDir)) return { catalog, packs, problems };
  for (const dir of (await readdir(packsDir)).sort()) {
    const manifest = join(packsDir, dir, "pack.json");
    if (!existsSync(manifest)) continue;
    try {
      const pack = parsePackManifest(JSON.parse(await readFile(manifest, "utf8")), manifest);
      packs.push(pack);
      if (pack.kind === "styles") {
        const frag = join(packsDir, dir, "catalog.json");
        if (!existsSync(frag)) throw new PackError(`${frag}: a styles pack needs a catalog.json`);
        catalog = mergeCatalog(catalog, parseCatalogFragment(JSON.parse(await readFile(frag, "utf8")), frag));
      }
    } catch (e) {
      problems.push({ file: manifest, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { catalog, packs, problems };
}
