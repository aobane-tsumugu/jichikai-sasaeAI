import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { ROTA_FIXTURE as fixture } from "./fixtures/rota";
import { replaceRoster } from "../src/answers/api";
import { seedAdmin, seedSeat } from "../src/core/testing";
import { CRON } from "../src/core/cron";
import { WardBucket } from "../src/core/storage";
import { writeDailyWardSnapshots } from "../src/archive/snapshot";
import { exportWard, requestWardDeletion, runDeletionCron } from "../src/ops/lifecycle";
import { applyChange, createProject, getProjectState } from "../src/project/api";
import { createInvite } from "../src/space/api";
import { addExemption, compareRota } from "../src/rota/store";
import { cookieFrom, get, postForm, realApp } from "./helpers";

it("架空の去年の表と変わった名簿から免除を外した下書きを直して配り、世帯の履歴と役員だけの免除を残して渡し、消せる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  await replaceRoster(env.DB, ward.wardId, fixture.oldRoster, { household: 0, district: 1 });
  const previous = await createProject(env.DB, ward.wardId, {
    kind: "duty", title: fixture.title, year: 2025, accountId: account.accountId,
  });
  for (const [index, entry] of fixture.oldRoster.entries()) {
    // 去年の表を読み取って状態に置いたところから始める。AIや外部通信は使わない。
    expect((await applyChange(env.DB, ward.wardId, previous.projectId, {
      kind: "row", table: "duties", data: { slot: fixture.slots[index]!, task: FIRST_SLICE.helperTime, assignee: entry.household },
      source: { kind: "original", ref: "fictional-2024-duty-table", locator: `${index + 1}行目`, year: 2024 },
      confidence: "high", packVersion: "rota-flow-fictional@1",
    })).status).toBe("applied");
  }
  const previousStart = `${root}/projects/${previous.projectId}/draft/duty_roster/start`;
  expect((await postForm(realApp, previousStart, {}, cookie)).headers.get("location")).toContain("notice=saved");
  let oldState = await getProjectState(env.DB, ward.wardId, previous.projectId);
  const first = oldState?.tables.duties.find((row) => row.scope === "current" && row.data.assignee === FIRST_SLICE.firstHousehold);
  if (!first || !oldState) throw new Error("去年の当番の下書きがありません。");
  expect((await postForm(realApp, `${root}/projects/${previous.projectId}/draft/duty-row/${first.rowId}`, {
    slot: String(first.data.slot), task: FIRST_SLICE.helperTime, assignee: FIRST_SLICE.firstHousehold, attendance: "present",
  }, cookie)).status).toBe(303);
  await env.DB.prepare("UPDATE projects SET closed_at = ? WHERE ward_id = ? AND project_id = ?")
    .bind("2025-12-31T00:00:00.000Z", ward.wardId, previous.projectId).run();

  await replaceRoster(env.DB, ward.wardId, fixture.newRoster, { household: 0, district: 1 });
  const current = await createProject(env.DB, ward.wardId, {
    kind: "duty", title: fixture.title, year: 2026, seedProjectId: previous.projectId, eventDay: "2026-11-08", accountId: account.accountId,
  });
  const draft = `${root}/projects/${current.projectId}/draft/duty_roster`;
  const exempt = fixture.newRoster[1]!;
  expect((await postForm(realApp, `${root}/rota/exemptions`, {
    household: JSON.stringify(exempt), reason: fixture.reason, starts_on: "2026-01-01", ends_on: "2026-12-31",
  }, cookie)).headers.get("location")).toContain("saved=1");
  expect((await postForm(realApp, `${draft}/start`, {}, cookie)).headers.get("location")).toContain("notice=saved");
  const comparison = await compareRota(env.DB, ward.wardId, current.projectId);
  expect(comparison?.comparison).toMatchObject({ hasOldRoster: true,
    added: [`${FIRST_SLICE.district} ${FIRST_SLICE.rosterName}`], removed: [`${FIRST_SLICE.district} ${FIRST_SLICE.phoneHousehold}`] });
  const html = await (await get(realApp, draft, cookie)).text();
  expect(html).toContain("免除の期間に当たるため");
  expect(html).toContain(FIRST_SLICE.rosterName);
  expect(html).not.toContain(fixture.reason);
  let state = await getProjectState(env.DB, ward.wardId, current.projectId);
  if (!state) throw new Error("今年の当番がありません。");
  const rows = state.tables.duties.filter((row) => row.scope === "current");
  expect(rows.map((row) => row.data.slot)).toEqual(fixture.slots);
  expect(rows.map((row) => row.data.assignee)).toEqual([FIRST_SLICE.firstHousehold, "", ""]);
  expect(rows.every((row) => row.source.kind === "ai_proposal" && row.data.attendance === undefined)).toBe(true);
  const vacant = rows[2]!;
  expect((await postForm(realApp, `${root}/projects/${current.projectId}/draft/duty-row/${vacant.rowId}`, {
    slot: String(vacant.data.slot), task: FIRST_SLICE.helperTime, assignee: FIRST_SLICE.rosterName, attendance: "no_change",
  }, cookie)).status).toBe(303);
  expect((await postForm(realApp, `${draft}/start`, {}, cookie)).status).toBe(303);
  state = await getProjectState(env.DB, ward.wardId, current.projectId);
  expect(state?.tables.duties.find((row) => row.rowId === vacant.rowId)?.data.assignee).toBe(FIRST_SLICE.rosterName);
  expect((await postForm(realApp, `${draft}/save`, {
    title: FIRST_SLICE.dutyTitle, scope: "space", text: FIRST_SLICE.dutyText, based_on: String(state?.project.stateVersion),
  }, cookie)).headers.get("location")).toContain("notice=saved");
  const document = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
    WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1`).bind(ward.wardId, current.projectId)
    .first<{ document_id: string; version_id: string; version_no: number }>();
  if (!document) throw new Error("配る下書きがありません。");
  expect((await postForm(realApp, `${root}/publish/${current.projectId}/space`, {
    documentId: document.document_id, versionId: document.version_id, versionNo: String(document.version_no),
  }, cookie)).status).toBe(303);
  expect((await postForm(realApp, `${root}/space/${current.projectId}/open`, { passphrase: FIRST_SLICE.passphrase }, cookie)).status).toBe(200);
  const invite = await createInvite(env.DB, ward.wardId, current.projectId, "member", null, account.accountId, true);
  const entered = await get(realApp, `/${ward.slug}/space/${current.projectId}/person/${invite}`);
  const spaceCookie = cookieFrom(entered, `space_${current.projectId}`);
  if (!spaceCookie) throw new Error("実行委員のページに入れません。");
  const space = await (await get(realApp, `/${ward.slug}/space/${current.projectId}`, spaceCookie)).text();
  expect(space).toContain(FIRST_SLICE.rosterName);
  for (const page of [space, await (await get(realApp, `/${ward.slug}/`)).text(),
    await (await get(realApp, `${root}/print/${current.projectId}/${document.document_id}/${document.version_no}/preview`, cookie)).text()]) {
    expect(page).not.toContain(fixture.reason);
    expect(page).not.toContain("免除");
  }
  const snapshot = await env.DB.prepare("SELECT tables_snapshot FROM document_versions WHERE ward_id = ? AND version_id = ?")
    .bind(ward.wardId, document.version_id).first<string>("tables_snapshot");
  expect(snapshot).toContain(FIRST_SLICE.rosterName);
  expect(snapshot).not.toContain(fixture.reason);
  expect(snapshot).not.toContain(FIRST_SLICE.secondHousehold);
  expect((await get(realApp, `${root}/rota/exemptions`, spaceCookie)).status).toBe(303);
  expect((await get(realApp, `${root}/rota/history`, other.cookie)).status).toBe(303);
  expect((await get(realApp, `/${ward.slug}/rota/exemptions`)).status).toBe(404);

  const seat = await seedSeat(env.DB, ward.wardId, "書記（架空）");
  await env.DB.prepare("UPDATE accounts SET seat_id = ? WHERE ward_id = ? AND account_id = ?").bind(seat, ward.wardId, account.accountId).run();
  await env.DB.prepare("UPDATE accounts SET seat_id = NULL WHERE ward_id = ? AND account_id = ?").bind(ward.wardId, account.accountId).run();
  const history = await (await get(realApp, `${root}/rota/history`, cookie)).text();
  expect(history).toContain("出席の記録あり");
  expect(history).toContain(fixture.reason);
  expect(history).toContain("書記（架空）");
  const exported = (await exportWard(env, ward.wardId)).body;
  expect(exported).toContain(fixture.reason);
  await writeDailyWardSnapshots(env, new Date("2026-11-07T00:00:00Z"));
  const bucket = new WardBucket(env.ORIGINALS, ward.wardId);
  expect(await (await bucket.get("snapshots/daily/2026-11-07.json"))!.text()).toContain(fixture.reason);
  await requestWardDeletion(env.DB, ward.wardId);
  for (let i = 0; i < 6; i++) await runDeletionCron({ cron: CRON.EVERY_5_MIN } as ScheduledController, env);
  for (const table of ["rota_exemptions", "rota_preparations", "rota_seat_changes"]) {
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ward_id = ?`).bind(ward.wardId).first<number>("count")).toBe(0);
  }
  expect(await env.DB.prepare("SELECT ward_id FROM wards WHERE ward_id = ?").bind(other.ward.wardId).first()).not.toBeNull();
});

it("架空の名簿にある世帯は名前に各や班を含んでも免除を反映し、去年からの担当として扱う", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  // 名前も班も架空。名簿にない「各世帯」「1班」は団体の担当として残す。
  const roster = [{ household: "架空の各務", district: "1班" }, { household: "架空の班目", district: "1班" }];
  await replaceRoster(env.DB, ward.wardId, roster, { household: 0, district: 1 });
  const project = await createProject(env.DB, ward.wardId, {
    kind: "duty", title: "架空の清掃当番", year: 2026, eventDay: "2026-11-08", accountId: account.accountId,
  });
  const assignees = { 午前: roster[0]!.household, 午後: roster[1]!.household, 共同: "各世帯", 全体: "1班" };
  for (const [slot, assignee] of Object.entries(assignees)) {
    expect((await applyChange(env.DB, ward.wardId, project.projectId, {
      kind: "row", table: "duties", data: { slot, task: "架空の清掃", assignee },
      source: { kind: "original", ref: "fictional-name-rota", locator: slot, year: 2025 },
      confidence: "high", packVersion: "rota-flow-fictional@1",
    })).status).toBe("applied");
  }
  expect(await addExemption(env.DB, ward.wardId, account.accountId, {
    ...roster[0]!, reason: "架空の免除理由", startsOn: "2026-01-01", endsOn: "2026-12-31",
  })).toBe(true);

  const proposal = await compareRota(env.DB, ward.wardId, project.projectId);
  const expected = { ...assignees, 午前: "" };
  expect(Object.fromEntries(proposal?.comparison.entries.map((entry) => [entry.data.slot, entry.data.assignee]) ?? [])).toEqual(expected);
  expect(proposal?.comparison.added).toEqual([]);
  const root = `/${ward.slug}/admin/projects/${project.projectId}/draft/duty_roster`;
  expect((await postForm(realApp, `${root}/start`, {}, cookie)).headers.get("location")).toContain("notice=saved");
  const state = await getProjectState(env.DB, ward.wardId, project.projectId);
  expect(Object.fromEntries(state?.tables.duties.filter((row) => row.scope === "current")
    .map((row) => [row.data.slot, row.data.assignee]) ?? [])).toEqual(expected);
});

it.each([
  {
    example: "月日だけの表", slots: ["12月26日（金）", "12月27日（土）", "12月28日（日）"], eventDay: "2026-12-26",
    exemptOn: "2026-12-27", exemptIndex: 1, expectedSlots: ["12月26日（土）", "12月27日（日）", "12月28日（月）"],
  },
  {
    example: "年をまたぐ表", slots: ["2025年12月30日", "2025年12月31日", "2026年1月2日"], eventDay: "2026-12-29",
    exemptOn: "2027-01-01", exemptIndex: 2, expectedSlots: ["12月29日（火）", "12月30日（水）", "1月1日（金）"],
  },
])("架空の$exampleを今年へずらし、当番から外す期間に当たる日だけ担当を空欄にする", async ({ slots, eventDay, exemptOn, exemptIndex, expectedSlots }) => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const household = { household: "架空の当番世帯", district: "1班" };
  await replaceRoster(env.DB, ward.wardId, [household], { household: 0, district: 1 });
  const project = await createProject(env.DB, ward.wardId, {
    kind: "duty", title: "架空の日ごとの当番", year: 2026, eventDay, accountId: account.accountId,
  });
  for (const slot of slots) {
    expect((await applyChange(env.DB, ward.wardId, project.projectId, {
      kind: "row", table: "duties", data: { slot, task: "架空の見回り", assignee: household.household },
      source: { kind: "original", ref: "fictional-exemption-dates", locator: slot, year: 2025 },
      confidence: "high", packVersion: "rota-flow-fictional@1",
    })).status).toBe("applied");
  }
  expect(await addExemption(env.DB, ward.wardId, account.accountId, {
    ...household, reason: "架空の一日の免除", startsOn: exemptOn, endsOn: exemptOn,
  })).toBe(true);
  const expected = expectedSlots.map((slot, index) => [slot, index === exemptIndex ? "" : household.household]);
  const proposal = await compareRota(env.DB, ward.wardId, project.projectId);
  expect(proposal?.comparison.entries.map((entry) => [entry.data.slot, entry.data.assignee])).toEqual(expected);
  const root = `/${ward.slug}/admin/projects/${project.projectId}/draft/duty_roster`;
  expect((await postForm(realApp, `${root}/start`, {}, cookie)).headers.get("location")).toContain("notice=saved");
  const state = await getProjectState(env.DB, ward.wardId, project.projectId);
  expect(state?.tables.duties.filter((row) => row.scope === "current")
    .map((row) => [row.data.slot, row.data.assignee])).toEqual(expected);
});
