import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { addAnswer } from "../src/answers/api";
import { writeDailyWardSnapshots } from "../src/archive/snapshot";
import { CRON } from "../src/core/cron";
import { seedAdmin } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import { receive } from "../src/intake/receive";
import { runDeletionCron } from "../src/ops/lifecycle";
import { applyChange, createProject } from "../src/project/api";
import { saveDocument } from "../src/project/actions";
import { get, postForm, realApp } from "./helpers";

const snapshotPath = "snapshots/daily/2026-11-05.json";

async function drain(wardId: string) {
  for (let i = 0; i < 20; i++) {
    const queue = await env.DB.prepare("SELECT COUNT(*) AS n FROM ops_deletion_queue WHERE ward_id = ?").bind(wardId).first<{ n: number }>();
    if (!queue?.n) break;
    await runDeletionCron({ cron: CRON.EVERY_5_MIN } as ScheduledController, env);
  }
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM ops_deletion_queue WHERE ward_id = ?").bind(wardId).first("n")).toBe(0);
}

it("原本と回答と配った案内のあるプロジェクトを列で消し、D1・R2・毎日の写しに残さない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "消去する行事（架空）", year: 2026, eventDay: "2026-10-24", accountId: account.accountId,
  });
  const received = await receive(env, { wardId: ward.wardId, projectId: project.projectId, via: "admin", parts: [
    { kind: "text", filename: "", mediaType: "text/plain", bytes: new TextEncoder().encode("消す対象の会場メモ（架空）") },
  ] });
  await applyChange(env.DB, ward.wardId, project.projectId, {
    kind: "item", itemKey: "place", value: "消す対象の会場（架空）",
    source: { kind: "original", ref: received.received[0]!.originalId, year: 2026 }, confidence: "low", packVersion: "test@1",
  });
  await addAnswer(env.DB, ward.wardId, { projectId: project.projectId, household: "架空の世帯", district: "1班", peopleCount: 2, source: "web" });
  const stateVersion = await env.DB.prepare("SELECT state_version FROM projects WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, project.projectId).first<number>("state_version");
  await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
    kind: "announcement", title: "消す案内（架空）", scope: "public", body: JSON.stringify({ text: "公開する架空の案内", items: [] }), basedOn: stateVersion!,
  });
  const version = await env.DB.prepare("SELECT document_id, version_id, version_no FROM document_versions WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  const published = await postForm(realApp, `/${ward.slug}/admin/publish/${project.projectId}/send`, {
    documentId: version!.document_id, versionId: version!.version_id, versionNo: String(version!.version_no),
    stateVersion: String(stateVersion), distribution: "", lineDelivery: "skip",
  }, cookie);
  expect(published.status).toBe(303);
  await writeDailyWardSnapshots(env, new Date("2026-11-05T00:00:00Z"));
  const root = `/${ward.slug}/admin/settings/deletion`;
  const page = await get(realApp, root, cookie);
  expect(await page.text()).toContain("このプロジェクトを消す");
  expect((await postForm(realApp, `${root}/projects/${project.projectId}`, {}, cookie)).status).toBe(303);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM ops_deletion_queue WHERE ward_id = ? AND target_type = 'project'").bind(ward.wardId).first("n")).toBe(1);
  await drain(ward.wardId);

  for (const table of ["projects", "project_answers", "publication_records", "documents", "document_versions", "project_deadlines", "project_map_tasks", "project_changes", "project_item_values", "project_questions"]) {
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ward_id = ? AND project_id = ?`).bind(ward.wardId, project.projectId).first("n")).toBe(0);
  }
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE ward_id = ? AND project_id = ?").bind(ward.wardId, project.projectId).first("n")).toBe(0);
  const bucket = new WardBucket(env.ORIGINALS, ward.wardId);
  expect((await bucket.list("originals/")).keys).toHaveLength(0);
  const snapshot = await (await bucket.get(snapshotPath))!.text();
  expect(snapshot).not.toContain(project.projectId);
  expect(snapshot).not.toContain("消す対象の会場");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM ops_deletion_marks WHERE ward_id = ?").bind(ward.wardId).first("n")).toBe(1);
  expect(await (await get(realApp, `/${ward.slug}/admin/projects`, cookie)).text()).not.toContain(project.title);
  expect((await get(realApp, `/${ward.slug}/p/${project.projectId}`)).status).toBe(404);
});

it("種にした先のプロジェクトは残し、D1 と毎日の写しの種の繋がりだけを外す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const source = await createProject(env.DB, ward.wardId, { kind: "event", title: "去年の行事（架空）", year: 2026, accountId: account.accountId });
  const next = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "来年の行事（架空）", year: 2027, seedProjectId: source.projectId, accountId: account.accountId,
  });
  await writeDailyWardSnapshots(env, new Date("2026-11-05T00:00:00Z"));
  expect((await postForm(realApp, `/${ward.slug}/admin/settings/deletion/projects/${source.projectId}`, {}, cookie)).status).toBe(303);
  await drain(ward.wardId);
  expect(await env.DB.prepare("SELECT project_id, seed_project_id FROM projects WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, next.projectId).first()).toMatchObject({ project_id: next.projectId, seed_project_id: null });
  expect((await get(realApp, `/${ward.slug}/admin/projects/${next.projectId}`, cookie)).status).toBe(200);
  const snapshot = await (await new WardBucket(env.ORIGINALS, ward.wardId).get(snapshotPath))!.text();
  expect(snapshot).toContain(next.projectId);
  expect(snapshot).not.toContain(source.projectId);
});
