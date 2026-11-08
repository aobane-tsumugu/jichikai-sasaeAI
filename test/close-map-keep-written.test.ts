import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { agentApi } from "../src/project/agent-api";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("来年への一言の下書きを作り直しても、すでに書いてある欄は上書きせず、空の欄だけ埋める", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2026, accountId: account.accountId, eventDay: "2026-01-10" });
  await get(realApp, `/${ward.slug}/admin/close/${project.projectId}`, cookie);
  const job = await env.DB.prepare("SELECT job_id FROM jobs WHERE ward_id = ? AND project_id = ? AND task = 'map_draft'").bind(ward.wardId, project.projectId).first<{ job_id: string }>();
  const tasks = (await env.DB.prepare("SELECT task_id, name FROM project_close_map WHERE ward_id = ? AND project_id = ?").bind(ward.wardId, project.projectId).all<{ task_id: string; name: string }>()).results;
  const task = tasks[0]!;
  // 役員が前に書いた（終わりにして取り消した）来年変えること。
  await env.DB.prepare("UPDATE project_close_map SET next_year = ? WHERE ward_id = ? AND task_id = ?").bind("受付を二人にする", ward.wardId, task.task_id).run();
  const result = await agentApi.applyChange(env, { wardId: ward.wardId, projectId: project.projectId, jobId: job!.job_id, packVersion: "test@1", agentVersion: null }, {
    kind: "map_draft", target: "map", confidence: "high",
    data: { tasks: tasks.map((entry) => ({ task_id: entry.task_id, name: entry.name, progress: "done", period: "", requested_by: "3班の班長", difficulty: "", next_year: "AIの案" })) },
  } as never);
  expect(result.status).toBe("applied");
  const saved = await env.DB.prepare("SELECT requested_by, next_year FROM project_close_map WHERE ward_id = ? AND task_id = ?").bind(ward.wardId, task.task_id).first<{ requested_by: string; next_year: string }>();
  expect(saved).toEqual({ requested_by: "3班の班長", next_year: "受付を二人にする" });
});
