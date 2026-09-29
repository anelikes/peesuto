/**
 * @napi-rs/canvas (Skia), the Canvas 2D JIZURA draws with, loaded on demand.
 *
 * Two things are settled before the addon loads, because its loader acts on
 * them at import time:
 * - DISABLE_SYSTEM_FONTS_LOAD=1: the addon would otherwise register every
 *   font installed on the Mac, and a system face could stand in for one of
 *   ours (a render must look the same on every machine). Fonts are only the
 *   ones fonts.ts registers.
 * - NAPI_RS_NATIVE_LIBRARY_PATH: the platform binary, resolved here. Without
 *   it the loader probes other package names first (a universal build, then
 *   the per-arch package), and a Bun started without --no-install would try
 *   to fetch a missing one from the npm registry: a network request outside
 *   the egress layer.
 *
 * Failing to load (no binary for this platform, a damaged bundle) is a
 * JizuraUnavailableError: Lyric motion then renders with Pocket Motion and
 * says why (index.ts).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

export interface CanvasContext2D {
  canvas: CanvasElement;
  save(): void;
  restore(): void;
  beginPath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(): void;
  [key: string]: unknown;
}
export interface CanvasElement {
  width: number;
  height: number;
  getContext(kind: "2d", options?: { alpha?: boolean }): CanvasContext2D;
  /** The raw pixels, RGBA (premultiplied; opaque here). */
  data(): Uint8Array;
  encodeSync(format: "png"): Uint8Array;
}
export interface GlobalFontsApi {
  /** A key for `remove`, or null when the file is not a font it can read. One file is one entry, whatever the aliases. */
  registerFromPath(path: string, alias?: string): unknown;
  remove(key: unknown): boolean;
  has(family: string): boolean;
  readonly families: readonly { family: string; styles: readonly { weight: number; style: string }[] }[];
}
export interface CanvasModule {
  createCanvas(width: number, height: number): CanvasElement;
  readonly GlobalFonts: GlobalFontsApi;
  readonly Path2D: unknown;
  readonly DOMMatrix: unknown;
  readonly ImageData: unknown;
  readonly Image: unknown;
}

/** JIZURA cannot run here: the canvas addon did not load (or the bundle is missing). */
export class JizuraUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "JizuraUnavailableError"; }
}

const PLATFORM_PACKAGE: Record<string, string> = {
  "darwin-arm64": "@napi-rs/canvas-darwin-arm64",
  "darwin-x64": "@napi-rs/canvas-darwin-x64",
  "linux-x64": "@napi-rs/canvas-linux-x64-gnu",
  "linux-arm64": "@napi-rs/canvas-linux-arm64-gnu",
};

/** The addon binary for this platform, when it is installed next to Core. */
export function canvasBinary(): string | undefined {
  const name = PLATFORM_PACKAGE[`${process.platform}-${process.arch}`];
  if (!name) return;
  try {
    const require = createRequire(import.meta.url);
    const dir = dirname(require.resolve(`${name}/package.json`));
    const main = (require(`${name}/package.json`) as { main?: string }).main;
    const path = main ? join(dir, main) : undefined;
    return path && existsSync(path) ? path : undefined;
  } catch { return; }
}

let loading: Promise<CanvasModule> | undefined;

/** The canvas addon (once per thread). Rejects with JizuraUnavailableError. */
export function loadCanvas(): Promise<CanvasModule> {
  loading ??= (async () => {
    process.env.DISABLE_SYSTEM_FONTS_LOAD = "1";
    const binary = canvasBinary();
    if (!binary && !process.env.NAPI_RS_NATIVE_LIBRARY_PATH) throw new JizuraUnavailableError(`no canvas addon for ${process.platform}-${process.arch} (@napi-rs/canvas is not installed next to Core)`);
    if (binary) process.env.NAPI_RS_NATIVE_LIBRARY_PATH = binary;
    try {
      return (await import("@napi-rs/canvas")) as unknown as CanvasModule;
    } catch (e) {
      throw new JizuraUnavailableError(`the canvas addon did not load: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
  // A failed load is not cached: the next render tries again (and falls back again).
  loading.catch(() => { loading = undefined; });
  return loading;
}
