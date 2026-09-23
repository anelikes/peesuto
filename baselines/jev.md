# Jev vs Laya vs local rules — baseline

2026-09-23. Jev (`typesafe/jev` on Workers AI) through the dev proxy
(`wrangler dev`, AI binding), the same corpus, questions and scripts as
[laya.md](laya.md): `scripts/laya/eval-cards.ts` (100-sample card corpus,
seven legacy card questions) and `scripts/probe-pick.ts` +
`scripts/laya/sweep-pick.ts` (thirty synthetic pick scenarios). The sweep
script now reads answers wrapped in `result` (the proxy's shape); before this
fix it silently fell back to the heuristic for proxied deciders.

## Card kind (85 scorable samples)

| | Jev | Laya multilingual | Laya typed-decisions | rules (`classify`) |
|---|---|---|---|---|
| kind accuracy | **75/85 (88%)** | 35/85 (41%) | 30/85 (35%) | 77/85 (91%) |
| confident answers (p ≥ 0.6) | 72/80 (90%) | 30/70 (43%) | 10/27 (37%) | — |
| latency p50 / p90 | 473 / 539 ms (max 3.3 s, cold) | 187 / 627 ms | 621 / 1836 ms | 0 |
| lists / code / quotes / stats recognised | 12/12, 15/15, 9/10, 7/8 | 0, 4, 3, 0 | 7, 7, 5, 3 | 12, 14, 9, 7 |

Jev's misses: five plain paragraphs called code, one plain text an event, one
quote and one stat called plain. It also varies scale (0–3) and tone (0–2),
which the rules do not.

## Smart pick (30 scenarios)

| decider weight | Jev top-1 | Jev top-3 | Laya typed-decisions top-1 |
|---|---|---|---|
| 0 (heuristic only) | 19/30 (63%) | 30/30 | 19/30 |
| 0.15 | **28/30 (93%)** | 29/30 | 20/30 |
| 0.30 | 26/30 (87%) | 29/30 | 20/30 |
| 0.50 | 24/30 (80%) | 29/30 | — |
| 0.70 (current default) | 24/30 (80%) | 30/30 | 17/30 |
| 1.00 | 24/30 (80%) | 30/30 | 16/30 |

About 300–600 ms per pick request.

## Reading

- On card kind, Jev is roughly level with the rules (88% vs 91%) — but the
  rules were written against this very corpus, and Jev also grades scale and
  tone. Laya is far behind both.
- On smart pick, Jev clearly earns its keep: +30 points of top-1 over the
  heuristic at a low blend weight. The current default weight (0.7) leaves
  about a quarter of that on the table; 0.15–0.3 is better on these thirty
  synthetic scenarios (small sample; confirm with real picks).
- Cost: one Workers AI call per card or pick, ~0.5 s warm.
