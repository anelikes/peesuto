# Laya as a local decider — baseline

2026-09-22, Apple M4, 32 GB, laya-mlx 0.1.0, MLX 0.32.2, FP16, through
`scripts/laya/server.py`. Two checkpoints from the `aac6fef/*-mlx` conversions:
`laya-multilingual` (mmBERT-base, 322M, 1024 ctx) and `laya-typed-decisions`
(ModernBERT-large, 421M, 1024 ctx). No Jev comparison yet (no working token);
the yardsticks are what the app ships today: the pick heuristic and the
rule-based kind classifier from `scripts/corpus.ts`.

## Cards: the 100-sample corpus, seven questions each

| | multilingual | typed-decisions | rules (`classify`) |
|---|---|---|---|
| answered | 100/100 | 100/100 | — |
| latency p50 / p90 / max | 187 / 627 / 963 ms | 621 / 1836 / 2760 ms | 0 |
| kind accuracy vs slug (85 scorable) | 35/85 (41%) | 30/85 (35%) | 77/85 (91%) |
| … among confident (p ≥ 0.6) | 30/70 (43%) | 10/27 (37%) | — |
| lists recognised (12) | 0 | 7 | 12 |
| code recognised (15) | 4 | 7 | 14 |
| quotes recognised (10) | 3 | 5 | 9 |
| stats recognised (8) | 0 | 3 | 7 |
| `scale` levels used | 2 ×98, 1 ×2 | 1 ×76, 2 ×24 | by length |
| `animate` = yes | 23 | 55 | 0 |

The multilingual model over-answers `event` (22 of 100) and calls every
list plain; the typed-decisions model calls 17 plain texts code. Neither
varies `scale` with length, which the fallback does by construction. The
rules were written against this corpus, so 91% flatters them, but the gap
is not a tuning gap.

Latency alone would be fine: one card is 100 ms on the multilingual model
for a chat-length text; the p90 is long paragraphs near the 1024-token
context.

## Smart pick: the thirty synthetic scenarios (`scripts/probe-pick.ts`)

| decider | top-1 | top-3 | ms per pick |
|---|---|---|---|
| heuristic only | 19/30 (63%) | 30/30 | < 1 |
| multilingual, blended (w 0.7) | 5/30 (17%) | 27/30 | 50–140 |
| typed-decisions, blended (w 0.7) | 17/30 (57%) | 28/30 | ~160 |
| typed-decisions alone (w 1.0) | 16/30 (53%) | 28/30 | |
| typed-decisions, w 0.15–0.3 | 20/30 (67%) | 29–30/30 | |

One scenario over the heuristic at a low weight, inside the noise of
thirty made-up cases. The scenarios are synthetic (see `baselines/pick.md`).

## Reading

- Zero-shot Laya does not earn its keep on pocket-paste's questions: it is
  below the shipped heuristics on both the pick and the card kind, and the
  upstream README says as much ("base checkpoints score near-chance on
  typed-decisions zero-shot; fine-tuning recovers capability").
- The interface fit is real: same question shape, same answer field names,
  100 ms local. A checkpoint fine-tuned on pocket-paste's own questions
  (corpus + recorded picks) would plug in through `server.py` unchanged.
- For a free, offline first run the better path today is the heuristic pick
  (already the `none` decider) plus a rules-based card kind, which is 91%
  here and instant.
- Setup friction observed: a 650–850 MB checkpoint per model, a Python 3.11+
  runtime (~260 MB with MLX), and huggingface.co stalling from China (the
  mirror plus `HF_HUB_DISABLE_XET=1`, or curl with resume, worked).
