import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { CRON } from "../src/core/cron";
import { WardBucket } from "../src/core/storage";
import { seedAdmin, seedSeat, seedWard } from "../src/core/testing";
import { requestWardDeletion, runDeletionCron } from "../src/ops/lifecycle";
import { applyChange, createProject } from "../src/project/api";
import { postForm, realApp } from "./helpers";

it("行政の記録・席・段取りの進み具合がある区も、保管物と一緒に消して印だけ残せる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const otherWard = await seedWard(env.DB);
  const seatId = await seedSeat(env.DB, ward.wardId, "架空の書記");
  await env.DB.prepare("UPDATE accounts SET seat_id = ? WHERE ward_id = ? AND account_id = ?")
    .bind(seatId, ward.wardId, account.accountId).run();
  const event = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の行事", year: 2026, accountId: account.accountId,
  });
  expect((await applyChange(env.DB, ward.wardId, event.projectId, {
    kind: "map_task", taskKey: "venue", progress: "done", source: { kind: "person", accountId: account.accountId },
    confidence: "high", packVersion: "ward-deletion-test@1",
  })).status).toBe("applied");
  const city = await createProject(env.DB, ward.wardId, {
    kind: "city_request", title: "架空の行政の依頼", year: 2026, accountId: account.accountId,
  });
  const root = `/${ward.slug}/admin`;
  expect((await postForm(realApp, `${root}/inquiries`, {
    receivedAt: "2026-11-05", kind: "request", subject: "架空の要望", answer: "架空の対応記録",
  }, cookie)).status).toBe(303);
  expect((await postForm(realApp, `${root}/requests/city/${city.projectId}`, {
    operation: "save", answerDraft: "架空の答えの下書き",
  }, cookie)).status).toBe(303);
  // 入力画面を外しても、以前の帳簿の記録を消す処理は保つ。
  await env.DB.prepare(`INSERT INTO ward_annual_budgets (ward_id, year, budget_income, budget_expense, settlement_draft, updated_at, updated_by_account_id)
    VALUES (?, 2026, 12000, 10000, '架空の決算の下書き', '2026-11-05', ?)`).bind(ward.wardId, account.accountId).run();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO ward_ai_route_flags (ward_id, updated_at) VALUES (?, '2026-11-05')").bind(ward.wardId),
    env.DB.prepare("INSERT INTO line_group_notices (ward_id, group_id, first_joined_at) VALUES (?, 'fictional-group', '2026-11-05')").bind(ward.wardId),
  ]);
  const bucket = new WardBucket(env.ORIGINALS, ward.wardId);
  const otherBucket = new WardBucket(env.ORIGINALS, otherWard.wardId);
  await bucket.put("originals/fictional.txt", "架空の保管物");
  await otherBucket.put("originals/fictional.txt", "架空の残す保管物");
  const queueId = await requestWardDeletion(env.DB, ward.wardId);
  let pending: { state: string } | null = null;
  for (let i = 0; i < 6; i++) {
    await runDeletionCron({ cron: CRON.EVERY_5_MIN } as ScheduledController, env);
    pending = await env.DB.prepare("SELECT state FROM ops_deletion_queue WHERE ward_id = ? AND queue_id = ?")
      .bind(ward.wardId, queueId).first<{ state: string }>();
    if (!pending || pending.state === "error") break;
  }
  expect(pending).toBeNull();
  expect(await env.DB.prepare("SELECT ward_id FROM wards WHERE ward_id = ?").bind(ward.wardId).first()).toBeNull();
  expect((await bucket.list("")).keys).toEqual([]);
  expect(await env.DB.prepare("SELECT scope FROM ops_deletion_marks WHERE ward_id = ?").bind(ward.wardId).all()).toMatchObject({ results: [{ scope: "ward" }] });
  expect(await env.DB.prepare("SELECT ward_id FROM wards WHERE ward_id = ?").bind(otherWard.wardId).first()).not.toBeNull();
  expect(await (await otherBucket.get("originals/fictional.txt"))!.text()).toBe("架空の残す保管物");
});
