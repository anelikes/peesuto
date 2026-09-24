/** The texts the promo copies, and the card each one becomes. Neutral content;
 * the terminal and the release notes are about Pocket Motion, the engine the
 * cards are rendered with. */
import type { TemplateAspect, TemplateId, TemplateMotion, VariantId } from "../../core/src/templates/types.ts";

export interface Sample {
  readonly id: string;
  readonly text: string;
  readonly template: TemplateId;
  readonly variant: VariantId;
  readonly aspect: TemplateAspect;
  /** Engine renders to produce besides the glyph JSON (for the "many forms" scene and QA). */
  readonly renders?: readonly { readonly format: "png" | "gif" | "mp4"; readonly motion: TemplateMotion }[];
}

export const SAMPLES: readonly Sample[] = [
  {
    id: "hook", template: "code", variant: "classic", aspect: "1:1",
    text: "const clamp = (n, lo, hi) =>\n  Math.min(hi, Math.max(lo, n));\n\nexport function ease(t) {\n  t = clamp(t, 0, 1);\n  return t * t * (3 - 2 * t);\n}",
    renders: [{ format: "png", motion: "none" }],
  },
  {
    id: "terminal", template: "code", variant: "classic", aspect: "1:1",
    text: "$ cd pocket-motion\n$ bun run motion render \\\n    compositions/shutter\nwrote shutter.mp4 · 90 frames",
    renders: [{ format: "png", motion: "none" }],
  },
  {
    id: "chat", template: "chat", variant: "classic", aspect: "1:1",
    text: "Maya: Did the release build pass?\nTheo: All green. Shipping at five.\nMaya: Perfect, I'll write the notes.",
    renders: [{ format: "png", motion: "none" }],
  },
  {
    id: "table", template: "table", variant: "classic", aspect: "1:1",
    text: "| Task | Owner | Due |\n|---|---|---|\n| Review | Maya | Mon |\n| Beta build | Theo | Wed |\n| Launch | Ines | Fri |",
    renders: [{ format: "png", motion: "none" }],
  },
  {
    id: "info", template: "info", variant: "classic", aspect: "1:1",
    text: "Maya Chen\n+1 415 555 0132\nmaya@example.com\nhttps://example.com\n500 Market St, San Francisco",
    renders: [{ format: "png", motion: "none" }],
  },
  {
    id: "diagram", template: "diagram", variant: "classic", aspect: "1:1",
    text: "flowchart TD\n  A[Copy] --> B{Which card?}\n  B --> C([Code])\n  B --> D([Chat])\n  B --> E([Table])",
    renders: [{ format: "png", motion: "none" }],
  },
  {
    id: "changelog", template: "changelog", variant: "classic", aspect: "1:1",
    text: "# Pocket Motion\n## v0.2.1 — 2026-09-22\n### Fixed\n- Asset paths resolve from the project root\n## v0.2.0 — 2026-09-21\n### Added\n- First public release",
    renders: [{ format: "png", motion: "none" }],
  },
  {
    id: "forms", template: "text", variant: "poster", aspect: "1:1",
    text: "Make room for a clearer thought.",
    renders: [{ format: "png", motion: "none" }],
  },
  {
    id: "qr", template: "qr", variant: "classic", aspect: "1:1",
    text: "Make room for a clearer thought.",
    renders: [{ format: "png", motion: "none" }],
  },
];
