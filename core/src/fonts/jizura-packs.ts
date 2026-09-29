/**
 * Fonts for the JIZURA render line: a small base set bundled with the app
 * (core/src/render/fonts/jizura/) and larger packs downloaded on demand into
 * `<dataDir>/fonts/jizura/<pack>@<sha-prefix>/`, both listed in
 * `jizura-packs.json` next to this file. Peesuto never asks Google Fonts
 * (or anyone) for a font while rendering: `jizuraFontFiles` is local only,
 * and only `ensureJizuraFonts` / `installFontPack` touch the network, to
 * fetch one pack file each from the manifest's host.
 *
 * A download is HTTPS only (plain HTTP is allowed for loopback hosts, for
 * tests), streamed to `<dataDir>/fonts/jizura/.partial/<pack>@<sha>.tar.part`,
 * resumed with a Range request when a part is there, checked against the
 * manifest's size and SHA-256, unpacked into a scratch directory, every
 * file checked again, and renamed into place in one step. Concurrent calls
 * for one pack share one download (and a lock file keeps two processes from
 * writing the same part); a caller's AbortSignal detaches that caller, and
 * the download stops when no caller is left. Offline mode (egress.ts) and a
 * host that was never configured refuse before anything is sent.
 *
 * `PEESUTO_JIZURA_FONTS_DIR` points at a flat directory of font files for
 * development; the files are matched by the family and weight their name
 * tables declare and take precedence over bundled and installed ones.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { egressLogPath, isLocalHost, isOffline, type EgressLogLine } from "../provider/egress.ts";
import { fontFaces } from "./font-names.ts";
import { extractTar, SAFE_NAME } from "./tar.ts";

// ── public types ────────────────────────────────────────────────────────────

export interface JizuraFontFile {
  family: string; weight: number; style: "normal" | "italic"; path: string;
  /** A bundled Latin cut standing in for the full face (fonts.ts drops it from Skia once the full face is registered). */
  cut?: true;
}

/** Lyric languages JIZURA draws with their own faces. "en" draws with the "ja" faces (all have Latin). */
export type JizuraLang = "ja" | "zh-Hans" | "zh-Hant" | "ko";

export interface JizuraFace { readonly family: string; readonly weights: readonly number[]; readonly langs: readonly JizuraLang[] }

const ALL: readonly JizuraLang[] = ["ja", "zh-Hans", "zh-Hant", "ko"];
const F = (family: string, weights: number[], langs: readonly JizuraLang[]): JizuraFace => ({ family, weights, langs });

/**
 * Every face JIZURA (852wa/JIZURA at bae339e) can ask for: the catalogue in
 * src/02_fonts.js (the Japanese faces, also used for English lyrics) and the
 * per-language faces in src/02b_lang.js, with the weights it names. The
 * "太さ" cut (weightGrow) also asks Noto Sans JP 100–900 and Noto Serif JP
 * 200–900 continuously; static files snap it to the nearest weight shipped.
 * DotGothic16 and IBM Plex Mono keep their face in every language.
 */
export const JIZURA_FACES: readonly JizuraFace[] = [
  F("Noto Sans JP", [300, 500, 700, 900], ["ja"]),
  F("Noto Serif JP", [300, 500, 700], ["ja"]),
  F("Dela Gothic One", [400], ["ja"]),
  F("Zen Kaku Gothic New", [900], ["ja"]),
  F("Zen Old Mincho", [900], ["ja"]),
  F("Kaisei Tokumin", [800], ["ja"]),
  F("M PLUS Rounded 1c", [800], ["ja"]),
  F("Mochiy Pop One", [400], ["ja"]),
  F("DotGothic16", [400], ALL),
  F("Yuji Syuku", [400], ["ja"]),
  F("IBM Plex Mono", [500], ALL),
  F("IBM Plex Sans JP", [500], ["ja"]),
  F("Reggae One", [400], ["ja"]),
  F("Rampart One", [400], ["ja"]),
  F("Potta One", [400], ["ja"]),
  F("Kiwi Maru", [500], ["ja"]),
  F("Klee One", [600], ["ja"]),
  F("Shippori Mincho B1", [800], ["ja"]),
  F("Noto Sans SC", [300, 500, 700, 900], ["zh-Hans"]),
  F("Noto Serif SC", [300, 500, 700, 800, 900], ["zh-Hans"]),
  F("ZCOOL QingKe HuangYou", [400], ["zh-Hans"]),
  F("ZCOOL KuaiLe", [400], ["zh-Hans"]),
  F("ZCOOL XiaoWei", [400], ["zh-Hans"]),
  F("Ma Shan Zheng", [400], ["zh-Hans"]),
  F("Noto Sans TC", [300, 500, 700, 900], ["zh-Hant"]),
  F("Noto Serif TC", [300, 500, 700, 800, 900], ["zh-Hant"]),
  F("WDXL Lubrifont TC", [400], ["zh-Hant"]),
  F("Chiron GoRound TC", [800], ["zh-Hant"]),
  F("Huninn", [400], ["zh-Hant"]),
  F("LXGW WenKai TC", [700], ["zh-Hant"]),
  F("LXGW Marker Gothic", [400], ["zh-Hant"]),
  F("Noto Sans KR", [300, 500, 700, 900], ["ko"]),
  F("Noto Serif KR", [300, 500, 700, 800, 900], ["ko"]),
  F("IBM Plex Sans KR", [500], ["ko"]),
  F("Black Han Sans", [400], ["ko"]),
  F("Jua", [400], ["ko"]),
  F("Do Hyeon", [400], ["ko"]),
  F("Gowun Dodum", [400], ["ko"]),
  F("Gowun Batang", [700], ["ko"]),
  F("Nanum Brush Script", [400], ["ko"]),
];

/** Every family name JIZURA can ask for. */
export const JIZURA_FAMILIES: readonly string[] = JIZURA_FACES.map((f) => f.family);

export type FontPackErrorCode =
  | "unknown-pack" | "bundled" | "offline" | "unconfigured" | "insecure" | "network" | "timeout" | "http"
  | "size" | "sha256" | "corrupt" | "aborted";

export class FontPackError extends Error {
  constructor(readonly code: FontPackErrorCode, message: string) { super(message); this.name = code === "aborted" ? "AbortError" : "FontPackError"; }
}

// ── manifest ────────────────────────────────────────────────────────────────

export interface Titles { readonly en: string; readonly zh: string; readonly ja: string }

export interface ManifestFont {
  readonly family: string;
  readonly weight: number;
  readonly style: "normal" | "italic";
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Only on a cut (the Latin cut of a CJK face): the ranges it leaves out, inclusive [first, last]. It stands in for the full face while the text has no character in them. */
  readonly lacks?: readonly (readonly [number, number])[];
}

export interface ManifestFile { readonly file: string; readonly bytes: number; readonly sha256: string }

export interface ManifestPack {
  readonly id: string;
  readonly title: Titles;
  readonly langs: readonly JizuraLang[];
  /** The pack file (a tar of `families[].file` and `licenses[].file`), relative to the base URL. */
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly families: readonly ManifestFont[];
  readonly licenses: readonly ManifestFile[];
}

export interface JizuraPackManifest {
  readonly formatVersion: 1;
  /** Where pack files are served from; PEESUTO_FONT_PACKS_URL or a call's `baseUrl` overrides it. A `.invalid` host means "not chosen yet". */
  readonly baseUrl: string;
  readonly bundled: { readonly title: Titles; readonly families: readonly ManifestFont[]; readonly licenses: readonly ManifestFile[] };
  readonly packs: readonly ManifestPack[];
}

export const BUNDLED_ID = "base";
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SHA = /^[0-9a-f]{64}$/;

/** Validate a manifest (throws Error naming the first problem). */
export function parseManifest(raw: unknown, origin = "jizura-packs.json"): JizuraPackManifest {
  const bad = (m: string): never => { throw new Error(`${origin}: ${m}`); };
  const obj = (v: unknown, what: string): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : bad(`${what} must be an object`));
  const arr = (v: unknown, what: string): unknown[] => (Array.isArray(v) ? v : bad(`${what} must be an array`));
  const str = (v: unknown, what: string): string => (typeof v === "string" && v.length > 0 ? v : bad(`${what} must be a non-empty string`));
  const int = (v: unknown, what: string): number => (Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : bad(`${what} must be a non-negative integer`));
  const r = obj(raw, "manifest");
  if (r.formatVersion !== 1) bad("formatVersion must be 1");
  const baseUrl = str(r.baseUrl, "baseUrl");
  const titles = (v: unknown, what: string): Titles => { const t = obj(v, what); return { en: str(t.en, `${what}.en`), zh: str(t.zh, `${what}.zh`), ja: str(t.ja, `${what}.ja`) }; };
  const file = (v: unknown, what: string): ManifestFile => {
    const f = obj(v, what);
    const name = str(f.file, `${what}.file`);
    if (!SAFE_NAME.test(name) || name.startsWith(".")) bad(`${what}.file ${name} is not a plain file name`);
    const sha256 = str(f.sha256, `${what}.sha256`);
    if (!SHA.test(sha256)) bad(`${what}.sha256 must be 64 lowercase hex digits`);
    return { file: name, bytes: int(f.bytes, `${what}.bytes`), sha256 };
  };
  const font = (v: unknown, what: string): ManifestFont => {
    const f = obj(v, what);
    const base = file(f, what);
    const weight = int(f.weight, `${what}.weight`);
    if (weight < 1 || weight > 1000) bad(`${what}.weight out of range`);
    if (f.style !== "normal" && f.style !== "italic") bad(`${what}.style must be normal or italic`);
    let lacks: [number, number][] | undefined;
    if (f.lacks !== undefined) lacks = arr(f.lacks, `${what}.lacks`).map((p, i) => {
      const q = arr(p, `${what}.lacks[${i}]`);
      const a = int(q[0], `${what}.lacks[${i}][0]`), b = int(q[1], `${what}.lacks[${i}][1]`);
      if (q.length !== 2 || a > b || b > 0x10ffff) bad(`${what}.lacks[${i}] must be [first, last]`);
      return [a, b] as [number, number];
    });
    return { family: str(f.family, `${what}.family`), weight, style: f.style as "normal" | "italic", ...base, ...(lacks ? { lacks } : {}) };
  };
  const b = obj(r.bundled, "bundled");
  const bundled = {
    title: titles(b.title, "bundled.title"),
    families: arr(b.families, "bundled.families").map((f, i) => font(f, `bundled.families[${i}]`)),
    licenses: arr(b.licenses, "bundled.licenses").map((f, i) => file(f, `bundled.licenses[${i}]`)),
  };
  const ids = new Set<string>([BUNDLED_ID]);
  const packs = arr(r.packs, "packs").map((v, i): ManifestPack => {
    const p = obj(v, `packs[${i}]`);
    const id = str(p.id, `packs[${i}].id`);
    if (!ID.test(id)) bad(`packs[${i}].id must be lowercase letters, digits and dashes`);
    if (ids.has(id)) bad(`pack id ${id} is used twice`);
    ids.add(id);
    const self = file(p, `packs[${i}]`);
    const langs = arr(p.langs, `packs[${i}].langs`).map((l) => (ALL.includes(l as JizuraLang) ? l as JizuraLang : bad(`packs[${i}].langs: unknown ${String(l)}`)));
    const families = arr(p.families, `packs[${i}].families`).map((f, j) => font(f, `packs[${i}].families[${j}]`));
    const licenses = arr(p.licenses, `packs[${i}].licenses`).map((f, j) => file(f, `packs[${i}].licenses[${j}]`));
    const names = new Set<string>();
    for (const f of [...families, ...licenses]) { if (names.has(f.file)) bad(`packs[${i}]: ${f.file} listed twice`); names.add(f.file); }
    return { id, title: titles(p.title, `packs[${i}].title`), langs, ...self, families, licenses };
  });
  return { formatVersion: 1, baseUrl, bundled, packs };
}

let defaultManifest: JizuraPackManifest | null = null;
const MANIFEST_PATH = fileURLToPath(new URL("./jizura-packs.json", import.meta.url));
/** Where the bundled base fonts live (inside the app bundle in a release: read only). */
export const BUNDLED_DIR = fileURLToPath(new URL("../render/fonts/jizura/", import.meta.url));

/** The committed manifest. */
export function jizuraPackManifest(): JizuraPackManifest {
  return (defaultManifest ??= parseManifest(JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))));
}

// ── options ─────────────────────────────────────────────────────────────────

interface Common {
  /** Tests and tools: another manifest / bundled directory than the committed ones. */
  manifest?: JizuraPackManifest;
  bundledDir?: string;
}
export interface ResolveOptions extends Common {
  /** The app's data directory (the daemon's --app-data); installed packs live in `<dataDir>/fonts/jizura/`. */
  dataDir?: string;
  /** The text to be drawn (lyrics and title). A bundled cut (the Latin cut of a Japanese face) stands in for the full face when the text has no CJK character; without `text` only full faces count. */
  text?: string;
}
export interface DownloadOptions extends Common {
  dataDir: string;
  /** Overrides PEESUTO_FONT_PACKS_URL and the manifest's baseUrl. */
  baseUrl?: string;
  signal?: AbortSignal;
  /** Bytes downloaded so far and in all (for this call's packs). */
  onProgress?: (done: number, total: number) => void;
}
export interface EnsureOptions extends DownloadOptions { text?: string }

// ── local resolution ────────────────────────────────────────────────────────

/** Installed packs live here: `<dataDir>/fonts/jizura`. */
export function fontPacksRoot(dataDir: string): string { return join(dataDir, "fonts", "jizura"); }
const dirName = (p: ManifestPack): string => `${p.id}@${p.sha256.slice(0, 12)}`;
const MARKER = ".pack.json";

/** Cheap check (a marker and every file at its size): is this pack installed? */
function installedSync(root: string, pack: ManifestPack): boolean {
  const dir = join(root, dirName(pack));
  try {
    const m = JSON.parse(readFileSync(join(dir, MARKER), "utf8")) as { sha256?: unknown };
    if (m.sha256 !== pack.sha256) return false;
    for (const f of [...pack.families, ...pack.licenses]) if (statSync(join(dir, f.file)).size !== f.bytes) return false;
    return true;
  } catch { return false; }
}

interface DevFace { weight: number; style: "normal" | "italic"; path: string }

/** Family names some upstream files declare, for the name JIZURA asks for (the dev override matches by name table). */
export const FAMILY_ALIASES: Readonly<Record<string, string>> = {
  "Rounded Mplus 1c": "M PLUS Rounded 1c",
};
let devCache: { dir: string; key: string; faces: Map<string, DevFace[]> } | null = null;

/** PEESUTO_JIZURA_FONTS_DIR: family → files, from each font's own name table (re-read when the directory changes). */
function devFaces(): Map<string, DevFace[]> | null {
  const dir = process.env.PEESUTO_JIZURA_FONTS_DIR?.trim();
  if (!dir) return null;
  let names: string[];
  try { names = readdirSync(dir).filter((n) => /\.(ttf|otf|ttc|woff2?)$/i.test(n)).sort(); } catch { return new Map(); }
  const key = names.map((n) => { try { const s = statSync(join(dir, n)); return `${n}:${s.size}:${s.mtimeMs}`; } catch { return n; } }).join("\n");
  if (devCache && devCache.dir === dir && devCache.key === key) return devCache.faces;
  const faces = new Map<string, DevFace[]>();
  for (const n of names) {
    const path = join(dir, n);
    try {
      for (const f of fontFaces(readFileSync(path))) {
        const names = new Set(f.names.flatMap((n) => (FAMILY_ALIASES[n] ? [n, FAMILY_ALIASES[n]] : [n])));
        for (const n of names) {
          const list = faces.get(n) ?? [];
          list.push({ weight: f.weight, style: f.style, path });
          faces.set(n, list);
        }
      }
    } catch { /* not a font we can read: ignored */ }
  }
  devCache = { dir, key, faces };
  return faces;
}

/**
 * What a Latin cut leaves out of a CJK face: hangul, CJK radicals to the
 * unified ideographs (kana, CJK symbols and punctuation, bopomofo, enclosed
 * and compatibility forms included), compatibility ideographs, vertical and
 * compatibility forms, half- and full-width forms, enclosed ideographs, and
 * the supplementary ideograph planes. Everything else the face has is kept.
 */
export const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x11ff], [0x2e80, 0x9fff], [0xa960, 0xa97f], [0xac00, 0xd7ff], [0xf900, 0xfaff],
  [0xfe10, 0xfe1f], [0xfe30, 0xfe4f], [0xff00, 0xffef], [0x1f200, 0x1f2ff], [0x20000, 0x3ffff],
];

/** A cut stands in for its full face when the text has none of the characters it lacks (without text: never). */
function covers(f: ManifestFont, text: string | undefined): boolean {
  if (!f.lacks) return true;
  if (text === undefined) return false;
  for (const ch of text) {
    const u = ch.codePointAt(0)!;
    if (u === 0x3000) continue;                        // the ideographic space is not drawn
    if (f.lacks.some(([a, b]) => u >= a && u <= b)) return false;
  }
  return true;
}

/**
 * The font files on this machine for `families` (bundled, installed packs,
 * and the PEESUTO_JIZURA_FONTS_DIR override), and the families that have
 * none. Synchronous and local: never touches the network.
 */
export function jizuraFontFiles(families: readonly string[], opts: ResolveOptions = {}): { files: JizuraFontFile[]; missing: string[] } {
  const manifest = opts.manifest ?? jizuraPackManifest();
  const bundledDir = opts.bundledDir ?? BUNDLED_DIR;
  const dev = devFaces();
  const root = opts.dataDir ? fontPacksRoot(opts.dataDir) : null;
  const installed = root ? manifest.packs.filter((p) => installedSync(root, p)) : [];
  const files: JizuraFontFile[] = [], missing: string[] = [];
  for (const family of [...new Set(families)]) {
    const own = dev?.get(family);
    if (own?.length) { for (const f of own) files.push({ family, weight: f.weight, style: f.style, path: f.path }); continue; }
    const found: JizuraFontFile[] = [];
    for (const p of installed) for (const f of p.families) if (f.family === family) found.push({ family, weight: f.weight, style: f.style, path: join(root!, dirName(p), f.file) });
    const bundled = manifest.bundled.families.filter((f) => f.family === family && existsSync(join(bundledDir, f.file)));
    const full = bundled.filter((f) => !f.lacks);
    for (const f of full) found.push({ family, weight: f.weight, style: f.style, path: join(bundledDir, f.file) });
    if (!found.length) {
      const subset = bundled.filter((f) => f.lacks);
      if (subset.length && subset.every((f) => covers(f, opts.text))) for (const f of subset) found.push({ family, weight: f.weight, style: f.style, path: join(bundledDir, f.file), cut: true });
    }
    if (found.length) files.push(...found); else missing.push(family);
  }
  return { files, missing };
}

/** The pack that has the full face of `family` (null: bundled in full, or unknown). */
function packFor(manifest: JizuraPackManifest, family: string): ManifestPack | null {
  if (manifest.bundled.families.some((f) => f.family === family && !f.lacks)) return null;
  return manifest.packs.find((p) => p.families.some((f) => f.family === family)) ?? null;
}

/** The downloadable packs with the full faces of `families`, in manifest order (a family bundled in full, or in no pack, adds none). */
export function fontPacksFor(families: readonly string[], opts: Common = {}): ManifestPack[] {
  const manifest = opts.manifest ?? jizuraPackManifest();
  const ids = new Set(families.map((f) => packFor(manifest, f)?.id));
  return manifest.packs.filter((p) => ids.has(p.id));
}

/**
 * `jizuraFontFiles`, after downloading and installing whatever packs the
 * missing families are in (and checking, once per process, that the packs
 * it relies on are intact; a damaged one is downloaded again). Throws a
 * FontPackError when a needed pack cannot be had (offline, no host, network,
 * a bad file, aborted); families no pack has are returned as `missing`.
 */
export async function ensureJizuraFonts(families: readonly string[], opts: EnsureOptions): Promise<{ files: JizuraFontFile[]; missing: string[] }> {
  const manifest = opts.manifest ?? jizuraPackManifest();
  const bundledDir = opts.bundledDir ?? BUNDLED_DIR;
  const dev = devFaces();
  const local = jizuraFontFiles(families, opts);
  const need = new Map<string, ManifestPack>();
  for (const family of new Set(families)) {
    if (dev?.get(family)?.length) continue;
    const p = packFor(manifest, family);
    if (!p) continue;                                   // bundled in full, or no pack has it
    // drawn from a bundled subset that has every character of the text: no pack needed
    if (!local.missing.includes(family) && local.files.some((f) => f.family === family && f.path.startsWith(bundledDir))) continue;
    need.set(p.id, p);                                  // missing, or installed (then only checked)
  }
  const packs = [...need.values()];
  // progress counts the packs that are not installed; one found damaged joins the total when it starts downloading
  const root = fontPacksRoot(opts.dataDir);
  const counted = new Set(packs.filter((p) => !installedSync(root, p)).map((p) => p.id));
  let total = packs.filter((p) => counted.has(p.id)).reduce((s, p) => s + p.bytes, 0);
  const done = new Map<string, number>();
  const report = opts.onProgress;
  for (const p of packs) {
    await installFontPack(p.id, {
      ...opts,
      onProgress: report ? (d) => {
        if (!counted.has(p.id)) { counted.add(p.id); total += p.bytes; }
        done.set(p.id, d);
        report([...done.values()].reduce((s, x) => s + x, 0), total);
      } : undefined,
    });
  }
  return jizuraFontFiles(families, opts);
}

// ── status, install, remove ─────────────────────────────────────────────────

export interface FontPackStatus {
  id: string;
  title: Titles;
  /** Download size (bundled: size on disk). */
  bytes: number;
  installed: boolean;
  bundled: boolean;
  /** A download for it is running in this process. */
  installing: boolean;
  langs: JizuraLang[];
  families: string[];
}

/** Every pack, bundled base first, and whether it is installed (a cheap local check). */
export function fontPackStatus(opts: { dataDir: string } & Common): FontPackStatus[] {
  const manifest = opts.manifest ?? jizuraPackManifest();
  const root = fontPacksRoot(opts.dataDir);
  const uniq = (fs: readonly ManifestFont[]) => [...new Set(fs.map((f) => f.family))];
  const b = manifest.bundled;
  return [
    { id: BUNDLED_ID, title: b.title, bytes: [...b.families, ...b.licenses].reduce((s, f) => s + f.bytes, 0), installed: true, bundled: true, installing: false, langs: [...ALL], families: uniq(b.families) },
    ...manifest.packs.map((p) => ({
      id: p.id, title: p.title, bytes: p.bytes, installed: installedSync(root, p), bundled: false,
      installing: inflight.has(jobKey(root, p)), langs: [...p.langs], families: uniq(p.families),
    })),
  ];
}

interface Job {
  promise: Promise<boolean>;
  controller: AbortController;
  callers: number;
  listeners: Set<(done: number, total: number) => void>;
}
const inflight = new Map<string, Job>();
const verified = new Map<string, number>();
const jobKey = (root: string, p: ManifestPack) => `${root}\0${dirName(p)}`;

/**
 * Download and install one pack (a no-op when it is installed and intact).
 * Resolves `{ downloaded }`; rejects with FontPackError.
 */
export async function installFontPack(id: string, opts: DownloadOptions): Promise<{ id: string; dir: string; downloaded: boolean }> {
  const manifest = opts.manifest ?? jizuraPackManifest();
  if (id === BUNDLED_ID) throw new FontPackError("bundled", "the base fonts come with the app and are not downloaded");
  const pack = manifest.packs.find((p) => p.id === id);
  if (!pack) throw new FontPackError("unknown-pack", `no font pack ${JSON.stringify(id)}`);
  const root = fontPacksRoot(opts.dataDir);
  const dir = join(root, dirName(pack));
  if (opts.signal?.aborted) throw aborted(opts.signal);
  const key = jobKey(root, pack);
  let job = inflight.get(key);
  if (!job) {
    const baseUrl = opts.baseUrl || process.env.PEESUTO_FONT_PACKS_URL?.trim() || manifest.baseUrl;
    const controller = new AbortController();
    const listeners = new Set<(d: number, t: number) => void>();
    const run = async (): Promise<boolean> => {
      if (await intact(dir, pack)) return false;
      return install(root, pack, packUrl(pack, baseUrl), controller.signal, (d, t) => { for (const l of listeners) l(d, t); });
    };
    const j: Job = { controller, listeners, callers: 0, promise: run().finally(() => inflight.delete(key)) };
    j.promise.catch(() => {});
    inflight.set(key, j);                               // set in the same tick: a second caller joins this job
    job = j;
  }
  return { id, dir, downloaded: await follow(job, opts.signal, opts.onProgress) };
}

/** Follow a shared job as one caller: leaving (abort) detaches, and the last caller to leave stops the download. */
function follow(job: Job, signal: AbortSignal | undefined, onProgress: ((d: number, t: number) => void) | undefined): Promise<boolean> {
  job.callers++;
  let last = 0, left = false, settled = false;
  const listener = onProgress ? (d: number, t: number) => { const now = Date.now(); if (d === t || now - last >= 100) { last = now; onProgress(d, t); } } : null;
  if (listener) job.listeners.add(listener);
  return new Promise<boolean>((resolve, reject) => {
    const leave = () => {
      if (left) return;
      left = true;
      if (listener) job.listeners.delete(listener);
      signal?.removeEventListener("abort", onAbort);
      if (--job.callers === 0 && !settled) job.controller.abort();
    };
    const onAbort = () => { leave(); reject(aborted(signal!)); };
    signal?.addEventListener("abort", onAbort, { once: true });
    job.promise.then(
      (v) => { settled = true; if (!left) { leave(); resolve(v); } },
      (e) => { settled = true; if (!left) { leave(); reject(e); } },
    );
  });
}

/** Remove an installed pack (every version of it), stopping its download if one is running here. */
export async function removeFontPack(id: string, opts: { dataDir: string } & Common): Promise<{ removed: boolean }> {
  const manifest = opts.manifest ?? jizuraPackManifest();
  if (id === BUNDLED_ID) throw new FontPackError("bundled", "the base fonts come with the app and cannot be removed");
  const pack = manifest.packs.find((p) => p.id === id);
  if (!pack) throw new FontPackError("unknown-pack", `no font pack ${JSON.stringify(id)}`);
  const root = fontPacksRoot(opts.dataDir);
  const job = inflight.get(jobKey(root, pack));
  if (job) { job.controller.abort(); await job.promise.catch(() => {}); }
  let removed = false;
  for (const base of [root, join(root, PARTIAL)]) {
    let names: string[] = [];
    try { names = await readdir(base); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith(`${id}@`)) continue;
      if (base === root) removed = true;
      await rm(join(base, n), { recursive: true, force: true });
    }
  }
  for (const k of verified.keys()) if (k.startsWith(join(root, `${id}@`))) verified.delete(k);
  return { removed };
}

// ── installing ──────────────────────────────────────────────────────────────

const PARTIAL = ".partial";
const STALL_MS = 30_000;

function aborted(signal: AbortSignal): FontPackError {
  const r = signal.reason as { message?: string } | undefined;
  return new FontPackError("aborted", `font pack download aborted${r?.message ? `: ${r.message}` : ""}`);
}

export function packUrl(pack: ManifestPack, baseUrl: string): string {
  let base: URL;
  try { base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`); } catch { throw new FontPackError("unconfigured", `font pack host is not a URL: ${baseUrl}`); }
  if (base.hostname.endsWith(".invalid")) throw new FontPackError("unconfigured", "no font pack host has been configured yet (set PEESUTO_FONT_PACKS_URL)");
  const u = new URL(pack.file, base);
  secure(u);
  return u.toString();
}

function secure(u: URL): void {
  if (u.protocol === "https:") return;
  if (u.protocol === "http:" && isLocalHost(u.hostname)) return;
  throw new FontPackError("insecure", `font packs are only downloaded over HTTPS (got ${u.protocol}//${u.host})`);
}

/** Installed and intact: the cheap check, then (once per process and marker) every file's SHA-256. */
async function intact(dir: string, pack: ManifestPack): Promise<boolean> {
  if (!installedSync(dirname(dir), pack)) return false;
  let mtime: number;
  try { mtime = (await stat(join(dir, MARKER))).mtimeMs; } catch { return false; }
  if (verified.get(dir) === mtime) return true;
  for (const f of [...pack.families, ...pack.licenses]) if ((await sha256File(join(dir, f.file))) !== f.sha256) return false;
  verified.set(dir, mtime);
  return true;
}

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest("hex");
}

async function install(root: string, pack: ManifestPack, url: string, signal: AbortSignal, progress: (d: number, t: number) => void): Promise<boolean> {
  if (isOffline()) throw new FontPackError("offline", `offline mode is on, so the ${pack.id} fonts were not downloaded`);
  const partial = join(root, PARTIAL);
  await mkdir(partial, { recursive: true });
  const name = dirName(pack);
  const dir = join(root, name);
  const release = await lock(join(partial, `${name}.lock`), signal);
  try {
    if (await intact(dir, pack)) return false;           // another process installed it while we waited
    const part = join(partial, `${name}.tar.part`);
    await download(url, part, pack, signal, progress);
    const tmp = join(partial, `${name}.${process.pid}-${randomBytes(4).toString("hex")}`);
    await mkdir(tmp);
    try {
      let entries;
      try { entries = await extractTar(part, tmp); }
      catch (e) { await rm(part, { force: true }); throw new FontPackError("corrupt", `${pack.id}: ${(e as Error).message}`); }
      const want = new Map([...pack.families, ...pack.licenses].map((f) => [f.file, f]));
      if (entries.length !== want.size || entries.some((e) => !want.has(e.name))) {
        await rm(part, { force: true });
        throw new FontPackError("corrupt", `${pack.id}: the pack's files do not match the manifest`);
      }
      for (const f of want.values()) {
        if ((await stat(join(tmp, f.file))).size !== f.bytes || (await sha256File(join(tmp, f.file))) !== f.sha256) {
          await rm(part, { force: true });
          throw new FontPackError("corrupt", `${pack.id}: ${f.file} does not match the manifest`);
        }
      }
      await writeFile(join(tmp, MARKER), JSON.stringify({ id: pack.id, sha256: pack.sha256, bytes: pack.bytes, installedAt: new Date().toISOString() }) + "\n");
      if (signal.aborted) throw aborted(signal);
      if (existsSync(dir)) {
        const trash = `${tmp}.old`;
        await rename(dir, trash);
        await rename(tmp, dir);
        await rm(trash, { recursive: true, force: true });
      } else await rename(tmp, dir);
    } finally { await rm(tmp, { recursive: true, force: true }); }
    await rm(part, { force: true });
    verified.delete(dir);
    // older versions of this pack
    for (const n of await readdir(root)) if (n.startsWith(`${pack.id}@`) && n !== name) await rm(join(root, n), { recursive: true, force: true });
    return true;
  } finally { await release(); }
}

/** One process at a time per pack: an exclusive lock file holding our pid; a dead holder's lock is taken over. */
async function lock(path: string, signal: AbortSignal): Promise<() => Promise<void>> {
  for (;;) {
    if (signal.aborted) throw aborted(signal);
    try {
      const fh = await open(path, "wx");
      try { await fh.writeFile(String(process.pid)); } finally { await fh.close(); }
      return () => rm(path, { force: true });
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    let pid = NaN, age = 0;
    try { pid = Number((await readFile(path, "utf8")).trim()); age = Date.now() - (await stat(path)).mtimeMs; } catch { continue; }
    const fresh = !Number.isFinite(pid) && age < 5_000;  // just created, pid not written yet
    if (!fresh && (pid === process.pid || !alive(pid))) { await rm(path, { force: true }); continue; }
    await sleep(250, signal);
  }
}

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
  const stop = () => { clearTimeout(t); reject(aborted(signal)); };
  signal.addEventListener("abort", stop, { once: true });
});

/**
 * Stream `url` into `part`, resuming a part left by an interrupted download
 * (Range), and check size and SHA-256. A part that fails the hash is deleted;
 * one cut short by the network is kept for the next attempt.
 */
async function download(url: string, part: string, pack: ManifestPack, signal: AbortSignal, progress: (d: number, t: number) => void): Promise<void> {
  let have = 0;
  try { have = (await stat(part)).size; } catch { have = 0; }
  if (have > pack.bytes) { await rm(part, { force: true }); have = 0; }
  let hash = createHash("sha256");
  if (have > 0) for await (const chunk of Bun.file(part).stream()) hash.update(chunk);
  const mismatch = async () => { await rm(part, { force: true }); return new FontPackError("sha256", `${pack.id}: the downloaded file does not match its SHA-256`); };
  if (have === pack.bytes) {                            // complete part from an attempt that stopped before unpacking
    progress(have, pack.bytes);
    if (hash.digest("hex") !== pack.sha256) throw await mismatch();
    return;
  }
  const stall = new AbortController();
  let timer = setTimeout(() => stall.abort(), STALL_MS);
  const both = AbortSignal.any([signal, stall.signal]);
  const t0 = performance.now();
  let res: Logged;
  try { res = await request(pack.id, url, have, both); }
  catch (e) { clearTimeout(timer); throw netError(e, signal, stall.signal, url); }
  const log = (extra: Partial<EgressLogLine>) => logLine({ ...res.log, status: res.status, ms: Math.round(performance.now() - t0), ...extra });
  const range = /^bytes (\d+)-/.exec(res.headers.get("content-range") ?? "");
  const resumes = res.status === 206 && have > 0 && !!range && Number(range[1]) === have;
  if (!resumes && res.status !== 200) {
    clearTimeout(timer);
    await res.body?.cancel().catch(() => {});
    await log({});
    if (have > 0 && (res.status === 206 || res.status === 416)) {       // our part does not fit what is served: start over
      await rm(part, { force: true });
      return download(url, part, pack, signal, progress);
    }
    throw new FontPackError("http", `${pack.id}: ${new URL(url).host} answered HTTP ${res.status}`);
  }
  if (!resumes) { have = 0; hash = createHash("sha256"); }
  const fh = await open(part, resumes ? "a" : "w");
  let bytesIn = 0;
  try {
    const reader = res.body!.getReader();
    progress(have, pack.bytes);
    for (;;) {
      let r: Awaited<ReturnType<typeof reader.read>>;
      try { r = await reader.read(); } catch (e) { throw netError(e, signal, stall.signal, url); }
      if (r.done) break;
      const chunk = r.value;
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(), STALL_MS);
      if (have + chunk.length > pack.bytes) {
        await reader.cancel().catch(() => {});
        await fh.close().catch(() => {});
        await rm(part, { force: true });
        throw new FontPackError("size", `${pack.id}: the server sent more than the ${pack.bytes} bytes expected`);
      }
      await fh.write(chunk);
      hash.update(chunk);
      have += chunk.length;
      bytesIn += chunk.length;
      progress(have, pack.bytes);
    }
  } finally {
    clearTimeout(timer);
    await fh.close().catch(() => {});
    await log({ bytesIn });
  }
  if (have !== pack.bytes) throw new FontPackError("size", `${pack.id}: the download ended after ${have} of ${pack.bytes} bytes`);
  if (hash.digest("hex") !== pack.sha256) throw await mismatch();
}

function netError(e: unknown, caller: AbortSignal, stall: AbortSignal, url: string): FontPackError {
  if (e instanceof FontPackError) return e;
  if (caller.aborted) return aborted(caller);
  if (stall.aborted) return new FontPackError("timeout", `${new URL(url).host} stopped sending for ${STALL_MS / 1000} s`);
  return new FontPackError("network", `${new URL(url).host}: ${(e as Error).message}`);
}

type Logged = Response & { log: EgressLogLine };

/** GET with manual redirects, so every hop is checked to be HTTPS. Only Range (when resuming) is sent besides the basics. */
async function request(id: string, url: string, from: number, signal: AbortSignal): Promise<Logged> {
  let u = new URL(url);
  for (let hop = 0; hop < 6; hop++) {
    secure(u);
    const line: EgressLogLine = { at: new Date().toISOString(), host: u.host, purpose: `fonts:${id}`, bytesOut: 0, bytesIn: 0, status: 0, ms: 0, ...(isLocalHost(u.hostname) ? { local: true as const } : {}) };
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(u, {
        redirect: "manual",
        signal,
        headers: { "user-agent": "Peesuto", accept: "*/*", "accept-encoding": "identity", ...(from > 0 ? { range: `bytes=${from}-` } : {}) },
      });
    } catch (e) {
      await logLine({ ...line, ms: Math.round(performance.now() - t0), error: signal.aborted ? "timeout" : "network" });
      throw e;
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      await res.body?.cancel();
      await logLine({ ...line, status: res.status, ms: Math.round(performance.now() - t0) });
      const loc = res.headers.get("location");
      if (!loc) throw new FontPackError("http", `${u.host} redirected without a location`);
      u = new URL(loc, u);
      continue;
    }
    return Object.assign(res, { log: line });
  }
  throw new FontPackError("http", "too many redirects");
}

async function logLine(line: EgressLogLine): Promise<void> {
  const path = egressLogPath();
  if (!path) return;
  try { await mkdir(dirname(path), { recursive: true }); await appendFile(path, `${JSON.stringify(line)}\n`); } catch { /* the egress layer warns about an unwritable log */ }
}
