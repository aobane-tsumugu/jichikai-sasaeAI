import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { applyChange, createProject, getProjectState } from "../src/project/api";
import { getMemoRows } from "../src/map/memo";
import { get, realApp } from "./helpers";

it("協賛の収入は費用に数えず、同じ何にの去年の行は一行に読む", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "試しの収支確認", year: 2026, accountId: account.accountId });
  const id = project.projectId;
  const source = { kind: "person" as const, accountId: account.accountId };
  const row = async (table: "ledger" | "sponsors", data: Record<string, string | number>, year?: number) => expect((await applyChange(env.DB, ward.wardId, id, {
    kind: "row", table, data, source: year ? { kind: "original", ref: "fictional", locator: null, year } as never : source, confidence: "high", packVersion: "memo-test@1",
  })).status).not.toBe("rejected");
  await row("ledger", { what: "試しの材料", counterpart: "商店", direction: "expense", amount: 14500, date: "2026-10-01" });
  await row("sponsors", { name: "協賛店" });
  await row("ledger", { what: "協賛", counterpart: "協賛店", direction: "income", amount: 6000 });
  await row("ledger", { what: "協賛", counterpart: "農園", direction: "income", amount: 3000 });
  const state = await getProjectState(env.DB, ward.wardId, id);
  const rows = await getMemoRows(env.DB, ward.wardId, state!);
  expect(rows.filter((entry) => entry.sponsor).map((entry) => [entry.name, entry.data.amount])).toEqual(expect.arrayContaining([["協賛店", 6000]]));
  expect(rows.filter((entry) => entry.sponsor)).toHaveLength(2);
  const page = await (await get(realApp, `/${ward.slug}/admin/projects/${id}/ledger`, cookie)).text();
  expect(page).toContain("分かっている費用は14,500円、協賛は9,000円です");
});
