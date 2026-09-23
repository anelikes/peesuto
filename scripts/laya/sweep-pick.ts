// Pick hit rate over the scenarios scripts/probe-pick.ts saved, for several
// decider blend weights, with a Jev-shaped endpoint as the decider.
//   bun scripts/probe-pick.ts && bun scripts/laya/sweep-pick.ts http://127.0.0.1:8790/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pick } from "../../core/src/pick/index.ts";
const url = process.argv[2] ?? "http://127.0.0.1:8791/";
const saved = JSON.parse(readFileSync(join(import.meta.dir, "../../.work/pick-scenarios.json"), "utf8")) as { now: number; scenarios: any[] };
const decider = { name: "laya", async ask(body: unknown) { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json() as any; return j.result?.answers ?? j.answers; } };
const cache = new Map<string, any>();
const cached = { name: "laya", async ask(body: unknown) { const k = JSON.stringify(body); if (!cache.has(k)) cache.set(k, await decider.ask(body)); return cache.get(k); } };
for (const w of [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1]) {
  let h1 = 0, h3 = 0;
  for (const s of saved.scenarios) {
    const want = s.candidates[s.answer].id;
    const r = await pick(s.ctx, s.candidates, w === 0 ? null : cached, { now: saved.now, deciderWeight: w });
    const ids = r.ranked.map((x: any) => x.item.id);
    if (ids[0] === want) h1++; if (ids.slice(0, 3).includes(want)) h3++;
  }
  console.log(`weight ${w.toFixed(2)}: top-1 ${h1}/30  top-3 ${h3}/30`);
}
