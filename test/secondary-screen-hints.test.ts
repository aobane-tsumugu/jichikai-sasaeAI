import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("住民から頼まれたものを消す画面は名前で探す形で、準備を丸ごと消す操作はやることの画面の一番下にある", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "試しの説明確認用の行事", year: 2026, accountId: account.accountId,
  });
  const page = await get(realApp, `/${ward.slug}/admin/settings/deletion`, cookie);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("住民の方から「自分の分を消してほしい」と頼まれたときに使います。消すと元に戻せません。");
  expect(html).toContain("頼んだ方のお名前");
  expect(html).not.toContain("「試しの説明確認用の行事」を");
  const map = await (await get(realApp, `/${ward.slug}/admin/projects/${project.projectId}/map`, cookie)).text();
  expect(map).toContain("<summary>この準備を丸ごと消す</summary>");
  expect(map).toContain(`action="/${ward.slug}/admin/settings/deletion/projects/${project.projectId}"`);
});
