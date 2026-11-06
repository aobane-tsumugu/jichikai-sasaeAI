import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { getAnswerDeadline, listAnswers } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("閉じた答えの画面では受付をせず、開き直してから電話の答えを入れられる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の答えの確認", year: 2026, accountId: account.accountId,
  });
  const root = `/${ward.slug}/admin`;
  const path = `${root}/answers/${project.projectId}`;
  const phone = { household: "架空の世帯", district: "架空の班", people_count: "2" };
  expect((await postForm(realApp, `${path}/phone`, phone, cookie)).status).toBe(303);
  expect((await postForm(realApp, `${path}/deadline`, { due_on: "2026-10-10" }, cookie)).status).toBe(303);
  expect((await postForm(realApp, `${root}/close/${project.projectId}/finalize`, {}, cookie)).status).toBe(303);

  const stalePhone = await postForm(realApp, `${path}/phone`, phone, cookie);
  expect(stalePhone.status).toBe(303);
  const photo = new FormData();
  photo.append("part", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1])], "架空の回答票.jpg", { type: "image/jpeg" }));
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
  expect(html).toContain("架空の世帯");
  expect(html).toContain("2人");
  expect(html).toContain("閉じた画面から、もう一度開いてください");
  expect(html).not.toContain('name="children_count"');
  expect(html).not.toContain('name="part"');
  expect(html).not.toContain('name="due_on"');

  expect((await postForm(realApp, `${root}/close/${project.projectId}/reopen`, {}, cookie)).status).toBe(303);
  expect(await (await get(realApp, `${path}?view=hand`, cookie)).text()).toContain('name="children_count"');
  expect((await postForm(realApp, `${path}/phone`, { ...phone, household: "架空の別の世帯", people_count: "3" }, cookie)).status).toBe(303);
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toHaveLength(2);
});
