// 入った物の読みの流れ。画面の応答の後に waitUntil で裏で動かす。
//
// waitUntil は応答を返した後、最長 30 秒しか続かない（Cloudflare の文書）。読みがそれを超えると黙って止められるので、
// 読み始める時に貸し出し（lease_until）を付け、切れた物と放ってある物を Cron（五分ごと）が読み直す。
// Cron は一回 15 分まで動ける。試行は MAX_READ_ATTEMPTS 回まで。
import type Anthropic from "@anthropic-ai/sdk";
import { WardBucket } from "../core/storage";
import type { Env } from "../env";
import { createAnthropic, MODEL } from "../ai/anthropic";
import { ReadError, readOriginals, type ReadableOriginal } from "../ai/read";
import {
  claimRead,
  endRun,
  failExhaustedReads,
  failJob,
  finishRead,
  getJob,
  listOriginals,
  listStuckReads,
  MAX_READ_ATTEMPTS,
  releaseRead,
  startRun,
} from "./store";
import type { Waitable } from "./types";

export interface PipelineDeps {
  /** 試験で差し替える。既定は署名鍵から作る本物のクライアント */
  createClient?: (env: Env) => Anthropic;
  readImpl?: typeof readOriginals;
}

export type ReadOutcome = "read" | "failed" | "retry" | "skipped";

let defaultDeps: PipelineDeps | undefined;

/** 試験で本物の Anthropic を呼ばないための差し替え口。null で戻す。 */
export function setPipelineDeps(deps: PipelineDeps | null): void {
  defaultDeps = deps ?? undefined;
}

/** 画面の応答の後に動かす時の貸し出し。waitUntil が止められても、これを過ぎれば Cron が拾う。 */
const LEASE_AFTER_RESPONSE_MS = 90_000;
/** Cron の中で読む時の貸し出し。 */
const LEASE_IN_CRON_MS = 10 * 60_000;

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 200) : "不明な失敗";
}

/** 一つの入った物を読む。取れた時だけ動き、結果を D1 に置く。 */
export async function runRead(
  env: Env,
  wardId: string,
  jobId: string,
  options: { leaseMs?: number; deps?: PipelineDeps } = {},
): Promise<ReadOutcome> {
  const deps = options.deps ?? defaultDeps;
  const attempt = await claimRead(env.DB, wardId, jobId, options.leaseMs ?? LEASE_AFTER_RESPONSE_MS);
  if (attempt === null) return "skipped";

  const job = await getJob(env.DB, wardId, jobId);
  if (!job) return "skipped";
  const run = await startRun(env.DB, { wardId, jobId, kind: "read", attempt, model: MODEL.main });

  try {
    const originals = (await listOriginals(env.DB, wardId, jobId)).filter(
      (o) => o.r2_path && (o.media_type.startsWith("image/") || o.media_type === "application/pdf"),
    );
    if (originals.length === 0) {
      await endRun(env.DB, run, wardId, { ok: false, error: "読む原本がありません" });
      await failJob(env.DB, wardId, jobId, "unsupported");
      return "failed";
    }
    const bucket = new WardBucket(env.ORIGINALS, wardId);
    const readable: ReadableOriginal[] = [];
    for (const o of originals) {
      const object = await bucket.get(o.r2_path as string);
      if (!object) {
        // 取り下げと行き違った。取り下げの方が先なので、何も置かない
        await endRun(env.DB, run, wardId, { ok: false, error: "原本の実体がありません" });
        await failJob(env.DB, wardId, jobId, "error");
        return "failed";
      }
      readable.push({
        originalId: o.original_id,
        filename: o.filename,
        mediaType: o.media_type,
        position: o.position,
        bytes: new Uint8Array(await object.arrayBuffer()),
      });
    }

    const client = (deps?.createClient ?? ((e: Env) => createAnthropic(e, { maxRetries: 1 })))(env);
    const result = await (deps?.readImpl ?? readOriginals)(client, { kind: job.read_kind, originals: readable });
    const placed = await finishRead(env.DB, {
      wardId,
      jobId,
      attempt,
      source: "model",
      packVersion: result.packVersion,
      model: result.model,
      body: result.body,
    });
    await endRun(env.DB, run, wardId, { ok: true, usage: result.usage, error: placed ? "" : "置く前に取り下げられました" });
    return placed ? "read" : "skipped";
  } catch (err) {
    const read = err instanceof ReadError ? err : null;
    await endRun(env.DB, run, wardId, { ok: false, error: describe(err) });
    console.error("入った物の読みに失敗しました", wardId, jobId, describe(err));
    if (read && (!read.retryable || attempt >= MAX_READ_ATTEMPTS)) {
      await failJob(env.DB, wardId, jobId, read.failure);
      return "failed";
    }
    if (attempt >= MAX_READ_ATTEMPTS) {
      await failJob(env.DB, wardId, jobId, "error");
      return "failed";
    }
    await releaseRead(env.DB, wardId, jobId, attempt);
    return "retry";
  }
}

/** 画面の応答の後に読みを始める。応答は待たない。 */
export function kickRead(env: Env, ctx: Waitable, wardId: string, jobId: string, deps?: PipelineDeps): void {
  ctx.waitUntil(
    runRead(env, wardId, jobId, { deps }).catch((err) => {
      console.error("読みの起動に失敗しました", wardId, jobId, describe(err));
    }),
  );
}

/** Cron（五分ごと）。止まっている読みを拾い直す。 */
export async function sweepReads(env: Env, deps?: PipelineDeps): Promise<{ picked: number; exhausted: number }> {
  const exhausted = await failExhaustedReads(env.DB);
  const stuck = await listStuckReads(env.DB);
  for (let i = 0; i < stuck.length; i += 3) {
    await Promise.all(
      stuck.slice(i, i + 3).map((s) =>
        runRead(env, s.ward_id, s.job_id, { leaseMs: LEASE_IN_CRON_MS, deps }).catch((err) => {
          console.error("読みの拾い直しに失敗しました", s.ward_id, s.job_id, describe(err));
        }),
      ),
    );
  }
  return { picked: stuck.length, exhausted };
}
