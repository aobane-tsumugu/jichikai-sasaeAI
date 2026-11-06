import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("閉じた地図がある時だけ、新しい年の順に来年の種への入口を出す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  expect(await (await get(realApp, `${root}/projects`, cookie)).text()).not.toContain("去年の地図から開く");
  const open = await createProject(env.DB, ward.wardId, { kind: "event", title: "開いている行事（架空）", year: 2026, accountId: account.accountId });
  const closed = [];
  for (const year of [2024, 2025]) {
    const project = await createProject(env.DB, ward.wardId, { kind: "event", title: `${year}年の行事（架空）`, year, accountId: account.accountId });
    await env.DB.prepare("UPDATE projects SET closed_at = ? WHERE ward_id = ? AND project_id = ?")
      .bind("2026-11-05T00:00:00Z", ward.wardId, project.projectId).run();
    closed.push(project);
  }
  const page = await get(realApp, `${root}/projects`, cookie);
  const html = await page.text();
  expect(html).toContain("去年の地図から開く");
  expect(html.indexOf("2025年 2025年の行事")).toBeLessThan(html.indexOf("2024年 2024年の行事"));
  for (const project of closed) expect(html).toContain(`href="${root}/archive/${project.projectId}"`);
  expect(html).not.toContain(`${root}/archive/${open.projectId}`);
  const record = await get(realApp, `${root}/archive/${closed[0]!.projectId}`, cookie);
  expect(await record.text()).toContain("これをもとに新しく始める");
});
