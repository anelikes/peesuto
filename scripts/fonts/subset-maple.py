#!/usr/bin/env python3
"""
Peesuto Code, step 1 of 3: subset Maple Mono NL CN v7.9 (unhinted, Regular
and Bold) and rename it "Peesuto Code" (a Modified Version under the SIL OFL
1.1; see core/src/render/fonts/README.md).

    python3 scripts/fonts/subset-maple.py <MapleMonoNL-CN-unhinted.zip>
    python3 scripts/fonts/merge-symbols.py <JetBrains Mono ttf dir>
    python3 scripts/fonts/peesuto-text.py

or all three, downloads included: scripts/fonts/build.sh. Needs fontTools.

Kept: Basic Latin, Latin-1, Latin Extended-A/B, Greek, Cyrillic, General
Punctuation, currency, letterlike symbols, arrows, mathematical operators,
miscellaneous technical, enclosed alphanumerics, box drawing, block elements,
geometric shapes, miscellaneous symbols, dingbats, CJK symbols and
punctuation, kana, half/full-width forms, all of GB 2312, all of JIS X 0208
(level 1 and 2 kanji and the non-kanji rows) and the three JIS X 0213 kanji
of the 2010 jōyō list Maple has (塡 剝 頰): whatever of these Maple has.
Layout features are kept (those left without lookups are pruned).

Maple has neither half-width katakana nor full-width Latin letters and
digits; they are made here from its own glyphs: the full-width katakana at
half width (punctuation and sound marks moved, not squeezed) and the ASCII
glyphs centred in a two-column cell.

Writes core/src/render/fonts/PeesutoCode-{Regular,Bold}.ttf (without the
JetBrains Mono symbols: run merge-symbols.py next, then peesuto-text.py).
"""
import hashlib
import os
import sys
import tempfile
import unicodedata
import zipfile
from pathlib import Path

from fontTools import subset
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

FONTS = Path(__file__).resolve().parents[2] / "core/src/render/fonts"
ZIP_SHA256 = "80bf6db8920b2999d900e08f9e5031f7686baeb72dbdb80891f2c1ae9cec606f"
BLOCKS = [
    (0x0020, 0x007E), (0x00A0, 0x024F),  # Basic Latin (printable), Latin-1, Latin Extended-A/B
    (0x0370, 0x03FF), (0x0400, 0x04FF),  # Greek, Cyrillic
    (0x2000, 0x206F), (0x20A0, 0x20CF), (0x2100, 0x214F),  # punctuation, currency, letterlike
    (0x2190, 0x21FF), (0x2200, 0x22FF), (0x2300, 0x23FF),  # arrows, math operators, technical
    (0x2460, 0x24FF), (0x2500, 0x259F), (0x25A0, 0x25FF),  # enclosed, box drawing and blocks, geometric
    (0x2600, 0x26FF), (0x2700, 0x27BF),  # miscellaneous symbols, dingbats
    (0x3000, 0x303F), (0x3040, 0x309F), (0x30A0, 0x30FF),  # CJK punctuation, hiragana, katakana
    (0xFF00, 0xFFEF),  # half/full-width forms
]
EXTRA = "⟜" "塡剝頰"  # in the first subset; JIS X 0213 jōyō kanji (𠮟 is not in Maple)
NAMES = [("MapleMonoNL-CN", "PeesutoCode"), ("Maple Mono NL CN", "Peesuto Code")]
HALF, FULL = 600, 1200


def double_byte(codec: str, first: range, second: range = range(0xA1, 0xFF)) -> set[int]:
    """Every single character a double-byte EUC code decodes to."""
    out = set()
    for hi in first:
        for lo in second:
            try:
                text = bytes([hi, lo]).decode(codec)
            except UnicodeDecodeError:
                continue
            if len(text) == 1:
                out.add(ord(text))
    return out


GB2312 = double_byte("gb2312", range(0xA1, 0xF8))
JIS_NONKANJI = double_byte("euc_jp", range(0xA1, 0xB0))  # rows 1–15
JIS_LEVEL1 = double_byte("euc_jp", range(0xB0, 0xD0))  # rows 16–47 (0xB0A1–0xCFD3)
JIS_LEVEL2 = double_byte("euc_jp", range(0xD0, 0xF5))  # rows 48–84 (0xD0A1–0xF4A6)


def unicodes(have: dict[int, str]) -> set[int]:
    wanted = {cp for lo, hi in BLOCKS for cp in range(lo, hi + 1)}
    wanted |= GB2312 | JIS_NONKANJI | JIS_LEVEL1 | JIS_LEVEL2 | {ord(c) for c in EXTRA}
    return {cp for cp in wanted if cp in have}


def subset_font(src: Path, dst: Path) -> tuple[int, int]:
    font = TTFont(src, recalcTimestamp=False)  # head.modified stays Maple's: reproducible bytes
    have = font.getBestCmap()
    options = subset.Options()
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.notdef_outline = True
    options.glyph_names = False
    options.drop_tables += ["meta"]
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=unicodes(have))
    subsetter.subset(font)
    made = synthesize(font)
    for record in font["name"].names:
        text = record.toUnicode()
        for old, new in NAMES:
            text = text.replace(old, new)
        record.string = text
    save(font, dst)
    return len(font.getBestCmap()), made


def save(font: TTFont, dst: Path) -> None:
    """Write beside, then rename: compositions hard-link these files, and
    must keep the old contents until they stage the new ones."""
    partial = dst.with_suffix(".partial")
    font.save(partial)
    os.replace(partial, dst)


def draw(font: TTFont, source: str, name: str, transform) -> None:
    recording = DecomposingRecordingPen(font.getGlyphSet())
    font.getGlyphSet()[source].draw(recording)
    pen = TTGlyphPen(None)
    recording.replay(TransformPen(pen, transform))
    glyf = font["glyf"]
    glyf[name] = pen.glyph()
    glyf[name].recalcBounds(glyf)


def ink(font: TTFont, glyph: str) -> tuple[float, float] | None:
    pen = BoundsPen(font.getGlyphSet())
    font.getGlyphSet()[glyph].draw(pen)
    return None if pen.bounds is None else (pen.bounds[0], pen.bounds[2])


def synthesize(font: TTFont) -> int:
    """Half-width katakana (U+FF61–FF9F) and full-width ASCII (U+FF01–FF5E)
    from Maple's own full-width kana and Latin, drawn as plain outlines."""
    cmap = font.getBestCmap()
    todo = []
    for cp in range(0xFF61, 0xFFA0):
        base = {0xFF9E: 0x309B, 0xFF9F: 0x309C}.get(cp) or ord(unicodedata.normalize("NFKC", chr(cp)))
        todo.append((cp, base, HALF))
    for cp in range(0xFF01, 0xFF5F):
        todo.append((cp, ord(unicodedata.normalize("NFKC", chr(cp))), FULL))
    hmtx = font["hmtx"]
    made = 0
    for cp, base, advance in todo:
        if cp in cmap or base not in cmap:
            continue
        source, name = cmap[base], f"uni{cp:04X}"
        bounds = ink(font, source)
        if advance == FULL:  # a 600-unit Latin glyph in the middle of a 1200-unit cell
            transform = (1, 0, 0, 1, (FULL - hmtx[source][0]) // 2, 0)
        elif 0xFF66 <= cp <= 0xFF9D:  # kana: squeezed to half width
            transform = (0.5, 0, 0, 1, 0, 0)
        elif cp in (0xFF9E, 0xFF9F):  # sound marks: moved, not squeezed, to hug the kana before them
            transform = (1, 0, 0, 1, round(60 - bounds[0]), 0)
        else:  # punctuation: moved to the middle of the cell, not squeezed
            middle = 0 if bounds is None else (bounds[0] + bounds[1]) / 2
            transform = (1, 0, 0, 1, round(HALF / 2 - middle), 0)
        draw(font, source, name, transform)
        glyph = font["glyf"][name]
        hmtx.metrics[name] = (advance, glyph.xMin if glyph.numberOfContours else 0)
        for table in font["cmap"].tables:
            if table.isUnicode():
                table.cmap[cp] = name
        made += 1
    return made


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    archive = Path(sys.argv[1])
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != ZIP_SHA256:
        sys.exit(f"{archive}: SHA-256 {digest}, expected {ZIP_SHA256} (MapleMonoNL-CN-unhinted.zip, v7.9)")
    with tempfile.TemporaryDirectory() as scratch, zipfile.ZipFile(archive) as zipped:
        for style in ("Regular", "Bold"):
            src = Path(zipped.extract(f"MapleMonoNL-CN-{style}.ttf", scratch))
            count, made = subset_font(src, FONTS / f"PeesutoCode-{style}.ttf")
            print(f"PeesutoCode-{style}.ttf: {count} characters ({made} made from Maple's own glyphs)")
