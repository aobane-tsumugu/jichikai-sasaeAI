import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { getAnswerTotals, listAnswers } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { claimRead, finishRead } from "../src/intake/store";
import { applyChange, createProject, getProjectState } from "../src/project/api";
import type { RowData } from "../src/project/model";
import { cookieFrom, get, postForm, realApp } from "./helpers";

it("当番の下書きと記入用紙から実行委員のページを開き、読み取った答えを直して閉じたあとの案内まで進める", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: fixture.nextYearTitle, year: fixture.eventYear, accountId: account.accountId,
  });
  const id = project.projectId;
  const root = `/${ward.slug}/admin`;
  const source = { kind: "person" as const, accountId: account.accountId };
  const rows: { table: "duties" | "layout" | "sponsors"; data: RowData }[] = [
    { table: "duties" as const, data: { slot: fixture.helperTime, task: fixture.helperTime, assignee: fixture.sheetHelper } },
    { table: "layout" as const, data: { spot: fixture.layoutSpot, position: fixture.layoutPosition } },
    { table: "sponsors" as const, data: { name: fixture.sponsorName, amount: fixture.sponsorAmount, reply: "yes" } },
  ];
  for (const input of rows) {
    expect((await applyChange(env.DB, ward.wardId, id, {
      kind: "row", ...input, source, confidence: "high", packVersion: "u20-flow@1",
    })).status).toBe("applied");
  }
  const draft = await (await get(realApp, `${root}/projects/${id}/draft/duty_roster`, cookie)).text();
  expect(draft).toContain('class="duty-rows"');
  expect(draft).toMatch(/type="radio" name="attendance" value="no_change" checked/);
  expect(draft).toContain("当番表は、実行委員と班長にだけ見えます。");
  const meeting = await (await get(realApp, `${root}/print/${id}/paper/meeting`, cookie)).text();
  expect(meeting).toContain(`${fixture.nextYearTitle} 役員会の記入欄`);
  expect(meeting).toContain("きれいに書かなくてかまいません。");
  expect(meeting.match(/min-height:66mm/g)).toHaveLength(3);
  expect(meeting).not.toContain("に配りましたに印刷しました");
  const sponsors = await (await get(realApp, `${root}/print/${id}/paper/sponsors`, cookie)).text();
  expect(sponsors).toContain('class="paper-header"');
  expect(sponsors).toContain("お願いした日");
  expect(sponsors).toContain(fixture.sponsorName);

  const state = await getProjectState(env.DB, ward.wardId, id);
  if (!state) throw new Error("架空の行事がありません。");
  expect((await postForm(realApp, `${root}/projects/${id}/draft/duty_roster/save`, {
    title: fixture.dutyTitle, scope: "space", based_on: String(state.project.stateVersion),
    text: fixture.dutyText, item_date_time: fixture.publicDayText, item_place: fixture.previousPlace,
  }, cookie)).status).toBe(303);
  const document = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM document_versions v
    JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
    WHERE v.ward_id = ? AND v.project_id = ? AND d.kind = 'duty_roster' ORDER BY v.version_no DESC LIMIT 1`)
    .bind(ward.wardId, id).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!document) throw new Error("保存した当番表がありません。");
  expect((await postForm(realApp, `${root}/publish/${id}/space`, {
    documentId: document.document_id, versionId: document.version_id, versionNo: String(document.version_no),
  }, cookie)).status).toBe(303);
  const duty = await (await get(realApp, `${root}/print/${id}/${document.document_id}/${document.version_no}/duty`, cookie)).text();
  expect(duty).toContain('class="paper-table paper-duties"');
  expect(duty).toContain('class="paper-table paper-layout"');
  expect(duty).toContain("出席");
  expect(duty.match(/min-height:30mm/g)).toHaveLength(1);

  expect((await postForm(realApp, `${root}/space/${id}/open`, { passphrase: fixture.passphrase }, cookie)).status).toBe(200);
  const spacePath = `/${ward.slug}/space/${id}`;
  const entered = await postForm(realApp, `${spacePath}/enter`, { passphrase: fixture.passphrase });
  const memberCookie = cookieFrom(entered, `space_${id}`);
  if (!memberCookie) throw new Error("実行委員の入口から入れませんでした。");
  const member = await (await get(realApp, spacePath, memberCookie)).text();
  expect(member).toContain('<div class="split"><aside>');
  expect(member).toContain(fixture.sheetHelper);
  expect(member).toContain("1軒のうち、1軒から返事がありました。");
  expect(member).toContain("返事あり");
  expect(member).not.toContain(`${fixture.sponsorAmount.toLocaleString("ja-JP")}円`);

  const received = await receive(env, {
    wardId: ward.wardId, projectId: id, via: "admin", readKind: "answer_sheet", accountId: account.accountId,
    parts: [{ kind: "photo", filename: fixture.answerSheetFilename, mediaType: "image/jpeg", bytes: new Uint8Array(fixture.answerSheetPhotoBytes) }],
  });
  const originalId = received.received[0]?.originalId;
  if (!received.jobId || !originalId) throw new Error("回答票を受け取れませんでした。");
  const attempt = await claimRead(env.DB, ward.wardId, received.jobId, 60_000);
  if (!attempt) throw new Error("回答票の読み取りを始められませんでした。");
  expect(await finishRead(env.DB, {
    wardId: ward.wardId, jobId: received.jobId, attempt, source: "model", packVersion: "u20-sheet@1", model: "fixture",
    body: { ...fixture.answerSheetReading, rows: fixture.answerSheetReading.rows.map((row) => ({ ...row, original_id: originalId })) },
  })).toBe(true);
  const answersPath = `${root}/answers/${id}`;
  const read = await (await get(realApp, `${answersPath}?view=read`, cookie)).text();
  expect(read).toContain("読み取った答えを直して入れる");
  expect(read).toContain("元の資料（回答票の写真）を見る");
  expect(read).toContain('class="choice half"');
  expect(read).toContain("答えに入れる");
  expect((await postForm(realApp, `${answersPath}/sheet/${originalId}/row/0`, {
    household: fixture.firstHousehold, district: fixture.district, attend: "yes",
    children_count: "1", adults_count: "2", seniors_count: "0", helper_name: fixture.sheetHelper, helper_times: fixture.helperTime,
  }, cookie)).status).toBe(303);
  expect((await getAnswerTotals(env.DB, ward.wardId, id)).people).toBe(3);
  const savedAnswers = await listAnswers(env.DB, ward.wardId, id);
  const answer = savedAnswers[0];
  if (!answer) throw new Error("入れた答えがありません。");
  expect((await postForm(realApp, `${root}/close/${id}/finalize`, {}, cookie)).status).toBe(303);
  const closed = await (await get(realApp, `${answersPath}/${answer.answerId}/edit`, cookie)).text();
  expect(closed).toContain("この行事は終わっています");
  expect(closed).toContain(`href="${root}/close/${id}">行事をもう一度開く画面へ`);
  expect(closed).toContain("もう一度開いても、これまでの記録は残ります。");
  expect(closed).not.toContain('name="household"');
  expect(await listAnswers(env.DB, ward.wardId, id)).toEqual(savedAnswers);
});
