# Peesuto promo (60 s, 16:9)

A HyperFrames composition for the X (Twitter) launch film. 1920×1080, rendered
at 60 fps, English on-screen text only (X autoplays muted), original
synthesised music. Plan and intent: [`BRIEF.md`](BRIEF.md),
[`STORYBOARD.md`](STORYBOARD.md).

## Timeline (100 BPM, one beat = 0.6 s; bars on beats 2, 6, 10 …)

Every copied text is held still and readable before it moves (≥ 1.2 s, about
2 s for the longer ones), every finished card holds ≥ 1.2 s with its name on
screen, and every caption stays ≥ 1.5 s. The flights themselves are unchanged.

| Time | Beats | Scene |
|---|---|---|
| 0–4.8 s | 0–8 | Hook: "On your clipboard", the copied code selected in a notes window, held 1.2 s. ⌥V on the first downbeat (1.2 s); the window turns to the card's panel colour and the code is highlighted in place; line by line the characters arc onto the terminal card (landed ≈ 2.9 s). "Copy text. / Paste a card." from 2.4 s. |
| 4.8–9.6 s | 8–16 | Four steps (screenshot → crop → resize → paste, stuttering) → "Four steps."; one ⌥V at 7.2 s → the card → "One key." |
| 9.6–34.8 s | 16–58 | "It reads what you copied." (alone 1.5 s), then five stations of 8 beats: pan in · raw text with "On your clipboard · …" held 1.8–2.1 s · flight · card + its name held 1.2 s. Chat (flight 12.6 s), table (17.4), contact (22.2), Mermaid (27.0), release notes (31.8). |
| 34.8–44.4 s | 58–74 | One card, many forms, 1.8 s each (pin 2.4 s): image, GIF (types itself), video (reveal + play bar), QR code (flip), pinned above a window. |
| 44.4–51.6 s | 74–86 | Chat: typing, ⌥V (46.8 s), the Paste as… chooser at the caret, Return (48.6 s), the card in the message box, send (49.8 s), the message holds. |
| 51.6–56.4 s | 86–94 | Runs on your Mac. / No telemetry. / Open source. |
| 56.4–60 s | 94–100 | Peesuto, "Free & open source for macOS", peesuto.com · github.com/anelikes/peesuto, fade. |

The code → terminal card example is the hook itself, so the showcase starts
with the chat (the `terminal` sample is still exported, unused).
`music/timeline.js` is the single source for these beats: `lib/scenes.js`
reads it as a script, `music/synth.py` parses it as JSON. The clip
`data-start`/`data-duration` values in `index.html` must match its sections.

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
in `music/timeline.js`, which the picture uses too. `music/master.sh` does a
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
