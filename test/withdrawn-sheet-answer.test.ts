import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { listAnswers } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { claimRead, finishRead } from "../src/intake/store";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("取り下げた回答票の古い画面からは追加も入れ直しもできず、保存済みの答えは一覧から直せる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: fixture.draftTitle, year: 2026, accountId: account.accountId,
  });
  const received = await receive(env, {
    wardId: ward.wardId, projectId: project.projectId, via: "admin", readKind: "answer_sheet", accountId: account.accountId,
    parts: [{ kind: "photo", filename: fixture.answerSheetFilename, mediaType: "image/jpeg", bytes: new Uint8Array(fixture.answerSheetPhotoBytes) }],
  });
  const original = received.received[0];
  if (!original || !received.jobId) throw new Error("架空の回答票を受け付けられませんでした");
  const attempt = await claimRead(env.DB, ward.wardId, received.jobId, 60_000);
  if (attempt === null) throw new Error("架空の回答票を読み取れませんでした");
  // AIは呼ばず、fixturesの架空の世帯と読み取りを使う。
  expect(await finishRead(env.DB, {
    wardId: ward.wardId, jobId: received.jobId, attempt, source: "model", packVersion: "withdrawn-sheet-test@1", model: "fixture",
    body: { ...fixture.answerSheetReading, rows: [fixture.firstHousehold, fixture.secondHousehold].flatMap((household) =>
      fixture.answerSheetReading.rows.map((row) => ({ ...row, household_name: household, original_id: original.originalId }))) },
  })).toBe(true);
  const answersPath = `/${ward.slug}/admin/answers/${project.projectId}`;
  const rowPath = `${answersPath}/sheet/${original.originalId}/row/0`;
  const newRowPath = `${answersPath}/sheet/${original.originalId}/row/1`;
  const form = { household: fixture.firstHousehold, district: fixture.district, people_count: "3" };

  expect((await postForm(realApp, rowPath, form, cookie)).status).toBe(303);
  expect((await postForm(realApp, rowPath, { ...form, people_count: "4" }, cookie)).status).toBe(303);
  const before = await listAnswers(env.DB, ward.wardId, project.projectId);
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({ household: fixture.firstHousehold, peopleCount: 4 });

  const closePath = `/${ward.slug}/admin/close/${project.projectId}`;
  expect((await postForm(realApp, `${closePath}/finalize`, {}, cookie)).status).toBe(303);
  const closed = await postForm(realApp, rowPath, form, cookie);
  expect(closed.status).toBe(303);
  expect(closed.headers.get("location")).toBe(`${closePath}?error=answers_closed`);
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toEqual(before);
  expect((await postForm(realApp, `${closePath}/reopen`, {}, cookie)).status).toBe(303);

  const opened = await get(realApp, `${answersPath}?view=list`, cookie);
  expect(opened.status).toBe(200);
  const oldPage = await opened.text();
  expect(oldPage).toContain(`action="${rowPath}"`);
  expect(oldPage).toContain(`action="${newRowPath}"`);
  expect((await postForm(realApp, `/${ward.slug}/admin/intake/${received.jobId}/withdraw`, {}, cookie)).status).toBe(303);
  for (const path of [rowPath, newRowPath]) {
    const response = await postForm(realApp, path, { ...form, people_count: "9" }, cookie);
    expect(response.status).toBe(409);
    const html = await response.text();
    expect(html).toContain("この回答票は取り下げられたため、答えを入れられません。");
    expect(html).toContain(`href="${answersPath}?view=list"`);
    expect(html).toContain("答えの一覧に戻る");
    expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toEqual(before);
  }

  const saved = before[0];
  if (!saved) throw new Error("保存済みの答えがありません");
  const editPath = `${answersPath}/${saved.answerId}/edit`;
  expect((await get(realApp, editPath, cookie)).status).toBe(200);
  expect((await postForm(realApp, editPath, { ...form, people_count: "5" }, cookie)).status).toBe(303);
  const corrected = await listAnswers(env.DB, ward.wardId, project.projectId);
  expect(corrected).toHaveLength(1);
  expect(corrected[0]).toMatchObject({ answerId: saved.answerId, peopleCount: 5 });
});
