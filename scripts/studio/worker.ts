/**
 * Studio worker: a subprocess that loads core fresh, so the server can restart
 * it after template code changes. Requests arrive as JSON lines on stdin;
 * replies are stdout lines prefixed with REPLY_PREFIX (anything else a child
 * process prints is ignored by the server).
 *
 *   {"id":1,"op":"plan","text":"…","imageFrame":"auto","motionFrame":"1:1","decider":"rules","formats":{…},"video":true,"answersDir":"…","autoOnly":false}
 *   {"id":2,"op":"render","plan":{…},"format":"png","out":"/abs/file.png","engine":{…}}
 *   {"id":3,"op":"registry"}
 */
import { errorOf, planText, registrySummary, renderJob } from "./pipeline.ts";

export const REPLY_PREFIX = "@@studio ";

type Request = { id: number; op: string; [key: string]: any };

async function handle(req: Request): Promise<unknown> {
  switch (req.op) {
    case "plan": return await planText(req.text, { imageFrame: req.imageFrame, motionFrame: req.motionFrame, decider: req.decider, answersDir: req.answersDir, formats: req.formats, video: req.video, autoOnly: req.autoOnly });
    case "render": return await renderJob(req.plan, req.format, req.out, req.engine);
    case "registry": return registrySummary();
    default: throw new Error(`unknown op ${req.op}`);
  }
}

if (import.meta.main) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const req = JSON.parse(line) as Request;
      // Requests run concurrently; the server serialises renders itself.
      void handle(req).then(
        (result) => process.stdout.write(`${REPLY_PREFIX}${JSON.stringify({ id: req.id, ok: true, result })}\n`),
        (error) => process.stdout.write(`${REPLY_PREFIX}${JSON.stringify({ id: req.id, ok: false, error: errorOf(error) })}\n`),
      );
    }
  }
}
