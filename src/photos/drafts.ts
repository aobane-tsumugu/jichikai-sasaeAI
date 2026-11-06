import type { Env } from "../env";
import { activePhotoPolicy, photoBindings } from "./policy";
import { checkedMasks, preparePublicationPhotos, type PhotoEdit, type PreparedPhoto } from "./server";

export interface DraftPhoto {
  original_id: string; revision: string; state: "processing" | "ready" | "failed";
  mode: PhotoEdit["mode"]; masks: string; prepared: string | null; updated_at: string;
}

export async function listDraftPhotos(env: Env, wardId: string, projectId: string): Promise<DraftPhoto[]> {
  // 画面を閉じた後にWorkerが止まった場合も、処理中のままにはしない。
  await env.DB.prepare(`UPDATE report_photo_drafts SET state = 'failed', prepared = NULL
    WHERE ward_id = ? AND project_id = ? AND state = 'processing' AND updated_at < ?`)
    .bind(wardId, projectId, new Date(Date.now() - 30_000).toISOString()).run();
  return (await env.DB.prepare(`SELECT original_id, revision, state, mode, masks, prepared, updated_at
    FROM report_photo_drafts WHERE ward_id = ? AND project_id = ? ORDER BY updated_at, original_id`)
    .bind(wardId, projectId).all<DraftPhoto>()).results;
}

export async function queueReportPhoto(env: Env, wardId: string, projectId: string, originalId: string, edit: PhotoEdit,
  ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
  const policy = await activePhotoPolicy(env, wardId);
  if (!policy || !photoBindings(env).FACE_MASK) throw new Error("写真の準備はまだ済んでいません。");
  const masks = checkedMasks(edit.masks);
  const revision = crypto.randomUUID();
  const result = await env.DB.prepare(`INSERT INTO report_photo_drafts
    (ward_id, project_id, original_id, revision, state, mode, masks, updated_at)
    SELECT ?, ?, o.original_id, ?, 'processing', ?, ?, ? FROM originals o
    JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id
    JOIN projects p ON p.ward_id = j.ward_id AND p.project_id = j.project_id
    WHERE o.ward_id = ? AND o.original_id = ? AND j.project_id = ? AND o.kind = 'photo'
      AND o.withdrawn_at IS NULL AND j.withdrawn_at IS NULL AND p.closed_at IS NULL
      AND ((SELECT COUNT(*) FROM report_photo_drafts f WHERE f.ward_id = ? AND f.project_id = ?) < 4
        OR EXISTS(SELECT 1 FROM report_photo_drafts f WHERE f.ward_id = ? AND f.project_id = ? AND f.original_id = ?))
    ON CONFLICT(ward_id, project_id, original_id) DO UPDATE SET revision = excluded.revision,
      state = 'processing', mode = excluded.mode, masks = excluded.masks, prepared = NULL, updated_at = excluded.updated_at`)
    .bind(wardId, projectId, revision, edit.mode, JSON.stringify(masks), new Date().toISOString(),
      wardId, originalId, projectId, wardId, projectId, wardId, projectId, originalId).run();
  if (!result.meta.changes) throw new Error("写真を選び直してください。報告には4枚まで選べます。");
  ctx.waitUntil((async () => {
    try {
      const photo = (await preparePublicationPhotos(env, wardId, projectId, [originalId], { ...edit, masks }))[0];
      if (!photo) throw new Error("写真がありません。");
      // 選び直した後の古い処理は保存しない。取り下げ・消去・設定変更で消えた行も復活させない。
      await env.DB.prepare(`UPDATE report_photo_drafts SET state = 'ready', prepared = ?, masks = ?
        WHERE ward_id = ? AND project_id = ? AND original_id = ? AND revision = ? AND state = 'processing'
          AND EXISTS(SELECT 1 FROM ward_photo_policy s WHERE s.ward_id = ? AND s.enabled = 1 AND s.revision = ?)`)
        .bind(JSON.stringify(photo), JSON.stringify(photo.masks), wardId, projectId, originalId, revision, wardId, policy.revision).run();
    } catch {
      await env.DB.prepare(`UPDATE report_photo_drafts SET state = 'failed', prepared = NULL
        WHERE ward_id = ? AND project_id = ? AND original_id = ? AND revision = ?`)
        .bind(wardId, projectId, originalId, revision).run();
    }
  })());
}

export async function readyReportPhotos(env: Env, wardId: string, projectId: string, selected?: readonly string[]): Promise<PreparedPhoto[]> {
  const policy = await activePhotoPolicy(env, wardId);
  if (!policy) return [];
  const drafts = await listDraftPhotos(env, wardId, projectId);
  return drafts.flatMap((row) => {
    if (row.state !== "ready" || !row.prepared || (selected && !selected.includes(row.revision))) return [];
    const photo = JSON.parse(row.prepared) as PreparedPhoto;
    return photo.policy.revision === policy.revision ? [photo] : [];
  });
}
