#!/usr/bin/env python3
"""Font work for scripts/fonts/jizura-packs.ts (JIZURA font packs).

    python3 scripts/fonts/jizura-fonts.py woff2 < jobs.json
        jobs: [{"src": path, "out": path, "cut": null | "latin", "lacks": [[first, last], ...]}]
        Converts each source to WOFF2 without touching its outlines (CFF stays
        CFF; the timestamp in `head` is kept, so the same input gives the same
        bytes). "latin" keeps every character except the `lacks` ranges
        (CJK_RANGES in core/src/fonts/jizura-packs.ts: kana, han, hangul, CJK
        symbols, full-width forms): the cut English lyrics are drawn with.
        Prints {"out": path, "glyphs": n} lines.

    python3 scripts/fonts/jizura-fonts.py outlines < pairs.json
        pairs: [{"a": path, "b": path, "cut": bool}]
        Checks every glyph of b has exactly a's outline (for a cut: every
        character b maps draws what a draws for it). Prints one JSON line per
        pair: {"a", "b", "glyphs", "different": [...first few names]}.

    python3 scripts/fonts/jizura-fonts.py overlaps < paths.json
        paths: [path]. Needs skia-pathops (pip install skia-pathops): counts the
        glyphs whose contours overlap (their outline changes when overlaps are
        removed), which JIZURA's stroked text shows as inner lines. Prints
        {"path", "glyphs", "overlapping", "examples"} lines.

Needs fontTools with brotli (built with fontTools 4.60).
"""
import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor

from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import DecomposingRecordingPen

def woff2(job):
    src, out, cut = job["src"], job["out"], job.get("cut")
    font = TTFont(src, recalcTimestamp=False)
    if cut == "latin":
        from fontTools import subset
        lacks = job["lacks"]
        keep = sorted(u for u in font.getBestCmap() if not any(a <= u <= b for a, b in lacks))
        opts = subset.Options()
        opts.layout_features = ["*"]
        opts.name_IDs = ["*"]
        opts.name_languages = ["*"]
        opts.name_legacy = True
        opts.notdef_outline = True
        opts.glyph_names = False
        opts.hinting = True
        opts.recalc_timestamp = False
        opts.drop_tables += ["DSIG"]
        s = subset.Subsetter(opts)
        s.populate(unicodes=keep)
        s.subset(font)
    elif cut:
        raise SystemExit(f"unknown cut {cut}")
    font.flavor = "woff2"
    tmp = out + ".tmp"
    font.save(tmp)
    os.replace(tmp, out)
    n = len(font.getGlyphOrder())
    return {"out": out, "glyphs": n}


def outline(font, gs, name):
    pen = DecomposingRecordingPen(gs)
    gs[name].draw(pen)
    return pen.value


def outlines(pair):
    a, b = TTFont(pair["a"]), TTFont(pair["b"])
    ga, gb = a.getGlyphSet(), b.getGlyphSet()
    diff = []
    if pair.get("cut"):
        ca, cb = a.getBestCmap(), b.getBestCmap()
        items = [(ca.get(u), cb[u]) for u in sorted(cb)]
    else:
        if a.getGlyphOrder() != b.getGlyphOrder():
            return {"a": pair["a"], "b": pair["b"], "glyphs": 0, "different": ["glyph order"]}
        items = [(n, n) for n in a.getGlyphOrder()]
    for na, nb in items:
        if na is None or outline(a, ga, na) != outline(b, gb, nb) or ga[na].width != gb[nb].width:
            diff.append(nb)
    return {"a": pair["a"], "b": pair["b"], "glyphs": len(items), "different": diff[:8], "differentCount": len(diff)}


def overlaps(path):
    import pathops
    from fontTools.pens.areaPen import AreaPen

    font = TTFont(path)
    gs = font.getGlyphSet()
    names = sorted(set(font.getBestCmap().values()))
    bad = []
    for n in names:
        ap = AreaPen(gs)
        gs[n].draw(ap)
        a0 = abs(ap.value)
        if a0 <= 0:
            continue
        p = pathops.Path()
        gs[n].draw(p.getPen(glyphSet=gs))
        p.simplify(fix_winding=True)
        ap = AreaPen()
        p.draw(ap)
        # overlapping contours count their shared area twice; the union counts it once
        if (a0 - abs(ap.value)) / a0 > 0.001:
            bad.append(n)
    return {"path": path, "glyphs": len(names), "overlapping": len(bad), "examples": bad[:6]}


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    fn = {"woff2": woff2, "outlines": outlines, "overlaps": overlaps}.get(cmd)
    if not fn:
        raise SystemExit(__doc__)
    jobs = json.load(sys.stdin)
    workers = int(os.environ.get("JIZURA_FONT_JOBS", "0")) or min(6, os.cpu_count() or 2)
    with ProcessPoolExecutor(workers) as ex:
        for r in ex.map(fn, jobs):
            print(json.dumps(r), flush=True)


if __name__ == "__main__":
    main()
