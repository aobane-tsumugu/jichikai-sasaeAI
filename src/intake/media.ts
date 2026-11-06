// 受けた物の種類の見分け。ブラウザが言う種類は信じず、先頭のバイトで見る。
// 読めない形式は受けない（原本として置いても読めないので、送った人に分かる文で返す）。

export type MediaClass = "image" | "pdf" | "word" | "excel" | "text";

export interface Classified {
  mediaType: string;
  mediaClass: MediaClass;
}

const WORD_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const EXCEL_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const TEXT_EXTENSIONS = new Set(["txt", "csv", "tsv", "json", "md", "log"]);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((b, i) => bytes[offset + i] === b);
}

function utf16Encoding(bytes: Uint8Array): "utf-16le" | "utf-16be" | null {
  if (startsWith(bytes, [0xff, 0xfe])) return "utf-16le";
  if (startsWith(bytes, [0xfe, 0xff])) return "utf-16be";
  return null;
}

/** 受けられる形式なら種類を返し、そうでなければ null。 */
export function classifyUpload(bytes: Uint8Array, declaredType: string, filename: string): Classified | null {
  if (bytes.length === 0) return null;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mediaType: "image/jpeg", mediaClass: "image" };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mediaType: "image/png", mediaClass: "image" };
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return { mediaType: "image/gif", mediaClass: "image" };
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { mediaType: "image/webp", mediaClass: "image" };
  }
  if (bytes.length >= 12 && new TextDecoder("latin1").decode(bytes.subarray(4, 8)) === "ftyp"
    && ["heic", "heix", "hevc", "hevx", "heif"].includes(new TextDecoder("latin1").decode(bytes.subarray(8, 12)))) {
    return { mediaType: "image/heic", mediaClass: "image" };
  }
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  if (head.includes("%PDF-")) return { mediaType: "application/pdf", mediaClass: "pdf" };
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const ext = extensionOf(filename);
    if (ext === "docx" || declaredType === WORD_TYPE) return { mediaType: WORD_TYPE, mediaClass: "word" };
    if (ext === "xlsx" || declaredType === EXCEL_TYPE) return { mediaType: EXCEL_TYPE, mediaClass: "excel" };
    return null;
  }
  // 古い形式の Word と Excel（.doc、.xls）は読めない
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return null;
  const looksText = declaredType.startsWith("text/") || TEXT_EXTENSIONS.has(extensionOf(filename)) || declaredType === "application/json";
  // BOM のある UTF-16 は、文字を表すゼロのバイトを含んでいても文字の資料。
  if (looksText && (utf16Encoding(bytes) !== null || !bytes.subarray(0, 8192).includes(0))) {
    return { mediaType: "text/plain", mediaClass: "text" };
  }
  return null;
}

/** BOM のある UTF-16 を読み、それ以外は UTF-8、読めなければ Shift_JIS で読む。 */
export function decodeText(bytes: Uint8Array): string {
  const encoding = utf16Encoding(bytes);
  if (encoding) return new TextDecoder(encoding).decode(bytes);
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const body = bytes.subarray(start);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
  } catch {
    return new TextDecoder("shift_jis").decode(body);
  }
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
