import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("閉じたプロジェクトを開き直し、残っている報告を直して保存できる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "開き直す行事（架空）", year: 2026, accountId: account.accountId,
  });
  const root = `/${ward.slug}/admin/close/${project.projectId}`;
  expect((await get(realApp, root, cookie)).status).toBe(200);
  expect((await postForm(realApp, `${root}/report/public`, { body: "閉じる前の報告（架空）" }, cookie)).status).toBe(303);
  expect((await postForm(realApp, `${root}/finalize`, {}, cookie)).status).toBe(303);
  const closed = await get(realApp, root, cookie);
  expect(await closed.text()).toContain("もう一度開く</button>");
  expect((await postForm(realApp, `${root}/reopen`, {}, cookie)).status).toBe(303);
  const reopened = await get(realApp, root, cookie);
  const html = await reopened.text();
  expect(html).toContain("閉じる前の報告（架空）");
  expect(html).toContain("閉じて記録に残す</button>");
  expect((await postForm(realApp, `${root}/report/public`, { body: "直した報告（架空）" }, cookie)).status).toBe(303);
  expect(await env.DB.prepare("SELECT body FROM project_close_reports WHERE ward_id = ? AND project_id = ? AND scope = 'public'")
    .bind(ward.wardId, project.projectId).first("body")).toBe("直した報告（架空）");
  expect(await env.DB.prepare("SELECT closed_at, closed_by_account_id FROM projects WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, project.projectId).first()).toMatchObject({ closed_at: null, closed_by_account_id: null });
});
