import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

const day = (offset: number) => new Date(Date.now() + 9 * 3600_000 + offset * 86400_000).toISOString().slice(0, 10);

it("トップは、今日が仕事の時期に入っている時だけ「今は…の時期です」と書き、時期の前や時期の無い仕事は「次は…です」と書く", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "年末の見回り", year: Number(day(48).slice(0, 4)), eventDay: day(48), accountId: account.accountId });
  const tasks = (await env.DB.prepare("SELECT task_id, name FROM project_map_tasks WHERE ward_id = ? AND project_id = ? AND removed_at IS NULL ORDER BY sort_order").bind(ward.wardId, project.projectId).all<{ task_id: string; name: string }>()).results;
  const kept = tasks[0]!;
  await env.DB.prepare("UPDATE project_map_tasks SET progress = 'done' WHERE ward_id = ? AND project_id = ? AND task_id <> ?").bind(ward.wardId, project.projectId, kept.task_id).run();
  const main = async () => {
    const page = await (await get(realApp, `${root}/`, cookie)).text();
    const start = page.indexOf('<section class="next">');
    return page.slice(start, page.indexOf("</section>", start));
  };
  // 当日の日から始まる仕事が、まだ先のとき
  await env.DB.prepare("UPDATE project_map_tasks SET period_start = ?, period_end = ? WHERE ward_id = ? AND task_id = ?").bind(day(48), day(50), ward.wardId, kept.task_id).run();
  let text = await main();
  expect(text).toContain(`次は「${kept.name}」です。`);
  expect(text).not.toContain("の時期です。");
  // 当日より前に始まる仕事が、まだ先のとき
  await env.DB.prepare("UPDATE project_map_tasks SET period_start = ?, period_end = ? WHERE ward_id = ? AND task_id = ?").bind(day(20), day(30), ward.wardId, kept.task_id).run();
  text = await main();
  expect(text).toMatch(new RegExp(`次は「${kept.name}」です。\\d+月\\d+日からです（あと20日）。`));
  // 時期の無い仕事
  await env.DB.prepare("UPDATE project_map_tasks SET period_start = NULL, period_end = NULL WHERE ward_id = ? AND task_id = ?").bind(ward.wardId, kept.task_id).run();
  text = await main();
  expect(text).toContain(`次は「${kept.name}」です。この仕事の時期はまだ決まっていません。`);
  // 今日が時期に入っている仕事
  await env.DB.prepare("UPDATE project_map_tasks SET period_start = ?, period_end = ? WHERE ward_id = ? AND task_id = ?").bind(day(-2), day(5), ward.wardId, kept.task_id).run();
  text = await main();
  expect(text).toMatch(new RegExp(`今は「${kept.name}」の時期です。\\d+月\\d+日までです（あと5日）。`));
});
