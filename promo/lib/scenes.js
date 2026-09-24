/* The promo's scenes on one paused timeline. Times come from the beat grid in
 * promo/music/timeline.js (shared with the music): B(n) is beat n (0.6 s).
 * All layout is computed here once, before any tween is added. */
(function () {
  const { el, morph, keycaps, maskedWords, rawLayout, mulberry32 } = ST;
  const TL = window.PROMO_TIMELINE, SEC = TL.sections;
  const B = (n) => n * TL.beat;
  const tl = gsap.timeline({ paused: true });
  const $ = (id) => document.getElementById(id);
  // "600 26px <family>" → DOM measurement (see stage.js).
  const textWidth = (text, font) => {
    const [, weight, px, family] = font.match(/^(\d+) (\d+)px (.*)$/);
    return ST.textWidth(text, { fontWeight: weight, fontSize: px + "px", fontFamily: family });
  };

  /** Masked word rise for a caption line. */
  function rise(t, words, o) {
    o = o || {};
    tl.fromTo(words, { yPercent: 110 }, { yPercent: 0, duration: o.d ?? 0.7, ease: o.ease ?? "expo.out", stagger: o.stagger ?? 0.06 }, t);
  }
  function sink(t, words, o) {
    o = o || {};
    tl.to(words, { yPercent: -110, duration: o.d ?? 0.35, ease: "power2.in", stagger: o.stagger ?? 0.03 }, t);
  }

  /** The notes window holding the raw copied text. Returns its parts and the text origin. */
  function notesWindow(parent, x, y, w, h, title) {
    const win = el("div", "notes", { left: x + "px", top: y + "px", width: w + "px", height: h + "px" }, parent);
    const bar = el("div", "notes-bar", null, win);
    [22, 44, 66].forEach((dx) => el("div", "notes-dot", { left: dx + "px" }, bar));
    el("div", "notes-title", null, bar).textContent = title;
    return { win, bar, textX: x + 44, textY: y + 56 + 34 };
  }

  // ─────────────────────────────── 1. Hook ───────────────────────────────
  (function hook() {
    const world = $("hook-world");
    const card = CARDS.hook;
    const k = 0.7, cx = 1920 - 150 - card.width * k, cy = (1080 - card.height * k) / 2;
    const nw = notesWindow(world, 150, 262, 700, 556, "ease.js — Notes");
    // Selection behind every line: this text was just copied.
    const size = 33, lh = 50;
    const lay = rawLayout(card.source, { x: nw.textX, y: nw.textY, size, lineHeight: lh });
    const lines = card.source.split("\n");
    const sels = lines.map((line, r) => {
      if (!line.length) return null;
      const w = textWidth(line, `400 ${size}px ${ST.RAW_FONT}`);
      return el("div", "sel", { left: nw.textX - 4 + "px", top: nw.textY + r * lh + 2 + "px", width: w + 8 + "px", height: size * 1.32 + "px" }, world);
    }).filter(Boolean);
    const m = morph(world, card, { k, cx, cy, seed: 3, radius: 26, raw: { x: nw.textX, y: nw.textY, size, lineHeight: lh, color: "#1d1d1f" } });
    // Glyph layer above the window.
    world.appendChild(m.host);
    const keys = keycaps(world, ["⌥", "V"], { x: 500 - 129, y: 872, size: 120 });
    const clip = el("div", "kind abs", { left: "150px", top: "206px" }, world); clip.textContent = "On your clipboard";
    const P = B(TL.hook.press);

    m.prime(tl, 0);
    // Keycaps rise in, press on the downbeat.
    // The copied snippet is on screen, selected and still, before anything moves.
    tl.fromTo(keys.root, { y: 60, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: "expo.out" }, B(TL.hook.keysIn));
    keys.press(tl, P, 0.1);
    tl.to(keys.root, { y: 30, opacity: 0, duration: 0.4, ease: "power2.in" }, P + 0.85);
    tl.to(clip, { opacity: 0, duration: 0.3 }, P + 0.2);
    // The selection clears as the text lifts off; the window steps back and goes.
    tl.to(sels, { opacity: 0, duration: 0.12, ease: "none" }, P);
    // The window empties top-down behind the departing lines (a wipe, not a fade: no grey).
    // The empty lower part folds up under the text; once the last line has left, the window closes to a line.
    tl.fromTo(nw.win, { clipPath: "inset(0% 0% 0% 0% round 18px)" }, { clipPath: "inset(0% 0% 25% 0% round 18px)", duration: 0.3, ease: "power2.out" }, P + 0.08);
    tl.to(nw.win, { clipPath: "inset(37% 0% 63% 0% round 18px)", duration: 0.3, ease: "power3.in" }, P + 0.85);
    // The flight.
// On the key press the notes window turns to the card's panel colour and the
    // text is highlighted in place (Peesuto reading it); then the lines lift off.
    tl.to(nw.win, { backgroundColor: "#1a1d23", boxShadow: "0 40px 90px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.08)", duration: 0.25, ease: "power2.out" }, P);
    tl.to(nw.bar, { backgroundColor: "#22252c", borderBottomColor: "#2a2e36", duration: 0.25, ease: "power2.out" }, P);
    tl.to(nw.bar.querySelectorAll(".notes-dot"), { backgroundColor: "#3a3e46", duration: 0.25 }, P);
    tl.to(nw.bar.querySelector(".notes-title"), { color: "#8b93a3", duration: 0.25 }, P);
    m.animate(tl, P + 0.22, 1.25, { spread: 0.42, lift: 1, ribbon: 0.005, colorAt: P + 0.02 });
    // Caption where the window was.
    const c1 = maskedWords(world, "Copy text.", { left: "150px", top: "388px", fontSize: "104px" });
    const c2 = maskedWords(world, "Paste a card.", { left: "150px", top: "516px", fontSize: "104px" });
    c1.line.className += " display"; c2.line.className += " display";
    rise(P + 1.15, c1.words, { stagger: 0.07 });
    rise(P + 1.35, c2.words, { stagger: 0.07 });
    // Camera: a slow push-in, then a push through into the next scene.
    const END = B(SEC.pain);
    tl.fromTo(world, { scale: 1 }, { scale: 1.03, duration: END - 0.22, ease: "sine.inOut" }, 0);
    tl.to(world, { scale: 1.12, opacity: 0, duration: 0.22, ease: "power2.in" }, END - 0.22);
  })();

  // ─────────────────────────────── 2. Pain ───────────────────────────────
  (function pain() {
    const T = B(SEC.pain), END = B(SEC.showcase), PR = B(TL.pain.press), world = $("pain-world");
    const P = { w: 800, h: 560, y: 210 };
    const L = el("div", "panel", { left: "120px", top: P.y + "px", width: P.w + "px", height: P.h + "px" }, world);
    const R = el("div", "panel", { left: 1000 + "px", top: P.y + "px", width: P.w + "px", height: P.h + "px" }, world);
    const hl = el("div", "label abs", { left: "120px", top: "140px", fontSize: "34px" }, world); hl.textContent = "The usual way";
    const hr = el("div", "label abs", { left: "1000px", top: "140px", fontSize: "34px" }, world); hr.textContent = "With Peesuto";

    // A small copy of the notes window in each panel.
    function mini(parent) {
      const w = el("div", "notes", { left: "150px", top: "90px", width: "500px", height: "330px", borderRadius: "14px" }, parent);
      const bar = el("div", "notes-bar", { height: "40px" }, w);
      [16, 34, 52].forEach((dx) => el("div", "notes-dot", { left: dx + "px", top: "14px", width: "11px", height: "11px" }, bar));
      const txt = el("div", "abs", { left: "30px", top: "62px", fontSize: "20px", lineHeight: "31px", color: "#1d1d1f", whiteSpace: "pre", fontFamily: "var(--ui)" }, w);
      txt.textContent = CARDS.hook.source;
      return w;
    }
    const ml = mini(L), mr = mini(R);

    // Left: four awkward steps.
    const steps = ["Screenshot", "Crop", "Resize", "Paste"];
    const stepAt = TL.pain.steps.map(B);
    const chips = [];
    let cx = 60;
    steps.forEach((s, i) => {
      const c = el("div", "chip", { left: cx + "px", top: "478px" }, L); c.textContent = s;
      cx += textWidth(s, `600 30px ${ST.RAW_FONT}`) + 20;
      chips.push(c);
      if (i < 3) { const a = el("div", "chip", { left: cx + "px", top: "478px" }, L); a.textContent = "→"; cx += 50; chips.push(a); }
    });
    // Screenshot: crosshair drags a selection in stutters.
    const dim = el("div", "abs", { left: "0px", top: "0px", width: P.w + "px", height: P.h + "px", background: "rgba(0,0,0,.35)", opacity: 0 }, L);
    const selR = el("div", "abs", { left: "170px", top: "140px", width: "10px", height: "10px", border: "2px dashed rgba(255,255,255,.9)", opacity: 0 }, L);
    const cross = el("div", "abs", { left: "170px", top: "140px", width: "34px", height: "34px", opacity: 0 }, L);
    cross.innerHTML = '<svg width="34" height="34" viewBox="0 0 34 34"><path d="M17 0v34M0 17h34" stroke="#fff" stroke-width="2"/></svg>';
    const flash = el("div", "abs", { left: "0px", top: "0px", width: P.w + "px", height: P.h + "px", background: "#fff", opacity: 0 }, L);
    // Crop: the grab floats with handles
    const grab = el("div", "abs", { left: "170px", top: "140px", width: "440px", height: "240px", overflow: "hidden", borderRadius: "4px", opacity: 0, boxShadow: "0 16px 40px rgba(0,0,0,.5)" }, L);
    const grabImg = el("div", "abs", { left: "-20px", top: "-50px", width: "500px", height: "330px" }, grab);
    grabImg.appendChild(mini(el("div", "abs", { left: "-150px", top: "-90px" }, grabImg)));
    const handles = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([hx, hy]) => el("div", "abs", { left: 170 + hx * 440 - 7 + "px", top: 140 + hy * 240 - 7 + "px", width: "14px", height: "14px", background: "#fff", borderRadius: "3px", opacity: 0 }, L));
    const dlg = el("div", "dialog", { left: "440px", top: "300px", width: "300px", height: "118px", opacity: 0 }, L);
    dlg.innerHTML = '<div style="position:absolute;left:20px;top:16px;color:#a1a1a6;font-size:18px">Image size</div><div style="position:absolute;left:20px;top:52px;font-size:24px;font-weight:600">1284 × 612 px</div><div style="position:absolute;left:20px;top:86px;font-size:17px;color:#a1a1a6">Width ▾&nbsp;&nbsp;Height ▾&nbsp;&nbsp;DPI 144</div>';
    const pasted = el("div", "abs", { left: "250px", top: "150px", width: "300px", height: "164px", overflow: "hidden", opacity: 0, filter: "blur(1.2px)", borderRadius: "2px", boxShadow: "0 6px 14px rgba(0,0,0,.4)" }, L);
    const pImg = el("img", "abs", { left: "-8px", top: "-30px", width: "330px" }, pasted); pImg.src = "assets/renders/hook-none.png";

    // Right: one keystroke → the real card.
    const rk = keycaps(R, ["⌥", "V"], { x: 400 - 107, y: 425, size: 96 });
    const rCard = el("img", "abs", { left: "210px", top: "60px", width: "380px", height: "380px", borderRadius: "16px", opacity: 0, boxShadow: "0 24px 60px rgba(0,0,0,.5)" }, R);
    rCard.src = "assets/renders/hook-none.png";

    // Verdicts
    const vl = maskedWords(world, "Four steps.", { left: "120px", top: "820px", fontSize: "84px" }); vl.line.className += " display";
    const vr = maskedWords(world, "One key.", { left: "1000px", top: "820px", fontSize: "84px" }); vr.line.className += " display";

    // Entry
    tl.fromTo([L, hl, hr], { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.5, ease: "expo.out", stagger: 0.05 }, T);
    tl.fromTo(R, { opacity: 0, y: 30 }, { opacity: 0.55, y: 0, duration: 0.5, ease: "expo.out" }, T + 0.05);
    // Step 1: screenshot
    const s1 = stepAt[0];
    tl.to(chips[0], { color: "#f5f5f7", duration: 0.05 }, s1);
    tl.to([dim, cross, selR], { opacity: 1, duration: 0.05 }, s1);
    tl.to(selR, { width: 440, height: 240, duration: 0.45, ease: "steps(6)" }, s1 + 0.05);
    tl.to(cross, { x: 440, y: 240, duration: 0.45, ease: "steps(6)" }, s1 + 0.05);
    // Step 2: crop (shutter flash, the grab lifts with handles)
    const s2 = stepAt[1];
    tl.to(chips[0], { color: "#6e6e73", duration: 0.05 }, s2);
    tl.to(chips[2], { color: "#f5f5f7", duration: 0.05 }, s2);
    tl.fromTo(flash, { opacity: 0.85 }, { opacity: 0, duration: 0.25, ease: "power2.out", immediateRender: false }, s2);
    tl.to([cross, selR], { opacity: 0, duration: 0.05 }, s2);
    tl.to(ml, { opacity: 0.25, duration: 0.05 }, s2);
    tl.to([grab, ...handles], { opacity: 1, duration: 0.05 }, s2);
    tl.to(grab, { x: -6, y: 4, duration: 0.12, ease: "steps(2)" }, s2 + 0.2);
    tl.to(handles, { x: -6, y: 4, duration: 0.12, ease: "steps(2)" }, s2 + 0.2);
    // Step 3: resize dialog, the grab squashes
    const s3 = stepAt[2];
    tl.to(chips[2], { color: "#6e6e73", duration: 0.05 }, s3);
    tl.to(chips[4], { color: "#f5f5f7", duration: 0.05 }, s3);
    tl.to(dlg, { opacity: 1, duration: 0.05 }, s3);
    tl.to(grab, { scaleX: 0.82, scaleY: 0.9, transformOrigin: "0 0", duration: 0.3, ease: "steps(3)" }, s3 + 0.1);
    tl.to(handles, { opacity: 0, duration: 0.05 }, s3 + 0.1);
    // Step 4: paste — small, soft, a little crooked
    const s4 = stepAt[3];
    tl.to(chips[4], { color: "#6e6e73", duration: 0.05 }, s4);
    tl.to(chips[6], { color: "#f5f5f7", duration: 0.05 }, s4);
    tl.to([dlg, grab, dim], { opacity: 0, duration: 0.05 }, s4);
    tl.to(ml, { opacity: 1, duration: 0.05 }, s4);
    tl.fromTo(pasted, { opacity: 0, rotation: 0 }, { opacity: 1, rotation: -2.5, duration: 0.2, ease: "steps(2)" }, s4 + 0.05);
    tl.to(chips[6], { color: "#6e6e73", duration: 0.2 }, s4 + 0.55);
    rise(B(TL.pain.verdict), vl.words);
    tl.to([L, hl], { opacity: 0.4, duration: 0.5, ease: "power2.out" }, PR - 0.25);
    tl.to(vl.line, { opacity: 0.4, duration: 0.5, ease: "power2.out" }, PR - 0.25);
    // Right: one keystroke on beat 10.
    tl.to(R, { opacity: 1, duration: 0.3 }, PR - 0.35);
    rk.press(tl, PR, 0.1);
    tl.to(mr, { opacity: 0, scale: 0.96, duration: 0.25, ease: "power2.out", transformOrigin: "50% 50%" }, PR);
    tl.fromTo(rCard, { opacity: 0, scale: 0.86 }, { opacity: 1, scale: 1, duration: 0.7, ease: "expo.out", transformOrigin: "50% 60%" }, PR + 0.03);
    rise(PR + 0.15, vr.words);
    // After the verdict, the camera drifts toward the answer.
    tl.to(world, { scale: 1.03, x: -40, duration: END - PR - 0.45, ease: "sine.inOut" }, PR + 0.1);
    // Exit: everything slides left as the camera moves on.
    tl.to(world, { x: -160, opacity: 0, duration: 0.3, ease: "power2.in" }, END - 0.3);
  })();

  // ─────────────────────────────── 3. Showcase ───────────────────────────────
  // Per station (8 beats): pan in (1) · raw text held still and readable (3) ·
  // flight (2) · finished card held with its name (2). The hook already showed
  // code → terminal card, so the showcase starts with the chat.
  (function showcase() {
    const SC = TL.showcase, T = B(SEC.showcase), END = B(SEC.forms), world = $("show-world"), hud = $("show-hud");
    const kinds = { terminal: "Terminal output", chat: "A chat", table: "A Markdown table", info: "Contact details", diagram: "A Mermaid chart", changelog: "Release notes" };
    const outs = { terminal: "Terminal card", chat: "Chat bubbles", table: "Data grid", info: "Contact card", diagram: "Flow diagram", changelog: "Release card" };
    const spots = [[0, 0], [2100, 300], [4200, -120], [6300, 260], [8400, -60], [10500, 220]];
    const FLY = 1.15, PAN = B(SC.panBeats);
    const plan = SC.stations.map((st, i) => ({ id: st.id, at: B(st.flight), fly: FLY, sx: spots[i][0], sy: spots[i][1] }));
    const morphs = plan.map((p, i) => {
      const card = CARDS[p.id];
      const station = el("div", "abs", { left: p.sx + "px", top: p.sy + "px", width: "1920px", height: "1080px" }, world);
      const k = 0.68, cx = 1920 - 150 - card.width * k, cy = (1080 - card.height * k) / 2 + 30;
      const kind = el("div", "kind abs", { left: "150px", top: "330px" }, station); kind.textContent = "On your clipboard · " + kinds[p.id];
      const m = morph(station, card, { k, cx, cy, seed: 10 + i, radius: 24, raw: { x: 150, y: 400, size: 36, lineHeight: 54, color: "#dcdce0" } });
      const out = maskedWords(station, outs[p.id], { left: "150px", top: "392px", fontSize: "80px" });
      out.line.className += " display";
      return { p, m, station, kind, out };
    });
    // Headline: alone and large first, then (while the first text is read) it stays;
    // it settles into the corner as a running title when the first flight starts.
    const head = maskedWords(hud, "It reads what you copied.", { left: "150px", top: "120px", fontSize: "92px" });
    head.line.className += " display";
    head.line.style.transformOrigin = "0 0";
    rise(T + 0.02, head.words, { stagger: 0.05 });
    tl.to(head.line, { scale: 0.5, x: 0, y: -40, duration: 0.7, ease: "power3.inOut" }, plan[0].at - 0.2);
    tl.to(head.line, { opacity: 0.8, duration: 0.7 }, plan[0].at - 0.2);

    tl.set(world, { x: 0, y: 0, scale: 1 }, T);
    morphs.forEach(({ p, m, kind, out }, i) => {
      m.prime(tl, T);
      tl.set(m.rawLayer, { opacity: 0 }, T);
      tl.set(kind, { opacity: 0 }, T);
      if (i > 0) {
        // pan in 4 beats before the flight; the raw text arrives with the camera and then holds still
        const t0 = p.at - B(4);
        tl.to(world, { x: -p.sx, y: -p.sy, duration: PAN, ease: "power3.inOut" }, t0);
        tl.to(world, { keyframes: [{ scale: 0.93, duration: PAN * 0.5, ease: "sine.out" }, { scale: 1, duration: PAN * 0.5, ease: "sine.in" }] }, t0);
        tl.to(m.rawLayer, { opacity: 1, duration: 0.3 }, t0 + 0.1);
        tl.to(kind, { opacity: 1, duration: 0.3 }, t0 + 0.1);
      } else {
        tl.to(m.rawLayer, { opacity: 1, duration: 0.5 }, B(SC.firstRaw));
        tl.to(kind, { opacity: 1, duration: 0.5 }, B(SC.firstRaw));
      }
      m.animate(tl, p.at, p.fly, { spread: p.fly * 0.38, lift: 0.8 });
      // the finished card holds; only a very gentle push until the camera moves on
      const next = i + 1 < plan.length ? plan[i + 1].at - B(4) : END - 0.3;
      tl.fromTo(m.host.parentNode, { scale: 1 }, { scale: 1.012, duration: next - p.at, ease: "none", transformOrigin: "62% 50%" }, p.at);
      // once the raw text has flown, the left side names what it became (it stays through the hold)
      rise(p.at + p.fly * 0.7, out.words, { stagger: 0.05, d: 0.6 });
    });
    // Out: the last card pushes forward into the next scene.
    tl.to(world, { scale: 1.12, opacity: 0, duration: 0.3, ease: "power2.in" }, END - 0.3);
    tl.to(head.line, { opacity: 0, duration: 0.3 }, END - 0.3);
  })();

  // ─────────────────────────────── 4. Forms ───────────────────────────────
  // Each state holds ≥ 1.2 s fully formed, its caption on screen the whole state.
  (function forms() {
    const T = B(SEC.forms), END = B(SEC.use), world = $("forms-world");
    const card = CARDS.forms, qr = CARDS.qr;
    const k = 0.6, W = card.width * k, cx = (1920 - W) / 2, cy = 250;
    // Chips
    const names = ["Image", "GIF", "Video", "QR code", "Pin to screen"];
    const font = `600 34px ${ST.RAW_FONT}`;
    const widths = names.map((n) => textWidth(n, font) + 56);
    const total = widths.reduce((a, b) => a + b, 0) + 12 * (names.length - 1);
    let x = (1920 - total) / 2;
    const pill = el("div", "fpill", { left: x + "px", top: "110px", width: widths[0] + "px" }, world);
    const chipEls = names.map((n, i) => {
      const c = el("div", "fchip", { left: x + "px", top: "110px", width: widths[i] + "px", textAlign: "center" }, world);
      c.textContent = n; c.dataset.x = x; x += widths[i] + 12; return c;
    });
    // Pin scene backdrop: a plain document window.
    const doc = el("div", "app", { left: "260px", top: "215px", width: "1400px", height: "690px", opacity: 0, background: "#fbfaf7" }, world);
    const docBar = el("div", "notes-bar", { background: "#efede8" }, doc);
    [22, 44, 66].forEach((dx) => el("div", "notes-dot", { left: dx + "px" }, docBar));
    el("div", "notes-title", null, docBar).textContent = "Launch plan";
    [["Launch plan", 44, 700, 60], ["", 0, 0, 0]].slice(0, 1).forEach(([t]) => {
      const h = el("div", "abs", { left: "90px", top: "110px", fontSize: "44px", fontWeight: 700, color: "#1d1d1f" }, doc); h.textContent = t;
    });
    ["Keep the chooser one keystroke away.", "Cards stay readable on a phone.", "Everything renders on this Mac."].forEach((t, i) => {
      const p = el("div", "abs", { left: "90px", top: 200 + i * 64 + "px", fontSize: "30px", color: "#4a4845" }, doc); p.textContent = "•  " + t;
    });
    [0, 1, 2, 3].forEach((i) => el("div", "abs", { left: "90px", top: 430 + i * 50 + "px", width: [900, 820, 960, 640][i] + "px", height: "16px", borderRadius: "8px", background: "#e9e6df" }, doc));

    // The card, as a flipper holding the poster card (front) and the QR card (back).
    const flip = el("div", "abs", { left: cx + "px", top: cy + "px", width: W + "px", height: W + "px", transformStyle: "preserve-3d" }, world);
    flip.setAttribute("data-layout-allow-overlap", ""); // two faces of one card, back to back
    const faceA = el("div", "abs", { left: "0px", top: "0px", width: W + "px", height: W + "px", backfaceVisibility: "hidden" }, flip);
    const faceB = el("div", "abs", { left: "0px", top: "0px", width: W + "px", height: W + "px", backfaceVisibility: "hidden", transform: "rotateY(180deg)" }, flip);
    function face(host, c) {
      const shade = el("div", "abs", { left: "0px", top: "0px", width: W + "px", height: W + "px", borderRadius: "24px", background: c.background, boxShadow: "0 40px 90px rgba(0,0,0,.5)", overflow: "hidden" }, host);
      const inner = el("div", "abs", { left: "0px", top: "0px", width: c.width + "px", height: c.height + "px", transformOrigin: "0 0", transform: `scale(${k})` }, shade);
      const refs = PC.buildCard(c, inner);
      // Engine-checked cards; the two faces share one place on purpose.
      refs.glyphs.forEach((g) => g.setAttribute("data-layout-ignore", ""));
      return refs;
    }
    const A = face(faceA, card), Bq = face(faceB, qr);
    const badge = el("div", "badge", { left: cx + 20 + "px", top: cy + 20 + "px", opacity: 0 }, world);
    // Video bar under the card
    const bar = el("div", "abs", { left: cx + "px", top: cy + W + 34 + "px", width: W + "px", height: "6px", borderRadius: "3px", background: "rgba(255,255,255,.18)", opacity: 0 }, world);
    const prog = el("div", "abs", { left: "0px", top: "0px", width: W + "px", height: "6px", borderRadius: "3px", background: "#f5f5f7", transformOrigin: "0 50%" }, bar);
    const cap = el("div", "label abs", { left: "0px", top: cy + W + 64 + "px", width: "1920px", textAlign: "center", fontSize: "30px" }, world);
    const capLines = ["PNG, pasted as an image", "GIF: it types itself", "MP4, for anywhere video plays", "A QR code of the same text", "Pinned above every window"];
    const capEls = capLines.map((t) => { const s = el("div", "abs", { left: "0px", top: "0px", width: "1920px", opacity: 0 }, cap); s.textContent = t; return s; });

    const at = TL.forms.map(B);
    function activate(i) {
      tl.to(pill, { x: Number(chipEls[i].dataset.x) - Number(chipEls[0].dataset.x), width: widths[i], duration: 0.4, ease: "expo.out" }, at[i]);
      tl.to(chipEls, { color: "#6e6e73", duration: 0.2 }, at[i]);
      tl.to(chipEls[i], { color: "#0b0b0d", duration: 0.2 }, at[i]);
      capEls.forEach((c, j) => { if (j !== i) tl.to(c, { opacity: 0, duration: 0.15 }, at[i]); });
      tl.fromTo(capEls[i], { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.4, ease: "expo.out" }, at[i] + 0.05);
    }
    // Enter
    tl.fromTo([pill, ...chipEls], { opacity: 0, y: -20 }, { opacity: 1, y: 0, duration: 0.5, ease: "expo.out", stagger: 0.03 }, T);
    tl.fromTo(flip, { scale: 0.86, opacity: 0, clipPath: "inset(50% 50% 50% 50% round 24px)" }, { scale: 1, opacity: 1, clipPath: "inset(0% 0% 0% 0% round 24px)", duration: 0.6, ease: "expo.out" }, T);
    tl.set(flip, { clipPath: "none" }, at[1] - 0.05);
    activate(0);
    // GIF: typewriter
    activate(1);
    tl.set(badge, { opacity: 1 }, at[1]);
    badge.textContent = "GIF";
    tl.set(A.glyphs, { opacity: 0 }, at[1]);
    A.glyphs.forEach((g, i) => tl.set(g, { opacity: 1 }, at[1] + 0.06 + i * 0.02));
    // Video: reveal by line, with a play bar
    activate(2);
    tl.set(badge, { opacity: 0 }, at[2]);
    tl.set(A.glyphs, { opacity: 0 }, at[2]);
    const lines = [...new Set(card.glyphs.map((g) => g.line))];
    lines.forEach((ln, i) => {
      const gs = A.glyphs.filter((_, gi) => card.glyphs[gi].line === ln);
      tl.fromTo(gs, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.28, ease: "power2.out", immediateRender: false }, at[2] + 0.08 + i * 0.08);
    });
    tl.to(bar, { opacity: 1, duration: 0.2 }, at[2]);
    tl.fromTo(prog, { scaleX: 0 }, { scaleX: 1, duration: at[3] - at[2] - 0.1, ease: "none" }, at[2]);
    tl.set(prog, { scaleX: 0 }, T);
    tl.to(bar, { opacity: 0, duration: 0.2 }, at[3] - 0.05);
    // QR: flip
    activate(3);
    tl.to(flip, { rotationY: 180, duration: 0.55, ease: "power3.inOut" }, at[3] - 0.05);
    // Pin: flip back while the card shrinks into the corner, floating over a document window.
    activate(4);
    tl.to(flip, { rotationY: 360, duration: 0.5, ease: "power3.inOut" }, at[4] - 0.05);
    tl.fromTo(doc, { opacity: 0, scale: 0.97 }, { opacity: 1, scale: 1, duration: 0.6, ease: "expo.out", transformOrigin: "50% 50%" }, at[4]);
    // centre of the card → (1400, 430): over the window's top-right, where a pinned note would sit
    tl.to(flip, { x: 1400 - (cx + W / 2), y: 430 - (cy + W / 2), scale: 0.4, duration: 0.7, ease: "expo.inOut" }, at[4] + 0.05);
    tl.to(flip, { y: `-=8`, duration: 0.5, ease: "sine.inOut", yoyo: true, repeat: 1 }, at[4] + 0.75);
    tl.to(world, { opacity: 0, scale: 1.04, duration: 0.3, ease: "power2.in" }, END - 0.3);
  })();

  // ─────────────────────────────── 5. Use ───────────────────────────────
  (function use() {
    const T = B(SEC.use), END = B(SEC.trust), U = TL.use, world = $("use-world"), over = $("use-overlay");
    const X = 240, Y = 100, W = 1440, H = 830;
    const app = el("div", "app", { left: X + "px", top: Y + "px", width: W + "px", height: H + "px" }, world);
    const side = el("div", "side", null, app);
    const ws = el("div", "abs", { left: "40px", top: "40px", fontSize: "26px", fontWeight: 700, color: "#1d1d1f" }, side); ws.textContent = "Pocket Motion";
    ["general", "motion", "design", "releases"].forEach((c, i) => {
      const d = el("div", "chan" + (c === "motion" ? " on" : ""), { top: 110 + i * 56 + "px" }, side); d.textContent = "# " + c;
    });
    const head = el("div", "abs", { left: "380px", top: "0px", right: "0px", height: "86px", borderBottom: "1px solid #eceae6" }, app);
    const ht = el("div", "abs", { left: "0px", top: "26px", fontSize: "28px", fontWeight: 700 }, head); ht.textContent = "# motion";
    // Thread
    const thread = el("div", "abs", { left: "0px", top: "0px", width: W + "px", height: H + "px" }, app);
    function message(y, who, color, name, time, text) {
      const m = el("div", "msg", { top: y + "px" }, thread);
      const a = el("div", "avatar", { background: color }, m); a.textContent = who;
      const n = el("div", "who", null, m); n.innerHTML = `${name}<span>${time}</span>`;
      if (text) { const s = el("div", "says", null, m); s.textContent = text; }
      return m;
    }
    const m1 = message(130, "T", "#0f7a70", "Theo", "10:02", "The shutter demo still snaps at the end. Did the easing helper land?");
    const m2 = message(240, "M", "#6a4fd6", "Maya", "10:03", "Checking. I have it right here.");
    // The sent message (hidden until send)
    const mine = message(350, "M", "#6a4fd6", "Maya", "10:04", "Here's the helper:");
    const sentCard = el("img", "abs", { left: "72px", top: "82px", width: "300px", height: "300px", borderRadius: "14px", boxShadow: "0 1px 0 rgba(0,0,0,.05), 0 0 0 1px #e8e6e1" }, mine);
    sentCard.src = "assets/renders/hook-none.png";
    // Composer
    const comp = el("div", "composer", { left: "380px", top: H - 128 + "px", width: W - 420 + "px", height: "92px" }, app);
    const ph = el("div", "abs", { left: "26px", top: "28px", fontSize: "25px", color: "#a3a19c" }, comp); ph.textContent = "Message #motion";
    const typed = "Here's the helper:";
    const tFont = `400 25px ${ST.RAW_FONT}`;
    const typedEl = el("div", "abs", { left: "26px", top: "28px", fontSize: "25px", color: "#1d1d1f", whiteSpace: "pre" }, comp);
    const chars = [...typed].map((ch) => { const s = el("span", null, { opacity: 0 }, typedEl); s.textContent = ch; return s; });
    const caret = el("div", "abs", { left: "26px", top: "28px", width: "2.5px", height: "32px", background: "#2a6df4" }, comp);
    const send = el("div", "abs", { right: "18px", top: "22px", width: "48px", height: "48px", borderRadius: "12px", background: "#e7e5e0" }, comp);
    send.innerHTML = '<svg width="48" height="48" viewBox="0 0 48 48"><path d="M24 33V16M17 22l7-7 7 7" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const attach = el("img", "abs", { left: "26px", top: "18px", width: "112px", height: "112px", borderRadius: "10px", opacity: 0, boxShadow: "0 0 0 1px #e3e1dc" }, comp);
    attach.src = "assets/renders/hook-none.png";

    // Chooser near the caret (above the composer), as in the app.
    const caretX = X + 380 + 26 + textWidth(typed, tFont), composerTop = Y + H - 128;
    const chH = 690, chX = caretX - 30, chY = composerTop - chH - 14;
    const ch = el("div", "chooser", { left: chX + "px", top: chY + "px", height: chH + "px" }, world);
    const title = el("div", "abs", { left: "24px", top: "22px", fontSize: "24px", fontWeight: 700 }, ch); title.textContent = "Paste as…";
    const cancel = el("div", "abs", { right: "18px", top: "16px", fontSize: "19px", color: "#8e8e93", fontWeight: 500 }, ch);
    cancel.innerHTML = 'Cancel <span style="display:inline-block;margin-left:8px;padding:5px 10px;border-radius:9px;background:#2a2a2e;color:#e9e9ec;font-weight:600;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)">esc</span>';
    const prev = el("div", "abs", { left: "18px", top: "70px", width: "364px", height: "236px", borderRadius: "16px", background: "#1c1c1f", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.06)" }, ch);
    const pimg = el("img", "abs", { left: "82px", top: "18px", width: "200px", height: "200px", borderRadius: "10px" }, prev); pimg.src = "assets/renders/hook-none.png";
    const ic = {
      img: '<svg viewBox="0 0 28 28" width="28" height="28"><rect x="3" y="5" width="22" height="18" rx="3" fill="none" stroke="#c7c7cc" stroke-width="1.8"/><circle cx="10" cy="11" r="2.2" fill="#c7c7cc"/><path d="M4 21l7-6 5 4 3-2 5 4" fill="none" stroke="#c7c7cc" stroke-width="1.8"/></svg>',
      gif: '<svg viewBox="0 0 28 28" width="28" height="28"><path d="M9 6l-6 8 6 8M15 6l-6 8 6 8M21 6l-6 8 6 8" fill="none" stroke="#c7c7cc" stroke-width="1.8" stroke-linejoin="round"/></svg>',
      vid: '<svg viewBox="0 0 28 28" width="28" height="28"><rect x="3" y="6" width="22" height="16" rx="2.5" fill="none" stroke="#c7c7cc" stroke-width="1.8"/><path d="M7 6v16M21 6v16M3 11h4M3 17h4M21 11h4M21 17h4" stroke="#c7c7cc" stroke-width="1.6"/></svg>',
      qr: '<svg viewBox="0 0 28 28" width="28" height="28"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="none" stroke="#c7c7cc" stroke-width="1.8"/><rect x="16" y="4" width="8" height="8" rx="1.5" fill="none" stroke="#c7c7cc" stroke-width="1.8"/><rect x="4" y="16" width="8" height="8" rx="1.5" fill="none" stroke="#c7c7cc" stroke-width="1.8"/><path d="M16 16h3v3h-3zM21 21h3v3h-3zM16 22h2M22 16h2" stroke="#c7c7cc" stroke-width="1.8"/></svg>',
      pin: '<svg viewBox="0 0 28 28" width="28" height="28"><path d="M10 4h8M11 4v7l-4 5h14l-4-5V4M14 16v9" fill="none" stroke="#c7c7cc" stroke-width="1.8" stroke-linejoin="round"/></svg>',
      hist: '<svg viewBox="0 0 28 28" width="28" height="28"><path d="M5.5 14a8.5 8.5 0 1 0 2.5-6M5 4v5h5M14 9v6l4 2" fill="none" stroke="#c7c7cc" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    };
    const rows = [["img", "Image", "↩"], ["gif", "GIF", "G"], ["vid", "Video", "M"], ["qr", "QR code", "Q"], null, ["pin", "Pin to screen", "P"], ["hist", "Clipboard history", "H"]];
    let ry = 318;
    const rowEls = [];
    rows.forEach((r) => {
      if (!r) { el("div", "abs", { left: "24px", right: "24px", top: ry + 6 + "px", height: "1px", background: "rgba(255,255,255,.1)" }, ch); ry += 14; return; }
      const row = el("div", "row", { top: ry + "px" }, ch);
      el("div", "ri", null, row).innerHTML = ic[r[0]];
      el("div", "rl", null, row).textContent = r[1];
      el("div", "rk", null, row).textContent = r[2];
      rowEls.push(row); ry += 56;
    });
    const hi = rowEls[0];
    hi.style.background = "rgba(59,130,246,.22)";

    // Keycaps overlay (screen space)
    // Keys shown in screen space, to the right of where the chooser lands.
    const keys = keycaps(over, ["⌥", "V"], { x: 1500, y: 860, size: 110 });
    const ret = keycaps(over, ["↩"], { x: 1560, y: 860, size: 110 });

    // ── timeline
    tl.fromTo(app, { opacity: 0, scale: 0.96, y: 20 }, { opacity: 1, scale: 1, y: 0, duration: 0.6, ease: "expo.out", transformOrigin: "50% 50%" }, T);
    tl.set([ch, keys.root, ret.root], { opacity: 0 }, T);
    tl.set(mine, { opacity: 0 }, T);
    // The camera leans in on the conversation while Maya types.
    {
      const s1 = 1.16, fx1 = X + 380 + 420, fy1 = Y + H - 300;
      tl.to(world, { scale: s1, x: (960 - fx1) * s1, y: (540 - fy1) * s1, duration: 1.6, ease: "power2.inOut" }, T + 0.4);
    }
    // Typing
    const t0 = B(U.typeStart), step = (B(U.typeEnd) - t0) / typed.length;
    tl.set(ph, { opacity: 0 }, t0);
    let acc = 0;
    chars.forEach((c, i) => {
      const t = t0 + i * step + [0, 0.02, -0.015, 0.01][i % 4];
      tl.set(c, { opacity: 1 }, t);
      acc = textWidth(typed.slice(0, i + 1), tFont);
      tl.set(caret, { x: acc }, t);
    });
    // caret blinks while waiting
    for (let t = B(U.typeEnd) + 0.3; t < B(U.optionV) + 0.1; t += 0.5) { tl.set(caret, { opacity: 0 }, t); tl.set(caret, { opacity: 1 }, t + 0.25); }
    // ⌥V
    const tv = B(U.optionV);
    tl.fromTo(keys.root, { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.25, ease: "expo.out" }, tv - 0.35);
    keys.press(tl, tv, 0.1);
    tl.to(keys.root, { opacity: 0, y: 20, duration: 0.25, ease: "power2.in" }, tv + 0.45);
    tl.fromTo(ch, { opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1, duration: 0.35, ease: "expo.out", transformOrigin: "10% 100%" }, tv + 0.04);
    // Camera push-in on the chooser
    const fx = chX + 200, fy = chY + chH / 2;
    const sc = 1.3;
    tl.to(world, { scale: sc, x: (960 - fx) * sc, y: (540 - fy) * sc, duration: 0.8, ease: "power3.inOut" }, tv + 0.05);
    // Return
    const te = B(U.enter);
    tl.fromTo(ret.root, { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.25, ease: "expo.out" }, te - 0.35);
    ret.press(tl, te, 0.1);
    tl.to(ret.root, { opacity: 0, y: 20, duration: 0.25, ease: "power2.in" }, te + 0.4);
    tl.to(hi, { background: "rgba(59,130,246,.55)", duration: 0.06 }, te);
    tl.to(ch, { opacity: 0, scale: 0.97, duration: 0.22, ease: "power2.in", transformOrigin: "10% 100%" }, te + 0.12);
    // The card lands in the message box
    tl.to(world, { scale: 1, x: 0, y: 0, duration: 0.7, ease: "power3.inOut" }, te + 0.1);
    tl.to(comp, { height: 148, top: H - 184, duration: 0.35, ease: "expo.out" }, te + 0.15);
    tl.to(typedEl, { x: 128, duration: 0.35, ease: "expo.out" }, te + 0.15);
    tl.to(caret, { opacity: 0, duration: 0.05 }, te + 0.15);
    tl.fromTo(attach, { opacity: 0, scale: 0.6, y: -40 }, { opacity: 1, scale: 1, y: 0, duration: 0.5, ease: "back.out(1.4)", transformOrigin: "50% 50%" }, te + 0.2);
    tl.to(send, { backgroundColor: "#2a6df4", duration: 0.2 }, te + 0.3);
    // Send
    const ts = B(U.send);
    tl.to(send, { scale: 0.88, duration: 0.07, yoyo: true, repeat: 1, transformOrigin: "50% 50%" }, ts - 0.07);
    tl.to([attach, typedEl], { opacity: 0, y: -30, duration: 0.25, ease: "power2.in" }, ts);
    tl.to(comp, { height: 92, top: H - 128, duration: 0.35, ease: "expo.out" }, ts + 0.15);
    tl.to(send, { backgroundColor: "#e7e5e0", duration: 0.2 }, ts + 0.15);
    tl.set(ph, { opacity: 1 }, ts + 0.3);
    tl.to([m1, m2], { y: -40, duration: 0.5, ease: "expo.out" }, ts + 0.05);
    tl.fromTo(mine, { opacity: 0, y: 30 }, { opacity: 1, y: -40, duration: 0.55, ease: "expo.out" }, ts + 0.05);
    tl.to(world, { scale: 1.06, duration: 1.2, ease: "sine.inOut", transformOrigin: "960px 600px" }, ts + 0.1);
    tl.to(world, { opacity: 0, duration: 0.3, ease: "power2.in" }, END - 0.3);
  })();

  // ─────────────────────────────── 6. Trust ───────────────────────────────
  (function trust() {
    const world = $("trust-world");
    const lines = ["Runs on your Mac.", "No telemetry.", "Open source."];
    const ms = lines.map((t, i) => { const m = maskedWords(world, t, { left: "240px", top: 270 + i * 170 + "px", fontSize: "124px" }); m.line.className += " display"; return m; });
    const T = B(SEC.trust), END = B(SEC.outro);
    TL.trust.forEach((b, i) => rise(B(b), ms[i].words, { stagger: 0.07, d: 0.8 }));
    tl.fromTo(world, { y: 16 }, { y: -16, duration: END - T, ease: "none" }, T);
    ms.forEach((m, i) => sink(END - 0.4 + i * 0.04, m.words));
  })();

  // ─────────────────────────────── 7. Outro ───────────────────────────────
  (function outro() {
    const T = B(SEC.outro), END = B(SEC.end), world = $("outro-world");
    const icon = el("img", "abs", { left: 960 - 80 + "px", top: "210px", width: "160px", height: "160px" }, world); icon.src = "assets/img/app-icon.png";
    const word = maskedWords(world, "Peesuto", { left: "0px", top: "400px", width: "1920px", textAlign: "center", fontSize: "150px", letterSpacing: "-0.035em" });
    word.line.className += " display";
    // letters, not words
    word.words[0].textContent = "";
    const letters = [..."Peesuto"].map((c) => { const m = el("span", "mask", null, word.words[0]); const s = el("span", "mword", null, m); s.textContent = c; return s; });
    const sub = el("div", "label abs", { left: "0px", top: "610px", width: "1920px", textAlign: "center", fontSize: "44px", color: "#d1d1d6" }, world);
    sub.textContent = "Free & open source for macOS";
    const url = el("div", "abs", { left: "0px", top: "700px", width: "1920px", textAlign: "center", fontSize: "34px", fontFamily: "PeesutoText", color: "#8e8e93" }, world);
    url.textContent = "peesuto.com  ·  github.com/anelikes/peesuto";
    tl.fromTo(icon, { scale: 0.6, opacity: 0, y: 30 }, { scale: 1, opacity: 1, y: 0, duration: 0.8, ease: "back.out(1.5)", transformOrigin: "50% 50%" }, T + 0.02);
    tl.fromTo(letters, { yPercent: 110 }, { yPercent: 0, duration: 0.8, ease: "expo.out", stagger: 0.045 }, T + 0.15);
    tl.fromTo(sub, { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.7, ease: "expo.out" }, T + 0.7);
    tl.fromTo(url, { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.7, ease: "expo.out" }, T + 0.95);
    tl.fromTo(world, { scale: 1.0 }, { scale: 0.97, duration: END - T, ease: "sine.out" }, T);
    tl.to(world, { opacity: 0, duration: 0.8, ease: "power1.in" }, END - 0.8);
  })();

  window.PROMO_GSAP = tl;
})();
