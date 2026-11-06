import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { getAnswerDeadline, getAnswerTotals, listAnswers, listUnansweredByDistrict, replaceRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

afterEach(() => vi.useRealTimers());

it("案内の締切を受付に使い、回答を直して消し、手で延ばした締切は配り直しても残す", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T03:00:00Z"));
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: FIRST_SLICE.draftTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId,
  });
  await replaceRoster(env.DB, ward.wardId, [
    { household: FIRST_SLICE.firstHousehold, district: FIRST_SLICE.district },
    { household: FIRST_SLICE.secondHousehold, district: FIRST_SLICE.district },
  ], { household: 0, district: 1 });
  const answersPath = `/${ward.slug}/admin/answers/${project.projectId}`;
  const publicPath = `/${ward.slug}/answer/${project.projectId}`;
  const publishPath = `/${ward.slug}/admin/publish/${project.projectId}`;
  const publish = async (due: string) => {
    expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
      kind: "announcement", title: FIRST_SLICE.draftTitle, scope: "public", basedOn: 0,
      body: JSON.stringify({ text: FIRST_SLICE.draftText, items: [{ key: "due", content: due }] }),
    })).toBe(true);
    const version = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no
      FROM document_versions v JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
      WHERE v.ward_id = ? AND v.project_id = ? AND d.kind = 'announcement' ORDER BY v.version_no DESC LIMIT 1`)
      .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
    if (!version) throw new Error("配る案がありません。");
    expect((await postForm(realApp, `${publishPath}/send`, {
      documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no),
      distribution: `${FIRST_SLICE.district} 2`, lineDelivery: "skip",
    }, cookie)).status).toBe(303);
  };

  await publish("決まり次第お知らせします");
  expect(await getAnswerDeadline(env.DB, ward.wardId, project.projectId)).toBeNull();
  const input = { household: FIRST_SLICE.phoneHousehold, district: `${FIRST_SLICE.district}（打ち間違い）`,
    people_count: "3", helper_name: FIRST_SLICE.phoneHelper, helper_times: FIRST_SLICE.helperTime };
  expect((await postForm(realApp, `${answersPath}/phone`, input, cookie)).status).toBe(303);
  const before = (await listAnswers(env.DB, ward.wardId, project.projectId))[0];
  if (!before) throw new Error("直す回答がありません。");
  const editPath = `${answersPath}/${before.answerId}/edit`;
  const indexHtml = await (await get(realApp, answersPath, cookie)).text();
  expect(indexHtml).toContain(`href="${editPath}"`);
  const editPage = await get(realApp, editPath, cookie);
  expect(editPage.status).toBe(200);
  const editHtml = await editPage.text();
  expect(editHtml).toContain(`value="${FIRST_SLICE.phoneHousehold}"`);
  expect(editHtml).toContain("保存せずに戻る");
  expect(editHtml).toContain(`action="${answersPath}/${before.answerId}/delete"`);
  expect((await postForm(realApp, editPath, {
    household: FIRST_SLICE.firstHousehold, district: FIRST_SLICE.district,
    people_count: "2", helper_name: FIRST_SLICE.sheetHelper, helper_times: FIRST_SLICE.helperTime,
  }, cookie)).status).toBe(303);
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toEqual([
    expect.objectContaining({ answerId: before.answerId, household: FIRST_SLICE.firstHousehold,
      district: FIRST_SLICE.district, peopleCount: 2, helperName: FIRST_SLICE.sheetHelper,
      helperTimes: FIRST_SLICE.helperTime, source: "phone", createdAt: before.createdAt }),
  ]);
  expect(await getAnswerTotals(env.DB, ward.wardId, project.projectId)).toEqual({ people: 2, helperRequests: 1 });
  expect(await listUnansweredByDistrict(env.DB, ward.wardId, project.projectId)).toEqual([
    { district: FIRST_SLICE.district, households: [FIRST_SLICE.secondHousehold] },
  ]);
  expect(await (await get(realApp, editPath, cookie)).text()).toContain(`value="${FIRST_SLICE.firstHousehold}"`);
  expect((await postForm(realApp, `${answersPath}/${before.answerId}/delete`, {}, cookie)).status).toBe(303);
  expect(await getAnswerTotals(env.DB, ward.wardId, project.projectId)).toEqual({ people: 0, helperRequests: 0 });
  expect(await listUnansweredByDistrict(env.DB, ward.wardId, project.projectId)).toEqual([
    { district: FIRST_SLICE.district, households: [FIRST_SLICE.firstHousehold, FIRST_SLICE.secondHousehold] },
  ]);
  expect((await get(realApp, editPath, cookie)).status).toBe(404);

  vi.setSystemTime(new Date("2026-10-01T03:00:00Z"));
  await publish("10 月 9 日（金）まで");
  expect(await getAnswerDeadline(env.DB, ward.wardId, project.projectId)).toBe("2026-10-09");
  vi.setSystemTime(new Date("2026-10-10T03:00:00Z"));
  expect(await (await get(realApp, publicPath)).text()).toContain("答えの受付は終わりました");
  const webInput = { ...input, district: FIRST_SLICE.district };
  expect((await postForm(realApp, publicPath, webInput)).status).toBe(400);

  await publish("2026/10/11");
  expect(await getAnswerDeadline(env.DB, ward.wardId, project.projectId)).toBe("2026-10-11");
  expect((await postForm(realApp, `${answersPath}/deadline`, { due_on: "2026-10-12" }, cookie)).status).toBe(303);
  await publish("2026年10月9日");
  expect(await getAnswerDeadline(env.DB, ward.wardId, project.projectId)).toBe("2026-10-12");
  expect((await postForm(realApp, publicPath, webInput)).status).toBe(200);
  expect(await getAnswerTotals(env.DB, ward.wardId, project.projectId)).toEqual({ people: 3, helperRequests: 1 });
  // 過ぎた日は受付の締切に入れない。配った途端に回答が閉じないように
  await env.DB.prepare("DELETE FROM project_deadlines WHERE ward_id = ? AND project_id = ? AND kind = 'answer_due'").bind(ward.wardId, project.projectId).run();
  await publish("2025年10月10日");
  expect(await getAnswerDeadline(env.DB, ward.wardId, project.projectId)).toBeNull();
});
