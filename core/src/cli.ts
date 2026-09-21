#!/usr/bin/env bun
/**
 * paste: clipboard text → Jev (typed decisions) → Pocket Motion (a card).
 *
 *   bun run.ts "some text" [--aspect chat|doc|social] [--out out.png]
 *   pbpaste | bun run.ts --stdin
 *
 * Needs `npx wrangler dev` running in jev-proxy/ (port 8787) and a sibling
 * checkout of pocketjs-motion at ../pocketjs-motion. Renders in a scratch
 * symlink tree under .work/ so the engine checkout is never written to.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, symlink, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const HERE = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const ENGINE = resolve(HERE, "../pocketjs-motion");
const WORK = join(HERE, ".work/tree");
const PROXY = "http://localhost:8787/";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const aspect = (flag("--aspect") ?? "chat") as "chat" | "doc" | "social";
const out = flag("--out");
const text = argv.includes("--stdin") ? await Bun.stdin.text() : argv.find((a) => !a.startsWith("--") && a !== flag("--aspect") && a !== out);
if (!text?.trim()) throw new Error("no text: pass it as an argument or --stdin");

// --- 1. Jev ---
const seg = (t: string) => [...new Intl.Segmenter("zh-CN", { granularity: "word" }).segment(t)].map((s) => s.segment).filter((w) => /[\p{L}\p{N}]/u.test(w));
const words = seg(text).slice(0, 200);
const wordCriteria: Record<string, string> = Object.fromEntries(words.map((w, i) => [`w${i}`, w]));
wordCriteria["none"] = "no single word deserves emphasis";
const t0 = performance.now();
const res = await fetch(PROXY, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
  state: { clipboard: text },
  questions: {
    kind: { type: "choice", instructions: "What kind of text is on the clipboard?", criteria: {
      quote: "a quotation or aphorism, often with an attribution", code: "source code, a shell command or a log line",
      stat: "a sentence whose point is one number", list: "several items or numbered steps",
      event: "a time, a place, an appointment", plain: "ordinary prose that fits none of the above" } },
    layout: { type: "choice", instructions: "Which layout suits it as a card?", criteria: {
      center: "one short thought, centred", left: "a left-aligned stack, good for several lines", split: "an accent rule on the left and text beside it" } },
    palette: { type: "choice", instructions: "Which palette suits the content's mood?", criteria: {
      ink: "neutral dark, technical", paper: "warm light, literary", cyan: "cool dark, business or data", amber: "warm dark, emphatic" } },
    scale: { type: "score", instructions: "How large should the type be, given how much text there is?", criteria: ["small: many lines", "medium", "large: a few lines", "huge: a few words"] },
    tone: { type: "score", instructions: "How emphatic should the entrance animation be?", criteria: ["none: static or informational", "gentle", "emphatic", "dramatic"] },
    animate: { type: "noul", instructions: "Does the content read in a sequence that motion would reveal (steps, a count, typing)?", criteria: { true: "yes, it has an intrinsic order", false: "no, it is one static thought" } },
    emphasis: { type: "choice", instructions: "Which single word carries the point and should be coloured?", criteria: wordCriteria },
  } }) });
const raw: any = await res.json();
const a = raw.result?.answers ?? raw.answers;
if (!a) throw new Error(`jev: ${JSON.stringify(raw).slice(0, 300)}`);
const jevMs = Math.round(performance.now() - t0);

// --- 2. answers → DSL (every field an enumeration; low confidence falls back to plain) ---
const clamp = (v: number) => Math.max(0, Math.min(3, Math.round(v)));
const kindP = a.kind.probabilities[a.kind.choice] ?? 0;
const kind = kindP < 0.6 ? "plain" : a.kind.choice === "event" ? "plain" : a.kind.choice;
const emphIdx = a.emphasis.choice === "none" ? -1 : Number(a.emphasis.choice.slice(1));
// `animate` and `tone` are answered independently (Jev never conditions one
// question on another), so a "yes, animate" with tone 0 is a real combination
// that the generator would render static: give motion at least the gentle tone.
const animate = a.animate.noul > 0.5;
const dsl = {
  text, kind, layout: a.layout.choice, palette: a.palette.choice, aspect,
  scale: clamp(a.scale.score), tone: animate ? Math.max(1, clamp(a.tone.score)) : clamp(a.tone.score), emphasis: emphIdx,
  animate,
};
console.log(`jev ${jevMs} ms → ${JSON.stringify({ ...dsl, text: undefined })}  (kind p=${kindP.toFixed(2)})`);

// --- 3. scratch tree over the engine checkout ---
if (!existsSync(join(ENGINE, "src/cli/main.ts"))) throw new Error(`engine checkout not found at ${ENGINE}`);
if (!existsSync(WORK)) {
  await mkdir(join(WORK, "compositions"), { recursive: true });
  await mkdir(join(WORK, "dist"), { recursive: true });
  for (const e of await readdir(ENGINE)) if (!["compositions", "dist", ".git"].includes(e)) await symlink(join(ENGINE, e), join(WORK, e));
  for (const c of await readdir(join(ENGINE, "compositions"))) await symlink(join(ENGINE, "compositions", c), join(WORK, "compositions", c));
}
const comp = join(WORK, "compositions/paste");
await mkdir(comp, { recursive: true });
await copyFile(join(HERE, "paste/gen.ts"), join(comp, "gen.ts"));
await copyFile(join(HERE, "paste/charset.txt"), join(comp, "charset.txt"));
await copyFile(join(HERE, "paste/emoji.ts"), join(comp, "emoji.ts"));
await Bun.write(join(comp, "job.json"), JSON.stringify(dsl, null, 2));

// --- 4. gen → build → render ---
const sh = async (args: string[]) => {
  const p = Bun.spawn(args, { cwd: WORK, stdout: "pipe", stderr: "pipe", env: { ...process.env, PASTE_EMOJI_CACHE: join(HERE, ".work/emoji") } });
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${args.slice(0, 4).join(" ")} failed:\n${o}${e}`);
  return o;
};
const t1 = performance.now();
console.log((await sh(["bun", "compositions/paste/gen.ts", "--dsl", "compositions/paste/job.json"])).trim());
await sh(["bun", "src/cli/main.ts", "build", "compositions/paste"]);
const frames = (await Bun.file(join(comp, "pocket-motion.json")).json()).durationFrames as number;
const dest = out ? resolve(out) : join(HERE, "out", frames > 1 ? "card.gif" : "card.png");
await mkdir(resolve(dest, ".."), { recursive: true });
if (frames > 1) {
  const mp4 = join(WORK, "dist/card.mp4");
  await sh(["bun", "src/cli/main.ts", "render", "compositions/paste", "--out", mp4]);
  await sh(["ffmpeg", "-v", "error", "-y", "-i", mp4, "-vf", "fps=15,scale=540:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer", dest]);
} else {
  await sh(["bun", "src/cli/main.ts", "frame", "compositions/paste", "--at", "0", "--out", dest]);
}
console.log(`render ${Math.round(performance.now() - t1)} ms → ${dest}  (${frames} frame(s), total ${Math.round(performance.now() - t0)} ms)`);
