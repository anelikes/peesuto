/**
 * Answers cached by text. Jev is calibrated but not deterministic: the same
 * text can flip kind near p = 0.6 or move the emphasis between two words
 * from one call to the next. A paste of the same text should give the same
 * card, so the first answer is kept; "another take" asks again (`fresh`).
 *
 * One JSON file per key under `dir`; the key covers the text and the shape
 * of the questions, so a changed question set never reads stale answers.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Answers, JevRequest } from "../questions.ts";
import type { Provider } from "./types.ts";

export function answerKey(body: JevRequest): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(body.state.clipboard);
  h.update("\0");
  h.update(Object.keys(body.questions).sort().join(","));
  return h.digest("hex");
}

export function cachedProvider(inner: Provider, dir: string, o: { fresh?: boolean } = {}): Provider {
  return {
    name: inner.name,
    async ask(body) {
      const file = join(dir, `${answerKey(body)}.json`);
      if (!o.fresh && existsSync(file)) {
        try {
          const hit = JSON.parse(await readFile(file, "utf8")) as { provider: string; answers: Answers };
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
