// 入った物（jobs）の状態と、原本、読み取り、列の記録（job_runs）の D1 への出し入れ。
// 全ての問い合わせに ward_id を入れる。状態の変更は where に今の状態を入れて、競り合っても二度進まないようにする。
import { WardBucket } from "../core/storage";
import { newId, nowIso } from "../core/ids";
import type { Env } from "../env";
import type { ReadingBody } from "../ai/schema";
import type { JobRow, JobStatus, OriginalRow } from "./types";

export const MAX_READ_ATTEMPTS = 3;

export async function getJob(db: D1Database, wardId: string, jobId: string): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE ward_id = ? AND job_id = ?").bind(wardId, jobId).first<JobRow>();
}

export async function listOriginals(db: D1Database, wardId: string, jobId: string): Promise<OriginalRow[]> {
  const res = await db
    .prepare("SELECT * FROM originals WHERE ward_id = ? AND job_id = ? ORDER BY position")
    .bind(wardId, jobId)
    .all<OriginalRow>();
  return res.results;
}

export async function getOriginal(db: D1Database, wardId: string, originalId: string): Promise<OriginalRow | null> {
  return db
    .prepare("SELECT * FROM originals WHERE ward_id = ? AND original_id = ?")
    .bind(wardId, originalId)
    .first<OriginalRow>();
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
        JSON.stringify(args.body),
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

/** 取り下げられるのは、繋げる前（セッションを開く前）まで。実体と読み取りを消し、行は残す。 */
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
              failure = '', finished_at = NULL, lease_until = NULL, ticket_hash = NULL, updated_at = ?
        WHERE ward_id = ? AND job_id = ? AND status = 'failed'`,
    )
    .bind(next, next, nowIso(), wardId, jobId)
    .run();
  return (res.meta.changes ?? 0) > 0 ? next : null;
}

/** プロジェクトを付ける・付け替える（公式 LINE の受け箱など）。終わった物と取り下げた物は動かさない。 */
export async function setJobProject(
  db: D1Database,
  wardId: string,
  jobId: string,
  projectId: string | null,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE jobs SET project_id = ?, updated_at = ?
        WHERE ward_id = ? AND job_id = ? AND status IN ('received', 'reading', 'read', 'failed')`,
    )
    .bind(projectId, nowIso(), wardId, jobId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** waitUntil の時間切れなどで終わりの記録が付かなかった読みの実行を、中断として閉じる（次の読みを始める時に呼ぶ）。 */
export async function closeAbandonedRuns(db: D1Database, wardId: string, jobId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE job_runs SET status = 'error', error = '中断（応答の後の時間切れなど）', ended_at = ?
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
  return res.results.map((r) => ({ ...r, body: JSON.parse(r.body) as ReadingBody }));
}

export interface JobListItem extends JobRow {
  original_count: number;
  first_filename: string;
  first_kind: string;
}

/** 入った物の一覧（新しい順）。 */
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
      WHERE j.ward_id = ? ${where}
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
