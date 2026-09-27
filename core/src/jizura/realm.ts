/**
 * JIZURA engine instances: the vendored bundle (bundle.ts) evaluated inside
 * a node:vm context of its own, with the few browser pieces the engine
 * touches. Nothing here edits JIZURA; everything it needs is provided
 * around it:
 *
 * - `window` is a fresh object per instance, `document` a stand-in whose
 *   createElement('canvas') makes a Skia canvas (canvas.ts). getElementById
 *   finds nothing, so the editor UI (src/12_ui.js) returns at once, and there
 *   is no <head>, so the engine never attaches a Google Fonts stylesheet:
 *   fonts are only what fonts.ts registered, and nothing is fetched.
 * - Path2D, DOMMatrix, ImageData and Image are the addon's.
 * - Math.random is seeded. The engine's own choices hash a seed (J.h, J.r);
 *   Math.random only paints its textures (the four grain tiles a Renderer
 *   makes, the paper it makes on first use), so an instance seeded the same
 *   way paints the same textures. It is the context's own Math: Core's is
 *   untouched.
 * - console.warn/error are kept per instance (a part that throws is skipped
 *   by the engine with a warning), not printed.
 *
 * One context per thread and bundle: the bundle's source is wrapped in a
 * function of (window, document) and each instance is a call of it, so every
 * instance starts with the engine's module state fresh (its caches, the J
 * object and everything registered on it) while the compiled and optimised
 * code is shared, not warmed up again. The frame renderer makes an instance
 * per chunk of frames (render.ts), so no state carries over between chunks.
 */
import vm from "node:vm";
import { jizuraSource } from "./bundle.ts";
import type { CanvasContext2D, CanvasModule } from "./canvas.ts";

/* ---- the parts of JIZURA's API Core uses (J.*) ------------------------------ */
export interface JizuraLine { readonly text: string; readonly lrc: number | null; readonly interlude?: boolean; readonly manual: readonly string[] | null; readonly gapBefore: boolean }
export interface JizuraCut {
  readonly index: number; readonly line: number; readonly start: number; readonly end: number; readonly text?: string;
  readonly layout?: string; readonly enter?: string; readonly exit?: string; readonly hold?: string; readonly treat?: string; readonly bg?: string; readonly cam?: string; readonly trans?: string;
  readonly decor?: readonly { readonly id: string }[];
}
export interface JizuraPlan {
  readonly W: number; readonly H: number; readonly fps: number; readonly duration: number; readonly lang: string; readonly styleKey: string;
  readonly cuts: readonly JizuraCut[];
  readonly events: readonly { readonly t: number; readonly type: string; readonly dur: number }[];
  readonly style: { readonly fonts: Record<string, readonly string[]> };
}
export type JizuraProject = Record<string, unknown> & {
  lyrics: string; style: string; mood: string | null; seed: number; aspect: string; fps: number;
  fx: Record<string, unknown>; enabled: Record<string, Record<string, boolean>>; timing: Record<string, unknown>;
  fonts: Record<string, string>; colors: Record<string, unknown>;
};
export interface JizuraFace { readonly family: string; readonly weight: number; readonly fb: string; readonly kind?: string }
export interface JizuraRenderer { frame(ctx: CanvasContext2D, plan: JizuraPlan, t: number, opt?: { scale?: number; fast?: boolean; noPost?: boolean }): void }
export interface JizuraApi {
  defaultProject(): JizuraProject;
  plan(project: JizuraProject, audio: null): JizuraPlan;
  parseLyrics(raw: string): { lines: JizuraLine[]; meta: Record<string, string> };
  omakase(project: JizuraProject, rnd: () => number): { mood: string; style: string; fx: Record<string, unknown>; enabled: Record<string, Record<string, boolean>>; fonts: Record<string, string>; colors: Record<string, unknown>; seed: number };
  Renderer: new () => JizuraRenderer;
  glyphs: { maxRes: number };
  fontsOfPlan(plan: JizuraPlan): string[];
  faceOf(key: string): JizuraFace;
  langBaseFaces(keys: readonly string[]): readonly { family: string; weight: number }[];
  setLang(lang: string): void;
  resolveLang(project: JizuraProject): string;
  FONTS: Record<string, { family: string; weight: number; kind: string; fb: string }>;
  STYLES: Record<string, { name: string; set?: string; extra?: boolean }>;
  STYLE_ORDER: string[];
  MOODS: Record<string, { name: string; set?: string }>;
  GROUP_KEYS: string[];
  order(group: string): string[];
  registry(group: string): Record<string, { name: string; set?: string; extra?: boolean; wa?: boolean; pack?: string }>;
  randomOk(project: JizuraProject, group: string, key: string): boolean;
  /** The part set an entry belongs to (horror, typo, kinetic), or null. */
  setOf(group: string, key: string): string | null;
  cutAt(plan: JizuraPlan, t: number): JizuraCut | null;
}

export interface JizuraRealm {
  readonly J: JizuraApi;
  /** What the engine warned about (a part that threw and was skipped), in order. */
  readonly warnings: string[];
  /** Reseed the realm's Math.random. */
  seed(seed: number): void;
  /** Free the pixels of every canvas the engine made (the realm is not used again). */
  dispose(): void;
}

/** mulberry32, as the engine's own J.rng. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Context {
  readonly factory: (window: Record<string, unknown>, document: unknown) => JizuraApi | undefined;
  readonly setSeed: (rng: () => number) => void;
  /** Where this context's console sends warnings (the current instance's list). */
  sink: string[];
}
const contexts = new Map<string, Context>();

function contextFor(canvas: CanvasModule, bundlePath: string): Context {
  let c = contexts.get(bundlePath);
  if (c) return c;
  const { source } = jizuraSource(bundlePath);
  const keep = (...args: unknown[]) => {
    if (ctx.sink.length < 200) ctx.sink.push(args.map((a) => (a instanceof Error ? a.stack?.split("\n").slice(0, 2).join(" | ") ?? a.message : String(a))).join(" ").slice(0, 400));
  };
  const sandbox: Record<string, unknown> = {
    Path2D: canvas.Path2D, DOMMatrix: canvas.DOMMatrix, ImageData: canvas.ImageData, Image: canvas.Image,
    console: { log() {}, info() {}, debug() {}, warn: keep, error: keep },
    performance,
    // The engine's font loader waits on a timer only when it attaches a stylesheet, which it never does here.
    setTimeout: (fn: () => void) => { queueMicrotask(fn); return 0; },
    clearTimeout() {},
  };
  const context = vm.createContext(sandbox, { name: "jizura" });
  // The bundle unchanged, as the body of a function: each call is a fresh engine.
  const factory = new vm.Script(`(function (window, document) {\n${source}\n;return window.J;\n})`, { filename: "jizura.js", lineOffset: -1 }).runInContext(context) as Context["factory"];
  const setSeed = vm.runInContext(`(function (rng) { Math.random = rng; })`, context) as Context["setSeed"];
  const ctx: Context = { factory, setSeed, sink: [] };
  contexts.set(bundlePath, ctx);
  c = ctx;
  return c;
}

/** A fresh engine instance over the bundle at `bundlePath`, Math.random seeded with `seed`. */
export function createRealm(canvas: CanvasModule, bundlePath: string, seed: number): JizuraRealm {
  const c = contextFor(canvas, bundlePath);
  const warnings: string[] = [];
  // Every canvas the engine makes (scratch layers, glyph pieces, textures, caches): their Skia
  // surfaces live outside the JS heap, so the collector does not hurry; dispose() frees them.
  const canvases: { width: number; height: number }[] = [];
  const document = {
    createElement(tag: string) {
      if (tag !== "canvas") throw new Error(`jizura realm: document.createElement(${JSON.stringify(tag)}) is not available`);
      const made = canvas.createCanvas(300, 150);
      canvases.push(made);
      return made;
    },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    documentElement: { lang: "ja" },
    head: null, body: null, hidden: false, readyState: "complete",
    fonts: { load: async () => [], add() {}, check: () => true, ready: Promise.resolve() },
  };
  const reseed = (n: number) => c.setSeed(mulberry32(n));
  reseed(seed);
  c.sink = warnings;
  const window: Record<string, unknown> = { document };
  const J = c.factory(window, document);
  if (!J || typeof J.plan !== "function" || typeof J.Renderer !== "function") throw new Error("jizura realm: the bundle did not define J.plan and J.Renderer");
  stableGlyphPieces(J);
  const dispose = () => { for (const made of canvases.splice(0)) { made.width = 1; made.height = 1; } };
  return { J, warnings, seed: reseed, dispose };
}

interface GlyphPiece { id: number; frags: unknown; [key: string]: unknown }
interface Glyph { ch: string; res: number; pieces: GlyphPiece[]; frags?: unknown }

/** FNV-1a, 32 bits, from `basis`. */
function fnv(text: string, basis: number): number {
  let h = basis >>> 0;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Glyph pieces that are the same whatever was drawn before. JIZURA cuts a
 * glyph into pieces (strokes, dots) for effects that fly, drop or dissolve
 * them, numbers each piece from one running counter in the order glyphs are
 * first cut, and seeds each piece's randomness with that number; a shattered
 * glyph also keeps the fragments of the first item that shattered it. So in
 * one long run a piece's motion depends on everything drawn before, and an
 * engine instance that starts mid-film (render.ts draws chunks on fresh
 * instances) would draw the same dissolve differently. Here a piece's number
 * is a hash of its face, character, resolution and index (53 bits: the tint
 * cache keys on it), and each lookup hands out fresh piece records, so
 * fragments follow the item that asks. The pieces' pixels are JIZURA's own.
 */
function stableGlyphPieces(J: JizuraApi): void {
  const cache = J.glyphs as unknown as { get(font: string, ch: string, px: number): Glyph };
  const get = cache.get.bind(cache);
  cache.get = (font: string, ch: string, px: number): Glyph => {
    const glyph = get(font, ch, px);
    const key = `${font}\u0000${ch}\u0000${glyph.res}\u0000`;
    return { ch: glyph.ch, res: glyph.res, pieces: glyph.pieces.map((p, i) => ({ ...p, id: fnv(key + i, 2166136261) * 2097152 + (fnv(key + i, 0x811c9dc5 ^ 0x5bd1e995) >>> 11), frags: null })) };
  };
}
