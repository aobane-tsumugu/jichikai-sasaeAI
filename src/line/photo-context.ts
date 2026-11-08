import type { MatchInput } from "../ai/match";
import { getReadings } from "../intake/store";
import { sha256Hex } from "../intake/media";
import type { PhotoSource } from "./clarifications";

// 買い出しや設営で撮って送り直す間をつなぐ仮の幅。別の作業まで長く持ち越さない。
export const PHOTO_CONTEXT_GAP_MS = 30 * 60_000;
export const PHOTO_GROUP_GAP_MS = 5000;

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

/** 送信者とトークが同じ直前の投稿を、D1の一つの更新で結ぶ。本文はここに保存しない。 */
export async function joinLineBundle(db: D1Database, wardId: string, destination: string, eventId: string, source: PhotoSource, receivedAt: string): Promise<string> {
  // 送信元と送信者のIDは残さず、回数制限と同じSHA-256で同じ人かだけを比べる。
  const sourceHash = await sha256Hex(source.id);
  const senderHash = await sha256Hex(source.senderId || source.id);
  await db.prepare(`UPDATE line_webhook_receipts SET destination = ?, source_type = ?, source_hash = ?, sender_hash = ?, received_at = ?,
    bundle_id = COALESCE((SELECT r.bundle_id FROM line_webhook_receipts r WHERE r.ward_id = ?
      AND r.destination = ? AND r.source_type = ? AND r.source_hash = ? AND r.sender_hash = ? AND r.event_id <> ? AND ? <> ''
      AND r.received_at >= ? AND r.received_at <= ? AND r.bundle_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM line_webhook_receipts newer WHERE newer.ward_id = r.ward_id
        AND newer.destination = r.destination AND newer.source_type = r.source_type AND newer.source_hash = r.source_hash
        AND newer.event_id <> ? AND newer.received_at > r.received_at AND newer.received_at <= ?)
      ORDER BY r.received_at DESC, r.event_id DESC LIMIT 1), ?)
    WHERE ward_id = ? AND event_id = ? AND bundle_id IS NULL`)
    .bind(destination, source.type, sourceHash, senderHash, receivedAt, wardId, destination, source.type, sourceHash, senderHash, eventId, source.senderId ? senderHash : "",
      new Date(Date.parse(receivedAt) - PHOTO_AFTER_MS).toISOString(), receivedAt, eventId, receivedAt, eventId, wardId, eventId).run();
  const row = await db.prepare("SELECT bundle_id FROM line_webhook_receipts WHERE ward_id = ? AND event_id = ?")
    .bind(wardId, eventId).first<{ bundle_id: string }>();
  return row?.bundle_id ?? eventId;
}

/** 受領と問い合わせの一言は同じまとまりで一回。到達不明でも重ねて送らない。 */
export async function claimLineBundleReply(db: D1Database, wardId: string, bundleId: string, eventId: string, now: Date): Promise<boolean> {
  const result = await db.prepare(`UPDATE line_webhook_receipts SET bundle_reply_claimed_at = ?
    WHERE ward_id = ? AND event_id = ? AND bundle_id = ? AND bundle_reply_claimed_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM line_webhook_receipts r WHERE r.ward_id = ? AND r.bundle_id = ? AND r.bundle_reply_claimed_at IS NOT NULL)`)
    .bind(now.toISOString(), wardId, eventId, bundleId, wardId, bundleId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function lineBundleContents(db: D1Database, wardId: string, bundleId: string) {
  const rows = await db.prepare(`SELECT i.item_id, i.job_id, i.event_id, i.original_kind, i.original_text, i.received_at
    FROM line_inbox_items i LEFT JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id
    WHERE i.ward_id = ? AND i.bundle_id = ? AND (i.job_id IS NULL OR j.withdrawn_at IS NULL)
    UNION ALL SELECT t.event_id AS item_id, NULL AS job_id, t.event_id, 'text' AS original_kind, t.text AS original_text, t.received_at
    FROM line_talk_inquiry_posts t WHERE t.ward_id = ? AND t.bundle_id = ?
    ORDER BY 6, 3`).bind(wardId, bundleId, wardId, bundleId).all<{
      item_id: string; job_id: string | null; event_id: string; original_kind: string; original_text: string | null; received_at: string;
    }>();
  const inquiry = await db.prepare("SELECT subject FROM inquiry_records WHERE ward_id = ? AND line_bundle_id = ?")
    .bind(wardId, bundleId).first<{ subject: string }>();
  return { items: rows.results, text: rows.results.filter((r) => r.original_kind === "text").map((r) => r.original_text ?? "").filter(Boolean).join("\n") || inquiry?.subject || "",
    photos: rows.results.filter((r) => r.original_kind === "image") };
}

/** 言葉の側にも、同じ人が一緒に送った写真の読みを渡す。 */
export async function lineBundlePhotoSummaries(db: D1Database, wardId: string, bundleId: string): Promise<string[]> {
  const { photos } = await lineBundleContents(db, wardId, bundleId);
  return Promise.all(photos.map(async (photo) => photo.job_id
    ? (await getReadings(db, wardId, photo.job_id)).map((r) => r.body.summary).join("\n") || "読み取りを待っている写真"
    : "届いた写真"));
}

// 撮り直しの選択も、同じトークで一時に持つ。普通の文と区別し、AIや記録へ渡さない。
const retakeEventId = (source: PhotoSource) => `retake:${JSON.stringify([source.type, source.id, source.senderId])}`;

export async function rememberPhotoRetake(db: D1Database, wardId: string, destination: string, source: PhotoSource, clarificationId: string, now: Date): Promise<void> {
  await db.prepare(`INSERT INTO line_photo_context_texts
    (ward_id, destination, source_type, source_id, event_id, received_at, text, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (ward_id, destination, event_id) DO UPDATE SET received_at = excluded.received_at, text = excluded.text, expires_at = excluded.expires_at`)
    .bind(wardId, destination, source.type, source.id, retakeEventId(source), now.toISOString(), clarificationId,
      new Date(now.getTime() + PHOTO_CONTEXT_GAP_MS).toISOString()).run();
}

export async function selectedPhotoRetake(db: D1Database, wardId: string, destination: string, source: PhotoSource, now: Date): Promise<string | undefined> {
  const row = await db.prepare(`SELECT text FROM line_photo_context_texts WHERE ward_id = ? AND destination = ?
    AND source_type = ? AND source_id = ? AND event_id = ? AND expires_at > ?`)
    .bind(wardId, destination, source.type, source.id, retakeEventId(source), now.toISOString()).first<{ text: string }>();
  return row?.text;
}

export async function forgetPhotoRetake(db: D1Database, wardId: string, destination: string, source: PhotoSource, clarificationId: string): Promise<void> {
  await db.prepare(`DELETE FROM line_photo_context_texts WHERE ward_id = ? AND destination = ?
    AND source_type = ? AND source_id = ? AND event_id = ? AND text = ?`)
    .bind(wardId, destination, source.type, source.id, retakeEventId(source), clarificationId).run();
}

export interface PhotoBatchContext {
  batch_id: string; destination: string; source_type: string; source_id: string;
  sender_id?: string;
  created_at: string; last_received_at: string;
  match_attempted_at: string | null; match_finished_at: string | null;
  match_reason: string | null;
}

/** 当てるための一時の写し。残す言葉の本体はline_inbox_itemsに保存する。 */
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
    AND event_id NOT LIKE 'retake:%'
    AND NOT EXISTS (SELECT 1 FROM line_inbox_items i WHERE i.ward_id = line_photo_context_texts.ward_id
      AND i.event_id = line_photo_context_texts.event_id AND i.bundle_id IS NOT NULL)
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
  const sender = batch.sender_id ?? "";
  const senderHash = await sha256Hex(sender || batch.source_id);
  const texts = await db.prepare(`SELECT t.received_at AS at, t.text AS summary FROM line_photo_context_texts t
    WHERE t.ward_id = ? AND t.destination = ? AND t.source_type = ? AND t.source_id = ? AND t.event_id NOT LIKE 'retake:%'
    AND t.received_at >= ? AND t.received_at <= ? AND t.expires_at > ?
    AND (t.source_type = 'user' OR EXISTS (SELECT 1 FROM line_webhook_receipts r WHERE r.ward_id = t.ward_id AND r.event_id = t.event_id AND r.sender_hash = ?))
    AND NOT EXISTS (SELECT 1 FROM line_inbox_items i WHERE i.ward_id = t.ward_id AND i.event_id = t.event_id AND i.bundle_id IS NOT NULL)
    UNION ALL SELECT i.received_at AS at, i.original_text AS summary FROM line_inbox_items i
    WHERE i.ward_id = ? AND i.line_destination = ? AND i.source_type = ? AND i.source_id = ? AND i.sender_id = ? AND i.original_kind = 'text'
      AND i.bundle_id IS NOT NULL AND i.received_at >= ? AND i.received_at <= ?
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.ward_id = i.ward_id AND j.job_id = i.job_id AND j.withdrawn_at IS NOT NULL)
    ORDER BY at`)
    .bind(wardId, batch.destination, batch.source_type, batch.source_id, start, end, now.toISOString(), senderHash,
      wardId, batch.destination, batch.source_type, batch.source_id, sender, start, end).all<{ at: string; summary: string }>();
  const before = await db.prepare(`SELECT b.created_at AS at, 'photo' AS kind, NULL AS summary, i.job_id FROM line_photo_batches b
    JOIN line_photo_items i ON i.ward_id = b.ward_id AND i.batch_id = b.batch_id
    JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id
    WHERE b.ward_id = ? AND b.destination = ? AND b.source_type = ? AND b.source_id = ?
      AND b.sender_id = ? AND b.created_at >= ? AND b.created_at < ? AND b.batch_id <> ? AND j.withdrawn_at IS NULL
    ORDER BY at DESC LIMIT 20`)
    .bind(wardId, batch.destination, batch.source_type, batch.source_id, sender, start, batch.created_at, batch.batch_id)
    .all<{ at: string; kind: "text" | "photo"; summary: string | null; job_id: string | null }>();
  const prior = await Promise.all([...before.results, ...texts.results.filter((t) => t.at < batch.created_at).map((t) => ({ ...t, kind: "text" as const, job_id: null }))]
    .sort((a, b) => a.at.localeCompare(b.at)).slice(-20).map(async (row) => ({ at: row.at, kind: row.kind,
    summary: row.job_id ? (await getReadings(db, wardId, row.job_id)).map((reading) => reading.body.summary).join("\n") || "文字のない写真" : row.summary ?? "" })));
  const after = texts.results.filter((t) => t.at >= batch.created_at);
  const place = await db.prepare(`SELECT s.project_id FROM line_photo_sources s JOIN projects p
    ON p.ward_id = s.ward_id AND p.project_id = s.project_id WHERE s.ward_id = ? AND s.destination = ?
      AND s.source_type = ? AND s.source_id = ? AND p.closed_at IS NULL`)
    .bind(wardId, batch.destination, batch.source_type, batch.source_id).first<{ project_id: string }>();
  const previous = await db.prepare(`SELECT j.project_id FROM line_photo_batches b
    JOIN line_photo_items i ON i.ward_id = b.ward_id AND i.batch_id = b.batch_id
    JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id
    JOIN projects p ON p.ward_id = j.ward_id AND p.project_id = j.project_id
    WHERE b.ward_id = ? AND b.destination = ? AND b.source_type = ? AND b.source_id = ?
      AND b.sender_id = ? AND b.created_at >= ? AND b.created_at < ? AND b.batch_id <> ?
      AND j.withdrawn_at IS NULL AND p.closed_at IS NULL ORDER BY b.created_at DESC, i.image_index DESC LIMIT 1`)
    .bind(wardId, batch.destination, batch.source_type, batch.source_id, sender, start, batch.created_at, batch.batch_id)
    .first<{ project_id: string }>();
  const questions = await db.prepare(`SELECT c.clarification_id AS id, j.project_id AS projectId, c.topic, c.text
    FROM line_clarifications c JOIN line_photo_batches b ON b.ward_id = c.ward_id AND b.batch_id = c.batch_id
    JOIN jobs j ON j.ward_id = c.ward_id AND j.job_id = c.job_id
    WHERE c.ward_id = ? AND b.destination = ? AND b.source_type = ? AND b.source_id = ?
      AND c.answer IS NULL AND c.sent_at >= ? AND c.sent_at <= ? AND j.withdrawn_at IS NULL
    ORDER BY c.sent_at DESC LIMIT 20`)
    .bind(wardId, batch.destination, batch.source_type, batch.source_id, start, batch.created_at)
    .all<NonNullable<MatchInput["photoContext"]>["unresolvedQuestions"][number]>();
  const own = await db.prepare(`SELECT DISTINCT i.bundle_id FROM line_inbox_items i JOIN line_photo_items p
    ON p.ward_id = i.ward_id AND p.job_id = i.job_id WHERE i.ward_id = ? AND p.batch_id = ? AND i.bundle_id IS NOT NULL`)
    .bind(wardId, batch.batch_id).all<{ bundle_id: string }>();
  const accompanyingText = (await Promise.all(own.results.map(async (row) => (await lineBundleContents(db, wardId, row.bundle_id)).text))).filter(Boolean).join("\n");
  return { before: prior, after, placeProjectId: place?.project_id ?? null, unresolvedQuestions: questions.results,
    previousPhotoProjectId: previous?.project_id ?? null, receivedAt: batch.created_at, ...(accompanyingText ? { accompanyingText } : {}) };
}

/** 当てる時だけ、開いている行事の仕事と日付を渡す。 */
export async function photoMatchCandidates(db: D1Database, wardId: string) {
  const projects = await db.prepare("SELECT project_id, title FROM projects WHERE ward_id = ? AND is_ward_notices = 0 AND closed_at IS NULL ORDER BY created_at")
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
