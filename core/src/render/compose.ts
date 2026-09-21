/**
 * compose — a clipboard card from an all-enumerated DSL.
 *
 * Writes a Pocket Motion composition (`main.tsx`, `pocket.config.ts`,
 * `pocket-motion.json`, `pocket.json`, `images.json`, staged emoji) into a
 * directory inside the work tree. Line breaks and sizes are measured against
 * the engine's own atlases, never guessed. The engine's text modules are
 * imported from the engine checkout at run time, so this file has no
 * compile-time dependency on where the engine is.
 */
import { resolve } from "node:path";
import { BASE_CATALOG, type Catalog } from "../catalog.ts";
import type { Dsl, Aspect } from "../dsl.ts";
import { splitEmoji, stageEmoji, stripEmoji } from "./emoji.ts";

/* ---- the engine surface this composer uses ------------------------------- */
type Measure = (s: string) => number;
interface FitApi {
  segments(text: string, locale?: string): string[];
  fitToBox(
    text: string, box: { maxWidth: number; maxHeight: number },
    candidates: readonly { px: number; measure: Measure; lineHeight: number }[],
    locale: string, strategy: "greedy" | "balanced",
  ): { lines: string[]; px: number; overflows: boolean };
}
interface Measurer {
  measure(px: number, bold?: boolean): Measure;
  lineHeight(px: number, bold?: boolean): number;
  close(): Promise<void>;
}
interface MeasureApi {
  openMeasurer(o: {
    face: { regular: string; bold: string };
    sizes: readonly { px: number; bold?: boolean }[];
    texts: readonly string[];
    density?: number;
    cache?: { charset: string; dir?: string };
  }): Promise<Measurer>;
}

export interface ComposeOptions {
  /** Engine checkout root: fonts and text modules are read from here. */
  readonly engine: string;
  /** Work tree root: the composition lives under `<work>/compositions/paste`. */
  readonly work: string;
  /** Where fetched emoji PNGs are cached across pastes. */
  readonly emojiCache: string;
  /** A bundled Noto Emoji set (`emoji_u<key>.png`), consulted before the cache. */
  readonly emojiBundle?: string;
  readonly catalog?: Catalog;
}

export interface ComposeResult {
  readonly dir: string;
  readonly lines: number;
  readonly size: number;
  readonly frames: number;
  readonly emoji: number;
}

export class ComposeError extends Error {}

const VIEW: Record<Aspect, { w: number; h: number }> = { chat: { w: 1080, h: 1080 }, doc: { w: 1920, h: 1080 }, social: { w: 1080, h: 1920 } };
/** Noto Sans SC bakes up to 176 px (engine AGENTS.md); ladders stay under it. */
const LADDER: Record<number, readonly number[]> = { 0: [40, 36, 32], 1: [56, 48, 42, 36], 2: [80, 72, 64, 56, 48], 3: [120, 104, 96, 84, 72, 60] };
const HERO: Record<number, readonly number[]> = { 0: [120, 104], 1: [144, 128, 112], 2: [160, 144, 128], 3: [176, 160, 144, 128] };
const AMP = [0, 24, 56, 110] as const;   // translateY px by tone
const DUR = [0, 360, 480, 620] as const; // ms by tone
const EASE = ["linear", "cubic-bezier(0.33,1,0.68,1)", "cubic-bezier(0.16,1,0.3,1)", "cubic-bezier(0.34,1.56,0.64,1)"] as const;
const FPS = 30;
const STAGGER_MS = 110;

const jsx = (s: string) => JSON.stringify(s);
const px = (v: number) => `${Math.round(v)}px`;

let charsetCache: string | undefined;
async function charset(): Promise<string> {
  charsetCache ??= await Bun.file(new URL("./charset.txt", import.meta.url).pathname).text();
  return charsetCache;
}

export async function composeCard(dsl: Dsl, o: ComposeOptions): Promise<ComposeResult> {
  const fitApi = (await import(`${o.engine}/src/text/fit.ts`)) as FitApi;
  const measureApi = (await import(`${o.engine}/src/text/measure.ts`)) as MeasureApi;
  const catalog = o.catalog ?? BASE_CATALOG;
  // Absolute: the engine's measurement build runs with the engine as cwd, so
  // a relative work tree would be resolved against the wrong root.
  const work = resolve(o.work);
  const dir = `${work}/compositions/paste`;
  const DIR = `${dir}/`;
  const view = VIEW[dsl.aspect];
  const palEntry = catalog.palettes[dsl.palette];
  if (!palEntry) throw new ComposeError(`palette ${dsl.palette} is not in the catalog`);
  const pal = palEntry.colors;
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
  const words = fitApi.segments(body, "zh-CN");
  // Emoji are pictures, not glyphs: they never reach the atlas or the
  // measurer, and they measure as one advance of the font size (below).
  const texts = [body, attribution, heroNum, ...words, ...body.split("\n"), "“", "”", "·"]
    .map(stripEmoji)
    .filter(Boolean);

  // `charset.txt`: ASCII, CJK punctuation and the 3755 level-1 GB2312
  // characters. With it the measurement is a cached metrics-only bake booted
  // per paste instead of a build per paste; a clipboard with a character
  // outside it falls back to the build.
  const m = await measureApi.openMeasurer({
    face: { regular: `${o.engine}/assets/fonts/NotoSansSC-Regular.otf`, bold: `${o.engine}/assets/fonts/NotoSansSC-Bold.otf` },
    sizes: sizes.flatMap((s) => [{ px: s, bold: true }, { px: s, bold: false }]),
    texts, density: 1,
    cache: { charset: await charset(), dir: `${work}/dist/.measure` },
  });
  try {
    /** A width function that measures text runs with the atlas and emoji as `px` each. */
    const measureWith = (px: number, isBold: boolean) => {
      const base = m.measure(px, isBold);
      return (s: string): number =>
        splitEmoji(s).reduce((w, r) => w + ("text" in r ? (r.text ? base(r.text) : 0) : px), 0);
    };
    // --- fit the body ---
    let lines: string[], size: number;
    const maxH = Math.round(view.h * (heroNum ? 0.35 : 0.62));
    if (explicitLines) {
      const raw = body.split("\n").map((l) => (dsl.kind === "list" ? l.replace(/^\s*(?:[-*•·]|\d+[.、)])\s*/, "") : l));
      const ladder = LADDER[dsl.scale]!;
      size = ladder.find((s) => raw.every((l) => measureWith(s, bold)(l) <= colW) && raw.length * m.lineHeight(s, bold) * 1.35 <= maxH) ?? ladder[ladder.length - 1]!;
      lines = raw;
    } else {
      const fit = fitApi.fitToBox(body, { maxWidth: colW, maxHeight: maxH },
        LADDER[dsl.scale]!.map((s) => ({ px: s, measure: measureWith(s, bold), lineHeight: m.lineHeight(s, bold) })), "zh-CN", "balanced");
      if (fit.overflows) throw new ComposeError(`text does not fit at any size in ladder ${dsl.scale}; cut it or drop scale`);
      lines = fit.lines; size = fit.px;
    }
    const lh = Math.round(m.lineHeight(size, bold) * (dsl.kind === "code" ? 1.5 : 1.3));

    // --- animation registry ---
    const keyframes: Record<string, unknown> = {};
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
    const emojiKeys = new Set<string>();
    /** Text runs as `Text`, emoji runs as square `Image`s at the font size. */
    const plainRuns = (s: string, cls: string, color: string, name?: string): string =>
      splitEmoji(s).map((r) => {
        if ("emoji" in r) {
          emojiKeys.add(r.key);
          return `<Image class="w-[${size}px] h-[${size}px]" src="e_${r.key}.png" />`;
        }
        return r.text ? `<Text${name ? ` debugName="${name}"` : ""} class="${cls} text-[${color}]">{${jsx(r.text)}}</Text>` : "";
      }).join("");
    const runs = (line: string, cls: string): string => {
      if (!emphWord || !line.includes(emphWord)) return plainRuns(line, cls, pal.ink);
      const [a, ...rest] = line.split(emphWord);
      const b = rest.join(emphWord);
      return plainRuns(a ?? "", cls, pal.ink) + plainRuns(emphWord, cls, pal.accent, "emphasis") + plainRuns(b, cls, pal.ink);
    };
    const lineNodes = lines.map((l, li) => {
      const prefix = dsl.kind === "list" ? `<Text class="${textCls} text-[${pal.accent}]">{"·  "}</Text>` : "";
      return `        <View debugName="line-${li}" class="flex-row h-[${lh}px] items-center${rise(li * STAGGER_MS)}">${prefix}${runs(l, textCls)}</View>`;
    });
    const parts: string[] = [];
    if (dsl.kind === "quote") parts.push(`        <Text debugName="quote-mark" class="text-[${Math.min(176, size * 2)}px] font-bold text-[${pal.accent}] h-[${Math.round(size * 1.2)}px]${rise(0)}">{"“"}</Text>`);
    if (heroNum) {
      const hs = HERO[dsl.scale]!.find((s) => m.measure(s, true)(heroNum) <= colW) ?? 120;
      parts.push(`        <Text debugName="hero" class="text-[${hs}px] font-bold text-[${pal.accent}] h-[${Math.round(m.lineHeight(hs, true))}px]${rise(0)}">{${jsx(heroNum)}}</Text>`);
    }
    parts.push(...lineNodes);
    if (attribution) parts.push(`        <View class="h-[${Math.round(lh * 0.6)}px]" /><View debugName="attribution" class="flex-row items-center${rise(lines.length * STAGGER_MS + 120)}">${plainRuns("— " + attribution, "text-[32px]", pal.muted)}</View>`);

    // --- emoji pictures beside the composition, declared linear for the downscale ---
    const emojiFiles = await stageEmoji(emojiKeys, o.emojiCache, dir, o.emojiBundle);
    await Bun.write(`${DIR}images.json`, JSON.stringify(Object.fromEntries(emojiFiles.map((f) => [f, { linear: true }])), null, 2) + "\n");

    const column = dsl.layout === "split"
      ? `      <View class="absolute left-[${px(margin)}] top-[${px(margin)}] w-[8px] h-[${px(view.h - 2 * margin)}] bg-[${pal.accent}] rounded-[4px]" />
      <View class="absolute left-[${px(margin + 56)}] top-0 w-[${px(colW - 56)}] h-[${px(view.h)}] flex-col justify-center ${align} gap-[6px]">
${parts.join("\n")}
      </View>`
      : `      <View class="absolute left-[${px(margin)}] top-0 w-[${px(colW)}] h-[${px(view.h)}] flex-col justify-center ${align} gap-[6px]">
${parts.join("\n")}
      </View>`;

    const bg = dsl.kind === "code" ? `bg-[${pal.bg2}]` : `bg-gradient-to-b from-[${pal.bg}] to-[${pal.bg2}]`;
    await Bun.write(`${DIR}main.tsx`, `// GENERATED by pocket-paste core/src/render/compose.ts — do not edit by hand.
import { mount } from "@pocketjs/framework";
import { ${emojiFiles.length > 0 ? "Image, " : ""}Text, View } from "@pocketjs/framework/components";

mount(() => (
  <View class="w-full h-full ${bg}">
    <View class="absolute left-0 top-0 w-[${view.w}px] h-[${view.h}px]">
${column}
    </View>
  </View>
));
`);
    await Bun.write(`${DIR}pocket.config.ts`, `// GENERATED by pocket-paste core/src/render/compose.ts — do not edit by hand.
import { definePocketConfig } from "../../vendor/pocketjs/framework/src/config.ts";
export default definePocketConfig({ theme: { keyframes: ${JSON.stringify(keyframes)}, animation: ${JSON.stringify(animation)} } });
`);
    const frames = dsl.animate && dsl.tone > 0 ? Math.ceil((DUR[dsl.tone] + STAGGER_MS * (lines.length + 1) + 700) / 1000 * FPS) : 1;
    await Bun.write(`${DIR}pocket-motion.json`, JSON.stringify({
      motion: 1, durationFrames: frames, fps: FPS, supersample: 1,
      fonts: { regular: "assets/fonts/NotoSansSC-Regular.otf", bold: "assets/fonts/NotoSansSC-Bold.otf" },
      assertions: emphWord ? [{ node: "emphasis", inPicture: [frames - 1, frames - 1] }] : [],
    }, null, 2) + "\n");
    await Bun.write(`${DIR}pocket.json`, JSON.stringify({
      $schema: "https://pocketjs.dev/schema/pocket-2.json", pocket: 2, id: "dev.pocket-stack.motion-paste", name: "pocketjs-motion-paste",
      title: "paste card", version: "0.0.0", engine: { capabilities: { requires: ["text.glyphs.baked"] } },
      app: { entry: "compositions/paste/main.tsx", output: "motion-paste", framework: "solid", viewport: { fixed: { logical: [view.w, view.h], presentation: "native" } } },
    }, null, 2) + "\n");
    return { dir, lines: lines.length, size, frames, emoji: emojiFiles.length };
  } finally { await m.close(); }
}
