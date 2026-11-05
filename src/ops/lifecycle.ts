import { CRON } from "../core/cron";
import { newId, nowIso } from "../core/ids";
import { WardBucket } from "../core/storage";
import type { Env } from "../env";
import { createAnthropic } from "../ai/anthropic";
import { deleteSession } from "../ai/complete";

const EXPORT_TABLES = [
  "wards", "seats", "accounts", "devices", "ward_settings", "ops_ward_limits", "ward_ai",
  "jobs", "originals", "readings", "job_runs", "job_tool_calls", "paper_reading_slices",
  "projects", "project_deadlines", "project_changes", "project_item_values", "project_rows", "documents",
  "document_versions", "project_questions", "project_map_tasks", "publication_records", "project_activity_pages",
  "ward_roster_entries", "ward_roster_settings", "project_answers", "project_spaces", "project_space_invites",
  "project_space_members", "line_channels", "line_webhook_receipts", "line_inbox_items", "line_unrelated_daily_counts",
  "project_close_map", "project_close_reports", "archive_search_entries",
] as const;

const WARD_DELETE_TABLES = [
  "archive_search_entries", "project_activity_pages", "project_close_reports", "project_close_map",
  "project_answers", "project_space_members", "project_space_invites", "project_spaces",
  "ward_roster_entries", "ward_roster_settings", "line_inbox_items",
  "line_webhook_receipts", "line_channels", "line_unrelated_daily_counts", "publication_records",
  "document_versions", "documents", "project_questions", "project_rows", "project_item_values",
  "project_changes", "project_map_tasks", "project_deadlines", "projects", "paper_reading_slices",
  "job_tool_calls", "job_runs", "readings", "originals", "jobs", "ward_ai",
  "ops_ward_limits", "devices", "ward_settings",
] as const;

interface QueueRow {
  queue_id: string;
  ward_id: string;
  target_type: "job" | "ward" | "answer";
  target_id: string | null;
  cursor: string | null;
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
      VALUES (?, ?, 'job', ?, ?)`)
      .bind(queueId, wardId, jobId, requestedAt),
  ]);
  return queueId;
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
  const bucket = new WardBucket(env.ORIGINALS, wardId);
  const page = await bucket.list("snapshots/daily/", { limit: 100, cursor });
  for (const entry of page.keys) {
    const object = await bucket.get(entry.key);
    if (!object) continue;
    let value: unknown;
    try { value = await object.json(); } catch { await bucket.delete(entry.key); continue; }
    if (typeof value !== "object" || value === null || Array.isArray(value)) { await bucket.delete(entry.key); continue; }
    const doc = value as { wardId?: unknown; tables?: Record<string, unknown> };
    if (doc.wardId !== wardId || typeof doc.tables !== "object" || doc.tables === null) { await bucket.delete(entry.key); continue; }
    const rows = doc.tables.project_answers;
    if (Array.isArray(rows)) doc.tables.project_answers = rows.filter((row) =>
      typeof row !== "object" || row === null || (row as Record<string, unknown>).answer_id !== answerId);
    await bucket.put(entry.key, JSON.stringify(doc), { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  }
  if (page.truncated && page.cursor) {
    await env.DB.prepare("UPDATE ops_deletion_queue SET cursor = ?, state = 'running', last_error = '' WHERE queue_id = ? AND ward_id = ?")
      .bind(`snapshots:${page.cursor}`, item.queue_id, wardId).run();
    return;
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ops_deletion_queue WHERE queue_id = ? AND ward_id = ?").bind(item.queue_id, wardId),
    env.DB.prepare("INSERT INTO ops_deletion_marks (mark_id, ward_id, scope, deleted_at) VALUES (?, ?, 'record', ?)").bind(newId(), wardId, nowIso()),
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
  if (!ward) throw new Error("区が見つかりません");
  const tables: Record<string, unknown[]> = {};
  for (const table of EXPORT_TABLES) {
    const rows = await env.DB.prepare(`SELECT * FROM ${table} WHERE ward_id = ?`).bind(wardId).all<Record<string, unknown>>();
    tables[table] = rows.results;
  }
  const objects: Array<{ key: string; mediaType: string; base64: string }> = [];
  const bucket = new WardBucket(env.ORIGINALS, wardId);
  let cursor: string | undefined;
  do {
    const page = await bucket.list("", { limit: 1000, cursor });
    for (const listed of page.keys) {
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
        if (data.format !== 1 || data.wardId !== wardId || typeof data.capturedAt !== "string" || typeof data.tables !== "object" || data.tables === null || Array.isArray(data.tables)) throw new Error("区または項目を確認できません");
        const tables = data.tables as Record<string, unknown>;
        const rows = Object.values(tables);
        if (rows.some((tableRows) => !Array.isArray(tableRows))) throw new Error("表の内容が配列ではありません");
        if (rows.some((tableRows) => (tableRows as unknown[]).some((row) =>
          typeof row !== "object" || row === null || (row as { ward_id?: unknown }).ward_id !== wardId))) {
          throw new Error("別の区の行、または区を確認できない行があります");
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

function eraseSnapshotJob(snapshot: unknown, wardId: string, jobId: string, originalIds: Set<string>, readingBodies: Set<string>): string | null {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return null;
  const doc = snapshot as { format?: unknown; wardId?: unknown; tables?: unknown };
  if (doc.format !== 1 || doc.wardId !== wardId || typeof doc.tables !== "object" || doc.tables === null || Array.isArray(doc.tables)) return null;
  const tables = doc.tables as Record<string, unknown>;
  const remove = (table: string, match: (row: Record<string, unknown>) => boolean) => {
    const rows = tables[table];
    if (Array.isArray(rows)) tables[table] = rows.filter((row) =>
      typeof row !== "object" || row === null || Array.isArray(row) || !match(row as Record<string, unknown>));
  };
  const changeIds = new Set<string>();
  if (Array.isArray(tables.project_changes)) {
    for (const value of tables.project_changes) {
      if (typeof value !== "object" || value === null) continue;
      const row = value as Record<string, unknown>;
      if (typeof row.source_ref === "string" && originalIds.has(row.source_ref) && typeof row.change_id === "string") changeIds.add(row.change_id);
    }
  }
  remove("project_questions", (row) =>
    (typeof row.source_ref === "string" && originalIds.has(row.source_ref)) ||
    (typeof row.change_id === "string" && changeIds.has(row.change_id)));
  if (Array.isArray(tables.project_map_tasks)) {
    for (const value of tables.project_map_tasks) {
      if (typeof value !== "object" || value === null) continue;
      const row = value as Record<string, unknown>;
      if ((typeof row.progress_source_ref === "string" && originalIds.has(row.progress_source_ref)) ||
          (typeof row.progress_change_id === "string" && changeIds.has(row.progress_change_id))) {
        Object.assign(row, { progress: "open", progress_source_kind: null, progress_source_ref: null,
          progress_source_locator: null, progress_confidence: null, progress_change_id: null });
      }
    }
  }
  remove("jobs", (row) => row.job_id === jobId);
  remove("originals", (row) => row.job_id === jobId || (typeof row.original_id === "string" && originalIds.has(row.original_id)));
  for (const table of ["readings", "job_runs", "job_tool_calls"]) remove(table, (row) => row.job_id === jobId);
  remove("paper_reading_slices", (row) => row.job_id === jobId || row.source_job_id === jobId);
  for (const table of ["project_item_values", "project_rows", "project_changes"]) {
    remove(table, (row) => typeof row.source_ref === "string" && originalIds.has(row.source_ref));
  }
  remove("project_answers", (row) => typeof row.original_id === "string" && originalIds.has(row.original_id));
  remove("line_inbox_items", (row) => row.job_id === jobId);
  remove("archive_search_entries", (row) =>
    (typeof row.source_id === "string" && originalIds.has(row.source_id)) ||
    (typeof row.content === "string" && readingBodies.has(row.content)));
  return JSON.stringify(doc);
}

async function rewriteJobSnapshots(env: Env, wardId: string, jobId: string, cursor: string | undefined): Promise<string | null> {
  const bucket = new WardBucket(env.ORIGINALS, wardId);
  const [originals, readings] = await Promise.all([
    env.DB.prepare("SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ?").bind(wardId, jobId).all<{ original_id: string }>(),
    env.DB.prepare("SELECT body FROM readings WHERE ward_id = ? AND job_id = ?").bind(wardId, jobId).all<{ body: string }>(),
  ]);
  const originalIds = new Set(originals.results.map((row) => row.original_id));
  const readingBodies = new Set(readings.results.map((row) => row.body));
  const page = await bucket.list("snapshots/daily/", { limit: 100, cursor });
  for (const entry of page.keys) {
    const object = await bucket.get(entry.key);
    if (!object) continue;
    let value: unknown;
    try { value = await object.json(); } catch { await bucket.delete(entry.key); continue; }
    const rewritten = eraseSnapshotJob(value, wardId, jobId, originalIds, readingBodies);
    if (rewritten === null) { await bucket.delete(entry.key); continue; }
    await bucket.put(entry.key, rewritten, { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  }
  return page.truncated ? page.cursor ?? null : null;
}

async function eraseJob(env: Env, item: QueueRow): Promise<"continue" | "done"> {
  const wardId = item.ward_id;
  const jobId = item.target_id ?? "";
  const job = await env.DB.prepare("SELECT session_id FROM jobs WHERE ward_id = ? AND job_id = ?")
    .bind(wardId, jobId).first<{ session_id: string | null }>();
  if (item.cursor === null) {
    if (job?.session_id && !(await deleteSession(env, wardId, jobId, job.session_id))) throw new Error("AI 側の処理を消せませんでした");
    await env.DB.prepare("UPDATE ops_deletion_queue SET cursor = 'snapshots', state = 'running', last_error = '' WHERE queue_id = ? AND ward_id = ?")
      .bind(item.queue_id, wardId).run();
    return "continue";
  }
  if (item.cursor === "snapshots" || item.cursor.startsWith("snapshots:")) {
    const token = item.cursor.startsWith("snapshots:") ? item.cursor.slice("snapshots:".length) : undefined;
    const next = await rewriteJobSnapshots(env, wardId, jobId, token);
    await env.DB.prepare("UPDATE ops_deletion_queue SET cursor = ?, state = 'running', last_error = '' WHERE queue_id = ? AND ward_id = ?")
      .bind(next ? `snapshots:${next}` : "record", item.queue_id, wardId).run();
    return "continue";
  }

  const originals = await env.DB.prepare("SELECT r2_path FROM originals WHERE ward_id = ? AND job_id = ? AND r2_path IS NOT NULL")
    .bind(wardId, jobId).all<{ r2_path: string }>();
  const inbox = await env.DB.prepare("SELECT original_object_key FROM line_inbox_items WHERE ward_id = ? AND job_id = ? AND original_object_key IS NOT NULL")
    .bind(wardId, jobId).all<{ original_object_key: string }>();
  const bucket = new WardBucket(env.ORIGINALS, wardId);
  for (const original of originals.results) await bucket.delete(original.r2_path);
  for (const entry of inbox.results) await bucket.delete(entry.original_object_key);
  const statements = [
    env.DB.prepare("DELETE FROM archive_search_entries WHERE ward_id = ? AND record_type = 'reading' AND (source_id IN (SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ?) OR content IN (SELECT body FROM readings WHERE ward_id = ? AND job_id = ?))").bind(wardId, wardId, jobId, wardId, jobId),
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
  const at = nowIso();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ops_deletion_queue WHERE queue_id = ? AND ward_id = ?").bind(item.queue_id, wardId),
    env.DB.prepare("INSERT INTO ops_deletion_marks (mark_id, ward_id, scope, deleted_at) VALUES (?, ?, 'record', ?)").bind(newId(), wardId, at),
  ]);
  return "done";
}

async function eraseWardData(env: Env, wardId: string): Promise<void> {
  const statements = WARD_DELETE_TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table} WHERE ward_id = ?`).bind(wardId));
  statements.unshift(env.DB.prepare("UPDATE projects SET seed_project_id = NULL WHERE ward_id = ?").bind(wardId));
  statements.unshift(env.DB.prepare("UPDATE accounts SET created_by_account_id = NULL, removed_by_account_id = NULL WHERE ward_id = ?").bind(wardId));
  statements.push(env.DB.prepare("DELETE FROM login_attempts WHERE ward_id = ?").bind(wardId));
  statements.push(env.DB.prepare("DELETE FROM seats WHERE ward_id = ?").bind(wardId));
  statements.push(env.DB.prepare("DELETE FROM accounts WHERE ward_id = ?").bind(wardId));
  statements.push(env.DB.prepare("DELETE FROM wards WHERE ward_id = ?").bind(wardId));
  await env.DB.batch(statements);
}

async function finishDeletion(env: Env, item: QueueRow): Promise<void> {
  const at = nowIso();
  if (item.target_type === "job" && item.target_id) {
    await eraseJob(env, item);
    return;
  }
  if (item.target_type === "answer" && item.target_id) {
    await eraseAnswer(env, item);
    return;
  }
  if (item.cursor === null) {
    const ai = await env.DB.prepare("SELECT agent_id FROM ward_ai WHERE ward_id = ?")
      .bind(item.ward_id).first<{ agent_id: string | null }>();
    if (ai?.agent_id) {
      try { await createAnthropic(env).beta.agents.archive(ai.agent_id); }
      catch (error) { if ((error as { status?: number } | null)?.status !== 404) throw error; }
    }
    await env.DB.prepare("UPDATE ops_deletion_queue SET cursor = 'sessions', state = 'running', last_error = '' WHERE queue_id = ? AND ward_id = ?")
      .bind(item.queue_id, item.ward_id).run();
    return;
  }
  if (item.cursor === "sessions") {
    const session = await env.DB.prepare("SELECT job_id, session_id FROM jobs WHERE ward_id = ? AND session_id IS NOT NULL ORDER BY connect_started_at LIMIT 1")
      .bind(item.ward_id).first<{ job_id: string; session_id: string }>();
    if (session) {
      if (!(await deleteSession(env, item.ward_id, session.job_id, session.session_id))) throw new Error("AI 側の処理を消せませんでした");
      return;
    }
    const ai = await env.DB.prepare("SELECT vault_id FROM ward_ai WHERE ward_id = ?")
      .bind(item.ward_id).first<{ vault_id: string | null }>();
    if (ai?.vault_id) {
      try { await createAnthropic(env).beta.vaults.delete(ai.vault_id); }
      catch (error) { if ((error as { status?: number } | null)?.status !== 404) throw error; }
    }
    await env.DB.prepare("UPDATE ops_deletion_queue SET cursor = 'r2', state = 'running', last_error = '' WHERE queue_id = ? AND ward_id = ?")
      .bind(item.queue_id, item.ward_id).run();
    return;
  }
  if (item.cursor === "r2" || item.cursor.startsWith("r2:")) {
    const cursor = item.cursor.startsWith("r2:") ? item.cursor.slice(3) : undefined;
    const bucket = new WardBucket(env.ORIGINALS, item.ward_id);
    const page = await bucket.list("", { limit: 500, cursor });
    for (const object of page.keys) await bucket.delete(object.key);
    const next = page.truncated && page.cursor ? `r2:${page.cursor}` : "database";
    await env.DB.prepare("UPDATE ops_deletion_queue SET cursor = ?, state = 'running', last_error = '' WHERE queue_id = ? AND ward_id = ?")
      .bind(next, item.queue_id, item.ward_id).run();
    return;
  }
  await eraseWardData(env, item.ward_id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ops_deletion_queue WHERE queue_id = ? AND ward_id = ?")
      .bind(item.queue_id, item.ward_id),
    env.DB.prepare("INSERT INTO ops_deletion_marks (mark_id, ward_id, scope, deleted_at) VALUES (?, ?, 'ward', ?)")
      .bind(newId(), item.ward_id, at),
  ]);
}

export async function runDeletionCron(event: ScheduledController, env: Env): Promise<void> {
  if (event.cron !== CRON.EVERY_5_MIN) return;
  const item = await env.DB.prepare(`SELECT queue_id, ward_id, target_type, target_id, cursor
    FROM ops_deletion_queue WHERE ward_id IS NOT NULL AND state IN ('pending', 'running', 'error')
    ORDER BY CASE state WHEN 'error' THEN 1 ELSE 0 END, requested_at LIMIT 1`)
    .first<QueueRow>();
  if (!item) return;
  try {
    await env.DB.prepare("UPDATE ops_deletion_queue SET state = 'running', last_error = '' WHERE queue_id = ? AND ward_id = ?")
      .bind(item.queue_id, item.ward_id).run();
    await finishDeletion(env, item);
  } catch (error) {
    const message = "処理を完了できませんでした。提供側で確認してください。";
    await env.DB.prepare("UPDATE ops_deletion_queue SET state = 'error', last_error = ? WHERE queue_id = ? AND ward_id = ?")
      .bind(message, item.queue_id, item.ward_id).run();
    console.error("消去処理を続けられませんでした", item.ward_id, item.queue_id, error instanceof Error ? error.name : "unknown");
  }
}
