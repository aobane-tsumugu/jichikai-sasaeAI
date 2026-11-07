import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { get, realApp } from "./helpers";

it("送る画面で用途の短い説明を読める", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const page = await get(realApp, `/${ward.slug}/admin/intake`, cookie);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('<p class="lead">去年の資料も、今年のものも送れます。いくつでも一度に送れます。分類も名前付けもいりません。</p>');
  expect(html).toContain("電話や立ち話で決まったことを書く");
  expect(html).not.toContain('name="project_id"><option');
});
