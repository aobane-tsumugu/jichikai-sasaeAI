import { nowIso } from "../core/ids";
import { getReadings, listOriginals } from "./store";

/** 文字のない写真は資料として完了する。空の読みから繋げる質問を作らない。 */
export async function completePhotoMaterial(db: D1Database, wardId: string, jobId: string): Promise<boolean> {
  const originals = (await listOriginals(db, wardId, jobId)).filter((original) => !original.withdrawn_at);
  if (!originals.length || originals.some((original) => !original.media_type.startsWith("image/"))) return false;
  const readings = await getReadings(db, wardId, jobId);
  if (!readings.length || readings.some(({ body }) => !("fields" in body) ||
    body.fields.length || body.tables.length || body.decisions.length || body.unreadable.length ||
    body.text_blocks.some((block) => block.text.trim()))) return false;
  const now = nowIso();
  const result = await db.prepare(`UPDATE jobs SET status = 'done', finished_at = ?, updated_at = ?,
    stop_reason = '写真を行事の資料に入れました。'
    WHERE ward_id = ? AND job_id = ? AND project_id IS NOT NULL AND status = 'read' AND withdrawn_at IS NULL`)
    .bind(now, now, wardId, jobId).run();
  return (result.meta.changes ?? 0) > 0;
}
