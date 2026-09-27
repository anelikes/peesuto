/**
 * A realm for JIZURA: a node:vm context of its own, with the few browser
 * pieces the engine touches, over the compiled bundle (bundle.ts). Nothing
 * here edits JIZURA; everything it needs is provided around it:
 *
 * - `window` is the context's global, `document` a stand-in whose
 *   createElement('canvas') makes a Skia canvas (canvas.ts). getElementById
 *   finds nothing, so the editor UI (src/12_ui.js) returns at once, and there
 *   is no <head>, so the engine never attaches a Google Fonts stylesheet:
 *   fonts are only what fonts.ts registered, and nothing is fetched.
 * - Path2D, DOMMatrix, ImageData and Image are the addon's.
 * - Math.random is seeded. The engine's own choices hash a seed (J.h, J.r);
 *   Math.random only paints its textures (the four grain tiles a Renderer
 *   makes, the paper it makes on first use), so a realm seeded the same way
 *   paints the same textures. It is the realm's own Math: Core's is untouched.
 * - console.warn/error are kept (a part that throws is skipped by the engine
 *   with a warning), not printed.
 *
 * A realm is cheap to make (the script is compiled once per thread; running
 * it is a few milliseconds), and the frame renderer makes a fresh one for
 * every chunk of frames (render.ts), so no state carries over between chunks.
 */
import vm from "node:vm";
import { jizuraScript } from "./bundle.ts";
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

/** A fresh realm over the engine at `bundlePath`, its Math.random seeded with `seed`. */
export function createRealm(canvas: CanvasModule, bundlePath: string, seed: number): JizuraRealm {
  const { script } = jizuraScript(bundlePath);
  const warnings: string[] = [];
  const keep = (...args: unknown[]) => {
    if (warnings.length < 200) warnings.push(args.map((a) => (a instanceof Error ? a.stack?.split("\n").slice(0, 2).join(" | ") ?? a.message : String(a))).join(" ").slice(0, 400));
  };
  const document = {
    createElement(tag: string) {
      if (tag !== "canvas") throw new Error(`jizura realm: document.createElement(${JSON.stringify(tag)}) is not available`);
      return canvas.createCanvas(300, 150);
    },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    documentElement: { lang: "ja" },
    head: null, body: null, hidden: false, readyState: "complete",
    fonts: { load: async () => [], add() {}, check: () => true, ready: Promise.resolve() },
  };
  const sandbox: Record<string, unknown> = {
    document,
    Path2D: canvas.Path2D, DOMMatrix: canvas.DOMMatrix, ImageData: canvas.ImageData, Image: canvas.Image,
    console: { log() {}, info() {}, debug() {}, warn: keep, error: keep },
    performance,
    // The engine's font loader waits on a timer only when it attaches a stylesheet, which it never does here.
    setTimeout: (fn: () => void) => { queueMicrotask(fn); return 0; },
    clearTimeout() {},
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox, { name: "jizura" });
  const setSeed = vm.runInContext(`(function (rng) { Math.random = rng; })`, context) as (rng: () => number) => void;
  const reseed = (n: number) => setSeed(mulberry32(n));
  reseed(seed);
  script.runInContext(context);
  const J = sandbox.J as JizuraApi | undefined;
  if (!J || typeof J.plan !== "function" || typeof J.Renderer !== "function") throw new Error("jizura realm: the bundle did not define J.plan and J.Renderer");
  return { J, warnings, seed: reseed };
}
