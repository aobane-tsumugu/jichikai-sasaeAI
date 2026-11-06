// 写しは読み取りの呼び出しまでの間だけ持つ。原本の保存先と消す道を増やさない。
import type { ReadableOriginal } from "../ai/read";
import type { Env } from "../env";
import { classifyUpload } from "./media";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_READ_BYTES = 20 * 1024 * 1024;

export interface ReadingCopy { bytes: Uint8Array; mediaType: string }

export function validReadingCopy(copy: ReadingCopy | undefined): ReadingCopy | undefined {
  if (!copy || copy.bytes.length > MAX_IMAGE_BYTES) return undefined;
  return classifyUpload(copy.bytes, copy.mediaType, "reading.jpg")?.mediaType === "image/jpeg"
    ? { bytes: copy.bytes, mediaType: "image/jpeg" } : undefined;
}

export async function readingCopyFromForm(value: File | string | null): Promise<ReadingCopy | undefined> {
  if (typeof value === "string" || !value || value.size > MAX_IMAGE_BYTES) return undefined;
  return validReadingCopy({ bytes: new Uint8Array(await value.arrayBuffer()), mediaType: value.type });
}

export function useReadingCopies(originals: ReadableOriginal[], copies: ReadableOriginal[] = []): ReadableOriginal[] {
  return originals.map((original) => {
    const copy = copies.find((item) => item.originalId === original.originalId);
    return copy ? { ...original, bytes: copy.bytes, mediaType: copy.mediaType } : original;
  });
}

// env.tsは土台の担当。追加のbindingはこの入口だけで型を付ける。
export function imagesBinding(env: Env): ImagesBinding | undefined {
  return (env as Env & { IMAGES?: ImagesBinding }).IMAGES;
}
