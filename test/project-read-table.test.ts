import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { listOriginals } from "../src/intake/store";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("準備の画面の読み取った内容は、文だけでなく、Word や Excel の表の中身も出す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "年末の見回り", year: 2026, accountId: account.accountId });
  const got = await receive(env, { wardId: ward.wardId, projectId: project.projectId, via: "admin", parts: [
    { kind: "text", filename: "見回りの当番表.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("年末の見回りの当番表") },
  ] });
  if (!got.jobId) throw new Error("資料を受け付けられませんでした");
  const [original] = await listOriginals(env.DB, ward.wardId, got.jobId);
  if (!original) throw new Error("原本がありません");
  const body = { document_kind: "rota", original_years: [], summary: "去年の年末の見回りの当番表。", text_blocks: [{ original_id: original.original_id, locator: "段落1", text: "年末の見回りのお知らせ" }], fields: [],
    tables: [{ name: "見回りの当番", original_id: original.original_id, locator: "見回りの当番", columns: [], rows: [
      { cells: ["日", "班", "担当の世帯"], locator: "2行目", confidence: "high" },
      { cells: ["12月26日（金）", "1班", "佐藤、田中"], locator: "3行目", confidence: "high" },
    ] }], decisions: [], unreadable: [] };
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE jobs SET status = 'done', read_at = ? WHERE ward_id = ? AND job_id = ?").bind(now, ward.wardId, got.jobId).run();
  await env.DB.prepare("INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at) VALUES (?, ?, ?, 'model', 'test@1', 'fixture', ?, ?)")
    .bind(crypto.randomUUID(), ward.wardId, got.jobId, JSON.stringify(body), now).run();
  const page = await (await get(realApp, `/${ward.slug}/admin/projects/${project.projectId}`, cookie)).text();
  expect(page).toContain("年末の見回りのお知らせ（段落1）");
  expect(page).toContain("<caption>見回りの当番</caption>");
  expect(page).toContain("<td>12月26日（金）</td><td>1班</td><td>佐藤、田中</td>");
});
