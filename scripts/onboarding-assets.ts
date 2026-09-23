#!/usr/bin/env bun
/**
 * Renders the sample cards shown on the native onboarding's welcome step with
 * the real template pipeline (local rules decision, no network), then shrinks
 * them for bundling into native/Resources/Onboarding/.
 *
 *   bun scripts/onboarding-assets.ts [--engine .work/native-engine] [--size 360]
 *
 * The engine checkout is copied to a scratch directory first: its build tools
 * write vendor caches. Needs macOS `sips` for resizing.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decideTemplate } from "../core/src/templates/decide.ts";
import { renderTemplate } from "../core/src/templates/render.ts";
import type { TemplateId, VariantId } from "../core/src/templates/types.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1]! : fallback; };
const REPO = resolve(import.meta.dir, "..");
const sourceEngine = resolve(flag("engine", join(REPO, ".work/native-engine")));
const size = Number(flag("size", "360"));
const out = join(REPO, "native/Resources/Onboarding");

interface Sample { file: string; text: string; template: TemplateId; variant?: VariantId }
const SAMPLES: Sample[] = [
  { file: "sample-text", template: "text", variant: "poster" as VariantId, text: "Make room for a clearer thought." },
  { file: "sample-chat", template: "chat", text: "小林：这段对话可以直接变成图片吗？\n阿澈：可以，复制后按一下快捷键。\n小林：那就把时间留给表达。" },
  { file: "sample-code", template: "code", text: "func greet(_ name: String) -> String {\n    \"Hello, \\(name)!\"\n}\n\nprint(greet(\"Peesuto\"))" },
  { file: "sample-qr", template: "qr", text: "https://peesuto.com" },
];

const scratch = join(tmpdir(), `peesuto-onboarding-${process.pid}`);
const engine = join(scratch, ".engine");
await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true });
await cp(sourceEngine, engine, { recursive: true });
await mkdir(out, { recursive: true });
try {
  for (const sample of SAMPLES) {
    const decision = await decideTemplate(sample.text, {
      aspect: "1:1", output: "image", decider: null,
      override: { id: sample.template, ...(sample.variant ? { variant: sample.variant } : {}) },
    });
    const full = join(scratch, `${sample.file}.png`);
    const r = await renderTemplate(decision.plan, {
      engine, work: join(scratch, ".tree"), emojiCache: join(scratch, ".emoji"), emojiBundle: join(REPO, ".work/emoji-all"),
      format: "png", out: full,
    });
    const target = join(out, `${sample.file}.png`);
    const p = Bun.spawn(["sips", "-Z", String(size), full, "--out", target], { stdout: "ignore", stderr: "inherit" });
    if (await p.exited !== 0) throw new Error(`sips failed for ${sample.file}`);
    console.log(`${sample.file}: ${decision.plan.template}/${decision.plan.variant} ${r.width}×${r.height} → ${target}`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
