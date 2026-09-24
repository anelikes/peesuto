#!/usr/bin/env bun
/** Sparkle appcast for peesuto.com: signs a release DMG with Sparkle's `sign_update`
 * (EdDSA key from the login Keychain) and adds its <item> to site/appcast.xml.
 *
 * bun scripts/appcast.ts --dmg <notarized dmg> --build <CFBundleVersion> [--version <short version>]
 *   [--out site/appcast.xml] [--dry-run]
 *
 * --version  defaults to the root package.json version; release notes come from the
 *            matching `## <version>` section of CHANGELOG.md (required).
 * --dry-run  print the feed instead of writing it.
 * Publishes nothing: upload the DMG to the GitHub Release and deploy site/ yourself
 * (docs/RELEASING.md). scripts/release-native.ts runs this after a notarized DMG.
 */
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const FEED_URL = "https://peesuto.com/appcast.xml";
export const MINIMUM_SYSTEM_VERSION = "13.0";
export const DOWNLOAD_BASE = "https://github.com/anelikes/peesuto/releases/download";

export interface AppcastRelease {
  /** CFBundleVersion: the monotonic build number Sparkle compares. */
  build: string;
  /** CFBundleShortVersionString, shown to people. */
  shortVersion: string;
  pubDate: Date;
  url: string;
  length: number;
  edSignature: string;
  /** Markdown bullets from CHANGELOG.md. */
  notes: string;
  minimumSystemVersion?: string;
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** The body of the `## <version>` section (up to the next `## `), or undefined. */
export function changelogSection(changelog: string, version: string): string | undefined {
  const lines = changelog.split("\n");
  const heading = new RegExp(`^## \\[?${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]?(\\s|$)`);
  const start = lines.findIndex(l => heading.test(l));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => l.startsWith("## "));
  const body = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  return body || undefined;
}

/** Changelog Markdown as small, escaped HTML: bullets become a list, `###` headings h3,
 * other lines paragraphs (wrapped lines joined). Inline `code` is kept; the rest is plain text. */
export function notesHtml(markdown: string): string {
  const inline = (text: string) => escapeXml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
  const out: string[] = [];
  let list: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map(i => `<li>${inline(i)}</li>`).join("")}</ul>`);
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    list = []; paragraph = [];
  };
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    const bullet = line.match(/^[-*]\s+(.*)$/);
    const heading = line.match(/^#+\s+(.*)$/);
    if (!line) flush();
    else if (heading) { flush(); out.push(`<h3>${inline(heading[1]!)}</h3>`); }
    else if (bullet) { if (paragraph.length) flush(); list.push(bullet[1]!); }
    else if (list.length && raw.startsWith(" ")) list[list.length - 1] += ` ${line}`;
    else { if (list.length) flush(); paragraph.push(line); }
  }
  flush();
  return out.join("\n");
}

export function renderItem(release: AppcastRelease): string {
  // CDATA cannot contain "]]>"; split it across two sections.
  const html = notesHtml(release.notes).replace(/]]>/g, "]]]]><![CDATA[>");
  return `    <item>
      <title>Version ${escapeXml(release.shortVersion)}</title>
      <pubDate>${release.pubDate.toUTCString()}</pubDate>
      <sparkle:version>${escapeXml(release.build)}</sparkle:version>
      <sparkle:shortVersionString>${escapeXml(release.shortVersion)}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>${escapeXml(release.minimumSystemVersion ?? MINIMUM_SYSTEM_VERSION)}</sparkle:minimumSystemVersion>
      <description><![CDATA[${html}]]></description>
      <enclosure url="${escapeXml(release.url)}" length="${release.length}" type="application/octet-stream" sparkle:edSignature="${escapeXml(release.edSignature)}"/>
    </item>`;
}

/** The <item> blocks of an existing feed (this generator's own output). */
export function existingItems(xml: string): string[] {
  return xml.match(/ {4}<item>[\s\S]*?<\/item>/g) ?? [];
}

function itemBuild(item: string): number {
  return Number(item.match(/<sparkle:version>(\d+)<\/sparkle:version>/)?.[1] ?? -1);
}

/** The feed with `release` added: an item with the same build is replaced; newest build first. */
export function updateAppcast(existing: string | undefined, release: AppcastRelease): string {
  const items = existingItems(existing ?? "").filter(item => itemBuild(item) !== Number(release.build));
  items.push(renderItem(release));
  items.sort((a, b) => itemBuild(b) - itemBuild(a));
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Peesuto</title>
    <link>${FEED_URL}</link>
    <description>Peesuto updates</description>
    <language>en</language>
${items.join("\n")}
  </channel>
</rss>
`;
}

/** Parses `sign_update` output: `sparkle:edSignature="…" length="…"`. */
export function parseSignUpdate(output: string): { edSignature: string; length: number } {
  const edSignature = output.match(/sparkle:edSignature="([^"]+)"/)?.[1];
  const length = Number(output.match(/length="(\d+)"/)?.[1]);
  if (!edSignature || !Number.isFinite(length) || length <= 0) throw new Error("sign_update printed no signature");
  return { edSignature, length };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const fail = (message: string): never => { console.error(`appcast: ${message}`); process.exit(1); };
  const dmg = resolve(flag("--dmg") ?? fail("--dmg <file> is required"));
  const build = flag("--build") ?? fail("--build <CFBundleVersion> is required");
  if (!/^\d+$/.test(build)) fail(`--build must be a number, got ${build}`);
  const shortVersion = flag("--version") ?? (await Bun.file(join(root, "package.json")).json()).version as string;
  const out = resolve(flag("--out") ?? join(root, "site/appcast.xml"));
  if (!existsSync(dmg)) fail(`no file at ${dmg}`);
  const notes = changelogSection(await Bun.file(join(root, "CHANGELOG.md")).text(), shortVersion)
    ?? fail(`CHANGELOG.md has no "## ${shortVersion}" section; add one before publishing.`);
  const tool = join(root, "native/.build/artifacts/sparkle/Sparkle/bin/sign_update");
  if (!existsSync(tool)) fail(`sign_update not found at ${tool}; run \`swift package resolve --package-path native\`.`);
  // The private key never leaves the Keychain: sign_update reads it there (macOS may ask to allow access).
  const p = Bun.spawn([tool, dmg], { stdout: "pipe", stderr: "inherit" });
  const signed = await new Response(p.stdout).text();
  if (await p.exited !== 0) fail("sign_update failed");
  const { edSignature, length } = parseSignUpdate(signed);
  if (length !== (await stat(dmg)).size) fail("sign_update length does not match the file size");
  const release: AppcastRelease = {
    build, shortVersion, pubDate: new Date(), edSignature, length, notes,
    url: `${DOWNLOAD_BASE}/v${encodeURIComponent(shortVersion)}/${encodeURIComponent(basename(dmg))}`,
  };
  const file = Bun.file(out);
  const feed = updateAppcast(await file.exists() ? await file.text() : undefined, release);
  if (args.includes("--dry-run")) { console.log(feed); process.exit(0); }
  await mkdir(dirname(out), { recursive: true });
  await Bun.write(out, feed);
  console.log(`appcast: ${out} now lists ${shortVersion} (build ${build}) at ${release.url}`);
}
