/**
 * Answers cached by content. Jev is calibrated but not deterministic: the
 * same text can flip kind near p = 0.6 or move the emphasis between two
 * words from one call to the next. The same request should get the same
 * answer, so the first one is kept; "another take" asks again (`fresh`).
 *
 * One JSON file per key under `dir`. The key covers the whole `state`
 * (canonical JSON, so a card's clipboard and a pick's app, role and
 * candidates all count), the question names, and for every choice question
 * its criteria names — a different candidate set never reuses an answer,
 * and a changed question set never reads a stale one.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JevAnswers, JevRequest } from "../questions.ts";
import type { Decider } from "./decider/types.ts";

/** JSON with object keys sorted at every level; `undefined` values are dropped as JSON.stringify drops them. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export function answerKey(body: JevRequest): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(canonicalJson(body.state));
  h.update("\0");
  for (const name of Object.keys(body.questions).sort()) {
    const q = body.questions[name] as { type?: unknown; criteria?: unknown } | undefined;
    h.update(name);
    if (q?.type === "choice" && q.criteria && typeof q.criteria === "object") h.update(`(${Object.keys(q.criteria).sort().join(",")})`);
    h.update(",");
  }
  return h.digest("hex");
}

export function cachedProvider(inner: Decider, dir: string, o: { fresh?: boolean } = {}): Decider {
  return {
    name: inner.name,
    async ask(body) {
      const file = join(dir, `${answerKey(body)}.json`);
      if (!o.fresh && existsSync(file)) {
        try {
          const hit = JSON.parse(await readFile(file, "utf8")) as { provider: string; answers: JevAnswers };
          if (hit.answers && typeof hit.answers === "object") return hit.answers;
        } catch { /* unreadable: ask again */ }
      }
      const answers = await inner.ask(body);
      if (answers) {
        await mkdir(dir, { recursive: true });
        await writeFile(file, JSON.stringify({ provider: inner.name, at: new Date().toISOString(), answers }, null, 2));
      }
      return answers;
    },
  };
}
