import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject, getProjectState } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("人がやることに足した仕事にも、これをもとに新しく始めるで去年の三つの記録を出す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const source = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の行事", year: 2026, eventDay: "2026-10-24", accountId: account.accountId,
  });
  const root = `/${ward.slug}/admin`;
  expect((await postForm(realApp, `${root}/projects/${source.projectId}/map/add`, {
    name: "架空の会場の鍵を受け取る",
  }, cookie)).status).toBe(303);
  const task = (await getProjectState(env.DB, ward.wardId, source.projectId))!.mapTasks.find((row) => row.name === "架空の会場の鍵を受け取る")!;
  expect((await get(realApp, `${root}/close/${source.projectId}`, cookie)).status).toBe(200);
  expect((await postForm(realApp, `${root}/close/${source.projectId}/map/${task.taskId}`, {
    name: "架空の会場の鍵を受け取る", period: "前日", progress: "done", requestedBy: "架空の会場の担当者",
    difficulty: "架空の鍵の受け取り時刻が合わなかった", nextYear: "架空の鍵は一週間前に受け取りを頼む",
  }, cookie)).status).toBe(303);
  expect((await postForm(realApp, `${root}/close/${source.projectId}/finalize`, {}, cookie)).status).toBe(303);
  const seeded = await postForm(realApp, `${root}/archive/${source.projectId}/seed`, {
    title: "来年の架空の行事", year: "2027", eventDay: "2027-10-23",
  }, cookie);
  expect(seeded.status).toBe(303);
  const location = seeded.headers.get("location");
  expect(location).toMatch(/\?started=.+$/);
  const projectId = new URL(location!, "http://localhost").searchParams.get("started");
  if (!projectId) throw new Error("新しいやることがありません");
  const seededTask = (await getProjectState(env.DB, ward.wardId, projectId))?.mapTasks.find((row) => row.name === task.name);
  if (!seededTask) throw new Error("引き継いだ仕事がありません");
  const page = await get(realApp, `${root}/projects/${projectId}/map/${seededTask.taskId}`, cookie);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("架空の会場の鍵を受け取る");
  expect(html).toContain("<dt>頼んだ人</dt><dd>架空の会場の担当者");
  expect(html).toContain("<dt>困ったこと</dt><dd>架空の鍵の受け取り時刻が合わなかった");
  expect(html).toContain("<dt>来年は</dt><dd>架空の鍵は一週間前に受け取りを頼む");
  expect(html.match(/去年の記録/g)).toHaveLength(1);
});
