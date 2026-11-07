import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { ONE_TIME_HELP as fixture } from "./fixtures/one-time-help";
import { getAnswerTotals, getDutyDraftHelpers, listAnswers, setAnswerDeadline } from "../src/answers/api";
import { listHelpOffers } from "../src/answers/help";
import { seedAdmin } from "../src/core/testing";
import { qrSvg } from "../src/print/qr";
import { createProject } from "../src/project/api";
import { saveDocument } from "../src/project/actions";
import { get, postForm, realApp } from "./helpers";

it("募集の紙とWebから同じ手伝いに申し込み、役員が時間を直して取消・復元し、世帯の数と分ける", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: FIRST_SLICE.nextYearTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId,
  });
  const base = `/${ward.slug}`;
  const root = `${base}/admin/answers/${project.projectId}`;
  const body = JSON.stringify({ text: FIRST_SLICE.draftText, items: [
    { key: "helper_slots", content: fixture.times.join("、") },
    { key: "due", content: fixture.due }, { key: "public_contact", content: fixture.contact },
  ] });
  expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
    kind: "recruitment", title: "手伝いの募集", scope: "public", basedOn: project.stateVersion, body,
  })).toBe(true);
  const version = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
    WHERE ward_id = ? AND project_id = ?`).bind(ward.wardId, project.projectId)
    .first<{ document_id: string; version_id: string; version_no: number }>();
  if (!version) throw new Error("架空の募集がありません。");
  expect((await postForm(realApp, `${base}/admin/publish/${project.projectId}/send`, {
    documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no), lineDelivery: "skip",
  }, cookie)).status).toBe(303);

  const paperResponse = await get(realApp, `${base}/admin/print/${project.projectId}/${version.document_id}/${version.version_no}/announcement`, cookie);
  expect(paperResponse.status).toBe(200);
  const paper = await paperResponse.text();
  const helpUrl = `${(env.PUBLIC_BASE_URL || "http://localhost").replace(/\/+$/, "")}${base}/help/${project.projectId}?d=${version.document_id}&v=${version.version_no}`;
  expect(paper).toContain(qrSvg(helpUrl));
  expect(paper).toContain("お名前");
  expect(paper).toContain("手伝える時間帯の一つに印を付けてください");
  expect(paper).toContain("班長か役員に渡してください。");
  expect(paper).not.toContain("代表者のお名前");
  expect(paper).not.toContain("参加する人数");
  const web = await (await get(realApp, new URL(helpUrl).pathname)).text();
  const hand = await (await get(realApp, `${root}/help`, cookie)).text();
  for (const time of fixture.times) {
    expect(paper).toContain(time);
    expect(web).toContain(`value="${time}"`);
    expect(hand).toContain(`value="${time}"`);
  }
  expect(hand).not.toMatch(/name="(?:household|district|people_count)"/);
  const submissionId = /name="submission_id" value="([^"]+)"/.exec(hand)?.[1];
  if (!submissionId) throw new Error("架空の手入力の送信番号がありません。");
  const input = { helper_name: FIRST_SLICE.sheetHelper, helper_times: fixture.times[0], submission_id: submissionId };
  const entered = await postForm(realApp, `${root}/help`, input, cookie);
  expect(entered.status).toBe(303);
  expect((await postForm(realApp, `${root}/help`, input, cookie)).status).toBe(303);
  const [offer] = await listHelpOffers(env.DB, ward.wardId, project.projectId);
  if (!offer) throw new Error("紙からの架空の申し込みがありません。");
  const endpoint = `${root}/help/${offer.offerId}`;
  expect(await listHelpOffers(env.DB, ward.wardId, project.projectId)).toHaveLength(1);
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toHaveLength(0);
  expect(await getAnswerTotals(env.DB, ward.wardId, project.projectId)).toEqual({ people: 0, helperRequests: 0 });
  expect(await (await get(realApp, root, cookie)).text()).toContain("手伝いの申し出を見る（1人）");
  expect(await (await get(realApp, `${root}?view=helpers`, cookie)).text()).toContain(`href="${endpoint}"`);

  // Webからも世帯に混ぜず同じ一覧へ入る。
  expect((await postForm(realApp, `${base}/help/${project.projectId}`, {
    helper_name: FIRST_SLICE.phoneHelper, helper_times: fixture.times[0], submission_id: crypto.randomUUID(),
  })).status).toBe(200);
  // 締切後に受けた変更と取消も反映し、押し間違えを戻せる。
  await setAnswerDeadline(env.DB, ward.wardId, project.projectId, "2000-01-01", account.accountId);
  expect((await postForm(realApp, `${endpoint}/edit`, { helper_times: fixture.times[1] }, cookie)).status).toBe(303);
  expect(await getDutyDraftHelpers(env.DB, ward.wardId, project.projectId)).toContainEqual(expect.objectContaining({ answerId: offer.offerId, times: fixture.times[1] }));
  const canceled = await postForm(realApp, `${endpoint}/cancel`, {}, cookie);
  expect(canceled.status).toBe(200);
  const receipt = await canceled.text();
  expect(receipt).toContain("取消を元に戻す");
  expect(await listHelpOffers(env.DB, ward.wardId, project.projectId)).toHaveLength(1);
  expect(await getDutyDraftHelpers(env.DB, ward.wardId, project.projectId)).not.toContainEqual(expect.objectContaining({ answerId: offer.offerId }));
  const undo = Object.fromEntries([...receipt.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((match) => [match[1]!, match[2]!]));
  expect(undo).toHaveProperty("submission_id", submissionId);
  expect((await postForm(realApp, `${endpoint}/restore`, undo, cookie)).status).toBe(303);
  expect(await listHelpOffers(env.DB, ward.wardId, project.projectId)).toHaveLength(2);
  expect(await getDutyDraftHelpers(env.DB, ward.wardId, project.projectId)).toContainEqual(expect.objectContaining({ answerId: offer.offerId, times: fixture.times[1] }));
  expect((await postForm(realApp, `${endpoint}/cancel`, {}, cookie)).status).toBe(200);
  expect((await postForm(realApp, `${base}/admin/close/${project.projectId}/finalize`, {}, cookie)).status).toBe(303);
  const closed = await env.DB.prepare("SELECT help_offer_count_on_close FROM projects WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, project.projectId).first<{ help_offer_count_on_close: number }>();
  expect(closed?.help_offer_count_on_close).toBe(1);
  expect((await postForm(realApp, `${endpoint}/restore`, undo, cookie)).headers.get("location")).toContain("error=answers_closed");
});

it.each([
  { slots: "（確認中）", choices: [] },
  { slots: `${fixture.times[0]}、（確認中）`, choices: [fixture.times[0]] },
])("確認中の時間帯を手伝いの選択肢から外し、決まった時間帯がないときは希望を書ける（$slots）", async ({ slots, choices }) => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の手伝いの募集", year: 2026, accountId: account.accountId,
  });
  const base = `/${ward.slug}`;
  expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
    kind: "recruitment", title: "架空の募集", scope: "public", basedOn: project.stateVersion,
    body: JSON.stringify({ text: "架空の手伝いを募集します。", items: [{ key: "helper_slots", content: slots }] }),
  })).toBe(true);
  const version = await env.DB.prepare("SELECT document_id, version_id, version_no FROM document_versions WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!version) throw new Error("架空の募集がありません。");
  expect((await postForm(realApp, `${base}/admin/publish/${project.projectId}/send`, {
    documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no), lineDelivery: "skip",
  }, cookie)).status).toBe(303);

  const publicPath = `${base}/help/${project.projectId}`;
  const adminPath = `${base}/admin/answers/${project.projectId}/help`;
  for (const html of [await (await get(realApp, publicPath)).text(), await (await get(realApp, adminPath, cookie)).text()]) {
    expect(html).not.toContain('<option value="（確認中）"');
    if (choices.length) {
      expect(html).toMatch(/<select[^>]+name="helper_times"/);
      for (const time of choices) expect(html).toContain(`<option value="${time}"`);
    } else {
      expect(html).toMatch(/<input[^>]+name="helper_times"/);
      expect(html).not.toMatch(/<select[^>]+name="helper_times"/);
    }
  }
  const paper = await (await get(realApp, `${base}/admin/print/${project.projectId}/${version.document_id}/${version.version_no}/announcement`, cookie)).text();
  expect(paper).not.toContain("□ （確認中）");
  for (const time of choices) expect(paper).toContain(`□ ${time}`);
  const times = choices[0] ?? fixture.times[1];
  expect((await postForm(realApp, publicPath, {
    helper_name: FIRST_SLICE.phoneHelper, helper_times: times, submission_id: crypto.randomUUID(),
  })).status).toBe(200);
  expect((await postForm(realApp, adminPath, {
    helper_name: FIRST_SLICE.sheetHelper, helper_times: times, submission_id: crypto.randomUUID(),
  }, cookie)).status).toBe(303);
  expect((await listHelpOffers(env.DB, ward.wardId, project.projectId)).map((offer) => offer.times)).toEqual([times, times]);
});
