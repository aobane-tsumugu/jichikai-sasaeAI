import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
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
  expect(asked).toContain("AIから役員への質問が1つあります。答えると報告に入ります。終わりにしたあとは、取り消すまで答えられません。");
  expect(asked).toContain(`href="/${ward.slug}/admin/projects/${project.projectId}/questions">質問に答える</a>`);
});

it("終わりにする画面の来年への一言は、仕事ごとに時期と済んだかを書き、役員だけの欄は「メモ」と呼ぶ", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2026, accountId: account.accountId, eventDay: "2026-01-10" });
  const page = await (await get(realApp, `/${ward.slug}/admin/close/${project.projectId}`, cookie)).text();
  expect(page).toMatch(/<summary>案内を住民に知らせる（.*、これから）<\/summary>/);
  expect(page).toContain("役員だけのメモ（書かなくてかまいません）");
  expect(page).not.toContain("役員だけの記録");
});
