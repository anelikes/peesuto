/**
 * The faces a JIZURA film draws with, and whether this machine has them.
 *
 * JIZURA names its faces by role key (gothic_black, mincho, dela, mono…);
 * each key is drawn with the face the lyric language maps it to (Noto Sans SC
 * for Chinese, the catalogue face for Japanese and English) and a CSS
 * fallback list behind it. Skia follows that list and nothing else (Core
 * disables system fonts, canvas.ts), so a character no face in the list has
 * is a box. Hence the families a film may draw with are every JIZURA face in
 * the list of every key the plan uses (J.fontsOfPlan), and the check before a
 * render is twofold: the faces it draws with first (the head of each list and
 * the language's base faces, `required`) resolve to files (core/src/fonts),
 * and every character of the lyric, title and credit is in some face of the
 * list of every such key. Either failing is a typed result, never a render
 * with boxes: Lyric motion then uses Pocket Motion and says why (index.ts).
 * The rest are fallbacks (every Chinese and Korean list ends in the Japanese
 * Noto faces): registered when this machine has them, a Latin cut included,
 * and never a reason on their own to ask for another language's pack.
 *
 * Fonts are registered with Skia once per process and file (the registry is
 * shared by every thread of the process), always under the family name
 * JIZURA asks for. Skia draws a family with the face registered first for a
 * weight, so a Latin cut registered by an earlier film (English lyrics, or a
 * fallback) would shadow the full face of a pack installed since, and its
 * CJK characters would draw as boxes: registering a full face drops the cuts
 * of its family first.
 */
import { JIZURA_FAMILIES, type JizuraFontFile } from "../fonts/jizura-packs.ts";
import type { CanvasModule } from "./canvas.ts";
import { fontCodepoints, invisible } from "./cmap.ts";
import type { JizuraApi, JizuraPlan } from "./realm.ts";

const KNOWN = new Set(JIZURA_FAMILIES);
const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");

/** The JIZURA families in a CSS font list, in order. */
export const familiesOfList = (list: string): string[] => list.split(",").map(unquote).filter((f) => KNOWN.has(f));

export interface PlanFaces {
  /** Every JIZURA family the plan may draw with (primary faces and their fallbacks), sorted. */
  readonly families: readonly string[];
  /** The ones it draws with first: the head of each key's list and the language's base faces, sorted. */
  readonly required: readonly string[];
  /** Per role key the plan uses: the families of its font list, in order. */
  readonly chains: Readonly<Record<string, readonly string[]>>;
}

/** The faces of `plan` (its language is set on J first). */
export function planFaces(J: JizuraApi, plan: JizuraPlan): PlanFaces {
  J.setLang(plan.lang);
  const keys = J.fontsOfPlan(plan).filter((k) => k !== "@var" && J.FONTS[k]);
  const chains: Record<string, string[]> = {};
  const all = new Set<string>(), required = new Set<string>();
  for (const key of keys) {
    const face = J.faceOf(key);
    const chain = [...new Set([...familiesOfList(face.family), ...familiesOfList(face.fb)])];
    chains[key] = chain;
    for (const f of chain) all.add(f);
    if (chain[0]) required.add(chain[0]);
  }
  for (const b of J.langBaseFaces(keys)) if (KNOWN.has(b.family)) { all.add(b.family); required.add(b.family); }
  return { families: [...all].sort(), required: [...required].sort(), chains };
}

const registered = new Set<string>();
/** Latin cuts registered in this thread, by family, with their Skia keys. */
const cuts = new Map<string, { path: string; key: unknown }[]>();

/** Register `files` with Skia (each path once per process), under the family JIZURA asks for. */
export function registerFonts(canvas: CanvasModule, files: readonly JizuraFontFile[]): { registered: number; failed: string[] } {
  let n = 0;
  const failed: string[] = [];
  for (const family of new Set(files.filter((f) => !f.cut).map((f) => f.family))) {
    for (const c of cuts.get(family) ?? []) { canvas.GlobalFonts.remove(c.key); registered.delete(`${family}\0${c.path}`); }
    cuts.delete(family);
  }
  for (const f of files) {
    const key = `${f.family}\0${f.path}`;
    if (registered.has(key)) continue;
    const k = canvas.GlobalFonts.registerFromPath(f.path, f.family);
    if (!k) { failed.push(f.path); continue; }
    registered.add(key);
    n++;
    if (f.cut) cuts.set(f.family, [...(cuts.get(f.family) ?? []), { path: f.path, key: k }]);
  }
  return { registered: n, failed };
}

/**
 * Characters of `text` that some key's font list cannot draw with `files`.
 * A family covers a character when any of its files maps it; a file this
 * reader cannot open (WOFF 1) is taken to cover everything.
 */
export function uncovered(text: string, faces: PlanFaces, files: readonly JizuraFontFile[]): string[] {
  const byFamily = new Map<string, JizuraFontFile[]>();
  for (const f of files) byFamily.set(f.family, [...(byFamily.get(f.family) ?? []), f]);
  const covers = (family: string, c: number) => (byFamily.get(family) ?? []).some((f) => { const set = fontCodepoints(f.path); return set === null || set.has(c); });
  const missing = new Set<string>();
  const chars = [...new Set([...text])];
  for (const ch of chars) {
    const c = ch.codePointAt(0)!;
    if (invisible(c)) continue;
    for (const chain of Object.values(faces.chains)) if (!chain.some((family) => covers(family, c))) { missing.add(ch); break; }
  }
  return [...missing];
}
