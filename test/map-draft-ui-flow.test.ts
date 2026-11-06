import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { addQuestion, applyChange, createProject, getProjectState } from "../src/project/api";
import { getEditableDocument } from "../src/project/actions";
import { get, postForm, realApp } from "./helpers";

it("資料のない一年目から仕事・質問・下書き・別の雨の知らせへ進み、外した仕事を戻せる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: FIRST_SLICE.nextYearTitle, year: FIRST_SLICE.nextYear,
    eventDay: FIRST_SLICE.eventDay, accountId: account.accountId,
  });
  const root = `/${ward.slug}/admin`;
  const path = `${root}/projects/${project.projectId}`;
  const state = async () => {
    const current = await getProjectState(env.DB, ward.wardId, project.projectId);
    if (!current) throw new Error("段取りがありません");
    return current;
  };
  const empty = await (await get(realApp, `${path}/map`, cookie)).text();
  expect(empty).toContain("ふつうの8つの仕事の段取りを用意しました");
  expect(empty).toContain('class="map-list"');
  expect(empty).not.toContain('<svg viewBox=');
  expect(empty).not.toContain("雨の変更を知らせる");
  expect(await (await get(realApp, `${path}/questions`, cookie)).text()).toContain("質問はありません");
  const announcementTask = (await state()).mapTasks.find((task) => task.taskKey === "announcement");
  if (!announcementTask) throw new Error("案内の仕事がありません");
  const taskPath = `${path}/map/${announcementTask.taskId}`;
  const taskHtml = await (await get(realApp, taskPath, cookie)).text();
  expect(taskHtml).toContain(`class="button" href="${path}/draft/announcement"`);
  expect(taskHtml).toContain("時期や担当を直す");
  expect((await postForm(realApp, `${taskPath}/remove`, {}, cookie)).status).toBe(303);
  expect(await (await get(realApp, `${path}/map`, cookie)).text()).toContain("この仕事を戻す");
  expect((await postForm(realApp, `${taskPath}/restore`, {}, cookie)).status).toBe(303);
  expect((await state()).mapTasks.some((task) => task.taskId === announcementTask.taskId)).toBe(true);

  const received = await receive(env, {
    wardId: ward.wardId, projectId: project.projectId, via: "admin", accountId: account.accountId,
    parts: [{ kind: "text", filename: FIRST_SLICE.dutyTitle, mediaType: "text/plain", bytes: new TextEncoder().encode(FIRST_SLICE.previousMaterial) }],
  });
  const original = received.received[0];
  if (!original) throw new Error("元の資料がありません");
  expect((await applyChange(env.DB, ward.wardId, project.projectId, {
    kind: "item", itemKey: "place", value: FIRST_SLICE.previousPlace,
    source: { kind: "original", ref: original.originalId, year: FIRST_SLICE.sourceYear, locator: FIRST_SLICE.previousLocator },
    confidence: "high", packVersion: "ui-flow@1",
  })).status).toBe("applied");
  const question = await addQuestion(env.DB, ward.wardId, project.projectId, {
    kind: "decide", target: "place", text: "場所はどこですか", packVersion: "ui-flow@1",
    source: { kind: "original", ref: original.originalId, locator: FIRST_SLICE.previousLocator },
  });
  if (question.status !== "added") throw new Error("質問を作れません");
  expect(await (await get(realApp, `${path}/map`, cookie)).text()).toContain("質問に答える");
  expect(await (await get(realApp, `${path}/questions`, cookie)).text()).toContain(`/intake/originals/${original.originalId}`);
  expect((await postForm(realApp, `${path}/draft/announcement/save`, {
    title: "案内", scope: "public", based_on: String((await state()).project.stateVersion),
    text: FIRST_SLICE.publicAnnouncement, item_place: FIRST_SLICE.previousPlace,
  }, cookie)).status).toBe(303);
  const answered = await postForm(realApp, `${path}/questions/${question.questionId}`, { action: "answer", answer: FIRST_SLICE.layoutPosition }, cookie);
  expect(answered.status).toBe(303);
  const answerHtml = await (await get(realApp, answered.headers.get("location")!, cookie)).text();
  expect(answerHtml).toContain("下書きに入りました");
  expect(answerHtml).toContain("案内の下書きを見る");
  expect((await getEditableDocument(env.DB, ward.wardId, project.projectId, "announcement"))?.body).toContain(FIRST_SLICE.layoutPosition);

  const draft = await (await get(realApp, `${path}/draft/announcement`, cookie)).text();
  expect(draft).toContain('name="title" value="案内"');
  expect(draft).toContain(`value="${FIRST_SLICE.layoutPosition}"`);
  expect(draft).toContain("保存して配る内容を見る");
  const fields = { title: "案内", scope: "public", based_on: String((await state()).project.stateVersion), text: FIRST_SLICE.publicAnnouncement, item_place: FIRST_SLICE.layoutPosition };
  expect((await postForm(realApp, `${path}/draft/announcement/save`, fields, cookie)).status).toBe(303);
  const saved = await (await get(realApp, `${path}/draft/announcement?notice=saved`, cookie)).text();
  expect(saved).toContain("保存しました。まだ配っていません");
  expect(saved).toContain("前の下書きに戻す");
  const confirmed = await postForm(realApp, `${path}/draft/announcement/save`, { ...fields, after: "confirm" }, cookie);
  expect(confirmed.status).toBe(200);
  const confirmHtml = await confirmed.text();
  const value = (name: string) => {
    const found = new RegExp(`name="${name}" value="([^"]*)"`).exec(confirmHtml)?.[1];
    if (!found) throw new Error(`配る内容の${name}がありません`);
    return found.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  };
  const beforeRain = await getEditableDocument(env.DB, ward.wardId, project.projectId, "announcement");
  expect((await postForm(realApp, `${root}/publish/${project.projectId}/send`, {
    documentId: value("documentId"), versionId: value("versionId"), versionNo: value("versionNo"),
    distribution: value("distribution"), lineDelivery: "skip",
  }, cookie)).status).toBe(303);
  const afterMap = await (await get(realApp, `${path}/map?changed=${announcementTask.taskId}`, cookie)).text();
  expect(afterMap).toContain("いま済みにしました");
  expect(afterMap).toContain("雨の変更を知らせる");
  const rain = await postForm(realApp, `${path}/draft/rain-notice`, {
    templateId: "rain", eventName: project.title, place: FIRST_SLICE.layoutPosition, dateTime: FIRST_SLICE.publicDayText,
  }, cookie);
  expect(rain.status).toBe(303);
  expect(rain.headers.get("location")).toContain("/draft/rain-sent?done=");
  expect(await (await get(realApp, rain.headers.get("location")!, cookie)).text()).toContain("班長に電話し、掲示の紙を張り替えてください");
  expect((await getEditableDocument(env.DB, ward.wardId, project.projectId, "announcement"))?.body).toBe(beforeRain?.body);
  expect((await getEditableDocument(env.DB, ward.wardId, project.projectId, "notice"))?.title).toBe("雨天の変更のお知らせ");

  for (const task of (await state()).mapTasks) expect((await postForm(realApp, `${path}/map/${task.taskId}/remove`, {}, cookie)).status).toBe(303);
  const noTasks = await (await get(realApp, `${path}/map`, cookie)).text();
  expect(noTasks).toContain("仕事はまだありません");
  expect(noTasks).toContain("報告を書いて閉じる");
});
