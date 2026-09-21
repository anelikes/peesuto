#!/usr/bin/env bun
/**
 * paste — a clipboard card from an all-enumerated DSL.
 *
 * Every field except `text` is a value Jev can return: a Choice over a fixed
 * set, a Score 0..3, or a boolean. `text` is the clipboard and comes from code.
 * Line breaks and sizes are measured, never guessed.
 *
 *   bun compositions/paste/gen.ts --dsl job.json
 */
import { fitToBox, segments, wrapLines } from "../../src/text/fit.ts";
import { openMeasurer } from "../../src/text/measure.ts";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const DIR = new URL(".", import.meta.url).pathname;

type Kind = "quote" | "code" | "stat" | "list" | "plain";
type Layout = "center" | "left" | "split";
type Palette = "ink" | "paper" | "cyan" | "amber";
type Aspect = "chat" | "doc" | "social";
interface Dsl {
  text: string; kind: Kind; layout: Layout; palette: Palette; aspect: Aspect;
  scale: 0 | 1 | 2 | 3; tone: 0 | 1 | 2 | 3; emphasis: number; animate: boolean;
}
const KINDS = ["quote", "code", "stat", "list", "plain"], LAYOUTS = ["center", "left", "split"],
  PALETTES = ["ink", "paper", "cyan", "amber"], ASPECTS = ["chat", "doc", "social"];

const VIEW: Record<Aspect, { w: number; h: number }> = { chat: { w: 1080, h: 1080 }, doc: { w: 1920, h: 1080 }, social: { w: 1080, h: 1920 } };
const PAL: Record<Palette, { bg: string; bg2: string; ink: string; muted: string; accent: string }> = {
  ink:   { bg: "#0b0f14", bg2: "#11161d", ink: "#f2f4f7", muted: "#9aa4b2", accent: "#7dd3fc" },
  paper: { bg: "#f7f3ea", bg2: "#efe8da", ink: "#1c1a17", muted: "#6b6257", accent: "#b45309" },
  cyan:  { bg: "#041c2c", bg2: "#062f45", ink: "#ffffff", muted: "#9fd3e8", accent: "#22d3ee" },
  amber: { bg: "#1a1206", bg2: "#2a1d08", ink: "#fde68a", muted: "#b8a06a", accent: "#f59e0b" },
};
/** Noto Sans SC bakes up to 176 px (AGENTS.md); ladders stay under it. */
const LADDER: Record<number, readonly number[]> = { 0: [40, 36, 32], 1: [56, 48, 42, 36], 2: [80, 72, 64, 56, 48], 3: [120, 104, 96, 84, 72, 60] };
const HERO: Record<number, readonly number[]> = { 0: [120, 104], 1: [144, 128, 112], 2: [160, 144, 128], 3: [176, 160, 144, 128] };
const AMP = [0, 24, 56, 110] as const;   // translateY px by tone
const DUR = [0, 360, 480, 620] as const; // ms by tone
const EASE = ["linear", "cubic-bezier(0.33,1,0.68,1)", "cubic-bezier(0.16,1,0.3,1)", "cubic-bezier(0.34,1.56,0.64,1)"] as const;

function parseDsl(raw: any): Dsl {
  const bad = (m: string) => { throw new Error(`paste dsl: ${m}`); };
  if (typeof raw.text !== "string" || !raw.text.trim()) bad("text must be a non-empty string");
  if (!KINDS.includes(raw.kind)) bad(`kind must be one of ${KINDS.join("|")}`);
  if (!LAYOUTS.includes(raw.layout)) bad(`layout must be one of ${LAYOUTS.join("|")}`);
  if (!PALETTES.includes(raw.palette)) bad(`palette must be one of ${PALETTES.join("|")}`);
  if (!ASPECTS.includes(raw.aspect)) bad(`aspect must be one of ${ASPECTS.join("|")}`);
  for (const k of ["scale", "tone"]) if (![0, 1, 2, 3].includes(raw[k])) bad(`${k} must be 0..3`);
  if (!Number.isInteger(raw.emphasis) || raw.emphasis < -1) bad("emphasis must be -1 or a word index");
  if (typeof raw.animate !== "boolean") bad("animate must be boolean");
  return raw as Dsl;
}

const jsx = (s: string) => JSON.stringify(s);
const px = (v: number) => `${Math.round(v)}px`;

async function main() {
  const i = process.argv.indexOf("--dsl");
  if (i < 0) throw new Error("usage: gen.ts --dsl <job.json>");
  const dsl = parseDsl(await Bun.file(process.argv[i + 1]!).json());
  const view = VIEW[dsl.aspect], pal = PAL[dsl.palette];
  const margin = Math.round(view.w * 0.09);
  const colW = view.w - 2 * margin;

  // --- split the clipboard into what the kind needs ---
  let body = dsl.text.trim(), attribution = "";
  if (dsl.kind === "quote") {
    const m = body.match(/^(.*?)\s*(?:——|—|--|-)\s*([^\n]{1,40})$/s);
    if (m) { body = m[1]!.trim(); attribution = m[2]!.trim(); }
    body = body.replace(/^[“"「]/, "").replace(/[”"」]$/, "");
  }
  let heroNum = "";
  if (dsl.kind === "stat") {
    const m = body.match(/[+-]?[\d][\d,.]*\s*[%万亿kKmMx倍]?/);
    if (m) { heroNum = m[0].trim(); body = body.replace(m[0], "").replace(/\s{2,}/g, " ").trim(); }
  }
  const explicitLines = dsl.kind === "code" || dsl.kind === "list";
  const bold = dsl.kind !== "code";
  const sizes = [...new Set([...(LADDER[dsl.scale]!), ...(heroNum ? HERO[dsl.scale]! : []), 28, 32])];
  const words = segments(body, "zh-CN");
  const texts = [body, attribution, heroNum, ...words, ...body.split("\n"), "“", "”", "·"].filter(Boolean);

  const m = await openMeasurer({
    face: { regular: `${ROOT}/assets/fonts/NotoSansSC-Regular.otf`, bold: `${ROOT}/assets/fonts/NotoSansSC-Bold.otf` },
    sizes: sizes.flatMap((s) => [{ px: s, bold: true }, { px: s, bold: false }]),
    texts, density: 1,
  });
  try {
    // --- fit the body ---
    let lines: string[], size: number;
    const maxH = Math.round(view.h * (heroNum ? 0.35 : 0.62));
    if (explicitLines) {
      const raw = body.split("\n").map((l) => (dsl.kind === "list" ? l.replace(/^\s*(?:[-*•·]|\d+[.、)])\s*/, "") : l));
      const ladder = LADDER[dsl.scale]!;
      size = ladder.find((s) => raw.every((l) => m.measure(s, bold)(l) <= colW) && raw.length * m.lineHeight(s, bold) * 1.35 <= maxH) ?? ladder[ladder.length - 1]!;
      lines = raw;
    } else {
      const fit = fitToBox(body, { maxWidth: colW, maxHeight: maxH },
        LADDER[dsl.scale]!.map((s) => ({ px: s, measure: m.measure(s, bold), lineHeight: m.lineHeight(s, bold) })), "zh-CN", "balanced");
      if (fit.overflows) throw new Error(`paste: text does not fit at any size in ladder ${dsl.scale}; cut it or drop scale`);
      lines = fit.lines; size = fit.px;
    }
    const lh = Math.round(m.lineHeight(size, bold) * (dsl.kind === "code" ? 1.5 : 1.3));

    // --- animation registry ---
    const keyframes: Record<string, any> = {};
    const animation: Record<string, { value: string }> = {};
    let n = 0;
    const rise = (delayMs: number) => {
      if (!dsl.animate || dsl.tone === 0) return "";
      keyframes.rise ??= { from: { translateY: `${AMP[dsl.tone]}px`, opacity: "0" }, to: { translateY: "0px", opacity: "1" } };
      const name = `r${n++}`;
      animation[name] = { value: `rise ${DUR[dsl.tone]}ms ${EASE[dsl.tone]} ${delayMs}ms both` };
      return ` animate-${name}`;
    };

    // --- emit lines; the emphasised word is its own run ---
    const emphWord = dsl.emphasis >= 0 ? words[dsl.emphasis] : undefined;
    const align = dsl.layout === "center" ? "items-center" : "items-start";
    const textCls = `text-[${size}px] ${bold ? "font-bold" : ""}`;
    const runs = (line: string, cls: string): string => {
      if (!emphWord || !line.includes(emphWord)) return `<Text class="${cls} text-[${pal.ink}]">{${jsx(line)}}</Text>`;
      const [a, ...rest] = line.split(emphWord);
      const b = rest.join(emphWord);
      return [a && `<Text class="${cls} text-[${pal.ink}]">{${jsx(a)}}</Text>`,
        `<Text debugName="emphasis" class="${cls} text-[${pal.accent}]">{${jsx(emphWord)}}</Text>`,
        b && `<Text class="${cls} text-[${pal.ink}]">{${jsx(b)}}</Text>`].filter(Boolean).join("");
    };
    const stagger = 110;
    const lineNodes = lines.map((l, li) => {
      const prefix = dsl.kind === "list" ? `<Text class="${textCls} text-[${pal.accent}]">{"·  "}</Text>` : "";
      return `        <View debugName="line-${li}" class="flex-row h-[${lh}px] items-center${rise(li * stagger)}">${prefix}${runs(l, textCls)}</View>`;
    });
    const parts: string[] = [];
    if (dsl.kind === "quote") parts.push(`        <Text debugName="quote-mark" class="text-[${Math.min(176, size * 2)}px] font-bold text-[${pal.accent}] h-[${Math.round(size * 1.2)}px]${rise(0)}">{"“"}</Text>`);
    if (heroNum) {
      const hs = HERO[dsl.scale]!.find((s) => m.measure(s, true)(heroNum) <= colW) ?? 120;
      parts.push(`        <Text debugName="hero" class="text-[${hs}px] font-bold text-[${pal.accent}] h-[${Math.round(m.lineHeight(hs, true))}px]${rise(0)}">{${jsx(heroNum)}}</Text>`);
    }
    parts.push(...lineNodes);
    if (attribution) parts.push(`        <View class="h-[${Math.round(lh * 0.6)}px]" /><Text debugName="attribution" class="text-[32px] text-[${pal.muted}]${rise(lines.length * stagger + 120)}">{${jsx("— " + attribution)}}</Text>`);

    const column = dsl.layout === "split"
      ? `      <View class="absolute left-[${px(margin)}] top-[${px(margin)}] w-[8px] h-[${px(view.h - 2 * margin)}] bg-[${pal.accent}] rounded-[4px]" />
      <View class="absolute left-[${px(margin + 56)}] top-0 w-[${px(colW - 56)}] h-[${px(view.h)}] flex-col justify-center ${align} gap-[6px]">
${parts.join("\n")}
      </View>`
      : `      <View class="absolute left-[${px(margin)}] top-0 w-[${px(colW)}] h-[${px(view.h)}] flex-col justify-center ${align} gap-[6px]">
${parts.join("\n")}
      </View>`;

    const bg = dsl.kind === "code" ? `bg-[${pal.bg2}]` : `bg-gradient-to-b from-[${pal.bg}] to-[${pal.bg2}]`;
    await Bun.write(`${DIR}main.tsx`, `// GENERATED by compositions/paste/gen.ts — do not edit by hand.
import { mount } from "@pocketjs/framework";
import { Text, View } from "@pocketjs/framework/components";

mount(() => (
  <View class="w-full h-full ${bg}">
    <View class="absolute left-0 top-0 w-[${view.w}px] h-[${view.h}px]">
${column}
    </View>
  </View>
));
`);
    await Bun.write(`${DIR}pocket.config.ts`, `// GENERATED by compositions/paste/gen.ts — do not edit by hand.
import { definePocketConfig } from "../../vendor/pocketjs/framework/src/config.ts";
export default definePocketConfig({ theme: { keyframes: ${JSON.stringify(keyframes)}, animation: ${JSON.stringify(animation)} } });
`);
    const frames = dsl.animate && dsl.tone > 0 ? Math.ceil((DUR[dsl.tone] + stagger * (lines.length + 1) + 700) / 1000 * 30) : 1;
    await Bun.write(`${DIR}pocket-motion.json`, JSON.stringify({
      motion: 1, durationFrames: frames, fps: 30, supersample: 1,
      fonts: { regular: "assets/fonts/NotoSansSC-Regular.otf", bold: "assets/fonts/NotoSansSC-Bold.otf" },
      assertions: emphWord ? [{ node: "emphasis", inPicture: [frames - 1, frames - 1] }] : [],
    }, null, 2) + "\n");
    await Bun.write(`${DIR}pocket.json`, JSON.stringify({
      $schema: "https://pocketjs.dev/schema/pocket-2.json", pocket: 2, id: "dev.pocket-stack.motion-paste", name: "pocketjs-motion-paste",
      title: "paste card", version: "0.0.0", engine: { capabilities: { requires: ["text.glyphs.baked"] } },
      app: { entry: "compositions/paste/main.tsx", output: "motion-paste", framework: "solid", viewport: { fixed: { logical: [view.w, view.h], presentation: "native" } } },
    }, null, 2) + "\n");
    console.log(`paste: ${dsl.kind}/${dsl.layout}/${dsl.palette}/${dsl.aspect} scale=${dsl.scale} tone=${dsl.tone} → ${lines.length} line(s) at ${size}px, ${frames} frame(s)`);
  } finally { await m.close(); }
}
await main();
