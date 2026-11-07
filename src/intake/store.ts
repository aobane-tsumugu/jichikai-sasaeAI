// 入った物（jobs）の状態と、原本、読み取り、列の記録（job_runs）の D1 への出し入れ。
// 全ての問い合わせに ward_id を入れる。状態の変更は where に今の状態を入れて、競り合っても二度進まないようにする。
import { WardBucket } from "../core/storage";
import { newId, nowIso } from "../core/ids";
import type { Env } from "../env";
import { normalizeOriginalYears, type ReadingBody } from "../ai/schema";
import type { JobRow, JobStatus, OriginalRow } from "./types";
import { subset } from "./reading-subset";

export const MAX_READ_ATTEMPTS = 3;

export async function getJob(db: D1Database, wardId: string, jobId: string): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE ward_id = ? AND job_id = ?").bind(wardId, jobId).first<JobRow>();
}

export async function listOriginals(db: D1Database, wardId: string, jobId: string): Promise<OriginalRow[]> {
  const res = await db
    .prepare(`SELECT * FROM originals WHERE ward_id = ?
      AND (job_id = ? OR job_id = (SELECT paper_source_job_id FROM jobs WHERE ward_id = ? AND job_id = ?))
      ORDER BY position`)
    .bind(wardId, jobId, wardId, jobId)
    .all<OriginalRow>();
  return res.results;
}

/** 資料ごとの一行の要約。一覧に、ファイル名の代わりに出す。 */
export async function jobSummaries(db: D1Database, wardId: string): Promise<Map<string, string>> {
  const rows = await db.prepare("SELECT job_id, CASE WHEN json_valid(body) THEN json_extract(body, '$.summary') END AS summary FROM readings WHERE ward_id = ?")
    .bind(wardId).all<{ job_id: string; summary: string | null }>();
  const summaries = new Map<string, string>();
  for (const row of rows.results) if (row.summary?.trim() && !summaries.has(row.job_id)) summaries.set(row.job_id, row.summary.trim());
  return summaries;
}

export async function getOriginal(db: D1Database, wardId: string, originalId: string): Promise<OriginalRow | null> {
  return db
    .prepare("SELECT * FROM originals WHERE ward_id = ? AND original_id = ?")
    .bind(wardId, originalId)
    .first<OriginalRow>();
}

/** 出どころの原本が、この区のこのプロジェクトに実在するか（取り下げた物は数えない）。 */
export async function originalInProject(
  db: D1Database,
  wardId: string,
  projectId: string,
  originalId: string,
): Promise<boolean> {
  if (!originalId) return false;
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM jobs j JOIN originals o ON o.ward_id = j.ward_id
        AND (o.job_id = j.job_id OR o.job_id = j.paper_source_job_id)
        WHERE j.ward_id = ? AND j.project_id = ? AND o.original_id = ? AND o.withdrawn_at IS NULL`,
    )
    .bind(wardId, projectId, originalId)
    .first();
  return !!row;
}

/** 読みの順番を取る。received か、貸し出しの切れた reading だけが取れる。取れたら試行の回数を返す。 */
export async function claimRead(
  db: D1Database,
  wardId: string,
  jobId: string,
  leaseMs: number,
  nowMs: number = Date.now(),
): Promise<number | null> {
  const now = new Date(nowMs).toISOString();
  const lease = new Date(nowMs + leaseMs).toISOString();
  const res = await db
    .prepare(
      `UPDATE jobs SET status = 'reading', attempt = attempt + 1, lease_until = ?, updated_at = ?
        WHERE ward_id = ? AND job_id = ? AND attempt < ?
          AND (status = 'received' OR (status = 'reading' AND lease_until < ?))`,
    )
    .bind(lease, now, wardId, jobId, MAX_READ_ATTEMPTS, now)
    .run();
  if ((res.meta.changes ?? 0) === 0) return null;
  const job = await getJob(db, wardId, jobId);
  return job?.attempt ?? null;
}

/** 読めた。reading のままで、この試行の物だけ置く（取り下げられていたら何もしない）。置けたら true。 */
export async function finishRead(
  db: D1Database,
  args: {
    wardId: string;
    jobId: string;
    attempt: number;
    source: "model" | "direct";
    packVersion: string;
    model: string;
    body: ReadingBody;
  },
): Promise<boolean> {
  const now = nowIso();
  let body = args.body;
  // 印字された「下書きです」の写真だけを外す。AIの関連性の判断では外さない。
  if ("fields" in body) {
    const general = body;
    const originals = await listOriginals(db, args.wardId, args.jobId);
    const excluded = new Set(originals.filter((original) => original.media_type.startsWith("image/") &&
      general.text_blocks.some((block) => block.original_id === original.original_id && block.text.includes("下書きです")))
      .map((original) => original.original_id));
    if (excluded.size) {
      const remaining = new Set(originals.filter((original) => !original.withdrawn_at && !excluded.has(original.original_id)).map((original) => original.original_id));
      const updates = [...excluded].map((id) => db.prepare(`UPDATE originals SET withdrawn_at = ?
        WHERE ward_id = ? AND job_id = ? AND original_id = ? AND withdrawn_at IS NULL
        AND EXISTS (SELECT 1 FROM jobs WHERE ward_id = ? AND job_id = ? AND status = 'reading' AND attempt = ?)`)
        .bind(now, args.wardId, args.jobId, id, args.wardId, args.jobId, args.attempt));
      if (!remaining.size) updates.push(db.prepare(`UPDATE jobs SET status = 'withdrawn', withdrawn_at = ?, lease_until = NULL,
        stop_reason = '下書きの紙なので、資料に入れていません。下書きの画面で直せます。'
        WHERE ward_id = ? AND job_id = ? AND status = 'reading' AND attempt = ?`)
        .bind(now, args.wardId, args.jobId, args.attempt));
      await db.batch(updates);
      if (!remaining.size) return false;
      body = subset(body, remaining);
      delete body.project_suggestions;
    }
  }
  const results = await db.batch([
    db
      .prepare(
        `INSERT OR REPLACE INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM jobs WHERE ward_id = ? AND job_id = ? AND status = 'reading' AND attempt = ?)`,
      )
      .bind(
        newId(),
        args.wardId,
        args.jobId,
        args.source,
        args.packVersion,
        args.model,
        JSON.stringify(body),
        now,
        args.wardId,
        args.jobId,
        args.attempt,
      ),
    db
      .prepare(
        `UPDATE jobs SET status = 'read', read_at = ?, lease_until = NULL, failure = '', updated_at = ?
          WHERE ward_id = ? AND job_id = ? AND status = 'reading' AND attempt = ?`,
      )
      .bind(now, now, args.wardId, args.jobId, args.attempt),
  ]);
  return (results[1]?.meta.changes ?? 0) > 0;
}

/** 読みの途中で失敗した時、後で読み直せるように received に戻す（Cron が拾う）。 */
export async function releaseRead(db: D1Database, wardId: string, jobId: string, attempt: number): Promise<void> {
  await db
    .prepare(
      `UPDATE jobs SET status = 'received', lease_until = NULL, updated_at = ?
        WHERE ward_id = ? AND job_id = ? AND status = 'reading' AND attempt = ?`,
    )
    .bind(nowIso(), wardId, jobId, attempt)
    .run();
}

/** 読めなかった。もう一度は役員が押す。 */
export async function failJob(
  db: D1Database,
  wardId: string,
  jobId: string,
  failure: JobRow["failure"],
): Promise<void> {
  await db
    .prepare(
      `UPDATE jobs SET status = 'failed', failure = ?, lease_until = NULL, finished_at = ?, updated_at = ?
        WHERE ward_id = ? AND job_id = ? AND status IN ('received', 'reading')`,
    )
    .bind(failure, nowIso(), nowIso(), wardId, jobId)
    .run();
}

/** 取り下げは現在の実体をすぐ消す。同じ更新のDB連動処理が、過去の写しの消去も引き受ける。 */
export async function withdrawJob(env: Pick<Env, "DB" | "ORIGINALS">, wardId: string, jobId: string): Promise<boolean> {
  const now = nowIso();
  const res = await env.DB.prepare(
    `UPDATE jobs SET status = 'withdrawn', withdrawn_at = ?, lease_until = NULL, updated_at = ?
      WHERE ward_id = ? AND job_id = ? AND status IN ('received', 'reading', 'read', 'failed')`,
  )
    .bind(now, now, wardId, jobId)
    .run();
  if ((res.meta.changes ?? 0) === 0) return false;
  const originals = await listOriginals(env.DB, wardId, jobId);
  const bucket = new WardBucket(env.ORIGINALS, wardId);
  await Promise.all(originals.filter((o) => o.r2_path).map((o) => bucket.delete(o.r2_path as string)));
  await env.DB.batch([
    // 本文を消す前に、読み取り全体と原本ごとの検索用の記録も消す。
    env.DB.prepare(`DELETE FROM archive_search_entries WHERE ward_id = ? AND record_type = 'reading' AND (
      source_id IN (SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ?) OR
      content IN (SELECT body FROM readings WHERE ward_id = ? AND job_id = ?))`)
      .bind(wardId, wardId, jobId, wardId, jobId),
    env.DB.prepare(
      "UPDATE originals SET withdrawn_at = ?, r2_path = NULL WHERE ward_id = ? AND job_id = ? AND withdrawn_at IS NULL",
    ).bind(now, wardId, jobId),
    env.DB.prepare("DELETE FROM readings WHERE ward_id = ? AND job_id = ?").bind(wardId, jobId),
  ]);
  return true;
}

/**
 * 失敗した物をもう一度。読めなかった物は received に戻して読み直し、繋げられなかった物（failure が connect）は
 * 読み取りをそのままに read に戻して繋げ直す。戻した後の状態を返す（戻せなければ null）。
 */
export async function resetForRetry(
  db: D1Database,
  wardId: string,
  jobId: string,
): Promise<"received" | "read" | null> {
  const job = await getJob(db, wardId, jobId);
  if (!job || job.status !== "failed") return null;
  const next = job.failure === "connect" ? "read" : "received";
  const res = await db
    .prepare(
      `UPDATE jobs SET status = ?, attempt = CASE WHEN ? = 'received' THEN 0 ELSE attempt END, connect_attempt = 0,
              failure = '', finished_at = NULL, lease_until = NULL, ticket_hash = NULL, session_id = NULL, session_deleted_at = NULL, updated_at = ?
        WHERE ward_id = ? AND job_id = ? AND status = 'failed'`,
    )
    .bind(next, next, nowIso(), wardId, jobId)
    .run();
  return (res.meta.changes ?? 0) > 0 ? next : null;
}

/** プロジェクトを付ける・付け替える。繋いでいる間と取り下げた物は動かさない。 */
export async function setJobProject(
  db: D1Database,
  wardId: string,
  jobId: string,
  projectId: string | null,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE jobs SET project_id = ?, updated_at = ?,
          status = CASE WHEN status IN ('done', 'attention') THEN 'read' ELSE status END,
          session_id = CASE WHEN status IN ('done', 'attention') THEN NULL ELSE session_id END,
          session_deleted_at = CASE WHEN status IN ('done', 'attention') THEN NULL ELSE session_deleted_at END,
          ticket_hash = CASE WHEN status IN ('done', 'attention') THEN NULL ELSE ticket_hash END,
          finished_at = CASE WHEN status IN ('done', 'attention') THEN NULL ELSE finished_at END,
          connect_attempt = 0
        WHERE ward_id = ? AND job_id = ? AND status IN ('received', 'reading', 'read', 'failed', 'done', 'attention')`,
    )
    .bind(projectId, nowIso(), wardId, jobId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** waitUntil の時間切れなどで終わりの記録が付かなかった読みの実行を、中断として閉じる（次の読みを始める時に呼ぶ）。 */
export async function closeAbandonedRuns(db: D1Database, wardId: string, jobId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE job_runs SET status = 'error', error = '中断（応答のあとの時間切れなど）', ended_at = ?
        WHERE ward_id = ? AND job_id = ? AND kind = 'read' AND status = 'running'`,
    )
    .bind(nowIso(), wardId, jobId)
    .run();
}

export interface RunStart {
  runId: string;
  startedAtMs: number;
}

export async function startRun(
  db: D1Database,
  args: { wardId: string; jobId: string; kind: "read" | "connect"; attempt: number; model: string; sessionId?: string },
): Promise<RunStart> {
  const runId = newId();
  const startedAtMs = Date.now();
  await db
    .prepare(
      `INSERT INTO job_runs (run_id, ward_id, job_id, kind, attempt, status, model, session_id, started_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
    )
    .bind(runId, args.wardId, args.jobId, args.kind, args.attempt, args.model, args.sessionId ?? "", new Date(startedAtMs).toISOString())
    .run();
  return { runId, startedAtMs };
}

export async function endRun(
  db: D1Database,
  run: RunStart,
  wardId: string,
  result: {
    ok: boolean;
    error?: string;
    usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE job_runs SET status = ?, error = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
              duration_ms = ?, ended_at = ?
        WHERE ward_id = ? AND run_id = ?`,
    )
    .bind(
      result.ok ? "ok" : "error",
      (result.error ?? "").slice(0, 300),
      result.usage?.input_tokens ?? 0,
      result.usage?.output_tokens ?? 0,
      result.usage?.cache_read_input_tokens ?? 0,
      Date.now() - run.startedAtMs,
      nowIso(),
      wardId,
      run.runId,
    )
    .run();
}

export interface ReadingRow {
  source: "model" | "direct";
  pack_version: string;
  model: string;
  body: ReadingBody;
}

/** 入った物の読み取り。MCP の「読み取りを引く」手と、画面が使う。 */
export async function getReadings(db: D1Database, wardId: string, jobId: string): Promise<ReadingRow[]> {
  const res = await db
    .prepare("SELECT source, pack_version, model, body FROM readings WHERE ward_id = ? AND job_id = ? ORDER BY source")
    .bind(wardId, jobId)
    .all<{ source: "model" | "direct"; pack_version: string; model: string; body: string }>();
  if (res.results.length === 0) return [];
  const originals = await listOriginals(db, wardId, jobId);
  return res.results.map((r) => {
    const ids = originals.filter((original) => {
      const model = original.media_type.startsWith("image/") || original.media_type === "application/pdf";
      return r.source === "model" ? model : !model;
    }).map((original) => original.original_id);
    return { ...r, body: normalizeOriginalYears(JSON.parse(r.body) as ReadingBody, ids) };
  });
}

export interface JobListItem extends JobRow {
  original_count: number;
  first_filename: string;
  first_kind: string;
}

/** 入った物の一覧（新しい順）。 */
/** 入った物の一覧。AI に頼んだ下書きなどの仕事（via が system）は入った物ではないので含めない。 */
export async function listJobs(
  db: D1Database,
  wardId: string,
  options: { projectId?: string | null; limit?: number } = {},
): Promise<JobListItem[]> {
  const where = options.projectId ? "AND j.project_id = ?" : "";
  const stmt = db.prepare(
    `SELECT j.*,
            (SELECT COUNT(*) FROM originals o WHERE o.ward_id = j.ward_id AND o.job_id = j.job_id) AS original_count,
            COALESCE((SELECT o.filename FROM originals o WHERE o.ward_id = j.ward_id AND o.job_id = j.job_id ORDER BY o.position LIMIT 1), '') AS first_filename,
            COALESCE((SELECT o.kind FROM originals o WHERE o.ward_id = j.ward_id AND o.job_id = j.job_id ORDER BY o.position LIMIT 1), '') AS first_kind
       FROM jobs j
      WHERE j.ward_id = ? AND j.paper_source_job_id IS NULL AND j.via <> 'system'
        AND NOT EXISTS (SELECT 1 FROM jobs routed WHERE routed.ward_id = j.ward_id AND routed.paper_source_job_id = j.job_id)
        ${where}
      ORDER BY j.created_at DESC
      LIMIT ?`,
  );
  const binds: (string | number)[] = [wardId];
  if (options.projectId) binds.push(options.projectId);
  binds.push(options.limit ?? 30);
  const res = await stmt.bind(...binds).all<JobListItem>();
  return res.results;
}

/** Cron が拾う入った物。received のまま放ってある物と、貸し出しの切れた reading。 */
export async function listStuckReads(
  db: D1Database,
  nowMs: number = Date.now(),
  limit = 20,
): Promise<Array<{ ward_id: string; job_id: string }>> {
  const now = new Date(nowMs).toISOString();
  const idleCutoff = new Date(nowMs - 60_000).toISOString();
  const res = await db
    .prepare(
      `SELECT ward_id, job_id FROM jobs
        WHERE attempt < ? AND ((status = 'received' AND updated_at < ?) OR (status = 'reading' AND lease_until < ?))
        ORDER BY created_at LIMIT ?`,
    )
    .bind(MAX_READ_ATTEMPTS, idleCutoff, now, limit)
    .all<{ ward_id: string; job_id: string }>();
  return res.results;
}

/** 試行の上限に達したまま止まっている読みを failed にする（Cron）。 */
export async function failExhaustedReads(db: D1Database, nowMs: number = Date.now()): Promise<number> {
  const now = new Date(nowMs).toISOString();
  const res = await db
    .prepare(
      `UPDATE jobs SET status = 'failed', failure = 'error', lease_until = NULL, finished_at = ?, updated_at = ?
        WHERE attempt >= ? AND (status = 'received' OR (status = 'reading' AND lease_until < ?))`,
    )
    .bind(now, now, MAX_READ_ATTEMPTS, now)
    .run();
  return res.meta.changes ?? 0;
}

export function isOpenStatus(status: JobStatus): boolean {
  return status === "received" || status === "reading" || status === "read" || status === "connecting";
}
