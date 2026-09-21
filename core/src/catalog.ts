/**
 * The catalog: every name Jev may choose, with a sentence for Jev and the
 * numbers for the composer. Questions are generated from it and the composer
 * only looks names up in it, so the two cannot drift.
 *
 * A style pack is a fragment of this catalog merged in at runtime
 * (`mergeCatalog`). The open-source core carries the base entries below; a
 * pack is just more of them, in the same shape.
 */
export interface Colors { readonly bg: string; readonly bg2: string; readonly ink: string; readonly muted: string; readonly accent: string }

export interface PaletteEntry { readonly description: string; readonly colors: Colors }
export interface KindEntry { readonly description: string }
export interface LayoutEntry { readonly description: string }

export interface Catalog {
  readonly kinds: Readonly<Record<string, KindEntry>>;
  readonly layouts: Readonly<Record<string, LayoutEntry>>;
  readonly palettes: Readonly<Record<string, PaletteEntry>>;
}

export const BASE_CATALOG: Catalog = {
  kinds: {
    quote: { description: "a quotation or aphorism, often with an attribution" },
    code: { description: "source code, a shell command or a log line" },
    stat: { description: "a sentence whose point is one number" },
    list: { description: "several items or numbered steps" },
    plain: { description: "ordinary prose that fits none of the above" },
  },
  layouts: {
    center: { description: "one short thought, centred" },
    left: { description: "a left-aligned stack, good for several lines" },
    split: { description: "an accent rule on the left and text beside it" },
  },
  palettes: {
    ink:   { description: "neutral dark, technical",        colors: { bg: "#0b0f14", bg2: "#11161d", ink: "#f2f4f7", muted: "#9aa4b2", accent: "#7dd3fc" } },
    paper: { description: "warm light, literary",           colors: { bg: "#f7f3ea", bg2: "#efe8da", ink: "#1c1a17", muted: "#6b6257", accent: "#b45309" } },
    cyan:  { description: "cool dark, business or data",    colors: { bg: "#041c2c", bg2: "#062f45", ink: "#ffffff", muted: "#9fd3e8", accent: "#22d3ee" } },
    amber: { description: "warm dark, emphatic",            colors: { bg: "#1a1206", bg2: "#2a1d08", ink: "#fde68a", muted: "#b8a06a", accent: "#f59e0b" } },
  },
};

/** A pack merged over a catalog: later entries win by name. */
export function mergeCatalog(base: Catalog, pack: Partial<Catalog>): Catalog {
  return {
    kinds: { ...base.kinds, ...(pack.kinds ?? {}) },
    layouts: { ...base.layouts, ...(pack.layouts ?? {}) },
    palettes: { ...base.palettes, ...(pack.palettes ?? {}) },
  };
}

/** `{name: description}` for a Jev choice question. */
export const criteriaOf = (entries: Readonly<Record<string, { readonly description: string }>>): Record<string, string> =>
  Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, v.description]));
