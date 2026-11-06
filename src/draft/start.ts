import { newId, nowIso } from "../core/ids";
import { dispatchProject } from "../ai/session";
import type { StartTaskInput } from "../ai/api";
import type { Env } from "../env";
import type { Waitable } from "../intake/types";

/** 共通のstartTaskは指示を4000文字で切るため、資料の読み取りを付ける仕事は切らずに同じ道へ入れる。 */
export async function startMaterialDraft(env: Env, ctx: Waitable, input: StartTaskInput): Promise<string> {
  const jobId = newId(); const now = nowIso();
  await env.DB.prepare(`INSERT INTO jobs (job_id, ward_id, project_id, via, task, instruction, account_id, status, created_at, updated_at, read_at)
    VALUES (?, ?, ?, 'system', 'draft', ?, ?, 'read', ?, ?, ?)`)
    .bind(jobId, input.wardId, input.projectId, input.instruction, input.accountId ?? null, now, now, now).run();
  ctx.waitUntil(dispatchProject(env, input.wardId, input.projectId).catch((error: unknown) =>
    console.error("下書きの起動に失敗しました", error instanceof Error ? error.name : "")));
  return jobId;
}
