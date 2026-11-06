import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject, getProjectState } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("閉じた地図は変更せず、開き直してから仕事を直せる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の地図の確認", year: 2026, eventDay: "2026-10-24", accountId: account.accountId,
  });
  const root = `/${ward.slug}/admin`;
  const path = `${root}/projects/${project.projectId}/map`;
  const before = (await getProjectState(env.DB, ward.wardId, project.projectId))!.mapTasks;
  const task = before.find((row) => row.taskKey === "venue")!;
  const fields = { name: "架空の会場を予約する", start: "2026-10-20", end: "2026-10-21", progress: "done", seat_id: "" };
  expect((await get(realApp, path, cookie)).status).toBe(200);
  expect((await get(realApp, `${root}/close/${project.projectId}`, cookie)).status).toBe(200);
  expect((await postForm(realApp, `${root}/close/${project.projectId}/finalize`, {}, cookie)).status).toBe(303);

  // 閉じる前に開いていた画面から送っても、記録の仕事を変えない。
  const responses = [
    await postForm(realApp, `${path}/${task.taskId}`, fields, cookie),
    await postForm(realApp, `${path}/${task.taskId}/remove`, {}, cookie),
    await postForm(realApp, `${path}/add`, { name: "架空の追加の仕事" }, cookie),
  ];
  expect((await getProjectState(env.DB, ward.wardId, project.projectId))!.mapTasks).toEqual(before);
  for (const response of responses) {
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain(`${root}/close/${project.projectId}?error=`);
  }
  const closed = await (await get(realApp, path, cookie)).text();
  expect(closed).toContain("直す時は「報告と閉じる」から「開き直す」を押してください。");
  expect(closed).not.toContain("時期や担当を直す");
  expect(closed).not.toContain("この仕事を地図から外す");
  expect(closed).not.toContain('name="name"');
  const guidance = await (await get(realApp, responses[0]!.headers.get("location")!, cookie)).text();
  expect(guidance).toContain("この行事は閉じました。段取りを直すときは「もう一度開く」を押してください。");

  expect((await postForm(realApp, `${root}/close/${project.projectId}/reopen`, {}, cookie)).status).toBe(303);
  expect(await (await get(realApp, path, cookie)).text()).toContain("時期や担当を直す");
  expect((await postForm(realApp, `${path}/${task.taskId}`, fields, cookie)).status).toBe(303);
  expect((await getProjectState(env.DB, ward.wardId, project.projectId))!.mapTasks.find((row) => row.taskId === task.taskId))
    .toMatchObject({ name: fields.name, periodStart: fields.start, periodEnd: fields.end, progress: fields.progress });
});
