/**
 * Template gallery: realistic clipboard scenarios, each decided the way the app
 * decides it (local rules), rendered in every style of the chosen template, the
 * other candidate templates, two GIF motions and one MP4. Writes a static page.
 *
 *   bun scripts/gallery.ts [--engine <prepared engine>] [--out .work/gallery] [--only <scenario id,...>] [--no-video]
 *
 * The engine checkout is copied first: its build tools write vendor caches.
 * MP4 needs ffmpeg (PATH or --ffmpeg). Open <out>/index.html in a browser.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decideTemplate } from "../core/src/templates/decide.ts";
import { renderTemplate } from "../core/src/templates/render.ts";
import { templateRegistration } from "../core/src/templates/registry.ts";
import type { TemplateId, TemplateMotion, VariantId } from "../core/src/templates/types.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const REPO = resolve(import.meta.dir, "..");
const out = resolve(flag("out", join(REPO, ".work/gallery"))!);
const sourceEngine = resolve(flag("engine", join(REPO, ".work/native-engine"))!);
const only = flag("only")?.split(",");
const video = !argv.includes("--no-video");
const ffmpeg = flag("ffmpeg") ?? Bun.which("ffmpeg") ?? undefined;

interface Scenario { id: string; title: string; text: string }
const SCENARIOS: Scenario[] = [
  { id: "short", title: "一句话", text: "少即是多。" },
  { id: "slogan", title: "一句中文文案", text: "好的设计，是把复杂留给自己，把简单留给别人。" },
  { id: "english", title: "英文短句", text: "Make it work, make it right, make it fast." },
  { id: "paragraph", title: "两段感想", text: "我们总以为效率来自更快的工具，其实更多来自更少的切换。把一件事做完再开始下一件，比同时开着十个窗口要快得多。\n\n今天就试试：关掉不用的标签页。" },
  { id: "emoji", title: "带 emoji 的消息", text: "周五下午茶到了 🍰☕️ 大家自取，顺便庆祝新版本上线 🎉" },
  { id: "quote", title: "带作者的引语", text: "“一个人只拥有此生此世是不够的，他还应该拥有诗意的世界。”——王小波" },
  { id: "quote-en", title: "英文引用块", text: "> Simplicity is prerequisite for reliability.\n— Edsger W. Dijkstra" },
  { id: "stat", title: "数据指标", text: "本季度活跃用户增长: 37%" },
  { id: "list", title: "有序清单", text: "1. 先把问题写清楚\n2. 一次只改一个变量\n3. 量化结果再继续" },
  { id: "bullets", title: "无序清单（英文）", text: "- Ship the native app\n- Record the release notes\n- Ask ten people to try it" },
  { id: "code", title: "代码块", text: "```ts\nconst greet = (name: string) => {\n  return `Hello, ${name}!`;\n};\nconsole.log(greet(\"世界\"));\n```" },
  { id: "command", title: "终端命令", text: "git log --oneline -5 --author=anelikes" },
  { id: "chat", title: "带标签的对话", text: "用户: 这个快捷键在哪里改？\n助手: 设置 → 通用 → 快捷键，点一下就能录新的组合。\n用户: 找到了，谢谢！" },
  { id: "chat-app", title: "从聊天软件复制的记录（长，会滚动）", text: "nok\n2026年09月22日 22:10\n如果ty不去武汉的话我整一个看看\n\nshybee\n2026年09月23日  0:10\n@nok \n\nshybee\n2026年09月23日  0:10\n全聚德\n\nshybee\n2026年09月23日  0:11\n明天吃这个不\n\nnok\n2026年09月23日  8:20\n牛逼\n\nnok\n2026年09月23日  8:20\nok" },
  { id: "table", title: "Markdown 表格", text: "| 项目 | 状态 | 负责人 |\n| --- | --- | --- |\n| 原生界面 | 完成 | nok |\n| 模板渲染 | 验证中 | shybee |\n| 签名公证 | 待证书 | — |" },
  { id: "comparison", title: "前后对比", text: "之前:\n许多零散入口\n\n手动排版\n\n之后:\n一个明确动作\n\n自动选择模板" },
  { id: "markdown", title: "Markdown 笔记", text: "# 周会纪要\n\n本周完成了原生版迁移，**所有测试通过**。\n\n- 文字模板上线\n- 聊天记录可以滚动\n\n## 下周\n\n准备第一次签名发布。" },
  { id: "long", title: "长文（超过一屏）", text: Array.from({ length: 6 }, (_, i) => `第 ${i + 1} 段。把复杂的想法讲清楚，需要先把它想清楚，再删掉所有不必要的部分，最后留下的每一句话都应该有它存在的理由。写作如此，做产品也如此。`).join("\n\n") },
];

interface Shot { label: string; file: string; kind: "png" | "gif" | "mp4"; note?: string }
interface Section { scenario: Scenario; chosen: TemplateId; candidates: TemplateId[]; shots: Shot[]; error?: string }

const engine = join(out, ".engine");
await mkdir(out, { recursive: true });
await rm(engine, { recursive: true, force: true });
await cp(sourceEngine, engine, { recursive: true });
const options = { engine, work: join(out, ".work"), emojiCache: join(out, ".emoji"), emojiBundle: join(REPO, ".work/emoji-all"), ffmpeg };

const name = (id: TemplateId) => templateRegistration(id).nameZh;
const style = (id: TemplateId, v: VariantId) => templateRegistration(id).variants.find((x) => x.id === v)?.nameZh ?? v;
const MOTION: Record<TemplateMotion, string> = { none: "静止", reveal: "逐段出现", typewriter: "打字机" };

const sections: Section[] = [];
for (const scenario of SCENARIOS.filter((s) => !only || only.includes(s.id))) {
  const section: Section = { scenario, chosen: "document", candidates: [], shots: [] };
  sections.push(section);
  try {
    const decision = await decideTemplate(scenario.text, { aspect: "chat", output: "image", decider: null });
    section.chosen = decision.plan.template;
    section.candidates = [...decision.availableTemplates];
    const shoot = async (label: string, template: TemplateId, variant: VariantId | undefined, output: "image" | "gif" | "video", motion?: TemplateMotion) => {
      const format = output === "image" ? "png" : output === "gif" ? "gif" : "mp4";
      const d = await decideTemplate(scenario.text, { aspect: "chat", output, decider: null, override: { id: template, ...(variant ? { variant } : {}), ...(motion ? { motion } : {}) } });
      const file = `${scenario.id}-${template}-${d.plan.variant}-${d.plan.motion}.${format}`;
      const started = performance.now();
      const r = await renderTemplate(d.plan, { ...options, format, out: join(out, file) });
      const note = [`${r.width}×${r.height}`, r.frames > 1 ? `${r.frames} 帧` : "", r.scroll ? "滚动" : "", `${Math.round(performance.now() - started)} ms`].filter(Boolean).join(" · ");
      section.shots.push({ label, file, kind: format, note });
      process.stdout.write(`  ${file} (${note})\n`);
    };
    console.log(`${scenario.id}: ${section.chosen} [${section.candidates.join(", ")}]`);
    const chosen = section.chosen;
    for (const v of templateRegistration(chosen).variants) await shoot(`${name(chosen)} · ${v.nameZh} · PNG`, chosen, v.id, "image");
    for (const other of section.candidates.filter((id) => id !== chosen)) await shoot(`可选：${name(other)} · ${style(other, "classic")} · PNG`, other, "classic", "image");
    for (const motion of ["reveal", "typewriter"] as const) await shoot(`${name(chosen)} · ${style(chosen, "classic")} · ${MOTION[motion]} · GIF`, chosen, "classic", "gif", motion);
    if (video && ffmpeg) await shoot(`${name(chosen)} · ${style(chosen, "classic")} · ${MOTION.reveal} · 视频`, chosen, "classic", "video", "reveal");
  } catch (error) {
    section.error = error instanceof Error ? error.message : String(error);
    console.log(`${scenario.id}: ERROR ${section.error}`);
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const media = (shot: Shot) => shot.kind === "mp4"
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
<header><h1>Peesuto 模板预览</h1><p>每个场景按应用的本地规则自动选模板（第一组），其后是同一模板的其他风格、其他可选模板、两种动效的 GIF 和一段视频。生成于 ${new Date().toLocaleString("zh-CN")}。</p></header>
<nav>${sections.map((s) => `<a href="#${s.scenario.id}">${esc(s.scenario.title)}</a>`).join("")}</nav>
${sections.map((s) => `<section id="${s.scenario.id}"><h2>${esc(s.scenario.title)}</h2>
<div class="meta">自动选择：<b>${esc(name(s.chosen))}</b>　可选模板：${s.candidates.map((id) => esc(name(id))).join("、")}</div>
<pre>${esc(s.scenario.text)}</pre>
${s.error ? `<p class="err">${esc(s.error)}</p>` : ""}
<div class="grid">${s.shots.map((shot) => `<figure>${media(shot)}<figcaption>${esc(shot.label)}<small>${esc(shot.note ?? "")}</small></figcaption></figure>`).join("")}</div></section>`).join("\n")}
`;
await Bun.write(join(out, "index.html"), html);
await rm(engine, { recursive: true, force: true });
console.log(`gallery: ${join(out, "index.html")}`);
