import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { getAnswerTotals, listAnswers } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { getDraftPack } from "../src/draft/packs";
import { receive } from "../src/intake/receive";
import { createLineIntakePorts } from "../src/line/intake";
import { addDays } from "../src/map/template";
import { getEditableDocument, saveAIDraft, saveDocument, setMapTask } from "../src/project/actions";
import { createProject, getProjectState, type DocumentKind } from "../src/project/api";
import type { DocumentBody } from "../src/project/document-body";
import { recordLineInquiry } from "../src/project/followup";
import { DEFAULT_ANSWER_LABELS } from "../src/settings/answer-labels";
import { get, postForm, realApp } from "./helpers";

it("空の下書きを項目から整え、行事の日を直し、名簿なしのLINEの答えと雨の知らせを記録する", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: fixture.nextYearTitle, year: fixture.eventYear, accountId: account.accountId,
  });
  const id = project.projectId;
  const root = `/${ward.slug}/admin`;
  const draftPath = `${root}/projects/${id}/draft/announcement`;
  const mapPath = `${root}/projects/${id}/map`;
  const read = async (path: string) => {
    const response = await get(realApp, path, cookie);
    expect(response.status).toBe(200);
    return (await response.text()).replace(/\r\n/g, "\n");
  };
  const state = async () => {
    const value = await getProjectState(env.DB, ward.wardId, id);
    if (!value) throw new Error("架空の行事がありません");
    return value;
  };
  const publish = async (kind: DocumentKind) => {
    const row = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM documents d
      JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
      WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = ? ORDER BY v.version_no DESC LIMIT 1`)
      .bind(ward.wardId, id, kind).first<{ document_id: string; version_id: string; version_no: number }>();
    if (!row) throw new Error("架空の文書がありません");
    expect((await postForm(realApp, `${root}/publish/${id}/send`, {
      documentId: row.document_id, versionId: row.version_id, versionNo: String(row.version_no), lineDelivery: "skip",
    }, cookie)).status).toBe(303);
    return row;
  };

  await recordLineInquiry(env.DB, ward.wardId, {
    eventId: crypto.randomUUID(), receivedAt: new Date().toISOString(), text: fixture.nextYearChange,
    sourceType: "user", sourceId: fixture.firstHousehold, senderLabel: fixture.firstHousehold,
  });
  const home = await read(`${root}/`);
  expect(home).toContain("公式LINEに届いた写真と文 1件");
  expect(home).toContain("問い合わせが1つあります");
  expect(home).not.toContain("まだ届いていません");

  const date = `${fixture.eventYear}年${fixture.publicDayText}`;
  const text = `${fixture.draftText}\n日時：（確認中）\n■ 日時\n（確認中）\n■ 場所\n（確認中）\n雨天時：（確認中）`;
  expect(await saveAIDraft(env.DB, ward.wardId, id, "announcement", getDraftPack("announcement").version, {
    text, title: "案内", items: [{ key: "date_time", content: "" }, { key: "place", content: "" }, { key: "rain_plan", content: "" }],
  })).toBe(true);
  const saved = await postForm(realApp, `${draftPath}/save`, {
    title: "案内", scope: "public", based_on: String((await state()).project.stateVersion), text: text.replace(/\n/g, "\r\n"),
    item_date_time: date, item_place: fixture.previousPlace, item_rain_plan: fixture.layoutSpot,
  }, cookie);
  expect(saved.status).toBe(303);
  expect(await read(saved.headers.get("location")!)).not.toContain("本文の日時のところも確かめてください");
  const document = await getEditableDocument(env.DB, ward.wardId, id, "announcement");
  if (!document) throw new Error("保存した案内がありません");
  const body = JSON.parse(document.body) as DocumentBody;
  expect(body.text).toContain(`日時：${date}`);
  expect(body.text).toContain(`■ 日時\r\n${date}`);
  expect(body.text).toContain(`■ 場所\r\n${fixture.previousPlace}`);
  expect(body.text).toContain(`雨天時：${fixture.layoutSpot}`);
  expect(body.text).not.toContain("（確認中）");
  const renderedText = body.text.replace(/\r\n/g, "\n");
  const announcement = await publish("announcement");
  // 配ると人数の聞き方も保存される。本文と項目は保存した内容を保つ。
  const publishedDocument = await getEditableDocument(env.DB, ward.wardId, id, "announcement");
  if (!publishedDocument) throw new Error("配った案内がありません");
  expect(JSON.parse(publishedDocument.body)).toEqual({ ...body, answerLabels: DEFAULT_ANSWER_LABELS });
  const paperPath = `${root}/print/${id}/${announcement.document_id}/${announcement.version_no}/announcement`;
  expect(await read(paperPath)).toContain(renderedText);
  expect(await read(`/${ward.slug}/p/${id}`)).toContain("<dt>どこで</dt>");

  const tasks = (await state()).mapTasks;
  const done = tasks.find((task) => task.taskKey === "committee");
  const manual = tasks.find((task) => task.taskKey === "venue");
  if (!done || !manual) throw new Error("架空の段取りがありません");
  expect(await setMapTask(env.DB, ward.wardId, id, done.taskId, {
    name: done.name, start: fixture.eventDay, end: fixture.eventDay, progress: "done", seatId: null,
  })).toBe(true);
  expect(await read(mapPath)).toContain('name="event_day" type="date"');
  const firstDay = await postForm(realApp, `${mapPath}/event-day`, { event_day: fixture.eventDay }, cookie);
  expect(firstDay.status).toBe(303);
  expect(await read(firstDay.headers.get("location")!)).toContain("行事の日を変えました。済んでいない仕事の時期を置き直しました。案内の文は変わりません");
  expect((await state()).mapTasks.find((task) => task.taskId === manual.taskId)?.periodStart).toBe(addDays(fixture.eventDay, -70));
  expect(await setMapTask(env.DB, ward.wardId, id, manual.taskId, {
    name: manual.name, start: addDays(fixture.eventDay, -12), end: addDays(fixture.eventDay, -10), progress: "started", seatId: null,
  })).toBe(true);
  const beforeShift = await state();
  const movedDay = addDays(fixture.eventDay, 7);
  expect((await postForm(realApp, `${mapPath}/event-day`, { event_day: movedDay }, cookie)).status).toBe(303);
  const shifted = await state();
  expect(shifted.project.deadlines.event_day).toBe(movedDay);
  for (const before of beforeShift.mapTasks) {
    const after = shifted.mapTasks.find((task) => task.taskId === before.taskId);
    const days = before.progress === "done" ? 0 : 7;
    expect(after?.periodStart).toBe(before.periodStart ? addDays(before.periodStart, days) : null);
    expect(after?.periodEnd).toBe(before.periodEnd ? addDays(before.periodEnd, days) : null);
  }
  expect((await postForm(realApp, `${mapPath}/event-day`, { event_day: fixture.eventDay }, cookie)).status).toBe(303);
  expect((await state()).mapTasks).toEqual(beforeShift.mapTasks);
  expect((await getEditableDocument(env.DB, ward.wardId, id, "announcement"))?.body).toBe(publishedDocument.body);

  // 役員が手で書き、本文を自動で直せない場合も保存を止めない。
  const differentText = `${fixture.draftText}\n日時：10/24（土）`;
  expect(await saveDocument(env.DB, ward.wardId, id, account.accountId, {
    kind: "announcement", title: "案内", scope: "public", basedOn: (await state()).project.stateVersion,
    body: JSON.stringify({ text: differentText, items: [{ key: "date_time", content: date }] }),
  })).toBe(true);
  const changeDate = async (value: string, after = "") => postForm(realApp, `${draftPath}/save`, {
    title: "案内", scope: "public", based_on: String((await state()).project.stateVersion), text: differentText,
    item_date_time: value, after,
  }, cookie);
  const mismatch = await changeDate(fixture.eventDay);
  expect(mismatch.status).toBe(303);
  expect(await read(mismatch.headers.get("location")!)).toContain("本文の日時のところも確かめてください");
  const confirm = await changeDate(movedDay, "confirm");
  expect(confirm.status).toBe(200);
  expect(await confirm.text()).toContain("本文の日時のところも確かめてください");
  expect(await read(paperPath)).toContain(renderedText);

  const ports = createLineIntakePorts(env, { waitUntil: () => undefined });
  for (const reply of [`${fixture.firstHousehold}です。大人2人です。`, `${fixture.secondHousehold}家は大人3人です。`, "大人1人です。", `${fixture.phoneHousehold}です。人数はあとで知らせます。`]) {
    const received = await receive(env, {
      wardId: ward.wardId, projectId: id, via: "line_direct",
      parts: [{ kind: "text", filename: "", mediaType: "text/plain", bytes: new TextEncoder().encode(reply) }],
    });
    if (!received.jobId || !ports.saveAnswerReply) throw new Error("架空のLINEの答えを受け付けられません");
    await ports.saveAnswerReply(ward.wardId, id, {
      eventId: crypto.randomUUID(), senderId: fixture.firstHousehold, sourceType: "user", receivedAt: new Date().toISOString(), kind: "text", text: reply,
    }, received.jobId);
  }
  const answers = await listAnswers(env.DB, ward.wardId, id);
  expect(answers).toHaveLength(3);
  expect(answers).toEqual(expect.arrayContaining([
    expect.objectContaining({ household: fixture.firstHousehold, district: "", peopleCount: 2 }),
    expect.objectContaining({ household: fixture.secondHousehold, district: "", peopleCount: 3 }),
    expect.objectContaining({ household: "名前の分からない答え", district: "", peopleCount: 1 }),
  ]));
  expect((await getAnswerTotals(env.DB, ward.wardId, id)).people).toBe(6);

  expect(await saveDocument(env.DB, ward.wardId, id, account.accountId, {
    kind: "notice", title: "知らせ", scope: "public", basedOn: (await state()).project.stateVersion,
    body: JSON.stringify({ text: fixture.rainAnnouncement, items: [{ key: "place", content: fixture.layoutSpot }] }),
  })).toBe(true);
  await env.DB.prepare("UPDATE publication_records SET published_at = ? WHERE ward_id = ? AND project_id = ? AND document_id = ?")
    .bind(`${fixture.eventYear}-01-01T00:00:00.000Z`, ward.wardId, id, announcement.document_id).run();
  await publish("notice");
  expect((await postForm(realApp, `${root}/answers/${id}/deadline`, { due_on: fixture.eventDay }, cookie)).status).toBe(303);
  const publicHtml = await read(`/${ward.slug}/p/${id}`);
  expect(publicHtml).not.toContain("<dt>どこで</dt>");
  expect(publicHtml).not.toContain("<dt>いつ</dt>");
  expect(publicHtml).toContain("出欠を答える");
  expect(publicHtml).toContain("答えの締切");
  expect(publicHtml.indexOf(fixture.rainAnnouncement)).toBeLessThan(publicHtml.indexOf(renderedText));
  expect(publicHtml).toContain(renderedText);
  expect(await read(`/${ward.slug}/`)).toContain(`${fixture.nextYearTitle} 知らせ`);
  expect((await postForm(realApp, `${root}/close/${id}/finalize`, { body: fixture.reportText }, cookie)).status).toBe(303);
  const record = await read(`${root}/archive/${id}`);
  expect(record).toContain("参加すると答えた");
  expect(record).not.toContain("参加した");
  expect(await read(`/${ward.slug}/`)).toContain(`${fixture.nextYearTitle} 実施報告`);
  expect(getDraftPack("report").instruction).toContain("参加すると答えた人数");
});
