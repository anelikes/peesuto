/**
 * Types for `gifenc`, which ships none. Only the surface gif.ts uses:
 * quantize → applyPalette → GIFEncoder().writeFrame()/finish()/bytes().
 */
declare module "gifenc" {
  export type PixelFormat = "rgb565" | "rgb444" | "rgba4444";
  /** `[r, g, b]` (or `[r, g, b, a]` for rgba4444) per entry, at most `maxColors` entries. */
  export type Palette = number[][];

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: {
      format?: PixelFormat;
      oneBitAlpha?: boolean | number;
      clearAlpha?: boolean;
      clearAlphaThreshold?: number;
      clearAlphaColor?: number;
      useSqrt?: boolean;
    },
  ): Palette;

  /** One palette index per pixel; nearest colour in RGB(A) space. */
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: PixelFormat): Uint8Array;

  export interface FrameOptions {
    /** Required on the first frame (becomes the global table); on later frames it writes a local table. */
    palette?: Palette;
    first?: boolean;
    transparent?: boolean;
    transparentIndex?: number;
    /** Milliseconds; the encoder rounds to centiseconds. */
    delay?: number;
    /** -1 once, 0 forever, n extra repetitions. Written with the first frame. */
    repeat?: number;
    dispose?: number;
    colorDepth?: number;
  }

  export interface Encoder {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: FrameOptions): void;
    writeHeader(): void;
    finish(): void;
    reset(): void;
    /** A copy of the bytes written so far. */
    bytes(): Uint8Array;
    /** A view, no copy. */
    bytesView(): Uint8Array;
    readonly buffer: ArrayBuffer;
  }

  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): Encoder;
  export default GIFEncoder;
}
