import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { get, realApp } from "./helpers";

it("送る画面で用途の短い説明を開ける", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const page = await get(realApp, `/${ward.slug}/admin/intake`, cookie);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('aria-label="説明"');
  expect(html).toContain('popover="auto"');
  expect(html).toContain("資料を撮るか、ファイルや一行の文を送る画面です。分かる時だけ送り先のプロジェクトを選んでください。");
});
