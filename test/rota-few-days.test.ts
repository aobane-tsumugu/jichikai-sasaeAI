import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("何日かだけの当番では曜日の欄を先に出さず畳みに入れ、毎週回す当番の時だけ先に出す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const page = async (projectId: string) => (await get(realApp, `/${ward.slug}/admin/projects/${projectId}/draft/duty_roster`, cookie)).text();
  const weeklyLabel = "何曜日に当番を回しますか";
  const fold = "<summary>毎週回す当番にするとき</summary>";

  // 当日のある見回り（12月26日から28日）
  const patrol = await createProject(env.DB, ward.wardId, { kind: "duty", title: "年末の見回り", year: 2026, accountId: account.accountId, eventDay: "2026-12-26" });
  const few = await page(patrol.projectId);
  expect(few).toContain(fold);
  expect(few.indexOf(weeklyLabel)).toBeGreaterThan(few.indexOf(fold));
  expect(few).not.toContain("毎週回す当番でなければ");

  // 当日がまだ決まっていなくても、一年の予定で毎週の物でなければ、毎週の当番として扱わない
  const undecided = await createProject(env.DB, ward.wardId, { kind: "duty", title: "夜の見回り", year: 2026, accountId: account.accountId });
  expect(await page(undecided.projectId)).toContain(fold);

  // ごみ当番（一年の予定で毎週月曜）
  const garbage = await createProject(env.DB, ward.wardId, { kind: "duty", title: "ごみ当番", year: 2026, accountId: account.accountId });
  const weekly = await page(garbage.projectId);
  expect(weekly).toContain(weeklyLabel);
  expect(weekly).not.toContain(fold);
});

it("当番表を送ったあとは、送り直しを頼まず、読んでいる間と、行が取れなかった時を書き分ける", async () => {
  const { receive } = await import("../src/intake/receive");
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const patrol = await createProject(env.DB, ward.wardId, { kind: "duty", title: "年末の見回り", year: 2026, accountId: account.accountId, eventDay: "2026-12-26" });
  const page = async () => (await get(realApp, `/${ward.slug}/admin/projects/${patrol.projectId}/draft/duty_roster`, cookie)).text();
  expect(await page()).toContain("手元の当番表を写真やファイルで送れます。");
  const got = await receive(env, { wardId: ward.wardId, projectId: patrol.projectId, via: "admin", parts: [
    { kind: "text", filename: "見回りの当番表.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("去年の見回りの当番表") },
  ] });
  const body = { document_kind: "rota", original_years: [], summary: "去年の見回りの当番表。", text_blocks: [], fields: [], tables: [], decisions: [], unreadable: [] };
  await env.DB.prepare("INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at) VALUES (?, ?, ?, 'model', 'test@1', 'fixture', ?, ?)")
    .bind(crypto.randomUUID(), ward.wardId, got.jobId, JSON.stringify(body), new Date().toISOString()).run();
  await env.DB.prepare("UPDATE jobs SET status = 'read' WHERE ward_id = ? AND job_id = ?").bind(ward.wardId, got.jobId).run();
  const reading = await page();
  expect(reading).toContain("届いた当番表「見回りの当番表.txt」を、AIが読んでいます。");
  expect(reading).not.toContain("手元の当番表を写真やファイルで送れます。");
  await env.DB.prepare("UPDATE jobs SET status = 'done' WHERE ward_id = ? AND job_id = ?").bind(ward.wardId, got.jobId).run();
  const done = await page();
  expect(done).toContain("届いた当番表「見回りの当番表.txt」から、担当の行を読み取れませんでした。");
  expect(done).toContain(`/intake/originals/${got.received[0]!.originalId}`);
});
