import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { listUnansweredByDistrict, replaceRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("別の班の同名世帯はそれぞれ回答を照合し、全員回答後も名簿にある班を表示する", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の行事", year: 2026, accountId: account.accountId,
  });
  await replaceRoster(env.DB, ward.wardId, [
    { household: "架空の同名世帯", district: "1班" },
    { household: "架空の同名世帯", district: "2班" },
  ], { household: 0, district: 1 });
  const path = `/${ward.slug}/answer/${project.projectId}`;
  expect((await postForm(realApp, path, { household: "架空の同名世帯", district: "1班", people_count: "2" })).status).toBe(200);
  expect(await listUnansweredByDistrict(env.DB, ward.wardId, project.projectId)).toEqual([
    { district: "1班", households: [] },
    { district: "2班", households: ["架空の同名世帯"] },
  ]);
  expect((await postForm(realApp, path, { household: "架空の同名世帯", district: "2班", people_count: "3" })).status).toBe(200);
  const page = await (await get(realApp, `/${ward.slug}/admin/answers/${project.projectId}?view=unanswered`, cookie)).text();
  expect(page).not.toContain("名簿はまだありません。");
  expect(page.match(/未回答の世帯はありません。/g)).toHaveLength(2);
});
