import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { answerQuestion } from "../src/project/actions";
import { addQuestion, createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("当日が済んでから終わりにする画面を開くと、報告の下書きを押さなくても頼み、AIの質問を終わりにする前に見せる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2026, accountId: account.accountId, eventDay: "2026-01-10" });
  const path = `/${ward.slug}/admin/close/${project.projectId}`;
  const first = await (await get(realApp, path, cookie)).text();
  expect(first).toContain("集まった資料と返事から、報告の下書きを作り始めました。");
  expect(first).not.toContain("報告の下書きをAIに頼む");
  const jobs = await env.DB.prepare("SELECT task FROM jobs WHERE ward_id = ? AND project_id = ? AND task = 'report'").bind(ward.wardId, project.projectId).all();
  expect(jobs.results).toHaveLength(1);
  // 二度目に開いても、二つ目は頼まない
  await get(realApp, path, cookie);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE ward_id = ? AND project_id = ? AND task = 'report'").bind(ward.wardId, project.projectId).first<{ n: number }>())?.n).toBe(1);

  await addQuestion(env.DB, ward.wardId, project.projectId, { kind: "decide", text: "当日に来た人数は何人でしたか。", packVersion: "test@1" });
  const asked = await (await get(realApp, path, cookie)).text();
  expect(asked).toContain("AIから役員への質問が1つあります。答えてこの画面に戻ると、答えを入れて報告と来年への一言の下書きを作り直します。終わりにしたあとは、取り消すまで答えられません。");
  expect(asked).toContain(`href="/${ward.slug}/admin/projects/${project.projectId}/questions">質問に答える</a>`);
});

it("下書きを作ったあとに質問に答えて終わりにする画面に戻ると、答えを入れて報告と来年への一言の下書きを作り直す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2026, accountId: account.accountId, eventDay: "2026-01-10" });
  const path = `/${ward.slug}/admin/close/${project.projectId}`;
  await get(realApp, path, cookie);
  // 下書きは済んだものとし、頼んだ時刻を答えより前にする。
  await env.DB.prepare("UPDATE jobs SET status = 'done', created_at = '2026-01-11T00:00:00.000Z' WHERE ward_id = ? AND project_id = ?").bind(ward.wardId, project.projectId).run();
  const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE ward_id = ? AND project_id = ? AND task IN ('report', 'map_draft')").bind(ward.wardId, project.projectId).first<{ n: number }>())?.n;
  const before = await count();
  // 答えていない間は作り直さない。
  await get(realApp, path, cookie);
  expect(await count()).toBe(before);
  const asked = await addQuestion(env.DB, ward.wardId, project.projectId, { kind: "decide", text: "当日の受付はだれに頼みましたか。", packVersion: "test@1" });
  if (!("questionId" in asked)) throw new Error("質問を足せませんでした");
  expect(await answerQuestion(env.DB, ward.wardId, project.projectId, asked.questionId, "answer", "3班の班長に頼みました。", account.accountId)).toBe(true);
  const page = await (await get(realApp, path, cookie)).text();
  expect(page).toContain("答えた質問を入れて、報告と来年への一言の下書きを作り直し始めました。");
  expect(await count()).toBe((before ?? 0) + 2);
  // 作り直している間に開き直しても、もう一度は頼まない。
  await get(realApp, path, cookie);
  expect(await count()).toBe((before ?? 0) + 2);
});

it("終わりにする画面の来年への一言は、仕事ごとに時期と済んだかを書き、役員だけの欄は「メモ」と呼ぶ", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2026, accountId: account.accountId, eventDay: "2026-01-10" });
  const page = await (await get(realApp, `/${ward.slug}/admin/close/${project.projectId}`, cookie)).text();
  expect(page).toMatch(/<summary>案内を住民に知らせる（.*、これから）<\/summary>/);
  expect(page).toContain("役員だけのメモ（書かなくてかまいません）");
  expect(page).not.toContain("役員だけの記録");
});
