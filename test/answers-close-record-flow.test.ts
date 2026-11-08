import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { listAnswers, replaceRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { createProject, getProjectState } from "../src/project/api";
import { saveDocument } from "../src/project/actions";
import { setSetting } from "../src/settings/store";
import { get, postForm, realApp } from "./helpers";

it("資料なしで答えを入れ、一度で閉じ、紹介と記録から翌年を始めて仕事なしでも閉じられる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: fixture.nextYearTitle, year: fixture.eventYear, accountId: account.accountId,
  });
  await setSetting(env.DB, ward.wardId, "squads", JSON.stringify([fixture.district]), account.accountId);
  const root = `/${ward.slug}/admin`;
  const answers = `${root}/answers/${project.projectId}`;
  const close = `${root}/close/${project.projectId}`;
  const record = `${root}/archive/${project.projectId}`;
  const read = async (path: string) => {
    const response = await get(realApp, path, cookie);
    expect(response.status).toBe(200);
    return response.text();
  };
  expect((await getProjectState(env.DB, ward.wardId, project.projectId))?.questions).toHaveLength(0);
  expect(await read(answers)).toContain("まだ返事はありません");
  expect(await read(`${answers}?view=list`)).toContain("返事はまだありません");
  expect(await read(`${answers}?view=helpers`)).toContain("まだ申し込みはありません");
  const send = await read(`${answers}?view=send`);
  expect(send).toContain(`action="${answers}/sheet"`);
  expect(send).toContain('name="part"');
  expect(send).not.toContain("<script");
  expect(await read(`${answers}?view=hand`)).toContain('name="seniors_count"');
  const entered = await postForm(realApp, `${answers}/phone`, {
    household: fixture.firstHousehold, district: fixture.district, children_count: "1", adults_count: "2", seniors_count: "0",
    helper_name: fixture.phoneHelper, helper_times: fixture.helperTime,
  }, cookie);
  expect(entered.status).toBe(303);
  const enteredPage = await read(entered.headers.get("location")!);
  expect(enteredPage).toContain("入れました。数に入りました");
  expect(enteredPage).toContain("続けて入れる");
  expect(enteredPage).toContain("返事の一覧で直す");
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toMatchObject([{ peopleCount: 3 }]);
  // 文書の題に行事名が入っていなくても、行事の記録としてたどれる。
  expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
    kind: "announcement", title: "案内", scope: "public", basedOn: 0,
    body: JSON.stringify({ text: fixture.publicAnnouncement, items: [] }),
  })).toBe(true);
  const announcement = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM document_versions v
    JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
    WHERE v.ward_id = ? AND v.project_id = ? AND d.kind = 'announcement' ORDER BY v.version_no DESC LIMIT 1`)
    .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!announcement) throw new Error("配る案内がありません。");
  expect((await postForm(realApp, `${root}/publish/${project.projectId}/send`, {
    documentId: announcement.document_id, versionId: announcement.version_id, versionNo: String(announcement.version_no), lineDelivery: "skip",
  }, cookie)).status).toBe(303);
  const deadline = await postForm(realApp, `${answers}/deadline`, { due_on: fixture.eventDay }, cookie);
  expect(await read(deadline.headers.get("location")!)).toContain("変えました。案内の文は変わりません");
  expect(await env.DB.prepare(`SELECT v.body FROM documents d JOIN document_versions v
    ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = 'announcement'`)
    .bind(ward.wardId, project.projectId).first("body")).toContain(fixture.publicAnnouncement);
  await replaceRoster(env.DB, ward.wardId, [{ household: fixture.firstHousehold, district: fixture.district }], { household: 0, district: 1 });
  expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
    kind: "report", title: "実施報告", scope: "public", basedOn: 0,
    body: JSON.stringify({ text: fixture.firstHousehold, items: [] }),
  })).toBe(true);
  const closing = await read(close);
  expect(closing).toContain("報告の中に見つかったもの");
  expect(closing).toContain(`名簿の名前: ${fixture.firstHousehold}`);
  expect(closing).toContain("このまま終わりにすることもできます");
  // 手伝いだけの申し込みが無いので、消えるものの警告は出さない
  expect(closing).not.toContain("終わりにすると消えるものがあります");
  expect(closing).not.toContain("<svg");
  const task = (await getProjectState(env.DB, ward.wardId, project.projectId))?.mapTasks.find((entry) => entry.taskKey === "venue");
  if (!task) throw new Error("記録を残す仕事がありません。");
  const form = new FormData();
  form.append("body", fixture.firstHousehold);
  form.append("body", fixture.nextYearChange);
  form.append("taskId", task.taskId);
  form.append("requestedBy", fixture.requestedBy);
  form.append("difficulty", fixture.nextYearDifficulty);
  form.append("nextYear", fixture.nextYearChange);
  const closed = await realApp.request(`${close}/finalize`, {
    method: "POST", headers: { cookie, origin: "http://localhost" }, body: form,
  }, env);
  expect(closed.status).toBe(303);
  expect(await read(closed.headers.get("location")!)).toContain("を終わりにしました");
  const publicPage = await read(`/${ward.slug}/p/${project.projectId}`);
  expect(publicPage).toContain(fixture.firstHousehold);
  expect(publicPage).not.toContain(fixture.nextYearChange);
  const savedRecord = await read(record);
  for (const value of [fixture.firstHousehold, fixture.requestedBy, fixture.nextYearDifficulty, fixture.nextYearChange]) expect(savedRecord).toContain(value);
  expect(savedRecord).toContain("<summary>案内</summary>");
  expect(savedRecord.indexOf("これをもとに今年の")).toBeLessThan(savedRecord.indexOf("年の動き</h2>"));
  expect(savedRecord.indexOf("これをもとに今年の")).toBeGreaterThan(0);
  const published = await postForm(realApp, `${close}/activity`, {
    action: "publish", introduction: fixture.reportText, membershipBurden: fixture.requestedBy, membershipBenefit: fixture.nextYearChange,
  }, cookie);
  expect(published.status).toBe(303);
  expect(await read(published.headers.get("location")!)).toContain("住民向けのページで見る");
  const seedPage = await read(`${record}?view=seed`);
  const eventDayInput = seedPage.match(/<input\b[^>]*\bname="eventDay"[^>]*>/)?.[0];
  expect(eventDayInput).toBeDefined();
  expect(eventDayInput).toContain('type="date"');
  expect(eventDayInput).not.toMatch(/\srequired(?:\s|=|\/?>)/);
  const started = await postForm(realApp, `${record}/seed`, {
    title: fixture.nextYearTitle, year: String(fixture.nextYear), eventDay: fixture.eventDay,
  }, cookie);
  expect(started.status).toBe(303);
  expect(await read(started.headers.get("location")!)).toContain("去年のやることを新しい日に置き直しました");
  const nextId = new URL(started.headers.get("location")!, "http://localhost").searchParams.get("started");
  if (!nextId) throw new Error("新しく始めた行事がありません。");
  await env.DB.prepare("UPDATE project_map_tasks SET removed_at = ? WHERE ward_id = ? AND project_id = ?")
    .bind(new Date().toISOString(), ward.wardId, nextId).run();
  const nextClose = `${root}/close/${nextId}`;
  expect(await read(nextClose)).toContain("報告だけでも終わりにできます");
  const introduction = await read(`${nextClose}?view=activity`);
  expect(introduction).toContain(fixture.requestedBy);
  expect(introduction).toContain(fixture.nextYearChange);
  expect(introduction).not.toContain('type="checkbox"');
  expect((await postForm(realApp, `${nextClose}/finalize`, { body: fixture.reportText }, cookie)).status).toBe(303);
  expect(await read(`${root}/archive/${nextId}`)).toContain("残っている仕事はありません");
  const reopened = await postForm(realApp, `${nextClose}/reopen`, {}, cookie);
  expect(await read(reopened.headers.get("location")!)).toContain("終わりを取り消しました");
});
