import { getJob } from "../intake/store";

// 買い出しや設営で撮って送り直す間をつなぐ仮の幅。別の作業まで長く持ち越さない。
export const PHOTO_CONTEXT_GAP_MS = 30 * 60_000;

/** 既存の「行事に入れる」と、行事を聞いた答えだけで場所を結ぶ。設定の操作は増やさない。 */
export async function rememberPhotoSource(db: D1Database, wardId: string, jobId: string, projectId: string): Promise<void> {
  await db.prepare(`INSERT INTO line_photo_sources (ward_id, destination, source_type, source_id, project_id)
    SELECT b.ward_id, b.destination, b.source_type, b.source_id, ? FROM line_photo_batches b
    JOIN line_photo_items i ON i.ward_id = b.ward_id AND i.batch_id = b.batch_id
    JOIN projects p ON p.ward_id = b.ward_id AND p.project_id = ? AND p.closed_at IS NULL
    WHERE b.ward_id = ? AND i.job_id = ? AND b.source_type IN ('group', 'room')
    ON CONFLICT (ward_id, destination, source_type, source_id) DO UPDATE SET project_id = excluded.project_id`)
    .bind(projectId, projectId, wardId, jobId).run();
}

/** QRなどで当たらなかった写真だけ、場所、直前の写真、今の時期の順で当てる。 */
export async function photoContextProject(db: D1Database, wardId: string, jobId: string): Promise<{ id: string; reason: string } | null> {
  const current = await getJob(db, wardId, jobId);
  if (!current) return null;
  const source = await db.prepare(`SELECT b.destination, b.source_type, b.source_id, b.sender_id, b.batch_id,
    i.image_index, x.received_at FROM line_photo_items i
    JOIN line_photo_batches b ON b.ward_id = i.ward_id AND b.batch_id = i.batch_id
    JOIN line_inbox_items x ON x.ward_id = i.ward_id AND x.job_id = i.job_id
    WHERE i.ward_id = ? AND i.job_id = ?`).bind(wardId, jobId)
    .first<{ destination: string; source_type: string; source_id: string; sender_id: string; batch_id: string; image_index: number | null; received_at: string }>();
  if (source) {
    const place = await db.prepare(`SELECT s.project_id FROM line_photo_sources s
      JOIN projects p ON p.ward_id = s.ward_id AND p.project_id = s.project_id
      WHERE s.ward_id = ? AND s.destination = ? AND s.source_type = ? AND s.source_id = ? AND p.closed_at IS NULL`)
      .bind(wardId, source.destination, source.source_type, source.source_id).first<{ project_id: string }>();
    if (place) return { id: place.project_id, reason: "送った場所の行事に入れました。" };
    const prior = await db.prepare(`SELECT j.project_id, p.closed_at FROM line_photo_items i
      JOIN line_photo_batches b ON b.ward_id = i.ward_id AND b.batch_id = i.batch_id
      JOIN line_inbox_items x ON x.ward_id = i.ward_id AND x.job_id = i.job_id
      JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id
      LEFT JOIN projects p ON p.ward_id = j.ward_id AND p.project_id = j.project_id
      WHERE i.ward_id = ? AND b.destination = ? AND b.source_type = ? AND b.source_id = ? AND b.sender_id = ?
      AND b.sender_id <> ''
      AND i.job_id <> ? AND j.withdrawn_at IS NULL AND x.received_at >= ?
      AND (x.received_at < ? OR (x.received_at = ? AND
        ((i.batch_id = ? AND i.image_index < ?) OR j.created_at < ?)))
      ORDER BY x.received_at DESC, i.image_index DESC, j.created_at DESC LIMIT 1`)
      .bind(wardId, source.destination, source.source_type, source.source_id, source.sender_id, jobId,
        new Date(Date.parse(source.received_at) - PHOTO_CONTEXT_GAP_MS).toISOString(), source.received_at, source.received_at,
        source.batch_id, source.image_index, current.created_at).first<{ project_id: string | null; closed_at: string | null }>();
    if (prior?.project_id && !prior.closed_at) return { id: prior.project_id, reason: "続けて届いた写真と同じ行事に入れました。" };
  }
  const today = new Date(Date.parse(source?.received_at ?? current.created_at) + 9 * 3600_000).toISOString().slice(0, 10);
  const active = await db.prepare(`SELECT p.project_id FROM projects p WHERE p.ward_id = ? AND p.closed_at IS NULL
    AND (EXISTS (SELECT 1 FROM project_deadlines d WHERE d.ward_id = p.ward_id AND d.project_id = p.project_id
      AND d.kind = 'event_day' AND d.due_on = ?)
    OR EXISTS (SELECT 1 FROM project_map_tasks t WHERE t.ward_id = p.ward_id AND t.project_id = p.project_id
      AND t.removed_at IS NULL AND t.progress <> 'done' AND t.period_start <= ? AND t.period_end >= ?)) LIMIT 2`)
    .bind(wardId, today, today, today).all<{ project_id: string }>();
  return active.results.length === 1 ? { id: active.results[0]!.project_id, reason: "今の時期に進めている行事に入れました。" } : null;
}
