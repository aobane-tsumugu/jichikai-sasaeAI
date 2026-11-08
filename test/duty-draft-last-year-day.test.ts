import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { applyChange, createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("当番表の下書きを初めて開いたとき、「いつ」に去年の日を入れず、欄の下に去年の日を書く。場所は去年の資料から入れる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "年末の見回り", year: 2026, accountId: account.accountId });
  for (const [itemKey, value, locator] of [["date_time", "2025年12月26日（金）から28日（日）まで", "表1/1行目"], ["place", "集会所の前", "表1/2行目"]] as const) {
    await applyChange(env.DB, ward.wardId, project.projectId, {
      kind: "item", itemKey, value, source: { kind: "original", ref: "o-last-year", locator, year: 2025 }, confidence: "high", packVersion: "test@1",
    });
  }
  const page = await (await get(realApp, `/${ward.slug}/admin/projects/${project.projectId}/draft/duty_roster`, cookie)).text();
  expect(page).toMatch(/<input id="item-date_time" name="item_date_time" value=""/);
  expect(page).toContain("去年は2025年12月26日（金）から28日（日）まででした。");
  expect(page).toMatch(/<input id="item-place" name="item_place" value="集会所の前"/);
});
