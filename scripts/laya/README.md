# Laya as a local decider — an experiment

[Laya](https://github.com/NandhaKishorM/laya) (Convai Innovations, Apache-2.0)
answers the same typed questions Jev does — `choice`, `score`, `noul` with
`instructions` and `criteria` — and [laya-mlx](https://github.com/mizorewww/laya-mlx)
runs it on Apple Silicon in about 100 ms per card. Its answers even use Jev's
field names, so `server.py` is a thirty-line HTTP front that pocket-paste's
`endpoint` decider (`--provider proxy --proxy-url http://127.0.0.1:8790/`) can
talk to with no core change.

```bash
uv venv --python 3.11 .venv && uv pip install --python .venv/bin/python laya-mlx
# From China, huggingface.co stalls: fetch the checkpoint through a mirror with
# curl (resume + retry) into a directory, or set HF_ENDPOINT=https://hf-mirror.com
# and HF_HUB_DISABLE_XET=1 before the first load.
.venv/bin/python scripts/laya/server.py --model aac6fef/laya-multilingual-mlx --port 8790
bun scripts/laya/eval-cards.ts http://127.0.0.1:8790/v1/ask      # the card corpus
bun scripts/probe-pick.ts                                         # writes .work/pick-scenarios.json
PASTE_PROXY_URL=http://127.0.0.1:8790/ bun scripts/probe-pick.ts # pick, Laya blended in
bun scripts/laya/sweep-pick.ts http://127.0.0.1:8790/            # the blend weight
bun scripts/laya/rules-kind.ts                                   # the yardstick
```

The numbers are in `baselines/laya.md`. Zero-shot, on our questions, Laya
does not beat the heuristics we already ship; the door stays open for a
fine-tuned checkpoint.
