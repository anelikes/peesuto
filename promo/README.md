# Peesuto promo (42 s, 16:9)

A HyperFrames composition for the X (Twitter) launch film. 1920×1080, rendered
at 60 fps, English on-screen text only (X autoplays muted), original
synthesised music. Plan and intent: [`BRIEF.md`](BRIEF.md),
[`STORYBOARD.md`](STORYBOARD.md).

## Timeline (100 BPM, one beat = 0.6 s)

| Time | Beats | Scene |
|---|---|---|
| 0–3.0 s | 0–5 | Hook: copied code in a notes window → ⌥V on the downbeat → the text is highlighted in place → every character flies to its place on the terminal card. "Copy text. Paste a card." |
| 3.0–7.8 s | 5–13 | Four steps (screenshot → crop → resize → paste, stuttering) vs one key. |
| 7.8–22.2 s | 13–37 | "It reads what you copied": terminal, chat, table, contact, Mermaid, release notes, each raw text flying into its card; the camera pans between stations, faster each time. |
| 22.2–28.2 s | 37–47 | One card, many forms: image, GIF (types itself), video (reveal + play bar), QR code (flip), pinned above a window. |
| 28.2–34.2 s | 47–57 | Real use: typing in a chat, ⌥V, the Paste as… chooser at the caret, Return, the card lands in the message box, sent. |
| 34.2–37.8 s | 57–63 | Runs on your Mac. No telemetry. Open source. |
| 37.8–42 s | 63–70 | Peesuto, "Free & open source for macOS", peesuto.com · github.com/anelikes/peesuto. |

## How the character flight works

The cards are not screenshots. `scripts/export-cards.ts` runs the real
template pipeline from `core/`: `decideTemplate` (local rules, template
forced per sample) → `layoutTemplate` with the Pocket Motion engine
measurer's real advances → one x per grapheme from the width of the styled
prefix, exactly as `composeTemplate` hands glyphs to the engine. It writes
`assets/cards/<id>.json` and `assets/cards/cards.js` (text, x, y, size,
colour, weight, line, reveal group per glyph; the card's shapes, SVG assets
and the full-resolution colour-field backdrop), and renders the same cards
with the engine to `assets/renders/` (the chooser preview, the pasted image,
QA).

`lib/card.js` rebuilds a card from that JSON, one element per glyph.
Card fidelity: the engine puts the baseline one ascent (1.02 em) below the
line top; a CSS line box exactly as tall as the face's content area (1.32 em)
lands on the same baseline. Compared against engine PNGs pixel by pixel, the
best vertical and horizontal offset is 0 px for code, chat, info, table and
diagram cards.

`lib/stage.js` `morph()` lays the raw copied text out in the system font (DOM
measurement at setup), pairs every card glyph with its source character
(reading order, then any unused match), starts each glyph at its raw
character (translated, scaled, still drawn in the raw face) and flies it home
on a quadratic arc, cross-fading to the monospace glyph and its syntax colour.
Whole lines leave together, top line first, the far end of each line a few
milliseconds ahead, so the text stays readable in flight. Characters the card
does not keep (Markdown markers, pipes, colons) fade out; generated glyphs
(line numbers) fade in last. All motion is on one paused GSAP timeline, so
every frame is a pure function of time.

## Music

`music/synth.py` (numpy + scipy, no samples) writes stems and a mix to
`.work/promo/music/`: detuned-saw pad chords (Dmaj9, Bm11, Gmaj9, A6sus, Em),
sine/saw bass, a 16th-note pluck arpeggio with ping-pong delay, soft kick,
clap and hats, keycap clicks for the typing and the ⌥V / Return presses,
filtered-noise risers and a bell accent on every card cut, a convolution
reverb and kick sidechain on pad and arp. Every event is placed on the grid
in `music/timeline.json`, which the picture uses too. `music/master.sh` does a
two-pass loudnorm to −14 LUFS (−1 dBTP) and encodes
`assets/audio/peesuto-bed.m4a`.

## Rebuild

```bash
# cards (scratch COPY of the pinned engine checkout: engine builds write caches)
cp -R .work/native-engine .work/promo/engine
bun promo/scripts/export-cards.ts --engine .work/promo/engine
# music
python3 promo/music/synth.py && sh promo/music/master.sh
# check, preview, render
cd promo && npx hyperframes@0.8.70 check
npx hyperframes@0.8.70 render -o ../.work/promo/render60.mp4 -f 60 --crf 14
cd .. && ffmpeg -i .work/promo/render60.mp4 -i .work/promo/music/master.wav -map 0:v -map 1:a \
  -c:v copy -c:a aac -b:a 256k -shortest -movflags +faststart .work/promo/peesuto-promo.mp4
```

`assets/fonts` is a symlink to `core/src/render/fonts` (Peesuto Code / Text,
Maple Mono subsets, SIL OFL 1.1). UI text uses the system font. GSAP loads
from jsDelivr at render time (the HyperFrames default); no fonts, images or
music are fetched.
