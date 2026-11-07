import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { replaceRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { addExemption } from "../src/rota/store";
import { get, realApp } from "./helpers";

it("年をまたぐ役員交代を日本時間の年で表示し、日付だけの免除の期間も正しく読める", async () => {
  // 名前、役、交代日時と免除の理由は試験用の架空のもの。
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const household = { household: account.name, district: "1班" };
  await replaceRoster(env.DB, ward.wardId, [household], { household: 0, district: 1 });
  const changes = [
    { previous: null, next: "架空の書記", at: "2026-12-31T14:30:00Z" },
    { previous: "架空の書記", next: null, at: "2026-12-31T15:30:00Z" },
  ];
  await env.DB.batch(changes.map((change) => env.DB.prepare(`INSERT INTO rota_seat_changes
    (change_id, ward_id, account_id, name, previous_title, next_title, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), ward.wardId, account.accountId, account.name, change.previous, change.next, change.at)));

  const root = `/${ward.slug}/admin/rota`;
  const history = await get(realApp, `${root}/history`, cookie);
  expect(history.status).toBe(200);
  const html = await history.text();
  expect(html).toContain("架空の書記");
  expect(html).toContain("2026年12月31日（木）から2027年1月1日（金）まで");
  expect(html).not.toContain("2026年1月1日（金）");

  expect(await addExemption(env.DB, ward.wardId, account.accountId, {
    ...household, reason: "試験用の架空の免除", startsOn: "2026-12-31", endsOn: "2027-01-01",
  })).toBe(true);
  const exemptions = await get(realApp, `${root}/exemptions`, cookie);
  expect(exemptions.status).toBe(200);
  expect(await exemptions.text()).toContain("2026年12月31日（木）から2027年1月1日（金）まで");
});
