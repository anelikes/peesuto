/** A frame worker over synthetic frames (fake-frames.ts), speaking frame-worker.ts's protocol. */
import type { WorkerReply, WorkerRequest } from "../../src/render/frames.ts";
import type { Drawer } from "../../src/render/prepared.ts";
import { fakeDrawer, fakeMode } from "./fake-frames.ts";

declare const self: Worker;

let drawer: Drawer | undefined;
let queue: Promise<void> = Promise.resolve();
const post = (reply: WorkerReply, transfer: ArrayBuffer[] = []) => self.postMessage(reply, transfer);
self.onmessage = (event: MessageEvent<WorkerRequest>) => { queue = queue.then(() => handle(event.data)); };

async function handle(m: WorkerRequest): Promise<void> {
  if (m.type === "init") {
    const mode = fakeMode(m.engine);
    if (mode.failInit) { post({ type: "error", phase: "init", message: "fake world did not boot" }); return; }
    drawer = fakeDrawer(mode);
    post({ type: "ready" });
    return;
  }
  if (!drawer) return;
  try {
    for (const [k, frame] of m.frames.entries()) {
      const rgba = await drawer.draw(frame, k === 0 ? m.before : m.frames[k - 1]!);
      if (rgba) post({ type: "frame", index: frame, rgba: rgba.buffer as ArrayBuffer }, [rgba.buffer as ArrayBuffer]);
      else post({ type: "frame", index: frame });
      await new Promise((resolve) => setImmediate(resolve));
    }
  } catch (e) {
    post({ type: "error", phase: "render", message: e instanceof Error ? e.message : String(e) });
  }
}
