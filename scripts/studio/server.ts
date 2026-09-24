/**
 * Studio server: HTTP API, a single sequential render queue, a content cache
 * keyed by the template code version, and a watcher on core's template code.
 * Core itself runs in two worker subprocesses (decisions, renders) that are
 * restarted whenever the code version changes.
 */
import { watch } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { DecisionInfo, Formats, JobSpec, PlanResult, RenderMeta } from "./pipeline.ts";
import { SCENARIOS } from "./scenarios.ts";
import { REPLY_PREFIX } from "./worker.ts";

/** Mirrors core's TEMPLATE_ASPECTS (the server does not load core; workers do). */
const IMAGE_FRAMES = ["auto", "1:1", "4:5", "16:9", "9:16"] as const;
const MOTION_FRAMES = ["1:1", "4:5", "16:9", "9:16"] as const;

export interface StudioOptions {
  readonly repo: string;
  /** .work/studio: holds .engine, .tree, .emoji, cache/, answers/. */
  readonly root: string;
  readonly engine: string;
  readonly ffmpeg?: string;
  /** Whether MP4 can be made (native encoder or ffmpeg); defaults to whether ffmpeg was given. */
  readonly video?: boolean;
  readonly port: number;
}

/** Hash of the code that decides and draws templates, plus the engine pin. */
export async function codeVersion(repo: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const dir of ["core/src/templates", "core/src/render", "core/src/privacy"]) {
    const names = (await readdir(join(repo, dir))).filter((n) => n.endsWith(".ts")).sort();
    for (const name of names) hasher.update(`${dir}/${name}\0`).update(await readFile(join(repo, dir, name))).update("\0");
  }
  hasher.update("engine.json\0").update(await readFile(join(repo, "engine.json")));
  return hasher.digest("hex").slice(0, 12);
}

const hash = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);

type WorkerError = Error & { kind?: string };

/** One core subprocess; restarted when the code version differs from the one it loaded. */
class Worker {
  private proc?: Subprocess<"pipe", "pipe", "inherit">;
  private version?: string;
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  constructor(private readonly script: string, private readonly cwd: string) {}

  async call<T>(version: string, request: Record<string, unknown>): Promise<T> {
    if (!this.proc || this.version !== version) this.restart(version);
    const id = this.next++;
    const reply = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.proc!.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
    this.proc!.stdin.flush();
    return (await reply) as T;
  }

  private fail(message: string) {
    for (const p of this.pending.values()) p.reject(Object.assign(new Error(message), { kind: "WorkerRestart" }));
    this.pending.clear();
  }

  restart(version: string) {
    this.stop();
    const proc = Bun.spawn([process.execPath, this.script], { cwd: this.cwd, stdin: "pipe", stdout: "pipe", stderr: "inherit", env: process.env });
    this.proc = proc;
    this.version = version;
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of proc.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith(REPLY_PREFIX)) { if (line.trim()) process.stderr.write(`[worker] ${line}\n`); continue; }
          const reply = JSON.parse(line.slice(REPLY_PREFIX.length)) as { id: number; ok: boolean; result?: unknown; error?: { kind: string; message: string } };
          const p = this.pending.get(reply.id);
          if (!p) continue;
          this.pending.delete(reply.id);
          if (reply.ok) p.resolve(reply.result);
          else p.reject(Object.assign(new Error(reply.error!.message), { kind: reply.error!.kind }));
        }
      }
      if (this.proc === proc) { this.proc = undefined; this.fail("worker 进程退出"); }
    })();
  }

  stop() {
    const proc = this.proc;
    this.proc = undefined;
    this.fail("worker 已重启（模板代码改变）");
    proc?.kill();
  }
}

type JobStatus = "queued" | "running" | "done" | "error" | "stale";
interface Job {
  readonly key: string;
  readonly version: string;
  readonly spec: JobSpec;
  status: JobStatus;
  meta?: RenderMeta & { cached?: boolean };
  error?: { kind: string; message: string };
}

interface PlanRequest { scenario?: string; text?: string; imageFrame?: string; motionFrame?: string; decider?: string; formats?: Partial<Formats>; modelContent?: string }
const MODEL_CONTENT = ["raw", "redacted", "structure"] as const;
interface Frames { readonly imageFrame: string; readonly motionFrame: string }

export async function startStudio(o: StudioOptions) {
  const cacheDir = join(o.root, "cache");
  const answersDir = join(o.root, "answers");
  await mkdir(cacheDir, { recursive: true });
  const workerScript = join(import.meta.dir, "worker.ts");
  const planner = new Worker(workerScript, o.repo);
  const renderer = new Worker(workerScript, o.repo);
  const engineOptions = { engine: o.engine, root: o.root, repo: o.repo, ffmpeg: o.ffmpeg };
  const jev = Boolean(process.env.PASTE_CF_TOKEN && process.env.PASTE_CF_ACCOUNT_ID);

  let version = await codeVersion(o.repo);
  const jobs = new Map<string, Job>();
  let queue: string[] = [];
  let running: string | undefined;

  // --- events (SSE) ---
  const encoder = new TextEncoder();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const send = (c: ReadableStreamDefaultController<Uint8Array>, text: string) => { try { c.enqueue(encoder.encode(text)); } catch { clients.delete(c); } };
  const broadcast = (event: Record<string, unknown>) => { const text = `data: ${JSON.stringify(event)}\n\n`; for (const c of clients) send(c, text); };
  setInterval(() => { for (const c of clients) send(c, ": ping\n\n"); }, 10_000);
  const queueState = () => ({ pending: queue.length, running: running ? jobs.get(running)?.spec.label : undefined });

  const fileOf = (job: Job) => join(cacheDir, `${job.key}.${job.spec.format}`);
  // `spec` is the requested one: two specs can share a render (the automatic PNG is also in the frame comparison).
  const view = (job: Job, spec: JobSpec = job.spec) => ({
    key: job.key, label: spec.label, template: spec.template, variant: spec.variant, motion: spec.motion, format: spec.format,
    group: spec.group, frame: spec.frame, auto: spec.auto, status: job.status, meta: job.meta, error: job.error,
    url: `/files/${job.key}.${job.spec.format}`, path: fileOf(job),
  });
  // Job events carry status and meta only; the page keeps each card's own label and group.
  const publish = (job: Job) => { const { key, status, meta, error, url, path } = view(job); broadcast({ type: "job", job: { key, status, meta, error, url, path } }); };

  // --- code version ---
  async function refreshVersion(): Promise<string> {
    const next = await codeVersion(o.repo);
    if (next === version) return version;
    const previous = version;
    version = next;
    // Queued work was planned by the old code; the page re-plans on refresh.
    for (const key of queue) { const job = jobs.get(key); if (job) { job.status = "stale"; publish(job); } }
    queue = [];
    console.log(`studio: template code changed ${previous} → ${next}`);
    broadcast({ type: "code", version, previous });
    broadcast({ type: "queue", ...queueState() });
    return version;
  }
  let debounce: Timer | undefined;
  const onChange = () => { clearTimeout(debounce); debounce = setTimeout(() => void refreshVersion(), 250); };
  for (const dir of ["core/src/templates", "core/src/render", "core/src/privacy"]) watch(join(o.repo, dir), onChange);
  watch(join(o.repo, "engine.json"), onChange);

  // --- queue ---
  async function pump() {
    if (running) return;
    while (queue.length) {
      const key = queue.shift()!;
      const job = jobs.get(key);
      if (!job || job.status !== "queued") continue;
      if (job.version !== version) { job.status = "stale"; publish(job); continue; }
      running = key;
      job.status = "running";
      publish(job);
      broadcast({ type: "queue", ...queueState() });
      try {
        const meta = await renderer.call<RenderMeta>(version, { op: "render", plan: job.spec.plan, format: job.spec.format, out: fileOf(job), engine: engineOptions });
        await Bun.write(join(cacheDir, `${key}.json`), JSON.stringify(meta));
        job.meta = meta;
        job.status = "done";
      } catch (error) {
        const e = error as WorkerError;
        job.error = { kind: e.kind ?? "Error", message: e.message };
        job.status = "error";
        console.log(`studio: ${job.spec.label}: ${job.error.kind}: ${job.error.message}`);
      }
      running = undefined;
      publish(job);
      broadcast({ type: "queue", ...queueState() });
    }
  }

  /** Register planned jobs (cache hits come back done) and queue the rest, first or last. */
  async function admit(text: string, frames: Frames, decider: string, specs: readonly JobSpec[], front: boolean): Promise<ReturnType<typeof view>[]> {
    const admitted: ReturnType<typeof view>[] = [];
    const fresh: string[] = [];
    for (const spec of specs) {
      // Both frames: the decision is made in the image frame; GIF/MP4 render in the motion frame
      // (left out of PNG keys so switching it does not re-render stills). spec.frame is the frame drawn.
      const key = hash([text, frames.imageFrame, spec.format === "png" ? "" : frames.motionFrame, spec.frame, spec.template, spec.variant, spec.motion, spec.format, decider, version]);
      let job = jobs.get(key);
      if (!job || job.status === "stale") {
        job = { key, version, spec, status: "queued" };
        const metaFile = join(cacheDir, `${key}.json`);
        if (existsSync(metaFile) && existsSync(fileOf(job))) {
          try { job.meta = { ...(JSON.parse(await readFile(metaFile, "utf8")) as RenderMeta), cached: true }; job.status = "done"; } catch { /* re-render */ }
        }
        jobs.set(key, job);
      }
      if (job.status === "queued") fresh.push(key);
      admitted.push(view(job, spec));
    }
    const rest = queue.filter((k) => !fresh.includes(k));
    queue = front ? [...fresh, ...rest] : [...rest, ...fresh];
    broadcast({ type: "queue", ...queueState() });
    void pump();
    return admitted;
  }

  const parseCommon = (body: PlanRequest) => {
    const frames: Frames = {
      imageFrame: IMAGE_FRAMES.includes(body.imageFrame as never) ? body.imageFrame! : "auto",
      motionFrame: MOTION_FRAMES.includes(body.motionFrame as never) ? body.motionFrame! : "1:1",
    };
    const mode = MODEL_CONTENT.includes(body.modelContent as never) ? body.modelContent! : "redacted";
    // What Jev receives can change its answer, so the mode is part of the decider's identity; rules never see a model.
    const decider = body.decider === "jev" && jev ? `jev:${mode}` : "rules";
    const f = body.formats ?? {};
    const formats: Formats = { png: f.png !== false, others: f.others !== false, gif: f.gif !== false, mp4: f.mp4 !== false, frames: f.frames === true };
    return { frames, decider, formats };
  };
  const plan = (text: string, frames: Frames, decider: string, formats: Formats, autoOnly = false) => {
    const [kind, modelContent] = decider.split(":");
    return planner.call<PlanResult>(version, { op: "plan", text, ...frames, decider: kind, modelContent, formats, video: o.video ?? Boolean(o.ffmpeg), answersDir, autoOnly });
  };
  const failure = (error: unknown, status = 422) => { const e = error as WorkerError; return Response.json({ error: { kind: e.kind ?? "Error", message: e.message } }, { status }); };

  const page = join(import.meta.dir, "page.html");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: o.port,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (req.method === "GET" && (path === "/" || path === "/index.html")) return new Response(Bun.file(page), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

      if (req.method === "GET" && path === "/api/state") {
        await refreshVersion();
        let registry: unknown = [];
        try { registry = await planner.call(version, { op: "registry" }); } catch (error) { return failure(error, 500); }
        return Response.json({ version, jev, ffmpeg: o.video ?? Boolean(o.ffmpeg), queue: queueState(), registry,
          scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title, group: s.group ?? "其他", text: s.text })) });
      }

      if (req.method === "POST" && path === "/api/plan") {
        const body = (await req.json().catch(() => ({}))) as PlanRequest;
        const { frames, decider, formats } = parseCommon(body);
        const scenario = body.scenario ? SCENARIOS.find((s) => s.id === body.scenario) : undefined;
        const text = scenario?.text ?? body.text;
        if (!text?.trim()) return Response.json({ error: { kind: "input", message: "没有文字" } }, { status: 400 });
        await refreshVersion();
        try {
          const result = await plan(text, frames, decider, formats);
          const admitted = await admit(text, frames, decider, result.jobs, true);
          return Response.json({ version, decision: result.decision, jobs: admitted });
        } catch (error) { return failure(error); }
      }

      if (req.method === "POST" && path === "/api/privacy") {
        const body = (await req.json().catch(() => ({}))) as PlanRequest & { mode?: string };
        const scenario = body.scenario ? SCENARIOS.find((s) => s.id === body.scenario) : undefined;
        const text = scenario?.text ?? body.text;
        if (!text) return Response.json({ error: { kind: "input", message: "没有文字" } }, { status: 400 });
        await refreshVersion();
        try { return Response.json(await planner.call(version, { op: "privacy", text, mode: MODEL_CONTENT.includes(body.mode as never) ? body.mode : "redacted" })); }
        catch (error) { return failure(error); }
      }

      if (req.method === "POST" && path === "/api/overview") {
        const body = (await req.json().catch(() => ({}))) as PlanRequest;
        const { frames, decider, formats } = parseCommon(body);
        await refreshVersion();
        const items: { scenario: { id: string; title: string; group: string }; decision?: DecisionInfo; job?: ReturnType<typeof view>; error?: unknown }[] = [];
        for (const s of SCENARIOS) {
          const scenario = { id: s.id, title: s.title, group: s.group ?? "其他" };
          try {
            const result = await plan(s.text, frames, decider, formats, true);
            const [job] = await admit(s.text, frames, decider, result.jobs, false);
            items.push({ scenario, decision: result.decision, job });
          } catch (error) { const e = error as WorkerError; items.push({ scenario, error: { kind: e.kind ?? "Error", message: e.message } }); }
        }
        return Response.json({ version, items });
      }

      if (req.method === "GET" && path === "/api/events") {
        let controller: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) { controller = c; clients.add(c); send(c, `data: ${JSON.stringify({ type: "hello", version, ...queueState() })}\n\n`); },
          cancel() { clients.delete(controller); },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
      }

      if (req.method === "POST" && path === "/api/clear") {
        queue = [];
        for (const [key, job] of jobs) if (key !== running) jobs.delete(key);
        await rm(cacheDir, { recursive: true, force: true });
        await mkdir(cacheDir, { recursive: true });
        await refreshVersion();
        broadcast({ type: "cleared", version });
        broadcast({ type: "queue", ...queueState() });
        return Response.json({ ok: true, version });
      }

      if (req.method === "POST" && path === "/api/reveal") {
        const { key } = (await req.json().catch(() => ({}))) as { key?: string };
        const job = key ? jobs.get(key) : undefined;
        if (!job || !existsSync(fileOf(job))) return Response.json({ error: { kind: "input", message: "文件不存在" } }, { status: 404 });
        Bun.spawn(["open", "-R", fileOf(job)]);
        return Response.json({ ok: true });
      }

      const file = /^\/files\/([0-9a-f]{32}\.(?:png|gif|mp4))$/.exec(path);
      if (req.method === "GET" && file) {
        const f = Bun.file(join(cacheDir, file[1]!));
        if (!(await f.exists())) return new Response("not found", { status: 404 });
        return new Response(f, { headers: { "cache-control": "public, max-age=31536000, immutable" } });
      }
      return new Response("not found", { status: 404 });
    },
  });

  // Warm both workers so the first click does not pay for loading core.
  void planner.call(version, { op: "registry" }).catch(() => {});
  void renderer.call(version, { op: "registry" }).catch(() => {});
  const stop = () => { planner.stop(); renderer.stop(); server.stop(true); };
  return { url: `http://127.0.0.1:${server.port}/`, version: () => version, stop };
}
