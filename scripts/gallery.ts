/**
 * Template gallery, the static export of the Studio (scripts/studio.ts): the
 * scenarios in scripts/studio/scenarios.ts, each decided the way the app decides
 * it (local rules), rendered in every style of the chosen template, every style
 * of the other candidate templates, each motion as GIF and one MP4, through the
 * Studio's pipeline (scripts/studio/pipeline.ts). Writes a static page.
 *
 *   bun scripts/gallery.ts [--engine <prepared engine>] [--out .work/gallery] [--only <scenario id,...>] [--no-video]
 *                          [--image-frame auto|1:1|4:5|16:9|9:16] [--motion-frame 1:1|4:5|16:9|9:16]
 *
 * PNGs use the image frame (default auto: width by content, height hugs it),
 * GIF/MP4 the fixed animated frame (default 1:1).
 *
 * The engine checkout is copied first: its build tools write vendor caches.
 * MP4 uses the native PeesutoEncoder when built (swift build --package-path native -c release),
 * else ffmpeg (PATH or --ffmpeg). Open <out>/index.html in a browser.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ALL_FORMATS, errorOf, frameName, IMAGE_FRAMES, MOTION_FRAMES, planText, privacyView, renderJob, type ImageFrame, type JobGroup, type MotionFrame } from "./studio/pipeline.ts";
import { SCENARIOS, type Scenario } from "./studio/scenarios.ts";
import { videoAvailable } from "../core/src/render/video.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const REPO = resolve(import.meta.dir, "..");
const out = resolve(flag("out", join(REPO, ".work/gallery"))!);
const sourceEngine = resolve(flag("engine", join(REPO, ".work/native-engine"))!);
const only = flag("only")?.split(",");
const video = !argv.includes("--no-video");
const ffmpeg = flag("ffmpeg") ?? Bun.which("ffmpeg") ?? undefined;
const imageFrame = flag("image-frame", "auto") as ImageFrame;
const motionFrame = flag("motion-frame", "1:1") as MotionFrame;
if (!IMAGE_FRAMES.includes(imageFrame)) { console.error(`gallery: --image-frame must be one of ${IMAGE_FRAMES.join(", ")}`); process.exit(1); }
if (!MOTION_FRAMES.includes(motionFrame)) { console.error(`gallery: --motion-frame must be one of ${MOTION_FRAMES.join(", ")}`); process.exit(1); }

interface Shot { label: string; file: string; kind: "png" | "gif" | "mp4"; group: JobGroup; note?: string }
interface Section { scenario: Scenario; chosen: string; candidates: string[]; shots: Shot[]; error?: string; model?: string }

const engine = join(out, ".engine");
await mkdir(out, { recursive: true });
await rm(engine, { recursive: true, force: true });
await cp(sourceEngine, engine, { recursive: true });
const engineOptions = { engine, root: out, repo: REPO, ffmpeg };
const GROUP_PREFIX: Record<JobGroup, string> = { chosen: "", frames: "画幅：", other: "可选：", motion: "", video: "" };

const sections: Section[] = [];
for (const scenario of SCENARIOS.filter((s) => !only || only.includes(s.id))) {
  // What a model would receive in the default mode, shown when a privacy rule matched.
  const view = privacyView(scenario.text, "redacted");
  const section: Section = { scenario, chosen: "", candidates: [], shots: [], ...(view.segments.some((x) => x.ruleId) ? { model: view.modelText } : {}) };
  sections.push(section);
  try {
    const { decision, jobs } = await planText(scenario.text, { imageFrame, motionFrame, decider: "rules", answersDir: join(out, ".answers"), formats: ALL_FORMATS, video: video && videoAvailable({ ffmpeg }) });
    section.chosen = decision.templateName;
    section.candidates = decision.candidates.map((c) => c.name);
    console.log(`${scenario.id}: ${decision.template} [${decision.candidates.map((c) => c.id).join(", ")}]`);
    for (const job of jobs) {
      const file = `${scenario.id}-${job.template}-${job.variant}-${job.motion}-${job.frame.replace(":", "x")}.${job.format}`;
      try {
        const r = await renderJob(job.plan, job.format, join(out, file), engineOptions);
        const note = [r.frames > 1 ? `${r.frames} 帧` : "", r.scroll ? "滚动" : "", `${r.ms} ms`].filter(Boolean).join(" · ");
        section.shots.push({ label: `${GROUP_PREFIX[job.group]}${job.label} ${r.width}×${r.height}`, file, kind: job.format, group: job.group, note });
        process.stdout.write(`  ${file} (${note})\n`);
      } catch (error) {
        const e = errorOf(error);
        section.shots.push({ label: GROUP_PREFIX[job.group] + job.label, file: "", kind: job.format, group: job.group, note: `${e.kind}: ${e.message}` });
        process.stdout.write(`  ${file} ERROR ${e.kind}: ${e.message}\n`);
      }
    }
  } catch (error) {
    section.error = error instanceof Error ? error.message : String(error);
    console.log(`${scenario.id}: ERROR ${section.error}`);
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const media = (shot: Shot) => !shot.file ? `<p class="err">渲染失败</p>` : shot.kind === "mp4"
  ? `<video src="${shot.file}" autoplay muted loop playsinline controls></video>`
  : `<img src="${shot.file}" loading="lazy" alt="${esc(shot.label)}">`;
const html = `<!doctype html><meta charset="utf-8"><title>Peesuto 模板预览</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#f4f2ee;--card:#fff;--ink:#1f2328;--muted:#6b6f76;--line:#e3dfd7;--accent:#2e5e52}
@media (prefers-color-scheme:dark){:root{--bg:#141618;--card:#1e2124;--ink:#e8e6e3;--muted:#9aa0a6;--line:#2c3034;--accent:#8fc2b0}}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
header{padding:28px 32px 8px}h1{margin:0 0 4px;font-size:22px}header p{margin:0;color:var(--muted)}
nav{padding:8px 32px 16px;display:flex;flex-wrap:wrap;gap:6px}nav a{color:var(--accent);text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:12px}
section{margin:0 32px 36px;padding-top:12px;border-top:1px solid var(--line)}
h2{font-size:17px;margin:8px 0}.meta{color:var(--muted);font-size:12px;margin-bottom:8px}.meta b{color:var(--accent)}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;white-space:pre-wrap;max-height:180px;overflow:auto;font:12px/1.5 ui-monospace,Menlo,monospace;margin:0 0 12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
figure img,figure video{display:block;width:100%;height:auto;max-height:520px;object-fit:contain;background:#0001}
figcaption{padding:8px 10px;font-size:12px}figcaption small{display:block;color:var(--muted)}
.err{color:#c0392b}
</style>
<header><h1>Peesuto 模板预览</h1><p>每个场景按应用的本地规则自动选模板（第一组），其后是同一模板的其他风格、其他可选模板的各风格、每种动效的 GIF 和一段视频。图片画幅 ${frameName(imageFrame)}，动图/视频画幅 ${motionFrame}。生成于 ${new Date().toLocaleString("zh-CN")}。</p></header>
<nav>${sections.map((s) => `<a href="#${s.scenario.id}">${esc(s.scenario.title)}</a>`).join("")}</nav>
${sections.map((s) => `<section id="${s.scenario.id}"><h2>${esc(s.scenario.title)}</h2>
<div class="meta">自动选择：<b>${esc(s.chosen)}</b>　可选模板：${s.candidates.map(esc).join("、")}</div>
<pre>${esc(s.scenario.text)}</pre>
${s.model ? `<div class="meta">模型收到（敏感信息脱敏，默认）：</div><pre>${esc(s.model)}</pre>` : ""}
${s.error ? `<p class="err">${esc(s.error)}</p>` : ""}
<div class="grid">${s.shots.map((shot) => `<figure>${media(shot)}<figcaption>${esc(shot.label)}<small>${esc(shot.note ?? "")}</small></figcaption></figure>`).join("")}</div></section>`).join("\n")}
`;
await Bun.write(join(out, "index.html"), html);
await rm(engine, { recursive: true, force: true });
console.log(`gallery: ${join(out, "index.html")}`);
