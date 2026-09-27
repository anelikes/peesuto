/**
 * A JIZURA project for one Lyric motion render: the lyrics and line times
 * (script.ts), the style (a key, or おまかせ seeded by the text), the part
 * sets and the frame. Plain data: it crosses to the frame workers, and every
 * realm plans the same film from it (J.plan is deterministic).
 */
import type { LyricScript } from "./script.ts";
import { mulberry32, type JizuraApi, type JizuraProject } from "./realm.ts";

export type JizuraAspect = "1:1" | "16:9" | "9:16" | "4:5";

export interface ProjectOptions {
  /** "auto" (おまかせ) or a JIZURA style key. */
  readonly style: string;
  /** JIZURA's horror set (its parts, styles and the horror mood). Off by default. */
  readonly horror: boolean;
  readonly aspect: JizuraAspect;
  /** Seeds everything (the text's hash): the same text gives the same film. */
  readonly seed: number;
  readonly fps: number;
  /** Parts random picks must not use, per group (render.ts SLOW_PARTS). */
  readonly exclude?: Readonly<Record<string, readonly string[]>>;
}

export interface BuiltProject {
  readonly project: JizuraProject;
  /** The style JIZURA draws with (おまかせ's pick for "auto"). */
  readonly style: string;
  /** おまかせ's mood; null for a chosen style. */
  readonly mood: string | null;
}

/** JIZURA's own line-length rule for a last line without a time of its own (src/08_planner.js computeTiming). */
const lastLineSeconds = (chars: number) => Math.min(5.2, Math.max(1.5, 0.8 + chars * 0.17));

export function buildProject(J: JizuraApi, script: LyricScript, o: ProjectOptions): BuiltProject {
  const p = J.defaultProject();
  Object.assign(p, {
    lyrics: script.lyrics, title: script.title, artist: script.artist,
    // おまかせ never repeats the current style; an empty one leaves every style open.
    style: o.style === "auto" ? "" : o.style, mood: null,
    // Every part set but horror unless asked: 追加分 (extra), 和風 (wa), 文字PV (typo), キネティック (kinetic).
    extra: true, wa: true, typo: true, kinetic: true, horror: o.horror,
    lang: "auto", keyBg: "off", unify: false, typeset: false, centerFree: false,
    aspect: o.aspect, fps: o.fps, seed: o.seed >>> 0,
  });
  let mood: string | null = null;
  if (o.style === "auto") {
    const r = J.omakase(p, mulberry32((o.seed ^ 0x6f6d616b) >>> 0));
    Object.assign(p, { mood: r.mood, style: r.style, fx: r.fx, enabled: r.enabled, fonts: r.fonts, colors: r.colors, seed: r.seed });
    mood = r.mood;
  }
  for (const [group, keys] of Object.entries(o.exclude ?? {})) {
    const on = (p.enabled[group] ??= {});
    for (const k of keys) on[k] = false;
  }
  // Line times: every line at the time script.ts gave it; the last one lasts its own time (through
  // lineScale, which JIZURA applies only to lines without a time), then the tail holds.
  const parsed = J.parseLyrics(p.lyrics).lines;
  if (parsed.length !== script.lines.length) throw new Error(`jizura: the lyrics read as ${parsed.length} lines, not ${script.lines.length}`);
  const last = script.lines.at(-1)!;
  const chars = [...parsed.at(-1)!.text].length;
  p.timing = {
    bpm: 0, offset: script.introMs / 1000, snap: false, tail: script.tailMs / 1000,
    lineTimes: Object.fromEntries(script.lines.map((l, i) => [i, l.startMs / 1000])),
    lineScale: last.durationMs / 1000 / lastLineSeconds(chars),
  };
  return { project: p, style: p.style, mood };
}
