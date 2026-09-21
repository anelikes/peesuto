#!/usr/bin/env bun
/**
 * Render every corpus sample (`core/fixtures/corpus/*.txt`) through the card
 * chain WITHOUT Jev, then run the engine's `verify` on each composition, and
 * write the table to `baselines/corpus.md`.
 *
 * The kind is chosen by a small classifier below (a stand-in for the Jev
 * answer, not a copy of it); palette, layout, aspect and scale rotate so
 * every ladder is exercised; every tenth sample is animated and its last
 * frame is rendered as well. Renders go to `.work/corpus-tree`, PNGs to
 * `.work/corpus-out`.
 *
 *   bun scripts/corpus.ts                # all samples, several minutes
 *   bun scripts/corpus.ts --only quote   # samples whose name contains "quote"
 *   bun scripts/corpus.ts --limit 10     # the first ten
 *   bun scripts/corpus.ts --no-verify    # skip the engine's verify (fast)
 */
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ASPECTS, LAYOUTS, PALETTES, type Dsl, type Kind, type Level } from "../core/src/dsl.ts";
import { assertEngine, bunOnPath, engineRoot, EngineError, REPO_ROOT, runEngine } from "../core/src/engine.ts";
import { fallbackDsl } from "../core/src/questions.ts";
import { frameCard, prepareCard } from "../core/src/render/card.ts";
import { ComposeError, LIST_MARKER } from "../core/src/render/compose.ts";

const CORPUS = join(REPO_ROOT, "core/fixtures/corpus");
const WORK = join(REPO_ROOT, ".work/corpus-tree");
const OUT = join(REPO_ROOT, ".work/corpus-out");
const BASELINE = join(REPO_ROOT, "baselines/corpus.md");

/* ---- flags ---------------------------------------------------------------- */
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const only = flag("only");
const limit = flag("limit") ? Number(flag("limit")) : undefined;
const verifyOn = !argv.includes("--no-verify");

/* ---- the classifier: a stand-in for the kind question --------------------- */
const CODE_LINE = /^\s*(?:import|export|const|let|var|function|class|def|fn|pub|struct|impl|SELECT|FROM|WHERE|package|func|if|for|while|return|else|try|except|async|await|@media|\{|\}|\[|\]|#include|<\/?[a-z]|\$ |curl |docker |git |kubectl )/i;
const LOG_LINE = /^\s*(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|\d{1,3}(?:\.\d{1,3}){3} |\[\d{2}\/\w{3}\/\d{4}|\w{3} +\d{1,2} \d{2}:\d{2}:\d{2} |\{"ts"|\{"time"|[A-Z][a-z]+ +[A-Z][A-Za-z]+ +\d+ )/;
const UNIT_NUMBER = /\d(?:[\d,]*\d)?(?:\.\d+)?\s?(?:[%％万亿倍]|[xXkKM](?![A-Za-z0-9]))/;
const ATTRIBUTED = /(?:\n\s*|[”"」』’]\s*|[。．.!?！？…]\s*)(?:——|—|--|-)\s*[^\n—]{1,40}$/;

export function classify(text: string): Kind {
  const t = text.trim();
  const lines = t.split("\n").filter((l) => l.trim());
  const chars = [...t].length;
  if (/^https?:\/\/\S+$/.test(t)) return "plain";
  if (/^```/m.test(t) || /^\s+at .+:\d+:\d+\)?$/m.test(t) || /^Traceback \(most recent call last\)/m.test(t)) return "code";
  if (/^\s*[{[][\s\S]*[}\]]\s*$/.test(t)) return "code";
  const symbols = (t.match(/[;{}()=<>[\]|\\$]/g) ?? []).length / Math.max(1, chars);
  const codeLines = lines.filter((l) => CODE_LINE.test(l)).length;
  const logLines = lines.filter((l) => LOG_LINE.test(l)).length;
  if (symbols > 0.06 || codeLines >= 2 || (lines.length === 1 && codeLines === 1 && symbols > 0.03) || logLines >= 2) return "code";
  if (lines.length >= 3 && lines.filter((l) => LIST_MARKER.test(l) && l.replace(LIST_MARKER, "") !== l).length >= 3) return "list";
  if (ATTRIBUTED.test(t) || /^[“「『][\s\S]*[”」』]$/.test(t)) return "quote";
  if (chars <= 120 && lines.length === 1 && UNIT_NUMBER.test(t)) return "stat";
  return "plain";
}

/* ---- the DSL per sample: fallbackDsl with the kind and a rotation --------- */
const clamp = (v: number): Level => Math.max(0, Math.min(3, v)) as Level;
function dslFor(text: string, i: number): Dsl {
  const base = fallbackDsl(text, ASPECTS[Math.floor(i / 3) % ASPECTS.length]!);
  const animated = i % 10 === 5;
  return {
    ...base,
    kind: classify(text),
    palette: PALETTES[i % PALETTES.length]!,
    layout: LAYOUTS[i % LAYOUTS.length]!,
    scale: clamp(base.scale + [0, 1, -1][i % 3]!),
    emphasis: i % 4 === 0 ? 2 : -1,
    animate: animated,
    tone: animated ? 2 : 0,
  };
}

/* ---- verify: the engine's six gates as one JSON envelope ------------------ */
/** `allowedBy` carries the reason of the `layoutAllow` entry that excused the finding; it then counts for nothing. */
interface Finding { readonly code: string; readonly detail: string; readonly name?: string; readonly allowedBy?: string }
interface VerifyJson {
  readonly ok: boolean; readonly errors: string[]; readonly warnings: number;
  readonly lint?: { findings?: unknown[]; diagnostics?: unknown[] };
  readonly realm?: { error?: string };
  readonly visibility?: { failures?: string[] };
  readonly layout?: { findings?: Finding[]; nodes?: { name?: string; id: number; findings?: Finding[] }[] }[];
  readonly assertions?: { ok?: boolean; failures?: unknown[]; error?: string };
}
interface VerifyResult { readonly errors: string[]; readonly warnings: number; readonly excused: number; readonly first: string; readonly ms: number; readonly raw?: VerifyJson }

async function verify(): Promise<VerifyResult> {
  const t0 = performance.now();
  const p = Bun.spawn([process.execPath, "src/cli/main.ts", "verify", "compositions/paste", "--json"], {
    cwd: WORK, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, PATH: (await bunOnPath(join(WORK, ".bin"))).PATH },
  });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const ms = Math.round(performance.now() - t0);
  let j: VerifyJson;
  try { j = JSON.parse(stdout) as VerifyJson; } catch {
    return { errors: ["no-json"], warnings: 0, excused: 0, first: `verify printed no JSON: ${(stderr || stdout).trim().split("\n")[0] ?? ""}`, ms };
  }
  const firsts: string[] = [];
  let excused = 0;
  for (const frame of j.layout ?? []) {
    for (const f of frame.findings ?? []) if (f.allowedBy !== undefined) excused++;
    for (const n of frame.nodes ?? []) for (const f of n.findings ?? []) if (f.allowedBy === undefined) firsts.push(`${f.code}${n.name ? `@${n.name}` : `#${n.id}`}: ${f.detail}`);
    if (firsts.length === 0) for (const f of frame.findings ?? []) if (f.allowedBy === undefined) firsts.push(`${f.code}: ${f.detail}`);
  }
  if (j.realm?.error) firsts.unshift(`realm: ${j.realm.error.split("\n")[0]}`);
  if (j.assertions?.error) firsts.unshift(`assertions: ${j.assertions.error.split("\n")[0]}`);
  if ((j.assertions?.failures?.length ?? 0) > 0) firsts.unshift(`assertions: ${JSON.stringify(j.assertions!.failures![0]).slice(0, 120)}`);
  if ((j.visibility?.failures?.length ?? 0) > 0) firsts.unshift(`visibility: ${j.visibility!.failures![0]}`);
  if ((j.lint?.findings?.length ?? 0) > 0) firsts.unshift(`lint: ${JSON.stringify(j.lint!.findings![0]).slice(0, 120)}`);
  return { errors: j.errors ?? [], warnings: j.warnings ?? 0, excused, first: firsts[0] ?? "", ms, raw: j };
}

/** Did the engine trip over another build's style table? (One shared file; see engine `src/vendor/build-lock.ts`.) */
const styleRace = (msg: string): boolean => /styles\.generated|unknown class|not in the compiled style table/.test(msg);

/* ---- one sample ----------------------------------------------------------- */
interface Row {
  readonly name: string; readonly chars: number; readonly kind: Kind; readonly aspect: string; readonly layout: string; readonly scale: number;
  readonly animated: boolean;
  size?: number; lines?: number; frames?: number; truncated?: boolean;
  ms: { compose?: number; build?: number; frame?: number; verify?: number };
  verify?: VerifyResult; refused?: string; crashed?: string; retried?: boolean;
}

async function runSample(name: string, text: string, i: number, engine: string): Promise<Row> {
  const dsl = dslFor(text, i);
  const row: Row = { name, chars: [...text].length, kind: dsl.kind, aspect: dsl.aspect, layout: dsl.layout, scale: dsl.scale, animated: dsl.animate, ms: {} };
  const o = { engine, work: WORK, emojiCache: join(REPO_ROOT, ".work/emoji"), emojiBundle: join(REPO_ROOT, ".work/emoji-all") };
  try {
    const prepared = await prepareCard(dsl, o);
    row.size = prepared.size; row.lines = prepared.lines; row.frames = prepared.frames; row.truncated = prepared.truncated;
    row.ms.compose = prepared.ms.compose; row.ms.build = prepared.ms.build;
    const frame = async (at: number, out: string): Promise<number> => {
      try { return await frameCard(o, at, out); } catch (e) {
        if (!(e instanceof EngineError) || !styleRace(e.message)) throw e;
        row.retried = true;
        await runEngine(WORK, ["build", "compositions/paste"]);
        return frameCard(o, at, out);
      }
    };
    row.ms.frame = await frame(0, join(OUT, `${name}.png`));
    if (prepared.frames > 1) row.ms.frame += await frame(prepared.frames - 1, join(OUT, `${name}-last.png`));
    if (verifyOn) {
      let v = await verify();
      if (v.errors.includes("realm") && styleRace(v.first)) { row.retried = true; await runEngine(WORK, ["build", "compositions/paste"]); v = await verify(); }
      row.verify = v; row.ms.verify = v.ms;
    }
  } catch (e) {
    if (e instanceof ComposeError) row.refused = `${e.code}: ${e.message}`;
    else row.crashed = e instanceof Error ? `${e.constructor.name}: ${e.message.split("\n")[0]}` : String(e);
  }
  return row;
}

/* ---- the report ----------------------------------------------------------- */
const pad = (s: string | number, n: number, right = false): string => { const t = String(s); return right ? t.padStart(n) : t.padEnd(n); };
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function verdict(r: Row): string {
  if (r.refused) return "refused";
  if (r.crashed) return "CRASH";
  if (!r.verify) return "rendered";
  const v = r.verify;
  return v.errors.length === 0 && v.warnings === 0 ? "ok" : `E${v.errors.length} W${v.warnings}`;
}
function note(r: Row): string {
  if (r.refused) return r.refused;
  if (r.crashed) return r.crashed;
  if (r.verify?.first) return r.verify.first;
  if (r.verify && r.verify.excused > 0) return `${r.verify.excused} finding(s) excused by layoutAllow`;
  return "";
}

function printTable(rows: Row[]): void {
  console.log(`\n${pad("#", 3)} ${pad("sample", 34)} ${pad("kind", 6)} ${pad("asp/lay/sc", 14)} ${pad("px", 4, true)} ${pad("ln", 3, true)} ${pad("tr", 2)} ${pad("ms c+b/f/v", 16)} ${pad("verdict", 8)} note`);
  rows.forEach((r, i) => {
    const ms = r.ms.compose === undefined ? "-" : `${(r.ms.compose ?? 0) + (r.ms.build ?? 0)}/${r.ms.frame ?? "-"}/${r.ms.verify ?? "-"}`;
    console.log(`${pad(i + 1, 3)} ${pad(r.name, 34)} ${pad(r.kind, 6)} ${pad(`${r.aspect}/${r.layout}/${r.scale}${r.animated ? "*" : ""}`, 14)} ${pad(r.size ?? "-", 4, true)} ${pad(r.lines ?? "-", 3, true)} ${pad(r.truncated ? "y" : "", 2)} ${pad(ms, 16)} ${pad(verdict(r), 8)} ${note(r).slice(0, 90)}`);
  });
}

async function writeBaseline(rows: Row[], engine: string, totalMs: number): Promise<void> {
  const pin = (await Bun.file(join(REPO_ROOT, "engine.json")).json()) as { repo: string; ref: string; sha: string };
  const rendered = rows.filter((r) => r.size !== undefined);
  const truncated = rendered.filter((r) => r.truncated);
  const refused = rows.filter((r) => r.refused);
  const crashed = rows.filter((r) => r.crashed);
  const verified = rendered.filter((r) => r.verify);
  const withErrors = verified.filter((r) => r.verify!.errors.length > 0);
  const withWarnings = verified.filter((r) => r.verify!.warnings > 0);
  const findings = verified.reduce((n, r) => n + r.verify!.errors.length + r.verify!.warnings, 0);
  const excused = verified.reduce((n, r) => n + r.verify!.excused, 0);
  const retried = rows.filter((r) => r.retried);
  const byKind = Object.entries(rows.reduce<Record<string, number>>((acc, r) => ((acc[r.kind] = (acc[r.kind] ?? 0) + 1), acc), {})).map(([k, n]) => `${k} ${n}`).join(", ");
  const codes = Object.entries(refused.reduce<Record<string, number>>((acc, r) => { const c = r.refused!.split(":")[0]!; acc[c] = (acc[c] ?? 0) + 1; return acc; }, {})).map(([k, n]) => `${k} ${n}`).join(", ");
  const sum = (k: keyof Row["ms"]): number => rendered.reduce((n, r) => n + (r.ms[k] ?? 0), 0);
  const avg = (k: keyof Row["ms"]): number => (rendered.length ? Math.round(sum(k) / rendered.length) : 0);
  const md = `# Card corpus — ${rows.length} clipboard samples through the card chain

Generated by \`bun scripts/corpus.ts\` on ${new Date().toISOString().slice(0, 10)} against the engine pinned in \`engine.json\`
(\`${pin.ref}\` at \`${pin.sha.slice(0, 12)}\`, ${pin.repo}). Do not edit by hand; rerun the script.

## Method

- Samples: \`core/fixtures/corpus/NNN-<slug>.txt\`, synthetic (see the README there). Each file's whole content is the clipboard text.
- No decision model: the kind comes from a small classifier in the script (fenced/indented/symbol-heavy or log-shaped → code; three or more marked lines → list; a dash-and-name at the end or a fully quoted text → quote; a single short line with a unit-bearing number → stat; else plain). Kinds here: ${byKind}.
- The DSL is \`fallbackDsl\` with that kind, and palette/layout/aspect rotating by sample index; the scale is the fallback's, +1 or −1 by index so every ladder is exercised. Every fourth sample colours word 2; every tenth (marked \`*\`) is animated with tone 2 and its last frame is rendered as well.
- Each sample: \`prepareCard\` (compose + build) in \`.work/corpus-tree\`, \`frame --at 0\` to \`.work/corpus-out/<sample>.png\`, then the engine's \`verify compositions/paste --json\` (lint, realm, keyframes, visibility, layout at up to 5 frames, assertions). A verify *error* is a failed section; a *warning* is an active layout finding (\`text_box_overflow\`, \`clipped_text\`, \`content_overlap\`, …).
- Refusals are \`ComposeError\`s: \`unsupported-script\` (a script the face has no glyphs for, or any codepoint it cannot map), \`overflow\` (not even one line fits), \`empty\`. Truncation (\`tr\` = y) is the fit policy: the ladder's smallest size and a cut at a sentence or line boundary with an ellipsis.
- The composition declares two intentional geometries as \`layoutAllow\` entries (each with its reason, which \`layout\` echoes as \`allowedBy\`): a line that has not entered yet on an animated card is not painted (\`occlusion\`), and the decorative \`“\` of a quote hangs a few px below its box (\`overflow\`). Excused findings stay in verify's output and are counted separately below.
- The engine's build rewrites one shared style table (\`vendor/pocketjs/framework/src/styles.generated.ts\`); when another build lands between this script's build and its frame/verify, the step is retried once after a rebuild (\`retried\` below).

## Totals

| | |
|---|---|
| samples | ${rows.length} |
| rendered | ${rendered.length} |
| of which truncated | ${truncated.length} |
| refused | ${refused.length}${codes ? ` (${codes})` : ""} |
| crashed (not a ComposeError) | ${crashed.length} |
| verified | ${verified.length} |
| verify: samples with errors | ${withErrors.length} |
| verify: samples with warnings | ${withWarnings.length} |
| verify: findings in total | ${findings} |
| verify: findings excused by a \`layoutAllow\` entry (entrance-delayed lines, the quote mark) | ${excused} |
| retried after a style-table race | ${retried.length} |
| mean ms compose / build / frame / verify | ${avg("compose")} / ${avg("build")} / ${avg("frame")} / ${avg("verify")} |
| wall clock | ${Math.round(totalMs / 1000)} s |

## Samples

\`px\` is the chosen font size, \`ln\` the drawn lines, \`tr\` whether the text was cut, \`ms\` compose+build / frame / verify.

| # | sample | chars | kind | aspect/layout/scale | px | ln | tr | ms | verdict | note |
|---|---|---|---|---|---|---|---|---|---|---|
${rows.map((r, i) => `| ${i + 1} | ${cell(r.name)} | ${r.chars} | ${r.kind} | ${r.aspect}/${r.layout}/${r.scale}${r.animated ? "*" : ""} | ${r.size ?? "-"} | ${r.lines ?? "-"} | ${r.truncated ? "y" : ""} | ${r.ms.compose === undefined ? "-" : `${(r.ms.compose ?? 0) + (r.ms.build ?? 0)}/${r.ms.frame ?? "-"}/${r.ms.verify ?? "-"}`} | ${verdict(r)}${r.retried ? " (retried)" : ""} | ${cell(note(r))} |`).join("\n")}
`;
  await mkdir(join(REPO_ROOT, "baselines"), { recursive: true });
  await Bun.write(BASELINE, md);
}

/* ---- main ----------------------------------------------------------------- */
const engine = engineRoot();
assertEngine(engine);
await mkdir(OUT, { recursive: true });
let names = (await readdir(CORPUS)).filter((f) => f.endsWith(".txt")).sort();
if (only) names = names.filter((n) => n.includes(only));
if (limit) names = names.slice(0, limit);
if (names.length === 0) { console.error("corpus: no samples matched"); process.exit(2); }
console.log(`corpus: ${names.length} sample(s), engine ${engine}, work ${WORK}${verifyOn ? "" : ", verify off"}`);

const rows: Row[] = [];
const t0 = performance.now();
for (const [i, file] of names.entries()) {
  const name = file.replace(/\.txt$/, "");
  const text = await Bun.file(join(CORPUS, file)).text();
  const index = Number(name.slice(0, 3)) - 1;
  const row = await runSample(name, text, Number.isFinite(index) ? index : i, engine);
  rows.push(row);
  console.log(`${pad(i + 1, 3)}/${names.length} ${pad(name, 34)} ${pad(row.kind, 6)} ${pad(verdict(row), 8)} ${note(row).slice(0, 100)}`);
}
const totalMs = performance.now() - t0;
printTable(rows);
if (!only && !limit) {
  await writeBaseline(rows, engine, totalMs);
  console.log(`\nwrote ${BASELINE}`);
} else {
  console.log("\n(partial run: baselines/corpus.md not written)");
}
const bad = rows.filter((r) => r.crashed).length;
process.exit(bad > 0 ? 1 : 0);
