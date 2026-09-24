/* Stage helpers for the promo: raw text blocks laid out glyph by glyph,
 * the raw → card glyph flight, keycaps. Build-time layout only (canvas
 * measurement once at setup); every change over time is a timeline tween. */
(function () {
  const RAW_FONT = 'system-ui, -apple-system, sans-serif';
  const CONTENT_EM = 1.32; // same line box as card.js: baseline at 1.02 em
  
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function el(tag, cls, css, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (css) Object.assign(e.style, css);
    if (parent) parent.appendChild(e);
    return e;
  }

  /** Measures with the DOM (setup time only): canvas `system-ui` does not
   * resolve to the same face as CSS in the render browser. */
  const probe = document.createElement("div");
  Object.assign(probe.style, { position: "absolute", left: "-20000px", top: "0px", whiteSpace: "pre", visibility: "hidden" });
  document.body.appendChild(probe);
  function textWidth(text, css) {
    probe.textContent = "";
    const s = document.createElement("span");
    Object.assign(s.style, css);
    s.textContent = text;
    probe.appendChild(s);
    return s.getBoundingClientRect().width;
  }

  /** Lays `source` out as plain proportional text (what a copied snippet looks
   * like in a notes app) at (x, y). Returns one position per character index
   * (null for newlines), measured from the real text run so kerning holds. */
  function rawLayout(source, opts) {
    const size = opts.size, lh = opts.lineHeight || Math.round(size * 1.45);
    probe.textContent = "";
    Object.assign(probe.style, { fontFamily: opts.font || RAW_FONT, fontSize: size + "px", fontWeight: String(opts.weight || 400), lineHeight: lh + "px" });
    const spans = [];
    for (let ci = 0; ci < source.length; ci++) {
      const ch = source[ci];
      if (ch === "\n") { probe.appendChild(document.createElement("br")); spans.push(null); continue; }
      const s = document.createElement("span");
      s.textContent = ch;
      probe.appendChild(s);
      spans.push(s);
    }
    const origin = probe.getBoundingClientRect();
    const pos = new Array(source.length);
    let row = 0, i = 0, rowStartIdx = 0;
    for (const s of spans) {
      if (!s) { pos[i++] = null; row++; rowStartIdx = i; continue; }
      const r = s.getBoundingClientRect();
      pos[i++] = { x: opts.x + (r.left - origin.left), y: opts.y + row * lh, size, row, rowStart: rowStartIdx };
    }
    probe.textContent = "";
    return { pos, rows: row + 1, lineHeight: lh, size };
  }

  function drawRaw(parent, source, layout, opts, keep) {
    const els = new Array(source.length).fill(null);
    for (let i = 0; i < source.length; i++) {
      const p = layout.pos[i];
      if (!p || !source[i].trim() || !keep(i)) continue;
      const d = el("div", "raw-ch", {
        position: "absolute", left: p.x + "px", top: p.y + "px", fontSize: p.size + "px",
        lineHeight: CONTENT_EM * p.size + "px", height: CONTENT_EM * p.size + "px",
        fontFamily: opts.font || RAW_FONT, fontWeight: opts.weight || 400, color: opts.color, whiteSpace: "pre",
      }, parent);
      d.textContent = source[i];
      els[i] = d;
    }
    return els;
  }

  /**
   * Builds a raw → card morph inside `station` (a positioned div in the
   * scene's world). The card sits at (cx, cy) scaled by k; the raw text at
   * opts.raw. Returns handles and an `animate(tl, t0, dur)` that flies every
   * matched glyph from its raw character to its place on the card, reveals
   * the card's ground and shapes around them, and fades what the card does
   * not keep (Markdown markers, pipes, colons).
   */
  function morph(station, card, opts) {
    const k = opts.k, cx = opts.cx, cy = opts.cy;
    const rawOpts = Object.assign({ color: "#d9d9de" }, opts.raw);
    const layout = rawLayout(card.source, rawOpts);
    const match = PC.matchGlyphs(card, card.source);
    const matched = new Set(match.filter((i) => i >= 0));
    const rawLayer = el("div", "raw-layer", { position: "absolute", left: "0px", top: "0px", width: "1px", height: "1px" }, station);
    const rawEls = drawRaw(rawLayer, card.source, layout, rawOpts, (i) => !matched.has(i));

    const host = el("div", "card-host", {
      position: "absolute", left: cx + "px", top: cy + "px", width: card.width + "px", height: card.height + "px",
      transformOrigin: "0 0", transform: `scale(${k})`,
    }, station);
    // Ground: background + colour field, clipped to the card's rounded rect, with the card's shadow.
    const radius = (opts.radius || 22) / k;
    // The shadow lives on its own layer: the ground's clip-path would clip it.
    const shade = el("div", "card-shade", {
      position: "absolute", left: "0px", top: "0px", width: card.width + "px", height: card.height + "px",
      borderRadius: radius + "px", background: card.background,
      boxShadow: opts.shadow || `0 ${40 / k}px ${90 / k}px rgba(0,0,0,.45), 0 ${8 / k}px ${24 / k}px rgba(0,0,0,.3)`,
    }, host);
    const ground = el("div", "card-ground", {
      position: "absolute", left: "0px", top: "0px", width: card.width + "px", height: card.height + "px",
      borderRadius: radius + "px", overflow: "hidden", background: card.background,
    }, host);
    const inner = el("div", "card-inner", { position: "absolute", left: "0px", top: "0px", width: card.width + "px", height: card.height + "px" }, host);
    const refs = PC.buildCard(card, inner);
    refs.root.style.overflow = "visible";
    refs.root.style.background = "transparent";
    for (const f of refs.fields) ground.appendChild(f);

    const rng = mulberry32(opts.seed || 1);
    const flights = [];
    card.glyphs.forEach((g, gi) => {
      const e = refs.glyphs[gi];
      e.style.transformOrigin = "0 0";
      // Glyphs cross other text and colours in flight on purpose; the card's
      // own contrast and fit are checked by core (templates/checks.ts).
      e.setAttribute("data-layout-ignore", "");
      const si = match[gi];
      if (si < 0 || !layout.pos[si]) { flights.push({ e, g, generated: true }); return; }
      const p = layout.pos[si];
      // The glyph starts as the raw character in the raw face (a proportional
      // system font) and turns into the card's monospace glyph in flight.
      e.textContent = "";
      const mono = el("span", "g-mono", { opacity: 0 }, e);
      mono.textContent = g.ch;
      const raw = el("span", "g-raw", { position: "absolute", left: "0px", top: "0px", fontFamily: rawOpts.font || RAW_FONT, fontWeight: String(rawOpts.weight || 400), color: rawOpts.color, fontSize: g.size + "px" }, e);
      raw.textContent = card.source[si];
      // raw position in card-local coordinates
      const lx = (p.x - cx) / k, ly = (p.y - cy) / k;
      const s = p.size / (k * g.size);
      // a proportional raw glyph is narrower/wider than the mono one; centre it on the raw glyph
      flights.push({ e, mono, raw, g, si, dx: lx - g.x, dy: ly - g.y, s, rot: (rng() - 0.5) * 28, lift: 40 + rng() * 90 });
    });
    flights.sort((a, b) => (a.si ?? 1e9) - (b.si ?? 1e9));

    function prime(tl, t) {
      tl.set(ground, { clipPath: `inset(50% 50% 50% 50% round ${radius}px)`, opacity: 1 }, t);
      tl.set(shade, { opacity: 0 }, t);
      tl.set(refs.shapes.concat(refs.images), { opacity: 0 }, t);
      for (const f of flights) {
        if (f.generated) tl.set(f.e, { opacity: 0 }, t);
        else { tl.set(f.e, { x: f.dx, y: f.dy, scale: f.s, rotation: 0, color: rawOpts.color }, t); tl.set(f.mono, { opacity: 0 }, t); tl.set(f.raw, { opacity: 1 }, t); }
      }
    }

    function animate(tl, t0, dur, o) {
      o = o || {};
      const spread = o.spread ?? dur * 0.45;         // stagger window
      const fly = dur - spread;                         // each glyph's flight
      const live = flights.filter((f) => !f.generated);
      // The ground opens from the centre (masked reveal), a touch before the first glyph lands.
      tl.to(ground, { clipPath: `inset(0% 0% 0% 0% round ${radius}px)`, duration: fly * 0.95, ease: "expo.out" }, t0 + fly * (o.groundAt ?? 0.3));
      tl.fromTo(shade, { opacity: 0 }, { opacity: 1, duration: fly * 0.5, ease: "power1.out" }, t0 + fly * 0.85);
      tl.fromTo(ground, { scale: 0.94 }, { scale: 1, duration: fly * 1.2, ease: "expo.out", transformOrigin: "50% 50%" }, t0 + fly * (o.groundAt ?? 0.3));
      // Shapes by reveal group, then line numbers and other generated glyphs.
      refs.shapes.concat(refs.images).forEach((s, i) => {
        const grp = Number(s.dataset.group || -1);
        tl.fromTo(s, { opacity: 0, scale: 0.96 }, { opacity: 1, scale: 1, duration: fly * 0.6, ease: "power2.out", transformOrigin: "50% 50%" },
          t0 + fly * 0.3 + Math.max(0, grp) * (spread / 8) + (i % 3) * 0.01);
      });
      // Unkept raw characters leave first.
      const gone = rawEls.filter(Boolean);
      if (gone.length) tl.to(gone, { opacity: 0, y: -6, duration: fly * 0.35, ease: "power2.in", stagger: { each: Math.min(0.004, spread / gone.length) } }, t0);
      // Whole raw lines leave together (top line first) so words stay legible
      // in flight; inside a line the far end leads by a few ms, so the line
      // stretches like a ribbon instead of bunching up behind its first glyph.
      const rows = [...new Set(live.map((f) => layout.pos[f.si].row))].sort((a, b) => a - b);
      const lastInRow = {};
      live.forEach((f) => { const r = layout.pos[f.si].row; lastInRow[r] = Math.max(lastInRow[r] ?? 0, f.si); });
      live.forEach((f) => {
        const r = layout.pos[f.si].row, ri = rows.indexOf(r);
        const t = t0 + (rows.length > 1 ? (ri / (rows.length - 1)) * spread : 0) + (lastInRow[r] - f.si) * (o.ribbon ?? 0.004);
        // A quadratic arc from the raw character to the glyph's home, bowed
        // upward; progress is eased once so every glyph accelerates out and
        // settles in. Pure function of progress: seek-safe.
        const cxp = f.dx * 0.5, cyp = Math.min(f.dy, 0) - f.lift * (o.lift ?? 1);
        const proxy = { p: 0 };
        const apply = () => {
          const p = proxy.p, q = 1 - p;
          gsap.set(f.e, {
            x: q * q * f.dx + 2 * q * p * cxp,
            y: q * q * f.dy + 2 * q * p * cyp,
            scale: f.s + (1 - f.s) * p,
            rotation: f.rot * Math.sin(Math.PI * p) * (1 - p * 0.3),
          });
        };
        tl.fromTo(proxy, { p: 0 }, { p: 1, duration: fly, ease: o.ease ?? "power3.inOut", onUpdate: apply, onStart: apply, onComplete: apply, onReverseComplete: apply, immediateRender: false }, t);
        // Colour: during the flight, or (o.colorAt) as one reading pass over the raw text before it lifts.
        if (o.colorAt !== undefined) {
          tl.to([f.e, f.raw], { color: f.g.color, duration: 0.22, ease: "power1.out" }, o.colorAt + layout.pos[f.si].row * 0.025 + (f.si - (layout.pos[f.si].rowStart ?? 0)) * 0.002);
        } else tl.to(f.e, { color: f.g.color, duration: fly * 0.4, ease: "power1.out" }, t + fly * 0.05);
        tl.to(f.raw, { opacity: 0, duration: fly * 0.3, ease: "power1.in" }, t + fly * 0.05);
        tl.to(f.mono, { opacity: 1, duration: fly * 0.3, ease: "power1.out" }, t + fly * 0.1);
      });
      const gen = flights.filter((f) => f.generated);
      if (gen.length) tl.to(gen.map((f) => f.e), { opacity: 1, duration: 0.3, ease: "power1.out", stagger: 0.03 }, t0 + dur - 0.1);
    }
    return { host, shade, ground, refs, rawLayer, rawEls, layout, flights, prime, animate };
  }

  /** A pair of keycaps (labels: array of strings). Returns { root, keys, press(tl, t) }. */
  function keycaps(parent, labels, opts) {
    const size = opts.size || 112;
    const root = el("div", "keycaps", { position: "absolute", left: opts.x + "px", top: opts.y + "px", display: "flex", gap: size * 0.16 + "px" }, parent);
    const keys = labels.map((l) => {
      const k = el("div", "keycap", { width: size + "px", height: size + "px", fontSize: size * 0.46 + "px", borderRadius: size * 0.2 + "px" }, root);
      const cap = el("div", "keycap-top", { borderRadius: size * 0.2 + "px" }, k);
      cap.textContent = l;
      return { k, cap };
    });
    function press(tl, t, hold) {
      hold = hold ?? 0.12;
      keys.forEach(({ cap }, i) => {
        tl.to(cap, { y: size * 0.06, boxShadow: `0 ${size * 0.01}px 0 #0b0b0d, 0 2px 6px rgba(0,0,0,.4)`, duration: 0.06, ease: "power2.in" }, t - 0.06 + i * 0.02);
        tl.to(cap, { y: 0, boxShadow: `0 ${size * 0.07}px 0 #0b0b0d, 0 ${size * 0.12}px ${size * 0.3}px rgba(0,0,0,.5)`, duration: 0.22, ease: "power3.out" }, t + hold + i * 0.02);
      });
    }
    keys.forEach(({ cap }) => (cap.style.boxShadow = `0 ${size * 0.07}px 0 #0b0b0d, 0 ${size * 0.12}px ${size * 0.3}px rgba(0,0,0,.5)`));
    return { root, keys, press };
  }

  /** Splits a caption into word spans inside overflow-hidden masks for a masked rise. */
  function maskedWords(parent, text, css) {
    const line = el("div", "mline", css, parent);
    const words = text.split(" ").map((w, i, a) => {
      const m = el("span", "mask", null, line);
      const s = el("span", "mword", null, m);
      s.textContent = w + (i < a.length - 1 ? " " : "");
      return s;
    });
    return { line, words };
  }

  window.ST = { textWidth, mulberry32, el, rawLayout, drawRaw, morph, keycaps, maskedWords, CONTENT_EM, RAW_FONT };
})();
