#!/usr/bin/env python3
"""Synthesises the promo's original music bed from nothing but numpy/scipy.

    python3 promo/music/synth.py [--out .work/promo/music]

Writes one WAV stem per instrument plus mix.wav (unmastered, 48 kHz stereo
float) into --out. promo/music/master.sh then masters mix.wav to -14 LUFS.

Everything is placed on the beat grid in timeline.js, the same file the
picture loads (100 BPM, 0.6 s a beat, bars on beats 2, 6, 10 ...: the hook's
key press is the first downbeat), so section changes land on bars or
half-bars and the accents land on the picture's cuts. Deterministic: a fixed seed for every
noise source, no samples, no downloaded audio.
"""
import argparse, json, os
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve
from scipy.io import wavfile

HERE = os.path.dirname(os.path.abspath(__file__))
_src = open(os.path.join(HERE, "timeline.js")).read()
T = json.loads(_src[_src.index("= {") + 2: _src.rindex("}") + 1])
SR = 48000
BEAT = T["beat"]
OFF = T["barOffset"]           # bars start on beats OFF, OFF + 4, ...
NB = T["beats"]                # length in beats
DUR = NB * BEAT
N = int(SR * DUR)
rng = np.random.default_rng(20260924)


def at(beat):
    return beat * BEAT


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def lp(x, f, order=2):
    return sosfilt(butter(order, min(f, SR * 0.45), "low", fs=SR, output="sos"), x)


def hp(x, f, order=2):
    return sosfilt(butter(order, f, "high", fs=SR, output="sos"), x)


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], "band", fs=SR, output="sos"), x)


def adsr(n, a, d, s, r, hold):
    """Envelope of n samples: attack a, decay d to level s, held until `hold` s, release r."""
    t = np.arange(n) / SR
    env = np.where(t < a, t / max(a, 1e-4), 1.0)
    dec = (t >= a) & (t < a + d)
    env = np.where(dec, 1 - (1 - s) * (t - a) / max(d, 1e-4), env)
    env = np.where(t >= a + d, s, env)
    rel = t >= hold
    env = np.where(rel, s * np.exp(-(t - hold) / max(r, 1e-4) * 4.0), env)
    return env


def saw(f, t, phase=0.0):
    # PolyBLEP-free but band-limited enough after the lowpass: sum of 18 partials.
    out = np.zeros_like(t)
    for k in range(1, 19):
        if f * k > SR * 0.45:
            break
        out += np.sin(2 * np.pi * f * k * t + phase * k) / k
    return out * 0.6


class Track:
    def __init__(self, name):
        self.name = name
        self.buf = np.zeros((N, 2))

    def add(self, start, sig, pan=0.0, gain=1.0):
        i = int(start * SR)
        if i >= N:
            return
        sig = sig[: N - i]
        if sig.ndim == 1:
            l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
            self.buf[i : i + len(sig), 0] += sig * l * gain * 1.414
            self.buf[i : i + len(sig), 1] += sig * r * gain * 1.414
        else:
            self.buf[i : i + len(sig)] += sig * gain


# ---------------------------------------------------------------- harmony
# D major colour: Dmaj9, Bm11, Gmaj9 (#11 avoided), A6sus. MIDI note lists.
CH = {
    "D": [50, 57, 61, 64, 66, 69],   # D A C# E F# A
    "Bm": [47, 54, 57, 61, 62, 66],  # B F# A C# D F#
    "G": [43, 50, 54, 57, 59, 66],   # G D F# A B F#
    "A": [45, 52, 57, 59, 62, 66],   # A E A B D F#  (sus, 6)
    "Em": [52, 55, 59, 62, 66, 69],  # E G B D F# A
}
ROOT = {"D": 38, "Bm": 35, "G": 31, "A": 33, "Em": 40}
# (beat, chord): bars on 1, 5, 9 ...
# (beat, chord). Hook and pain: D Bm G A; showcase: D Bm G A twice-plus, one
# chord a bar; forms G A D Em; UI scene G A D; trust G A; outro resolves on D.
PROG = [(0, "D"), (2, "D"), (6, "Bm"), (10, "G"), (14, "A"),
        (18, "D"), (22, "Bm"), (26, "G"), (30, "A"), (34, "D"), (38, "Bm"), (42, "G"), (46, "A"), (50, "D"), (54, "Bm"),
        (58, "G"), (62, "A"), (66, "D"), (70, "Em"),
        (74, "G"), (78, "A"), (82, "D"),
        (86, "G"), (90, "A"), (94, "D")]


def chord_at(beat):
    c = PROG[0][1]
    for b, name in PROG:
        if beat >= b:
            c = name
    return c


def segments():
    out = []
    for i, (b, c) in enumerate(PROG):
        end = PROG[i + 1][0] if i + 1 < len(PROG) else NB
        if end > b:
            out.append((b, end, c))
    return out


# ---------------------------------------------------------------- instruments
def pad_note(f, dur, bright=1400.0):
    n = int((dur + 2.5) * SR)
    t = np.arange(n) / SR
    left = saw(f * 0.997, t, 0.3) + saw(f * 1.004, t, 1.9)
    right = saw(f * 1.003, t, 0.7) + saw(f * 0.996, t, 2.6)
    env = adsr(n, 0.35, 0.6, 0.8, 1.6, dur)
    # slow filter swell inside each chord
    sig = np.stack([lp(left, bright, 2), lp(right, bright, 2)], 1) * env[:, None]
    return sig * 0.12


def pluck(f, dur=0.35, cutoff=3200.0, decay=6.0):
    n = int((dur + 0.4) * SR)
    t = np.arange(n) / SR
    tone = np.sign(np.sin(2 * np.pi * f * t)) * 0.35 + saw(f, t) * 0.65
    env = np.exp(-t * decay)
    # filter envelope: bright attack, darker tail (two passes blended)
    bright, dark = lp(tone, cutoff, 2), lp(tone, cutoff * 0.3, 2)
    k = np.exp(-t * 18)
    return (bright * k + dark * (1 - k)) * env * 0.5


def bell(f, dur=1.6):
    n = int((dur + 0.5) * SR)
    t = np.arange(n) / SR
    mod = np.sin(2 * np.pi * f * 3.5 * t) * np.exp(-t * 3) * 1.6
    sig = np.sin(2 * np.pi * f * t + mod) * np.exp(-t * 2.2)
    return sig * 0.35


def kick(gain=1.0, length=0.45):
    n = int(length * SR)
    t = np.arange(n) / SR
    f = 44 + 90 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t * 7.5)
    click = lp(rng.standard_normal(n), 2500) * np.exp(-t * 180) * 0.25
    return np.tanh((body + click) * 1.6) * 0.8 * gain


def clap(gain=1.0):
    n = int(0.5 * SR)
    t = np.arange(n) / SR
    noise = bp(rng.standard_normal(n), 900, 5200)
    env = np.zeros(n)
    for k, off in enumerate([0.0, 0.011, 0.023]):
        env += np.where(t >= off, np.exp(-(t - off) * 140), 0) * (0.8 if k < 2 else 1.0)
    env += np.where(t >= 0.023, np.exp(-(t - 0.023) * 16) * 0.35, 0)
    return noise * env * 0.32 * gain


def hat(gain=1.0, open_=False):
    n = int((0.35 if open_ else 0.09) * SR)
    t = np.arange(n) / SR
    noise = hp(rng.standard_normal(n), 7500, 2)
    return noise * np.exp(-t * (14 if open_ else 55)) * 0.12 * gain


def bass_note(f, dur):
    n = int((dur + 0.15) * SR)
    t = np.arange(n) / SR
    sig = np.sin(2 * np.pi * f * t) + 0.35 * lp(saw(f, t), 420)
    env = adsr(n, 0.008, 0.12, 0.75, 0.08, dur)
    return np.tanh(sig * env * 1.2) * 0.34


def tick(freq=2600.0, gain=1.0):
    """A keycap: a short filtered noise knock plus a tiny pitched blip."""
    n = int(0.08 * SR)
    t = np.arange(n) / SR
    knock = bp(rng.standard_normal(n), 1500, 6000) * np.exp(-t * 170)
    blip = np.sin(2 * np.pi * freq * t) * np.exp(-t * 90) * 0.4
    return (knock * 0.5 + blip) * 0.35 * gain


def thock(gain=1.0):
    """The ⌥V press: a deeper keycap with a little body."""
    n = int(0.25 * SR)
    t = np.arange(n) / SR
    body = np.sin(2 * np.pi * (180 + 160 * np.exp(-t * 60)) * t) * np.exp(-t * 26)
    knock = bp(rng.standard_normal(n), 1200, 5000) * np.exp(-t * 120) * 0.6
    return (body + knock) * 0.45 * gain


def whoosh(length, rise=True, lo=300, hi=6000):
    n = int(length * SR)
    t = np.arange(n) / SR
    x = rng.standard_normal(n)
    out = np.zeros(n)
    # sweep a band through a few blocks
    blocks = 24
    for k in range(blocks):
        a, b = k * n // blocks, (k + 1) * n // blocks
        p = k / (blocks - 1)
        p = p if rise else 1 - p
        c = lo * (hi / lo) ** p
        out[a:b] = bp(x, c * 0.7, min(c * 1.4, SR * 0.45))[a:b]
    env = (t / length) ** 2 if rise else np.exp(-t / length * 5)
    return out * env * 0.25


def reverb_ir(seconds=2.4, seed=5, damp=0.9):
    r = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = r.standard_normal((n, 2)) * np.exp(-t * 6.9 / seconds)[:, None]
    ir[:, 0] = lp(ir[:, 0], 5200 * damp)
    ir[:, 1] = lp(ir[:, 1], 5000 * damp)
    ir[: int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))[:, None]
    return ir / np.sqrt((ir ** 2).sum(0))


def reverb(x, wet, ir):
    y = np.stack([fftconvolve(x[:, 0], ir[:, 0])[:N], fftconvolve(x[:, 1], ir[:, 1])[:N]], 1)
    return x + y * wet


def pingpong(x, delay, fb=0.38, wet=0.3, repeats=6):
    y = np.zeros_like(x)
    d = int(delay * SR)
    g = wet
    src = x.copy()
    for k in range(1, repeats + 1):
        ch = k % 2
        s = np.zeros_like(x)
        s[d * k :, ch] = lp(src[: N - d * k, 0] + src[: N - d * k, 1], 3000 - k * 250) * 0.5
        y += s * g
        g *= fb
    return x + y


# ---------------------------------------------------------------- arrangement
tracks = {k: Track(k) for k in ["pad", "bass", "arp", "drums", "keys", "fx", "bells"]}
S = T["sections"]
PRESS = T["hook"]["press"]
bar_down = lambda b: (b - OFF) % 4 == 0

# Pad: whole piece; brighter from the showcase, darker for trust, open at the end.
for b0, b1, c in segments():
    dur = at(b1 - b0)
    bright = 900 if b0 < S["showcase"] else 1600 if b0 < S["use"] else 1100 if b0 < S["trust"] else 1300
    gain = 0.55 if b0 < PRESS else 1.0
    if b0 >= S["outro"]:
        dur = DUR - at(b0) - 0.2
    for i, m in enumerate(CH[c]):
        tracks["pad"].add(at(b0), pad_note(midi(m), dur, bright), gain=gain * (0.8 if i == 0 else 1.0))

# Pickup riser into the key press (beat 0 -> 1).
tracks["fx"].add(0.0, whoosh(at(PRESS), True, 400, 5000), gain=0.9)
tracks["fx"].add(at(PRESS) - 0.005, thock(1.4))

# Kick: bar downbeats in hook/pain (with a soft push on beat 3), four on the floor in the groove sections.
def groove_on(beat):
    return S["showcase"] <= beat < S["use"]

for b in np.arange(PRESS, NB, 1.0):
    if b < S["showcase"]:
        if bar_down(b):
            tracks["drums"].add(at(b), kick(0.8))
        if (b - OFF) % 4 == 2 and b >= S["pain"]:
            tracks["drums"].add(at(b), kick(0.45))
    elif groove_on(b):
        tracks["drums"].add(at(b), kick(0.9))
        if (b - OFF) % 2 == 1:
            tracks["drums"].add(at(b), clap(0.9))
    elif S["use"] <= b < S["trust"]:
        # the scene is UI: a light pulse only on bar downbeats
        if bar_down(b):
            tracks["drums"].add(at(b), kick(0.55))
    elif b == S["outro"]:
        tracks["drums"].add(at(b), kick(1.1, 0.9))

# Hats: 8ths with light swing in the groove, 16ths in the last showcase bars (acceleration).
for k in range(int(S["pain"] * 4), int(S["trust"] * 4)):
    b = k / 4
    if S["pain"] <= b < S["showcase"]:
        if k % 2 == 0 and k % 4 == 2:
            tracks["drums"].add(at(b), hat(0.5))
        continue
    if S["use"] <= b < S["trust"]:
        if k % 4 == 2:
            tracks["drums"].add(at(b), hat(0.45))
        continue
    dense = b >= T["showcase"]["stations"][-2]["flight"] - 4
    if k % 2 == 0 or dense:
        swing = 0.03 if k % 4 == 2 else 0.0
        g = 0.9 if k % 4 == 2 else 0.55
        tracks["drums"].add(at(b) + swing, hat(g * (0.7 if dense and k % 2 else 1.0)), pan=0.25)
    if k % 8 == 6:
        tracks["drums"].add(at(b), hat(0.35, True), pan=-0.2)

# Bass: 8ths following the chord root in the groove; long notes elsewhere.
for b0, b1, c in segments():
    root = midi(ROOT[c])
    if S["showcase"] <= b0 < S["use"]:
        b = b0
        while b < b1:
            accent = 1.0 if (b - b0) % 1 == 0 else 0.7
            f = root * (2 if (b * 2) % 4 == 3 else 1)
            tracks["bass"].add(at(b), bass_note(f, 0.24), gain=accent)
            b += 0.5
    elif b0 >= S["pain"] and b0 < S["showcase"]:
        tracks["bass"].add(at(b0), bass_note(root, at(b1 - b0) * 0.9), gain=0.8)
    elif S["use"] <= b0 < S["trust"]:
        tracks["bass"].add(at(b0), bass_note(root, at(b1 - b0) * 0.9), gain=0.6)
    elif b0 >= S["outro"]:
        tracks["bass"].add(at(b0), bass_note(root, 2.4), gain=0.9)

# Arp: 16ths across the chord (up two octaves), from the showcase through forms;
# 8ths, filtered, under the UI scene; a single rising figure in the pain scene.
for k in range(int(S["showcase"] * 4), int(S["use"] * 4)):
    b = k / 4
    c = CH[chord_at(b)]
    notes = [c[1], c[2], c[3], c[4], c[5], c[4] + 12, c[5], c[3]]
    f = midi(notes[k % len(notes)] + 12)
    cut = 1800 + 2600 * ((b - S["showcase"]) / (S["use"] - S["showcase"]))
    tracks["arp"].add(at(b), pluck(f, 0.12, cut, 12), pan=(-0.35 if k % 2 else 0.35), gain=0.8 if k % 4 == 0 else 0.55)
for k in range(int(S["use"] * 2), int(S["trust"] * 2)):
    b = k / 2
    c = CH[chord_at(b)]
    f = midi(c[2 + k % 4] + 12)
    tracks["arp"].add(at(b), pluck(f, 0.2, 1400, 9), pan=(-0.3 if k % 2 else 0.3), gain=0.45)
# Pain scene: four awkward steps on the left (muted, off-grid by design, but on 8ths), one clean chord hit on the right.
for i, b in enumerate(T["pain"]["steps"]):
    tracks["arp"].add(at(b), pluck(midi(62 + [0, 3, 1, 4][i]), 0.1, 900, 16), pan=-0.5, gain=0.7)
for m in CH[chord_at(T["pain"]["press"])][1:]:
    tracks["arp"].add(at(T["pain"]["press"]), pluck(midi(m + 12), 0.5, 3600, 5), pan=0.4, gain=0.35)
tracks["keys"].add(at(T["pain"]["press"]), thock(0.8))

# Card-change accents in the showcase and the forms: a bell on each cut.
for cut in [st["flight"] for st in T["showcase"]["stations"]] + T["forms"]:
    m = CH[chord_at(cut)][5] + 12
    tracks["bells"].add(at(cut), bell(midi(m), 1.2), pan=0.15, gain=0.55)
    tracks["fx"].add(at(cut) - 0.25, whoosh(0.25, True, 1500, 9000), gain=0.35)

# UI scene: typing ticks, the ⌥V press, Return, send.
U = T["use"]
typing = np.arange(U["typeStart"], U["typeEnd"], 0.25)
for i, b in enumerate(typing):
    jitter = [0.0, 0.02, -0.015, 0.01][i % 4]
    tracks["keys"].add(at(b) + jitter, tick(2400 + (i % 3) * 180, 0.6), pan=0.1)
tracks["keys"].add(at(U["optionV"]), thock(1.0))
tracks["keys"].add(at(U["enter"]), thock(0.9))
tracks["fx"].add(at(U["send"]), whoosh(0.5, False, 900, 5000), gain=0.6)
tracks["bells"].add(at(U["send"]) + 0.05, bell(midi(81), 0.8), gain=0.35)

# Trust: three soft bells, one per line.
for i, b in enumerate(T["trust"]):
    tracks["bells"].add(at(b), bell(midi([74, 78, 81][i]), 2.0), pan=[-0.2, 0.0, 0.2][i], gain=0.5)
# Outro: the resolving chord, a low bell.
tracks["bells"].add(at(S["outro"]), bell(midi(62), 3.5), gain=0.55)
tracks["fx"].add(at(S["outro"]) - 0.6, whoosh(0.6, True, 300, 4000), gain=0.6)

# ---------------------------------------------------------------- mix
ir = reverb_ir()
ir_long = reverb_ir(3.4, seed=9, damp=0.8)

# Sidechain: duck pad and arp under every kick.
duck = np.ones(N)
kick_times = []
for b in np.arange(PRESS, NB, 1.0):
    if groove_on(b) or (b < S["showcase"] and bar_down(b)) or (S["use"] <= b < S["trust"] and bar_down(b)) or b == S["outro"]:
        kick_times.append(at(b))
for kt in kick_times:
    i = int(kt * SR)
    n = int(0.35 * SR)
    seg = 1 - 0.45 * np.exp(-np.arange(n) / SR * 9)
    duck[i : i + n] = np.minimum(duck[i : i + n], seg[: max(0, min(n, N - i))])

stems = {}
stems["pad"] = reverb(tracks["pad"].buf * duck[:, None], 0.35, ir_long)
stems["bass"] = tracks["bass"].buf
stems["arp"] = reverb(pingpong(tracks["arp"].buf * duck[:, None], BEAT * 0.75, 0.4, 0.28), 0.25, ir)
stems["drums"] = reverb(tracks["drums"].buf, 0.12, ir)
stems["keys"] = reverb(tracks["keys"].buf, 0.1, ir)
stems["fx"] = reverb(tracks["fx"].buf, 0.3, ir_long)
stems["bells"] = reverb(pingpong(tracks["bells"].buf, BEAT * 0.75, 0.35, 0.25), 0.45, ir_long)

levels = {"pad": 0.9, "bass": 1.0, "arp": 0.75, "drums": 1.0, "keys": 0.8, "fx": 0.7, "bells": 0.7}
mix = sum(stems[k] * levels[k] for k in stems)
# Gentle bus glue and a fade over the last 2.2 s.
mix = np.tanh(mix * 1.1) / 1.1
fade = np.ones(N)
fl = int(2.2 * SR)
fade[-fl:] = np.linspace(1, 0, fl) ** 1.6
mix *= fade[:, None]
fi = int(0.02 * SR)
mix[:fi] *= np.linspace(0, 1, fi)[:, None]

ap = argparse.ArgumentParser()
ap.add_argument("--out", default=os.path.join(HERE, "../../.work/promo/music"))
args = ap.parse_args()
os.makedirs(os.path.join(args.out, "stems"), exist_ok=True)
for k, v in stems.items():
    wavfile.write(os.path.join(args.out, "stems", f"{k}.wav"), SR, (v * levels[k] * fade[:, None]).astype(np.float32))
peak = np.abs(mix).max()
wavfile.write(os.path.join(args.out, "mix.wav"), SR, (mix / max(peak, 1e-9) * 0.89).astype(np.float32))
print(f"wrote {len(stems)} stems + mix.wav to {args.out} ({DUR:.1f} s, peak {peak:.2f})")
