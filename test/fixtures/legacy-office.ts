// 試験のデータを外部アプリなしで作る。CFB v3/v4、MiniFATと通常のFAT、
// BIFF8の最小ブック、FIB/Clx/PlcPcdを持つWordの流れをバイトで組み立てる。
const FREE = 0xffffffff;
const END = 0xfffffffe;

export function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let p = 0;
  for (const part of parts) { result.set(part, p); p += part.length; }
  return result;
}

export function u16(...numbers: number[]): Uint8Array {
  const data = new DataView(new ArrayBuffer(numbers.length * 2));
  numbers.forEach((n, i) => data.setUint16(i * 2, n, true));
  return new Uint8Array(data.buffer);
}

export function u32(...numbers: number[]): Uint8Array {
  const data = new DataView(new ArrayBuffer(numbers.length * 4));
  numbers.forEach((n, i) => data.setUint32(i * 4, n, true));
  return new Uint8Array(data.buffer);
}

export function f64(number: number): Uint8Array {
  const data = new DataView(new ArrayBuffer(8));
  data.setFloat64(0, number, true);
  return new Uint8Array(data.buffer);
}

export function utf16(text: string): Uint8Array {
  return u16(...Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)));
}

export function biff(id: number, ...parts: Uint8Array[]): Uint8Array {
  const body = joinBytes(...parts);
  return joinBytes(u16(id, body.length), body);
}

export function biffText(text: string): Uint8Array {
  return joinBytes(u16(text.length), new Uint8Array([1]), utf16(text));
}

/** 小さい流れはMiniFATへ、大きい流れはFATへ置く。外部DIFATも試せる。 */
export function compound(streams: Record<string, Uint8Array>, sectorSize = 512, externalDifat = false): Uint8Array {
  const entries = Object.entries(streams).sort(([a], [b]) => a.length - b.length || (a < b ? -1 : 1))
    .map(([name, bytes]) => ({ name, bytes, start: END, left: FREE, right: FREE, color: 1 }));
  const blocks: Uint8Array[] = [];
  const fat: number[] = [];
  const allocate = (bytes: Uint8Array) => {
    if (bytes.length === 0) return END;
    const start = blocks.length;
    const count = Math.ceil(bytes.length / sectorSize);
    for (let i = 0; i < count; i++) {
      const block = new Uint8Array(sectorSize);
      block.set(bytes.subarray(i * sectorSize, (i + 1) * sectorSize));
      blocks.push(block);
      fat.push(i + 1 === count ? END : blocks.length);
    }
    return start;
  };
  const minis: Uint8Array[] = [];
  const miniFat: number[] = [];
  for (const entry of entries) {
    if (entry.bytes.length >= 4096) { entry.start = allocate(entry.bytes); continue; }
    if (entry.bytes.length === 0) continue;
    entry.start = minis.length;
    const count = Math.ceil(entry.bytes.length / 64);
    for (let i = 0; i < count; i++) {
      const block = new Uint8Array(64);
      block.set(entry.bytes.subarray(i * 64, (i + 1) * 64));
      minis.push(block);
      miniFat.push(i + 1 === count ? END : minis.length);
    }
  }
  const rootStart = allocate(joinBytes(...minis));
  const miniFatBytes = new Uint8Array(Math.ceil(miniFat.length * 4 / sectorSize) * sectorSize).fill(0xff);
  miniFatBytes.set(u32(...miniFat));
  const miniStart = allocate(miniFatBytes);
  const directory = new Uint8Array(Math.ceil((entries.length + 1) * 128 / sectorSize) * sectorSize);
  const data = new DataView(directory.buffer);
  const tree = (lo: number, hi: number, depth: number): number => {
    if (lo >= hi) return FREE;
    const mid = Math.floor((lo + hi) / 2);
    const entry = entries[mid]!;
    entry.left = tree(lo, mid, depth + 1);
    entry.right = tree(mid + 1, hi, depth + 1);
    entry.color = depth > 0 && depth === Math.floor(Math.log2(entries.length + 1)) ? 0 : 1;
    return mid + 1;
  };
  const child = tree(0, entries.length, 0);
  const writeEntry = (p: number, name: string, type: number, start: number, size: number, left: number, right: number, childId: number, color = 1) => {
    directory.set(utf16(`${name}\0`), p);
    data.setUint16(p + 64, (name.length + 1) * 2, true);
    data.setUint8(p + 66, type);
    data.setUint8(p + 67, color);
    data.setUint32(p + 68, left, true);
    data.setUint32(p + 72, right, true);
    data.setUint32(p + 76, childId, true);
    data.setUint32(p + 116, start, true);
    data.setUint32(p + 120, size, true);
  };
  writeEntry(0, "Root Entry", 5, rootStart, minis.length * 64, FREE, FREE, child);
  entries.forEach((entry, i) => writeEntry((i + 1) * 128, entry.name, 2, entry.start, entry.bytes.length, entry.left, entry.right, FREE, entry.color));
  const directoryStart = allocate(directory);
  const perFat = sectorSize / 4;
  let fatCount = externalDifat ? 110 : 1;
  let difCount = 0;
  while (true) {
    const nextDif = Math.max(0, Math.ceil((fatCount - 109) / (perFat - 1)));
    const nextFat = Math.max(fatCount, Math.ceil((blocks.length + fatCount + nextDif) / perFat));
    if (nextDif === difCount && nextFat === fatCount) break;
    difCount = nextDif;
    fatCount = nextFat;
  }
  const fatStart = blocks.length;
  const difStart = difCount ? fatStart + fatCount : END;
  for (let i = 0; i < fatCount; i++) fat.push(0xfffffffd);
  for (let i = 0; i < difCount; i++) fat.push(0xfffffffc);
  const fatBytes = new Uint8Array(fatCount * sectorSize).fill(0xff);
  fatBytes.set(u32(...fat));
  for (let i = 0; i < fatCount; i++) blocks.push(fatBytes.subarray(i * sectorSize, (i + 1) * sectorSize));
  const fatIds = Array.from({ length: fatCount }, (_, i) => fatStart + i);
  for (let i = 0; i < difCount; i++) {
    const block = new Uint8Array(sectorSize).fill(0xff);
    block.set(u32(...fatIds.slice(109 + i * (perFat - 1), 109 + (i + 1) * (perFat - 1))));
    new DataView(block.buffer).setUint32(sectorSize - 4, i + 1 === difCount ? END : difStart + i + 1, true);
    blocks.push(block);
  }
  const header = new Uint8Array(sectorSize);
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const h = new DataView(header.buffer);
  h.setUint16(24, 0x003e, true);
  h.setUint16(26, sectorSize === 512 ? 3 : 4, true);
  h.setUint16(28, 0xfffe, true);
  h.setUint16(30, sectorSize === 512 ? 9 : 12, true);
  h.setUint16(32, 6, true);
  h.setUint32(40, sectorSize === 512 ? 0 : directory.length / sectorSize, true);
  h.setUint32(44, fatCount, true);
  h.setUint32(48, directoryStart, true);
  h.setUint32(56, 4096, true);
  h.setUint32(60, miniStart, true);
  h.setUint32(64, miniFatBytes.length / sectorSize, true);
  h.setUint32(68, difStart, true);
  h.setUint32(72, difCount, true);
  header.fill(0xff, 76, 512);
  header.set(u32(...fatIds.slice(0, 109)), 76);
  return joinBytes(header, ...blocks);
}

export function summaryInformation(modified?: string, created?: string): Uint8Array {
  const values: Array<[number, string]> = [];
  if (created) values.push([12, created]);
  if (modified) values.push([13, modified]);
  const bytes = new Uint8Array(48 + 8 + values.length * 20);
  const data = new DataView(bytes.buffer);
  data.setUint16(0, 0xfffe, true);
  data.setUint32(24, 1, true);
  bytes.set([0xe0, 0x85, 0x9f, 0xf2, 0xf9, 0x4f, 0x68, 0x10, 0xab, 0x91, 8, 0, 0x2b, 0x27, 0xb3, 0xd9], 28);
  data.setUint32(44, 48, true);
  data.setUint32(48, bytes.length - 48, true);
  data.setUint32(52, values.length, true);
  values.forEach(([pid, date], i) => {
    const offset = 8 + values.length * 8 + i * 12;
    data.setUint32(56 + i * 8, pid, true);
    data.setUint32(60 + i * 8, offset, true);
    data.setUint32(48 + offset, 64, true);
    data.setBigUint64(52 + offset, (BigInt(Date.parse(date)) + 11644473600000n) * 10000n, true);
  });
  return bytes;
}

export function wordStreams(text = "自治会の知らせ\r日本語の本文です。\r", tableName: "0Table" | "1Table" = "1Table", compressedPrefix = ""): Record<string, Uint8Array> {
  const word = new Uint8Array(1024 + compressedPrefix.length + text.length * 2);
  const fib = new DataView(word.buffer);
  fib.setUint16(0, 0xa5ec, true);
  fib.setUint16(2, 0xc1, true);
  fib.setUint16(10, tableName === "1Table" ? 0x0200 : 0, true);
  fib.setUint16(32, 14, true);
  fib.setUint16(62, 22, true);
  fib.setUint32(64 + 12, compressedPrefix.length + text.length, true);
  fib.setUint16(152, 93, true);
  const count = compressedPrefix ? 2 : 1;
  const plc = new Uint8Array(4 + count * 12);
  const pc = new DataView(plc.buffer);
  if (compressedPrefix) {
    word.set(new TextEncoder().encode(compressedPrefix), 1024);
    pc.setUint32(4, compressedPrefix.length, true);
    pc.setUint32((count + 1) * 4 + 2, 0x40000000 | (1024 * 2), true);
  }
  word.set(utf16(text), 1024 + compressedPrefix.length);
  pc.setUint32(count * 4, compressedPrefix.length + text.length, true);
  pc.setUint32((count + 1) * 4 + (count - 1) * 8 + 2, 1024 + compressedPrefix.length, true);
  // 先頭のPrCを飛ばし、Pcdtを見つけることも確かめる。
  const clx = joinBytes(new Uint8Array([1, 2, 0, 0, 0, 2]), u32(plc.length), plc);
  fib.setUint32(154 + 33 * 8, 16, true);
  fib.setUint32(158 + 33 * 8, clx.length, true);
  return { WordDocument: word, [tableName]: joinBytes(new Uint8Array(16), clx) };
}

export function workbookStream(sheetRecords?: Uint8Array[], options: { date1904?: boolean; sst?: Uint8Array[]; name?: string } = {}): Uint8Array {
  const bof = (type: number) => biff(0x0809, u16(0x0600, type, 0x0dbb, 0x07cc), u32(0, 6));
  const eof = biff(0x000a);
  const name = options.name ?? "協賛先";
  const bound = biff(0x0085, u32(0), new Uint8Array([0, 0, name.length, 1]), utf16(name));
  const strings = options.sst ?? [biff(0x00fc, u32(3, 3), biffText("相手"), biffText("額"), biffText("商店A"))];
  const xf = (format: number) => biff(0x00e0, u16(0, format), new Uint8Array(16));
  const globals = joinBytes(bof(5), biff(0x0022, u16(options.date1904 ? 1 : 0)), xf(0), xf(14), xf(20), xf(164),
    biff(0x041e, u16(164), biffText("yyyy/m/d h:mm")), ...strings, bound, eof);
  new DataView(globals.buffer).setUint32(globals.length - eof.length - bound.length + 4, globals.length, true);
  const cells = sheetRecords ?? [
    biff(0x00fd, u16(0, 0, 0), u32(0)), biff(0x00fd, u16(0, 1, 0), u32(1)),
    biff(0x00fd, u16(1, 0, 0), u32(2)), biff(0x0203, u16(1, 1, 0), f64(6000)),
    biff(0x0203, u16(3, 3, 1), f64(options.date1904 ? 44857 : 46319)),
  ];
  return joinBytes(globals, bof(0x0010), ...cells, eof);
}
