/**
 * DSL → card. compose → engine build → one PNG frame, or every frame → GIF.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Catalog } from "../catalog.ts";
import type { Dsl } from "../dsl.ts";
import { ensureWorkTree, runEngine } from "../engine.ts";
import { composeCard, type ComposeResult } from "./compose.ts";
import { encodeCardGif } from "./gif.ts";

export interface RenderOptions {
  readonly engine: string;
  readonly work: string;
  readonly emojiCache: string;
  readonly emojiBundle?: string;
  /** The catalog with style packs merged in; the base one when absent. */
  readonly catalog?: Catalog;
  /** Output path; defaults to `<outDir>/card.png|gif`. */
  readonly out?: string;
  readonly outDir?: string;
}

export interface RenderResult extends ComposeResult {
  readonly path: string;
  readonly format: "png" | "gif";
  readonly ms: { readonly compose: number; readonly build: number; readonly frame: number };
}

/** compose + build; the composition is then ready for `frame` or `render`. */
export async function prepareCard(dsl: Dsl, o: RenderOptions): Promise<ComposeResult & { readonly ms: { compose: number; build: number } }> {
  await ensureWorkTree(o.engine, o.work);
  await mkdir(join(o.work, "compositions/paste"), { recursive: true });
  const t0 = performance.now();
  const composed = await composeCard(dsl, { engine: o.engine, work: o.work, emojiCache: o.emojiCache, emojiBundle: o.emojiBundle, catalog: o.catalog });
  const t1 = performance.now();
  await runEngine(o.work, ["build", "compositions/paste"]);
  const t2 = performance.now();
  return { ...composed, ms: { compose: Math.round(t1 - t0), build: Math.round(t2 - t1) } };
}

/** One frame of the prepared composition as PNG. */
export async function frameCard(o: RenderOptions, at: number, out: string): Promise<number> {
  await mkdir(dirname(out), { recursive: true });
  const r = await runEngine(o.work, ["frame", "compositions/paste", "--at", String(at), "--out", out]);
  return r.ms;
}

export async function renderCard(dsl: Dsl, o: RenderOptions): Promise<RenderResult> {
  const prepared = await prepareCard(dsl, o);
  const format = prepared.frames > 1 ? "gif" : "png";
  const path = o.out ? resolve(o.out) : join(o.outDir ?? o.work, `card.${format}`);
  await mkdir(dirname(path), { recursive: true });
  const t0 = performance.now();
  if (format === "gif") {
    await encodeCardGif({ engine: o.engine, work: o.work, out: path });
  } else {
    await runEngine(o.work, ["frame", "compositions/paste", "--at", "0", "--out", path]);
  }
  return { ...prepared, path, format, ms: { ...prepared.ms, frame: Math.round(performance.now() - t0) } };
}
