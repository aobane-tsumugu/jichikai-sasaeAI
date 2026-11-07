import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject, getProjectState, getProjectSummary } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("記録から始める入力で名前を直すときも、入力した年と日付を保つ", async () => {
  // 行事の名前と日付は試験用の架空のもの。
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const source = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の去年の行事", year: 2026, eventDay: "2026-09-06", accountId: account.accountId,
  });
  await env.DB.prepare("UPDATE projects SET closed_at = ? WHERE ward_id = ? AND project_id = ?")
    .bind("2026-09-07T00:00:00Z", ward.wardId, source.projectId).run();
  const root = `/${ward.slug}/admin/archive/${source.projectId}`;
  const initial = await (await get(realApp, `${root}?view=seed`, cookie)).text();
  expect(initial).toContain('name="title" type="text" value="架空の去年の行事"');
  expect(initial).toContain('name="year" type="number" inputmode="numeric" value="2027"');

  const values = { title: "　", year: "2030", eventDay: "2030-09-03" };
  const failed = await postForm(realApp, `${root}/seed`, values, cookie);
  const html = failed.status === 303
    ? await (await get(realApp, failed.headers.get("location")!, cookie)).text()
    : await failed.text();
  expect(html).toContain('name="year" type="number" inputmode="numeric" value="2030"');
  expect(html).toContain('name="eventDay" type="date" value="2030-09-03"');
  expect(html).toContain('name="title" type="text" value="　"');
  expect(html).toContain("名前、年、当日を確かめて");
  expect(failed.status).toBe(400);
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM projects WHERE ward_id = ? AND seed_project_id = ?")
    .bind(ward.wardId, source.projectId).first<number>("count")).toBe(0);

  const title = "架空の次の行事";
  const saved = await postForm(realApp, `${root}/seed`, { ...values, title }, cookie);
  expect(saved.status).toBe(303);
  const location = saved.headers.get("location")!;
  expect(location).toContain(`${root}?started=`);
  const target = new URL(location, "https://example.test").searchParams.get("started")!;
  expect(await getProjectSummary(env.DB, ward.wardId, target))
    .toMatchObject({ title, year: 2030, deadlines: { event_day: values.eventDay } });
  expect((await get(realApp, location, cookie)).status).toBe(200);
  expect(await getProjectSummary(env.DB, ward.wardId, source.projectId))
    .toMatchObject({ title: source.title, year: 2026, deadlines: { event_day: "2026-09-06" } });
});

it("記録から当日が未定でも始められ、去年の日付を今年の予定にしない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const source = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の去年の行事", year: 2026, eventDay: "2026-09-06", accountId: account.accountId,
  });
  await env.DB.prepare("UPDATE projects SET closed_at = ? WHERE ward_id = ? AND project_id = ?")
    .bind("2026-09-07T00:00:00Z", ward.wardId, source.projectId).run();
  const before = await getProjectState(env.DB, ward.wardId, source.projectId);
  if (!before) throw new Error("もとにする記録がありません。");
  expect(before.mapTasks.length).toBeGreaterThan(0);
  expect(before.mapTasks.some((task) => task.periodStart !== null)).toBe(true);
  const root = `/${ward.slug}/admin/archive/${source.projectId}`;
  const saved = await postForm(realApp, `${root}/seed`, {
    title: "架空の次の行事", year: "2027", eventDay: "",
  }, cookie);
  expect(saved.status).toBe(303);
  const location = saved.headers.get("location")!;
  expect(location).toContain(`${root}?started=`);
  const targetId = new URL(location, "https://example.test").searchParams.get("started");
  if (!targetId) throw new Error("新しく始めた行事がありません。");
  const next = await getProjectState(env.DB, ward.wardId, targetId);
  if (!next) throw new Error("新しく始めた行事を読めません。");
  expect(next.project).toMatchObject({ title: "架空の次の行事", year: 2027, closedAt: null });
  expect(next.project.deadlines).toEqual({});
  expect(next.mapTasks.map(({ taskKey, name, periodStart, periodEnd }) => ({ taskKey, name, periodStart, periodEnd })))
    .toEqual(before.mapTasks.map(({ taskKey, name }) => ({ taskKey, name, periodStart: null, periodEnd: null })));
  expect((await get(realApp, location, cookie)).status).toBe(200);
  expect(await getProjectState(env.DB, ward.wardId, source.projectId)).toEqual(before);
});
