/** Just enough of ISO BMFF to check an MP4 without ffprobe: top-level box
 * order (faststart), the video sample entry, avcC profile and chroma format,
 * the colour box, sample count and duration. Test-only. */
export interface Mp4Facts {
  readonly top: string[];
  readonly codec?: string;
  readonly profile?: number;
  readonly chroma?: number;
  readonly size?: [number, number];
  readonly samples?: number;
  readonly durationSeconds?: number;
  readonly colour?: { primaries: number; transfer: number; matrix: number; fullRange: boolean };
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

export function mp4Boxes(bytes: Uint8Array): Mp4Facts {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = (at: number) => String.fromCharCode(...bytes.subarray(at + 4, at + 8));
  const facts: { -readonly [K in keyof Mp4Facts]: Mp4Facts[K] } = { top: [] };
  const walk = (start: number, end: number, depth: number, handler: string | undefined) => {
    let at = start;
    let hdlr = handler;
    while (at + 8 <= end) {
      let size = view.getUint32(at);
      let header = 8;
      if (size === 1) { size = Number(view.getBigUint64(at + 8)); header = 16; }
      if (size === 0) size = end - at;
      if (size < header || at + size > end) break;
      const t = type(at);
      const body = at + header;
      if (depth === 0) facts.top.push(t);
      if (t === "hdlr") hdlr = String.fromCharCode(...bytes.subarray(body + 8, body + 12));
      // Inside mdia the order is mdhd, hdlr, minf: the handler is known by the time stsd is read.
      if (CONTAINERS.has(t)) walk(body, at + size, depth + 1, hdlr);
      if (t === "mdhd") {
        const version = bytes[body]!;
        const timescale = version === 1 ? view.getUint32(body + 20) : view.getUint32(body + 12);
        const duration = version === 1 ? Number(view.getBigUint64(body + 24)) : view.getUint32(body + 16);
        pendingDuration = duration / timescale;
      }
      if (t === "stsd" && hdlr === "vide") {
        const entry = body + 8;
        facts.codec = type(entry);
        facts.size = [view.getUint16(entry + 32), view.getUint16(entry + 34)];
        facts.durationSeconds = pendingDuration;
        // Sample entry: 8 header + 78 bytes of VisualSampleEntry fields, then child boxes.
        walkEntry(entry + 86, entry + view.getUint32(entry));
      }
      if (t === "stsz" && hdlr === "vide") facts.samples = view.getUint32(body + 8);
      at += size;
    }
  };
  let pendingDuration: number | undefined;
  const walkEntry = (start: number, end: number) => {
    let at = start;
    while (at + 8 <= end) {
      const size = view.getUint32(at);
      if (size < 8) break;
      const t = type(at), body = at + 8;
      if (t === "avcC") {
        facts.profile = bytes[body + 1];
        // Skip SPS and PPS lists; High profiles carry chroma_format after them.
        let p = body + 5;
        const sps = bytes[p]! & 0x1f; p++;
        for (let i = 0; i < sps; i++) p += 2 + view.getUint16(p);
        const pps = bytes[p]!; p++;
        for (let i = 0; i < pps; i++) p += 2 + view.getUint16(p);
        if (p < at + size) facts.chroma = bytes[p]! & 0x03;
      }
      if (t === "colr") {
        const k = String.fromCharCode(...bytes.subarray(body, body + 4)); // nclx (MP4) or nclc (QuickTime)
        facts.colour = { primaries: view.getUint16(body + 4), transfer: view.getUint16(body + 6), matrix: view.getUint16(body + 8),
          fullRange: k === "nclx" ? (bytes[body + 10]! & 0x80) !== 0 : false };
      }
      at += size;
    }
  };
  walk(0, bytes.byteLength, 0, undefined);
  return facts;
}
