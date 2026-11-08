// 日付は資料の中から取る。送信日時から補わず、役員画面のFile.lastModifiedだけを補いに使う。
import type { MediaClass } from "./media";
import { compoundOfficeDate, isCompoundOffice } from "./legacy-office-cfb";

export interface OriginalDate { date: string; source: string }

export function validDocumentDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) return null;
  const time = Date.parse(value);
  const day = value.slice(0, 10);
  if (!Number.isFinite(time) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return null;
  return value;
}

export function fileModifiedDate(value: unknown): OriginalDate | null {
  const ms = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15
    ? { date: new Date(ms).toISOString(), source: "file_last_modified" } : null;
}

/** ブラウザが本文と一緒にzipから取り出したcore.xmlの日付。 */
function officeDate(extracted: unknown): OriginalDate | null {
  if (!extracted || typeof extracted !== "object") return null;
  const data = extracted as Record<string, unknown>;
  const date = validDocumentDate(data.documentDate);
  return date && (data.documentDateSource === "office_modified" || data.documentDateSource === "office_created")
    ? { date, source: data.documentDateSource } : null;
}

function pdfDate(value: string): string | null {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?$/.exec(value.trim());
  if (!m) return null;
  const zone = !m[7] || m[7] === "Z" ? m[7] ?? "" : m[7].replace(/'/g, "").replace(/([+-]\d{2})(\d{2})/, "$1:$2");
  return validDocumentDate(`${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}${zone}`);
}

/** 本文の文字を誤って採らないよう、最後の文書情報が指す辞書だけを見る。 */
async function pdfInfoDate(bytes: Uint8Array): Promise<OriginalDate | null> {
  const text = new TextDecoder("latin1").decode(bytes);
  const refs = [...text.matchAll(/\/Info\s+(\d+)\s+(\d+)\s+R\b/g)];
  const ref = refs.at(-1);
  if (!ref) return null;
  const objects = [...text.matchAll(new RegExp(`(?:^|[\\r\\n])${ref[1]}\\s+${ref[2]}\\s+obj\\b([\\s\\S]*?)endobj`, "g"))];
  let info = objects.at(-1)?.[1];
  // 新しいPDFでは文書情報も圧縮したobject streamの中に置かれる。
  if (!info) {
    for (const object of text.matchAll(/(?:^|[\r\n])\d+\s+\d+\s+obj\b([\s\S]*?)endobj/g)) {
      const content = object[1]!;
      const headerEnd = /\bstream(?:\r\n|\n|\r)/.exec(content);
      if (!headerEnd) continue;
      const dictionary = content.slice(0, headerEnd.index);
      if (!/\/Type\s*\/ObjStm\b/.test(dictionary)) continue;
      const first = Number(/\/First\s+(\d+)/.exec(dictionary)?.[1]);
      const count = Number(/\/N\s+(\d+)/.exec(dictionary)?.[1]);
      const length = Number(/\/Length\s+(\d+)\b(?!\s+\d+\s+R)/.exec(dictionary)?.[1]);
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || !Number.isSafeInteger(length)) continue;
      const start = object.index! + object[0].indexOf(content) + headerEnd.index + headerEnd[0].length;
      try {
        const raw = bytes.subarray(start, start + length);
        const decoded = /\/Filter\s*(?:\/FlateDecode|\[\s*\/FlateDecode\s*\])/.test(dictionary)
          ? new TextDecoder("latin1").decode(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer())
          : !/\/Filter\b/.test(dictionary) ? new TextDecoder("latin1").decode(raw) : "";
        const positions = decoded.slice(0, first).trim().split(/\s+/).map(Number);
        for (let i = 0; i < count; i++) {
          if (String(positions[i * 2]) !== ref[1]) continue;
          const offset = positions[i * 2 + 1];
          if (offset === undefined) continue;
          const end = positions[(i + 1) * 2 + 1];
          info = decoded.slice(first + offset, end === undefined ? undefined : first + end);
        }
      } catch { /* 読めない文書情報から日付を作らない。 */ }
    }
  }
  if (!info) return null;
  for (const [key, source] of [["ModDate", "pdf_modified"], ["CreationDate", "pdf_created"]] as const) {
    const value = new RegExp(`/${key}\\s*(\\((?:\\\\[\\s\\S]|[^\\\\)])*\\)|<[0-9a-fA-F\\s]+>)`).exec(info)?.[1];
    if (!value) continue;
    const decoded = value.startsWith("(") ? value.slice(1, -1).replace(/\\([0-7]{1,3}|[\s\S])/g, (_, part: string) =>
      /^[0-7]/.test(part) ? String.fromCharCode(parseInt(part, 8)) : part)
      : String.fromCharCode(...(value.slice(1, -1).replace(/\s/g, "").match(/.{1,2}/g) ?? []).map((hex) => parseInt(hex, 16)));
    const date = pdfDate(decoded);
    if (date) return { date, source };
  }
  return null;
}

/** TIFFのExifIFDにあるDateTimeOriginal。JPEG、PNG、WebPのEXIFを同じ道で読む。 */
function tiffDate(bytes: Uint8Array): OriginalDate | null {
  try {
    const start = bytes[0] === 0x45 && bytes[1] === 0x78 ? 6 : 0;
    const data = new DataView(bytes.buffer, bytes.byteOffset + start, bytes.byteLength - start);
    const little = data.getUint16(0) === 0x4949;
    if ((!little && data.getUint16(0) !== 0x4d4d) || data.getUint16(2, little) !== 42) return null;
    const ifd = (offset: number, tag: number): number | null => {
      const count = data.getUint16(offset, little);
      for (let i = 0; i < count; i++) {
        const p = offset + 2 + i * 12;
        if (data.getUint16(p, little) === tag) return p;
      }
      return null;
    };
    const pointer = ifd(data.getUint32(4, little), 0x8769);
    if (pointer === null) return null;
    const entry = ifd(data.getUint32(pointer + 8, little), 0x9003);
    if (entry === null || data.getUint16(entry + 2, little) !== 2 || data.getUint32(entry + 4, little) < 19) return null;
    const offset = start + data.getUint32(entry + 8, little);
    const raw = new TextDecoder().decode(bytes.subarray(offset, offset + 19));
    const date = validDocumentDate(raw.replace(/^(\d{4}):(\d{2}):(\d{2}) /, "$1-$2-$3T"));
    return date ? { date, source: "exif_original" } : null;
  } catch { return null; }
}

export function exifOriginalDate(bytes: Uint8Array): OriginalDate | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start: number, length: number) => new TextDecoder().decode(bytes.subarray(start, start + length));
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let p = 2; p + 4 <= bytes.length;) {
      if (bytes[p] !== 0xff || bytes[p + 1] === 0xda || bytes[p + 1] === 0xd9) break;
      const length = view.getUint16(p + 2);
      if (length < 2 || p + 2 + length > bytes.length) break;
      if (bytes[p + 1] === 0xe1 && text(p + 4, 6) === "Exif\0\0") {
        const date = tiffDate(bytes.subarray(p + 4, p + 2 + length));
        if (date) return date;
      }
      p += length + 2;
    }
  } else if (text(1, 3) === "PNG") {
    for (let p = 8; p + 12 <= bytes.length;) {
      const length = view.getUint32(p);
      if (p + 12 + length > bytes.length) break;
      if (text(p + 4, 4) === "eXIf") return tiffDate(bytes.subarray(p + 8, p + 8 + length));
      p += 12 + length;
    }
  } else if (text(0, 4) === "RIFF" && text(8, 4) === "WEBP") {
    for (let p = 12; p + 8 <= bytes.length;) {
      const length = view.getUint32(p + 4, true);
      if (p + 8 + length > bytes.length) break;
      if (text(p, 4) === "EXIF") return tiffDate(bytes.subarray(p + 8, p + 8 + length));
      p += 8 + length + length % 2;
    }
  }
  return null;
}

export async function originalDate(media: MediaClass, bytes: Uint8Array, extracted: unknown, lastModified?: unknown): Promise<OriginalDate | null> {
  const embedded = media === "word" || media === "excel" || media === "powerpoint" ? (isCompoundOffice(bytes) ? compoundOfficeDate(bytes) : officeDate(extracted))
    : media === "pdf" ? await pdfInfoDate(bytes) : media === "image" ? exifOriginalDate(bytes) : null;
  return embedded ?? (media !== "text" ? fileModifiedDate(lastModified) : null);
}
