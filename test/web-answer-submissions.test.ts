import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { getAnswerTotals, listAnswers } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

const input = { attend: "yes", household: "送信確認世帯", district: "", children_count: "", adults_count: "2", seniors_count: "" };
function number(html: string): string {
  const value = /name="submission_id" value="([^"]+)"/.exec(html)?.[1];
  if (!value) throw new Error("返事の画面に送信番号がありません。");
  return value;
}
async function fixture() {
  const admin = await seedAdmin(env.DB);
  const project = await createProject(env.DB, admin.ward.wardId, { kind: "event", title: "試しの送信確認会", year: 2026, accountId: admin.account.accountId });
  return { ...admin, project, path: `/${admin.ward.slug}/answer/${project.projectId}` };
}

it("同時送信と再読み込みを一件にし、別の画面からの同名の答えは別に数える", async () => {
  const { ward, project, path } = await fixture();
  const initial = await get(realApp, path);
  expect(initial.headers.get("Cache-Control")).toContain("no-store");
  const key = number(await initial.text());
  const form = { ...input, submission_id: key };
  for (const response of await Promise.all([postForm(realApp, path, form), postForm(realApp, path, form)])) {
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.text()).toContain("返事を受け付けました");
  }
  expect((await postForm(realApp, path, form)).status).toBe(200);
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toHaveLength(1);
  expect((await getAnswerTotals(env.DB, ward.wardId, project.projectId)).people).toBe(2);
  const otherKey = number(await (await get(realApp, path)).text());
  expect(otherKey).not.toBe(key);
  expect((await postForm(realApp, path, { ...input, submission_id: otherKey })).status).toBe(200);
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toHaveLength(2);
  expect((await getAnswerTotals(env.DB, ward.wardId, project.projectId)).people).toBe(4);
});

it("入力のやり直しは同じ番号を使い、受け付けた答えの訂正や削除を再送で戻さない", async () => {
  const { ward, project, path, cookie } = await fixture();
  const key = number(await (await get(realApp, path)).text());
  const form = { ...input, submission_id: key };
  const invalid = await postForm(realApp, path, { ...form, household: "" });
  expect(invalid.status).toBe(400);
  expect(number(await invalid.text())).toBe(key);
  expect((await postForm(realApp, path, form)).status).toBe(200);
  const saved = (await listAnswers(env.DB, ward.wardId, project.projectId))[0]!;
  const admin = `/${ward.slug}/admin/answers/${project.projectId}/${saved.answerId}`;
  expect((await postForm(realApp, `${admin}/edit`, { ...input, adults_count: "3" }, cookie)).status).toBe(303);
  const repeated = await postForm(realApp, path, form);
  expect(repeated.status).toBe(200);
  expect(await repeated.text()).toContain("3人");
  expect((await getAnswerTotals(env.DB, ward.wardId, project.projectId)).people).toBe(3);
  expect((await postForm(realApp, `${admin}/delete`, {}, cookie)).status).toBe(303);
  const deleted = await postForm(realApp, path, form);
  expect(deleted.status).toBe(200);
  expect(await deleted.text()).not.toContain(input.household);
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toEqual([]);
  expect((await postForm(realApp, `/${ward.slug}/admin/close/${project.projectId}/finalize`, {}, cookie)).status).toBe(303);
  expect((await postForm(realApp, path, form)).status).toBe(200);
  expect((await postForm(realApp, path, { ...input, submission_id: crypto.randomUUID() })).status).toBe(400);
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toEqual([]);
});

it("送信番号が同じでも別の区や別の行事の答えをまとめない", async () => {
  const first = await fixture();
  const second = await fixture();
  const project = await createProject(env.DB, first.ward.wardId, { kind: "event", title: "試しの別の確認会", year: 2026, accountId: first.account.accountId });
  const key = number(await (await get(realApp, first.path)).text());
  for (const target of [first, second, { ward: first.ward, project, path: `/${first.ward.slug}/answer/${project.projectId}` }]) {
    expect((await postForm(realApp, target.path, { ...input, submission_id: key })).status).toBe(200);
    expect(await listAnswers(env.DB, target.ward.wardId, target.project.projectId)).toHaveLength(1);
  }
});
