import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { KAKUU_YEAR_RECURRING, seedKakuuYearRecurring } from "../fixtures/kakuu-year-recurring";
import { getRoster, replaceRoster } from "../src/answers/api";
import { SNAPSHOT_TABLES, WARD_TABLE_POLICY } from "../src/archive/snapshot";
import { seedAdmin } from "../src/core/testing";
import { getKnowItem } from "../src/know/store";
import { wardYear, YEAR_BASE } from "../src/know/year";
import { createProject, getProjectState, listOpenProjects } from "../src/project/api";
import { addExemption } from "../src/rota/store";
import { get, postForm, realApp } from "./helpers";

it("通年のごみ当番を月曜で作り、免除と名簿変更を反映し、市報の配布は予定と基本情報に残す", async () => {
  // この試験の世帯、進め方、免除の理由は全て架空。
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const year = Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Tokyo", year: "numeric" }).format(new Date()));
  const roster = KAKUU_YEAR_RECURRING.roster;
  await replaceRoster(env.DB, ward.wardId, roster, { household: 0, district: 1 });
  const ordered = await getRoster(env.DB, ward.wardId);
  expect(ordered).toHaveLength(3);
  const exempt = ordered[1]!;
  expect(await addExemption(env.DB, ward.wardId, account.accountId, {
    ...exempt, reason: "この年は当番を休む", startsOn: `${year}-04-01`, endsOn: `${year + 1}-03-31`,
  })).toBe(true);
  const initialYear = await (await get(realApp, `${root}/year`, cookie)).text();
  for (const title of ["ごみ当番", "市報や回覧の配布", "集会所の管理"]) expect(initialYear).toContain(title);
  for (const base of YEAR_BASE.filter((entry) => entry.recurrence)) expect(initialYear).toContain(`href="${root}/year/${base.key}"`);

  expect((await postForm(realApp, `${root}/year/garbage-duty/recurring`, {
    recurrence: "毎週月曜", body: "ごみ当番は世帯の名簿の順で回す。",
  }, cookie)).status).toBe(303);
  expect((await postForm(realApp, `${root}/year`, { title: "市報の配布", month: "0", recurrence: "毎月" }, cookie)).status).toBe(303);
  const delivery = await env.DB.prepare("SELECT item_id FROM ward_year_items WHERE ward_id = ? AND title = ?")
    .bind(ward.wardId, "市報の配布").first<{ item_id: string }>();
  if (!delivery) throw new Error("市報の配布がありません");
  expect((await postForm(realApp, `${root}/year/${delivery.item_id}/recurring`, {
    recurrence: "毎月", body: "毎月、班長が市報を各世帯に配る。",
  }, cookie)).status).toBe(303);
  expect((await getKnowItem(env.DB, ward.wardId, "delivery"))?.body).toBe("毎月、班長が市報を各世帯に配る。");
  const deliveryPage = await (await get(realApp, `${root}/year/${delivery.item_id}`, cookie)).text();
  expect(deliveryPage).toContain("毎月。");
  expect(deliveryPage).not.toContain("準備を始める");
  expect(deliveryPage).not.toContain("/prepare");
  expect((await postForm(realApp, `${root}/year/${delivery.item_id}/prepare`, {}, cookie)).status).toBe(404);

  const started = await postForm(realApp, `${root}/year/garbage-duty/prepare`, {}, cookie);
  expect(started.status).toBe(303);
  const draft = started.headers.get("location");
  if (!draft) throw new Error("当番表へ進めません");
  expect((await postForm(realApp, `${root}/year/garbage-duty/prepare`, {}, cookie)).headers.get("location")).toBe(draft);
  const projects = await listOpenProjects(env.DB, ward.wardId);
  expect(projects.map((project) => project.title)).toEqual(["ごみ当番"]);
  const project = projects[0]!;
  expect(project.kind).toBe("duty");
  expect(await (await get(realApp, draft, cookie)).text()).toContain("何曜日に当番を回しますか");
  expect((await postForm(realApp, `${root}/rota/${project.projectId}/weekly`, { weekday: "1" }, cookie)).status).toBe(303);
  const state = await getProjectState(env.DB, ward.wardId, project.projectId);
  if (!state) throw new Error("ごみ当番の下書きがありません");
  const duties = state.tables.duties.filter((row) => row.scope === "current");
  const mondays: string[] = [];
  // 自治会の一年は4月から翌年3月。
  for (let day = new Date(`${year}-04-01T00:00:00Z`); day < new Date(`${year + 1}-04-01T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
    if (day.getUTCDay() === 1) mondays.push(day.toISOString().slice(0, 10));
  }
  expect(duties.map((row) => row.data.slot)).toEqual(mondays);
  const available = ordered.filter((entry) => entry.household !== exempt.household);
  expect(duties.map((row) => row.data.assignee)).toEqual(mondays.map((_, index) => available[index % available.length]!.household));
  expect(duties.every((row) => row.data.assignee !== exempt.household)).toBe(true);
  const table = await wardYear(env.DB, ward, projects, [state], `${year}-11-08`);
  expect(table.rows.find((row) => row.title === "ごみ当番")).toMatchObject({ state: "fact", from: 0, to: 100, note: "毎週月曜。" });
  expect(table.rows.find((row) => row.title === "市報の配布")).toMatchObject({ state: "fact", from: 0, to: 100, note: "毎月。" });
  const html = await (await get(realApp, `${root}/year`, cookie)).text();
  expect(html).toContain("毎週月曜。");
  expect(html).toContain("毎月。");
  expect(html).toContain("--from:0%;--to:100%");

  // 手で直した当番は保ち、未編集の担当は今の名簿と免除で作り直す。曜日は送り直さない。
  const edited = duties[0]!;
  expect((await postForm(realApp, `${root}/projects/${project.projectId}/draft/duty-row/${edited.rowId}`, {
    slot: String(edited.data.slot), task: String(edited.data.task), assignee: "手で決めた担当", attendance: "no_change",
  }, cookie)).status).toBe(303);
  const arrived = { household: "江口", district: "1班" };
  await replaceRoster(env.DB, ward.wardId, [available[1]!, arrived], { household: 0, district: 1 });
  expect((await postForm(realApp, `${draft}/start`, {}, cookie)).status).toBe(303);
  const refreshed = await getProjectState(env.DB, ward.wardId, project.projectId);
  if (!refreshed) throw new Error("作り直した当番表がありません");
  const current = refreshed.tables.duties.filter((row) => row.scope === "current");
  expect(current).toHaveLength(mondays.length);
  expect(current.map((row) => row.data.slot)).toEqual(mondays);
  expect(current.find((row) => row.rowId === edited.rowId)?.data.assignee).toBe("手で決めた担当");
  expect(current.some((row) => row.data.assignee === arrived.household)).toBe(true);
  expect(current.some((row) => row.data.assignee === available[0]!.household)).toBe(false);
  expect(await env.DB.prepare("SELECT weekday FROM rota_schedules WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, project.projectId).first<number>("weekday")).toBe(1);
  expect((await postForm(realApp, `/${other.ward.slug}/admin/rota/${project.projectId}/weekly`, { weekday: "2" }, other.cookie)).status).toBe(404);
  expect((await postForm(realApp, `/${other.ward.slug}/admin/year/${delivery.item_id}/recurring`, { recurrence: "随時" }, other.cookie)).status).toBe(404);
  expect((await listOpenProjects(env.DB, other.ward.wardId))).toHaveLength(0);
});

it("kakuuの見本に月曜のごみ当番と毎月の市報を入れ、ほかの自治会には入れない", async () => {
  const { ward, account } = await seedAdmin(env.DB, "kakuu");
  const judge = await seedAdmin(env.DB);
  const projectId = await seedKakuuYearRecurring(env.DB, ward, account.accountId);
  const state = await getProjectState(env.DB, ward.wardId, projectId);
  if (!state) throw new Error("見本のごみ当番がありません");
  expect(state.tables.duties.filter((row) => row.scope === "current")).toHaveLength(52);
  const first = state.tables.duties.find((row) => row.scope === "current");
  expect(first?.data.slot).toBe("2026-04-06");
  const projects = await listOpenProjects(env.DB, ward.wardId);
  const table = await wardYear(env.DB, ward, projects, [state], "2026-11-08");
  expect(table.rows.find((row) => row.title === "ごみ当番")?.note).toBe("毎週月曜。");
  expect(table.rows.find((row) => row.title === "市報の配布")?.note).toBe("毎月。");
  expect(projects.map((project) => project.title)).toEqual(["ごみ当番"]);
  await expect(seedKakuuYearRecurring(env.DB, judge.ward, judge.account.accountId)).rejects.toThrow("kakuuだけ");
  expect(await listOpenProjects(env.DB, judge.ward.wardId)).toHaveLength(0);
  expect(SNAPSHOT_TABLES).toContain("rota_schedules");
  expect(WARD_TABLE_POLICY.find((entry) => entry.table === "rota_schedules")).toMatchObject({ export: true, deletion: { cascade: "projects" } });
  // 同じ見本を再度入れても、当番の準備と通年の予定は増えない。
  expect(await seedKakuuYearRecurring(env.DB, ward, account.accountId)).toBe(projectId);
  expect(await listOpenProjects(env.DB, ward.wardId)).toHaveLength(1);
});

it("通年の曜日を空や範囲外で送っても表を作らず、別の種類にも設定しない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  await replaceRoster(env.DB, ward.wardId, KAKUU_YEAR_RECURRING.roster, { household: 0, district: 1 });
  const duty = await createProject(env.DB, ward.wardId, { kind: "duty", title: "集会所の掃除", year: 2026, accountId: account.accountId });
  const event = await createProject(env.DB, ward.wardId, { kind: "event", title: "清掃の日", year: 2026, accountId: account.accountId });
  const root = `/${ward.slug}/admin`;
  for (const weekday of ["", "7", "-1", "1.5"]) expect((await postForm(realApp, `${root}/rota/${duty.projectId}/weekly`, { weekday }, cookie)).status).toBe(400);
  expect((await postForm(realApp, `${root}/rota/${event.projectId}/weekly`, { weekday: "1" }, cookie)).status).toBe(404);
  expect((await getProjectState(env.DB, ward.wardId, duty.projectId))?.tables.duties).toHaveLength(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM rota_schedules WHERE ward_id = ?").bind(ward.wardId).first<number>("n")).toBe(0);
});
