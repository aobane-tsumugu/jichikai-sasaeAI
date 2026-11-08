import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { packVersionFor, systemFor } from "../src/ai/read";
import { checkPublicDraft } from "../src/check";
import { seedAdmin } from "../src/core/testing";
import { getDraftPack } from "../src/draft/packs";
import { getEditableDocument, saveAIDraft } from "../src/project/actions";
import { addQuestion, applyChange, createProject, getProjectState, type DocumentKind } from "../src/project/api";
import type { DocumentBody } from "../src/project/document-body";
import { get, postForm, realApp } from "./helpers";

it("試しの資料の下書きを見比べて直し、雨の場所を確かめ、協賛額を出さずに活動を紹介する", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const create = (kind: "event" | "board_meeting" | "general_meeting") => createProject(env.DB, ward.wardId, {
    kind, title: fixture.nextYearTitle, year: fixture.eventYear, accountId: account.accountId,
  });
  const latest = async (id: string, kind: DocumentKind) => {
    const row = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no, v.scope FROM document_versions v
      JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
      WHERE v.ward_id = ? AND v.project_id = ? AND d.kind = ? ORDER BY v.version_no DESC LIMIT 1`)
      .bind(ward.wardId, id, kind).first<{ document_id: string; version_id: string; version_no: number; scope: string }>();
    if (!row) throw new Error("試しの下書きがありません");
    return { documentId: row.document_id, versionId: row.version_id, versionNo: String(row.version_no), scope: row.scope };
  };
  const source = { kind: "person" as const, accountId: account.accountId };

  // AIがscopeを省いても、議事録は役員だけの文書になり、公開の確認にも送れない。
  for (const kind of ["board_meeting", "general_meeting"] as const) {
    const meeting = await create(kind);
    expect(await saveAIDraft(env.DB, ward.wardId, meeting.projectId, "report", getDraftPack("report", kind).version, {
      text: `${fixture.reportText}\n場所：${fixture.previousPlace}`, items: [
        { key: "content", content: fixture.reportText }, { key: "place", content: fixture.layoutSpot },
      ],
    })).toBe(true);
    const question = (await getProjectState(env.DB, ward.wardId, meeting.projectId))?.questions.find((entry) => entry.kind === "conflict");
    if (!question) throw new Error("試しの議事録の食い違いがありません");
    const answer = await postForm(realApp, `${root}/projects/${meeting.projectId}/questions/${question.questionId}`, { action: "answer", answer: fixture.layoutSpot }, cookie);
    expect(answer.headers.get("location")).toContain("notice=answered");
    const minutes = await getEditableDocument(env.DB, ward.wardId, meeting.projectId, "report");
    expect((JSON.parse(minutes!.body) as DocumentBody).text).toContain(fixture.layoutSpot);
    expect(await getEditableDocument(env.DB, ward.wardId, meeting.projectId, "announcement")).toBeNull();
    const fields = await latest(meeting.projectId, "report");
    expect(fields.scope).toBe("staff");
    expect((await getEditableDocument(env.DB, ward.wardId, meeting.projectId, "report"))?.scope).toBe("staff");
    expect((await postForm(realApp, `${root}/publish/${meeting.projectId}/confirm`, fields, cookie)).status).toBe(404);
  }

  const project = await create("event");
  const id = project.projectId;
  const date = `${fixture.eventYear}年${fixture.publicDayText}`;
  expect(await saveAIDraft(env.DB, ward.wardId, id, "announcement", getDraftPack("announcement").version, {
    text: `日時：${date}\n場所：${fixture.previousPlace}`, items: [
      { key: "date_time", content: date }, { key: "place", content: fixture.layoutSpot },
    ],
  })).toBe(true);
  const state = await getProjectState(env.DB, ward.wardId, id);
  const conflict = state?.questions.find((question) => question.kind === "conflict" && question.target === "place");
  if (!conflict) throw new Error("本文と項目の食い違いが質問にありません");
  expect(conflict.options).toEqual([fixture.previousPlace, fixture.layoutSpot]);
  expect(state?.items.find((item) => item.key === "place")?.current).toBeNull();
  const before = await getEditableDocument(env.DB, ward.wardId, id, "announcement");
  expect(JSON.parse(before!.body).items).toContainEqual({ key: "place", content: fixture.previousPlace });
  expect((await addQuestion(env.DB, ward.wardId, id, { kind: "decide", text: fixture.nextYearTask,
    source, packVersion: "fictional-fifth-review@1", requestId: crypto.randomUUID() })).status).toBe("added");
  const compared = await get(realApp, `${root}/projects/${id}/questions/${conflict.questionId}/compare`, cookie);
  expect(compared.status).toBe(200);
  const comparedHtml = await compared.text();
  expect(comparedHtml).toContain(fixture.previousPlace);
  expect(comparedHtml).toContain(fixture.layoutSpot);
  const answered = await postForm(realApp, `${root}/projects/${id}/questions/${conflict.questionId}`, { action: "answer", answer: fixture.layoutSpot }, cookie);
  expect(answered.status).toBe(303);
  const questions = await (await get(realApp, answered.headers.get("location")!, cookie)).text();
  expect(questions).toContain(fixture.nextYearTask);
  expect(questions).toContain("答えを残しました");
  expect(questions.indexOf("答えを残しました")).toBeGreaterThan(questions.indexOf(fixture.nextYearTask));
  const corrected = await getEditableDocument(env.DB, ward.wardId, id, "announcement");
  const body = JSON.parse(corrected!.body) as DocumentBody;
  expect(body.text).toContain(fixture.layoutSpot);
  expect(body.text).not.toContain(fixture.previousPlace);
  expect(body.items).toContainEqual({ key: "place", content: fixture.layoutSpot });

  const fields = await latest(id, "announcement");
  expect((await postForm(realApp, `${root}/publish/${id}/send`, { ...fields, lineDelivery: "skip" }, cookie)).status).toBe(303);
  const rainPath = `${root}/projects/${id}/draft/notice`;
  const rain = await (await get(realApp, rainPath, cookie)).text();
  expect(rain).toContain('id="place" name="place" value="" maxlength="200" required');
  const emptyRain = await postForm(realApp, `${root}/projects/${id}/draft/rain-notice`, {
    templateId: "rain", eventName: fixture.nextYearTitle, dateTime: date, place: "", lineDelivery: "skip",
  }, cookie);
  expect(emptyRain.headers.get("location")).toContain("error=rain_input");
  expect(await getEditableDocument(env.DB, ward.wardId, id, "notice")).toBeNull();
  expect((await applyChange(env.DB, ward.wardId, id, { kind: "item", itemKey: "rain_plan", value: fixture.layoutPosition,
    source, confidence: "high", packVersion: "fictional-fifth-review@1" })).status).toBe("applied");
  const withPlace = await (await get(realApp, rainPath, cookie)).text();
  expect(withPlace).toContain(`id="place" name="place" value="${fixture.layoutPosition}"`);

  expect((await applyChange(env.DB, ward.wardId, id, { kind: "row", table: "sponsors",
    data: { name: fixture.sponsorName, amount: fixture.sponsorAmount }, source, confidence: "high", packVersion: "fictional-fifth-review@1" })).status).toBe("applied");
  const introduction = `${fixture.reportText}参加する人数は${fixture.sponsorAmount}人です。`;
  expect(await checkPublicDraft(env.DB, ward.wardId, id, "report", { text: introduction })).toHaveLength(0);
  for (const text of [`${fixture.sponsorName}：${fixture.sponsorAmount.toLocaleString("ja-JP")}円`, `${fixture.sponsorAmount}円\n${fixture.sponsorName}`]) {
    expect(await checkPublicDraft(env.DB, ward.wardId, id, "report", { text })).toContain(`協賛の額: ${fixture.sponsorAmount}`);
  }
  expect((await postForm(realApp, `${root}/close/${id}/finalize`, { body: fixture.reportText }, cookie)).status).toBe(303);
  const activityForm = { action: "publish", introduction, membershipBurden: fixture.nextYearTask, membershipBenefit: fixture.nextYearChange };
  const activity = await postForm(realApp, `${root}/close/${id}/activity`, activityForm, cookie);
  expect(activity.headers.get("location")).toContain("activity=published");
  const leaked = await postForm(realApp, `${root}/close/${id}/activity`, { ...activityForm, introduction: `${fixture.sponsorName}：${fixture.sponsorAmount}円` }, cookie);
  expect(leaked.headers.get("location")).toContain("error=activity_private");
  const saved = await env.DB.prepare("SELECT published_body FROM project_activity_pages WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, id).first<{ published_body: string }>();
  expect(JSON.parse(saved!.published_body).introduction).toBe(introduction);

  for (const kind of ["general", "restore"] as const) {
    expect(systemFor(kind)).toContain("参加する住民が持ってくる物だけ");
    expect(systemFor(kind)).toContain("運営の準備物");
    expect(packVersionFor(kind)).toBe(kind === "general" ? "read-general@6" : "read-restore@6");
  }
  expect(getDraftPack("announcement").instruction).toContain("運営の準備物は段取りの仕事や進め方に残し");
});
