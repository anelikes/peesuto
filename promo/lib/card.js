/* Rebuilds a Peesuto card from the geometry promo/scripts/export-cards.ts
 * exported from the real layout engine: every glyph is its own element at the
 * engine's x/y, so the composition can fly characters one by one.
 * Pure DOM construction; no timing here (scenes own their timelines). */
(function () {
  const FONT = { "peesuto-code": "PeesutoCode", "peesuto-text": "PeesutoText", "noto-sans-sc": "PeesutoText" };
  // The engine's drop shadows, approximated.
  const SHADOW = {
    shadow: "0 1px 3px rgba(0,0,0,.18)",
    "shadow-md": "0 4px 10px rgba(0,0,0,.10), 0 2px 4px rgba(0,0,0,.08)",
    "shadow-lg": "0 14px 32px rgba(0,0,0,.28), 0 4px 10px rgba(0,0,0,.18)",
  };
  // The engine puts the baseline one ascent (1.02 em for both Peesuto faces)
  // below the line's top, whatever the line height; CSS centres the content
  // area (ascent + descent = 1.32 em) in the line box. A line box exactly as
  // tall as the content area therefore lands on the engine's baseline.
  // Checked against engine PNGs: 0 px offset (promo/README.md, "Card fidelity").
  const CONTENT_EM = 1.32;

  function el(tag, cls, css) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (css) Object.assign(e.style, css);
    return e;
  }

  /** Builds `card` into `host` (sized to card.width × card.height). Returns element refs. */
  function buildCard(card, host, opts) {
    opts = opts || {};
    const root = el("div", "pc-card", {
      position: "absolute", left: "0px", top: "0px", width: card.width + "px", height: card.height + "px",
      background: card.background, overflow: "hidden", borderRadius: (opts.radius ?? 0) + "px",
    });
    const refs = { root, fields: [], shapes: [], images: [], glyphs: [] };
    for (const im of card.images) if (im.field) {
      const i = el("img", "pc-field", { position: "absolute", left: im.x + "px", top: im.y + "px", width: im.w + "px", height: im.h + "px" });
      i.src = im.src; root.appendChild(i); refs.fields.push(i);
    }
    for (const s of card.shapes) {
      const d = el("div", "pc-shape", {
        position: "absolute", left: s.x + "px", top: s.y + "px", width: s.w + "px", height: s.h + "px",
        background: s.gradient ? `linear-gradient(${{ t: "to top", b: "to bottom", l: "to left", r: "to right" }[s.gradient.dir]}, ${s.gradient.from}, ${s.gradient.to})` : s.color,
        borderRadius: s.radius + "px", boxShadow: s.shadow ? SHADOW[s.shadow] : "none",
      });
      d.dataset.group = s.group ?? -1;
      root.appendChild(d); refs.shapes.push(d);
    }
    for (const im of card.images) if (!im.field) {
      const i = el("img", "pc-img", { position: "absolute", left: im.x + "px", top: im.y + "px", width: im.w + "px", height: im.h + "px" });
      i.src = im.src; i.dataset.group = im.group ?? -1; root.appendChild(i); refs.images.push(i);
    }
    const family = FONT[card.font] || "PeesutoText";
    for (const g of card.glyphs) {
      const s = el("div", "pc-glyph", {
        position: "absolute", left: g.x + "px", top: g.y + "px", height: (CONTENT_EM * g.size) + "px", lineHeight: (CONTENT_EM * g.size) + "px",
        fontSize: g.size + "px", fontFamily: family, fontWeight: g.bold ? "700" : "400", color: g.color, whiteSpace: "pre",
      });
      s.textContent = g.ch;
      root.appendChild(s); refs.glyphs.push(s);
    }
    host.appendChild(root);
    return refs;
  }

  /** Pairs each card glyph with a character of `source` (the raw copied text):
   * in reading order from a cursor, else any unused occurrence. Returns an
   * array of source indices (or -1 for generated glyphs such as line numbers). */
  function matchGlyphs(card, source) {
    const used = new Array(source.length).fill(false);
    let cursor = 0;
    return card.glyphs.map((g) => {
      if (g.generated) return -1;
      let i = source.indexOf(g.ch, cursor);
      // Skip ahead no more than a line's worth; otherwise search from the start.
      if (i >= 0 && !used[i] && i - cursor < 80) { used[i] = true; cursor = i + g.ch.length; return i; }
      for (let j = 0; j < source.length; j++) if (!used[j] && source.startsWith(g.ch, j)) { used[j] = true; return j; }
      return -1;
    });
  }

  window.PC = { buildCard, matchGlyphs, FONT };
})();
