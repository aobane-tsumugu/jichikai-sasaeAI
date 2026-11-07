import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { addAnswer, listAnswers } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { SETTING_KEYS } from "../src/settings/keys";
import { setSetting } from "../src/settings/store";
import { postForm, realApp } from "./helpers";

const input = {
  household: "架空の電話の代表", district: "架空の一班", attend: "yes",
  children_count: "", adults_count: "", seniors_count: "",
  helper_name: "架空の手伝いさん", helper_times: "9時から10時",
};

async function fixture() {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の手入力確認会", year: 2099, accountId: account.accountId });
  await setSetting(env.DB, ward.wardId, SETTING_KEYS.squads, JSON.stringify([input.district]), account.accountId);
  return { ward, account, cookie, project, root: `/${ward.slug}/admin/answers/${project.projectId}` };
}

function expectFields(html: string, values: typeof input) {
  for (const name of ["household", "children_count", "adults_count", "seniors_count", "helper_name", "helper_times"] as const) {
    const field = new RegExp(`<input\\b(?=[^>]*name="${name}")(?=[^>]*value="${values[name]}")[^>]*>`);
    expect(html).toMatch(field);
  }
  for (const name of ["attend", "district"] as const) {
    expect(html).toMatch(new RegExp(`<input\\b(?=[^>]*name="${name}")(?=[^>]*value="${values[name]}")(?=[^>]*\\bchecked)[^>]*>`));
  }
}

it("電話や紙の手入力で人数を忘れてもほかの入力を残し、直して一件を数に入れる", async () => {
  const f = await fixture();
  const path = `${f.root}/phone`;
  const invalid = await postForm(realApp, path, input, f.cookie);
  expect(invalid.status).toBe(400);
  const html = await invalid.text();
  expect(html).toContain(`action="${path}"`);
  expectFields(html, input);
  expect(await listAnswers(env.DB, f.ward.wardId, f.project.projectId)).toHaveLength(0);

  expect((await postForm(realApp, path, { ...input, adults_count: "2" }, f.cookie)).status).toBe(303);
  expect(await listAnswers(env.DB, f.ward.wardId, f.project.projectId)).toEqual([
    expect.objectContaining({ household: input.household, district: input.district, peopleCount: 2, helperName: input.helper_name, helperTimes: input.helper_times }),
  ]);
});

it("答えの訂正で人数を間違えても書き直した名前や希望を残し、保存は成功したときだけ変える", async () => {
  const f = await fixture();
  const id = await addAnswer(env.DB, f.ward.wardId, { projectId: f.project.projectId, household: "架空の訂正前の代表", district: "", peopleCount: 2,
    childrenCount: 0, adultsCount: 2, seniorsCount: 0, source: "phone", accountId: f.account.accountId });
  const saved = await listAnswers(env.DB, f.ward.wardId, f.project.projectId);
  const path = `${f.root}/${id}/edit`;
  const values = { ...input, adults_count: "0" };
  const invalid = await postForm(realApp, path, values, f.cookie);
  expect(invalid.status).toBe(400);
  const html = await invalid.text();
  expect(html).toContain(`action="${path}"`);
  expectFields(html, values);
  expect(await listAnswers(env.DB, f.ward.wardId, f.project.projectId)).toEqual(saved);

  expect((await postForm(realApp, path, { ...values, adults_count: "3" }, f.cookie)).status).toBe(303);
  expect(await listAnswers(env.DB, f.ward.wardId, f.project.projectId)).toEqual([
    expect.objectContaining({ answerId: id, household: input.household, district: input.district, peopleCount: 3, helperName: input.helper_name, helperTimes: input.helper_times }),
  ]);
});

it("合計だけの古い答えも、消した人数を誤りの後に保存済みの値へ戻さず、入れ直して保存できる", async () => {
  const f = await fixture();
  const id = await addAnswer(env.DB, f.ward.wardId, { projectId: f.project.projectId, household: input.household, district: input.district, peopleCount: 4,
    helperName: input.helper_name, helperTimes: input.helper_times, source: "phone", accountId: f.account.accountId });
  const saved = await listAnswers(env.DB, f.ward.wardId, f.project.projectId);
  const path = `${f.root}/${id}/edit`;
  const values = { ...input, people_count: "" };
  const invalid = await postForm(realApp, path, values, f.cookie);
  expect(invalid.status).toBe(400);
  const html = await invalid.text();
  expectFields(html, values);
  expect(html).toMatch(/<input\b(?=[^>]*name="people_count")(?=[^>]*value="")[^>]*>/);
  expect(await listAnswers(env.DB, f.ward.wardId, f.project.projectId)).toEqual(saved);

  expect((await postForm(realApp, path, { ...values, people_count: "2" }, f.cookie)).status).toBe(303);
  expect(await listAnswers(env.DB, f.ward.wardId, f.project.projectId)).toEqual([
    expect.objectContaining({ answerId: id, peopleCount: 2, adultsCount: null, childrenCount: null, seniorsCount: null }),
  ]);
});
