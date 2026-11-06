import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("消す求めの画面で用途とプロジェクトを消す操作の説明を開ける", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の説明確認用の行事", year: 2026, accountId: account.accountId,
  });
  const page = await get(realApp, `/${ward.slug}/admin/settings/deletion`, cookie);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('<summary>説明を読む</summary>');
  expect(html).toContain('<details class="hint">');
  expect(html).toContain("消してほしいと頼まれた記録や、不要なプロジェクトを消す画面です。題や日時で対象を選んでください。");
  expect(html).toContain("原本、回答、配った案内などをプロジェクトごと消し、元には戻せません。");
});
