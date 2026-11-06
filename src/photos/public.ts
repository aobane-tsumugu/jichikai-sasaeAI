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

