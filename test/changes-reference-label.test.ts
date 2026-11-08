import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { applyChange, createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("去年の資料から参考として入った値は、変わったところに「去年の参考として入れました」と書き、今年の資料の値だけ「今年の内容に入れました」と書く", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "年末の見回り", year: 2026, accountId: account.accountId });
  await applyChange(env.DB, ward.wardId, project.projectId, {
    kind: "item", itemKey: "date_time", value: "2025年12月26日（金）から28日（日）まで",
    source: { kind: "original", ref: "o-last-year", locator: "表1/1行目", year: 2025 }, confidence: "high", packVersion: "test@1",
  });
  await applyChange(env.DB, ward.wardId, project.projectId, {
    kind: "item", itemKey: "place", value: "集会所の前",
    source: { kind: "original", ref: "o-this-year", locator: "1行目", year: 2026 }, confidence: "high", packVersion: "test@1",
  });
  await applyChange(env.DB, ward.wardId, project.projectId, {
    kind: "item", itemKey: "belongings", value: "懐中電灯",
    source: { kind: "original", ref: "o-no-year", locator: "2行目" }, confidence: "high", packVersion: "test@1",
  });
  const page = await (await get(realApp, `/${ward.slug}/admin/projects/${project.projectId}`, cookie)).text();
  expect(page).toContain("去年の参考として入れました（表1/1行目）");
  expect(page).toContain("今年の内容に入れました（1行目）");
  expect(page).toContain("年の分からない資料の参考として入れました（2行目）");
  expect(page).not.toContain("今年の内容に入れました（表1/1行目）");
});
