// MS-CFBのFAT、MiniFATと、ルート直下の流れだけを読む。埋め込み文書には入らない。
// 仕様: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-cfb/
const END = 0xfffffffe;
const FREE = 0xffffffff;
const MAX_BYTES = 25 * 1024 * 1024;

export function checked(condition: unknown): asserts condition {
  if (!condition) throw new Error("古い形式の資料を読み取れませんでした");
}

export function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function slice(bytes: Uint8Array, start: number, length: number): Uint8Array {
  checked(Number.isSafeInteger(start) && Number.isSafeInteger(length) && start >= 0 && length >= 0 && start + length <= bytes.length);
  return bytes.subarray(start, start + length);
}

export function isCompoundOffice(bytes: Uint8Array): boolean {
  return [0xd0, 0xcf, 0x11, 0xe0].every((b, i) => bytes[i] === b);
}

interface Entry { name: string; type: number; left: number; right: number; child: number; start: number; size: number }

export class CompoundOffice {
  private readonly sectorSize: number;
  private readonly fat: number[] = [];
  private readonly entries: Entry[] = [];
  private readonly streams = new Map<string, Entry>();
  private miniFat?: number[];
  private miniStream?: Uint8Array;
  private readonly header: DataView;

  constructor(private readonly bytes: Uint8Array) {
    checked(bytes.length >= 512 && bytes.length <= MAX_BYTES);
    checked([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((b, i) => bytes[i] === b));
    this.header = view(bytes);
    const major = this.header.getUint16(26, true);
    const shift = this.header.getUint16(30, true);
    checked(this.header.getUint16(28, true) === 0xfffe && this.header.getUint16(32, true) === 6);
    checked((major === 3 && shift === 9) || (major === 4 && shift === 12));
    this.sectorSize = 2 ** shift;
    checked(bytes.length % this.sectorSize === 0 && this.header.getUint32(56, true) === 4096);
    const sectorCount = bytes.length / this.sectorSize - 1;
    const fatCount = this.header.getUint32(44, true);
    checked(fatCount > 0 && fatCount <= sectorCount);
    const fatIds: number[] = [];
    for (let p = 76; p < 512; p += 4) {
      const id = this.header.getUint32(p, true);
      if (id !== FREE) fatIds.push(id);
    }
    let dif = this.header.getUint32(68, true);
    const difCount = this.header.getUint32(72, true);
    checked(difCount <= sectorCount);
    const seenDif = new Set<number>();
    for (let i = 0; i < difCount; i++) {
      checked(!seenDif.has(dif));
      seenDif.add(dif);
      const block = view(this.sector(dif));
      for (let p = 0; p < this.sectorSize - 4; p += 4) {
        const id = block.getUint32(p, true);
        if (id !== FREE) { checked(fatIds.length < fatCount); fatIds.push(id); }
      }
      dif = block.getUint32(this.sectorSize - 4, true);
    }
    checked(fatIds.length === fatCount && new Set(fatIds).size === fatCount);
    for (const id of fatIds) {
      const block = view(this.sector(id));
      for (let p = 0; p < block.byteLength && this.fat.length < sectorCount; p += 4) this.fat.push(block.getUint32(p, true));
    }
    const directory = this.chain(this.header.getUint32(48, true), this.fat, this.sectorSize, (id) => this.sector(id));
    const data = view(directory);
    for (let p = 0; p + 128 <= directory.length; p += 128) {
      const type = data.getUint8(p + 66);
      const nameBytes = data.getUint16(p + 64, true);
      if (type !== 0) checked(nameBytes >= 2 && nameBytes <= 64 && nameBytes % 2 === 0);
      const size = data.getUint32(p + 120, true) + (major === 4 ? data.getUint32(p + 124, true) * 2 ** 32 : 0);
      this.entries.push({ name: type === 0 ? "" : new TextDecoder("utf-16le").decode(slice(directory, p, nameBytes - 2)),
        type, left: data.getUint32(p + 68, true), right: data.getUint32(p + 72, true), child: data.getUint32(p + 76, true),
        start: data.getUint32(p + 116, true), size });
    }
    const root = this.entries[0];
    checked(root?.type === 5);
    const pending = [root.child];
    const seenEntries = new Set<number>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === FREE) continue;
      checked(!seenEntries.has(id));
      seenEntries.add(id);
      const entry = this.entries[id];
      checked(entry && (entry.type === 1 || entry.type === 2));
      pending.push(entry.left, entry.right);
      if (entry.type === 2) {
        checked(!this.streams.has(entry.name));
        this.streams.set(entry.name, entry);
      }
    }
  }

  private sector(id: number): Uint8Array {
    checked(id < this.bytes.length / this.sectorSize - 1);
    return slice(this.bytes, (id + 1) * this.sectorSize, this.sectorSize);
  }

  private chain(start: number, fat: number[], blockSize: number, block: (id: number) => Uint8Array, size?: number): Uint8Array {
    checked(size === undefined || (size <= this.bytes.length && size >= 0));
    const ids: number[] = [];
    const seen = new Set<number>();
    for (let id = start; id !== END;) {
      checked(id < fat.length && !seen.has(id) && (ids.length + 1) * blockSize <= MAX_BYTES);
      seen.add(id);
      ids.push(id);
      id = fat[id]!;
    }
    checked(size === undefined || ids.length === Math.ceil(size / blockSize));
    const result = new Uint8Array(size ?? ids.length * blockSize);
    ids.forEach((id, i) => result.set(block(id).subarray(0, Math.min(blockSize, result.length - i * blockSize)), i * blockSize));
    return result;
  }

  stream(name: string): Uint8Array | null {
    const entry = this.streams.get(name);
    if (!entry) return null;
    if (entry.size === 0) return new Uint8Array(0);
    if (entry.size >= 4096) return this.chain(entry.start, this.fat, this.sectorSize, (id) => this.sector(id), entry.size);
    if (!this.miniFat || !this.miniStream) {
      const miniCount = this.header.getUint32(64, true);
      checked(miniCount > 0 && miniCount * this.sectorSize <= this.bytes.length);
      const raw = view(this.chain(this.header.getUint32(60, true), this.fat, this.sectorSize, (id) => this.sector(id), miniCount * this.sectorSize));
      const root = this.entries[0]!;
      this.miniFat = [];
      for (let p = 0; p < raw.byteLength && this.miniFat.length * 64 < root.size; p += 4) this.miniFat.push(raw.getUint32(p, true));
      this.miniStream = this.chain(root.start, this.fat, this.sectorSize, (id) => this.sector(id), root.size);
    }
    const miniStream = this.miniStream;
    return this.chain(entry.start, this.miniFat, 64, (id) => slice(miniStream, id * 64, 64), entry.size);
  }
}

/** SummaryInformationの保存日、無ければ作成日。壊れた情報で受付を止めない。 */
export function compoundOfficeDate(bytes: Uint8Array): { date: string; source: string } | null {
  try {
    const raw = new CompoundOffice(bytes).stream("\u0005SummaryInformation");
    if (!raw) return null;
    const data = view(raw);
    checked(data.getUint16(0, true) === 0xfffe && data.getUint32(24, true) >= 1);
    // SummaryInformationのFMTID。他のプロパティ集合の番号は日付として扱わない。
    const fmtid = [0xe0, 0x85, 0x9f, 0xf2, 0xf9, 0x4f, 0x68, 0x10, 0xab, 0x91, 0x08, 0, 0x2b, 0x27, 0xb3, 0xd9];
    checked(fmtid.every((b, i) => raw[28 + i] === b));
    const section = data.getUint32(44, true);
    const info = view(slice(raw, section, data.getUint32(section, true)));
    const count = info.getUint32(4, true);
    checked(8 + count * 8 <= info.byteLength);
    for (const [pid, source] of [[13, "office_modified"], [12, "office_created"]] as const) {
      for (let i = 0; i < count; i++) {
        if (info.getUint32(8 + i * 8, true) !== pid) continue;
        const offset = info.getUint32(12 + i * 8, true);
        if (offset + 12 > info.byteLength || info.getUint32(offset, true) !== 64) continue;
        const ticks = info.getBigUint64(offset + 4, true);
        if (ticks === 0n) continue;
        const ms = Number(ticks / 10000n - 11644473600000n);
        if (Number.isFinite(ms) && ms > 0 && ms <= 8.64e15) return { date: new Date(ms).toISOString(), source };
      }
    }
  } catch { /* 日付が無ければFile.lastModifiedで補う。 */ }
  return null;
}
