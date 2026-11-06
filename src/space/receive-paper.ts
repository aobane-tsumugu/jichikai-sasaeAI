import type { Env } from "../env";
import { getClient } from "../ai/deps";
import { ReadError, readOriginals } from "../ai/read";
import { receive } from "../intake/receive";
import { kickRead } from "../intake/pipeline";
import { claimRead, failJob, getJob, resetForRetry } from "../intake/store";
import { WardBucket } from "../core/storage";
import type { Waitable } from "../intake/types";

/** 実行委員に紙の種類を選ばせず、既存の読み取りと答えの受付につなぐ。 */
export async function receiveSpacePaper(env: Env, ctx: Waitable, wardId: string, projectId: string, file: File, sourceHash?: string) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const outcome = await receive(env, { wardId, projectId, via: "space", readKind: "general",
    parts: [{ kind: "photo", filename: file.name, mediaType: file.type, bytes, sourceHash }],
  });
  const jobId = outcome.jobId;
  if (jobId) ctx.waitUntil(readSpacePaper(env, ctx, wardId, jobId).catch(async (error: unknown) => {
    await failJob(env.DB, wardId, jobId, error instanceof ReadError ? error.failure : "error");
  }));
  return outcome;
}

/** 読み分けの前に原本を預かる。読めなくても、役員と提供側から読み直せる。 */
export async function readSpacePaper(env: Env, ctx: Waitable, wardId: string, jobId: string) {
  const job = await getJob(env.DB, wardId, jobId);
  if (!job || job.via !== "space" || job.withdrawn_at) return false;
  if (job.status === "failed") await resetForRetry(env.DB, wardId, jobId);
  // 既存の貸し出しを使い、読み分け中に同じ紙をもう一度読み始めない。
  const attempt = await claimRead(env.DB, wardId, jobId, 90_000);
  if (attempt === null) return false;
  const original = await env.DB.prepare(`SELECT original_id, r2_path, filename, media_type FROM originals
    WHERE ward_id = ? AND job_id = ? AND withdrawn_at IS NULL ORDER BY position LIMIT 1`)
    .bind(wardId, jobId).first<{ original_id: string; r2_path: string | null; filename: string; media_type: string }>();
  if (!original?.r2_path) { await failJob(env.DB, wardId, jobId, "error"); return false; }
  const object = await new WardBucket(env.ORIGINALS, wardId).get(original.r2_path);
  if (!object) { await failJob(env.DB, wardId, jobId, "error"); return false; }
  const classified = await readOriginals(getClient(env), {
    kind: "general",
    originals: [{ originalId: original.original_id, filename: original.filename, mediaType: original.media_type,
      bytes: new Uint8Array(await object.arrayBuffer()), position: 1, photoResizeFailed: object.customMetadata?.photoResizeFailed === "1" }],
  });
  const answer = "document_kind" in classified.body && classified.body.document_kind === "answer_sheet";
  const changed = await env.DB.prepare(`UPDATE jobs SET read_kind = ?, status = 'received', failure = '', attempt = 0
    WHERE ward_id = ? AND job_id = ? AND withdrawn_at IS NULL AND status = 'reading' AND attempt = ?`)
    .bind(answer ? "answer_sheet" : "general", wardId, jobId, attempt).run();
  if (!changed.meta.changes) return false;
  // 読み分けた道を残すので、そのあとの読み直しは既存の処理を使える。
  kickRead(env, ctx, wardId, jobId, { createClient: () => getClient(env), readImpl: async (client, options) => {
    if (!answer) return classified;
    const result = await readOriginals(client, options);
    return { ...result, usage: {
      input_tokens: result.usage.input_tokens + classified.usage.input_tokens,
      output_tokens: result.usage.output_tokens + classified.usage.output_tokens,
      cache_read_input_tokens: result.usage.cache_read_input_tokens + classified.usage.cache_read_input_tokens,
    } };
  } });
  return true;
}
