import { eraseCopiedContent, eraseReadingOriginals, eraseSnapshotJobs, eraseSnapshotRecord, eraseWardMaterialContent, listRecordWardIds, questionUsesOriginal, WARD_TABLE_POLICY } from "../archive/snapshot";
import { CRON } from "../core/cron";
import { newId, nowIso } from "../core/ids";
import { WardBucket } from "../core/storage";
import type { Env } from "../env";
import { getClient } from "../ai/deps";
import { deleteSession, pendingSessions } from "../ai/complete";
import { BACKUP_PAGE_SIZE, deleteRecordObject, putRecordSnapshot, snapshotPage, withRecordLock } from "../archive/backup";
import { CONTACT_WARD } from "../contact/store";

const EXPORT_TABLES = WARD_TABLE_POLICY.filter((entry) => entry.export === true);
const WARD_DELETE_TABLES = WARD_TABLE_POLICY.filter((entry) => entry.deletion === true).map((entry) => entry.table).reverse();

interface QueueRow {
  queue_id: string;
  ward_id: string;
  target_type: "job" | "ward" | "answer" | "project" | "inquiry" | "help_offer";
  target_id: string | null;
  cursor: string | null;
}

export async function requestProjectDeletion(db: D1Database, wardId: string, projectId: string): Promise<boolean> {
  const project = await db.prepare("SELECT project_id FROM projects WHERE ward_id = ? AND project_id = ?")
    .bind(wardId, projectId).first();
  if (!project) return false;
  await db.prepare(`INSERT INTO ops_deletion_queue (queue_id, ward_id, target_type, target_id, requested_at)
    SELECT ?, ?, 'project', ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM ops_deletion_queue WHERE ward_id = ? AND target_type = 'project' AND target_id = ? AND state IN ('pending', 'running', 'error')
    )`).bind(newId(), wardId, projectId, nowIso(), wardId, projectId).run();
  return true;
}

export async function requestJobDeletion(db: D1Database, wardId: string, jobId: string): Promise<string> {
  const exists = await db.prepare("SELECT job_id FROM jobs WHERE ward_id = ? AND job_id = ?")
    .bind(wardId, jobId).first<{ job_id: string }>();
  if (!exists) throw new Error("対象の記録が見つかりません");
  const existing = await db.prepare(`SELECT queue_id FROM ops_deletion_queue
    WHERE ward_id = ? AND target_type = 'job' AND target_id = ? AND state IN ('pending', 'running', 'error')
    ORDER BY requested_at LIMIT 1`).bind(wardId, jobId).first<{ queue_id: string }>();
  if (existing) return existing.queue_id;
  const queueId = newId();
  const requestedAt = nowIso();
  await db.batch([
    db.prepare(`UPDATE jobs SET status = 'withdrawn', ticket_hash = NULL, withdrawn_at = ?, updated_at = ?
      WHERE ward_id = ? AND job_id = ? AND withdrawn_at IS NULL`).bind(requestedAt, requestedAt, wardId, jobId),
    db.prepare(`INSERT INTO ops_deletion_queue (queue_id, ward_id, target_type, target_id, requested_at)
      SELECT ?, ?, 'job', ?, ? WHERE NOT EXISTS (SELECT 1 FROM ops_deletion_queue
        WHERE ward_id = ? AND target_type = 'job' AND target_id = ? AND state IN ('pending', 'running', 'error'))`)
      .bind(queueId, wardId, jobId, requestedAt, wardId, jobId),
  ]);
  const queued = await db.prepare("SELECT queue_id FROM ops_deletion_queue WHERE ward_id = ? AND target_type = 'job' AND target_id = ? ORDER BY requested_at LIMIT 1")
    .bind(wardId, jobId).first<{ queue_id: string }>();
  return queued?.queue_id ?? queueId;
}

/**
 * Web と電話で受けた回答を消す。回答の表からはすぐ消し、日次の写しの書き直しは列で続ける。
 * 回答票の写真から入った回答（原本がある物）は、記録の消去で原本と一緒に消す。
 */
export async function requestAnswerDeletion(db: D1Database, wardId: string, answerId: string): Promise<boolean> {
  const requestedAt = nowIso();
  const [removed] = await db.batch([
    db.prepare("DELETE FROM project_answers WHERE ward_id = ? AND answer_id = ? AND original_id IS NULL").bind(wardId, answerId),
    db.prepare(`INSERT INTO ops_deletion_queue (queue_id, ward_id, target_type, target_id, requested_at)
      SELECT ?, ?, 'answer', ?, ? WHERE changes() = 1`).bind(newId(), wardId, answerId, requestedAt),
  ]);
  return (removed?.meta.changes ?? 0) === 1;
}

async function eraseAnswer(env: Env, item: QueueRow): Promise<void> {
  const wardId = item.ward_id;
  const answerId = item.target_id ?? "";
  const cursor = item.cursor?.startsWith("snapshots:") ? item.cursor.slice("snapshots:".length) : undefined;
  const page = await snapshotPage(env, wardId, cursor);
  const bucket = page.bucket;
  for (const entry of page.keys) {
    const object = await bucket.get(entry.key);
    if (!object) continue;
    let value: unknown;
    try { value = await object.json(); } catch { await deleteRecordObject(env, wardId, entry.key); continue; }
    if (typeof value !== "object" || value === null || Array.isArray(value)) { await deleteRecordObject(env, wardId, entry.key); continue; }
    const doc = value as { wardId?: unknown; tables?: Record<string, unknown> };
    if (doc.wardId !== wardId || typeof doc.tables !== "object" || doc.tables === null) { await deleteRecordObject(env, wardId, entry.key); continue; }
    const rewritten = eraseSnapshotRecord(doc, wardId, wardId === CONTACT_WARD ? "provider_contact" : item.target_type, answerId);
    if (rewritten === null) { await deleteRecordObject(env, wardId, entry.key); continue; }
    await putRecordSnapshot(env, wardId, entry.key, rewritten);
  }
  if (page.next) {
    await env.DB.prepare("UPDATE ops_deletion_queue SET cursor = ?, state = 'running', last_error = '' WHERE queue_id = ? AND ward_id = ?")
      .bind(`snapshots:${page.next}`, item.queue_id, wardId).run();
    return;
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ops_deletion_queue WHERE queue_id = ? AND ward_id = ?").bind(item.queue_id, wardId),
    env.DB.prepare("INSERT INTO ops_deletion_marks (mark_id, ward_id, scope, deleted_at, target_type, target_id) VALUES (?, ?, 'record', ?, ?, ?)").bind(newId(), wardId, nowIso(), wardId === CONTACT_WARD ? "provider_contact" : item.target_type, item.target_id),
  ]);
}

export async function requestWardDeletion(db: D1Database, wardId: string): Promise<string> {
  const existing = await db.prepare(`SELECT queue_id FROM ops_deletion_queue
    WHERE ward_id = ? AND target_type = 'ward' AND state IN ('pending', 'running', 'error')
    ORDER BY requested_at LIMIT 1`).bind(wardId).first<{ queue_id: string }>();
  if (existing) return existing.queue_id;
  const queueId = newId();
  await db.batch([
    db.prepare("UPDATE wards SET is_active = 0 WHERE ward_id = ?").bind(wardId),
    db.prepare(`INSERT INTO ops_deletion_queue (queue_id, ward_id, target_type, requested_at)
      VALUES (?, ?, 'ward', ?)`)
      .bind(queueId, wardId, nowIso()),
  ]);
  return queueId;
}

export async function listDeletionQueue(db: D1Database, wardId: string) {
  const rows = await db.prepare(`SELECT queue_id, target_type, state, last_error, requested_at, completed_at
    FROM ops_deletion_queue WHERE ward_id = ? ORDER BY requested_at DESC LIMIT 50`).bind(wardId)
    .all<{ queue_id: string; target_type: string; state: string; last_error: string; requested_at: string; completed_at: string | null }>();
  return rows.results;
}

export async function listDeletionMarks(db: D1Database, wardId: string) {
  const rows = await db.prepare("SELECT scope, deleted_at FROM ops_deletion_marks WHERE ward_id = ? ORDER BY deleted_at DESC LIMIT 50")
    .bind(wardId).all<{ scope: string; deleted_at: string }>();
  return rows.results;
}

export async function exportWard(env: Env, wardId: string): Promise<{ body: string; filename: string }> {
  const ward = await env.DB.prepare("SELECT ward_id, slug, name, created_at, is_active FROM wards WHERE ward_id = ?")
    .bind(wardId).first<{ ward_id: string; slug: string; name: string; created_at: string; is_active: number }>();
  if (!ward) throw new Error("自治会が見つかりません");
  const tables: Record<string, unknown[]> = {};
  for (const { table, omitExportColumns } of EXPORT_TABLES) {
    const rows = await env.DB.prepare(`SELECT * FROM ${table} WHERE ward_id = ?`).bind(wardId).all<Record<string, unknown>>();
    tables[table] = rows.results.map((row) => Object.fromEntries(
      Object.entries(row).filter(([column]) => !omitExportColumns?.includes(column))));
  }
  const objects: Array<{ key: string; mediaType: string; base64: string }> = [];
  const bucket = new WardBucket(env.ORIGINALS, wardId);
  let cursor: string | undefined;
  do {
    const page = await bucket.list("", { limit: 1000, cursor });
    for (const listed of page.keys) {
      // 復旧用の写しには認証情報があるため、区へ渡す原本には含めない。
      if (listed.key.startsWith("snapshots/")) continue;
      const object = await bucket.get(listed.key);
      if (!object) continue;
      const bytes = new Uint8Array(await object.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      objects.push({ key: listed.key, mediaType: object.httpMetadata?.contentType ?? "application/octet-stream", base64: btoa(binary) });
    }
    cursor = page.cursor;
  } while (cursor);
  return {
    body: JSON.stringify({ format: 1, exportedAt: nowIso(), ward, tables, objects }, null, 2),
    filename: `${ward.slug}-records-${new Date().toISOString().slice(0, 10)}.json`,
  };
}

export interface SnapshotStatus {
  key: string;
  capturedAt: string;
  tableCount: number;
  rowCount: number;
  valid: boolean;
  problem: string;
}

export async function inspectSnapshots(env: Env, wardId: string): Promise<SnapshotStatus[]> {
  const bucket = new WardBucket(env.ORIGINALS, wardId);
  const files: SnapshotStatus[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list("snapshots/daily/", { limit: 1000, cursor });
    for (const item of page.keys) {
      const status: SnapshotStatus = { key: item.key, capturedAt: "", tableCount: 0, rowCount: 0, valid: false, problem: "読めません" };
      try {
        const object = await bucket.get(item.key);
        if (!object) { files.push(status); continue; }
        const value: unknown = await object.json();
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("形が違います");
        const data = value as { format?: unknown; wardId?: unknown; capturedAt?: unknown; tables?: unknown };
        if (data.format !== 1 || data.wardId !== wardId || typeof data.capturedAt !== "string" || typeof data.tables !== "object" || data.tables === null || Array.isArray(data.tables)) throw new Error("自治会または項目を確認できません");
        const tables = data.tables as Record<string, unknown>;
        const rows = Object.values(tables);
        if (rows.some((tableRows) => !Array.isArray(tableRows))) throw new Error("記録の表を読み取れません");
        if (rows.some((tableRows) => (tableRows as unknown[]).some((row) =>
          typeof row !== "object" || row === null || (row as { ward_id?: unknown }).ward_id !== wardId))) {
          throw new Error("別の自治会の行、または自治会を確認できない行があります");
        }
        status.capturedAt = data.capturedAt;
        status.tableCount = rows.length;
        status.rowCount = rows.reduce<number>((total, tableRows) => total + (tableRows as unknown[]).length, 0);
        status.valid = true;
        status.problem = "";
      } catch (error) {
        status.problem = error instanceof Error ? error.message : "形式を確認できません";
      }
      files.push(status);
    }
    cursor = page.cursor;
  } while (cursor);
  return files.sort((a, b) => b.key.localeCompare(a.key));
}


interface SnapshotDeletionBatch {
  items: Array<{ queue_id: string; target_type: "job" | "project"; target_id: string }>;
  cursor?: string;
}

async function rewriteJobSnapshots(env: Env, item: QueueRow): Promise<void> {
  const wardId = item.ward_id;
  // 同じ写しの次のページにも同じ求めだけを当てる。途中から来た求めは次の一巡に回す。
  const batch: SnapshotDeletionBatch = item.cursor?.startsWith("batch:")
    ? JSON.parse(item.cursor.slice(6)) as SnapshotDeletionBatch
    : { items: (await env.DB.prepare(`SELECT queue_id, target_type, target_id FROM ops_deletion_queue
        WHERE ward_id = ? AND target_type IN ('job', 'project') AND state IN ('pending', 'running', 'error')
          AND (cursor IS NULL OR cursor NOT IN ('record', 'records', 'mark')) ORDER BY requested_at, rowid`)
        .bind(wardId).all<SnapshotDeletionBatch["items"][number]>()).results };
  const saveCursor = (value: SnapshotDeletionBatch) => env.DB.prepare("UPDATE ops_deletion_queue SET cursor = ? WHERE ward_id = ? AND queue_id = ?")
    .bind(`batch:${JSON.stringify(value)}`, wardId, item.queue_id).run();
  if (!item.cursor?.startsWith("batch:")) await saveCursor(batch);
  const jobIds = new Set(batch.items.filter((row) => row.target_type === "job").map((row) => row.target_id));
  const projectIds = new Set(batch.items.filter((row) => row.target_type === "project").map((row) => row.target_id));
  for (const projectId of projectIds) {
    const jobs = await env.DB.prepare("SELECT job_id FROM jobs WHERE ward_id = ? AND project_id = ?").bind(wardId, projectId).all<{ job_id: string }>();
    for (const job of jobs.results) jobIds.add(job.job_id);
    await env.DB.prepare(`UPDATE jobs SET status = 'withdrawn', ticket_hash = NULL, lease_until = NULL,
      withdrawn_at = COALESCE(withdrawn_at, ?), updated_at = ? WHERE ward_id = ? AND project_id = ?`)
      .bind(nowIso(), nowIso(), wardId, projectId).run();
  }
  const originalIds = new Set<string>();
  const currentPaths = new Set<string>();
  const readingBodies = new Set<string>();
  const ids = [...jobIds];
  for (let offset = 0; offset < ids.length; offset += 50) {
    const part = ids.slice(offset, offset + 50);
    const places = part.map(() => "?").join(",");
    const [originals, readings] = await Promise.all([
      env.DB.prepare(`SELECT original_id, r2_path FROM originals WHERE ward_id = ? AND job_id IN (${places})`).bind(wardId, ...part).all<{ original_id: string; r2_path: string | null }>(),
      env.DB.prepare(`SELECT body FROM readings WHERE ward_id = ? AND job_id IN (${places})`).bind(wardId, ...part).all<{ body: string }>(),
    ]);
    for (const row of originals.results) { originalIds.add(row.original_id); currentPaths.add(row.r2_path ?? `originals/${row.original_id}`); }
    for (const row of readings.results) readingBodies.add(row.body);
  }
  const page = await snapshotPage(env, wardId, batch.cursor);
  const bucket = page.bucket;
  const deletedPaths = new Set<string>();
  for (const entry of page.keys) {
    const object = await bucket.get(entry.key);
    if (!object) continue;
    if (batch.cursor?.startsWith("backup:")) {
      const primary = await new WardBucket(env.ORIGINALS, wardId).head(entry.key);
      if (primary && object.customMetadata?.sourceVersion === primary.version) continue;
    }
    let value: unknown;
    try { value = await object.json(); } catch { await deleteRecordObject(env, wardId, entry.key); continue; }
    // 取り下げで現在のr2_pathが空でも、過去の写しが持つ原本の所在を消す。
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const doc = value as { wardId?: unknown; tables?: { originals?: unknown; jobs?: unknown } };
      if (doc.wardId === wardId && Array.isArray(doc.tables?.originals)) {
        const snapshotJobs = new Set(jobIds);
        if (Array.isArray(doc.tables.jobs)) for (const row of doc.tables.jobs as unknown[]) {
          if (typeof row !== "object" || row === null) continue;
          const job = row as { job_id?: unknown; project_id?: unknown };
          if (typeof job.job_id === "string" && typeof job.project_id === "string" && projectIds.has(job.project_id)) snapshotJobs.add(job.job_id);
        }
        for (const row of doc.tables.originals as unknown[]) {
          if (typeof row !== "object" || row === null) continue;
          const original = row as { original_id?: unknown; job_id?: unknown; r2_path?: unknown };
          if (((typeof original.job_id === "string" && snapshotJobs.has(original.job_id)) ||
            (typeof original.original_id === "string" && originalIds.has(original.original_id))) && typeof original.r2_path === "string" &&
            !currentPaths.has(original.r2_path) && !deletedPaths.has(original.r2_path)) {
            await deleteRecordObject(env, wardId, original.r2_path);
            deletedPaths.add(original.r2_path);
          }
        }
      }
    }
    const rewritten = eraseSnapshotJobs(value, wardId, jobIds, originalIds, readingBodies, projectIds);
    if (rewritten === null) { await deleteRecordObject(env, wardId, entry.key); continue; }
    await putRecordSnapshot(env, wardId, entry.key, rewritten);
  }
  if (page.next) { await saveCursor({ ...batch, cursor: page.next }); return; }
  // 全ページを書き終えた求めだけを次へ進める。失敗した場合は同じページからやり直す。
  await env.DB.batch(batch.items.map((row) => env.DB.prepare("UPDATE ops_deletion_queue SET cursor = ? WHERE ward_id = ? AND queue_id = ?")
    .bind(row.target_type === "job" ? "record" : "records", wardId, row.queue_id)));
}

async function eraseJobCopies(env: Env, wardId: string, jobId: string): Promise<void> {
  const originals = await env.DB.prepare("SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ?")
    .bind(wardId, jobId).all<{ original_id: string }>();
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const table of ["document_versions", "archive_search_entries", "project_rows", "project_changes", "project_questions", "readings", "paper_reading_slices", "ward_know_items", "ward_material_links", "ward_year_items"]) {
    tables[table] = (await env.DB.prepare(`SELECT * FROM ${table} WHERE ward_id = ?`).bind(wardId).all<Record<string, unknown>>()).results;
  }
  const before = new Map(tables.document_versions?.map((row) => [row, row.tables_snapshot] as const));
  const knowBefore = new Map(tables.ward_know_items?.map((row) => [row, JSON.stringify([row.body, row.proposed_text, row.proposed_original_id])] as const));
  const oldSearch = new Set(tables.archive_search_entries?.map((row) => Number(row.entry_id)));
  const originalIds = new Set(originals.results.map((row) => row.original_id));
  eraseCopiedContent(tables, originalIds);
  eraseWardMaterialContent(tables, originalIds);
  const statements: D1PreparedStatement[] = [];
  for (const row of tables.project_questions ?? []) {
    if (questionUsesOriginal(row.detail, originalIds)) statements.push(env.DB.prepare("DELETE FROM project_questions WHERE ward_id = ? AND question_id = ?")
      .bind(wardId, String(row.question_id)));
  }
  for (const table of ["readings", "paper_reading_slices"]) for (const row of tables[table] ?? []) {
    if (row.job_id === jobId || typeof row.body !== "string") continue;
    const cleaned = eraseReadingOriginals(row.body, originalIds);
    if (cleaned === row.body) continue;
    statements.push(env.DB.prepare(`UPDATE ${table} SET body = ? WHERE ward_id = ? AND ${table === "readings" ? "reading_id" : "job_id"} = ?`)
      .bind(cleaned, wardId, String(table === "readings" ? row.reading_id : row.job_id)));
  }
  for (const row of tables.ward_know_items ?? []) {
    if (knowBefore.get(row) === JSON.stringify([row.body, row.proposed_text, row.proposed_original_id])) continue;
    statements.push(env.DB.prepare(`UPDATE ward_know_items SET body = ?, proposed_text = ?, proposed_original_id = ? WHERE ward_id = ? AND item_id = ?`)
      .bind(String(row.body), String(row.proposed_text), row.proposed_original_id as string | null, wardId, String(row.item_id)));
  }
  statements.push(env.DB.prepare(`DELETE FROM ward_year_items WHERE ward_id = ? AND source_original_id IN
    (SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ?)`).bind(wardId, wardId, jobId));
  for (const row of tables.document_versions ?? []) {
    if (before.get(row) !== row.tables_snapshot) statements.push(env.DB.prepare(`UPDATE document_versions
      SET tables_snapshot = ? WHERE ward_id = ? AND version_id = ?`)
      .bind(row.tables_snapshot as string | null, wardId, String(row.version_id)));
  }
  for (const row of tables.archive_search_entries ?? []) oldSearch.delete(Number(row.entry_id));
  for (const id of oldSearch) statements.push(env.DB.prepare("DELETE FROM archive_search_entries WHERE ward_id = ? AND entry_id = ?").bind(wardId, id));
  if (statements.length) await env.DB.batch(statements);
}

async function eraseJob(env: Env, item: QueueRow, projectJob?: { jobId: string; cursor: string | null }): Promise<"continue" | "done"> {
  const wardId = item.ward_id;
  const jobId = projectJob?.jobId ?? item.target_id ?? "";
  for (const session of await pendingSessions(env.DB, wardId, jobId)) {
    if (!(await deleteSession(env, wardId, jobId, session.session_id))) throw new Error("AI側の処理を消せませんでした");
  }
  if ((await pendingSessions(env.DB, wardId, jobId)).length) return "continue";

  await eraseJobCopies(env, wardId, jobId);
  const originals = await env.DB.prepare("SELECT original_id, r2_path FROM originals WHERE ward_id = ? AND job_id = ?")
    .bind(wardId, jobId).all<{ original_id: string; r2_path: string | null }>();
  const inbox = await env.DB.prepare("SELECT original_object_key FROM line_inbox_items WHERE ward_id = ? AND job_id = ? AND original_object_key IS NOT NULL")
    .bind(wardId, jobId).all<{ original_object_key: string }>();
  for (const original of originals.results) await deleteRecordObject(env, wardId, original.r2_path ?? `originals/${original.original_id}`);
  for (const entry of inbox.results) await deleteRecordObject(env, wardId, entry.original_object_key);
  const statements = [
    env.DB.prepare("DELETE FROM archive_search_entries WHERE ward_id = ? AND record_type = 'reading' AND (source_id IN (SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ?) OR content IN (SELECT body FROM readings WHERE ward_id = ? AND job_id = ?))").bind(wardId, wardId, jobId, wardId, jobId),
    // プロジェクトごとの消去では、差分への参照を持つ問い・地図と一緒に後で消す。
    ...(!projectJob ? [
      env.DB.prepare("DELETE FROM project_item_values WHERE ward_id = ? AND source_ref IN (SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ?)").bind(wardId, wardId, jobId),
      env.DB.prepare("DELETE FROM project_rows WHERE ward_id = ? AND source_ref IN (SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ?)").bind(wardId, wardId, jobId),
      env.DB.prepare(`DELETE FROM project_questions WHERE ward_id = ? AND (
        source_ref IN (SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ?) OR
        change_id IN (SELECT change_id FROM project_changes WHERE ward_id = ? AND source_ref IN
          (SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ?)))`)
        .bind(wardId, wardId, jobId, wardId, wardId, jobId),
      env.DB.prepare(`UPDATE project_map_tasks SET progress = 'open', progress_source_kind = NULL, progress_source_ref = NULL,
        progress_source_locator = NULL, progress_confidence = NULL, progress_change_id = NULL WHERE ward_id = ? AND (
        progress_source_ref IN (SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ?) OR
        progress_change_id IN (SELECT change_id FROM project_changes WHERE ward_id = ? AND source_ref IN
          (SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ?)))`)
        .bind(wardId, wardId, jobId, wardId, wardId, jobId),
      env.DB.prepare("DELETE FROM project_changes WHERE ward_id = ? AND source_ref IN (SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ?)").bind(wardId, wardId, jobId),
    ] : []),
    env.DB.prepare("DELETE FROM project_answers WHERE ward_id = ? AND original_id IN (SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ?)").bind(wardId, wardId, jobId),
    env.DB.prepare("DELETE FROM line_inbox_items WHERE ward_id = ? AND job_id = ?").bind(wardId, jobId),
    env.DB.prepare("DELETE FROM paper_reading_slices WHERE ward_id = ? AND (job_id = ? OR source_job_id = ?)").bind(wardId, jobId, jobId),
    env.DB.prepare("DELETE FROM job_tool_calls WHERE ward_id = ? AND job_id = ?").bind(wardId, jobId),
    env.DB.prepare("DELETE FROM job_runs WHERE ward_id = ? AND job_id = ?").bind(wardId, jobId),
    env.DB.prepare("DELETE FROM readings WHERE ward_id = ? AND job_id = ?").bind(wardId, jobId),
    env.DB.prepare("DELETE FROM originals WHERE ward_id = ? AND job_id = ?").bind(wardId, jobId),
    env.DB.prepare("DELETE FROM jobs WHERE ward_id = ? AND job_id = ?").bind(wardId, jobId),
  ];
  await env.DB.batch(statements);
  if (projectJob) {
    await env.DB.prepare("UPDATE ops_deletion_queue SET cursor = 'records' WHERE ward_id = ? AND queue_id = ?")
      .bind(wardId, item.queue_id).run();
    return "done";
  }
  const at = nowIso();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ops_deletion_queue WHERE queue_id = ? AND ward_id = ?").bind(item.queue_id, wardId),
    env.DB.prepare("INSERT INTO ops_deletion_marks (mark_id, ward_id, scope, deleted_at, target_type, target_id) VALUES (?, ?, 'record', ?, ?, ?)").bind(newId(), wardId, at, item.target_type, item.target_id),
  ]);
  return "done";
}

const PROJECT_DELETE_TABLES = [
  "archive_search_entries", "project_activity_pages", "project_close_reports", "project_close_map",
  "project_answers", "project_answer_fields", "project_space_members", "project_space_invites", "project_spaces", "city_request_details",
  "publication_records", "document_versions", "documents", "project_questions", "project_rows", "project_item_values",
  "project_map_tasks", "project_changes", "project_deadlines", "projects",
] as const;

async function eraseProject(env: Env, item: QueueRow): Promise<void> {
  const wardId = item.ward_id;
  const projectId = item.target_id ?? "";
  if (item.cursor === "records") {
    const job = await env.DB.prepare("SELECT job_id FROM jobs WHERE ward_id = ? AND project_id = ? ORDER BY created_at, job_id LIMIT 1")
      .bind(wardId, projectId).first<{ job_id: string }>();
    if (job) {
      await env.DB.prepare("UPDATE jobs SET status = 'withdrawn', ticket_hash = NULL, withdrawn_at = COALESCE(withdrawn_at, ?), updated_at = ? WHERE ward_id = ? AND job_id = ?")
        .bind(nowIso(), nowIso(), wardId, job.job_id).run();
      await eraseJob(env, item, { jobId: job.job_id, cursor: "record" });
      return;
    }
    // 文書を消すとチラシの所在も連動して消えるため、先に画像本体と見本を消す。
    const flyers = await env.DB.prepare("SELECT r2_path, preview_r2_path FROM notice_flyers WHERE ward_id = ? AND project_id = ?")
      .bind(wardId, projectId).all<{ r2_path: string | null; preview_r2_path: string | null }>();
    for (const path of new Set(flyers.results.flatMap((flyer) => [flyer.r2_path, flyer.preview_r2_path]))) {
      if (path) await deleteRecordObject(env, wardId, path);
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE projects SET seed_project_id = NULL WHERE ward_id = ? AND seed_project_id = ?").bind(wardId, projectId),
      ...PROJECT_DELETE_TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table} WHERE ward_id = ? AND project_id = ?`).bind(wardId, projectId)),
      env.DB.prepare("UPDATE ops_deletion_queue SET cursor = 'mark' WHERE ward_id = ? AND queue_id = ?").bind(wardId, item.queue_id),
    ]);
    return;
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ops_deletion_queue WHERE ward_id = ? AND queue_id = ?").bind(wardId, item.queue_id),
    env.DB.prepare("INSERT INTO ops_deletion_marks (mark_id, ward_id, scope, deleted_at, target_type, target_id) VALUES (?, ?, 'record', ?, ?, ?)").bind(newId(), wardId, nowIso(), item.target_type, item.target_id),
  ]);
}

async function eraseWardData(env: Env, wardId: string, deletedAt: string): Promise<void> {
  const statements = WARD_DELETE_TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table} WHERE ward_id = ?`).bind(wardId));
  statements.unshift(env.DB.prepare("UPDATE projects SET seed_project_id = NULL WHERE ward_id = ?").bind(wardId));
  statements.unshift(env.DB.prepare("UPDATE accounts SET created_by_account_id = NULL, removed_by_account_id = NULL WHERE ward_id = ?").bind(wardId));
  // 処理待ちを消したのに消去の記録が残らない状態にしない。
  statements.push(env.DB.prepare("INSERT INTO ops_deletion_marks (mark_id, ward_id, scope, deleted_at) VALUES (?, ?, 'ward', ?)")
    .bind(newId(), wardId, deletedAt));
  await env.DB.batch(statements);
}

async function finishDeletion(env: Env, item: QueueRow): Promise<void> {
  const at = nowIso();
  if ((item.target_type === "job" || item.target_type === "project") &&
    item.cursor !== "record" && item.cursor !== "records" && item.cursor !== "mark") {
    await rewriteJobSnapshots(env, item);
    return;
  }
  if (item.target_type === "project" && item.target_id) {
    await eraseProject(env, item);
    return;
  }
  if (item.target_type === "job" && item.target_id) {
    await eraseJob(env, item);
    return;
  }
  if (["answer", "inquiry", "help_offer"].includes(item.target_type) && item.target_id) {
    await eraseAnswer(env, item);
    return;
  }
  if (item.cursor === null) {
    const ai = await env.DB.prepare("SELECT agent_id FROM ward_ai WHERE ward_id = ?")
      .bind(item.ward_id).first<{ agent_id: string | null }>();
    if (ai?.agent_id) {
      try { await getClient(env).beta.agents.archive(ai.agent_id); }
      catch (error) { if ((error as { status?: number } | null)?.status !== 404) throw error; }
    }
    await env.DB.prepare("UPDATE ops_deletion_queue SET cursor = 'sessions', state = 'running', last_error = '' WHERE queue_id = ? AND ward_id = ?")
      .bind(item.queue_id, item.ward_id).run();
    return;
  }
  if (item.cursor === "sessions") {
    const session = (await pendingSessions(env.DB, item.ward_id))[0];
    if (session) {
      if (!(await deleteSession(env, item.ward_id, session.job_id, session.session_id))) throw new Error("AI側の処理を消せませんでした");
      return;
    }
    const ai = await env.DB.prepare("SELECT vault_id FROM ward_ai WHERE ward_id = ?")
      .bind(item.ward_id).first<{ vault_id: string | null }>();
    if (ai?.vault_id) {
      try { await getClient(env).beta.vaults.delete(ai.vault_id); }
      catch (error) { if ((error as { status?: number } | null)?.status !== 404) throw error; }
    }
    await env.DB.prepare("UPDATE ops_deletion_queue SET cursor = 'r2', state = 'running', last_error = '' WHERE queue_id = ? AND ward_id = ?")
      .bind(item.queue_id, item.ward_id).run();
    return;
  }
  if (item.cursor === "r2" || item.cursor.startsWith("r2:")) {
    const cursor = item.cursor.startsWith("r2:") ? item.cursor.slice(3) : undefined;
    const bucket = new WardBucket(env.ORIGINALS, item.ward_id);
    const page = await bucket.list("", { limit: BACKUP_PAGE_SIZE, cursor });
    for (const object of page.keys) await deleteRecordObject(env, item.ward_id, object.key);
    const next = page.truncated && page.cursor ? `r2:${page.cursor}` : env.ORIGINALS_BACKUP ? "backup" : "database";
    await env.DB.prepare("UPDATE ops_deletion_queue SET cursor = ?, state = 'running', last_error = '' WHERE queue_id = ? AND ward_id = ?")
      .bind(next, item.queue_id, item.ward_id).run();
    return;
  }
  if ((item.cursor === "backup" || item.cursor.startsWith("backup:")) && env.ORIGINALS_BACKUP) {
    const bucket = new WardBucket(env.ORIGINALS_BACKUP, item.ward_id);
    const page = await bucket.list("", {
      limit: BACKUP_PAGE_SIZE, cursor: item.cursor.startsWith("backup:") ? item.cursor.slice(7) : undefined,
    });
    for (const object of page.keys) await bucket.delete(object.key);
    await env.DB.prepare("UPDATE ops_deletion_queue SET cursor = ? WHERE ward_id = ? AND queue_id = ?")
      .bind(page.truncated && page.cursor ? `backup:${page.cursor}` : "database", item.ward_id, item.queue_id).run();
    return;
  }
  await eraseWardData(env, item.ward_id, at);
}

/** 一回の Cron で進める上限。一歩ずつだと、資料の多い準備や区を消し終えるまで何時間もかかるため、時間の許す限り続ける。 */
const DELETION_STEP_BUDGET_MS = 20_000;
const DELETION_STEP_LIMIT = 60;

export async function runDeletionCron(event: ScheduledController, env: Env): Promise<void> {
  if (event.cron !== CRON.EVERY_5_MIN) return;
  const started = Date.now();
  // 空のときは区ごとの読み取りをしない。全区から番号だけを得る既存の入口を使う。
  const first = await env.DB.prepare(`SELECT queue_id, ward_id, target_type, target_id, cursor
    FROM ops_deletion_queue WHERE ward_id IS NOT NULL AND state IN ('pending', 'running', 'error')
    ORDER BY CASE state WHEN 'error' THEN 1 ELSE 0 END, requested_at LIMIT 1`).first<QueueRow>();
  if (!first) return;
  const wards = [...new Set([first.ward_id, ...(await listRecordWardIds(env.DB)).map((ward) => ward.ward_id), CONTACT_WARD])];
  type Candidate = QueueRow & { state: string; requested_at: string; request_order: number };
  const pages = await env.DB.batch<Candidate>(wards.map((wardId) => env.DB.prepare(`SELECT queue_id, ward_id, target_type, target_id, cursor, state, requested_at, rowid AS request_order
    FROM ops_deletion_queue WHERE ward_id = ? AND state IN ('pending', 'running', 'error')`).bind(wardId)));
  const priority = (state: string) => state === "running" ? 0 : state === "pending" ? 1 : 2;
  const items = pages.flatMap((page) => page.results).sort((a, b) => priority(a.state) - priority(b.state) ||
    a.requested_at.localeCompare(b.requested_at) || a.request_order - b.request_order);
  let step = 0;
  for (const item of items) {
    while (step < DELETION_STEP_LIMIT && Date.now() - started < DELETION_STEP_BUDGET_MS) {
      step++;
      const result = await runDeletionStep(env, item);
      if (result === "error") return;
      if (result === "gone") break;
    }
    if (step >= DELETION_STEP_LIMIT || Date.now() - started >= DELETION_STEP_BUDGET_MS) return;
  }
}

/** 一つの項目を終えるまで、同じ途中位置を読み直して続ける。 */
async function runDeletionStep(env: Env, item: QueueRow): Promise<"progress" | "gone" | "error"> {
  try {
    // 消去済みならロックを取らない。区の消去で消した管理用の行を作り直さないため。
    const pending = await env.DB.prepare("SELECT 1 FROM ops_deletion_queue WHERE ward_id = ? AND queue_id = ?")
      .bind(item.ward_id, item.queue_id).first();
    if (!pending) return "gone";
    return await withRecordLock(env, item.ward_id, async () => {
      // 同じ区を別のCronが先に進めた場合は、その途中位置から読む。
      const current = await env.DB.prepare(`SELECT queue_id, ward_id, target_type, target_id, cursor
        FROM ops_deletion_queue WHERE ward_id = ? AND queue_id = ?`)
        .bind(item.ward_id, item.queue_id).first<QueueRow>();
      if (!current) return "gone";
      await env.DB.prepare("UPDATE ops_deletion_queue SET state = 'running', last_error = '' WHERE queue_id = ? AND ward_id = ?")
        .bind(item.queue_id, item.ward_id).run();
      await finishDeletion(env, current);
      return "progress";
    });
  } catch (error) {
    const message = "処理を完了できませんでした。提供側で確認してください。";
    await env.DB.prepare("UPDATE ops_deletion_queue SET state = 'error', last_error = ? WHERE queue_id = ? AND ward_id = ?")
      .bind(message, item.queue_id, item.ward_id).run();
    console.error("消去処理を続けられませんでした", item.ward_id, item.queue_id, error instanceof Error ? error.name : "unknown");
    return "error";
  }
}
