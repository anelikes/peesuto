/**
 * QR codes for any text. The data is encoded byte for byte as UTF-8 with
 * error correction M, falling back to L when M cannot hold it; beyond version
 * 40 at L (2,953 bytes, about 980 Chinese characters) it is an explicit error.
 */
import qrcode from "qrcode-generator";
import { ComposeError } from "../render/compose.ts";

qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"]!;

export interface QrMatrix { readonly size: number; readonly level: "M" | "L"; isDark(row: number, col: number): boolean }

/** Largest UTF-8 payload a QR code carries (version 40, level L, byte mode). */
export const QR_MAX_BYTES = 2953;

export function encodeQr(data: string): QrMatrix {
  for (const level of ["M", "L"] as const) {
    try {
      const code = qrcode(0, level);
      code.addData(data, "Byte");
      code.make();
      return { size: code.getModuleCount(), level, isDark: (r, c) => code.isDark(r, c) };
    } catch (error) {
      if (!/overflow/i.test(String(error))) throw error;
    }
  }
  const bytes = new TextEncoder().encode(data).length;
  throw new ComposeError("qr-too-long", `This text is ${bytes} bytes of UTF-8; a QR code holds at most ${QR_MAX_BYTES}. Nothing was truncated.`);
}

/** Dark modules as horizontal runs: one rectangle per run instead of one per module. */
export function qrRuns(matrix: QrMatrix): { row: number; col: number; length: number }[] {
  const runs: { row: number; col: number; length: number }[] = [];
  for (let row = 0; row < matrix.size; row++) {
    let col = 0;
    while (col < matrix.size) {
      if (!matrix.isDark(row, col)) { col++; continue; }
      const start = col;
      while (col < matrix.size && matrix.isDark(row, col)) col++;
      runs.push({ row, col: start, length: col - start });
    }
  }
  return runs;
}
