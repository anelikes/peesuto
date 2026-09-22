# A local decider: Laya

The decider is the small typed-decision model behind the smart pick and the
card decisions. Jev, the one the hosted and Cloudflare kinds use, runs in the
cloud. [Laya](https://github.com/NandhaKishorM/laya) (Convai Innovations,
Apache-2.0) answers the same typed questions and runs on your Mac through
[laya-mlx](https://github.com/mizorewww/laya-mlx). It is not as sharp on our
questions as the rules the app ships with (see `baselines/laya.md`), so it
is not built in; it is an option for people who want a model that never
leaves the machine.

You need Apple Silicon, macOS 14 or later, and about 1.5 GB of disk.

## 1. Install the runtime

```bash
brew install uv                                  # or: pip install uv
mkdir -p ~/laya && cd ~/laya
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python laya-mlx
curl -O https://raw.githubusercontent.com/anelikes/peesuto/main/scripts/laya/server.py
```

## 2. Get a checkpoint

The multilingual checkpoint is the one to use for Chinese and mixed text
(650 MB). The first `server.py` start downloads it from Hugging Face:

```bash
.venv/bin/python server.py --model aac6fef/laya-multilingual-mlx
```

From mainland China huggingface.co stalls. Either point the client at a
mirror before the first start,

```bash
export HF_ENDPOINT=https://hf-mirror.com HF_HUB_DISABLE_XET=1
```

or fetch the files with curl (which resumes and retries) into a directory
and pass that directory as `--model`:

```bash
for f in model.safetensors rl_agent_config.json encoder/config.json mlx_config.json manifest.json tokenizer/tokenizer.json tokenizer/tokenizer_config.json; do
  mkdir -p "models/laya-multilingual-mlx/$(dirname "$f")"
  curl -L -C - --retry 10 --retry-all-errors -o "models/laya-multilingual-mlx/$f" \
    "https://hf-mirror.com/aac6fef/laya-multilingual-mlx/resolve/main/$f"
done
.venv/bin/python server.py --model models/laya-multilingual-mlx
```

`server.py` prints one line when the model is loaded and one line per
request with the timing. It listens on `http://127.0.0.1:8790/` and only
there; nothing in it logs text.

## 3. Point the app at it

Settings → Providers → Decider → **Laya**. Leave the URL empty for the
default port, press **Test decider**. From the command line the same thing
is `paste --provider laya "text"` or `PASTE_PROVIDER=laya`.

## What to expect

- A card decision takes about 100 ms for a chat-length text, up to a second
  for a long paragraph. The smart pick blends Laya's answer with the
  heuristic at a low weight, because on our synthetic scenarios Laya alone
  ranks below the heuristic (`baselines/laya.md`).
- Card kinds: Laya over-calls `event` and misses lists; when it is unsure
  the card falls back to plain, as with any decider.
- Everything stays on the machine: the egress log shows one local
  destination, and Offline mode blocks it like any other endpoint.

If a checkpoint fine-tuned on pocket-paste's questions appears, it plugs in
here unchanged.
