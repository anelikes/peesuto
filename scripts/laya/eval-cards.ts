/**
 * The card corpus through any Jev-shaped endpoint (scripts/laya/server.py, the
 * dev proxy, …): per-sample answers and DSL, latency, kind accuracy against the
 * slug, confusion. Recorded in baselines/laya.md.
 *   bun scripts/laya/eval-cards.ts http://127.0.0.1:8790/v1/ask [limit]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_CATALOG } from "../../core/src/catalog.ts";
import { answersToDsl, buildRequest, isCardAnswers, KIND_CONFIDENCE } from "../../core/src/questions.ts";
const ROOT = join(import.meta.dir, "../..");
const url = process.argv[2] ?? "http://127.0.0.1:8790/v1/ask";
const limit = Number(process.argv[3] ?? 1000);
const dir = join(ROOT, "core/fixtures/corpus");
const files = readdirSync(dir).filter((f) => f.endsWith(".txt")).sort().slice(0, limit);
const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const kinds = new Map<string, number>(), layouts = new Map<string, number>(), palettes = new Map<string, number>(), scales = new Map<string, number>(), tones = new Map<string, number>();
let animateYes = 0, lowConf = 0, bad = 0; const lat: number[] = []; const rows: string[] = [];
/** Expected kind from the sample's slug: what a good decider should say (event has no template, so a date is "event" here). */
const expectedKind = (f: string): string | null => {
  const m = /^\d+-([a-z]+)-/.exec(f); const g = m?.[1] ?? "";
  return ({ chat: "plain", para: "plain", url: "plain", code: "code", log: "plain", list: "list", quote: "quote", stat: "stat", date: "event", poem: "plain", tweet: "plain", email: "plain", address: "plain", markdown: "plain" } as Record<string, string>)[g] ?? null;
};
let kindRight = 0, kindTotal = 0, kindRightConf = 0, kindTotalConf = 0; const confusion = new Map<string, number>();
for (const f of files) {
  const text = readFileSync(join(dir, f), "utf8");
  const req = buildRequest(text, BASE_CATALOG).body;
  const t0 = performance.now();
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
  const json = await res.json() as any;
  lat.push(performance.now() - t0);
  const a = json?.result?.answers ?? json?.answers;
  if (!res.ok || !isCardAnswers(a)) { bad++; rows.push(`${f}: BAD ${res.status} ${JSON.stringify(json).slice(0, 160)}`); continue; }
  const { dsl, kindP } = answersToDsl(text, a, "chat", BASE_CATALOG);
  const exp = expectedKind(f);
  if (exp) { kindTotal++; if (a.kind.choice === exp) kindRight++; count(confusion, `${exp}→${a.kind.choice}`); if (kindP >= KIND_CONFIDENCE) { kindTotalConf++; if (a.kind.choice === exp) kindRightConf++; } }
  count(kinds, `${a.kind.choice}→${dsl.kind}`); count(layouts, dsl.layout); count(palettes, dsl.palette); count(scales, String(dsl.scale)); count(tones, String(dsl.tone));
  if (dsl.animate) animateYes++; if (kindP < KIND_CONFIDENCE) lowConf++;
  const emph = dsl.emphasis === undefined ? "-" : String(dsl.emphasis);
  rows.push(`${f.padEnd(34)} kind=${a.kind.choice.padEnd(6)} p=${kindP.toFixed(2)} → ${dsl.kind.padEnd(5)} ${dsl.layout.padEnd(6)} ${dsl.palette.padEnd(5)} s${dsl.scale} t${dsl.tone} ${dsl.animate ? "anim" : "    "} e=${emph.padEnd(3)} noul=${a.animate.noul.toFixed(2)} | ${text.split("\n")[0]!.slice(0, 40).replace(/\s+/g, " ")}`);
}
const sorted = [...lat].sort((x, y) => x - y); const p = (q: number) => sorted[Math.floor(q * (sorted.length - 1))]!.toFixed(0);
console.log(rows.join("\n"));
console.log(`\nsamples ${files.length}, bad ${bad}, latency p50 ${p(0.5)} ms p90 ${p(0.9)} ms max ${p(1)} ms`);
const show = (n: string, m: Map<string, number>) => console.log(`${n}: ${[...m.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${v}`).join(" ")}`);
show("kind (chosen→used)", kinds); show("layout", layouts); show("palette", palettes); show("scale", scales); show("tone", tones);
console.log(`animate=yes ${animateYes}, kind below confidence ${KIND_CONFIDENCE}: ${lowConf}`);
console.log(`kind accuracy vs slug: ${kindRight}/${kindTotal} (${Math.round(100 * kindRight / Math.max(1, kindTotal))}%); among confident (p>=${KIND_CONFIDENCE}): ${kindRightConf}/${kindTotalConf} (${Math.round(100 * kindRightConf / Math.max(1, kindTotalConf))}%)`);
show("confusion expected→chosen", confusion);
