// 他の束が呼ぶ口。包みと入力を渡して、Managed Agents のセッションを開く。
// 束 3 の下書き、束 7 の報告と地図の下書きが使う。入った物の繋げるは、読み終わりから自動で動くので呼ばなくてよい。
import { newId, nowIso } from "../core/ids";
import type { Env } from "../env";
import type { JobTask, Waitable } from "../intake/types";
import { dispatchProject } from "./session";

export { receiveOriginal } from "../intake/api";
export { MATCH_MULTIPLE, MATCH_NEW, MATCH_UNRELATED, matchProject } from "./match";

export interface StartTaskInput {
  wardId: string;
  projectId: string;
  task: Exclude<JobTask, "connect">;
  /** 仕事の指示（例「案内の下書きを起こす。文書: 案内」）。原本は渡さない。状態は agent が MCP で引く */
  instruction: string;
  accountId?: string | null;
}

/**
 * 原本の無い仕事（下書き、報告、地図の下書き）を、そのプロジェクトの順番に入れる。
 * 同じプロジェクトでは一つずつ動き、終わると agent は結果を write_change（kind は draft、map_draft など）で書く。
 * 返す jobId で、状態（jobs.status）と使った量（job_runs）を見られる。
 */
export async function startTask(env: Env, ctx: Waitable, input: StartTaskInput): Promise<string> {
  const jobId = newId();
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO jobs (job_id, ward_id, project_id, via, task, instruction, account_id, status, created_at, updated_at, read_at)
     VALUES (?, ?, ?, 'system', ?, ?, ?, 'read', ?, ?, ?)`,
  )
    .bind(jobId, input.wardId, input.projectId, input.task, input.instruction.slice(0, 4000), input.accountId ?? null, now, now, now)
    .run();
  ctx.waitUntil(
    dispatchProject(env, input.wardId, input.projectId).catch((e) =>
      console.error("仕事の起動に失敗しました", e instanceof Error ? `${e.name}: ${e.message}` : ""),
    ),
  );
  return jobId;
}
