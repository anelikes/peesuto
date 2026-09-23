/** Native engine compositions for structured templates. Legacy DSL composition stays unchanged. */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ComposeError, normalizeText, unsupportedScript, type ComposeOptions, type ComposeResult } from "../render/compose.ts";
import { splitEmoji, stageEmoji, stripEmoji } from "../render/emoji.ts";
import type { TemplateMotion, TemplatePlan } from "./types.ts";

export const TEMPLATE_LIMITS = { maxHeight: 4096, maxGraphemes: 2400, fps: 30, typingMaxMs: 4200, holdMs: 1200 } as const;
const SIZES = [24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 80, 96, 112, 128, 144, 160] as const;
const VIEW = { chat: { width: 1080, height: 1080 }, doc: { width: 1920, height: 1080 }, social: { width: 1080, height: 1920 } };
export interface TemplateMeasure {
  width(text: string, size: number, bold: boolean): number;
  lineHeight(size: number, bold: boolean): number;
}
export interface TemplateLine {
  text: string; x: number; y: number; width: number; size: number; height: number; bold: boolean; color: string; group: number;
  /** Per-grapheme weight after Markdown markers are interpreted. */
  boldAt: boolean[];
}
export interface TemplateRect { x: number; y: number; width: number; height: number; color: string; radius: number }
export interface TemplateLayout {
  width: number; height: number; background: string; lines: TemplateLine[]; shapes: TemplateRect[];
}
export interface TemplateComposeResult extends ComposeResult {
  readonly width: number;
  readonly height: number;
  readonly template: string;
  readonly variant: string;
  readonly motion: TemplateMotion;
}
const graphemes = (text: string): string[] => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
interface StyledGlyph { text: string; bold: boolean }
function styledGlyphs(text: string, bold: boolean, markdown: boolean): StyledGlyph[] {
  const output: StyledGlyph[] = [];
  const append = (part: string, weight: boolean) => output.push(...graphemes(part).map((text) => ({ text, bold: weight })));
  if (!markdown) { append(text, bold); return output; }
  let cursor = 0;
  for (const match of text.matchAll(/\*\*([^*\n]+)\*\*/g)) {
    append(text.slice(cursor, match.index), bold); append(match[1]!, true); cursor = match.index! + match[0].length;
  }
  append(text.slice(cursor), bold);
  return output;
}
function styledWidth(glyphs: readonly StyledGlyph[], size: number, measure: TemplateMeasure): number {
  let width = 0, run = "", bold = glyphs[0]?.bold ?? false;
  for (const glyph of glyphs) {
    if (glyph.bold !== bold) { width += measure.width(run, size, bold); run = ""; bold = glyph.bold; }
    run += glyph.text;
  }
  return width + measure.width(run, size, bold);
}
function wrapStyled(glyphs: readonly StyledGlyph[], width: number, size: number, measure: TemplateMeasure): StyledGlyph[][] {
  const result: StyledGlyph[][] = [];
  let explicit: StyledGlyph[] = [];
  const flush = () => {
    if (!explicit.length) { result.push([]); return; }
    while (explicit.length) {
      let count = 0;
      while (count < explicit.length && styledWidth(explicit.slice(0, count + 1), size, measure) <= width + 0.01) count++;
      if (!count) throw new ComposeError("overflow", "A character cannot fit in this template column. Choose a wider aspect.");
      if (count < explicit.length) for (let i = count - 1; i > 0; i--) {
        if (/\s/u.test(explicit[i]!.text) && explicit.slice(0, i).some((g) => g.text.trim())) { count = i + 1; break; }
      }
      result.push(explicit.slice(0, count)); explicit = explicit.slice(count);
    }
  };
  for (const glyph of glyphs) { if (glyph.text === "\n") flush(); else explicit.push(glyph); }
  flush();
  return result;
}

/** Wrap all content without deleting words. A too-wide glyph is an explicit error. */
export function wrapTemplateText(text: string, width: number, size: number, bold: boolean, measure: TemplateMeasure): string[] {
  const output: string[] = [];
  for (const explicit of text.split("\n")) {
    if (!explicit) { output.push(""); continue; }
    let remaining = graphemes(explicit);
    while (remaining.length) {
      let count = 0;
      while (count < remaining.length && measure.width(remaining.slice(0, count + 1).join(""), size, bold) <= width + 0.01) count++;
      if (!count) throw new ComposeError("overflow", "A character cannot fit in this template column. Choose a wider aspect.");
      if (count < remaining.length) {
        // Prefer word boundaries for Latin, but preserve explicit indentation.
        let breakAt = count;
        for (let i = count - 1; i > 0; i--) {
          if (/\s/u.test(remaining[i]!) && remaining.slice(0, i).join("").trim()) { breakAt = i + 1; break; }
        }
        count = breakAt;
      }
      output.push(remaining.slice(0, count).join(""));
      remaining = remaining.slice(count);
    }
  }
  return output;
}

/** Pure layout: fonts supply real advances in production, a metric fixture in unit tests. */
export function layoutTemplate(plan: TemplatePlan, measure: TemplateMeasure): TemplateLayout {
  if (plan.template !== plan.content.kind) throw new ComposeError("catalog", "Template and structured content do not match.");
  if (!["classic", "editorial"].includes(plan.variant)) throw new ComposeError("catalog", "Unknown template variant.");
  const view = VIEW[plan.aspect];
  const editorial = plan.variant === "editorial";
  const W = view.width, margin = 88, inner = W - margin * 2;
  const layout: TemplateLayout = { width: W, height: view.height, background: "#f1eee7", lines: [], shapes: [] };
  let bottom = margin, group = 0;
  const rect = (x: number, y: number, width: number, height: number, color: string, radius = 0): TemplateRect => {
    const value = { x, y, width, height, color, radius }; layout.shapes.push(value); return value;
  };
  const block = (text: string, x: number, y: number, width: number, size = 40, bold = false, color = "#20272b", align: "left" | "center" = "left", groupID = group++, markdown = plan.template === "document", code = plan.template === "code"): number => {
    const normalized = normalizeText(text, code ? "code" : "plain");
    const lines = wrapStyled(styledGlyphs(normalized, bold, markdown), width, size, measure);
    const height = Math.ceil(measure.lineHeight(size, bold) * 1.30);
    for (const [index, line] of lines.entries()) {
      const advance = styledWidth(line, size, measure);
      layout.lines.push({ text: line.map((g) => g.text).join(""), x: x + (align === "center" ? (width - advance) / 2 : 0), y: y + index * height,
        width: advance, size, height, bold, color, group: groupID, boldAt: line.map((g) => g.bold) });
    }
    bottom = Math.max(bottom, y + lines.length * height);
    return lines.length * height;
  };
  const rule = (x: number, y: number, width: number, color = "#d9d4c9") => rect(x, y, width, 2, color);
  const content = plan.content;
  switch (content.kind) {
    case "document": {
      layout.background = editorial ? "#e9edf0" : "#ede9df";
      const paper = rect(margin - 24, margin - 24, inner + 48, 0, "#fffdf8", 8);
      let x = margin + 24, width = inner - 48, y = margin + 32;
      if (editorial) {
        rect(margin + 12, margin + 28, 9, 140, "#31584d");
        block("01", margin + 40, margin + 16, 150, 80, true, "#31584d");
        block("NOTES", margin + 40, margin + 132, 150, 24, true, "#697870");
        x = margin + 236; width = inner - 260;
      } else {
        block("NOTES", x, y, width, 24, true, "#687068");
        y += 62; rule(x, y, width); y += 40;
      }
      const blocks = content.blocks ?? content.paragraphs.map((text) => ({ kind: "paragraph" as const, text }));
      for (const [index, item] of blocks.entries()) {
        if (item.kind === "heading") {
          y += block(item.text, x, y, width, item.level === 1 ? 56 : item.level === 2 ? 48 : 40, true, "#253e35");
        } else if (item.kind === "code") {
          const h = block(item.code, x + 24, y + 24, width - 48, 28, false, "#dde8f1", "left", group++, false, true);
          rect(x, y, width, h + 48, "#243440", 8); y += h + 48;
        } else if (item.kind === "list") {
          for (const [i, entry] of item.items.entries()) {
            block(item.ordered ? `${i + 1}.` : "·", x + 4, y, 52, 36, true, "#447061");
            y += block(entry, x + 62, y, width - 62, 36) + 16;
          }
        } else y += block(item.text, x, y, width, editorial && index === 0 ? 56 : 40, editorial && index === 0);
        y += editorial ? 38 : 30;
      }
      paper.height = Math.max(view.height - margin * 2 + 48, y - paper.y + 20);
      bottom = Math.max(bottom, paper.y + paper.height - margin);
      break;
    }
    case "quote": {
      layout.background = editorial ? "#182c2b" : "#eee9de";
      const ink = editorial ? "#fcf5df" : "#302d27";
      let y = margin + (editorial ? 34 : 96);
      if (editorial) {
        block("“", margin, y - 34, 180, 160, true, "#badc9a");
        y += 170;
        y += block(content.text, margin + 12, y, inner - 24, 72, true, ink);
        y += 56; rect(margin + 12, y, 112, 8, "#badc9a"); y += 38;
      } else {
        rect(margin, margin, 8, Math.max(300, view.height - margin * 2), "#b7a789");
        block("“", margin + 40, margin - 8, 130, 128, false, "#a38962");
        y += block(content.text, margin + 64, y, inner - 100, 48, false, ink);
        y += 48;
      }
      if (content.author) y += block("— " + content.author, margin + (editorial ? 12 : 64), y, inner - 100, 28, false, editorial ? "#badc9a" : "#7a6d56");
      bottom = y;
      break;
    }
    case "code": {
      layout.background = editorial ? "#edf0eb" : "#121c28";
      const panel = rect(margin - 24, margin - 24, inner + 48, 0, editorial ? "#fffefa" : "#202d3d", 18);
      let y = margin + 32;
      if (!editorial) {
        ["#d47d79", "#d9b86f", "#80b19a"].forEach((color, i) => rect(margin + 12 + i * 30, y, 14, 14, color, 7));
        y += 55;
      } else {
        block(content.language || "CODE", margin + 20, y, inner - 40, 28, true, "#447061");
        y += 62; rule(margin + 20, y, inner - 40); y += 28;
      }
      const sourceLines = normalizeText(content.code, "code").split("\n");
      for (const [index, line] of sourceLines.entries()) {
        const start = y;
        if (editorial) block(String(index + 1).padStart(2, "0"), margin + 16, y, 70, 28, false, "#8b9890");
        y += block(line, margin + (editorial ? 112 : 24), y, inner - (editorial ? 144 : 48), 32, false, editorial ? "#253e35" : "#dce7f1");
        if (editorial && index % 2 === 0) rect(margin + 100, start, inner - 120, y - start, "#f0f3ed", 4);
        y += 8;
      }
      panel.height = Math.max(260, y - panel.y + 34);
      bottom = panel.y + panel.height;
      break;
    }
    case "stat": {
      layout.background = editorial ? "#e7edeb" : "#f4f0e4";
      if (editorial) {
        const valueWidth = Math.round(inner * 0.42);
        const panel = rect(margin - 12, margin + 72, valueWidth + 36, 0, "#264e44", 12);
        const vh = block(content.value, margin + 12, margin + 110, valueWidth - 12, 128, true, "#d9edb5");
        const lh = block(content.label, margin + valueWidth + 64, margin + 114, inner - valueWidth - 64, 44, false, "#29453c");
        panel.height = Math.max(360, vh + 100, lh + 100);
        bottom = panel.y + panel.height;
      } else {
        let size = 160;
        for (const candidate of [160, 144, 128, 112, 96, 80]) { size = candidate; if (measure.width(content.value, size, true) <= inner) break; }
        let y = margin + 130;
        y += block(content.value, margin, y, inner, size, true, "#285b49", "center");
        y += 50; rect(W / 2 - 48, y, 96, 6, "#c4a66a"); y += 52;
        y += block(content.label, margin + 72, y, inner - 144, 44, false, "#4b5145", "center");
        bottom = y;
      }
      break;
    }
    case "list": {
      layout.background = editorial ? "#e9eef1" : "#faf7ef";
      let y = margin + 24;
      for (const [index, item] of content.items.entries()) {
        if (editorial) {
          const h = block(item, margin + 144, y + 30, inner - 184, 40, index === 0, "#243840");
          rect(margin, y, inner, h + 60, "#ffffff", 14);
          block(String(index + 1).padStart(2, "0"), margin + 28, y + 22, 94, 56, true, "#4c7980");
          y += h + 84;
        } else {
          if (content.ordered) block(String(index + 1) + ".", margin + 4, y + 4, 80, 40, true, "#aa7f4b");
          else { rect(margin + 4, y + 14, 26, 26, "#ad9470", 5); rect(margin + 9, y + 19, 16, 16, "#faf7ef", 2); }
          y += block(item, margin + 88, y, inner - 100, 44);
          y += 24; rule(margin + 88, y, inner - 100); y += 30;
        }
      }
      bottom = y;
      break;
    }
    case "chat": {
      layout.background = editorial ? "#fbf7ef" : "#e9eff0";
      let y = margin;
      const speakers = [...new Set(content.turns.map((turn) => turn.speaker))];
      for (const turn of content.turns) {
        if (editorial) {
          const speakerHeight = block(turn.speaker, margin, y + 20, 200, 28, true, "#547b70");
          const textHeight = block(turn.text, margin + 242, y + 18, inner - 242, 40);
          rule(margin, y, inner, "#b9c6ba");
          y += Math.max(speakerHeight, textHeight) + 60;
        } else {
          const right = speakers.indexOf(turn.speaker) % 2 === 1;
          const bubbleW = Math.round(inner * 0.83), x = right ? W - margin - bubbleW : margin;
          const bubble = rect(x, y, bubbleW, 0, right ? "#244c44" : "#ffffff", 26);
          let top = y + 24;
          top += block(turn.speaker, x + 28, top, bubbleW - 56, 24, true, right ? "#b3d4c4" : "#6c837e");
          top += 12;
          top += block(turn.text, x + 28, top, bubbleW - 56, 40, false, right ? "#ffffff" : "#263c3a");
          bubble.height = top - y + 26; y = top + 48;
        }
      }
      bottom = y;
      break;
    }
    case "table": {
      if (!content.headers.length || content.headers.length > 6 || content.rows.some((row) => row.length !== content.headers.length)) {
        throw new ComposeError("overflow", "A table needs 1–6 columns and the same number of cells in every row.");
      }
      layout.background = editorial ? "#f2ede2" : "#e8eff0";
      let y = margin;
      if (editorial) {
        for (const [rowIndex, row] of content.rows.entries()) {
          block(String(rowIndex + 1).padStart(2, "0"), margin, y + 8, 100, 48, true, "#ad8260");
          let rowY = y + 10;
          for (const [index, cell] of row.entries()) {
            const hh = block(content.headers[index]!, margin + 130, rowY, Math.round(inner * 0.28), 28, true, "#7a705f");
            const vh = block(cell, margin + Math.round(inner * 0.43), rowY, Math.round(inner * 0.57), 36);
            rowY += Math.max(hh, vh) + 22;
          }
          y = rowY + 12; rule(margin, y, inner, "#c5bda9"); y += 36;
        }
      } else {
        const col = inner / content.headers.length;
        for (const [rowIndex, row] of [content.headers, ...content.rows].entries()) {
          let rowHeight = 0;
          const rowY = y;
          for (const [index, cell] of row.entries()) rowHeight = Math.max(rowHeight,
            block(cell, margin + index * col + 20, y + 24, col - 40, rowIndex === 0 ? 32 : 28, rowIndex === 0, rowIndex === 0 ? "#ffffff" : "#263c3b"));
          rowHeight += 48;
          rect(margin, y, inner, rowHeight, rowIndex === 0 ? "#315c59" : rowIndex % 2 ? "#ffffff" : "#f3f7f5");
          for (let i = 1; i < content.headers.length; i++) rect(margin + i * col, rowY, 1, rowHeight, "#d5dfda");
          y += rowHeight;
        }
      }
      bottom = y;
      break;
    }
    case "comparison": {
      if (content.columns.length !== 2) throw new ComposeError("catalog", "Comparison templates require exactly two columns.");
      layout.background = editorial ? "#f5f1e8" : "#e9eef0";
      let y = margin;
      const width = editorial ? inner : (inner - 32) / 2;
      const heights: number[] = [];
      for (const [index, column] of content.columns.entries()) {
        const x = editorial ? margin : margin + index * (width + 32);
        const top = editorial ? y : margin;
        const panel = rect(x, top, width, 0, index === 0 ? "#ffffff" : "#244c44", 16);
        const color = index === 0 ? "#253e35" : "#f0f7e9";
        let cy = top + 32;
        if (editorial) {
          const titleH = block(column.title, x + 28, cy, 220, 44, true, color);
          let bodyY = cy;
          for (const item of column.items) { bodyY += block(item, x + 300, bodyY, width - 332, 36, false, color) + 24; }
          cy += Math.max(titleH, bodyY - cy);
        } else {
          cy += block(column.title, x + 30, cy, width - 60, 44, true, color) + 32;
          for (const item of column.items) { cy += block(item, x + 30, cy, width - 60, 36, false, color) + 30; }
        }
        panel.height = Math.max(230, cy - top + 20); heights.push(panel.height);
        if (editorial) y = top + panel.height + 28;
      }
      if (!editorial) {
        const maxH = Math.max(...heights);
        // The two panels align at the bottom while retaining independent text.
        layout.shapes.slice(-2).forEach((shape) => { shape.height = maxH; });
        bottom = margin + maxH;
      } else bottom = y;
      break;
    }
  }
  const count = layout.lines.reduce((total, line) => total + graphemes(line.text).length, 0);
  if (!count || !plan.sourceText.trim()) throw new ComposeError("empty", "There is no text to render.");
  if (count > TEMPLATE_LIMITS.maxGraphemes) throw new ComposeError("overflow", `This template contains ${count} characters; the supported maximum is ${TEMPLATE_LIMITS.maxGraphemes}. Split the source into smaller cards. No content was truncated.`);
  layout.height = Math.ceil(Math.max(view.height, bottom + margin) / 2) * 2;
  if (layout.height > TEMPLATE_LIMITS.maxHeight) throw new ComposeError("overflow", `The complete content needs ${layout.height}px of height (maximum ${TEMPLATE_LIMITS.maxHeight}px). Choose a wider aspect or split the source. No content was truncated.`);
  return layout;
}

export interface TemplateTiming { frames: number; revealMs: number; holdMs: number; delay(index: number, total: number): number }
export function templateTiming(motion: TemplateMotion, count: number): TemplateTiming {
  if (motion === "none") return { frames: 1, revealMs: 0, holdMs: 0, delay: () => 0 };
  const revealMs = motion === "typewriter" ? Math.min(TEMPLATE_LIMITS.typingMaxMs, Math.max(700, count * 35)) : 1400;
  return { frames: Math.ceil((revealMs + TEMPLATE_LIMITS.holdMs + 250) / 1000 * TEMPLATE_LIMITS.fps) + 1,
    revealMs, holdMs: TEMPLATE_LIMITS.holdMs,
    delay: (index, total) => Math.round(index / Math.max(1, total - 1) * revealMs) };
}

interface EngineMeasurer {
  measure(size: number, bold?: boolean): (text: string) => number;
  lineHeight(size: number, bold?: boolean): number;
  unmapped(text: string, size: number, bold?: boolean): string[];
  close(): Promise<void>;
}

export async function composeTemplate(plan: TemplatePlan, options: ComposeOptions): Promise<TemplateComposeResult> {
  const script = unsupportedScript(plan.sourceText);
  if (script) throw new ComposeError("unsupported-script", `The card font does not support ${script}; no content was rendered or truncated.`);
  const work = resolve(options.work), dir = `${work}/compositions/paste`;
  await mkdir(dir, { recursive: true });
  const api = await import(`${options.engine}/src/text/measure.ts`) as { openMeasurer(options: unknown): Promise<EngineMeasurer> };
  const serialized = JSON.stringify(plan.content);
  const texts = [stripEmoji(serialized), "NOTES CODE 0123456789.—“·"];
  const m = await api.openMeasurer({
    face: { regular: `${options.engine}/assets/fonts/NotoSansSC-Regular.otf`, bold: `${options.engine}/assets/fonts/NotoSansSC-Bold.otf` },
    sizes: SIZES.flatMap((px) => [{ px, bold: false }, { px, bold: true }]), texts, density: 1,
    cache: { charset: await Bun.file(new URL("../render/charset.txt", import.meta.url)).text(), dir: `${work}/dist/.measure` },
  });
  try {
    for (const text of texts) {
      const missing = m.unmapped(text, 40, false);
      if (missing.length) throw new ComposeError("unsupported-script", `The font cannot draw ${missing.slice(0, 8).join(", ")}. No content was truncated.`);
    }
    const metrics: TemplateMeasure = {
      width: (text, size, bold) => splitEmoji(text).reduce((width, run) => width + ("emoji" in run ? size : m.measure(size, bold)(run.text)), 0),
      lineHeight: (size, bold) => m.lineHeight(size, bold),
    };
    const layout = layoutTemplate(plan, metrics);
    const count = layout.lines.reduce((total, line) => total + graphemes(line.text).length, 0);
    const timing = templateTiming(plan.motion, count);
    const groups = Math.max(1, ...layout.lines.map((line) => line.group + 1));
    const animations: Record<string, { value: string }> = {};
    const keyframes: Record<string, unknown> = {};
    const emojiKeys = new Set<string>();
    const nodes: string[] = [];
    let glyphIndex = 0;
    for (const shape of layout.shapes) nodes.push(`<View class="absolute left-[${shape.x}px] top-[${shape.y}px] w-[${shape.width}px] h-[${shape.height}px] bg-[${shape.color}] rounded-[${shape.radius}px]" />`);
    for (const line of layout.lines) {
      const prefix: StyledGlyph[] = [];
      for (const [glyphPosition, glyph] of graphemes(line.text).entries()) {
        const bold = line.boldAt[glyphPosition] ?? line.bold;
        const x = line.x + styledWidth(prefix, line.size, metrics);
        prefix.push({ text: glyph, bold });
        const index = glyphIndex++;
        if (!glyph.trim()) continue;
        let animation = "";
        if (plan.motion !== "none") {
          const name = `t${index}`;
          const typewriter = plan.motion === "typewriter";
          keyframes[typewriter ? "appear" : "reveal"] ??= typewriter
            ? { from: { opacity: "0" }, to: { opacity: "1" } }
            : { from: { opacity: "0", translateY: "10px" }, to: { opacity: "1", translateY: "0px" } };
          animations[name] = { value: `${typewriter ? "appear 1ms linear" : "reveal 240ms ease-out"} ${timing.delay(typewriter ? index : line.group, typewriter ? count : groups)}ms both` };
          animation = ` animate-${name}`;
        }
        const emoji = splitEmoji(glyph).find((run) => "emoji" in run);
        if (emoji && "emoji" in emoji) {
          emojiKeys.add(emoji.key);
          nodes.push(`<Image class="absolute left-[${x}px] top-[${line.y + (line.height - line.size) / 2}px] w-[${line.size}px] h-[${line.size}px]${animation}" src="e_${emoji.key}.png" />`);
        } else {
          nodes.push(`<Text class="absolute left-[${x}px] top-[${line.y}px] text-[${line.size}px] ${bold ? "font-bold" : ""} text-[${line.color}] h-[${line.height}px]${animation}">{${JSON.stringify(glyph)}}</Text>`);
        }
      }
    }
    const emoji = await stageEmoji(emojiKeys, options.emojiCache, dir, options.emojiBundle);
    await Bun.write(`${dir}/images.json`, JSON.stringify(Object.fromEntries(emoji.map((file) => [file, { linear: true }]))) + "\n");
    await Bun.write(`${dir}/main.tsx`, `// GENERATED template ${plan.template}/${plan.variant}; text positions are fixed across frames.\nimport { mount } from "@pocketjs/framework";\nimport { View, Text${emoji.length ? ", Image" : ""} } from "@pocketjs/framework/components";\nmount(() => (<View class="w-full h-full bg-[${layout.background}]">\n${nodes.join("\n")}\n</View>));\n`);
    await Bun.write(`${dir}/pocket.config.ts`, `import { definePocketConfig } from "../../vendor/pocketjs/framework/src/config.ts";\nexport default definePocketConfig({theme:{keyframes:${JSON.stringify(keyframes)},animation:${JSON.stringify(animations)}}});\n`);
    await Bun.write(`${dir}/pocket-motion.json`, JSON.stringify({ motion: 1, durationFrames: timing.frames, fps: TEMPLATE_LIMITS.fps, supersample: 1,
      fonts: { regular: "assets/fonts/NotoSansSC-Regular.otf", bold: "assets/fonts/NotoSansSC-Bold.otf" } }, null, 2));
    await Bun.write(`${dir}/pocket.json`, JSON.stringify({ $schema: "https://pocketjs.dev/schema/pocket-2.json", pocket: 2,
      id: "dev.pocket-stack.motion-paste", name: "pocketjs-motion-paste", title: `${plan.template} ${plan.variant}`, version: "0.0.0",
      engine: { capabilities: { requires: ["text.glyphs.baked"] } },
      app: { entry: "compositions/paste/main.tsx", output: "motion-paste", framework: "solid", viewport: { fixed: { logical: [layout.width, layout.height], presentation: "native" } } } }, null, 2));
    await Bun.write(`${dir}/template-layout.json`, JSON.stringify({ template: plan.template, variant: plan.variant, width: layout.width, height: layout.height,
      lines: layout.lines.map(({ text: _text, ...geometry }) => geometry), timing: { frames: timing.frames, revealMs: timing.revealMs, holdMs: timing.holdMs } }, null, 2));
    return { dir, lines: layout.lines.length, size: Math.max(...layout.lines.map((line) => line.size)), frames: timing.frames,
      emoji: emoji.length, truncated: false, width: layout.width, height: layout.height, template: plan.template, variant: plan.variant, motion: plan.motion };
  } finally { await m.close(); }
}
