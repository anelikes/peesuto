/**
 * A child for daemon-fonts.test.ts: reads stdin the way the daemon does
 * (Bun.stdin.stream(), a read pending all along), installs a font pack, then
 * prints every stdin line it reads until "bye", or "EOF" if stdin ends first
 * (what a Bun.file stream read to its end did to a Bun.spawn pipe in Bun 1.3:
 * the next chunk arrived, then the read after it ended the stream).
 *
 *   bun install-then-read-stdin.ts <manifest.json> <dataDir> <baseUrl>
 */
import { readFileSync } from "node:fs";
import { installFontPack, parseManifest } from "../../src/fonts/jizura-packs.ts";

const [manifestPath, dataDir, baseUrl] = process.argv.slice(2) as [string, string, string];
const reader = Bun.stdin.stream().getReader();
const reading = (async () => {
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) { console.log("EOF"); return; }
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      console.log(`read ${line}`);
      if (line === "bye") return;
    }
  }
})();
await Bun.sleep(50);                                     // the read is pending before the install starts
const r = await installFontPack("ja", { dataDir, baseUrl, manifest: parseManifest(JSON.parse(readFileSync(manifestPath, "utf8"))) });
console.log(JSON.stringify({ installed: r.downloaded }));
await reading;
process.exit(0);
