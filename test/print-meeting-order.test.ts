import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("役員会の記入欄は、開いた準備の紙が最初に出て、下の帯は印刷した日になる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の先に作った祭り", year: 2026, accountId: account.accountId });
  const later = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の後に作った訓練", year: 2026, accountId: account.accountId });
  const html = await (await get(realApp, `/${ward.slug}/admin/print/${later.projectId}/paper/meeting`, cookie)).text();
  const first = html.indexOf("架空の後に作った訓練 役員会の記入欄");
  const second = html.indexOf("架空の先に作った祭り 役員会の記入欄");
  expect(first).toBeGreaterThan(0);
  expect(second).toBeGreaterThan(first);
  expect(html).toContain("に印刷しました");
  expect(html).not.toContain("に配りました");
  const list = await (await get(realApp, `/${ward.slug}/admin/print/${later.projectId}`, cookie)).text();
  expect(list).toContain("この準備の紙が最初です");
});
