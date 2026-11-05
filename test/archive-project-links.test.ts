import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("記録検索の題から進行中のプロジェクトを開け、閉じた後は記録を開ける", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の防災の準備", year: 2026, accountId: account.accountId,
  });
  await receive(env, {
    wardId: ward.wardId, projectId: project.projectId, via: "admin", accountId: account.accountId,
    parts: [{ kind: "text", filename: "架空の備品.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("架空の備品を確認しました。") }],
  });
  const root = `/${ward.slug}/admin`;
  const searchPath = `${root}/archive/search?q=${encodeURIComponent("備品")}`;
  const titleLink = (html: string) => /<h2><a href="([^"]+)">架空の防災の準備<\/a><\/h2>/.exec(html)?.[1];
  const openPage = await get(realApp, searchPath, cookie);
  expect(openPage.status).toBe(200);
  const openLink = titleLink(await openPage.text());
  expect(openLink).toBeDefined();
  expect((await get(realApp, openLink!, cookie)).status).toBe(200);

  expect((await postForm(realApp, `${root}/close/${project.projectId}/finalize`, {}, cookie)).status).toBe(303);
  const closedPage = await get(realApp, searchPath, cookie);
  expect(closedPage.status).toBe(200);
  const closedLink = titleLink(await closedPage.text());
  expect(closedLink).toBe(`${root}/archive/${project.projectId}`);
  expect((await get(realApp, closedLink!, cookie)).status).toBe(200);
});
