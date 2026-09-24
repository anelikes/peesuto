#!/usr/bin/env python3
"""
Adds the symbols Maple Mono lacks to Peesuto Code from JetBrains Mono (SIL
OFL 1.1, same 1000-unit em and 600-unit advance, so outlines copy as they
are): keyboard symbols (⌘ ⌥ ⌃ ⎋ ⏎ ⌫ ⌦), and whatever else of the technical,
arrow, geometric, symbol and dingbat blocks Maple is missing. Copied text
with ⌥ in it used to fail in every font we have.

    python3 scripts/fonts/merge-symbols.py <JetBrains Mono ttf dir>
    python3 scripts/fonts/peesuto-text.py      # then rebuild Peesuto Text

Idempotent: only code points Peesuto Code does not map are added. JetBrains
Mono v2.304: https://github.com/JetBrains/JetBrainsMono (ttf/ in the zip).
"""
import sys
from pathlib import Path

from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

FONTS = Path(__file__).resolve().parents[2] / "core/src/render/fonts"
BLOCKS = [(0x2190, 0x21FF), (0x2300, 0x23FF), (0x25A0, 0x25FF), (0x2600, 0x26FF), (0x2700, 0x27BF), (0x2B00, 0x2BFF)]


def merge(target: Path, donor: Path) -> list[str]:
    font, extra = TTFont(target), TTFont(donor)
    have, give = font.getBestCmap(), extra.getBestCmap()
    donor_glyphs = extra.getGlyphSet()
    glyf, hmtx = font["glyf"], font["hmtx"]
    added = []
    for lo, hi in BLOCKS:
        for cp in range(lo, hi + 1):
            if cp in have or cp not in give:
                continue
            source = give[cp]
            name = f"jbm.{source}"
            if name not in glyf:
                # Decompose: the donor's components do not exist in the target.
                recording = DecomposingRecordingPen(donor_glyphs)
                donor_glyphs[source].draw(recording)
                pen = TTGlyphPen(None)
                recording.replay(pen)
                glyf[name] = pen.glyph()
                glyf[name].recalcBounds(glyf)
                hmtx.metrics[name] = (extra["hmtx"][source][0], glyf[name].xMin if glyf[name].numberOfContours else 0)
            for table in font["cmap"].tables:
                if table.isUnicode() and (table.format == 12 or cp <= 0xFFFF):
                    table.cmap[cp] = name
            added.append(chr(cp))
    font.save(target)
    return added


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    donors = Path(sys.argv[1])
    for style in ("Regular", "Bold"):
        added = merge(FONTS / f"PeesutoCode-{style}.ttf", donors / f"JetBrainsMono-{style}.ttf")
        print(f"PeesutoCode-{style}.ttf: {len(added)} symbols added {''.join(added[:40])}{'…' if len(added) > 40 else ''}")
