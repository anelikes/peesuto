import { describe, expect, test } from "bun:test";
import { changelogSection, existingItems, notesHtml, parseSignUpdate, updateAppcast, type AppcastRelease } from "../../scripts/appcast.ts";

const release = (build: string, shortVersion: string, notes = "- Fixes."): AppcastRelease => ({
  build, shortVersion, notes,
  pubDate: new Date("2026-09-24T08:00:00Z"),
  url: `https://github.com/anelikes/peesuto/releases/download/v${shortVersion}/Peesuto-${shortVersion}-arm64.dmg`,
  length: 1234,
  edSignature: "c2lnbmF0dXJl+/=",
});

describe("appcast", () => {
  test("feed shape", () => {
    const xml = updateAppcast(undefined, release("120", "0.2.0"));
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(xml).toContain('xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"');
    expect(xml).toContain("<sparkle:version>120</sparkle:version>");
    expect(xml).toContain("<sparkle:shortVersionString>0.2.0</sparkle:shortVersionString>");
    expect(xml).toContain("<sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>");
    expect(xml).toContain("<pubDate>Thu, 24 Sep 2026 08:00:00 GMT</pubDate>");
    expect(xml).toContain('<enclosure url="https://github.com/anelikes/peesuto/releases/download/v0.2.0/Peesuto-0.2.0-arm64.dmg" length="1234" type="application/octet-stream" sparkle:edSignature="c2lnbmF0dXJl+/="/>');
    expect(existingItems(xml)).toHaveLength(1);
  });

  test("release notes are escaped", () => {
    const html = notesHtml("- Paste <b>bold</b> & \"quotes\" with `a<b`\n  continued\n- ]]> survives");
    expect(html).toBe("<ul><li>Paste &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quotes&quot; with <code>a&lt;b</code> continued</li><li>]]&gt; survives</li></ul>");
    expect(notesHtml("Intro line\nwrapped.\n\n### Added\n\n- One")).toBe("<p>Intro line wrapped.</p>\n<h3>Added</h3>\n<ul><li>One</li></ul>");
    const xml = updateAppcast(undefined, release("1", "0.1.0", "- a ]]> b"));
    expect(xml).toContain("<description><![CDATA[<ul><li>a ]]&gt; b</li></ul>]]></description>");
  });

  test("newest build first; same build replaced", () => {
    let xml = updateAppcast(undefined, release("100", "0.1.1"));
    xml = updateAppcast(xml, release("130", "0.3.0"));
    xml = updateAppcast(xml, release("120", "0.2.0"));
    xml = updateAppcast(xml, release("120", "0.2.0", "- Rebuilt."));
    const builds = existingItems(xml).map(item => item.match(/<sparkle:version>(\d+)</)![1]);
    expect(builds).toEqual(["130", "120", "100"]);
    expect(xml).toContain("Rebuilt.");
    expect(xml.match(/Fixes\./g)).toHaveLength(2);
  });

  test("changelog section and sign_update output", () => {
    const changelog = "# Changelog\n\n## Unreleased\n\n- Next.\n\n## 0.1.1 — 2026-09-23\n\n- One.\n- Two.\n\n## 0.1.0 — 2026-09-22\n\n- Zero.\n";
    expect(changelogSection(changelog, "0.1.1")).toBe("- One.\n- Two.");
    expect(changelogSection(changelog, "0.1")).toBeUndefined();
    expect(changelogSection(changelog, "9.9.9")).toBeUndefined();
    expect(parseSignUpdate('sparkle:edSignature="abc+/=" length="42"\n')).toEqual({ edSignature: "abc+/=", length: 42 });
    expect(() => parseSignUpdate("")).toThrow();
  });
});
