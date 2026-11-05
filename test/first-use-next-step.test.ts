import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("初めての役員にプロジェクト・資料・空間の次の操作を、その画面で示す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const opening = "行事や総会など、仕事ごとにプロジェクトを開きます。";
  const materials = "去年の案内や記録の紙、Word や Excel を、見つかった物から送ってください。全部そろえなくてかまいません。";
  const emptyHome = await get(realApp, `${root}/`, cookie);
  const homeHtml = await emptyHome.text();
  expect(homeHtml).toContain(opening);
  expect(homeHtml).toContain(`class="button" href="${root}/projects">プロジェクトを開く`);

  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "最初の行事（架空）", year: 2026, accountId: account.accountId,
  });
  expect(await (await get(realApp, `${root}/`, cookie)).text()).not.toContain(opening);
  const emptyMap = await get(realApp, `${root}/projects/${project.projectId}/map`, cookie);
  const mapHtml = await emptyMap.text();
  expect(mapHtml).toContain(materials);
  expect(mapHtml).toContain("材料を送る");
  await receive(env, { wardId: ward.wardId, projectId: project.projectId, via: "admin", parts: [
    { kind: "text", filename: "", mediaType: "text/plain", bytes: new TextEncoder().encode("去年の会場の記録（架空）") },
  ] });
  expect(await (await get(realApp, `${root}/projects/${project.projectId}/map`, cookie)).text()).not.toContain(materials);
  const space = await get(realApp, `${root}/space/${project.projectId}`, cookie);
  expect(await space.text()).toContain("実行委員や班長に、当番表や出欠を見てもらう場所です。");
});
