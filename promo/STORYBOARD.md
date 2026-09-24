# Storyboard

Beat grid: 100 BPM, beat = 0.6 s, bars on beats 2, 6, 10 … (`music/timeline.js`,
shared with the music). All scenes live in `index.html` / `lib/scenes.js` on one
timeline. Reading holds: raw text ≥ 1.2 s before it flies, landed cards ≥ 1.2 s
with their name, captions ≥ 1.5 s.

## Frame 1
status: built
src: lib/scenes.js#hook
time: 0–4.8 s (beats 0–8)
shape: custom glyph flight (rules: masked reveal, camera push-in)
"On your clipboard": copied code sits selected in a notes window, still, for
1.2 s. ⌥V presses on the first downbeat (beat 2); the window turns to the
card's panel colour and the code is highlighted in place; line by line the
characters arc to the terminal card (Indigo night field). "Copy text. / Paste
a card." rises in masks and holds ~2 s with the card.

## Frame 2
status: built
src: lib/scenes.js#pain
time: 4.8–9.6 s (beats 8–16)
shape: comparison-split
Left, "The usual way": screenshot, shutter flash, crop handles, resize dialog,
a small crooked paste, stuttering. "Four steps." Right, "With Peesuto": one ⌥V
on beat 12, the real card. "One key." (≥ 2 s).

## Frame 3
status: built
src: lib/scenes.js#showcase
time: 9.6–34.8 s (beats 16–58)
shape: spatial-pan-stations
"It reads what you copied." alone, then five stations of 8 beats each (pan 1,
raw text held 3, flight 2, card + name held 2): chat, table, contact, Mermaid,
release notes. The headline settles into the corner at the first flight.

## Frame 4
status: built
src: lib/scenes.js#forms
time: 34.8–44.4 s (beats 58–74)
shape: fixed-anchor-cycle
One poster card; a pill steps through Image, GIF (types itself), Video (line
reveal + play bar), QR code (flip), Pin to screen (floats above a document
window), 3 beats each, 4 for the pin.

## Frame 5
status: built
src: lib/scenes.js#use
time: 44.4–51.6 s (beats 74–86)
shape: cursor-ui-demo (keyboard-driven)
Chat app; Maya types "Here's the helper:"; ⌥V (beat 78); the Paste as…
chooser at the caret with the card preview; push-in; Return (beat 81); the
card lands in the message box; send (beat 83); the message holds.

## Frame 6
status: built
src: lib/scenes.js#trust
time: 51.6–56.4 s (beats 86–94)
shape: kinetic-type-beats
"Runs on your Mac." "No telemetry." "Open source." at beats 86, 87.5, 89.

## Frame 7
status: built
src: lib/scenes.js#outro
time: 56.4–60 s (beats 94–100)
shape: logo-assemble-lockup
App icon, "Peesuto" letter by letter, "Free & open source for macOS",
peesuto.com · github.com/anelikes/peesuto; fade.
