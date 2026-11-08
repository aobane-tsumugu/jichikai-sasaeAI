import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { pendingMaterialGroups } from "../src/intake/groups";
import { WhichProject } from "../src/intake/which-project";
import { postForm, realApp } from "./helpers";

async function readJob(wardId: string, accountId: string, original: string, title: string) {
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO jobs (job_id, ward_id, via, read_kind, sender_label, account_id, status, created_at, updated_at, read_at)
    VALUES (?, ?, 'admin', 'general', '試し', ?, 'read', ?, ?, ?)`).bind(jobId, wardId, accountId, now, now, now).run();
  await env.DB.prepare(`INSERT INTO originals (original_id, ward_id, job_id, position, filename, kind, media_type, content_hash, byte_size, received_at)
    VALUES (?, ?, ?, 0, ?, 'text', 'text/plain', ?, 1, ?)`).bind(original, wardId, jobId, `${original}.txt`, `hash-${original}`, now).run();
  await env.DB.prepare(`INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at)
    VALUES (?, ?, ?, 'direct', 'fixture@1', 'fixture', ?, ?)`).bind(crypto.randomUUID(), wardId, jobId, JSON.stringify({
    document_kind: "other", summary: "", original_years: [], text_blocks: [], fields: [], tables: [], decisions: [], unreadable: [],
    project_suggestions: [{ original_id: original, title, year_item: "", date_text: "", place: "" }],
  }), now).run();
  return jobId;
}

it("「この名前で新しく準備を始める」を二度押しても、同じ名前の準備を二つ作らず、残りの資料は一つ目に入れる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const first = await readJob(ward.wardId, account.accountId, "original-first", "秋の収穫祭");
  const second = await readJob(ward.wardId, account.accountId, "original-second", "秋の収穫祭");
  const group = (await pendingMaterialGroups(env.DB, ward.wardId)).find((entry) => entry.title);
  expect(group?.materials).toHaveLength(2);
  const form = { group: group!.key, operation: "new-project", projectName: "秋の収穫祭", year: "2026", eventDay: "" };
  expect((await postForm(realApp, `/${ward.slug}/admin/intake/start`, form, cookie)).status).toBe(303);
  // 一度目が入れ終わる前に二度目が届いた形にする（二つ目の資料をまだ入っていない状態に戻す）。
  await env.DB.prepare("UPDATE jobs SET project_id = NULL, status = 'read' WHERE ward_id = ? AND job_id = ?").bind(ward.wardId, second).run();
  expect((await postForm(realApp, `/${ward.slug}/admin/intake/start`, form, cookie)).status).toBe(303);
  const projects = await env.DB.prepare("SELECT project_id FROM projects WHERE ward_id = ? AND is_ward_notices = 0 AND title = '秋の収穫祭'")
    .bind(ward.wardId).all<{ project_id: string }>();
  expect(projects.results).toHaveLength(1);
  const placed = await env.DB.prepare("SELECT DISTINCT project_id FROM jobs WHERE ward_id = ? AND job_id IN (?, ?)").bind(ward.wardId, first, second).all<{ project_id: string }>();
  expect(placed.results.map((row) => row.project_id)).toEqual([projects.results[0]!.project_id]);
});

it("違う年の日を入れて始めた時は、同じ名前でも別の準備として始める", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  await readJob(ward.wardId, account.accountId, "original-this", "秋の収穫祭");
  const group = (await pendingMaterialGroups(env.DB, ward.wardId)).find((entry) => entry.title)!;
  await postForm(realApp, `/${ward.slug}/admin/intake/start`, { group: group.key, operation: "new-project", projectName: "秋の収穫祭", eventDay: "2026-10-25" }, cookie);
  await readJob(ward.wardId, account.accountId, "original-next", "秋の収穫祭");
  const next = (await pendingMaterialGroups(env.DB, ward.wardId)).find((entry) => entry.title)!;
  await postForm(realApp, `/${ward.slug}/admin/intake/start`, { group: next.key, operation: "new-project", projectName: "秋の収穫祭", eventDay: "2027-10-24" }, cookie);
  const years = await env.DB.prepare("SELECT year FROM projects WHERE ward_id = ? AND is_ward_notices = 0 AND title = '秋の収穫祭' ORDER BY year")
    .bind(ward.wardId).all<{ year: number }>();
  expect(years.results.map((row) => row.year)).toEqual([2026, 2027]);
});

it("準備を選ぶ二つのボタンの欄は、押したあとにボタンを止める", () => {
  const html = String(WhichProject({ id: "g", question: "この資料は、次の準備のものですか？", projects: [{ project_id: "p1", name: "秋の収穫祭" }] as never,
    action: "/x/admin/intake/start", suggestedName: "秋の収穫祭" }));
  expect(html.match(/onsubmit="setTimeout/g)?.length).toBe(2);
});
