import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { replaceRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { SHORT_TEMPLATE } from "../src/know/year";
import { applyChange, createProject, getProjectState } from "../src/project/api";
import { compareRota, prepareRota } from "../src/rota/store";
import { get, postForm, realApp } from "./helpers";

it.each(["担当を決める"])("eventのまま%sを足すと、届いた三晩の表と翌年の記録から当番表を始める", async (taskName) => {
  // 日、班、世帯と資料は全て。読み取った去年の表を保存したところから通す。
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const roster = ["試しの甲世帯", "試しの乙世帯", "試しの丙世帯"].map((household, index) => ({ household, district: `${index + 1}班` }));
  await replaceRoster(env.DB, ward.wardId, roster, { household: 0, district: 1 });
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "試しの年末の見回り", year: 2026, eventDay: "2026-12-26", eventEnd: "2026-12-28",
    taskKeys: SHORT_TEMPLATE.tasks, accountId: account.accountId,
  });
  const path = `${root}/projects/${project.projectId}`;
  expect((await postForm(realApp, `${path}/map/add`, { name: taskName }, cookie)).status).toBe(303);
  const expected = roster.map((entry, index) => ({ slot: `2026-12-${26 + index}`, task: entry.district, assignee: entry.household }));
  for (const [index, row] of expected.entries()) {
    expect((await applyChange(env.DB, ward.wardId, project.projectId, {
      kind: "row", table: "duties", data: { ...row, slot: `2025-12-${26 + index}` },
      source: { kind: "original", ref: "fictional-night-patrol-table", locator: `${index + 1}行目`, year: 2025 },
      confidence: "high", packVersion: "fictional-night-patrol@1",
    })).status).toBe("applied");
  }
  const draft = `${path}/draft/duty_roster`;
  const before = await (await get(realApp, draft, cookie)).text();
  expect(before).toContain("去年の表の日と班と世帯を、今年の日に合わせて並べます。");
  expect(before).not.toContain("曜日を一度選ぶと");
  expect(await (await get(realApp, `${path}/draft`, cookie)).text()).toContain("当番の下書きを作る</button>");
  const started = await postForm(realApp, `${draft}/start`, {}, cookie);
  expect(started.status).toBe(303);
  expect(started.headers.get("location")).toContain("notice=saved");
  const state = await getProjectState(env.DB, ward.wardId, project.projectId);
  expect(state?.project.kind).toBe("event");
  expect(state?.tables.duties.filter((row) => row.scope === "current").map((row) => row.data)).toEqual(expected);
  expect(await (await get(realApp, draft, cookie)).text()).not.toContain("当番表の行はまだありません");
  expect(await prepareRota(env.DB, other.ward.wardId, project.projectId, other.account.accountId)).toBe(false);
  expect(await env.DB.prepare("SELECT job_id FROM jobs WHERE ward_id = ? AND project_id = ? AND task = 'draft'")
    .bind(ward.wardId, project.projectId).first()).toBeNull();

  // 去年もeventだった準備を、翌年の下書きでも拾う。
  await env.DB.prepare("UPDATE projects SET closed_at = ? WHERE ward_id = ? AND project_id = ?")
    .bind("2026-12-29T00:00:00.000Z", ward.wardId, project.projectId).run();
  const next = await createProject(env.DB, ward.wardId, {
    kind: "event", title: project.title, year: 2027, seedProjectId: project.projectId, accountId: account.accountId,
  });
  expect((await postForm(realApp, `${root}/projects/${next.projectId}/map/add`, { name: taskName }, cookie)).status).toBe(303);
  expect(await prepareRota(env.DB, ward.wardId, next.projectId, account.accountId)).toBe(true);
  expect((await compareRota(env.DB, ward.wardId, next.projectId))?.comparison.sourceProjectId).toBe(project.projectId);
  expect((await getProjectState(env.DB, ward.wardId, next.projectId))?.tables.duties.filter((row) => row.scope === "current").map((row) => row.data))
    .toEqual(expected.map((row) => ({ ...row, slot: row.slot.replace("2026", "2027") })));
});

it("行事の「当番表と配置を決める」だけでは名簿の順で回さず、手伝いの返事から AI に下書きを頼む", async () => {
  // 名簿の順で回すのは「担当を決める」がある時だけ。行事の当番表は手伝いの申し込みと世帯の返事から作る。
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "試しの秋の祭り", year: 2026, accountId: account.accountId });
  const state = await getProjectState(env.DB, ward.wardId, project.projectId);
  expect(state?.mapTasks.some((task) => task.taskKey === "duty_roster")).toBe(true);
  expect(state?.mapTasks.some((task) => task.taskKey === "assign")).toBe(false);
  const path = `/${ward.slug}/admin/projects/${project.projectId}`;
  const list = await (await get(realApp, `${path}/draft`, cookie)).text();
  expect(list).not.toContain("当番の下書きを作る</button>");
  const draft = await (await get(realApp, `${path}/draft/duty_roster`, cookie)).text();
  expect(draft).toContain("手伝いの申し込みと、世帯の返事にある手伝いから、AIが担当の下書きを入れます。");
  expect(await prepareRota(env.DB, ward.wardId, project.projectId, account.accountId)).toBe(false);
});
