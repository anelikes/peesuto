#!/usr/bin/env python3
"""
A Jev-shaped HTTP front for laya-mlx: POST {state, questions} → {answers}.

    python laya_server.py [--model aac6fef/laya-multilingual-mlx] [--port 8790] [--dtype float16]

Answers are mapped to the shape pocket-paste's deciders read
(core/src/provider/decider/types.ts): choice → {choice, probabilities},
score → {score}, noul → {noul}. Everything else Laya reports (confidence,
distribution, usage) is dropped. Nothing is logged but timings.
"""
import argparse, json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ap = argparse.ArgumentParser()
ap.add_argument("--model", default="aac6fef/laya-multilingual-mlx")
ap.add_argument("--port", type=int, default=8790)
ap.add_argument("--host", default="127.0.0.1")
ap.add_argument("--dtype", default="float16")
args = ap.parse_args()

import laya_mlx as laya  # noqa: E402  (import after argparse so --help is instant)
t0 = time.time()
agent = laya.load(args.model, dtype=args.dtype)
print(f"laya-server: {args.model} loaded in {time.time()-t0:.1f}s, listening on http://{args.host}:{args.port}", flush=True)


def to_jev(answers):
    out = {}
    for name, a in (answers or {}).items():
        if not isinstance(a, dict):
            out[name] = {"choice": a} if isinstance(a, str) else {"score": a}
            continue
        m = {}
        if "choice" in a: m["choice"] = a["choice"]
        elif "label" in a: m["choice"] = a["label"]
        if "probabilities" in a and isinstance(a["probabilities"], dict): m["probabilities"] = a["probabilities"]
        if "score" in a: m["score"] = a["score"]
        elif "level" in a: m["score"] = a["level"]
        if "noul" in a: m["noul"] = a["noul"]
        elif "probability" in a: m["noul"] = a["probability"]
        out[name] = m
    return out


class H(BaseHTTPRequestHandler):
    def log_message(self, *_): pass

    def _send(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(200, {"ok": True, "model": args.model, "decider": "laya"})

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:
            return self._send(400, {"error": f"bad json: {e}"})
        state, questions = req.get("state"), req.get("questions")
        if state is None or not isinstance(questions, dict) or not questions:
            return self._send(400, {"error": "body must be {state, questions}"})
        t = time.time()
        try:
            r = agent.predict(state, questions)
        except Exception as e:
            print(f"laya-server: predict failed: {type(e).__name__}: {str(e)[:200]}", file=sys.stderr, flush=True)
            return self._send(500, {"error": f"{type(e).__name__}: {str(e)[:200]}"})
        ms = round((time.time() - t) * 1000)
        print(f"laya-server: {len(questions)} question(s) in {ms} ms", flush=True)
        self._send(200, {"answers": to_jev(r.get("answers") if isinstance(r, dict) else None), "ms": ms, "model": args.model})


ThreadingHTTPServer((args.host, args.port), H).serve_forever()
