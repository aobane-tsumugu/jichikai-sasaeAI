// 写真は運営で使う大きさに整えてから保管する。読み取りもこの一つを使う。
import type { Env } from "../env";
import { classifyUpload } from "./media";

export const PHOTO_LONG_EDGE = 2400;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_READ_BYTES = 20 * 1024 * 1024;
export type PhotoImages = Pick<ImagesBinding, "input">;

// env.tsは土台の担当。既存のbindingの型はこの入口で付ける。
export function imagesBinding(env: Pick<Env, "DB" | "ORIGINALS">): PhotoImages | undefined {
  return (env as typeof env & { IMAGES?: PhotoImages }).IMAGES;
}

/** 変換前の写真を識別する印。認証や行事の選択には使わない。 */
export function photoSourceHash(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

/** 画像の見出しだけを読み、画素を展開しない。 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = (width: number, height: number) => width > 0 && height > 0 ? { width, height } : null;
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) return size(view.getUint32(16), view.getUint32(20));
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49) return size(view.getUint16(6, true), view.getUint16(8, true));
  if (bytes.length >= 30 && bytes[0] === 0x52 && bytes[8] === 0x57) {
    const tag = String.fromCharCode(...bytes.subarray(12, 16));
    if (tag === "VP8X") return size(1 + (view.getUint32(24, true) & 0xffffff), 1 + ((view.getUint32(26, true) >>> 8) & 0xffffff));
    if (tag === "VP8 ") return size(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    if (tag === "VP8L" && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return size(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
    }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1]!;
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = view.getUint16(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        return size(view.getUint16(offset + 7), view.getUint16(offset + 5));
      }
      offset += length + 2;
    }
  }
  return null;
}

export function storedPhotoFits(bytes: Uint8Array, mediaType: string): boolean {
  const dimensions = imageDimensions(bytes);
  return mediaType === "image/jpeg" && bytes.length <= MAX_IMAGE_BYTES && dimensions !== null
    && Math.max(dimensions.width, dimensions.height) <= PHOTO_LONG_EDGE;
}

/** ブラウザで整えたJPEGは再圧縮しない。失敗時も受付を止めず、読めない印を保管する。 */
export async function preparePhoto(bytes: Uint8Array, mediaType: string, images?: PhotoImages): Promise<{
  bytes: Uint8Array; mediaType: string; resizeFailed: boolean;
}> {
  if (storedPhotoFits(bytes, mediaType)) return { bytes, mediaType, resizeFailed: false };
  try {
    if (!images) throw new Error("写真の変換が使えません");
    const output = await images.input(new Blob([bytes]).stream())
      .transform({ width: PHOTO_LONG_EDGE, height: PHOTO_LONG_EDGE, fit: "scale-down" })
      .output({ format: "image/jpeg", quality: 85 });
    const resized = new Uint8Array(await output.response().arrayBuffer());
    if (classifyUpload(resized, output.contentType(), "photo.jpg")?.mediaType !== "image/jpeg"
      || !storedPhotoFits(resized, output.contentType())) throw new Error("写真を整えられませんでした");
    return { bytes: resized, mediaType: "image/jpeg", resizeFailed: false };
  } catch {
    return { bytes, mediaType, resizeFailed: true };
  }
}
