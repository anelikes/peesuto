/**
 * Gradients that stay colourful in the middle. A straight line between two
 * colours in RGB passes through grey (navy to yellow is muddy at the
 * midpoint); walking the hue circle keeps every step saturated. The engine
 * only draws two-stop linear gradients, so a hue arc is sampled in OKLCH
 * (perceptually even steps) and drawn as adjacent two-stop segments: each
 * segment spans nearby colours, so its RGB midpoint is still on the arc.
 */

export interface Oklch { readonly l: number; readonly c: number; readonly h: number }

/** A hue arc: from one OKLCH colour to another, hue moving by `turn` degrees (sign = direction). */
export interface HueArc { readonly from: Oklch; readonly to: Oklch; readonly turn: number }

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/** OKLCH → linear sRGB (may be out of gamut). */
function linearRgb({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180), b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (rgb: readonly number[]) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** The colour as #rrggbb, chroma reduced (hue and lightness kept) until it fits sRGB. */
export function oklchHex(color: Oklch): string {
  let rgb = linearRgb(color);
  if (!inGamut(rgb)) {
    let lo = 0, hi = color.c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(linearRgb({ ...color, c: mid }))) lo = mid; else hi = mid;
    }
    rgb = linearRgb({ ...color, c: lo });
  }
  return `#${rgb.map((v) => Math.round(toGamma(Math.min(1, Math.max(0, v))) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** `steps + 1` colours evenly along the arc, as #rrggbb. */
export function sampleArc(arc: HueArc, steps: number): string[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    return oklchHex({ l: arc.from.l + (arc.to.l - arc.from.l) * t, c: arc.from.c + (arc.to.c - arc.from.c) * t, h: (((arc.from.h + arc.turn * t) % 360) + 360) % 360 });
  });
}
