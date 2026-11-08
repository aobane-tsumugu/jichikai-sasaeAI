import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { listAnswers } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { postForm, realApp } from "./helpers";

it("参加すると返事をした人数の入力漏れを不参加にせず、人数を直して同じ返事を保存できる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "試しの人数確認会", year: 2026, accountId: account.accountId,
  });
  const publicPath = `/${ward.slug}/answer/${project.projectId}`;
  const adminPath = `/${ward.slug}/admin/answers/${project.projectId}`;
  const input = { attend: "yes", household: "入力確認世帯", district: "", children_count: "", adults_count: "", seniors_count: "" };

  for (const count of ["", "0"]) {
    const form = { ...input, adults_count: count };
    const invalid = await postForm(realApp, publicPath, form);
    expect(invalid.status).toBe(400);
    const html = await invalid.text();
    expect(html).toContain(`value="${input.household}"`);
    expect(html).toMatch(/<input\b(?=[^>]*name="attend")(?=[^>]*value="yes")(?=[^>]*\bchecked)[^>]*>/);
    expect((await postForm(realApp, `${adminPath}/phone`, form, cookie)).status).toBe(400);
  }
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toEqual([]);

  const accepted = await postForm(realApp, publicPath, { ...input, adults_count: "2" });
  expect(accepted.status).toBe(200);
  expect(await accepted.text()).toContain("返事を受け付けました");
  const saved = await listAnswers(env.DB, ward.wardId, project.projectId);
  expect(saved).toEqual([expect.objectContaining({ peopleCount: 2, adultsCount: 2 })]);
  const editPath = `${adminPath}/${saved[0]!.answerId}/edit`;
  for (const count of ["", "0"]) {
    expect((await postForm(realApp, editPath, { ...input, adults_count: count }, cookie)).status).toBe(400);
    expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toEqual(saved);
  }
  expect((await postForm(realApp, editPath, { ...input, adults_count: "3" }, cookie)).status).toBe(303);
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toEqual([
    expect.objectContaining({ answerId: saved[0]!.answerId, peopleCount: 3, adultsCount: 3 }),
  ]);
  expect((await postForm(realApp, editPath, { ...input, attend: "no" }, cookie)).status).toBe(303);
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toEqual([
    expect.objectContaining({ answerId: saved[0]!.answerId, peopleCount: 0 }),
  ]);
});
