#!/usr/bin/env bun
/**
 * Regenerates the website's binary assets under site/ from the repository's
 * own sources. Run it when a template preview, the app icon or the fonts
 * change; the outputs are committed, so `bun run site:build` never needs it.
 *
 *   bun scripts/site-assets.ts [--only cards,icons,fonts,backdrop,og]
 *
 * Local tools only (no network): macOS sips and iconutil, cwebp (brew install
 * webp), fontTools' pyftsubset with brotli (pip install fonttools brotli) and
 * Google Chrome for the Open Graph image. What it writes:
 *
 *   site/cards/<template>-<style>.webp   native/Resources/TemplatePreviews/*.png, lossless WebP
 *   site/assets/icon-*.png, favicon.ico  native/Resources/AppIcon.icns
 *   site/assets/fonts/*.woff2            core/src/render/fonts/PeesutoText-*.ttf, Latin + keyboard symbols
 *   site/assets/field-indigo.{webp,jpg}  the code cards' "Indigo night" colour field (core/src/templates/backdrop.ts)
 *   site/assets/grain.png                a small tile of monochrome grain laid over the field
 *   site/og.png                          scripts/site/og.html rendered at 1200×630
 */
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { CODE_FIELDS, fieldPng } from "../core/src/templates/backdrop.ts";

const REPO = resolve(import.meta.dir, "..");
const SITE = join(REPO, "site");
const argv = process.argv.slice(2);
const onlyArg = argv.includes("--only") ? argv[argv.indexOf("--only") + 1]!.split(",") : undefined;
const want = (step: string) => !onlyArg || onlyArg.includes(step);
const scratch = join(tmpdir(), `peesuto-site-${process.pid}`);
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function run(cmd: string[]): Promise<void> {
  const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd[0]} failed (${code}): ${await new Response(p.stderr).text()}`);
}
const size = async (path: string) => (await stat(path)).size;
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true });
await mkdir(join(SITE, "assets/fonts"), { recursive: true });
await mkdir(join(SITE, "cards"), { recursive: true });

try {
  if (want("cards")) {
    const from = join(REPO, "native/Resources/TemplatePreviews");
    let total = 0;
    for (const file of (await readdir(from)).filter((f) => f.endsWith(".png")).sort()) {
      const out = join(SITE, "cards", file.replace(/\.png$/, ".webp"));
      await run(["cwebp", "-quiet", "-lossless", "-z", "9", "-metadata", "none", join(from, file), "-o", out]);
      total += await size(out);
    }
    console.log(`cards → site/cards (${kb(total)})`);
  }

  if (want("icons")) {
    const set = join(scratch, "AppIcon.iconset");
    await run(["iconutil", "-c", "iconset", join(REPO, "native/Resources/AppIcon.icns"), "-o", set]);
    await copyFile(join(set, "icon_32x32@2x.png"), join(SITE, "assets/icon-64.png"));
    await copyFile(join(set, "icon_256x256.png"), join(SITE, "assets/icon-256.png"));
    await run(["sips", "-z", "180", "180", join(set, "icon_256x256.png"), "--out", join(SITE, "apple-touch-icon.png")]);
    await copyFile(join(set, "icon_512x512.png"), join(SITE, "assets/icon-512.png"));
    await Bun.write(join(SITE, "favicon.ico"), ico([await Bun.file(join(set, "icon_32x32.png")).bytes()]));
    console.log("icons → site/assets/icon-*.png, site/apple-touch-icon.png, site/favicon.ico");
  }

  if (want("fonts")) {
    // Headings and keycaps only: ASCII, typographic punctuation and the keyboard symbols
    // the page shows. Chinese headings fall back to the system's PingFang.
    const unicodes = "U+0020-007E,U+00A0,U+00A9,U+00B7,U+00D7,U+2013-2014,U+2018-2019,U+201C-201D,U+2022,U+2026,U+2190-2193,U+21A9,U+21B5,U+21E7,U+2303,U+2318,U+2325,U+238B,U+23CE,U+203A";
    for (const weight of ["Regular", "Bold"]) {
      const out = join(SITE, `assets/fonts/peesuto-mono-${weight.toLowerCase()}.woff2`);
      await run(["pyftsubset", join(REPO, `core/src/render/fonts/PeesutoText-${weight}.ttf`), `--unicodes=${unicodes}`,
        "--flavor=woff2", "--layout-features=kern", "--no-hinting", "--desubroutinize", `--output-file=${out}`]);
      console.log(`font ${weight} → ${out.slice(REPO.length + 1)} (${kb(await size(out))})`);
    }
    await copyFile(join(REPO, "core/src/render/fonts/OFL.txt"), join(SITE, "assets/fonts/OFL.txt"));
  }

  if (want("backdrop")) {
    // The code cards' "Indigo night" field, drawn by the same code. It is a blur, so
    // 1600 px is plenty for the panel at 2x once the grain tile restores the texture.
    const png = join(scratch, "field.png");
    await Bun.write(png, fieldPng(CODE_FIELDS.indigo, { width: 1600, height: 1000 }));
    await run(["cwebp", "-quiet", "-q", "88", "-sharp_yuv", "-metadata", "none", png, "-o", join(SITE, "assets/field-indigo.webp")]);
    await run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "72", "-Z", "1280", png, "--out", join(SITE, "assets/field-indigo.jpg")]);
    await Bun.write(join(SITE, "assets/grain.png"), grainTile(128, 20260924));
    console.log(`backdrop → field-indigo.webp (${kb(await size(join(SITE, "assets/field-indigo.webp")))}), .jpg (${kb(await size(join(SITE, "assets/field-indigo.jpg")))}), grain.png (${kb(await size(join(SITE, "assets/grain.png")))})`);
  }

  if (want("og")) {
    const shot = join(scratch, "og.png");
    await run([CHROME, "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1", `--screenshot=${shot}`,
      "--window-size=1200,630", "--virtual-time-budget=3000", `file://${join(REPO, "scripts/site/og.html")}`]);
    await run(["sips", "-s", "format", "png", shot, "--out", join(SITE, "og.png")]);
    console.log(`og → site/og.png (${kb(await size(join(SITE, "og.png")))})`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

/** A seeded, tileable monochrome grain: grey pixels with a small random alpha. */
function grainTile(side: number, seed: number): Uint8Array {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
  const raw = new Uint8Array(side * (side * 2 + 1));
  for (let y = 0; y < side; y++) {
    raw[y * (side * 2 + 1)] = 0; // filter: none
    for (let x = 0; x < side; x++) {
      const i = y * (side * 2 + 1) + 1 + x * 2;
      const v = rand();
      raw[i] = v < 0.5 ? 0 : 255; // grey-alpha: dark or light speck
      raw[i + 1] = Math.round(Math.abs(v - 0.5) * 2 * 26);
    }
  }
  return png(side, side, 4 /* grey + alpha */, raw);
}

function png(width: number, height: number, colorType: number, raw: Uint8Array): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header.set([8, colorType, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** An .ico wrapping PNG images (supported by every browser that asks for /favicon.ico). */
function ico(images: Uint8Array[]): Uint8Array {
  const head = 6 + images.length * 16;
  const out = new Uint8Array(head + images.reduce((n, i) => n + i.length, 0));
  const view = new DataView(out.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, images.length, true);
  let offset = head;
  images.forEach((img, n) => {
    const w = new DataView(img.buffer, img.byteOffset).getUint32(16);
    const e = 6 + n * 16;
    out[e] = w >= 256 ? 0 : w;
    out[e + 1] = w >= 256 ? 0 : w;
    view.setUint16(e + 4, 1, true);
    view.setUint16(e + 6, 32, true);
    view.setUint32(e + 8, img.length, true);
    view.setUint32(e + 12, offset, true);
    out.set(img, offset);
    offset += img.length;
  });
  return out;
}
