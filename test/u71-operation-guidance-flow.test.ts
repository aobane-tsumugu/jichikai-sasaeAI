import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { seedAdmin } from "../src/core/testing";
import { getEditableDocument } from "../src/project/actions";
import { createProject, getProjectState } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("長い下書きを残して保存し直し、配ったあとの班長への一枚を開き、短い質問の理由と入力を読める", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: FIRST_SLICE.nextYearTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId,
  });
  const root = `/${ward.slug}/admin`;
  const draftPath = `${root}/projects/${project.projectId}/draft/announcement`;
  const body = FIRST_SLICE.reportText.repeat(2000).slice(0, 20001);
  const fields = {
    title: FIRST_SLICE.nextYearTitle, scope: "public", based_on: String(project.stateVersion),
    text: body, item_place: FIRST_SLICE.previousPlace,
  };
  const failed = await postForm(realApp, `${draftPath}/save`, fields, cookie);
  expect(failed.status).toBe(400);
  const failedHtml = await failed.text();
  expect(failedHtml).toContain("20000文字以内にして、もう一度保存してください。");
  expect(failedHtml).toContain("書いた内容は下に残っています。");
  expect(failedHtml).toContain(body);
  expect(failedHtml).toContain(`name="title" value="${fields.title}"`);
  expect(failedHtml).toContain(`name="item_place" value="${fields.item_place}"`);
  expect(await getEditableDocument(env.DB, ward.wardId, project.projectId, "announcement")).toBeNull();

  const acceptedText = `${FIRST_SLICE.reportText}\n`.repeat(2000).slice(0, 20000);
  const submittedText = acceptedText.replace(/\n/g, "\r\n");
  // ブラウザのフォームが送るCRLFでも、本文欄と同じ文字数で保存する。
  // 送った本文の改行形式も保ち、項目の置き換えの試験と同じ扱いにする。
  expect((await postForm(realApp, `${draftPath}/save`, { ...fields, text: submittedText }, cookie)).status).toBe(303);
  const accepted = await getEditableDocument(env.DB, ward.wardId, project.projectId, "announcement");
  if (!accepted) throw new Error("架空の下書きが保存されていません");
  expect(JSON.parse(accepted.body)).toMatchObject({ text: submittedText, items: [{ key: "place", content: fields.item_place }] });
  expect(accepted.body.length).toBeGreaterThan(20000);
  const editHtml = await (await get(realApp, draftPath, cookie)).text();
  expect(editHtml).toContain('maxlength="20000"');
  expect(editHtml).toContain(submittedText);

  const state = await getProjectState(env.DB, ward.wardId, project.projectId);
  if (!state) throw new Error("架空の行事がありません");
  expect((await postForm(realApp, `${draftPath}/save`, {
    ...fields, text: FIRST_SLICE.publicAnnouncement, based_on: String(state.project.stateVersion),
  }, cookie)).status).toBe(303);
  const latest = await getEditableDocument(env.DB, ward.wardId, project.projectId, "announcement");
  if (!latest?.versionId) throw new Error("配る架空の下書きがありません");
  const sent = await postForm(realApp, `${root}/publish/${project.projectId}/send`, {
    documentId: latest.documentId, versionId: latest.versionId, versionNo: "2", lineDelivery: "skip",
  }, cookie);
  expect(sent.status).toBe(303);
  const location = sent.headers.get("location");
  if (!location) throw new Error("配った結果への入口がありません");
  const sentHtml = await (await get(realApp, location, cookie)).text();
  const leaderPath = sentHtml.match(/href="([^"]+)">班長への一枚を印刷する<\/a>/)?.[1];
  expect(leaderPath).toBe(`${root}/print/${project.projectId}/${latest.documentId}/2/leader`);
  if (!leaderPath) throw new Error("班長への一枚への入口がありません");
  const leader = await get(realApp, leaderPath, cookie);
  expect(leader.status).toBe(200);
  expect(await leader.text()).toContain("実行委員と班長のページを開いてから印刷する");
  expect((await postForm(realApp, `${root}/space/${project.projectId}/open`, { passphrase: FIRST_SLICE.passphrase }, cookie)).status).toBe(200);
  const ready = await (await get(realApp, leaderPath, cookie)).text();
  expect(ready).toContain("班長の専用QRを作って印刷する");
  const paper = await postForm(realApp, leaderPath, {}, cookie);
  expect(paper.status).toBe(200);
  expect(await paper.text()).toContain("<svg");

  const question = FIRST_SLICE.previousPlace.slice(-2);
  const asked = await postForm(realApp, `${root}/archive/ask`, { question }, cookie);
  expect(asked.status).toBe(400);
  const askedHtml = await asked.text();
  expect(askedHtml).toContain("3文字以上300文字以内で書いてください。");
  expect(askedHtml).toContain(`name="question" type="text" value="${question}" minlength="3"`);
});
