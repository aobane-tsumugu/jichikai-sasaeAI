import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("初めての役員に行事・資料・実行委員と班長のページの次の操作を、その画面で示す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const opening = "まず、手元にある自治会の資料を送ってください";
  const materials = "ふつうの8つのやることを用意しました";
  const emptyHome = await get(realApp, `${root}/`, cookie);
  expect(emptyHome.status).toBe(200);
  const homeHtml = await emptyHome.text();
  expect(homeHtml).toContain(opening);
  // 資料が無い一年目でも始められる。
  expect(homeHtml).toContain(`class="quiet" href="${root}/projects">資料なしで準備を始める</a>`);
  const projectEntry = await get(realApp, `${root}/projects`, cookie);
  expect(projectEntry.status).toBe(200);
  const projectEntryHtml = await projectEntry.text();
  expect(projectEntryHtml).toContain("<h1>新しく準備を始める</h1>");
  expect(projectEntryHtml).toContain(`<form method="post" action="${root}/projects">`);
  expect(projectEntryHtml).toContain('<button type="submit">始める</button>');

  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "最初の行事（架空）", year: 2026, accountId: account.accountId,
  });
  expect(await (await get(realApp, `${root}/`, cookie)).text()).not.toContain(opening);
  const emptyMap = await get(realApp, `${root}/projects/${project.projectId}/map`, cookie);
  const mapHtml = await emptyMap.text();
  expect(mapHtml).toContain(materials);
  expect(mapHtml).toContain("資料を送る");
  await receive(env, { wardId: ward.wardId, projectId: project.projectId, via: "admin", parts: [
    { kind: "text", filename: "", mediaType: "text/plain", bytes: new TextEncoder().encode("去年の会場の記録（架空）") },
  ] });
  expect(await (await get(realApp, `${root}/projects/${project.projectId}/map`, cookie)).text()).not.toContain(materials);
  const space = await get(realApp, `${root}/space/${project.projectId}`, cookie);
  expect(await space.text()).toContain("実行委員と班長だけが、スマホで開けるページです。住民には見えません。");
});
