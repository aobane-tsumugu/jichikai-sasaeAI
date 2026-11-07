import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("消す求めの画面で用途と行事を消す操作の説明を開ける", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の説明確認用の行事", year: 2026, accountId: account.accountId,
  });
  const page = await get(realApp, `/${ward.slug}/admin/settings/deletion`, cookie);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('<summary>説明を読む</summary>');
  expect(html).toContain('<details class="hint">');
  expect(html).toContain("住民から消してほしいと頼まれたものを、ここで選んで消します。消すと元に戻せません。");
  expect(html).toContain("元の資料、出欠の返事、知らせた案内などをまとめて消し、元には戻せません。");
});
