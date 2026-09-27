/**
 * One frame worker (frames.ts): a thread with its own wasm world over the
 * prepared composition. It draws the chunks it is sent, in the order sent
 * (always increasing), folding through the frames other workers draw, and
 * posts each frame's pixels (transferred, not copied), or that it is held.
 * For a JIZURA film the thread draws with JIZURA instead (core/src/jizura/
 * render.ts: a fresh engine per chunk), loaded only then.
 *
 * Messages are handled one at a time: a chunk waits for the init before it
 * and for the chunk before it. After each frame the worker yields a macrotask
 * turn; that is where the thread's terminate() takes effect.
 */
import type { WorkerReply, WorkerRequest } from "./frames.ts";
import { FrameDrawer, type Drawer } from "./prepared.ts";

declare const self: Worker;

let drawer: Drawer | undefined;
let queue: Promise<void> = Promise.resolve();
const post = (reply: WorkerReply, transfer: ArrayBuffer[] = []) => self.postMessage(reply, transfer);
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

self.onmessage = (event: MessageEvent<WorkerRequest>) => { queue = queue.then(() => handle(event.data)); };

async function handle(m: WorkerRequest): Promise<void> {
  if (m.type === "init") {
    try {
      drawer = "jizura" in m
        ? await (await import("../jizura/render.ts")).JizuraDrawer.open(m.jizura)
        : await FrameDrawer.open(m.engine, m.composition, { width: m.width, reuse: m.reuse });
      post({ type: "ready" });
    } catch (e) {
      post({ type: "error", phase: "init", message: messageOf(e) });
    }
    return;
  }
  // Without a world the init has already reported why; frames.ts gives up the workers.
  if (!drawer) return;
  try {
    for (const [k, frame] of m.frames.entries()) {
      const drawn = await drawer.draw(frame, k === 0 ? m.before : m.frames[k - 1]!);
      if (drawn) {
        // The buffer is transferred whole, so it must be exactly the frame.
        const rgba = drawn.byteOffset === 0 && drawn.byteLength === drawn.buffer.byteLength ? drawn : drawn.slice();
        post({ type: "frame", index: frame, rgba: rgba.buffer as ArrayBuffer }, [rgba.buffer as ArrayBuffer]);
      } else post({ type: "frame", index: frame });
      await new Promise((resolve) => setImmediate(resolve));
    }
  } catch (e) {
    post({ type: "error", phase: "render", message: messageOf(e) });
  }
}
