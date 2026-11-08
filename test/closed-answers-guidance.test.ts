import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { getAnswerDeadline, listAnswers } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("閉じた返事の画面では受付をせず、開き直してから電話の返事を入れられる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "試しの答えの確認", year: 2026, accountId: account.accountId,
  });
  const root = `/${ward.slug}/admin`;
  const path = `${root}/answers/${project.projectId}`;
  const phone = { household: "試しの世帯", district: "試しの班", people_count: "2" };
  expect((await postForm(realApp, `${path}/phone`, phone, cookie)).status).toBe(303);
  expect((await postForm(realApp, `${path}/deadline`, { due_on: "2026-10-10" }, cookie)).status).toBe(303);
  expect((await postForm(realApp, `${root}/close/${project.projectId}/finalize`, {}, cookie)).status).toBe(303);

  const stalePhone = await postForm(realApp, `${path}/phone`, phone, cookie);
  expect(stalePhone.status).toBe(303);
  const photo = new FormData();
  photo.append("part", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1])], "試しの回答票.jpg", { type: "image/jpeg" }));
  const staleSheet = await realApp.request(`${path}/sheet`, {
    method: "POST", headers: { cookie, origin: "http://localhost" }, body: photo,
  }, env);
  const staleDeadline = await postForm(realApp, `${path}/deadline`, { due_on: "2027-10-10" }, cookie);
  for (const response of [stalePhone, staleSheet, staleDeadline]) {
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain(`${root}/close/${project.projectId}?error=`);
  }
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toHaveLength(1);
  expect(await getAnswerDeadline(env.DB, ward.wardId, project.projectId)).toBe("2026-10-10");
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, project.projectId).first()).toEqual({ count: 0 });
  const html = await (await get(realApp, `${path}?view=list`, cookie)).text();
  expect(html).toContain("試しの世帯");
  expect(html).toContain("2人");
  expect(html).toContain("終わりにした画面で、終わりを取り消してください");
  expect(html).not.toContain('name="children_count"');
  expect(html).not.toContain('name="part"');
  expect(html).not.toContain('name="due_on"');

  expect((await postForm(realApp, `${root}/close/${project.projectId}/reopen`, {}, cookie)).status).toBe(303);
  expect(await (await get(realApp, `${path}?view=hand`, cookie)).text()).toContain('name="children_count"');
  expect((await postForm(realApp, `${path}/phone`, { ...phone, household: "試しの別の世帯", people_count: "3" }, cookie)).status).toBe(303);
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toHaveLength(2);
});

it("返事の画面で、終わったものの開き直しと訂正をやめるリンクに押せる高さのclassを使う", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: FIRST_SLICE.nextYearTitle, year: FIRST_SLICE.nextYear, accountId: account.accountId,
  });
  const root = `/${ward.slug}/admin`;
  const path = `${root}/answers/${project.projectId}`;
  const closePath = `${root}/close/${project.projectId}`;
  expect((await postForm(realApp, `${path}/phone`, {
    household: FIRST_SLICE.firstHousehold, district: FIRST_SLICE.district, people_count: "2",
  }, cookie)).status).toBe(303);
  const answer = (await listAnswers(env.DB, ward.wardId, project.projectId))[0];
  if (!answer) throw new Error("訂正する答えがありません。");
  const editPath = `${path}/${answer.answerId}/edit`;
  const openPage = await get(realApp, path, cookie);
  expect(openPage.status).toBe(200);
  expect(await openPage.text()).not.toContain("終わりにした画面で、終わりを取り消してください");
  const editPage = await get(realApp, editPath, cookie);
  expect(editPage.status).toBe(200);
  expect(await editPage.text()).toContain(`<p class="link-line"><a href="${path}?view=list">保存せずに戻る</a></p>`);

  expect((await postForm(realApp, `${closePath}/finalize`, {}, cookie)).status).toBe(303);
  for (const query of ["", "?view=unanswered", "?view=list", "?view=read"]) {
    const response = await get(realApp, `${path}${query}`, cookie);
    expect(response.status).toBe(200);
    // 文の途中でなく、一行の押しやすいリンクで置く
    expect(await response.text()).toContain(`<p class="link-line"><a href="${closePath}">終わりにした画面を開く</a></p>`);
  }
  const closedEdit = await get(realApp, editPath, cookie);
  expect(closedEdit.status).toBe(200);
  const closedHtml = await closedEdit.text();
  expect(closedHtml).toContain(`<a class="button" href="${closePath}">終わりを取り消す画面へ</a>`);
  expect(closedHtml).not.toContain("保存せずに戻る");
});
