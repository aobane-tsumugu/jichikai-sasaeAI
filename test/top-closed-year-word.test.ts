import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

const thisYear = new Date(Date.now() + 9 * 3600_000).getUTCFullYear();

async function closedProject(year: number) {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "試しの秋の収穫祭", year, accountId: account.accountId });
  await env.DB.prepare("UPDATE projects SET closed_at = ?, closed_by_account_id = ? WHERE ward_id = ? AND project_id = ?")
    .bind(new Date().toISOString(), account.accountId, ward.wardId, project.projectId).run();
  return (await get(realApp, `/${ward.slug}/admin/`, cookie)).text();
}

it("今年終わりにした準備を、トップで「去年」と呼ばず、次の準備として始める道を出す", async () => {
  const top = await closedProject(thisYear);
  expect(top).toContain(`今年（${thisYear}年）は試しの秋の収穫祭を行い、終わりにしました。`);
  expect(top).toContain("次の試しの秋の収穫祭の準備を始める");
  expect(top).not.toContain(`去年（${thisYear}年）`);
});

it("去年の準備は、今までどおり去年と呼ぶ", async () => {
  const top = await closedProject(thisYear - 1);
  expect(top).toContain(`去年（${thisYear - 1}年）は試しの秋の収穫祭をしました。`);
  expect(top).toContain("今年の試しの秋の収穫祭の準備を始める");
});
