import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { replaceRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { get, postForm, realApp } from "./helpers";

it("免除の期間を間違えても入力が残り、終わりの日だけ直して保存できる", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const entries = [
    { household: "最初の世帯（架空）", district: "架空1班" },
    { household: "選んだ世帯（架空）", district: "架空2班" },
  ];
  await replaceRoster(env.DB, ward.wardId, entries, { household: 0, district: 1 });
  const path = `/${ward.slug}/admin/rota/exemptions`;
  const input = {
    household: JSON.stringify(entries[1]), reason: "架空の免除の理由",
    starts_on: "2026-11-01", ends_on: "2026-10-31",
  };
  const failed = await postForm(realApp, path, input, cookie);
  const page = failed.status === 303 ? await get(realApp, failed.headers.get("location")!, cookie) : failed;
  const html = await page.text();
  expect(html).toContain(`value="${input.reason}"`);
  expect(html).toContain(`value="${input.starts_on}"`);
  expect(html).toContain(`value="${input.ends_on}"`);
  expect(html).toMatch(/<option[^>]*selected[^>]*>架空2班 選んだ世帯（架空）<\/option>/);
  expect(html).toContain("もう一度保存してください");
  expect(failed.status).toBe(400);
  expect(failed.headers.get("location")).toBeNull();
  expect(failed.headers.get("cache-control")).toContain("no-store");
  const rows = () => env.DB.prepare("SELECT household, district, reason, starts_on, ends_on FROM rota_exemptions WHERE ward_id = ?")
    .bind(ward.wardId).all();
  expect((await rows()).results).toHaveLength(0);

  const saved = await postForm(realApp, path, { ...input, ends_on: "2026-12-31" }, cookie);
  expect(saved.status).toBe(303);
  expect(saved.headers.get("location")).toBe(`${path}?saved=1`);
  expect((await rows()).results).toEqual([{
    ...entries[1], reason: input.reason, starts_on: input.starts_on, ends_on: "2026-12-31",
  }]);
});
