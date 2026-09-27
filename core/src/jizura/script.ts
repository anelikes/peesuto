/**
 * Lyric motion's text and timing, handed to JIZURA as its lyrics and line
 * times. JIZURA is a lyric-video maker that expects a song to set the time;
 * Peesuto has no song, so the times come from Lyric motion's own reading
 * timing (templates/lyrics.ts LYRICS_TIMING): a line stays as long as it
 * takes to read (LRC timing when present), prose never below its reading
 * floor, the same intro, final hold and caps (30 s video, 14.4 s GIF), and,
 * when that is too long, two lines of a stanza on one screen, else the same
 * explicit lyric-too-long / lyric-gif-too-long errors. JIZURA then splits
 * each line into cuts itself, within the line's time.
 *
 * What is a JIZURA line:
 * - a lyric or poem line is one line, its `/` pieces (and the pieces a long
 *   line was cut into) written back as JIZURA's own `/` markup;
 * - a prose cut (parse.ts splitCuts) is a line of its own, so that JIZURA
 *   reads a paragraph phrase by phrase;
 * - `*emphasis*`, `line|note` and a trailing `!` are JIZURA's markup too and
 *   are written back as such (JIZURA draws the trailing `!` as a flash and a
 *   shake, not as a character).
 * Characters that would read as markup are replaced by their full-width
 * forms: a literal `*`, `/` or `|`, a leading `#` (a comment to JIZURA) and a
 * leading `[` that would look like an LRC tag or an interlude.
 */
import { ComposeError, normalizeText } from "../render/compose.ts";
import { fitDurations, graphemes, LYRICS_TIMING, lyricsMaxMs, WIDE } from "../templates/lyrics.ts";
import type { TemplateFormat } from "../templates/compose.ts";
import type { LyricLine, TemplateContent } from "../templates/types.ts";

type LyricsContent = Extract<TemplateContent, { kind: "lyrics" }>;

export interface ScriptLine {
  /** The line in JIZURA's markup. */
  readonly text: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly stanza: number;
}

export interface LyricScript {
  /** JIZURA's lyrics: one line per ScriptLine, a blank line between stanzas. */
  readonly lyrics: string;
  readonly title: string;
  readonly artist: string;
  readonly lines: readonly ScriptLine[];
  /** Before the first line (and the title card, when there is one). */
  readonly introMs: number;
  /** The title card's time, when there is a title or credit. */
  readonly titleMs: number;
  /** After the last line. */
  readonly tailMs: number;
  readonly totalMs: number;
  /** Two lines of a stanza share each line (the text was too long otherwise). */
  readonly paired: boolean;
}

interface Piece { readonly text: string; readonly emphasis: readonly (readonly [number, number])[] }
interface Draft {
  pieces: Piece[];
  note?: string;
  stanza: number;
  /** Reading (or LRC) time and floor, summed over the pieces. */
  wantMs: number;
  floorMs: number;
  /** Poems and lyrics join their pieces with `/`; prose pieces are lines of their own. */
  joined: boolean;
}

const T = LYRICS_TIMING;

const readingMs = (text: string) => graphemes(text).reduce((ms, g) => ms + (!g.trim() ? 0 : WIDE.test(g) ? T.cjkMs : T.latinMs), 0);
const proseFloorMs = (text: string) => Math.max(T.minCutMs, graphemes(text).reduce((ms, g) => ms + (!g.trim() ? 0 : WIDE.test(g) ? T.proseCjkMs : T.proseLatinMs), 0));

/** A piece's text in JIZURA markup: emphasis wrapped in `*`, markup characters made literal. */
function markup(piece: Piece, first: boolean): string {
  const g = graphemes(piece.text);
  const open = new Set(piece.emphasis.map(([a]) => a)), close = new Set(piece.emphasis.map(([, b]) => b));
  let out = "";
  for (let i = 0; i <= g.length; i++) {
    if (close.has(i) && i > 0) out += "*";
    if (i === g.length) break;
    if (open.has(i)) out += "*";
    const c = g[i]!;
    out += c === "*" ? "＊" : c === "/" ? "／" : c === "|" ? "｜" : c;
  }
  if (first) {
    if (out.startsWith("#")) out = `＃${out.slice(1)}`;
    // An LRC stamp or tag, or an interlude, when it opens a line.
    if (/^\[(?:\d+:\d|(?:ti|ar|al|by|offset):|\s*(?:間奏|间奏|interlude|instrumental|inst|간주)\b)/i.test(out)) out = `［${out.slice(1)}`;
  }
  return out;
}

/** A draft line in JIZURA markup. */
function lineText(d: Draft): string {
  const body = d.pieces.map((p, i) => markup(p, i === 0)).join("/");
  const note = d.note ? `|${d.note.replaceAll("|", "｜")}` : "";
  return `${body}${note}`;
}

/** The pieces of one of our lines: its `/` (or splitCuts) pieces, trimmed, emphasis shifted into each. */
function piecesOf(line: LyricLine): Piece[] {
  const glyphs = graphemes(normalizeText(line.text, "plain"));
  const bounds = [0, ...(line.breaks ?? []), glyphs.length];
  const out: Piece[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    let lo = bounds[k]!, hi = bounds[k + 1]!;
    while (lo < hi && !glyphs[lo]!.trim()) lo++;
    while (hi > lo && !glyphs[hi - 1]!.trim()) hi--;
    if (lo >= hi) continue;
    const emphasis = (line.emphasis ?? []).map(([x, y]) => [Math.max(x, lo) - lo, Math.min(y, hi) - lo] as const).filter(([x, y]) => y > x);
    out.push({ text: glyphs.slice(lo, hi).join(""), emphasis });
  }
  return out;
}

function drafts(content: LyricsContent): Draft[] {
  const out: Draft[] = [];
  for (const [s, stanza] of content.stanzas.entries()) {
    for (const line of stanza.lines) {
      const pieces = piecesOf(line);
      if (!pieces.length) continue;
      const visible = (text: string) => graphemes(text).filter((g) => g.trim()).length;
      const total = pieces.reduce((n, p) => n + visible(p.text), 0);
      const timed = line.at !== undefined && line.until !== undefined ? line.until - line.at : undefined;
      // Each piece is timed as the classic renderer times a cut, and a line lasts as long as its pieces.
      const cut = (p: Piece) => {
        const floor = content.prose ? proseFloorMs(p.text) : T.minCutMs;
        const share = timed !== undefined ? Math.round(timed * visible(p.text) / Math.max(1, total)) : undefined;
        return { want: Math.max(floor, Math.min(T.maxCutMs, Math.max(T.minCutMs, share ?? readingMs(p.text)))), floor };
      };
      if (content.prose) {
        pieces.forEach((p, i) => {
          const c = cut(p);
          out.push({ pieces: [p], ...(i === pieces.length - 1 && line.note ? { note: line.note } : {}), stanza: s, wantMs: c.want, floorMs: c.floor, joined: false });
        });
      } else {
        const cuts = pieces.map(cut);
        out.push({ pieces, ...(line.note ? { note: line.note } : {}), stanza: s, wantMs: cuts.reduce((n, c) => n + c.want, 0), floorMs: cuts.reduce((n, c) => n + c.floor, 0), joined: true });
      }
    }
  }
  return out;
}

/** Two consecutive lines of one stanza as one line (their pieces joined by `/`). */
function paired(list: readonly Draft[]): Draft[] {
  const out: Draft[] = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!, b = list[i + 1];
    if (b && b.stanza === a.stanza && !a.note) {
      out.push({ pieces: [...a.pieces, ...b.pieces], ...(b.note ? { note: b.note } : {}), stanza: a.stanza, wantMs: a.wantMs + b.wantMs, floorMs: a.floorMs + b.floorMs, joined: true });
      i++;
    } else out.push(a);
  }
  return out;
}

/** The lines, their times and the whole length, for `content` in a `width`×`height` frame of `format`. */
export function lyricScript(content: LyricsContent, o: { readonly width: number; readonly height: number; readonly format: TemplateFormat }): LyricScript {
  const cap = lyricsMaxMs(o.width, o.height, o.format);
  const titleMs = content.title || content.credit ? T.titleMs : 0;
  const fit = (list: readonly Draft[]) => {
    if (!list.length) return;
    const last = list.length - 1;
    const tail = Math.max(0, T.finalHoldMs + 600 - list[last]!.wantMs);
    const durations = fitDurations(list.map((d) => d.wantMs), list.map((d) => d.floorMs), cap - T.introMs - titleMs - tail);
    return durations && { durations, tail };
  };
  let list = drafts(content);
  if (!list.length) throw new ComposeError("lyric-unfit", "There is no text to set in motion.");
  let fitted = fit(list), pairedLines = false;
  if (!fitted) { list = paired(list); fitted = fit(list); pairedLines = true; }
  if (!fitted) {
    const most = Math.floor((cap - T.introMs - T.finalHoldMs) / T.minCutMs);
    if (o.format === "gif") throw new ComposeError("lyric-gif-too-long", `This text needs ${list.length} lines even two at a time; a ${(cap / 1000).toFixed(1)} s lyric-motion GIF holds about ${most}${content.prose ? " at a readable pace" : ""}. Make it a video instead (up to ${(T.maxMs / 1000).toFixed(0)} s), copy a shorter passage, or use PNG for a poster of all of it. No content was dropped.`);
    throw new ComposeError("lyric-too-long", `This text needs ${list.length} lines even two at a time; a ${(cap / 1000).toFixed(1)} s lyric-motion video holds about ${most}${content.prose ? " at a readable pace" : ""}. Copy a shorter passage, or use PNG for a poster of all of it. No content was dropped.`);
  }
  const lines: ScriptLine[] = [];
  let at = T.introMs + titleMs;
  for (const [i, d] of list.entries()) {
    const durationMs = fitted.durations[i]!;
    lines.push({ text: lineText(d), startMs: at, durationMs, stanza: d.stanza });
    at += durationMs;
  }
  const rows: string[] = [];
  for (const [i, line] of lines.entries()) {
    if (i > 0 && line.stanza !== lines[i - 1]!.stanza) rows.push("");
    rows.push(line.text);
  }
  return {
    lyrics: rows.join("\n"), title: content.title ?? "", artist: content.credit ?? "",
    lines, introMs: T.introMs, titleMs, tailMs: fitted.tail, totalMs: at + fitted.tail, paired: pairedLines,
  };
}
