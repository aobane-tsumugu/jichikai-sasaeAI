import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { applyChange, createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("一年の画面は十以上を「つ」で数えず、日の決まっていない準備の行に、年間の予定の月と去年の資料の日を書く", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const year = async () => (await get(realApp, `/${ward.slug}/admin/year`, cookie)).text();
  const empty = await year();
  expect(empty).toMatch(/今は、よくある自治会の例を\d+件仮に置いています。/);
  expect(empty).not.toMatch(/\d{2}つ/);

  await env.DB.prepare("INSERT INTO ward_year_items (ward_id, item_id, title, month, added) VALUES (?, ?, ?, 12, 1)").bind(ward.wardId, crypto.randomUUID(), "年末の見回り").run();
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "年末の見回り", year: 2026, accountId: account.accountId });
  const got = await receive(env, { wardId: ward.wardId, projectId: project.projectId, via: "admin", parts: [
    { kind: "text", filename: "見回りのお知らせ.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("去年の年末の見回りのお知らせ") },
  ] });
  const ref = got.received[0]!.originalId;
  await applyChange(env.DB, ward.wardId, project.projectId, { kind: "item", itemKey: "date_time", value: "12月26日（金）から28日（日）まで", confidence: "high", packVersion: "test@1",
    source: { kind: "original", ref, year: 2025, locator: "段落7" } });
  const page = await year();
  expect(page).toContain("年間の予定では12月です。日はまだ決まっていません。去年の資料では12月26日（金）から28日（日）まででした。");
});
