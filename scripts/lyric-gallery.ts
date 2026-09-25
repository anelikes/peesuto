/**
 * Lyric motion (文字 PV) shot gallery: every effect the lyric video can use,
 * one clip each, in every style. Each clip pins one dimension of the planner
 * (layout, entrance, hold, transition, decor, shape motion) through the
 * tooling-only hook in core/src/templates/lyric-video.ts (withLyricForce) and
 * keeps the others fixed and quiet, so the clip shows that effect alone. The
 * page also lists each style's weighted vocabulary (LYRICS_MOTION).
 *
 *   bun run lyric-gallery [-- options]
 *   bun scripts/lyric-gallery.ts [--engine <prepared engine>] [--out .work/lyric-gallery] [--jobs 5]
 *                                [--styles classic,editorial,pop,night] [--sections layouts,entrances,…] [--frame 1:1] [--no-video]
 *
 * Clips are GIFs; the "auto" row adds one MP4 per style (textures show only in
 * video). Each parallel job is a worker process with its own clone of the
 * engine checkout (engine builds rewrite files in the checkout). Open <out>/index.html in a browser.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decideTemplate } from "../core/src/templates/decide.ts";
import { renderTemplate } from "../core/src/templates/render.ts";
import { LYRIC_ENTRANCES, LYRIC_LAYOUTS, LYRICS_MOTION, LYRICS_STYLES, LYRICS_VARIANTS, type LyricDecor, type LyricHold, type LyricLayout, type LyricEntrance,
  type LyricShapeMotion, type LyricsProgram, type LyricsVariant, type LyricTransition } from "../core/src/templates/lyrics.ts";
import { withLyricForce, type LyricForce } from "../core/src/templates/lyric-video.ts";
import { MOTION_FRAMES, errorOf, type MotionFrame } from "./studio/pipeline.ts";
import { videoAvailable } from "../core/src/render/video.ts";
import type { TemplateMotion } from "../core/src/templates/types.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const REPO = resolve(import.meta.dir, "..");
const out = resolve(flag("out", join(REPO, ".work/lyric-gallery"))!);
const sourceEngine = resolve(flag("engine", join(REPO, ".work/native-engine"))!);
const jobs = Math.max(1, Number(flag("jobs", "5")));
const styles = (flag("styles")?.split(",") ?? LYRICS_VARIANTS) as LyricsVariant[];
const frame = flag("frame", "1:1") as MotionFrame;
const ffmpeg = flag("ffmpeg") ?? Bun.which("ffmpeg") ?? undefined;
const video = !argv.includes("--no-video") && videoAvailable({ ffmpeg });
if (!MOTION_FRAMES.includes(frame)) { console.error(`lyric-gallery: --frame must be one of ${MOTION_FRAMES.join(", ")}`); process.exit(1); }
for (const s of styles) if (!LYRICS_VARIANTS.includes(s)) { console.error(`lyric-gallery: unknown style ${s} (${LYRICS_VARIANTS.join(", ")})`); process.exit(1); }

/* ───────────── What to show ───────────── */
const STYLE_ZH: Record<LyricsVariant, string> = { classic: "舞台 Stage", editorial: "纸面 Paper", pop: "糖果 Pop", night: "夜行 Night" };

// Sample text written for this gallery (not a real song). Short lines (under six units) so no line is broken into chunks.
const TWO = "晚风吹亮*月光*\n我们慢慢走回家";
const THREE = "晚风吹亮*月光*\n我们慢慢走回家\n路灯一盏盏醒来";
/** Tried in order when a forced layout cannot set the first. */
const LAYOUT_TEXTS = [TWO, "晚风吹亮月光\n慢慢走回家", "晚风吹亮月光我们慢慢走回家\n路灯一盏一盏在河边醒来", "*月光*\n回家", "Paper *moon*\nWalk me home"];

const LAYOUT_ZH: Record<LyricLayout, [string, string]> = {
  center: ["居中", "整句居中排成一块，最朴素的构图。"],
  low: ["左下", "左对齐偏下，上方一条强调色短横线。"],
  stack: ["堆叠", "逐词换行堆成一列，行越多越像海报。"],
  steps: ["大小跳", "逐词堆叠，字号大—小—大交替跳动。"],
  giant: ["巨字", "短句用巨大字版铺满画面（一到两行）。"],
  focus: ["焦点字", "取句中一个字放大成背景幽灵字，整句叠在上面。"],
  diagonal: ["斜条", "整句做成一块倾斜字版，压在横穿画面的色带上。"],
  split: ["分屏", "画面分成两块色域，句子在分界两侧断开。"],
  mix: ["横竖混排", "中日文：前半句竖排在右侧，其余横排在左下。"],
  vertical: ["竖排", "中日文整句竖排成列。"],
  echo: ["回声", "句子上下各有空心的重复幽灵字。"],
  jump: ["跳字", "字版排成一行，关键词（*强调*）放大到两倍。"],
  labels: ["标签", "每个词各自压在一块墨色底板上。"],
  sweep: ["扫线", "左对齐，每行下方扫过一条粗色条；强调词带马克笔底。"],
  numeral: ["大编号", "巨大的镜头编号当作图形，句子叠在旁边。"],
  caption: ["题注", "杂志式：句子缩小放在左下角细线下，线尾是镜头编号。"],
  cascade: ["瀑布", "词一行一行向右下阶梯排列。"],
  frame: ["画框", "屏幕四周画一圈粗框，句子居中其中。"],
  ticker: ["跑马灯", "句子居中，上下两条滚动的跑马灯重复这句话。"],
  wide: ["疏排", "单行字距拉开，夹在两条细线之间。"],
  wave: ["波浪", "字版大小逐字跳动，基线上下起伏成波浪。"],
  tilt: ["歪字", "每个字做成字版，左右交替轻微倾斜，基线抖动。"],
};
const ENTRANCE_ZH: Record<LyricEntrance, [string, string]> = {
  rise: ["上浮", "逐字从下方浮起并淡入。"],
  drop: ["落下", "逐字从上方落下，落地回弹一下。"],
  slide: ["横滑", "逐字从左侧滑入。"],
  pop: ["弹出", "逐字向上弹出并略微过冲；字版则从小放大弹出。"],
  focus: ["对焦", "逐字由模糊变清晰。"],
  flicker: ["闪烁", "逐字像坏灯管一样闪几下才亮定（按 12 帧/秒步进）。"],
  type: ["打字", "逐字瞬间出现，像打字机（应用里的「打字机」动效即全程用它）。"],
  zoom: ["缩放", "字版从大缩到原大（普通字只是淡入，见下方「字版」版本）。"],
  wipe: ["擦出", "整块被一个移动窗口从左向右擦出，窗口边缘带一条强调色竖条。"],
  slice: ["切片", "整块切成三条横带，左右交替滑入拼合。"],
};
const HOLD_ZH: Record<LyricHold, [string, string]> = {
  still: ["静止", "入场后不动。"],
  drift: ["漂移", "停留期间缓慢向一侧斜上方漂。"],
  float: ["浮动", "上下轻轻浮动（2.4 秒一周期）。"],
  breathe: ["呼吸", "轻微放大缩小（2.8 秒一周期）。"],
  jitter: ["抖动", "每秒 12 步的随机小抖动（手持感）。"],
};
const TRANSITION_ZH: Record<LyricTransition, [string, string]> = {
  none: ["无", "只用于第一个镜头；与「硬切」看起来相同。"],
  cut: ["硬切", "下一镜头直接替换，没有过渡。"],
  "wipe-l": ["左擦", "新底色从左侧推入，旧字先退场。"],
  "wipe-r": ["右擦", "新底色从右侧推入。"],
  "wipe-u": ["上擦", "新底色从下方推上来。"],
  "wipe-d": ["下擦", "新底色从上方压下来。"],
  slice: ["切片", "新镜头切成横带从两侧交替滑入。"],
  flash: ["闪白", "切换瞬间闪一下白（浅底用强调色）。"],
  swap: ["反色", "先闪一帧墨色满屏，再出新镜头。"],
  glitch: ["故障", "切换时几条彩色横纹错位闪过。"],
  fade: ["淡入", "新镜头淡入，旧字淡出。"],
};
const DECOR_ZH: Record<LyricDecor, [string, string]> = {
  bars: ["圆角条", "空白处三条强调色圆角横条。"],
  orb: ["圆盘", "从角落升起的大圆（接近底色的淡色）。"],
  frame: ["边框", "屏幕四周一圈细/粗框。"],
  dots: ["圆点", "角落一排五个强调色圆点。"],
  rules: ["细线", "句子上下各一条细线。"],
  sun: ["小太阳", "角落一个强调色圆点（像印章/太阳）。"],
  none: ["无", "不加装饰。"],
};
const SHAPE_ZH: Record<LyricShapeMotion, [string, string]> = {
  none: ["无", "形状直接出现。"],
  "slide-l": ["左滑入", "形状从左侧整屏滑入。"],
  "slide-r": ["右滑入", "从右侧滑入。"],
  "slide-u": ["上滑入", "从下方滑上来。"],
  "slide-d": ["下滑入", "从上方滑下来。"],
  "grow-x": ["向右生长", "从左端横向伸长。"],
  "grow-x-r": ["向左生长", "从右端横向伸长。"],
  "grow-x-c": ["两边生长", "从中间向两边伸长。"],
  "grow-y": ["向下生长", "从顶端纵向伸长。"],
  pop: ["弹出", "从 0 放大并略微过冲。"],
  fade: ["淡入", "淡入。"],
  pulse: ["脉动", "停留期间随节拍一下下轻微放大。"],
};
const SHAPE_MOTIONS = Object.keys(SHAPE_ZH) as LyricShapeMotion[];

interface Clip {
  readonly section: string; readonly id: string; readonly zh: string; readonly code: string; readonly desc: string;
  readonly force: LyricForce; readonly texts: readonly string[];
  readonly motion?: TemplateMotion; readonly format?: "gif" | "mp4";
  /** Which program field to check against the forced value (every cut after the title). */
  readonly check?: { readonly field: "layout" | "entrance" | "motion" | "transition"; readonly value: string; readonly from?: number };
}
/** Everything but the effect on show held fixed and quiet. */
const QUIET: LyricForce = { chroma: false, micro: false, chunk: false };
const STILL: LyricForce = { ...QUIET, layout: "center", entrance: "rise", hold: "still", transition: "cut", decor: "none" };

const SECTIONS: { id: string; zh: string; intro: string; clips: Clip[] }[] = [
  { id: "layouts", zh: `构图（${LYRIC_LAYOUTS.length} 种）`, intro: "每个镜头的文字怎么摆。每段强制一种构图；入场与停留仍按风格随机（标注里写了实际用到的），关掉装饰、色散与小字。某构图排不下示例句时换一句更短的。",
    clips: LYRIC_LAYOUTS.map((l) => ({ section: "layouts", id: l, zh: LAYOUT_ZH[l][0], code: l, desc: LAYOUT_ZH[l][1], force: { ...QUIET, layout: l, transition: "cut", decor: "none" }, texts: LAYOUT_TEXTS, check: { field: "layout", value: l } })) },
  { id: "entrances", zh: `入场（${LYRIC_ENTRANCES.length} 种）`, intro: "文字怎么出现。统一用「居中」构图、停留静止、硬切；「字版」两段用「巨字」构图，展示字版上的缩放与弹出。",
    clips: [
      ...LYRIC_ENTRANCES.map((e) => ({ section: "entrances", id: e, zh: ENTRANCE_ZH[e][0], code: e, desc: ENTRANCE_ZH[e][1], force: { ...STILL, entrance: e }, texts: [TWO], check: { field: "entrance" as const, value: e } })),
      ...(["zoom", "pop"] as const).map((e) => ({ section: "entrances", id: `${e}-plate`, zh: `${ENTRANCE_ZH[e][0]}（字版）`, code: `${e} · giant`, desc: `在「巨字」字版上：${e === "zoom" ? "从 1.7 倍缩回原大" : "从 0.2 倍弹到 1.18 倍再回落"}。`, force: { ...STILL, layout: "giant" as const, entrance: e }, texts: ["晚风*月光*\n慢慢回家", "*月光*\n回家"], check: { field: "entrance" as const, value: e } })),
    ] },
  { id: "holds", zh: "停留（5 种）", intro: "文字停在画面上时怎么动。「居中」构图、上浮入场、硬切。动作幅度本来就小，请留意整块文字。",
    clips: (Object.keys(HOLD_ZH) as LyricHold[]).map((h) => ({ section: "holds", id: h, zh: HOLD_ZH[h][0], code: h, desc: HOLD_ZH[h][1], force: { ...STILL, hold: h }, texts: [TWO], check: { field: "motion", value: h } })) },
  { id: "transitions", zh: "转场（11 种）", intro: "镜头之间怎么切换。三句示例（两次转场），「居中」构图、上浮入场、静止。闪白、反色、故障只持续几帧，GIF 按 15 帧/秒，注意看切换瞬间。",
    clips: (Object.keys(TRANSITION_ZH) as LyricTransition[]).map((tr) => ({ section: "transitions", id: tr, zh: TRANSITION_ZH[tr][0], code: tr, desc: TRANSITION_ZH[tr][1], force: { ...STILL, transition: tr }, texts: [THREE], check: { field: "transition", value: tr, from: 1 } })) },
  { id: "decor", zh: "装饰（7 种）", intro: "安静构图上的点缀图形。「居中」构图、上浮入场、静止、硬切。各风格平时只从自己的装饰表里随机（见下方词汇表）。",
    clips: (Object.keys(DECOR_ZH) as LyricDecor[]).map((d) => ({ section: "decor", id: d, zh: DECOR_ZH[d][0], code: d, desc: DECOR_ZH[d][1], force: { ...STILL, decor: d }, texts: [TWO] })) },
  { id: "shapes", zh: `形状动作（${SHAPE_MOTIONS.length} 种）`, intro: "色块、色带、线条、装饰进场的方式。用「分屏」构图（两块色域 + 分界线）让形状足够大，所有形状统一用该动作；上浮入场、静止、硬切。",
    clips: SHAPE_MOTIONS.map((m) => ({ section: "shapes", id: m, zh: SHAPE_ZH[m][0], code: m, desc: SHAPE_ZH[m][1], force: { ...STILL, layout: "split" as const, shapeMotion: m }, texts: LAYOUT_TEXTS })) },
  { id: "extras", zh: "其他效果", intro: "不属于上面几类、但会出现的效果；以及不加任何强制时应用实际生成的样子（MP4 才有颗粒、扫描线、暗角、纸纹等质感，GIF 没有）。",
    clips: [
      { section: "extras", id: "chroma", zh: "色散重影", code: "chroma", desc: "文字后面两层偏色重影，随节拍抖开（夜行每镜都有，纸面没有）。", force: { ...STILL, chroma: true }, texts: [TWO] },
      { section: "extras", id: "micro", zh: "小字装饰", code: "micro", desc: "把本句用小字、宽字距放在空白处，配一条短色条（装饰，不计入正文）。", force: { ...STILL, micro: true }, texts: [TWO] },
      { section: "extras", id: "bang", zh: "感叹号闪屏", code: "bang (!)", desc: "句尾写「!」：落定时全屏闪一下并左右震动。", force: { ...STILL }, texts: ["晚风吹亮*月光*!\n我们慢慢走回家!"] },
      { section: "extras", id: "chunk", zh: "分块", code: "chunk", desc: "长句拆成两三段各占一个镜头（按词断开），段内多用硬切/闪白。", force: { ...QUIET, chunk: true, layout: "center", decor: "none" }, texts: ["我们沿着河边慢慢走回家\n路灯一盏一盏在身后醒来"] },
      { section: "extras", id: "notes", zh: "标签与注释", code: "[label] · line|note", desc: "「[副歌]」这样的段落标签在上方，「句子|注释」的注释小字在下方。", force: { ...STILL }, texts: ["[副歌]\n晚风吹亮月光|轻声哼\n我们慢慢走回家\n路灯一盏盏醒来"] },
      { section: "extras", id: "title", zh: "标题镜头", code: "title", desc: "LRC 的 [ti:] [ar:] 生成开头的标题镜头（巨字或居中、缩放入场）。", force: { ...QUIET }, texts: ["[ti:月光]\n[ar:Peesuto]\n[00:01.00]晚风吹亮月光\n[00:03.50]我们慢慢走回家"] },
      { section: "extras", id: "typewriter", zh: "打字机动效", code: "motion: typewriter", desc: "应用里选「打字机」时：每个镜头都用打字入场，其余照常随机。", force: { ...QUIET }, motion: "typewriter", texts: [THREE] },
      { section: "extras", id: "auto", zh: "自动（GIF）", code: "no force", desc: "不强制任何东西：应用实际会生成的样子。", force: {}, texts: ["晚风吹亮*月光*\n我们沿着河边慢慢走回家\n路灯一盏一盏醒来\n你说明天还会*再见*!"] },
      ...(video ? [{ section: "extras", id: "auto-mp4", zh: "自动（视频）", code: "no force · mp4", desc: "同上，MP4：有颗粒、扫描线、暗角、纸纹等质感（视风格而定）。", force: {}, format: "mp4" as const, texts: ["晚风吹亮*月光*\n我们沿着河边慢慢走回家\n路灯一盏一盏醒来\n你说明天还会*再见*!"] }] : []),
    ] },
];
const only = flag("sections")?.split(",");
const sections = SECTIONS.filter((s) => !only || only.includes(s.id));

/* ───────────── Rendering ───────────── */
interface Shot { file?: string; error?: string; text?: string; ms?: number; bytes?: number; cuts?: string; mismatch?: string }
const results = new Map<string, Shot>(); // `${section}/${id}/${style}`
const key = (c: Clip, s: string) => `${c.section}/${c.id}/${s}`;

const summary = (p: LyricsProgram) => p.cuts.map((c) => `${c.layout}/${c.entrance}/${c.motion}/${c.transition}`).join(" → ");
async function render(clip: Clip, variant: LyricsVariant, lane: { engine: string; work: string }): Promise<Shot> {
  const format = clip.format ?? "gif";
  const file = `${clip.section}-${clip.id}-${variant}.${format}`;
  let last: Shot = { error: "no text" };
  for (const text of clip.texts) {
    const started = performance.now();
    try {
      const decided = await decideTemplate(text, { aspect: frame, output: format === "mp4" ? "video" : "gif", decider: null, override: { id: "lyrics", variant, motion: clip.motion ?? "reveal" } });
      let program: LyricsProgram | undefined;
      await withLyricForce({ ...clip.force, onProgram: (p) => { program = p; } }, () => renderTemplate(decided.plan, {
        engine: lane.engine, work: lane.work, emojiCache: join(out, ".emoji"), emojiBundle: join(REPO, ".work/emoji-all"), ffmpeg, format, out: join(out, file),
      }));
      const shot: Shot = { file, text, ms: Math.round(performance.now() - started), bytes: Bun.file(join(out, file)).size, ...(program ? { cuts: summary(program) } : {}) };
      if (clip.check && program) {
        const bad = program.cuts.slice(clip.check.from ?? 0).filter((c) => String(c[clip.check!.field]) !== clip.check!.value);
        if (bad.length) shot.mismatch = `${clip.check.field}: ${bad.map((c) => c[clip.check!.field]).join(", ")}`;
      }
      return shot;
    } catch (error) {
      const e = errorOf(error);
      last = { error: `${e.kind}: ${e.message}`, text };
      // Only a forced layout that cannot set this text is worth another text.
      if (!/forced layout/.test(e.message)) return last;
    }
  }
  return last;
}

const clipOf = (section: string, id: string) => SECTIONS.find((s) => s.id === section)!.clips.find((c) => c.id === id)!;
const REPLY = "@@lyric-gallery ";
type Job = { section: string; id: string; style: LyricsVariant; engine: string; work: string };

// Worker mode: one render lane in its own process (compose and GIF encoding are CPU work on the JS thread), jobs as JSON lines on stdin.
if (argv.includes("--worker")) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const job = JSON.parse(line) as Job;
      const shot = await render(clipOf(job.section, job.id), job.style, job);
      process.stdout.write(`${REPLY}${JSON.stringify(shot)}\n`);
    }
  }
  process.exit(0);
}

const spawnWorker = () => Bun.spawn(["bun", import.meta.path, ...argv, "--worker"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
class Lane {
  private readonly proc: ReturnType<typeof spawnWorker>;
  private readonly waiting: ((shot: Shot) => void)[] = [];
  constructor(readonly engine: string, readonly work: string) {
    const proc = this.proc = spawnWorker();
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of proc.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.startsWith(REPLY)) this.waiting.shift()?.(JSON.parse(line.slice(REPLY.length)) as Shot);
        }
      }
      for (const w of this.waiting.splice(0)) w({ error: "worker exited" });
    })();
  }
  render(clip: Clip, style: LyricsVariant): Promise<Shot> {
    return new Promise((done) => {
      this.waiting.push(done);
      this.proc.stdin.write(JSON.stringify({ section: clip.section, id: clip.id, style, engine: this.engine, work: this.work } satisfies Job) + "\n");
      this.proc.stdin.flush();
    });
  }
  async close() { this.proc.stdin.end(); await this.proc.exited; }
}

await mkdir(out, { recursive: true });
// Engine clones (APFS clonefile when available: cheap), one per lane: engine builds rewrite files in the checkout.
const lanes: Lane[] = [];
for (let k = 0; k < jobs; k++) {
  const engine = join(out, `.engine-${k}`);
  await rm(engine, { recursive: true, force: true });
  const clone = Bun.spawnSync(["cp", "-cR", sourceEngine, engine]);
  if (clone.exitCode !== 0) await cp(sourceEngine, engine, { recursive: true });
  lanes.push(new Lane(engine, join(out, `.tree-${k}`)));
}
// Slowest first (MP4, then three-cut clips), so no lane is left with a long job at the end.
const weight = (c: Clip) => (c.format === "mp4" ? 3 : c.texts[0]!.split("\n").length > 2 ? 1 : 0);
const queue = sections.flatMap((s) => s.clips).flatMap((clip) => styles.map((style) => ({ clip, style }))).sort((a, b) => weight(b.clip) - weight(a.clip));
const started = performance.now();
let done = 0;
await Promise.all(lanes.map(async (lane) => {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const shot = await lane.render(job.clip, job.style);
    results.set(key(job.clip, job.style), shot);
    done++;
    console.log(`[${done}] ${key(job.clip, job.style)} ${shot.error ? `ERROR ${shot.error}` : `${shot.ms} ms${shot.mismatch ? ` MISMATCH ${shot.mismatch}` : ""}`}`);
  }
}));
const seconds = Math.round((performance.now() - started) / 1000);
for (const lane of lanes) { await lane.close(); await rm(lane.engine, { recursive: true, force: true }); await rm(lane.work, { recursive: true, force: true }); }

/* ───────────── The vocabulary table ───────────── */
type Table = { title: string; names: Record<string, [string, string]>; rows: readonly string[]; weight: (s: LyricsVariant, k: string) => number | undefined; note: string };
const pct = (w: number, total: number) => `${Math.round((w / total) * 100)}%`;
const TABLES: Table[] = [
  { title: "构图", names: LAYOUT_ZH, rows: LYRIC_LAYOUTS, weight: (s, k) => (LYRICS_MOTION[s].layouts as Record<string, number>)[k],
    note: "权重再乘以「适合度」（句子长短、有无强调、是否中日文、画幅）和「新鲜度」（最近用过的降权）。表中没有的构图不会被自动选到（标题镜头例外：巨字或居中）。" },
  { title: "入场", names: ENTRANCE_ZH, rows: LYRIC_ENTRANCES, weight: (s, k) => (LYRICS_MOTION[s].entrances as Record<string, number>)[k],
    note: "只在当前构图允许的入场里选；风格表里没有的入场以 0.05 的小权重兜底（很少出现）。标题镜头用缩放/上浮；打字机动效全程用打字。" },
  { title: "停留", names: HOLD_ZH, rows: Object.keys(HOLD_ZH), weight: (s, k) => (LYRICS_MOTION[s].holds as Record<string, number>)[k],
    note: "少数构图自带停留列表（巨字、波浪、歪字等），那时风格表外的停留以 0.2 兜底。" },
  { title: "转场", names: TRANSITION_ZH, rows: (Object.keys(TRANSITION_ZH) as string[]).filter((k) => k !== "none"), weight: (s, k) => (LYRICS_MOTION[s].transitions as Record<string, number>)[k],
    note: "与上一个转场相同的降为 1/4。同一句拆出来的分块之间另有规则：硬切为主，偶尔闪白（纸面用淡入）。" },
  { title: "装饰", names: DECOR_ZH, rows: Object.keys(DECOR_ZH), weight: (s, k) => ((LYRICS_STYLES[s].motion.decor as readonly string[]).includes(k) ? 1 : undefined),
    note: "装饰在风格列表里等概率随机（不与上一镜相同），只加在不「满」的构图上。" },
];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const vocabTable = (t: Table) => {
  const totals = LYRICS_VARIANTS.map((s) => t.rows.reduce((n, k) => n + (t.weight(s, k) ?? 0), 0));
  return `<h3>${t.title}</h3><table><thead><tr><th>效果</th>${LYRICS_VARIANTS.map((s) => `<th>${STYLE_ZH[s]}</th>`).join("")}</tr></thead><tbody>
${t.rows.map((k) => `<tr><td>${esc(t.names[k]?.[0] ?? k)} <code>${esc(k)}</code></td>${LYRICS_VARIANTS.map((s, i) => { const w = t.weight(s, k); return w ? `<td class="on" style="--w:${Math.min(1, w / 1.6)}">${t.title === "装饰" ? "✓" : `${w} <small>${pct(w, totals[i]!)}</small>`}</td>` : `<td class="off">—</td>`; }).join("")}</tr>`).join("\n")}
</tbody></table><p class="note">${t.note}</p>`;
};
const params = `<table><thead><tr><th>参数</th>${LYRICS_VARIANTS.map((s) => `<th>${STYLE_ZH[s]}</th>`).join("")}</tr></thead><tbody>
${([
  ["节拍 bpm（镜头长度对齐节拍）", (s) => String(LYRICS_MOTION[s].bpm)],
  ["抽帧 koma（0 = 流畅，12 = 每秒 12 张）", (s) => String(LYRICS_MOTION[s].koma)],
  ["入场时长 ms / 逐字间隔 ms", (s) => `${LYRICS_MOTION[s].enterMs} / ${LYRICS_MOTION[s].staggerMs}`],
  ["色散重影出现比例", (s) => pct(LYRICS_MOTION[s].ghosts.share, 1)],
  ["长句分块比例", (s) => pct(LYRICS_MOTION[s].chunk, 1)],
  ["小字装饰比例", (s) => pct(LYRICS_MOTION[s].micro, 1)],
  ["取景框 HUD（四角 + 镜头计数）", (s) => (LYRICS_MOTION[s].hud ? "有" : "—")],
  ["质感（仅视频）颗粒/扫描线/暗角/纸纹", (s) => { const t = LYRICS_MOTION[s].texture; return [t.grain, t.scanlines, t.vignette, t.paper].map((v) => (v ? String(v) : "—")).join(" / "); }],
  ["配色", (s) => (LYRICS_STYLES[s].motion.palette as readonly { bg: string; ink: string; accent: string }[]).map((p) => `<span class="sw" style="background:${p.bg};color:${p.ink}">A<b style="color:${p.accent}">a</b></span>`).join("")],
] as [string, (s: LyricsVariant) => string][]).map(([name, f]) => `<tr><td>${name}</td>${LYRICS_VARIANTS.map((s) => `<td>${f(s)}</td>`).join("")}</tr>`).join("\n")}
</tbody></table>`;

/* ───────────── The page ───────────── */
const figure = (clip: Clip) => {
  const shots = Object.fromEntries(styles.map((s) => [s, results.get(key(clip, s)) ?? { error: "未渲染" }]));
  const data = esc(JSON.stringify(shots));
  const first = shots[styles[0]!]!;
  const isVideo = clip.format === "mp4";
  const media = isVideo ? `<video autoplay muted loop playsinline controls ${first.file ? `src="${first.file}"` : ""}></video>` : `<img loading="lazy" alt="${esc(clip.zh)}" ${first.file ? `src="${first.file}"` : ""}>`;
  return `<figure data-shots="${data}">${media}<p class="err" ${first.error ? "" : "hidden"}>${esc(first.error ?? "")}</p>
<figcaption><b>${esc(clip.zh)}</b> <code>${esc(clip.code)}</code><span>${esc(clip.desc)}</span><small class="meta"></small></figcaption></figure>`;
};
const total = sections.reduce((n, s) => n + s.clips.length, 0) * styles.length;
const failed = [...results.values()].filter((r) => r.error).length;
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>文字 PV 效果图鉴</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#f4f2ee;--card:#fff;--ink:#1f2328;--muted:#6b6f76;--line:#e3dfd7;--accent:#2e5e52;--on:46,94,82}
@media (prefers-color-scheme:dark){:root{--bg:#141618;--card:#1e2124;--ink:#e8e6e3;--muted:#9aa0a6;--line:#2c3034;--accent:#8fc2b0;--on:143,194,176}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
header{padding:28px 32px 4px}h1{margin:0 0 4px;font-size:22px}header p{margin:0 0 4px;color:var(--muted);max-width:980px}
.bar{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 32px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.tabs button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:999px;padding:4px 14px;cursor:pointer}
.tabs button[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:var(--bg)}
nav a{color:var(--accent);text-decoration:none;font-size:12px;margin-right:10px}
section{margin:0 32px 40px;padding-top:14px}h2{font-size:18px;margin:10px 0 4px}h3{font-size:15px;margin:22px 0 6px}.intro{color:var(--muted);margin:0 0 12px;max-width:980px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
figure img,figure video{display:block;width:100%;aspect-ratio:${frame.replace(":", "/")};object-fit:contain;background:#0002}
figcaption{padding:8px 10px 10px;font-size:13px}figcaption span{display:block;margin-top:2px}figcaption .meta{display:block;color:var(--muted);font-size:11px;margin-top:4px;word-break:break-all}
code{font:12px ui-monospace,Menlo,monospace;color:var(--muted)}.err{color:#c0392b;padding:8px 10px;margin:0;font-size:12px}.warn{color:#b9770e}
table{border-collapse:collapse;background:var(--card);border:1px solid var(--line);font-size:13px;min-width:min(760px,100%)}
th,td{border-bottom:1px solid var(--line);padding:5px 10px;text-align:left;white-space:nowrap}td.on{background:rgba(var(--on),calc(var(--w)*.35))}td.off{color:var(--muted)}td small{color:var(--muted)}
.tw{overflow-x:auto}.note{color:var(--muted);font-size:12px;margin:6px 0 0;max-width:980px}
.sw{display:inline-block;width:28px;height:22px;line-height:22px;text-align:center;border-radius:4px;margin-right:4px;font-weight:700;border:1px solid #0002}
@media (max-width:600px){header,section{margin-left:16px;margin-right:16px;padding-left:0;padding-right:0}.bar{padding:8px 16px}}
</style>
<header><h1>文字 PV（Lyric motion）效果图鉴</h1>
<p>文字 PV 的每个镜头 = 构图 + 入场 + 停留 + 转场 + 装饰（+ 形状动作、色散重影等）。应用按风格的权重、句子长短、强调与前几个镜头的用法随机挑选（同一段文字结果固定）。这里每段只强制一个维度，其余固定为最安静的选择，让你看清这一种效果。</p>
<p>示例文字为本页原创。画幅 ${frame}，GIF（15 帧/秒）。共 ${total} 段，${failed ? `<b class="warn">${failed} 段失败</b>，` : ""}渲染用时 ${seconds} 秒（${jobs} 路并行），生成于 ${new Date().toLocaleString("zh-CN")}。每段下方灰字是实际用到的「构图/入场/停留/转场」，按镜头顺序。</p></header>
<div class="bar"><div class="tabs">${styles.map((s, i) => `<button data-style="${s}" aria-pressed="${i === 0}">${STYLE_ZH[s]}</button>`).join(" ")}</div>
<nav>${sections.map((s) => `<a href="#${s.id}">${s.zh}</a>`).join("")}<a href="#vocab">各风格词汇表</a></nav></div>
${sections.map((s) => `<section id="${s.id}"><h2>${s.zh}</h2><p class="intro">${s.intro}</p><div class="grid">${s.clips.map(figure).join("\n")}</div></section>`).join("\n")}
<section id="vocab"><h2>各风格词汇表（LYRICS_MOTION）</h2><p class="intro">每种风格会用到哪些效果、基础权重多少（百分比 = 该项在本风格同类里的基础占比）。「—」表示这个风格自动生成时不会用（或只在兜底时极少出现，见表下说明）。</p>
${TABLES.map((t) => `<div class="tw">${vocabTable(t)}</div>`).join("\n")}
<h3>节奏与质感</h3><div class="tw">${params}</div></section>
<script>
const show = (style) => {
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-pressed", String(b.dataset.style === style));
  for (const f of document.querySelectorAll("figure[data-shots]")) {
    const shot = JSON.parse(f.dataset.shots)[style] || { error: "未渲染" };
    const m = f.querySelector("img,video"), err = f.querySelector(".err"), meta = f.querySelector(".meta");
    if (shot.file) { if (m.getAttribute("src") !== shot.file) m.setAttribute("src", shot.file); m.hidden = false; } else { m.removeAttribute("src"); m.hidden = true; }
    err.hidden = !shot.error; err.textContent = shot.error || "";
    meta.innerHTML = "";
    if (shot.cuts) meta.append(shot.cuts);
    if (shot.mismatch) { const w = document.createElement("b"); w.className = "warn"; w.textContent = " 未完全强制：" + shot.mismatch; meta.append(w); }
    if (shot.text && shot.file) meta.append(" · 示例：" + shot.text.replace(/\\n/g, " / "));
  }
  try { localStorage.setItem("lyric-gallery-style", style); } catch {}
};
for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => show(b.dataset.style));
let initial = ${JSON.stringify(styles[0])};
try { const saved = localStorage.getItem("lyric-gallery-style"); if (saved && document.querySelector('.tabs button[data-style="' + saved + '"]')) initial = saved; } catch {}
show(initial);
</script>
</html>
`;
await Bun.write(join(out, "index.html"), html);
await Bun.write(join(out, "manifest.json"), JSON.stringify(Object.fromEntries(results), null, 1));
console.log(`lyric-gallery: ${join(out, "index.html")} — ${total} clips, ${failed} failed, ${seconds} s with ${jobs} jobs`);
