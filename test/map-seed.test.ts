import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject, getProjectState } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("閉じる時に残した三つの記録を種から開いた地図の同じ仕事に出す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "去年の行事（架空）", year: 2026, eventDay: "2026-10-24", accountId: account.accountId,
  });
  const root = `/${ward.slug}/admin`;
  expect((await get(realApp, `${root}/close/${project.projectId}`, cookie)).status).toBe(200);
  const task = await env.DB.prepare("SELECT task_id FROM project_map_tasks WHERE ward_id = ? AND project_id = ? AND task_key = 'venue'")
    .bind(ward.wardId, project.projectId).first<{ task_id: string }>();
  expect(task).not.toBeNull();
  const saved = await postForm(realApp, `${root}/close/${project.projectId}/map/${task!.task_id}`, {
    name: "会場を押さえる", period: "10月", progress: "done", requestedBy: "会場の担当者（架空）",
    difficulty: "鍵を受け取る時刻が合わなかった（架空）", nextYear: "一週間前に鍵の受け取りを頼む（架空）",
  }, cookie);
  expect(saved.status).toBe(303);
  expect((await postForm(realApp, `${root}/close/${project.projectId}/finalize`, {}, cookie)).status).toBe(303);
  const seeded = await postForm(realApp, `${root}/archive/${project.projectId}/seed`, {
    title: "来年の行事（架空）", year: "2027", eventDay: "2027-10-23",
  }, cookie);
  const location = seeded.headers.get("location");
  expect(location).toMatch(/\?started=.+$/);
  const projectId = new URL(location!, "http://localhost").searchParams.get("started");
  if (!projectId) throw new Error("引き継いだ段取りがありません");
  const seededTask = (await getProjectState(env.DB, ward.wardId, projectId))?.mapTasks.find((row) => row.taskKey === "venue");
  if (!seededTask) throw new Error("引き継いだ仕事がありません");
  const page = await get(realApp, `${root}/projects/${projectId}/map/${seededTask.taskId}`, cookie);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("去年の記録");
  expect(html).toContain("<dt>頼んだ人</dt><dd>会場の担当者（架空）");
  expect(html).toContain("<dt>困ったこと</dt><dd>鍵を受け取る時刻が合わなかった（架空）");
  expect(html).toContain("<dt>来年は</dt><dd>一週間前に鍵の受け取りを頼む（架空）");
  expect(html.match(/去年の記録/g)).toHaveLength(1);
});

it("種のないプロジェクトの地図には去年の記録を出さない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "新しい行事（架空）", year: 2027, accountId: account.accountId,
  });
  const page = await get(realApp, `/${ward.slug}/admin/projects/${project.projectId}/map`, cookie);
  expect(page.status).toBe(200);
  expect(await page.text()).not.toContain("去年の記録");
});
