import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("閉じたやることがある時だけ、新しい年の順にこれをもとに新しく始めるへの入口を出す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  expect(await (await get(realApp, `${root}/projects`, cookie)).text()).not.toContain("去年の終わったものから始める");
  const open = await createProject(env.DB, ward.wardId, { kind: "event", title: "開いている行事", year: 2026, accountId: account.accountId });
  const closed = [];
  for (const year of [2024, 2025]) {
    const project = await createProject(env.DB, ward.wardId, { kind: "event", title: `${year}年の行事`, year, accountId: account.accountId });
    await env.DB.prepare("UPDATE projects SET closed_at = ? WHERE ward_id = ? AND project_id = ?")
      .bind("2026-11-05T00:00:00Z", ward.wardId, project.projectId).run();
    closed.push(project);
  }
  // 今年終わったものは「去年の終わったもの」に並べない。
  const thisYear = Number(new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 4));
  const doneThisYear = await createProject(env.DB, ward.wardId, { kind: "event", title: "今年終わった行事", year: thisYear, accountId: account.accountId });
  await env.DB.prepare("UPDATE projects SET closed_at = ? WHERE ward_id = ? AND project_id = ?").bind(new Date().toISOString(), ward.wardId, doneThisYear.projectId).run();
  const page = await get(realApp, `${root}/projects`, cookie);
  const html = await page.text();
  expect(html).toContain("去年の終わったものから始める");
  expect(html.indexOf("2025年 2025年の行事")).toBeLessThan(html.indexOf("2024年 2024年の行事"));
  for (const project of closed) expect(html).toContain(`href="${root}/archive/${project.projectId}"`);
  expect(html).not.toContain(`${root}/archive/${open.projectId}`);
  expect(html).not.toContain(`${root}/archive/${doneThisYear.projectId}`);
  const record = await get(realApp, `${root}/archive/${closed[0]!.projectId}`, cookie);
  expect(await record.text()).toContain("これをもとに今年の");
});
