// BIFF8の共有文字列とセルを読む。数式は再計算せず、保存済みの結果を使う。
// 仕様: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xls/
import type { ExtractedDocument } from "./direct-reading";
import { checked, CompoundOffice, slice, view } from "./legacy-office-cfb";

interface RecordData { id: number; offset: number; bytes: Uint8Array }

function records(bytes: Uint8Array): RecordData[] {
  const result: RecordData[] = [];
  const data = view(bytes);
  for (let p = 0; p < bytes.length;) {
    checked(p + 4 <= bytes.length);
    const id = data.getUint16(p, true);
    const size = data.getUint16(p + 2, true);
    // 古いブックには流れの末尾にゼロの余白がある。
    if (id === 0 && size === 0) { checked(bytes.subarray(p).every((b) => b === 0)); break; }
    checked(result.length < 400_000);
    result.push({ id, offset: p, bytes: slice(bytes, p + 4, size) });
    p += 4 + size;
  }
  return result;
}

/** SSTのCONTINUE境界では、文字の途中にだけ文字幅の印が入る。 */
class Strings {
  private index = 0;
  private offset = 0;
  constructor(private readonly blocks: Uint8Array[]) {}
  private get block(): Uint8Array { const b = this.blocks[this.index]; checked(b); return b; }
  private next(): void { this.index++; this.offset = 0; checked(this.blocks[this.index]); }
  byte(): number {
    if (this.offset === this.block.length) this.next();
    const b = this.block[this.offset++]; checked(b !== undefined); return b;
  }
  uint16(): number { return this.byte() + this.byte() * 256; }
  uint32(): number { return this.uint16() + this.uint16() * 65536; }
  skip(count: number): void {
    checked(count <= 25 * 1024 * 1024);
    for (let left = count; left > 0;) {
      if (this.offset === this.block.length) this.next();
      const take = Math.min(left, this.block.length - this.offset);
      this.offset += take;
      left -= take;
    }
  }
  text(short = false): string {
    const count = short ? this.byte() : this.uint16();
    const flags = this.byte();
    let wide = !!(flags & 1);
    const runs = flags & 8 ? this.uint16() : 0;
    const extension = flags & 4 ? this.uint32() : 0;
    const codes = new Uint16Array(count);
    for (let i = 0; i < count; i++) {
      if (this.offset === this.block.length) { this.next(); wide = !!(this.byte() & 1); }
      checked(this.offset + (wide ? 2 : 1) <= this.block.length);
      codes[i] = wide ? this.uint16() : this.byte();
    }
    this.skip(runs * 4 + extension);
    // BIFFの1バイト文字はUnicodeの下位バイトであり、Shift_JISではない。
    let result = "";
    for (let i = 0; i < count; i += 4096) result += String.fromCharCode(...codes.subarray(i, i + 4096));
    return result;
  }
}

function rkNumber(raw: number): number {
  let number: number;
  if (raw & 2) number = raw >> 2;
  else {
    const data = new DataView(new ArrayBuffer(8));
    data.setUint32(4, raw & 0xfffffffc, true);
    number = data.getFloat64(0, true);
  }
  return raw & 1 ? number / 100 : number;
}

function formattedNumber(number: number, format: number, custom: Map<number, string>, date1904: boolean): string {
  if (!Number.isFinite(number)) return String(number);
  const code = (custom.get(format) ?? "").replace(/"[^"]*"|\\.|_.|\*.|\[(?![hms]+\])[^\]]*\]/gi, "");
  const date = (format >= 14 && format <= 17) || /[yd]/i.test(code);
  const time = (format >= 18 && format <= 22) || /[hs]/i.test(code);
  if ((!date && !time && format !== 22) || number < 0 || /\[[hms]+\]/i.test(code)) return String(number);
  const seconds = Math.round((number % 1) * 86400) % 86400;
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}${format === 19 || format === 21 || /s/i.test(code) ? `:${pad(seconds % 60)}` : ""}`;
  if (!date && format !== 22) return clock;
  // Excelの1900年2月29日は実在しないので、数のまま残す。
  if (!date1904 && Math.floor(number) === 60) return String(number);
  const days = Math.floor(number) - (!date1904 && number >= 60 ? 1 : 0);
  const ms = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 31) + days * 86400000;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return String(number);
  const day = new Date(ms).toISOString().slice(0, 10);
  return time ? `${day} ${clock}` : day;
}

export function extractLegacyExcel(file: CompoundOffice): ExtractedDocument {
  const raw = file.stream("Workbook") ?? file.stream("Book");
  checked(raw);
  const all = records(raw);
  const first = all[0];
  checked(first?.id === 0x0809 && view(first.bytes).getUint16(0, true) === 0x0600 && view(first.bytes).getUint16(2, true) === 5);
  checked(!all.some((r) => r.id === 0x002f)); // FILEPASSは読まず、原本を残す。
  const endGlobals = all.findIndex((r) => r.id === 0x000a);
  checked(endGlobals > 0);
  const globals = all.slice(0, endGlobals);
  const shared: string[] = [];
  const formats = new Map<number, string>();
  const xfs: number[] = [];
  let date1904 = false;
  let textSize = 0;
  for (let i = 0; i < globals.length; i++) {
    const r = globals[i]!;
    const data = view(r.bytes);
    if (r.id === 0x00fc) {
      const blocks = [r.bytes];
      while (globals[i + 1]?.id === 0x003c) blocks.push(globals[++i]!.bytes);
      const reader = new Strings(blocks);
      reader.uint32();
      const count = reader.uint32();
      checked(count <= 200_000);
      for (let n = 0; n < count; n++) {
        const text = reader.text();
        textSize += text.length;
        checked(textSize <= 400_000);
        shared.push(text);
      }
    } else if (r.id === 0x041e) {
      formats.set(data.getUint16(0, true), new Strings([r.bytes.subarray(2)]).text());
    } else if (r.id === 0x00e0) xfs.push(data.getUint16(2, true));
    else if (r.id === 0x0022) date1904 = data.getUint16(0, true) === 1;
  }
  const tables: ExtractedDocument["tables"] = [];
  let cells = 0;
  let outputSize = 0;
  const offsets = new Map(all.map((r, i) => [r.offset, i]));
  for (const bound of globals.filter((r) => r.id === 0x0085)) {
    const info = view(bound.bytes);
    if (info.getUint8(5) !== 0) continue; // グラフとマクロのシートは実行も読み取りもしない。
    const start = offsets.get(info.getUint32(0, true));
    checked(start !== undefined);
    const bof = all[start]!;
    checked(bof.id === 0x0809 && view(bof.bytes).getUint16(2, true) === 0x0010);
    const name = new Strings([bound.bytes.subarray(6)]).text(true);
    const rows: string[][] = [];
    const put = (row: number, col: number, text: string) => {
      checked(row < 65536 && col < 256);
      while (rows.length <= row) rows.push([]);
      const target = rows[row]!;
      if (target.length <= col) { cells += col + 1 - target.length; checked(cells <= 200_000); }
      while (target.length <= col) target.push("");
      outputSize += text.length;
      checked(outputSize <= 400_000);
      target[col] = text;
    };
    const numeric = (data: DataView, offset: number, number: number) =>
      formattedNumber(number, xfs[data.getUint16(offset, true)] ?? 0, formats, date1904);
    let pendingString: { row: number; col: number } | null = null;
    let ended = false;
    let chartDepth = 0;
    for (let i = start + 1; i < all.length; i++) {
      const r = all[i]!;
      const data = view(r.bytes);
      if (r.id === 0x0809) {
        checked(data.getUint16(2, true) === 0x0020); // 埋め込みのグラフだけを飛ばす。
        chartDepth++;
        continue;
      }
      if (r.id === 0x000a) {
        if (chartDepth > 0) { chartDepth--; continue; }
        ended = true;
        break;
      }
      if (chartDepth > 0) continue;
      if (r.id === 0x0207 && pendingString) {
        const blocks = [r.bytes];
        while (all[i + 1]?.id === 0x003c) blocks.push(all[++i]!.bytes);
        put(pendingString.row, pendingString.col, new Strings(blocks).text());
        pendingString = null;
        continue;
      }
      if (![0x00fd, 0x0204, 0x0203, 0x027e, 0x00bd, 0x0205, 0x0006].includes(r.id)) continue;
      checked(pendingString === null);
      const row = data.getUint16(0, true);
      const col = data.getUint16(2, true);
      if (r.id === 0x00fd) {
        const text = shared[data.getUint32(6, true)]; checked(text !== undefined); put(row, col, text);
      } else if (r.id === 0x0204) {
        const blocks = [r.bytes.subarray(6)];
        while (all[i + 1]?.id === 0x003c) blocks.push(all[++i]!.bytes);
        put(row, col, new Strings(blocks).text());
      } else if (r.id === 0x0203) put(row, col, numeric(data, 4, data.getFloat64(6, true)));
      else if (r.id === 0x027e) put(row, col, numeric(data, 4, rkNumber(data.getUint32(6, true))));
      else if (r.id === 0x00bd) {
        const last = data.getUint16(r.bytes.length - 2, true);
        checked(last >= col && r.bytes.length === 6 + (last - col + 1) * 6);
        for (let c = col; c <= last; c++) {
          const p = 4 + (c - col) * 6;
          put(row, c, numeric(data, p, rkNumber(data.getUint32(p + 2, true))));
        }
      } else if (r.id === 0x0205) put(row, col, data.getUint8(7) ? `#ERROR(${data.getUint8(6)})` : data.getUint8(6) ? "TRUE" : "FALSE");
      else if (r.id === 0x0006) {
        if (data.getUint16(12, true) !== 0xffff) put(row, col, numeric(data, 4, data.getFloat64(6, true)));
        else {
          const type = data.getUint8(6);
          if (type === 0) pendingString = { row, col };
          else if (type === 1) put(row, col, data.getUint8(8) ? "TRUE" : "FALSE");
          else if (type === 2) put(row, col, `#ERROR(${data.getUint8(8)})`);
          else { checked(type === 3); put(row, col, ""); }
        }
      }
    }
    checked(ended && pendingString === null);
    tables.push({ name, rows });
  }
  checked(tables.length > 0);
  return { format: "xls", paragraphs: [], tables };
}
