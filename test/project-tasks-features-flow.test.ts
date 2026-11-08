import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { replaceRoster, listAnswers } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { createProject, getProjectState } from "../src/project/api";
import { getEditableDocument, saveDocument } from "../src/project/actions";
import { projectFeatures } from "../src/project/task-features";
import { startTemplate } from "../src/project/start-template";
import { SHORT_TEMPLATE } from "../src/know/year";
import { listSubmittedItems } from "../src/project/followup";
import { saveMeetingAnswer } from "../src/answers/meeting-store";
import { get, postForm, realApp } from "./helpers";

// 全て試しの予定と世帯。AIや外部送信を使わず、実際のフォーム、D1、紙を通す。
it("短い防災訓練に担当と提出を足すと、eventのまま名簿の順と提出の記録を使える", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "防災訓練", year: 2026, eventDay: "2026-10-24", taskKeys: SHORT_TEMPLATE.tasks, accountId: account.accountId,
  });
  const path = `${root}/projects/${project.projectId}`;
  await replaceRoster(env.DB, ward.wardId, [{ household: "試験一郎", district: "一班" }, { household: "試験二郎", district: "二班" }], { household: 0, district: 1 });
  expect(await projectFeatures(env.DB, ward.wardId, project.projectId)).toMatchObject({ rota: false, submit: false });
  for (const name of ["担当を決める", "提出する"]) {
    expect((await postForm(realApp, `${path}/map/add`, { name }, cookie)).status).toBe(303);
  }
  const state = await getProjectState(env.DB, ward.wardId, project.projectId);
  if (!state) throw new Error("試しの防災訓練を作れませんでした");
  expect(state.project.kind).toBe("event");
  expect(await projectFeatures(env.DB, ward.wardId, project.projectId)).toMatchObject({ rota: true, submit: true });
  expect(await projectFeatures(env.DB, other.ward.wardId, project.projectId)).toMatchObject({ rota: false, submit: false });
  for (const [name, target] of [["担当を決める", `${path}/draft/duty_roster`], ["提出する", `${root}/requests/city/${project.projectId}`]]) {
    const task = state.mapTasks.find((entry) => entry.name === name);
    if (!task) throw new Error("足した仕事がありません");
    const response = await get(realApp, `${path}/map/${task.taskId}`, cookie);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`href="${target}"`);
  }
  const rota = await get(realApp, `${path}/draft/duty_roster`, cookie);
  expect(rota.status).toBe(200);
  expect(await rota.text()).toContain("名簿から下書きを作る");
  const prepared = await postForm(realApp, `${path}/draft/duty_roster/start`, {}, cookie);
  expect(prepared.status).toBe(303);
  expect(prepared.headers.get("location")).toContain("notice=saved");
  const duties = (await getProjectState(env.DB, ward.wardId, project.projectId))?.tables.duties.filter((row) => row.scope === "current");
  expect(duties?.map((row) => row.data.assignee)).toEqual(["試験一郎", "試験二郎"]);
  expect((await get(realApp, `${root}/rota/${project.projectId}/result`, cookie)).status).toBe(200);
  expect((await postForm(realApp, `${root}/rota/exemptions`, {
    household: JSON.stringify({ household: "試験二郎", district: "二班" }), reason: "試しの免除理由",
    starts_on: "2026-01-01", ends_on: "2026-12-31",
  }, cookie)).headers.get("location")).toContain("saved=1");
  expect((await postForm(realApp, `${path}/draft/duty_roster/start`, {}, cookie)).headers.get("location")).toContain("notice=saved");
  const refreshed = (await getProjectState(env.DB, ward.wardId, project.projectId))?.tables.duties.filter((row) => row.scope === "current");
  expect(refreshed?.map((row) => row.data.assignee)).toEqual(["試験一郎", ""]);
  const first = refreshed?.[0];
  if (!first) throw new Error("試しの担当の行がありません");
  expect((await postForm(realApp, `${path}/draft/duty-row/${first.rowId}`, {
    slot: String(first.data.slot), task: String(first.data.task), assignee: "試験一郎", attendance: "present",
  }, cookie)).status).toBe(303);
  const history = await get(realApp, `${root}/rota/history`, cookie);
  expect(history.status).toBe(200);
  const historyHtml = await history.text();
  expect(historyHtml).toContain("防災訓練 / 1番目 / 一班");
  expect(historyHtml).toContain("出席の記録あり");
  expect(historyHtml).toContain("試しの免除理由");
  const submission = `${root}/requests/city/${project.projectId}`;
  expect((await get(realApp, submission, cookie)).status).toBe(200);
  expect((await postForm(realApp, submission, { operation: "save", answerDraft: "訓練の予定を提出します。", submittedWhat: "訓練の届け", submittedTo: "試験用の窓口", submittedOn: "2026-10-20", submissionId: crypto.randomUUID() }, cookie)).status).toBe(303);
  expect(await listSubmittedItems(env.DB, ward.wardId, project.projectId)).toEqual([expect.objectContaining({ what: "訓練の届け", body: expect.stringContaining("訓練の予定を提出します。") })]);
  expect((await getProjectState(env.DB, ward.wardId, project.projectId))?.project.kind).toBe("event");
  const assign = state.mapTasks.find((task) => task.name === "担当を決める");
  if (!assign) throw new Error("足した担当の仕事がありません");
  expect((await postForm(realApp, `${path}/map/${assign.taskId}/remove`, {}, cookie)).status).toBe(303);
  expect((await projectFeatures(env.DB, ward.wardId, project.projectId)).rota).toBe(false);
  expect((await get(realApp, `${root}/rota/${project.projectId}/result`, cookie)).status).toBe(404);
});

it("一年の決算と総会の準備から議案、委任、議事録と紙を使える", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const template = startTemplate("決算と総会の準備");
  const project = await createProject(env.DB, ward.wardId, { kind: template.kind, title: "決算と総会の準備", year: 2026, taskKeys: template.taskKeys, accountId: account.accountId });
  const path = `${root}/projects/${project.projectId}`;
  const state = await getProjectState(env.DB, ward.wardId, project.projectId);
  if (!state) throw new Error("試しの総会の準備がありません");
  expect(state.mapTasks.map((task) => task.taskKey)).toEqual(["agenda", "notice", "answers", "day", "minutes"]);
  // 一年の型を使ったあとも、中の種類の値には頼らない。
  await env.DB.prepare("UPDATE projects SET kind = 'event' WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, project.projectId).run();
  for (const [kind, title] of [["procedure", "議案の資料"], ["report", "議事録"]]) {
    const response = await get(realApp, `${path}/draft/${kind}`, cookie);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`${title}の下書きを直す`);
  }
  const answers = `${root}/answers/${project.projectId}`;
  const form = await get(realApp, `${answers}?view=hand`, cookie);
  expect(form.status).toBe(200);
  expect(await form.text()).toContain("委任する");
  expect((await postForm(realApp, `${answers}/phone`, { household: "試験三郎", district: "一班", meeting_status: "proxy", proxy_name: "" }, cookie)).status).toBe(303);
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toEqual([expect.objectContaining({ meetingStatus: "proxy" })]);
  const savedAnswer = (await listAnswers(env.DB, ward.wardId, project.projectId))[0];
  if (!savedAnswer) throw new Error("試しの委任の返事がありません");
  expect((await postForm(realApp, `${answers}/${savedAnswer.answerId}/edit`, {
    household: "試験三郎", district: "一班", meeting_status: "attend", proxy_name: "",
  }, cookie)).status).toBe(303);
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toEqual([expect.objectContaining({ meetingStatus: "attend" })]);
  const current = await getProjectState(env.DB, ward.wardId, project.projectId);
  if (!current) throw new Error("試しの総会の状態がありません");
  expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, { kind: "announcement", title: "総会の招集", scope: "public", body: JSON.stringify({ text: "総会を開きます。", items: [{ key: "place", content: "試験用の集会所" }] }), basedOn: current.project.stateVersion })).toBe(true);
  const announcement = await getEditableDocument(env.DB, ward.wardId, project.projectId, "announcement");
  if (!announcement) throw new Error("試しの招集の下書きがありません");
  const savedState = await getProjectState(env.DB, ward.wardId, project.projectId);
  const versionNo = savedState?.documents.find((document) => document.documentId === announcement.documentId)?.latestVersionNo;
  if (!versionNo) throw new Error("試しの招集の版がありません");
  const preview = await get(realApp, `${root}/print/${project.projectId}/${announcement.documentId}/${versionNo}/preview`, cookie);
  expect(preview.status).toBe(200);
  expect(await preview.text()).toContain("委任状");
});

it("春の清掃の短い型では協賛、実行委員、会場の仕事と入口が出ず、足すと出る", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const template = startTemplate("春の清掃");
  const project = await createProject(env.DB, ward.wardId, { kind: template.kind, title: "春の清掃", year: 2026, taskKeys: template.taskKeys, accountId: account.accountId });
  const path = `${root}/projects/${project.projectId}`;
  const state = await getProjectState(env.DB, ward.wardId, project.projectId);
  expect(state?.mapTasks.map((task) => task.taskKey)).toEqual(["announcement", "day", "report"]);
  const html = await (await get(realApp, `${path}/map`, cookie)).text();
  for (const name of ["会場を押さえる", "協賛をお願いする", "実行委員を決める"]) expect(html).not.toContain(name);
  expect(await (await get(realApp, path, cookie)).text()).not.toContain(`${path}/committee`);
  const sponsors = `${root}/print/${project.projectId}/paper/sponsors`;
  expect((await get(realApp, sponsors, cookie)).status).toBe(404);
  expect(await (await get(realApp, `${root}/print/${project.projectId}`, cookie)).text()).not.toContain(sponsors);
  for (const name of ["会場を押さえる", "協賛をお願いする", "実行委員を決める"]) {
    expect((await postForm(realApp, `${path}/map/add`, { name }, cookie)).status).toBe(303);
  }
  expect(await projectFeatures(env.DB, ward.wardId, project.projectId)).toMatchObject({ sponsors: true, committee: true, venue: true });
  expect((await get(realApp, sponsors, cookie)).status).toBe(200);
  expect(await (await get(realApp, path, cookie)).text()).toContain(`${path}/committee`);
});

it("短い型に委任を集める仕事を足すと使え、外すと委任の返事を書き換えられない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "試しの話し合い", year: 2026, taskKeys: SHORT_TEMPLATE.tasks, accountId: account.accountId,
  });
  const root = `/${ward.slug}/admin`;
  const input = { projectId: project.projectId, household: "試しの丁世帯", district: "一班", peopleCount: 0,
    meetingStatus: "proxy" as const, proxyName: "", source: "phone" as const, accountId: account.accountId };
  expect(await saveMeetingAnswer(env.DB, ward.wardId, input)).toBeNull();
  expect((await postForm(realApp, `${root}/projects/${project.projectId}/map/add`, { name: "委任と出欠を集める" }, cookie)).status).toBe(303);
  expect(await (await get(realApp, `/${ward.slug}/answer/${project.projectId}`)).text()).toContain("委任する");
  expect(await saveMeetingAnswer(env.DB, other.ward.wardId, input)).toBeNull();
  const answerId = await saveMeetingAnswer(env.DB, ward.wardId, input);
  expect(answerId).not.toBeNull();
  if (!answerId) throw new Error("試しの委任を保存できませんでした");
  const task = (await getProjectState(env.DB, ward.wardId, project.projectId))?.mapTasks.find((entry) => entry.name === "委任と出欠を集める");
  if (!task) throw new Error("試しの委任の仕事がありません");
  expect((await postForm(realApp, `${root}/projects/${project.projectId}/map/${task.taskId}/remove`, {}, cookie)).status).toBe(303);
  expect(await saveMeetingAnswer(env.DB, ward.wardId, { ...input, meetingStatus: "absent" }, { answerId })).toBeNull();
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toEqual([expect.objectContaining({ meetingStatus: "proxy" })]);
});
