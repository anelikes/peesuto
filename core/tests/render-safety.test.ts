import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineError, EngineTimeoutError, RENDER_TIMEOUT_MS, renderTimeoutMs, runEngine } from "../src/engine.ts";
import { OUTPUT_RETENTION, pruneOutputs, writeOutput } from "../src/render/outputs.ts";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A work tree whose "engine" starts a grandchild and then hangs. */
async function hangingWork(): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "paste-hang-"));
  await mkdir(join(work, "src/cli"), { recursive: true });
  await writeFile(join(work, "src/cli/main.ts"), `
    const child = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    await Bun.write(${JSON.stringify(join(work, "grandchild.pid"))}, String(child.pid));
    console.log("started");
    await Bun.sleep(60_000);
  `);
  return work;
}

describe("engine render deadline", () => {
  const saved = process.env.PASTE_RENDER_TIMEOUT_MS;
  afterEach(() => { if (saved === undefined) delete process.env.PASTE_RENDER_TIMEOUT_MS; else process.env.PASTE_RENDER_TIMEOUT_MS = saved; });

  test("defaults are 240 s for PNG/GIF and 600 s for MP4; the env var overrides", () => {
    delete process.env.PASTE_RENDER_TIMEOUT_MS;
    expect(RENDER_TIMEOUT_MS).toEqual({ still: 240_000, video: 600_000 });
    expect(renderTimeoutMs("png")).toBe(240_000);
    expect(renderTimeoutMs("gif")).toBe(240_000);
    expect(renderTimeoutMs("mp4")).toBe(600_000);
    process.env.PASTE_RENDER_TIMEOUT_MS = "1500";
    expect(renderTimeoutMs("mp4")).toBe(1500);
    process.env.PASTE_RENDER_TIMEOUT_MS = "nonsense";
    expect(renderTimeoutMs("png")).toBe(240_000);
  });

  test("a hung engine is killed with its whole process group and reported clearly", async () => {
    const work = await hangingWork();
    const started = performance.now();
    let error: unknown;
    try { await runEngine(work, ["render", "compositions/paste"], {}, { deadline: performance.now() + 1500 }); }
    catch (e) { error = e; }
    expect(error).toBeInstanceOf(EngineTimeoutError);
    expect(error).toBeInstanceOf(EngineError);
    expect((error as Error).message).toContain("timed out");
    expect(performance.now() - started).toBeLessThan(10_000);
    const grandchild = Number(await readFile(join(work, "grandchild.pid"), "utf8"));
    await Bun.sleep(100);
    expect(alive(grandchild)).toBe(false);
  }, 20_000);

  test("PASTE_RENDER_TIMEOUT_MS bounds a run without an explicit deadline", async () => {
    process.env.PASTE_RENDER_TIMEOUT_MS = "1000";
    const work = await hangingWork();
    await expect(runEngine(work, ["build", "compositions/paste"])).rejects.toBeInstanceOf(EngineTimeoutError);
  }, 20_000);

  test("a deadline already past refuses to start", async () => {
    const work = await hangingWork();
    await expect(runEngine(work, ["build"], {}, { deadline: performance.now() - 1 })).rejects.toBeInstanceOf(EngineTimeoutError);
  });
});

describe("rendered output files", () => {
  const uuid = () => crypto.randomUUID();

  test("a failed render leaves the caller's existing file untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-out-"));
    const out = join(dir, "mine.mp4");
    await writeFile(out, "precious");
    await expect(writeOutput(out, async (temp) => { await writeFile(temp, "half"); throw new Error("encoder died"); })).rejects.toThrow("encoder died");
    expect(await readFile(out, "utf8")).toBe("precious");
    expect(await readdir(dir)).toEqual(["mine.mp4"]);
    await writeOutput(out, async (temp) => { expect(temp.endsWith(".mp4")).toBe(true); await writeFile(temp, "new"); });
    expect(await readFile(out, "utf8")).toBe("new");
    expect(await readdir(dir)).toEqual(["mine.mp4"]);
  });

  test("pruning removes generated files older than 24 h and beyond the newest 30", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-cards-"));
    const now = Date.now();
    const names: string[] = [];
    for (let i = 0; i < 40; i++) {
      const name = `${i % 2 ? "card" : "template"}-${uuid()}.${["png", "gif", "mp4"][i % 3]}`;
      names.push(name);
      await writeFile(join(dir, name), "x");
      const t = (now - i * 60_000) / 1000; // i minutes old; index 0 is newest
      await utimes(join(dir, name), t, t);
    }
    const stale = `card-${uuid()}.png`;
    await writeFile(join(dir, stale), "x");
    await utimes(join(dir, stale), (now - OUTPUT_RETENTION.maxAgeMs - 1000) / 1000, (now - OUTPUT_RETENTION.maxAgeMs - 1000) / 1000);
    const stalePartial = `.partial-${uuid()}-card-${uuid()}.png`;
    await writeFile(join(dir, stalePartial), "x");
    await utimes(join(dir, stalePartial), (now - OUTPUT_RETENTION.maxAgeMs - 1000) / 1000, (now - OUTPUT_RETENTION.maxAgeMs - 1000) / 1000);
    const freshPartial = `.partial-${uuid()}-template-${uuid()}.gif`;
    await writeFile(join(dir, freshPartial), "x");
    await writeFile(join(dir, "notes.txt"), "user file");
    const removed = await pruneOutputs(dir, join(dir, names[0]!), OUTPUT_RETENTION, now);
    const left = new Set(await readdir(dir));
    expect(removed.length).toBe(12); // 10 beyond the newest 30, one stale, one stale partial
    for (const name of names.slice(0, 30)) expect(left.has(name)).toBe(true);
    for (const name of names.slice(30)) expect(left.has(name)).toBe(false);
    expect(left.has(stale)).toBe(false);
    expect(left.has(stalePartial)).toBe(false);
    expect(left.has(freshPartial)).toBe(true);
    expect(left.has("notes.txt")).toBe(true);
  });

  test("the output just produced is never pruned, and a missing dir is fine", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paste-cards-"));
    const name = `card-${uuid()}.png`;
    await writeFile(join(dir, name), "x");
    expect(await pruneOutputs(dir, join(dir, name), { maxAgeMs: 0, keep: 0 }, Date.now() + 1000)).toEqual([]);
    expect(await pruneOutputs(join(dir, "missing"))).toEqual([]);
  });
});
