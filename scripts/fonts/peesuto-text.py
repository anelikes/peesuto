#!/usr/bin/env python3
"""
Peesuto Text: Peesuto Code (the Maple Mono NL CN subset) with full-width
glyphs set at 1em instead of 1.2em, for every card but code.

Maple Mono keeps Chinese exactly two Latin columns wide (1200 units against
600) so code lines up; in running text that is 0.2em of extra air between
every pair of Chinese characters. Here each glyph advancing 1200 advances
1000, its outline moved 100 units left so it stays centred. Latin is
untouched. Composite glyphs are decomposed first so no outline moves twice.

    python3 scripts/fonts/peesuto-text.py   # needs fontTools

Reads core/src/render/fonts/PeesutoCode-{Regular,Bold}.ttf and writes
PeesutoText-{Regular,Bold}.ttf next to them (a Modified Version under the
SIL OFL 1.1, like Peesuto Code; see the README there).
"""
import os
from pathlib import Path

from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

FONTS = Path(__file__).resolve().parents[2] / "core/src/render/fonts"
WIDE, NARROW = 1200, 1000
SHIFT = (NARROW - WIDE) // 2


def narrow(src: Path, dst: Path, style: str) -> int:
    font = TTFont(src, recalcTimestamp=False)  # head.modified stays Maple's: reproducible bytes
    glyf, hmtx = font["glyf"], font["hmtx"]
    glyph_set = font.getGlyphSet()
    changed = 0
    for name, (advance, lsb) in list(hmtx.metrics.items()):
        if advance != WIDE:
            continue
        pen = TTGlyphPen(glyph_set)
        glyph_set[name].draw(TransformPen(pen, (1, 0, 0, 1, SHIFT, 0)))
        glyf[name] = pen.glyph()
        glyf[name].recalcBounds(glyf)
        hmtx.metrics[name] = (NARROW, glyf[name].xMin if glyf[name].numberOfContours else 0)
        changed += 1
    font["post"].isFixedPitch = 0
    font["OS/2"].panose.bProportion = 0
    family, full, ps = "Peesuto Text", f"Peesuto Text {style}", f"PeesutoText-{style}"
    for record in font["name"].names:
        text = {1: family, 3: f"{ps};peesuto", 4: full, 6: ps, 16: family}.get(record.nameID)
        if text is not None:
            record.string = text
    # Beside, then renamed: compositions hard-link these files.
    partial = dst.with_suffix(".partial")
    font.save(partial)
    os.replace(partial, dst)
    return changed


if __name__ == "__main__":
    for style in ("Regular", "Bold"):
        n = narrow(FONTS / f"PeesutoCode-{style}.ttf", FONTS / f"PeesutoText-{style}.ttf", style)
        print(f"PeesutoText-{style}.ttf: {n} full-width glyphs set to {NARROW}")
