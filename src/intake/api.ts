// 他の束が呼ぶ口。束 5（班長の写真、代理入力）と束 6（公式 LINE の受け箱）は receiveOriginal を使う。
// 区の ID は呼び出し側が自分の経路（URL、チャネル）から決めた物を渡す。本文に来た ward_id は信じない。
import type { Env } from "../env";
import { kickRead, type PipelineDeps } from "./pipeline";
import { receive, type ReceiveInput, type ReceiveOutcome } from "./receive";
import { resetForRetry, setJobProject, withdrawJob as withdraw } from "./store";
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
  const reset = await resetForRetry(env.DB, wardId, jobId);
  if (reset) kickRead(env, ctx, wardId, jobId, deps);
  return reset;
}

/** 受け箱の物にプロジェクトを付ける・付け替える。 */
export function assignProject(db: D1Database, wardId: string, jobId: string, projectId: string | null): Promise<boolean> {
  return setJobProject(db, wardId, jobId, projectId);
}
