import type { Env } from "../env";
import { activePhotoPolicy } from "./policy";
import { checkedMaskedPng, photoHash } from "./server";

const LIVE_PHOTOS = `FROM publication_photos f
  JOIN publication_records r ON r.ward_id = f.ward_id AND r.publication_id = f.publication_id AND r.project_id = f.project_id
  JOIN document_versions v ON v.ward_id = r.ward_id AND v.version_id = r.version_id AND v.project_id = r.project_id
  JOIN originals o ON o.ward_id = f.ward_id AND o.original_id = f.original_id
  JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id AND j.project_id = f.project_id
  WHERE f.ward_id = ? AND f.project_id = ? AND f.policy_revision = ?
    AND r.unpublished_at IS NULL AND v.scope = 'public' AND v.published_at IS NOT NULL
    AND o.withdrawn_at IS NULL AND j.withdrawn_at IS NULL AND o.r2_path IS NOT NULL AND o.content_hash = f.source_hash
    AND NOT EXISTS (SELECT 1 FROM publication_records n WHERE n.ward_id = r.ward_id AND n.document_id = r.document_id AND n.version_no > r.version_no)`;

export async function listPublicPhotos(env: Env, wardId: string, projectId: string) {
  const policy = await activePhotoPolicy(env, wardId);
  if (!policy) return [];
  return (await env.DB.prepare(`SELECT f.photo_id, f.publication_id, r.document_id, r.version_no ${LIVE_PHOTOS} ORDER BY f.photo_id`)
    .bind(wardId, projectId, policy.revision).all<{ photo_id: string; publication_id: string; document_id: string; version_no: number }>()).results;
}

/** 閉じる画面で本文を直しても、配った写真を選び直した下書きで置き換えない。 */
export function copyPublicPhotoStatement(db: D1Database, wardId: string, projectId: string,
  sourcePublicationId: string, publicationId: string): D1PreparedStatement {
  return db.prepare(`INSERT INTO publication_photos
    (ward_id, project_id, publication_id, photo_id, original_id, source_hash, masked_hash, masked_png,
     width, height, faces, model_sha256, profile, policy_revision)
    SELECT f.ward_id, f.project_id, ?, lower(hex(randomblob(16))), f.original_id, f.source_hash, f.masked_hash, f.masked_png,
      f.width, f.height, f.faces, f.model_sha256, f.profile, f.policy_revision
    FROM publication_photos f
    JOIN publication_records r ON r.ward_id = f.ward_id AND r.project_id = f.project_id AND r.publication_id = f.publication_id
    JOIN originals o ON o.ward_id = f.ward_id AND o.original_id = f.original_id
    JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id AND j.project_id = f.project_id
    JOIN ward_photo_policy s ON s.ward_id = f.ward_id
    WHERE f.ward_id = ? AND f.project_id = ? AND f.publication_id = ? AND r.unpublished_at IS NULL
      AND o.withdrawn_at IS NULL AND j.withdrawn_at IS NULL AND o.r2_path IS NOT NULL AND o.content_hash = f.source_hash
      AND s.enabled = 1 AND s.revision = f.policy_revision AND s.model_sha256 = f.model_sha256 AND s.profile = f.profile
      AND s.author_approved_at IS NOT NULL AND length(s.quality_report_sha256) = 64
      AND EXISTS (SELECT 1 FROM publication_records n WHERE n.ward_id = ? AND n.project_id = ? AND n.publication_id = ? AND n.unpublished_at IS NULL)`)
    .bind(publicationId, wardId, projectId, sourcePublicationId, wardId, projectId, publicationId);
}

export async function publicPhotoResponse(env: Env, wardId: string, projectId: string, photoId: string): Promise<Response> {
  const hidden = () => new Response(null, { status: 404, headers: { "cache-control": "private, no-store" } });
  const policy = await activePhotoPolicy(env, wardId);
  if (!policy) return hidden();
  const photo = await env.DB.prepare(`SELECT f.masked_png, f.width, f.height, f.masked_hash ${LIVE_PHOTOS} AND f.photo_id = ?`)
    .bind(wardId, projectId, policy.revision, photoId).first<{ masked_png: string; width: number; height: number; masked_hash: string }>();
  if (!photo) return hidden();
  try {
    const bytes = checkedMaskedPng(photo.masked_png, photo.width, photo.height);
    if (await photoHash(bytes) !== photo.masked_hash) return hidden();
    return new Response(bytes, { headers: { "content-type": "image/png", "content-disposition": "inline",
      "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch { return hidden(); }
}

