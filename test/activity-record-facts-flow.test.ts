import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { seedAdmin } from "../src/core/testing";
import { formatJstDate } from "../src/core/time";
import { applyChange, createProject, getProjectState } from "../src/project/api";
import { saveDocument, setMapTask } from "../src/project/actions";
import type { RowData } from "../src/project/model";
import { setSetting } from "../src/settings/store";
import { get, postForm, realApp } from "./helpers";

it("架空の行事を閉じ、紹介の下書きと公開に同じ事実を出し、名前を出さず来年の入口を残す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: FIRST_SLICE.nextYearTitle, year: FIRST_SLICE.eventYear,
    eventDay: "2026-10-24", accountId: account.accountId,
  });
  const id = project.projectId; const root = `/${ward.slug}`; const close = `${root}/admin/close/${id}`;
  await setSetting(env.DB, ward.wardId, "official_line_url", "https://example.test/official-line", account.accountId);
  const source = { kind: "person" as const, accountId: account.accountId };
  const duty = async (data: RowData) => {
    expect((await applyChange(env.DB, ward.wardId, id, {
      kind: "row", table: "duties", data, source, confidence: "high", packVersion: "activity-facts-test@1",
    })).status).toBe("applied");
  };
  await duty({ task: FIRST_SLICE.helperTime, slot: "午前", assignee: `${FIRST_SLICE.phoneHelper}、${FIRST_SLICE.sheetHelper}`, attendance: "present", note: FIRST_SLICE.sponsorName });
  await duty({ task: FIRST_SLICE.helperTime, slot: "13:00〜14:00", assignee: FIRST_SLICE.phoneHelper, attendance: "present" });
  await duty({ task: "片付け", slot: "午後", assignee: FIRST_SLICE.requestedBy, attendance: "absent" });
  // AI の割り当ての案は実績にも担当人数にも数えない。
  expect((await applyChange(env.DB, ward.wardId, id, {
    kind: "row", table: "duties", data: { task: "清掃", slot: "夜", assignee: FIRST_SLICE.firstHousehold, attendance: "present" },
    source: { kind: "ai_proposal", year: FIRST_SLICE.sourceYear }, confidence: "high", packVersion: "activity-facts-test@1",
  })).status).toBe("applied");
  const state = await getProjectState(env.DB, ward.wardId, id);
  if (!state) throw new Error("架空の行事がありません。");
  const task = state.mapTasks.find((entry) => entry.taskKey === "announcement");
  const untimed = state.mapTasks.find((entry) => entry.taskKey === "venue");
  const privateTask = state.mapTasks.find((entry) => entry.taskKey === "sponsors");
  if (!task || !untimed || !privateTask) throw new Error("架空のやることがありません。");
  for (const entry of [task, untimed, privateTask]) {
    expect(await setMapTask(env.DB, ward.wardId, id, entry.taskId, {
      name: entry === privateTask ? `${FIRST_SLICE.phoneHelper}に頼む` : entry.name,
      start: entry === untimed ? "" : entry.periodStart ?? "", end: entry === untimed ? "" : entry.periodEnd ?? "",
      progress: "done", seatId: null,
    })).toBe(true);
  }
  expect(await saveDocument(env.DB, ward.wardId, id, account.accountId, {
    kind: "announcement", title: FIRST_SLICE.draftTitle, scope: "public", basedOn: 0,
    body: JSON.stringify({ text: FIRST_SLICE.publicAnnouncement, items: [] }),
  })).toBe(true);
  const version = await env.DB.prepare("SELECT document_id, version_id, version_no FROM document_versions WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1")
    .bind(ward.wardId, id).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!version) throw new Error("架空の案内がありません。");
  expect((await postForm(realApp, `${root}/admin/publish/${id}/send`, {
    documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no), lineDelivery: "skip",
    recipientScope: "all_households", distribution: JSON.stringify({ mode: "district", targets: [{ district: "全戸", copies: 12 }] }),
  }, cookie)).status).toBe(303);
  expect((await postForm(realApp, `${close}/finalize`, { body: FIRST_SLICE.reportText }, cookie)).status).toBe(303);
  const expected = [
    "受付は午前の2人（当番表の担当）", "受付は13:00〜14:00の1人（当番表の担当）",
    "手伝った人は2人（当番表で出席が記録された人）", "紙は12部（配るときの部数）", "予定では当日の45日前〜30日前",
  ];
  const preview = await (await get(realApp, `${close}?view=activity`, cookie)).text();
  for (const fact of expected) expect(preview).toContain(fact);
  const form = new FormData();
  form.set("action", "publish"); form.set("introduction", FIRST_SLICE.reportText);
  form.set("membershipBurden", "行事の当番を受け持ちます（架空）。");
  form.set("membershipBenefit", "地域の行事に参加できます（架空）。");
  for (const entry of [task, untimed, privateTask]) form.append("taskId", entry.taskId);
  expect((await realApp.request(`${close}/activity`, {
    method: "POST", headers: { cookie, origin: "http://localhost" }, body: form,
  }, env)).status).toBe(303);
  const publicHtml = await (await get(realApp, `${root}/work/${id}`)).text();
  for (const fact of expected) expect(publicHtml).toContain(fact);
  expect(publicHtml).toContain(untimed.name);
  expect(publicHtml).toContain(`案内を知らせた日: ${formatJstDate(new Date().toISOString())}`);
  for (const name of [FIRST_SLICE.phoneHelper, FIRST_SLICE.sheetHelper, FIRST_SLICE.requestedBy, FIRST_SLICE.sponsorName, FIRST_SLICE.firstHousehold]) expect(publicHtml).not.toContain(name);
  expect(publicHtml).not.toContain("清掃は夜");
  expect(publicHtml).not.toContain("時期の記録なし");
  expect(publicHtml).not.toContain('href="' + root + '/help"');
  expect(publicHtml).toContain('href="' + root + '/line"');
  expect(publicHtml).toContain("来年の案内をご覧ください");
  // 前から載っていた紹介にも、保存し直さず同じ事実を補う。
  const published = await env.DB.prepare("SELECT published_body FROM project_activity_pages WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, id).first<{ published_body: string }>();
  if (!published) throw new Error("架空の紹介がありません。");
  const legacy = JSON.parse(published.published_body) as Record<string, unknown>;
  delete legacy.facts;
  await env.DB.prepare("UPDATE project_activity_pages SET published_body = ? WHERE ward_id = ? AND project_id = ?")
    .bind(JSON.stringify(legacy), ward.wardId, id).run();
  const legacyHtml = await (await get(realApp, `${root}/work/${id}`)).text();
  for (const fact of expected) expect(legacyHtml).toContain(fact);
  // 載せた時点の事実は、開き直した後の記録に引きずられない。
  await env.DB.prepare("UPDATE project_activity_pages SET published_body = ? WHERE ward_id = ? AND project_id = ?")
    .bind(published.published_body, ward.wardId, id).run();
  expect((await postForm(realApp, `${close}/reopen`, {}, cookie)).status).toBe(303);
  await duty({ task: FIRST_SLICE.helperTime, slot: "午前", assignee: FIRST_SLICE.phoneHelper, attendance: "absent" });
  const unchanged = await (await get(realApp, `${root}/work/${id}`)).text();
  for (const fact of expected) expect(unchanged).toContain(fact);
  const other = await seedAdmin(env.DB);
  expect((await get(realApp, `/${other.ward.slug}/work/${id}`)).status).toBe(404);
});
