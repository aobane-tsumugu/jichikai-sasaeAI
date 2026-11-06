import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("初めての役員にプロジェクト・資料・空間の次の操作を、その画面で示す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const opening = "去年の資料を送ってください";
  const materials = "ふつうの8つの仕事の段取りを用意しました";
  const emptyHome = await get(realApp, `${root}/`, cookie);
  expect(emptyHome.status).toBe(200);
  const homeHtml = await emptyHome.text();
  expect(homeHtml).toContain(opening);
  // 資料が無い一年目でも始められる。
  expect(homeHtml).toContain(`class="button secondary" href="${root}/projects">資料がないので、種類を選んで始める</a>`);
  const projectEntry = await get(realApp, `${root}/projects`, cookie);
  expect(projectEntry.status).toBe(200);
  const projectEntryHtml = await projectEntry.text();
  expect(projectEntryHtml).toContain("<h2>プロジェクトを開く</h2>");
  expect(projectEntryHtml).toContain(`<form method="post" action="${root}/projects">`);
  expect(projectEntryHtml).toContain('<button type="submit">開く</button>');

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
  expect(await space.text()).toContain("実行委員と班長が、配られたものを見て、紙を撮って送るページです。");
});
