// 繋げるの完了。webhook（session.status_idled など）か、来なかった時の Cron で、セッションの events を引き直して決める。
// 最新の session.status_idle の stop_reason（end_turn、requires_action、budget_reached）で、完了か要対応か失敗かを分ける。
// 完了でも失敗でも、結果を列の記録（job_runs）に写してからセッションを消し、同じプロジェクトの次を送る。
import { nowIso } from "../core/ids";
import type { Env } from "../env";
import type { JobRow } from "../intake/types";
import { getJob } from "../intake/store";
import { getClient } from "./deps";
import { dispatchProject } from "./session";

/** 繋げるの待ち時間の上限（分）。上限に当たった入力は失敗にして次を送り、列を詰まらせない。数は実測後に直す仮の値。 */
export const CONNECT_TIMEOUT_MS = 20 * 60_000;

export type CheckOutcome = "done" | "attention" | "failed" | "running" | "skipped";

interface SessionLike {
  status: string;
  usage?: { input_tokens?: number; output_tokens?: number; list_cost?: { amount?: string } | null } | null;
}

interface EventLike {
  type: string;
  stop_reason?: { type?: string } | null;
}

/** events の中の、最新の status_idle の stop_reason と、エラーの有無。 */
export function summarizeEvents(events: EventLike[]): { stopReason: string | null; errors: number } {
  let stopReason: string | null = null;
  let errors = 0;
  for (const e of events) {
    if (e.type === "session.status_idle") stopReason = e.stop_reason?.type ?? "";
    if (e.type === "session.error") errors += 1;
  }
  return { stopReason, errors };
}

export function decide(
  sessionStatus: string,
  stopReason: string | null,
): { outcome: Exclude<CheckOutcome, "skipped">; failure: "" | "connect" } {
  if (sessionStatus === "running" || sessionStatus === "rescheduling") return { outcome: "running", failure: "" };
  if (stopReason === "end_turn") return { outcome: "done", failure: "" };
  if (stopReason === "requires_action" || stopReason === "budget_reached") return { outcome: "attention", failure: "" };
  // 終わっているのに end_turn が無い（途中で終了、エラー）
  if (sessionStatus === "terminated") return { outcome: "failed", failure: "connect" };
  // idle だが最新の idle の理由がまだ見えない（events の反映待ち）
  return { outcome: "running", failure: "" };
}

/** セッションの今を見て、終わっていれば結果を写して消す。webhook と Cron の両方から呼ばれる（二度呼ばれても一度だけ効く）。 */
export async function checkSession(env: Env, wardId: string, jobId: string): Promise<CheckOutcome> {
  const job = await getJob(env.DB, wardId, jobId);
  if (!job || job.status !== "connecting" || !job.session_id) return "skipped";
  const client = getClient(env);
  let session: SessionLike;
  let events: EventLike[] = [];
  try {
    session = (await client.beta.sessions.retrieve(job.session_id)) as unknown as SessionLike;
    for await (const e of client.beta.sessions.events.list(job.session_id)) events.push(e as unknown as EventLike);
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    if (status !== 404) throw err;
    // セッションが無い（消えた）。失敗にして次へ
    return settle(env, job, "failed", "connect", "session_missing", null);
  }
  const { stopReason } = summarizeEvents(events);
  const decided = decide(session.status, stopReason);
  if (decided.outcome === "running") {
    if (Date.now() - Date.parse(job.connect_started_at ?? job.updated_at) > CONNECT_TIMEOUT_MS) {
      return settle(env, job, "failed", "connect", "timeout", session);
    }
    return "running";
  }
  return settle(env, job, decided.outcome, decided.failure, stopReason ?? "", session);
}

async function settle(
  env: Env,
  job: JobRow,
  outcome: "done" | "attention" | "failed",
  failure: "" | "connect",
  stopReason: string,
  session: SessionLike | null,
): Promise<CheckOutcome> {
  const now = nowIso();
  // 先に状態を変えた方だけが後始末をする（札はここで失効する）
  const res = await env.DB.prepare(
    `UPDATE jobs SET status = ?, failure = ?, stop_reason = ?, ticket_hash = NULL, finished_at = ?, updated_at = ?
      WHERE ward_id = ? AND job_id = ? AND status = 'connecting' AND session_id = ?`,
  )
    .bind(outcome, failure, stopReason, now, now, job.ward_id, job.job_id, job.session_id)
    .run();
  if ((res.meta.changes ?? 0) === 0) return "skipped";

  const cents = Number.parseInt(session?.usage?.list_cost?.amount ?? "0", 10) || 0;
  await env.DB.prepare(
    `UPDATE job_runs SET status = ?, error = ?, stop_reason = ?, input_tokens = ?, output_tokens = ?, list_cost_cents = ?,
            duration_ms = ?, ended_at = ?
      WHERE ward_id = ? AND job_id = ? AND kind = 'connect' AND session_id = ?`,
  )
    .bind(
      outcome === "failed" ? "error" : "ok",
      outcome === "failed" ? stopReason || "terminated" : "",
      stopReason,
      session?.usage?.input_tokens ?? 0,
      session?.usage?.output_tokens ?? 0,
      cents,
      Date.now() - Date.parse(job.connect_started_at ?? now),
      now,
      job.ward_id,
      job.job_id,
      job.session_id,
    )
    .run();

  await deleteSession(env, job.ward_id, job.job_id, job.session_id as string);
  if (job.project_id) await dispatchProject(env, job.ward_id, job.project_id).catch((e) => console.error("次の入力の起動に失敗しました", e instanceof Error ? e.message : ""));
  return outcome;
}

/**
 * セッションを消す。仕事の場であって記録ではない（設計書 5.6）。
 * 動いている間は消せない（400「Cannot delete session while it is running」。実機で確かめた）ので、
 * 中断（user.interrupt）を送ってから消す。消せなければ Cron が拾う。
 */
export async function deleteSession(env: Env, wardId: string, jobId: string, sessionId: string): Promise<boolean> {
  const client = getClient(env);
  let deleted = false;
  for (let attempt = 0; attempt < 3 && !deleted; attempt++) {
    try {
      await client.beta.sessions.delete(sessionId);
      deleted = true;
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      if (status === 404) {
        deleted = true;
      } else if (status === 400 && /running/i.test(err instanceof Error ? err.message : "")) {
        await client.beta.sessions.events.send(sessionId, { events: [{ type: "user.interrupt" }] }).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } else {
        console.error("セッションを消せませんでした", wardId, jobId, status ?? "");
        return false;
      }
    }
  }
  if (!deleted) return false;
  await env.DB.prepare("UPDATE jobs SET session_deleted_at = ? WHERE ward_id = ? AND job_id = ?")
    .bind(nowIso(), wardId, jobId)
    .run();
  return true;
}

/** Cron（五分ごと）。webhook が来なかった物を引き直し、繋げる順番を待っている物を送り、消し損ねを消す。 */
export async function sweepConnections(env: Env): Promise<{ checked: number; dispatched: number; deleted: number }> {
  const now = Date.now();
  // 予約したがセッションを開く前に止まった物は、read に戻す
  await env.DB.prepare(
    `UPDATE jobs SET status = 'read', ticket_hash = NULL, updated_at = ?
      WHERE status = 'connecting' AND session_id IS NULL AND connect_started_at < ?`,
  )
    .bind(nowIso(), new Date(now - 5 * 60_000).toISOString())
    .run();

  const connecting = await env.DB.prepare(
    `SELECT ward_id, job_id FROM jobs WHERE status = 'connecting' AND session_id IS NOT NULL AND connect_started_at < ? LIMIT 20`,
  )
    .bind(new Date(now - 60_000).toISOString())
    .all<{ ward_id: string; job_id: string }>();
  for (const j of connecting.results) {
    await checkSession(env, j.ward_id, j.job_id).catch((e) => console.error("セッションの確認に失敗しました", e instanceof Error ? e.name : ""));
  }

  const waiting = await env.DB.prepare(
    `SELECT DISTINCT ward_id, project_id FROM jobs WHERE status = 'read' AND project_id IS NOT NULL LIMIT 20`,
  ).all<{ ward_id: string; project_id: string }>();
  let dispatched = 0;
  for (const w of waiting.results) {
    if ((await dispatchProject(env, w.ward_id, w.project_id).catch(() => "failed")) === "started") dispatched += 1;
  }

  const leftovers = await env.DB.prepare(
    `SELECT ward_id, job_id, session_id FROM jobs
      WHERE session_id IS NOT NULL AND session_deleted_at IS NULL AND status <> 'connecting' LIMIT 20`,
  ).all<{ ward_id: string; job_id: string; session_id: string }>();
  let deleted = 0;
  for (const l of leftovers.results) if (await deleteSession(env, l.ward_id, l.job_id, l.session_id)) deleted += 1;

  return { checked: connecting.results.length, dispatched, deleted };
}
