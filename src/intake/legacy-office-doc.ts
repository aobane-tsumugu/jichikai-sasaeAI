// MS-DOCのFIBが指すpiece tableから、本文だけを文字の順に取り出す。
// 仕様: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/01d5d8c4-cf9c-4ef9-80fd-439e763cfe01
import type { ExtractedDocument } from "./direct-reading";
import { checked, CompoundOffice, slice, view } from "./legacy-office-cfb";

// FcCompressedの8ビット文字に対する、仕様の例外表。
const COMPRESSED_CODES = new Map([
  [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026], [0x86, 0x2020], [0x87, 0x2021],
  [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160], [0x8b, 0x2039], [0x8c, 0x0152], [0x91, 0x2018],
  [0x92, 0x2019], [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
  [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153], [0x9f, 0x0178],
]);

export function extractLegacyWord(file: CompoundOffice): ExtractedDocument {
  const word = file.stream("WordDocument");
  checked(word);
  const fib = view(word);
  checked(fib.getUint16(0, true) === 0xa5ec && fib.getUint16(2, true) >= 0xc1);
  const flags = fib.getUint16(10, true);
  checked(!(flags & 0x0100)); // 暗号化とXORの保護を解除しない。
  const table = file.stream(flags & 0x0200 ? "1Table" : "0Table");
  checked(table);
  let p = 32;
  p += 2 + fib.getUint16(p, true) * 2;
  const longCount = fib.getUint16(p, true);
  checked(longCount >= 4);
  const textLength = fib.getUint32(p + 2 + 12, true);
  checked(textLength <= 400_000);
  p += 2 + longCount * 4;
  checked(fib.getUint16(p, true) > 33);
  const pair = p + 2 + 33 * 8;
  const clx = slice(table, fib.getUint32(pair, true), fib.getUint32(pair + 4, true));
  const data = view(clx);
  p = 0;
  while (clx[p] === 1) p += 3 + data.getUint16(p + 1, true);
  checked(clx[p] === 2);
  const plc = view(slice(clx, p + 5, data.getUint32(p + 1, true)));
  const count = (plc.byteLength - 4) / 12;
  checked(Number.isInteger(count) && count > 0 && plc.getUint32(0, true) === 0);
  checked(plc.getUint32(count * 4, true) >= textLength);
  const pieces: string[] = [];
  for (let i = 0; i < count; i++) {
    const start = plc.getUint32(i * 4, true);
    const end = plc.getUint32((i + 1) * 4, true);
    checked(end > start);
    if (start >= textLength) continue;
    const fc = plc.getUint32((count + 1) * 4 + i * 8 + 2, true);
    const compressed = !!(fc & 0x40000000);
    const offset = (fc & 0x3fffffff) / (compressed ? 2 : 1);
    const size = (Math.min(end, textLength) - start) * (compressed ? 1 : 2);
    const bytes = slice(word, offset, size);
    if (compressed) {
      let text = "";
      for (const b of bytes) text += String.fromCharCode(COMPRESSED_CODES.get(b) ?? b);
      pieces.push(text);
    } else pieces.push(new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(bytes));
  }
  // フィールドの命令は本文に混ぜず、保存済みの表示文字だけを残す。
  const fields: boolean[] = [];
  const body: string[] = [];
  for (const ch of pieces.join("")) {
    if (ch === "\u0013") { checked(fields.length < 128); fields.push(false); }
    else if (ch === "\u0014" && fields.length) fields[fields.length - 1] = true;
    else if (ch === "\u0015") fields.pop();
    else if (fields.every(Boolean)) body.push(ch);
  }
  const text = body.join("").replace(/[\r\u000b\u000c]/g, "\n").replace(/\u0007/g, "\t")
    .replace(/[\u0000-\u0008\u000e-\u001f]/g, "");
  return { format: "doc", paragraphs: text.split("\n"), tables: [] };
}
