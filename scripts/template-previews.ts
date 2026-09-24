#!/usr/bin/env bun
/**
 * Renders one preview per template style for Settings › Templates with the
 * real template pipeline (no network), at 1:1 so the grid is even, then
 * shrinks them for bundling into native/Resources/TemplatePreviews/ as
 * `<template>-<variant>.png`. Rerun after a template's look changes.
 *
 *   bun scripts/template-previews.ts [--engine .work/native-engine] [--size 320] [--only code,table]
 *
 * The engine checkout is copied to a scratch directory first: its build tools
 * write vendor caches. Needs macOS `sips` for resizing.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decideTemplate } from "../core/src/templates/decide.ts";
import { TEMPLATE_REGISTRY } from "../core/src/templates/registry.ts";
import { renderTemplate } from "../core/src/templates/render.ts";
import type { TemplateId } from "../core/src/templates/types.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1]! : fallback; };
const REPO = resolve(import.meta.dir, "..");
const sourceEngine = resolve(flag("engine", join(REPO, ".work/native-engine")));
const size = Number(flag("size", "320"));
const only = argv.includes("--only") ? flag("only", "").split(",") : undefined;
const out = join(REPO, "native/Resources/TemplatePreviews");

/** Short samples that each template recognizes on its own. */
const PREVIEW_SAMPLES: Record<TemplateId, string> = {
  text: "Make room for a clearer thought.",
  document: "Release notes\n\nPeesuto now remembers the style you pick for each template.\n\nCopy anything and press a shortcut: the card is ready before you paste.",
  quote: "“Simplicity is the ultimate sophistication.”\n— Leonardo da Vinci",
  code: "func greet(_ name: String) -> String {\n    \"Hello, \\(name)!\"\n}\n\nprint(greet(\"Peesuto\"))",
  stat: "Weekly active users: 12,480",
  list: "- Copy the text\n- Press the shortcut\n- Paste the card",
  chat: "Lin: Can this chat become an image?\nAsh: Yes, copy it and press the shortcut.\nLin: Nice, that's all?",
  table: "| Plan | Price | Seats |\n|---|---|---|\n| Solo | $0 | 1 |\n| Team | $12 | 10 |",
  comparison: "Before:\nCopy, screenshot, crop, paste\nAfter:\nCopy, press a shortcut",
  diagram: "Copy → Decide → Render → Paste",
  info: "Staging account\nUser: admin\nPassword: P@ssw0rd!2026\nEmail: ops@example.com\nHost: https://staging.example.com",
  qr: "https://peesuto.com",
};

const scratch = join(tmpdir(), `peesuto-previews-${process.pid}`);
const engine = join(scratch, ".engine");
await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true });
await cp(sourceEngine, engine, { recursive: true });
await mkdir(out, { recursive: true });
try {
  for (const template of TEMPLATE_REGISTRY) {
    if (only && !only.includes(template.id)) continue;
    for (const variant of template.variants) {
      const name = `${template.id}-${variant.id}`;
      const decision = await decideTemplate(PREVIEW_SAMPLES[template.id], {
        aspect: "1:1", output: "image", decider: null, override: { id: template.id, variant: variant.id },
      });
      const full = join(scratch, `${name}.png`);
      await renderTemplate(decision.plan, {
        engine, work: join(scratch, ".tree"), emojiCache: join(scratch, ".emoji"), emojiBundle: join(REPO, ".work/emoji-all"),
        format: "png", out: full,
      });
      const target = join(out, `${name}.png`);
      const p = Bun.spawn(["sips", "-Z", String(size), full, "--out", target], { stdout: "ignore", stderr: "inherit" });
      if (await p.exited !== 0) throw new Error(`sips failed for ${name}`);
      console.log(`${name} → ${target}`);
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
