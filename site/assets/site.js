// Peesuto website: the hero loop, its scaling, and the content-type tabs. No dependencies.
(() => {
  "use strict";
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

  // --- Hero stage: scale the fixed-size drawing to the panel, wide or stacked.
  const wrap = document.querySelector(".stage-wrap");
  const stage = wrap && wrap.querySelector(".stage");
  if (wrap && stage) {
    const fit = () => {
      const width = wrap.clientWidth;
      const narrow = width < 700;
      stage.classList.toggle("narrow", narrow);
      const w = narrow ? 440 : 1000, h = narrow ? 730 : 520;
      const k = Math.min(1, width / w);
      stage.style.transform = `translateX(${Math.max(0, (width - w * k) / 2)}px) scale(${k})`;
      wrap.style.height = `${Math.round(h * k)}px`;
    };
    fit();
    new ResizeObserver(fit).observe(wrap);
  }

  // --- Hero loop: copy → ⌥V → Paste as… → Return → the card lands.
  const demo = document.querySelector("[data-demo]");
  if (demo && stage) {
    const samples = JSON.parse(demo.querySelector("script[type='application/json']").textContent);
    const steps = demo.querySelectorAll(".steps li");
    const button = demo.querySelector(".play");
    const src = stage.querySelector(".src pre .sel");
    const file = stage.querySelector(".src .win-bar b");
    const ask = stage.querySelector(".msg-ask p");
    const cards = stage.querySelectorAll("img[data-card]");
    // [class added, ms to hold, step label lit]
    const TIMELINE = [
      ["", 700, 0], ["is-selected", 900, 0], ["is-copied", 1000, 0], ["is-keys", 650, 1],
      ["is-chooser", 1500, 2], ["is-enter", 380, 2], ["is-landed", 3300, 3], ["is-fade", 550, 3],
    ];
    const ALL = TIMELINE.map((t) => t[0]).filter(Boolean);
    let sample = 0, at = 0, timer = 0, playing = false;

    const show = (i) => {
      const s = samples[i];
      src.textContent = s.text;
      file.textContent = s.file;
      ask.textContent = s.ask;
      cards.forEach((img) => { img.src = s.card; img.alt = img.dataset.card === "msg" ? s.alt : ""; });
    };
    const apply = (n) => {
      stage.classList.remove(...ALL);
      if (n < TIMELINE.length - 1) for (let k = 1; k <= n; k++) stage.classList.add(TIMELINE[k][0]);
      else stage.classList.add("is-landed", "is-fade");
      steps.forEach((li, k) => li.classList.toggle("on", k === TIMELINE[n][2]));
    };
    const tick = () => {
      at += 1;
      if (at >= TIMELINE.length) { at = 0; sample = (sample + 1) % samples.length; show(sample); }
      apply(at);
      timer = window.setTimeout(tick, TIMELINE[at][1]);
    };
    const setPlaying = (on) => {
      playing = on;
      window.clearTimeout(timer);
      button.setAttribute("aria-pressed", String(!on));
      button.querySelector(".label").textContent = on ? button.dataset.pause : button.dataset.play;
      button.querySelector("path").setAttribute("d", on ? "M0 0h3.5v12H0zM6.5 0H10v12H6.5z" : "M0 0l10 6-10 6z");
      if (on) { if (at >= 6) { at = TIMELINE.length - 1; } timer = window.setTimeout(tick, 400); }
    };
    // A still frame: the chooser open over the chat, the text selected.
    const still = () => { at = 4; apply(4); };

    show(0);
    button.hidden = false;
    button.addEventListener("click", () => setPlaying(!playing));
    // Only run while visible; start still when the Mac asks for reduced motion.
    let visible = true;
    new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      if (!visible && playing) { window.clearTimeout(timer); }
      else if (visible && playing) { window.clearTimeout(timer); timer = window.setTimeout(tick, TIMELINE[at][1]); }
    }).observe(demo);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) window.clearTimeout(timer);
      else if (playing && visible) { window.clearTimeout(timer); timer = window.setTimeout(tick, TIMELINE[at][1]); }
    });
    if (reduce.matches) { still(); setPlaying(false); } else { apply(0); setPlaying(true); }
  }

  // --- Content-type tabs (roving tabindex, arrow keys).
  document.querySelectorAll("[role='tablist']").forEach((list) => {
    const tabs = [...list.querySelectorAll("[role='tab']")];
    const select = (tab, focus) => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
      });
      if (focus) tab.focus();
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => select(tab, false));
      tab.addEventListener("keydown", (e) => {
        const n = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
        if (n === null) return;
        e.preventDefault();
        select(tabs[(n + tabs.length) % tabs.length], true);
      });
    });
  });
})();
