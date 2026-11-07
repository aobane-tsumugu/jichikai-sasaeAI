import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { postForm, realApp } from "./helpers";

it("電話の返事で参加するを選んで人数を空けると、何を直せば通るかを一文で言い、入れた名前は残す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の秋祭り", year: 2026, accountId: account.accountId });
  const path = `/${ward.slug}/admin/answers/${project.projectId}/phone`;
  const blank = await postForm(realApp, path, { household: "架空 電話の世帯", district: "", attend: "yes", children_count: "", adults_count: "", seniors_count: "" }, cookie);
  expect(blank.status).toBe(400);
  const html = await blank.text();
  expect(html).toContain("「参加する」のときは、参加する人数を入れてください。何人か分からないときは、ひとまず1と入れてかまいません。");
  expect(html).toContain('value="架空 電話の世帯"');
  const noName = await postForm(realApp, path, { household: "", district: "", attend: "no" }, cookie);
  expect(await noName.text()).toContain("世帯の代表者のお名前が入っていません。");
  const ok = await postForm(realApp, path, { household: "架空 電話の世帯", district: "", attend: "yes", children_count: "", adults_count: "1", seniors_count: "" }, cookie);
  expect(ok.status).toBe(303);
});
