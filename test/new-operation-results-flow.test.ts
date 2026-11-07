import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { ROTA_FIXTURE as rota } from "./fixtures/rota";
import { getAnswerDeadline, listAnswers, replaceRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { claimRead, finishRead } from "../src/intake/store";
import { applyChange, createProject, getProjectState } from "../src/project/api";
import { exemptions } from "../src/rota/store";
import { get, postForm, realApp } from "./helpers";

it("架空の当番と総会で、操作の結果と次の案と戻り方を読み、役員の直しを保ってやり直せる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const read = async (path: string) => {
    const response = await get(realApp, path, cookie);
    expect(response.status).toBe(200);
    return response.text();
  };
  const result = async (response: Response, message: string, back: string) => {
    expect(response.status).toBe(303);
    const location = response.headers.get("location");
    if (!location) throw new Error("操作のあとに開く画面がありません。");
    const html = await read(location);
    expect(html).toContain(message);
    expect(html.match(/class="next"/g)).toHaveLength(1);
    expect(html).toContain(back);
    return html;
  };
  const duty = await createProject(env.DB, ward.wardId, {
    kind: "duty", title: rota.title, year: fixture.eventYear, accountId: account.accountId,
  });
  const draft = `${root}/projects/${duty.projectId}/draft/duty_roster`;
  const empty = await read(draft);
  expect(empty).toContain("去年の表も今の名簿もまだありません");
  expect(empty.match(/class="next"/g)).toHaveLength(1);
  expect(empty).toContain(`/intake?project=${duty.projectId}#send-form`);
  for (const path of ["exemptions", "history"]) {
    const html = await read(`${root}/rota/${path}`);
    expect(html.match(/class="next"/g)).toHaveLength(1);
    expect(html).toContain(`${root}/answers/roster`);
  }
  await replaceRoster(env.DB, ward.wardId, rota.newRoster, { household: 0, district: 1 });
  for (const [index, entry] of rota.oldRoster.entries()) {
    expect((await applyChange(env.DB, ward.wardId, duty.projectId, {
      kind: "row", table: "duties", data: { slot: rota.slots[index]!, task: fixture.helperTime, assignee: entry.household },
      source: { kind: "original", ref: "fictional-u55-previous-table", locator: `${index + 1}行目`, year: fixture.sourceYear },
      confidence: "high", packVersion: "u55-fictional@1",
    })).status).toBe("applied");
  }
  const before = await getProjectState(env.DB, ward.wardId, duty.projectId);
  const preparePath = `${draft}/start`;
  expect(await read(draft)).toContain(`action="${preparePath}"`);
  await result(await postForm(realApp, preparePath, {}, cookie), "当番の下書きを作りました", "当番の下書きへ戻る");
  const created = await getProjectState(env.DB, ward.wardId, duty.projectId);
  const first = created?.tables.duties.find((row) => row.scope === "current" && row.data.slot === rota.slots[0]);
  if (!first) throw new Error("架空の当番の下書きがありません。");
  // 時間帯も直す。去年の照合先が変わっても、同じ行の直しを保つ。
  const edited = { slot: "夕方（架空）", task: fixture.helperTime, assignee: fixture.rosterName, attendance: "present" };
  expect((await postForm(realApp, `${root}/projects/${duty.projectId}/draft/duty-row/${first.rowId}`, edited, cookie)).status).toBe(303);
  const exemptPath = `${root}/rota/exemptions`;
  await result(await postForm(realApp, exemptPath, {
    household: JSON.stringify(rota.newRoster[1]), reason: rota.reason, starts_on: "2026-01-01", ends_on: "2026-12-31",
  }, cookie), "免除の記録を保存しました。", "免除の画面へ戻る");
  const exemption = (await exemptions(env.DB, ward.wardId))[0];
  if (!exemption) throw new Error("架空の免除の記録がありません。");
  const rebuilt = await result(await postForm(realApp, preparePath, {}, cookie), "今の名簿と免除を下書きに反映しました", "当番の下書きへ戻る");
  expect(rebuilt).toContain("担当を戻したいときも、下書きで書き直せます");
  const after = await getProjectState(env.DB, ward.wardId, duty.projectId);
  expect(after?.tables.duties.find((row) => row.rowId === first.rowId)?.data).toEqual(edited);
  expect(after?.tables.duties.filter((row) => row.scope === "current")).toHaveLength(3);
  expect(after?.tables.duties.find((row) => row.scope === "current" && row.data.slot === rota.slots[1])?.data.assignee).toBe("");
  expect(after?.tables.duties.filter((row) => row.scope === "reference")).toEqual(before?.tables.duties.filter((row) => row.scope === "reference"));
  await result(await postForm(realApp, `${exemptPath}/${exemption.exemption_id}/withdraw`, {}, cookie), "免除を取り消しました。", "取り消した免除を戻す");
  expect((await exemptions(env.DB, ward.wardId))[0]?.withdrawn_at).not.toBeNull();
  await result(await postForm(realApp, `${exemptPath}/${exemption.exemption_id}/restore`, {}, cookie), "取り消した免除を戻しました。", "免除の画面へ戻る");
  expect((await exemptions(env.DB, ward.wardId))[0]?.withdrawn_at).toBeNull();

  const meeting = await createProject(env.DB, ward.wardId, {
    kind: "general_meeting", title: "総会（架空）", year: fixture.eventYear, accountId: account.accountId,
  });
  const answers = `${root}/answers/${meeting.projectId}`;
  const emptyMeeting = await read(answers);
  expect(emptyMeeting.match(/class="next"/g)).toHaveLength(1);
  expect(emptyMeeting).toContain(`${answers}?view=send`);
  const hand = { household: fixture.firstHousehold, district: fixture.district, meeting_status: "attend", proxy_name: "" };
  const entered = await result(await postForm(realApp, `${answers}/phone`, hand, cookie), "電話や紙の返事を数に入れました。", "手で入れる画面へ戻る");
  const answer = (await listAnswers(env.DB, ward.wardId, meeting.projectId))[0];
  if (!answer) throw new Error("架空の総会の返事がありません。");
  const editPath = `${answers}/${answer.answerId}/edit`;
  expect(entered).toContain(`href="${editPath}"`);
  const corrected = await result(await postForm(realApp, editPath, { ...hand, meeting_status: "proxy", proxy_name: fixture.firstOfficer }, cookie), "返事を訂正し、数え直しました。", "返事の一覧へ戻る");
  expect(corrected).toContain(`href="${editPath}"`);
  await result(await postForm(realApp, editPath, hand, cookie), "返事を訂正し、数え直しました。", "返事の一覧へ戻る");
  expect((await listAnswers(env.DB, ward.wardId, meeting.projectId))[0]?.meetingStatus).toBe("attend");
  const deleted = await result(await postForm(realApp, `${answers}/${answer.answerId}/delete`, {}, cookie), "返事を一覧と数から消しました。", "返事の一覧へ戻る");
  expect(deleted).toContain(`href="${answers}?view=hand"`);
  expect(await listAnswers(env.DB, ward.wardId, meeting.projectId)).toHaveLength(0);
  await result(await postForm(realApp, `${answers}/phone`, hand, cookie), "電話や紙の返事を数に入れました。", "手で入れる画面へ戻る");
  expect(await listAnswers(env.DB, ward.wardId, meeting.projectId)).toHaveLength(1);
  const deadline = await result(await postForm(realApp, `${answers}/deadline`, { due_on: "2099-11-08" }, cookie), "返事の締切を11月8日", "総会の返事へ戻る");
  expect(deadline).toContain(`${answers}?deadline=edit#answer-deadline`);
  expect(await read(`${answers}?deadline=edit`)).toMatch(/<details[^>]*id="answer-deadline"[^>]*open/);
  await result(await postForm(realApp, `${answers}/deadline`, { due_on: "2099-11-07" }, cookie), "返事の締切を11月7日", "総会の返事へ戻る");
  expect(await getAnswerDeadline(env.DB, ward.wardId, meeting.projectId)).toBe("2099-11-07");

  // 読み取りは架空の応答を保存する。受付、R2、D1、画面、訂正は製品の経路を使う。
  const received = await receive(env, {
    wardId: ward.wardId, projectId: meeting.projectId, via: "admin", readKind: "answer_sheet", accountId: account.accountId,
    parts: [{ kind: "photo", filename: fixture.answerSheetFilename, mediaType: "image/jpeg", bytes: new Uint8Array(fixture.answerSheetPhotoBytes) }],
  });
  const original = received.received[0];
  if (!received.jobId || !original) throw new Error("架空の回答票を受け付けられません。");
  const attempt = await claimRead(env.DB, ward.wardId, received.jobId, 60_000);
  if (attempt === null) throw new Error("架空の回答票の読み取りを始められません。");
  expect(await finishRead(env.DB, {
    wardId: ward.wardId, jobId: received.jobId, attempt, source: "model", packVersion: "u55-fictional-sheet@1", model: "fixture",
    body: { ...fixture.answerSheetReading, rows: [{ ...fixture.answerSheetReading.rows[0]!, original_id: original.originalId,
      household_name: fixture.secondHousehold, meeting_status: null }],
      unreadable: [{ original_id: original.originalId, locator: "1枚目", note: "出欠の印が読めませんでした" }] },
  })).toBe(true);
  const sheetPath = `${answers}/sheet/${original.originalId}/row/0`;
  expect(await read(`${answers}?view=read`)).toContain(`action="${sheetPath}"`);
  const fixedSheet = { ...hand, household: fixture.secondHousehold, meeting_status: "absent" };
  const fixed = await result(await postForm(realApp, sheetPath, fixedSheet, cookie), "読み取った返事を直して、数に入れました。", "回答票の読み取りへ戻る");
  expect(fixed).toContain(`original=${original.originalId}`);
  await result(await postForm(realApp, sheetPath, { ...fixedSheet, meeting_status: "attend" }, cookie), "読み取った返事を直して、数に入れました。", "回答票の読み取りへ戻る");
  const savedAnswers = await listAnswers(env.DB, ward.wardId, meeting.projectId);
  expect(savedAnswers).toHaveLength(2);
  expect(savedAnswers.find((entry) => entry.originalId === original.originalId)?.meetingStatus).toBe("attend");

  const close = `${root}/close/${meeting.projectId}`;
  const finalize = (staff: string) => {
    const form = new FormData();
    form.append("body", fixture.reportText);
    form.append("body", staff);
    form.append("decisions", fixture.nextYearChange);
    return realApp.request(`${close}/finalize`, { method: "POST", headers: { cookie, origin: "http://localhost" }, body: form }, env);
  };
  await result(await finalize(fixture.nextYearChange), "会議を終わりにして、議事録を役員の記録に残しました", "終わりを取り消す</button>");
  expect(await read(`${root}/archive/${meeting.projectId}`)).toContain(fixture.nextYearChange);
  const reopened = await result(await postForm(realApp, `${close}/reopen`, {}, cookie), "終わりを取り消しました", "終わりにする画面に戻る");
  expect(reopened).toContain(`href="${close}#report-staff"`);
  expect(reopened).toContain("間違えたときは、終わりにする画面で");
  expect(await read(close)).toContain(fixture.nextYearChange);
  await result(await finalize(fixture.nextYearDifficulty), "会議を終わりにして、議事録を役員の記録に残しました", "終わりを取り消す</button>");
  expect(await env.DB.prepare("SELECT body FROM project_close_reports WHERE ward_id = ? AND project_id = ? AND scope = 'staff'")
    .bind(ward.wardId, meeting.projectId).first("body")).toBe(fixture.nextYearDifficulty);
});
