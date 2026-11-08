import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject, getProjectState } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("やることの一覧は、当日が無い時に行ごとに「時期はまだ決まっていません」を並べず、過ぎて済んでいない仕事に印を付ける。仕事一つは保存したことを書く", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const undecided = await createProject(env.DB, ward.wardId, { kind: "event", title: "防災訓練", year: 2030, accountId: account.accountId });
  const map = await (await get(realApp, `${root}/projects/${undecided.projectId}/map`, cookie)).text();
  expect(map).toContain("まず、日を決めます");
  expect(map).not.toContain("時期はまだ決まっていません");
  const task = (await getProjectState(env.DB, ward.wardId, undecided.projectId))!.mapTasks[0]!;
  const taskPage = await (await get(realApp, `${root}/projects/${undecided.projectId}/map/${task.taskId}`, cookie)).text();
  expect(taskPage).toContain(`時期は、防災訓練の当日を入れると決まります。<a href="${root}/projects/${undecided.projectId}/map">防災訓練の当日を入れる</a>`);
  expect(taskPage).not.toContain("担当はあとから直せます。");
  const saved = await postForm(realApp, `${root}/projects/${undecided.projectId}/map/${task.taskId}`, { name: task.name, start: "2030-05-01", end: "2030-05-10", progress: "open", seat_id: "" }, cookie);
  const after = await (await get(realApp, saved.headers.get("location")!, cookie)).text();
  expect(after).toContain(`「${task.name}」を保存しました`);
  expect(after).toContain("時期は5月1日（水）から5月10日（金）までです。担当はまだ決まっていません。");
  expect(after).not.toContain("やることに入りました");

  const past = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2026, accountId: account.accountId, eventDay: "2026-01-10" });
  const pastMap = await (await get(realApp, `${root}/projects/${past.projectId}/map`, cookie)).text();
  expect(pastMap).toContain("（過ぎています）");
});
