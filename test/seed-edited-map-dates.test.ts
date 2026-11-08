import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject, getProjectState } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("去年のやることで直した仕事の日付を、来年の行事の日から同じ間隔で引き継ぐ", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const source = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "試しの行事", year: 2026, eventDay: "2026-10-24", accountId: account.accountId,
  });
  const root = `/${ward.slug}/admin`;
  const venue = (await getProjectState(env.DB, ward.wardId, source.projectId))!.mapTasks.find((task) => task.taskKey === "venue")!;
  expect((await postForm(realApp, `${root}/projects/${source.projectId}/map/${venue.taskId}`, {
    name: venue.name, start: "2026-10-20", end: "2026-10-21", progress: "done", seat_id: "",
  }, cookie)).status).toBe(303);
  expect((await get(realApp, `${root}/close/${source.projectId}`, cookie)).status).toBe(200);
  expect((await postForm(realApp, `${root}/close/${source.projectId}/finalize`, {}, cookie)).status).toBe(303);
  const seeded = await postForm(realApp, `${root}/archive/${source.projectId}/seed`, {
    title: "来年の試しの行事", year: "2027", eventDay: "2027-10-23",
  }, cookie);
  expect(seeded.status).toBe(303);
  const targetId = new URL(seeded.headers.get("location")!, "http://localhost").searchParams.get("started");
  expect(targetId).toBeDefined();
  const next = await getProjectState(env.DB, ward.wardId, targetId!);
  expect(next?.mapTasks.find((task) => task.taskKey === "venue"))
    .toMatchObject({ periodStart: "2027-10-19", periodEnd: "2027-10-20" });
});
