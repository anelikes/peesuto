/**
 * Synthetic frames for the frame-stream tests (frames.test.ts): no engine.
 * A frame's picture is a pure function of its index, `hold` frames in a row
 * share one, and `engine` (which a real stream passes to its workers) carries
 * the mode: "fake:hold=3,busy=20,failAt=40,failInit".
 */
import type { Drawer } from "../../src/render/prepared.ts";

export const FAKE_SIZE = { width: 8, height: 6 } as const;

export interface FakeMode { readonly hold: number; readonly busyMs: number; readonly failAt?: number; readonly failInit: boolean }

export function fakeMode(engine: string): FakeMode {
  const fields = new Map<string, string | undefined>(engine.replace(/^fake:/, "").split(",").filter(Boolean).map((kv) => { const [k, v] = kv.split("="); return [k!, v]; }));
  return { hold: Number(fields.get("hold") ?? 1), busyMs: Number(fields.get("busy") ?? 0), failInit: fields.has("failInit"),
    ...(fields.has("failAt") ? { failAt: Number(fields.get("failAt")) } : {}) };
}

/** The picture of `frame`: one byte, every channel. */
export const fakePicture = (frame: number, hold: number): number => Math.floor(frame / hold) % 251;

/** Busy-waits like a rasteriser: the thread does nothing else meanwhile. */
const busy = (ms: number) => { const until = performance.now() + ms; while (performance.now() < until); };

export function fakeDrawer(mode: FakeMode): Drawer {
  return {
    async draw(frame, before) {
      busy(mode.busyMs);
      if (frame === mode.failAt) throw new Error(`fake failure at frame ${frame}`);
      if (before >= 0 && fakePicture(before, mode.hold) === fakePicture(frame, mode.hold)) return null;
      return new Uint8Array(FAKE_SIZE.width * FAKE_SIZE.height * 4).fill(fakePicture(frame, mode.hold));
    },
    async dispose() {},
  };
}
