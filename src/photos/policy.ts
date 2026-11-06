import type { Env } from "../env";

export const PHOTO_MODEL_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4";
export const PHOTO_PROFILE = "yunet-report-v2";
/** 未配備では役員の写真の入口を出さない。 */
export interface PhotoBindings {
  FACE_MASK?: DurableObjectNamespace;
}
export interface PhotoPolicy { revision: string; model_sha256: string; quality_report_sha256: string; }

export function photoBindings(env: Env): PhotoBindings {
  return env as Env & PhotoBindings;
}

export async function activePhotoPolicy(env: Env, wardId: string): Promise<PhotoPolicy | null> {
  // この値は本人の裁定後に提供側が設定する。役員のフォームからは受けない。
  return env.DB.prepare(`SELECT revision, model_sha256, quality_report_sha256 FROM ward_photo_policy
    WHERE ward_id = ? AND enabled = 1 AND author_approved_at IS NOT NULL
      AND model_sha256 = ? AND length(quality_report_sha256) = 64 AND profile = ?`)
    .bind(wardId, PHOTO_MODEL_SHA256, PHOTO_PROFILE).first<PhotoPolicy>();
}

/** 提供側の認証済みの設定経路へ接続する関数。役員向けの経路には接続しない。 */
export async function saveWardPhotoPolicy(db: D1Database, wardId: string, input: {
  enabled: boolean; authorApprovedAt: string; qualityReportSha256: string; providerId: string;
}): Promise<void> {
  if (!input.providerId || !/^\d{4}-\d{2}-\d{2}T/.test(input.authorApprovedAt) ||
      !/^[a-f0-9]{64}$/.test(input.qualityReportSha256)) throw new Error("写真の導入条件が足りません。");
  await db.prepare(`INSERT INTO ward_photo_policy
    (ward_id, enabled, revision, author_approved_at, quality_report_sha256, model_sha256, profile, updated_by_provider)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ward_id) DO UPDATE SET enabled = excluded.enabled, revision = excluded.revision,
      author_approved_at = excluded.author_approved_at, quality_report_sha256 = excluded.quality_report_sha256,
      model_sha256 = excluded.model_sha256, profile = excluded.profile, updated_by_provider = excluded.updated_by_provider`)
    .bind(wardId, input.enabled ? 1 : 0, crypto.randomUUID(), input.authorApprovedAt,
      input.qualityReportSha256, PHOTO_MODEL_SHA256, PHOTO_PROFILE, input.providerId).run();
}


export async function photosAvailable(env: Env, wardId: string): Promise<boolean> {
  return Boolean(photoBindings(env).FACE_MASK && await activePhotoPolicy(env, wardId));
}
