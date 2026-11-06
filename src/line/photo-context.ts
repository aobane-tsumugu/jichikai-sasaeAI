import type { MatchInput } from "../ai/match";
import { getReadings } from "../intake/store";

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
  const batches = await db.prepare(`SELECT b.* FROM line_photo_batches b JOIN line_photo_items i
    ON i.ward_id = b.ward_id AND i.batch_id = b.batch_id WHERE b.ward_id = ? AND i.job_id = ?
    AND (b.expected_count IS NULL OR (SELECT COUNT(*) FROM line_photo_items x WHERE x.ward_id = b.ward_id AND x.batch_id = b.batch_id) >= b.expected_count)
    AND NOT EXISTS (SELECT 1 FROM line_photo_items x JOIN jobs j ON j.ward_id = x.ward_id AND j.job_id = x.job_id
      WHERE x.ward_id = b.ward_id AND x.batch_id = b.batch_id AND j.project_id IS NULL AND j.withdrawn_at IS NULL)`)
    .bind(wardId, jobId).all<PhotoBatchContext>();
  for (const batch of batches.results) {
    await db.prepare("UPDATE line_photo_batches SET match_finished_at = COALESCE(match_finished_at, ?) WHERE ward_id = ? AND batch_id = ?")
      .bind(new Date().toISOString(), wardId, batch.batch_id).run();
    await clearPhotoTexts(db, wardId, batch);
  }
}

export const PHOTO_AFTER_MS = 10 * 60_000;
export const PHOTO_TEXT_TTL_MS = 24 * 60 * 60_000;

export interface PhotoBatchContext {
  batch_id: string; destination: string; source_type: string; source_id: string;
  created_at: string; last_received_at: string;
  match_attempted_at: string | null; match_finished_at: string | null;
  match_reason: string | null;
}

/** 前の文も受けておくが、原本や索引には一切渡さない。 */
export async function rememberPhotoText(db: D1Database, wardId: string, input: {
  destination: string; sourceType: string; sourceId: string; eventId: string; receivedAt: string; text: string;
}, now = new Date()): Promise<void> {
  const expires = new Date(Math.min(Date.parse(input.receivedAt), now.getTime()) + PHOTO_TEXT_TTL_MS).toISOString();
  if (expires <= now.toISOString()) return;
  await db.prepare(`INSERT OR IGNORE INTO line_photo_context_texts
    (ward_id, destination, source_type, source_id, event_id, received_at, text, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(wardId, input.destination, input.sourceType, input.sourceId, input.eventId, input.receivedAt, input.text, expires).run();
}

export async function purgePhotoTexts(db: D1Database, wardId: string, now = new Date()): Promise<void> {
  await db.prepare("DELETE FROM line_photo_context_texts WHERE ward_id = ? AND expires_at <= ?")
    .bind(wardId, now.toISOString()).run();
}

/** 解決した写真の前後の文を消す。重なる未解決の写真に必要な間だけは残す。 */
export async function clearPhotoTexts(db: D1Database, wardId: string, batch: PhotoBatchContext): Promise<void> {
  await db.prepare(`DELETE FROM line_photo_context_texts WHERE ward_id = ? AND destination = ? AND source_type = ? AND source_id = ?
    AND received_at >= ? AND received_at <= ? AND NOT EXISTS (
      SELECT 1 FROM line_photo_batches b WHERE b.ward_id = line_photo_context_texts.ward_id
      AND b.destination = line_photo_context_texts.destination AND b.source_type = line_photo_context_texts.source_type
      AND b.source_id = line_photo_context_texts.source_id AND b.match_finished_at IS NULL AND b.batch_id <> ?
      AND line_photo_context_texts.received_at >= strftime('%Y-%m-%dT%H:%M:%fZ', b.created_at, '-30 minutes')
      AND line_photo_context_texts.received_at <= strftime('%Y-%m-%dT%H:%M:%fZ', b.last_received_at, '+10 minutes'))`)
    .bind(wardId, batch.destination, batch.source_type, batch.source_id,
      new Date(Date.parse(batch.created_at) - PHOTO_CONTEXT_GAP_MS).toISOString(),
      new Date(Date.parse(batch.last_received_at) + PHOTO_AFTER_MS).toISOString(), batch.batch_id).run();
}

/** 場所と直前の写真は候補を選ぶ資料にする。ここでは当て先を決めない。 */
export async function photoContextProject(db: D1Database, wardId: string, batch: PhotoBatchContext, now = new Date()): Promise<NonNullable<MatchInput["photoContext"]>> {
  const start = new Date(Date.parse(batch.created_at) - PHOTO_CONTEXT_GAP_MS).toISOString();
  const end = new Date(Math.min(now.getTime(), Date.parse(batch.last_received_at) + PHOTO_AFTER_MS)).toISOString();
  const before = await db.prepare(`SELECT received_at AS at, 'text' AS kind, text AS summary, NULL AS job_id
    FROM line_photo_context_texts WHERE ward_id = ? AND destination = ? AND source_type = ? AND source_id = ?
      AND received_at >= ? AND received_at < ? AND expires_at > ?
    UNION ALL SELECT b.created_at AS at, 'photo' AS kind, NULL AS summary, i.job_id FROM line_photo_batches b
    JOIN line_photo_items i ON i.ward_id = b.ward_id AND i.batch_id = b.batch_id
    JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id
    WHERE b.ward_id = ? AND b.destination = ? AND b.source_type = ? AND b.source_id = ?
      AND b.created_at >= ? AND b.created_at < ? AND b.batch_id <> ? AND j.withdrawn_at IS NULL
    ORDER BY at DESC LIMIT 20`)
    .bind(wardId, batch.destination, batch.source_type, batch.source_id, start, batch.created_at, now.toISOString(),
      wardId, batch.destination, batch.source_type, batch.source_id, start, batch.created_at, batch.batch_id)
    .all<{ at: string; kind: "text" | "photo"; summary: string | null; job_id: string | null }>();
  const prior = await Promise.all(before.results.reverse().map(async (row) => ({ at: row.at, kind: row.kind,
    summary: row.job_id ? (await getReadings(db, wardId, row.job_id)).map((reading) => reading.body.summary).join("\n") || "文字のない写真" : row.summary ?? "" })));
  const after = await db.prepare(`SELECT received_at AS at, text AS summary FROM line_photo_context_texts
    WHERE ward_id = ? AND destination = ? AND source_type = ? AND source_id = ?
      AND received_at >= ? AND received_at <= ? AND expires_at > ? ORDER BY received_at, event_id`)
    .bind(wardId, batch.destination, batch.source_type, batch.source_id, batch.created_at, end, now.toISOString())
    .all<{ at: string; summary: string }>();
  const place = await db.prepare(`SELECT s.project_id FROM line_photo_sources s JOIN projects p
    ON p.ward_id = s.ward_id AND p.project_id = s.project_id WHERE s.ward_id = ? AND s.destination = ?
      AND s.source_type = ? AND s.source_id = ? AND p.closed_at IS NULL`)
    .bind(wardId, batch.destination, batch.source_type, batch.source_id).first<{ project_id: string }>();
  const previous = await db.prepare(`SELECT j.project_id FROM line_photo_batches b
    JOIN line_photo_items i ON i.ward_id = b.ward_id AND i.batch_id = b.batch_id
    JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id
    JOIN projects p ON p.ward_id = j.ward_id AND p.project_id = j.project_id
    WHERE b.ward_id = ? AND b.destination = ? AND b.source_type = ? AND b.source_id = ?
      AND b.created_at >= ? AND b.created_at < ? AND b.batch_id <> ?
      AND j.withdrawn_at IS NULL AND p.closed_at IS NULL ORDER BY b.created_at DESC, i.image_index DESC LIMIT 1`)
    .bind(wardId, batch.destination, batch.source_type, batch.source_id, start, batch.created_at, batch.batch_id)
    .first<{ project_id: string }>();
  return { before: prior, after: after.results, placeProjectId: place?.project_id ?? null,
    previousPhotoProjectId: previous?.project_id ?? null, receivedAt: batch.created_at };
}

/** 当てる時だけ、開いている行事の仕事と日付を渡す。 */
export async function photoMatchCandidates(db: D1Database, wardId: string) {
  const projects = await db.prepare("SELECT project_id, title FROM projects WHERE ward_id = ? AND closed_at IS NULL ORDER BY created_at")
    .bind(wardId).all<{ project_id: string; title: string }>();
  return Promise.all(projects.results.map(async (project) => {
    const dates = await db.prepare("SELECT kind, due_on FROM project_deadlines WHERE ward_id = ? AND project_id = ? ORDER BY due_on")
      .bind(wardId, project.project_id).all<{ kind: string; due_on: string }>();
    const tasks = await db.prepare(`SELECT name, period_start, period_end, progress FROM project_map_tasks
      WHERE ward_id = ? AND project_id = ? AND removed_at IS NULL AND progress <> 'done' ORDER BY period_start, task_id`)
      .bind(wardId, project.project_id).all<{ name: string; period_start: string | null; period_end: string | null; progress: string }>();
    return { id: project.project_id, title: project.title, detail: JSON.stringify({ dates: dates.results, tasks: tasks.results }) };
  }));
}
