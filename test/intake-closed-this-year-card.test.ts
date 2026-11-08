import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("今年終えた行事の資料が後から届いた枠では、今年終えたことを書き、「もう済んでいれば、準備を始めてから…」を並べない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const year = new Date(Date.now() + 9 * 3600_000).getUTCFullYear();
  // 年間の予定では一月の行事（いつ流しても「もう過ぎた月」になる）。
  await env.DB.prepare("INSERT INTO ward_year_items (ward_id, item_id, title, month, added) VALUES (?, 'ward-newyear', '試しの新年会', 1, 1)").bind(ward.wardId).run();
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "試しの新年会", year, accountId: account.accountId });
  await env.DB.prepare("UPDATE projects SET closed_at = ?, closed_by_account_id = ? WHERE ward_id = ? AND project_id = ?")
    .bind(new Date().toISOString(), account.accountId, ward.wardId, project.projectId).run();
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO jobs (job_id, ward_id, via, read_kind, sender_label, account_id, status, created_at, updated_at, read_at)
    VALUES (?, ?, 'admin', 'general', '試し', ?, 'read', ?, ?, ?)`).bind(jobId, ward.wardId, account.accountId, now, now, now).run();
  await env.DB.prepare(`INSERT INTO originals (original_id, ward_id, job_id, position, filename, kind, media_type, content_hash, byte_size, received_at)
    VALUES ('original-late', ?, ?, 0, '試しの新年会のご案内.txt', 'text', 'text/plain', 'hash-late', 1, ?)`).bind(ward.wardId, jobId, now).run();
  await env.DB.prepare(`INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at) VALUES (?, ?, ?, 'direct', 'fixture@1', 'fixture', ?, ?)`)
    .bind(crypto.randomUUID(), ward.wardId, jobId, JSON.stringify({ document_kind: "other", summary: "", original_years: [], text_blocks: [], fields: [], tables: [], decisions: [], unreadable: [],
      project_suggestions: [{ original_id: "original-late", title: "試しの新年会", year_item: "", date_text: "", place: "" }] }), now).run();
  const page = await (await get(realApp, `/${ward.slug}/admin/intake/read`, cookie)).text();
  expect(page).toContain("今年");
  expect(page).toContain("終わりを取り消す画面へ");
  expect(page).not.toContain("もう済んでいれば、準備を始めてから");
});
