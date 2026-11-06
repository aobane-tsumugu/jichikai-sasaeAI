import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { writeDailyWardSnapshots } from "../src/archive/snapshot";
import { WardBucket } from "../src/core/storage";
import { seedAdmin } from "../src/core/testing";
import { exportWard } from "../src/ops/lifecycle";
import { createProject } from "../src/project/api";
import { postForm, realApp } from "./helpers";

it("保存した問い合わせ・行政の答え・年間帳簿・活動紹介が書き出しと日次の写しに入る", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "city_request", title: "架空の行政の依頼", year: 2026, accountId: account.accountId,
  });
  const root = `/${ward.slug}/admin`;
  expect((await postForm(realApp, `${root}/inquiries`, {
    receivedAt: "2026-11-05", kind: "inquiry", subject: "架空の問い合わせ", answer: "架空の対応記録",
  }, cookie)).status).toBe(303);
  expect((await postForm(realApp, `${root}/requests/city/${project.projectId}`, {
    operation: "save", answerDraft: "架空の答えの下書き", dueOn: "2026-11-30",
  }, cookie)).status).toBe(303);
  // 後回しになった帳簿の既存データも、書き出しから落とさない。
  await env.DB.prepare(`INSERT INTO ward_annual_budgets (ward_id, year, budget_income, budget_expense, settlement_draft, updated_at, updated_by_account_id)
    VALUES (?, 2026, 12000, 10000, '架空の決算の下書き', '2026-11-05', ?)`).bind(ward.wardId, account.accountId).run();
  expect((await postForm(realApp, `${root}/close/${project.projectId}/activity`, {
    action: "save", introduction: "架空の活動紹介",
  }, cookie)).status).toBe(303);

  const exported = JSON.parse((await exportWard(env, ward.wardId)).body) as { tables: Record<string, unknown[]> };
  await writeDailyWardSnapshots(env, new Date("2026-11-05T00:00:00.000Z"));
  const object = await new WardBucket(env.ORIGINALS, ward.wardId).get("snapshots/daily/2026-11-05.json");
  expect(object).not.toBeNull();
  const snapshot = await object!.json<{ tables: Record<string, unknown[]> }>();
  for (const { tables } of [exported, snapshot]) {
    expect(tables.inquiry_records).toEqual([expect.objectContaining({ ward_id: ward.wardId, subject: "架空の問い合わせ", answer: "架空の対応記録" })]);
    expect(tables.city_request_details).toEqual([expect.objectContaining({ ward_id: ward.wardId, project_id: project.projectId, answer_draft: "", due_on: "2026-11-30" })]);
    expect(tables.document_versions).toEqual(expect.arrayContaining([expect.objectContaining({ ward_id: ward.wardId, project_id: project.projectId, body: expect.stringContaining("架空の答えの下書き") })]));
    expect(tables.ward_annual_budgets).toEqual([expect.objectContaining({ ward_id: ward.wardId, year: 2026, budget_income: 12000, budget_expense: 10000, settlement_draft: "架空の決算の下書き" })]);
    expect(tables.project_activity_pages).toEqual([expect.objectContaining({ ward_id: ward.wardId, project_id: project.projectId, draft_body: expect.stringContaining("架空の活動紹介") })]);
  }
});
