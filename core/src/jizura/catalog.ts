/**
 * Lyric motion's styles, as data Core reports to the app: "auto" (JIZURA's
 * おまかせ, picked from the text), JIZURA's 24 styles (and its three horror
 * ones, only with the horror switch), and Peesuto's four classic styles,
 * drawn by Pocket Motion. Names come from JIZURA itself (Japanese) and from
 * its English and Simplified Chinese editions, via vendor/jizura/catalog.json
 * (scripts/jizura.ts writes it at the pin); the classic ones from Core's
 * template registry.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TEMPLATE_REGISTRY } from "../templates/registry.ts";
import { jizuraBundlePath } from "./bundle.ts";

export type LyricEngine = "jizura" | "classic";
export interface Labels { readonly en: string; readonly ja: string; readonly "zh-Hans": string }

export interface LyricStyle {
  /** "auto", a JIZURA style key (noir, sakura…), or a classic variant id (classic, editorial, pop, night). */
  readonly id: string;
  readonly engine: LyricEngine;
  readonly name: Labels;
  readonly description?: Labels;
  /** A horror style: offered only with the horror switch on. */
  readonly horror?: boolean;
  /** JIZURA's 追加分: added after its first release. */
  readonly extra?: boolean;
}

interface CatalogFile {
  readonly sets: Record<string, { readonly on: boolean }>;
  readonly styles: readonly { key: string; ja: [string, string]; en?: [string, string]; "zh-Hans"?: [string, string]; set: string | null; extra: boolean; moods: string[] }[];
  readonly moods: readonly { key: string; ja: string; en: string | null; "zh-Hans": string | null; set: string | null }[];
  readonly parts: Record<string, { total: number; sets: Record<string, number>; extra: number; wa: number }>;
}

let cached: CatalogFile | undefined;
/** vendor/jizura/catalog.json (next to the engine bundle). */
export function jizuraCatalog(): CatalogFile {
  if (cached) return cached;
  let path: string;
  try { path = join(dirname(jizuraBundlePath()), "catalog.json"); } catch { path = ""; }
  cached = path && existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as CatalogFile) : { sets: {}, styles: [], moods: [], parts: {} };
  return cached;
}

export const AUTO_STYLE = "auto";

/** The classic (Pocket Motion) styles: Lyric motion's registered variants. Japanese names as the app shows them. */
const CLASSIC_JA: Record<string, string> = { classic: "ステージ", editorial: "ペーパー", pop: "ポップ", night: "ナイト" };
export function classicLyricStyles(): LyricStyle[] {
  const lyrics = TEMPLATE_REGISTRY.find((r) => r.id === "lyrics");
  return (lyrics?.variants ?? []).map((v) => ({ id: v.id, engine: "classic", name: { en: v.name, ja: CLASSIC_JA[v.id] ?? v.name, "zh-Hans": v.nameZh } }));
}
export const isClassicLyricStyle = (id: string): boolean => classicLyricStyles().some((s) => s.id === id);

/** Every Lyric motion style: auto, JIZURA's (horror ones only with `horror`), then the classic ones. */
export function lyricStyles(o: { readonly horror?: boolean } = {}): LyricStyle[] {
  const c = jizuraCatalog();
  const out: LyricStyle[] = [{
    id: AUTO_STYLE, engine: "jizura",
    name: { en: "Auto", ja: "おまかせ", "zh-Hans": "自动" },
    description: { en: "JIZURA picks a style and a mood from the text", ja: "文字から JIZURA がスタイルと雰囲気を選びます", "zh-Hans": "由 JIZURA 按文字挑选风格与氛围" },
  }];
  for (const s of c.styles) {
    const horror = s.set === "horror";
    if (horror && !o.horror) continue;
    out.push({
      id: s.key, engine: "jizura",
      name: { ja: s.ja[0], en: s.en?.[0] ?? s.ja[0], "zh-Hans": s["zh-Hans"]?.[0] ?? s.en?.[0] ?? s.ja[0] },
      description: { ja: s.ja[1], en: s.en?.[1] ?? s.ja[1], "zh-Hans": s["zh-Hans"]?.[1] ?? s.en?.[1] ?? s.ja[1] },
      ...(horror ? { horror: true } : {}), ...(s.extra ? { extra: true } : {}),
    });
  }
  return [...out, ...classicLyricStyles()];
}

/** A JIZURA style key (any, horror included), or undefined. */
export function jizuraStyleOf(id: string): { readonly key: string; readonly horror: boolean } | undefined {
  const s = jizuraCatalog().styles.find((x) => x.key === id);
  return s && { key: s.key, horror: s.set === "horror" };
}
