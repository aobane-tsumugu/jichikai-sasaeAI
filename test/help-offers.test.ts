import { setSetting } from "../src/settings/store";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { addAnswer, getAnswerTotals, getDutyDraftHelpers, listAnswers } from "../src/answers/api";
import { listHelpOffers } from "../src/answers/help";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { saveDocument } from "../src/project/actions";
import { get, postForm, realApp } from "./helpers";

it("募集から班を選ばず申し込み、世帯と別に数えて当番の資料にし、行事を閉じると名前を消す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: FIRST_SLICE.nextYearTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId,
  });
  const base = `/${ward.slug}`;
  const helpPath = `${base}/help/${project.projectId}`;
  const linePath = `${base}/line`;
  const settings = { contact: "", squads: FIRST_SLICE.district, official_line_url: "https://example.test/official-line" };
  await setSetting(env.DB, ward.wardId, "official_line_url", settings.official_line_url, null);
  expect((await postForm(realApp, `${base}/admin/settings/info`, settings, cookie)).status).toBe(303);
  expect(await (await get(realApp, `${base}/admin/settings/info`, cookie)).text()).not.toContain('name="official_line_url"');
  await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
    kind: "recruitment", title: FIRST_SLICE.draftTitle, scope: "public", basedOn: project.stateVersion,
    body: JSON.stringify({ text: FIRST_SLICE.draftText, items: [{ key: "helper_slots", content: FIRST_SLICE.helperTime }] }),
  });
  const version = await env.DB.prepare(`SELECT d.document_id, v.version_id, v.version_no FROM documents d
    JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = 'recruitment'`)
    .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!version) throw new Error("募集が保存されていません");
  await env.DB.prepare(`INSERT INTO publication_records (ward_id, publication_id, project_id, document_id, version_id,
    version_no, line_status, published_at, published_by_account_id) VALUES (?, ?, ?, ?, ?, ?, 'not_sent', ?, ?)`)
    .bind(ward.wardId, crypto.randomUUID(), project.projectId, version.document_id, version.version_id,
      version.version_no, new Date().toISOString(), account.accountId).run();

  const home = await (await get(realApp, `${base}/`)).text();
  expect(home).toContain(`href="${base}/help"`);
  expect(home).toContain(`href="${linePath}"`);
  const lineResponse = await get(realApp, linePath);
  expect(lineResponse.status).toBe(200);
  const linePage = await lineResponse.text();
  expect(linePage).toContain(`href="${settings.official_line_url}"`);
  expect(linePage).toContain("追加しなくても読めます");
  expect(linePage).toContain("案内は、このページと、紙の回覧、掲示でも読めます。");
  expect((await get(realApp, `${base}/help`)).headers.get("location")).toBe(helpPath);
  const form = await (await get(realApp, helpPath)).text();
  expect(form).toContain(`value="${FIRST_SLICE.helperTime}"`);
  expect(form).not.toMatch(/name="(?:household|district|people_count)"/);
  const sent = await postForm(realApp, helpPath, { helper_name: FIRST_SLICE.sheetHelper, helper_times: FIRST_SLICE.helperTime });
  expect(sent.status).toBe(200);
  expect(await sent.text()).toContain("申し込みを受け付けました");
  await addAnswer(env.DB, ward.wardId, {
    projectId: project.projectId, household: FIRST_SLICE.firstHousehold, district: FIRST_SLICE.district,
    peopleCount: 2, helperName: FIRST_SLICE.phoneHelper, helperTimes: FIRST_SLICE.helperTime, source: "phone",
  });
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toHaveLength(1);
  expect(await getAnswerTotals(env.DB, ward.wardId, project.projectId)).toEqual({ people: 2, helperRequests: 1 });
  const answersPage = await (await get(realApp, `${base}/admin/answers/${project.projectId}?view=helpers`, cookie)).text();
  expect(answersPage).toContain("世帯の返事");
  expect(answersPage).toContain("手伝いだけ");
  expect(answersPage).toContain(FIRST_SLICE.sheetHelper);
  const helpers = await getDutyDraftHelpers(env.DB, ward.wardId, project.projectId);
  expect(helpers).toHaveLength(2);
  expect(helpers).toContainEqual(expect.objectContaining({ name: FIRST_SLICE.sheetHelper, times: FIRST_SLICE.helperTime, household: "", district: "" }));

  expect((await postForm(realApp, `${base}/admin/close/${project.projectId}/finalize`, {}, cookie)).status).toBe(303);
  expect(await listHelpOffers(env.DB, ward.wardId, project.projectId)).toHaveLength(0);
  expect((await postForm(realApp, helpPath, { helper_name: FIRST_SLICE.sheetHelper, helper_times: FIRST_SLICE.helperTime })).status).toBe(400);
  expect(await (await get(realApp, `${base}/`)).text()).not.toContain(`href="${base}/help"`);
  expect((await postForm(realApp, `${base}/admin/settings/info`, { ...settings, official_line_url: "" }, cookie)).status).toBe(303);
  const homeWithLine = await (await get(realApp, `${base}/`)).text();
  expect(homeWithLine).toContain(`href="${linePath}"`);
  const lineWithSetting = await (await get(realApp, linePath)).text();
  expect(lineWithSetting).toContain(`href="${settings.official_line_url}"`);
});
