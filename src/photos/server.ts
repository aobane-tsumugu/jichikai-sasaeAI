import type { Env } from "../env";
import { WardBucket } from "../core/storage";
import { activePhotoPolicy, photoBindings, PHOTO_MODEL_SHA256, PHOTO_PROFILE, type PhotoPolicy } from "./policy";
import { boundedPhotoBody } from "./container";

export class PhotoPreparationError extends Error {}
export interface MaskBox { x: number; y: number; width: number; height: number; }
export interface PhotoEdit { mode: "auto" | "manual" | "none"; masks: MaskBox[]; }
export interface PreparedPhoto extends PhotoEdit {
  photoId: string; originalId: string; sourceHash: string; maskedHash: string;
  png: string; width: number; height: number; faces: number; policy: PhotoPolicy;
}
export async function photoHash(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}
function photoBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return btoa(parts.join(""));
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PhotoPreparationError("写真を処理できませんでした。");
  return value as Record<string, unknown>;
}
/** PNGの形式・寸法・メタデータを検査。成功という文字だけでは通さない。 */
export function checkedMaskedPng(encoded: unknown, width: unknown, height: unknown): Uint8Array {
  if (typeof encoded !== "string" || encoded.length > 800_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
      typeof width !== "number" || typeof height !== "number" || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width > 1280 || height > 1280) throw new PhotoPreparationError("写真の出力が不正です。");
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  if ([137, 80, 78, 71, 13, 10, 26, 10].some((v, i) => bytes[i] !== v)) throw new PhotoPreparationError("写真の形式が違います。");
  const view = new DataView(bytes.buffer);
  let offset = 8, data = false, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (length > bytes.length - offset - 12 || !["IHDR", "IDAT", "IEND"].includes(type)) throw new PhotoPreparationError("写真の構造が不正です。");
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13 || view.getUint32(16) !== width || view.getUint32(20) !== height ||
          bytes[24] !== 8 || bytes[25] !== 2 || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) throw new PhotoPreparationError("写真の寸法が違います。");
    } else if (type === "IHDR") throw new PhotoPreparationError("写真の見出しが重複しています。");
    if (type === "IDAT") data = true;
    offset += length + 12;
    if (type === "IEND") { ended = length === 0 && data && offset === bytes.length; break; }
  }
  if (!ended) throw new PhotoPreparationError("写真が途中で切れています。");
  return bytes;
}

export async function preparePublicationPhotos(env: Env, wardId: string, projectId: string, ids: readonly string[], edit: PhotoEdit = { mode: "auto", masks: [] }): Promise<PreparedPhoto[]> {
  if (!ids.length) return [];
  if (ids.length > 4 || new Set(ids).size !== ids.length) throw new PhotoPreparationError("写真を選び直してください。");
  const policy = await activePhotoPolicy(env, wardId);
  const namespace = photoBindings(env).FACE_MASK;
  if (!policy || !namespace) throw new PhotoPreparationError("写真の公開はまだ準備が済んでいません。");
  const prepared: PreparedPhoto[] = [];
  for (const originalId of ids) {
    const source = await env.DB.prepare(`SELECT o.r2_path, o.content_hash, o.media_type, o.byte_size FROM originals o
      JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id
      JOIN projects p ON p.ward_id = j.ward_id AND p.project_id = j.project_id
      WHERE o.ward_id = ? AND o.original_id = ? AND j.project_id = ?
        AND o.withdrawn_at IS NULL AND j.withdrawn_at IS NULL AND o.kind = 'photo'`)
      .bind(wardId, originalId, projectId).first<{ r2_path: string | null; content_hash: string; media_type: string; byte_size: number }>();
    if (!source?.r2_path || !["image/jpeg", "image/png"].includes(source.media_type) || source.byte_size > 8_000_000) throw new PhotoPreparationError("この写真は公開用に処理できません。");
    const object = await new WardBucket(env.ORIGINALS, wardId).get(source.r2_path);
    if (!object || object.size > 8_000_000) throw new PhotoPreparationError("元の写真を確認できません。");
    const original = new Uint8Array(await object.arrayBuffer());
    if (await photoHash(original) !== source.content_hash) throw new PhotoPreparationError("元の写真との対応が違います。");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = new Request("http://face-mask/mask", { method: "POST", headers: { "content-type": edit.mode === "auto" ? source.media_type : "application/json" }, body: edit.mode === "auto" ? original : JSON.stringify({ image_base64: photoBase64(original), ...edit }), signal: controller.signal });
      const task = (async () => {
        const stub = namespace.get(namespace.idFromName(JSON.stringify([wardId, projectId])));
        const response = await stub.fetch(request);
        if (!response.ok) throw new PhotoPreparationError("写真の処理が終わりませんでした。");
        return JSON.parse(new TextDecoder().decode(await boundedPhotoBody(response, 1_100_000))) as unknown;
      })();
      const result = await Promise.race([task, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new PhotoPreparationError("写真の処理に時間がかかっています。")); }, 20_000);
      })]);
      const value = record(result);
      if (value.state !== "masked" || value.source_sha256 !== source.content_hash || value.model_sha256 !== PHOTO_MODEL_SHA256 ||
          value.profile !== PHOTO_PROFILE || typeof value.faces !== "number" || !Number.isSafeInteger(value.faces) ||
          value.faces < 0 || value.faces >= 2000) throw new PhotoPreparationError("写真を隠したことを確認できません。");
      const bytes = checkedMaskedPng(value.png_base64, value.width, value.height);
      const maskedHash = await photoHash(bytes);
      if (maskedHash !== value.masked_sha256) throw new PhotoPreparationError("写真の出力を確認できません。");
      const masks = checkedMasks(value.masks);
      if (edit.mode === "auto" && (!value.faces || !masks.length)) throw new PhotoPreparationError("顔を隠した写真を作れませんでした。");
      prepared.push({ photoId: crypto.randomUUID(), originalId, sourceHash: source.content_hash, maskedHash,
        png: String(value.png_base64), width: Number(value.width), height: Number(value.height), faces: value.faces, policy, mode: edit.mode, masks });
    } catch (error) {
      if (error instanceof PhotoPreparationError) throw error;
      throw new PhotoPreparationError("写真を処理できませんでした。まだ配っていません。");
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  return prepared;
}

/** 同じD1のbatchへ入れる。選び直しや取り下げがあればその写真だけ外し、報告は配る。 */
export function photoPublicationStatements(db: D1Database, wardId: string, projectId: string,
  publicationId: string, photos: readonly PreparedPhoto[]): D1PreparedStatement[] {
  return photos.map((photo) => db.prepare(`INSERT INTO publication_photos
    (ward_id, project_id, publication_id, photo_id, original_id, source_hash, masked_hash, masked_png,
     width, height, faces, model_sha256, profile, policy_revision)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
      SELECT 1 FROM report_photo_drafts f JOIN originals o ON o.ward_id = f.ward_id AND o.original_id = f.original_id
      JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id AND j.project_id = f.project_id
      JOIN ward_photo_policy s ON s.ward_id = f.ward_id
      WHERE f.ward_id = ? AND f.project_id = ? AND f.original_id = ? AND f.state = 'ready'
        AND json_extract(f.prepared, '$.photoId') = ? AND o.withdrawn_at IS NULL AND j.withdrawn_at IS NULL
        AND o.r2_path IS NOT NULL AND o.content_hash = ? AND s.enabled = 1 AND s.revision = ?
        AND EXISTS(SELECT 1 FROM publication_records r WHERE r.ward_id = ? AND r.project_id = ? AND r.publication_id = ? AND r.unpublished_at IS NULL)
    )`)
    .bind(wardId, projectId, publicationId, photo.photoId, photo.originalId, photo.sourceHash, photo.maskedHash,
      photo.png, photo.width, photo.height, photo.faces, PHOTO_MODEL_SHA256, PHOTO_PROFILE, photo.policy.revision, wardId, projectId, photo.originalId, photo.photoId, photo.sourceHash, photo.policy.revision, wardId, projectId, publicationId));
}

/** 写しに残る配った本文へ、写真の元とhashの対応だけを付ける。画素は入れない。 */
export function bodyWithPhotoInputs(body: string, photos: readonly PreparedPhoto[]): string {
  if (!photos.length) return body;
  const value = record(JSON.parse(body));
  
  return JSON.stringify({ ...value, publicPhotoInputs: photos.map((photo) => ({ originalId: photo.originalId, sourceHash: photo.sourceHash, mode: photo.mode, masks: photo.masks })) });
}

/** 端末から来る範囲は写真全体を1とした座標。検出も画素の変更も提供側で行う。 */
export function checkedMasks(raw: unknown): MaskBox[] {
  if (!Array.isArray(raw) || raw.length > 2000) throw new PhotoPreparationError("隠す範囲を選び直してください。");
  return raw.map((entry: unknown) => {
    const box = record(entry);
    const { x, y, width, height } = box;
    if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number" ||
        ![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) {
      throw new PhotoPreparationError("隠す範囲を選び直してください。");
    }
    return { x, y, width, height };
  });
}
