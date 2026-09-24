// The promo's beat grid: the single source for the picture (lib/scenes.js,
// loaded as a script) and the music (music/synth.py parses the object literal
// after "= " as JSON, so keep it strict JSON).
// Times are in beats: 100 BPM, one beat = 0.6 s. Bars start on beats 2, 6, 10 …
// so the hook's ⌥V press (beat 2) is the first downbeat. index.html's clip
// data-start/data-duration values must match "sections" × 0.6 s.
window.PROMO_TIMELINE = {
  "bpm": 100,
  "beat": 0.6,
  "barOffset": 2,
  "beats": 100,
  "sections": { "hook": 0, "pain": 8, "showcase": 16, "forms": 58, "use": 74, "trust": 86, "outro": 94, "end": 100 },
  "hook": { "keysIn": 1, "press": 2 },
  "pain": { "steps": [8.5, 9.25, 10, 10.75], "verdict": 11.1, "press": 12 },
  "showcase": {
    "headline": 16,
    "firstRaw": 17.5,
    "panBeats": 1,
    "stations": [
      { "id": "chat", "flight": 21 },
      { "id": "table", "flight": 29 },
      { "id": "info", "flight": 37 },
      { "id": "diagram", "flight": 45 },
      { "id": "changelog", "flight": 53 }
    ]
  },
  "forms": [58, 61, 64, 67, 70],
  "use": { "typeStart": 74.5, "typeEnd": 77.5, "optionV": 78, "enter": 81, "send": 83 },
  "trust": [86, 87.5, 89],
  "outro": 94
};
