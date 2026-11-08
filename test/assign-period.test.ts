import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { setEventDay } from "../src/project/actions";
import { createProject, getProjectState } from "../src/project/api";

it("資料から足した「担当を決める」にも、当日を入れたら当日の21日前から7日前を目安に置き、当日を直せば一緒に動く", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "年末の見回り", year: 2030, accountId: account.accountId, taskKeys: ["announcement", "day", "report"] });
  await env.DB.prepare(`INSERT INTO project_map_tasks (task_id, ward_id, project_id, task_key, name, period_start, period_end, offset_start_days, offset_end_days, sort_order, created_at)
    VALUES (?, ?, ?, 'assign', '担当を決める', NULL, NULL, -21, -7, 1, ?)`).bind(crypto.randomUUID(), ward.wardId, project.projectId, new Date().toISOString()).run();
  const assign = async () => (await getProjectState(env.DB, ward.wardId, project.projectId))?.mapTasks.find((task) => task.taskKey === "assign");
  expect(await setEventDay(env.DB, ward.wardId, project.projectId, "2030-12-26", account.accountId, "2030-12-28")).toBe(true);
  expect(await assign()).toMatchObject({ periodStart: "2030-12-05", periodEnd: "2030-12-19" });
  expect(await setEventDay(env.DB, ward.wardId, project.projectId, "2030-12-27", account.accountId, "2030-12-29")).toBe(true);
  expect(await assign()).toMatchObject({ periodStart: "2030-12-06", periodEnd: "2030-12-20" });
});
