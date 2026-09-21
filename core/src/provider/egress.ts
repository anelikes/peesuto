/**
 * The one door out of the machine. Every request core makes to any host
 * goes through here, so one switch (offline mode) shuts them all and one
 * log shows where bytes went. Nothing is allow-listed at this layer: the
 * switch is the control, the log is the audit.
 *
 * The log is one JSON line per request — when, which host, what for, bytes
 * out, bytes in, status, milliseconds. Never a body, never a header. Local
 * destinations (localhost, 127.0.0.1) are logged like any other and marked
 * `local: true`.
 *
 * Offline mode starts from `PASTE_OFFLINE=1` and refuses every request,
 * local ones included: "offline" means no model call at all.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_TIMEOUT_MS, ProviderConfigError, ProviderError } from "./types.ts";

export interface EgressOptions {
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
  /** What the request is for, e.g. "decider:cloudflare"; recorded in the log. */
  readonly purpose: string;
}

export interface EgressResponse {
  readonly status: number;
  /** The body parsed as JSON; `null` when empty, `{ error: <text> }` when not JSON. */
  readonly json: unknown;
  readonly text: string;
}

export interface EgressLogLine {
  at: string;
  host: string;
  purpose: string;
  bytesOut: number;
  bytesIn: number;
  /** 0 when no response arrived (see `error`). */
  status: number;
  ms: number;
  local?: true;
  error?: "timeout" | "network";
}

let offline = /^(1|true|yes)$/i.test(process.env.PASTE_OFFLINE ?? "");
let logPath: string | null = null;
let logDirReady: string | null = null;
let logWarned = false;

export function setOffline(on: boolean): void { offline = on; }
export function isOffline(): boolean { return offline; }

/** Append every request's log line to this file; `null` (the default) logs nothing. */
export function setEgressLog(path: string | null): void { logPath = path; logDirReady = null; logWarned = false; }
export function egressLogPath(): string | null { return logPath; }

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOCAL_HOSTS.has(h) || h.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(h);
}

async function record(line: EgressLogLine): Promise<void> {
  if (!logPath) return;
  try {
    if (logDirReady !== logPath) { await mkdir(dirname(logPath), { recursive: true }); logDirReady = logPath; }
    await appendFile(logPath, `${JSON.stringify(line)}\n`);
  } catch (e) {
    if (!logWarned) { logWarned = true; console.error(`egress: cannot write ${logPath}: ${(e as Error).message}`); }
  }
}

async function send(method: "GET" | "POST", url: string, body: string | undefined, o: EgressOptions): Promise<EgressResponse> {
  let u: URL;
  try { u = new URL(url); } catch { throw new ProviderConfigError(`${o.purpose}: not a URL: ${url}`); }
  if (offline) throw new ProviderError("offline", `${o.purpose}: offline mode is on, so nothing was sent to ${u.host}`);
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const line: EgressLogLine = { at: new Date().toISOString(), host: u.host, purpose: o.purpose, bytesOut: body === undefined ? 0 : Buffer.byteLength(body), bytesIn: 0, status: 0, ms: 0 };
  if (isLocalHost(u.hostname)) line.local = true;
  const t0 = performance.now();
  try {
    let text: string;
    try {
      const res = await fetch(url, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...o.headers },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      line.status = res.status;
      text = await res.text();
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        line.error = "timeout";
        throw new ProviderError("timeout", `${o.purpose}: no answer from ${u.host} within ${timeoutMs} ms`);
      }
      line.error = "network";
      throw new ProviderError("network", `${o.purpose}: ${url}: ${(e as Error).message}`);
    }
    line.bytesIn = Buffer.byteLength(text);
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { error: text.slice(0, 300) }; }
    return { status: line.status, json, text };
  } finally {
    line.ms = Math.round(performance.now() - t0);
    await record(line);
  }
}

export const egress = {
  /** POST `body` as JSON. Fetch failures become "timeout" / "network" ProviderErrors; HTTP errors are returned as-is for the caller to map. */
  post: (url: string, body: unknown, o: EgressOptions): Promise<EgressResponse> => send("POST", url, JSON.stringify(body), o),
  get: (url: string, o: EgressOptions): Promise<EgressResponse> => send("GET", url, undefined, o),
  /** `post` under the name the deciders used before the egress layer existed. */
  postJson: (url: string, body: unknown, o: EgressOptions): Promise<EgressResponse> => send("POST", url, JSON.stringify(body), o),
};
