import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { listJobs } from "../src/intake/store";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("届いたものを名前と文で見分け、資料の文を読み、今やることに過ぎた行事の日を出さない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const jstNow = Date.now() + 9 * 60 * 60 * 1000;
  const yesterday = new Date(jstNow - 86400000).toISOString().slice(0, 10);
  const tomorrow = new Date(jstNow + 86400000).toISOString().slice(0, 10);
  const displayDate = (iso: string): string => {
    const date = new Date(`${iso}T00:00:00Z`);
    const weekday = ["日", "月", "火", "水", "木", "金", "土"][date.getUTCDay()];
    return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日（${weekday}）`;
  };
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "済んだ行事（架空）", year: 2026, eventDay: yesterday, accountId: account.accountId,
  });
  await createProject(env.DB, ward.wardId, { kind: "event", title: "次の行事（架空）", year: 2026, eventDay: tomorrow });
  await env.DB.prepare("INSERT INTO project_deadlines (ward_id, project_id, kind, due_on) VALUES (?, ?, 'answer_due', ?)")
    .bind(ward.wardId, project.projectId, yesterday).run();
  const filename = "会場のメモ（架空）.txt";
  const text = "受付は東側の入口に移します。担当の実行委員には会場の鍵と机の置き場を伝えます（すべて架空の資料）。";
  await receive(env, { wardId: ward.wardId, projectId: project.projectId, via: "admin", parts: [
    { kind: "file", filename, mediaType: "text/plain", bytes: new TextEncoder().encode("架空の会場のメモです") },
  ] });
  await receive(env, { wardId: ward.wardId, projectId: project.projectId, via: "admin", parts: [
    { kind: "text", filename: "", mediaType: "text/plain", bytes: new TextEncoder().encode(text) },
  ] });
  const root = `/${ward.slug}/admin`;
  const intake = await get(realApp, `${root}/intake/received`, cookie);
  const intakeHtml = await intake.text();
  expect(intakeHtml).toContain(filename);
  expect(intakeHtml).toContain(`<b>${text.slice(0, 40)}…</b>`);
  const materials = await get(realApp, `${root}/projects/${project.projectId}`, cookie);
  const materialHtml = await materials.text();
  const beforeReadings = materialHtml.slice(materialHtml.indexOf('<h2 id="materials"')).split("<details>")[0];
  expect(beforeReadings).toContain(text);
  const today = await get(realApp, `${root}/projects/today`, cookie);
  const todayHtml = await today.text();
  // 仕事名と日付は別の行に出る。同じ仕事の中に期限があることを確かめる。
  const todayRows = todayHtml.match(/<a class="row-link"[^>]*>[\s\S]*?<\/a>/g) ?? [];
  expect(todayRows.some((row) => row.includes("済んだ行事（架空）　当日"))).toBe(false);
  const nextEvent = todayRows.find((row) => row.includes("次の行事（架空）　当日"));
  expect(nextEvent).toBeDefined();
  expect(nextEvent).toContain(displayDate(tomorrow));
  const answerDue = todayRows.find((row) => row.includes("済んだ行事（架空）　返事の締切"));
  expect(answerDue).toBeDefined();
  expect(answerDue).toContain(displayDate(yesterday));
  expect(answerDue).toContain(`href="${root}/answers/${project.projectId}"`);
});

it("AIに頼んだ下書きの仕事は、届いたものの一覧に出さない", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭（架空）", year: 2026, accountId: account.accountId });
  await env.DB.prepare(`INSERT INTO jobs (job_id, ward_id, project_id, via, task, instruction, account_id, status, created_at, updated_at, read_at)
    VALUES ('system-draft', ?, ?, 'system', 'report', '架空の指示', ?, 'done', ?, ?, ?)`)
    .bind(ward.wardId, project.projectId, account.accountId, "2026-11-05T00:00:00.000Z", "2026-11-05T00:00:00.000Z", "2026-11-05T00:00:00.000Z").run();
  const jobs = await listJobs(env.DB, ward.wardId, { projectId: project.projectId });
  expect(jobs.map((job) => job.job_id)).not.toContain("system-draft");
});
