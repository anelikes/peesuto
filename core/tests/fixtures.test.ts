/**
 * The five fixtures render byte-for-byte to the digests recorded at the
 * pinned engine. Skipped when no usable engine checkout is around (CI
 * without the engine, a contributor without the fonts).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseDsl } from "../src/dsl.ts";
import { engineMissing, REPO_ROOT } from "../src/engine.ts";
import { frameCard, prepareCard } from "../src/render/card.ts";

let engine: string | undefined;
try {
  const { engineRoot } = await import("../src/engine.ts");
  const root = engineRoot();
  if (engineMissing(root).length === 0) engine = root;
} catch { /* no engine */ }

const digests = (await Bun.file(join(REPO_ROOT, "core/fixtures/digests.json")).json()) as { frames: Record<string, Record<string, string>> };
const sha256 = async (p: string) => new Bun.CryptoHasher("sha256").update(await Bun.file(p).bytes()).digest("hex");

describe.skipIf(!engine)("fixtures render to their recorded digests", () => {
  const work = join(REPO_ROOT, ".work/test-tree");
  const out = join(REPO_ROOT, ".work/test-out");
  for (const [name, frames] of Object.entries(digests.frames)) {
    test(name, async () => {
      const dsl = parseDsl(await Bun.file(join(REPO_ROOT, `core/fixtures/${name}.json`)).json());
      const o = { engine: engine!, work, emojiCache: join(REPO_ROOT, ".work/emoji") };
      await prepareCard(dsl, o);
      for (const [at, want] of Object.entries(frames)) {
        const png = join(out, `${name}-${at}.png`);
        await frameCard(o, Number(at), png);
        expect(await sha256(png)).toBe(want);
      }
    }, 60_000);
  }
});
