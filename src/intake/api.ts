// 他の束が呼ぶ口。束 5（班長の写真、代理入力）と束 6（公式 LINE の受け箱）は receiveOriginal を使う。
// 区の ID は呼び出し側が自分の経路（URL、チャネル）から決めた物を渡す。本文に来た ward_id は信じない。
import type { Env } from "../env";
import { kickRead, type PipelineDeps } from "./pipeline";
import { receive, type ReceiveInput, type ReceiveOutcome } from "./receive";
import { dispatchProject } from "../ai/session";
import { getJob, resetForRetry, setJobProject, withdrawJob as withdraw } from "./store";
import type { Waitable } from "./types";

export { ReceiveError } from "./receive";
export type { ReceiveInput, ReceiveOutcome, ReceivePart } from "./receive";
export { getReadings } from "./store";
export type { ReadingRow } from "./store";

/**
 * 原本を受ける。同じ物は置かずに「同じ物でした」として返し、新しい物は一つの入った物にまとめる。
 * 画像と PDF があれば、応答の後に裏で読みを始める（waitUntil）。受けた時点で返り、読みは待たない。
 */
export async function receiveOriginal(
  env: Env,
  ctx: Waitable,
  input: ReceiveInput,
  deps?: PipelineDeps,
): Promise<ReceiveOutcome> {
  const outcome = await receive(env, input);
  if (outcome.jobId && outcome.needsModelRead) kickRead(env, ctx, input.wardId, outcome.jobId, deps);
  // 読みが要らない（文字と Word と Excel だけ）物は、すぐ繋げる順番に入る
  if (outcome.jobId && !outcome.needsModelRead && input.projectId) {
    ctx.waitUntil(dispatchProject(env, input.wardId, input.projectId).catch(logDispatchError));
  }
  return outcome;
}

/** 取り下げる。繋げる前（セッションを開く前）まで。取り下げられたら true。 */
export function withdrawJob(env: Pick<Env, "DB" | "ORIGINALS">, wardId: string, jobId: string): Promise<boolean> {
  return withdraw(env, wardId, jobId);
}

/** 読めなかった物をもう一度読む。 */
export async function retryJob(
  env: Env,
  ctx: Waitable,
  wardId: string,
  jobId: string,
  deps?: PipelineDeps,
): Promise<boolean> {
  const next = await resetForRetry(env.DB, wardId, jobId);
  if (next === "received") kickRead(env, ctx, wardId, jobId, deps);
  if (next === "read") {
    const job = await getJob(env.DB, wardId, jobId);
    if (job?.project_id) ctx.waitUntil(dispatchProject(env, wardId, job.project_id).catch(logDispatchError));
  }
  return next !== null;
}

function logDispatchError(err: unknown): void {
  console.error("繋げるの起動に失敗しました", err instanceof Error ? `${err.name}: ${err.message}` : "不明な失敗");
}

/** 受け箱の物にプロジェクトを付ける・付け替える。読み終わっていれば、繋げる順番に入る。 */
export async function assignProject(
  env: Env,
  ctx: Waitable,
  wardId: string,
  jobId: string,
  projectId: string | null,
): Promise<boolean> {
  const changed = await setJobProject(env.DB, wardId, jobId, projectId);
  if (changed && projectId) ctx.waitUntil(dispatchProject(env, wardId, projectId).catch(logDispatchError));
  return changed;
}
