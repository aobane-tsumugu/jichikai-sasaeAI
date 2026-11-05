import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { findFragments, searchArchive } from "../src/archive/search";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { createProject } from "../src/project/api";
import { postForm, realApp } from "./helpers";

it("取り下げた資料は記録の検索と根拠から消え、ほかの資料は探せる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の防災の準備", year: 2026, accountId: account.accountId,
  });
  const send = (text: string) => receive(env, {
    wardId: ward.wardId, projectId: project.projectId, via: "admin", accountId: account.accountId,
    parts: [{ kind: "text", filename: "架空の連絡.txt", mediaType: "text/plain", bytes: new TextEncoder().encode(text) }],
  });
  const withdrawn = await send("架空の備品を手配しました。");
  await send("架空の会場を予約しました。");
  expect((await searchArchive(env.DB, ward.wardId, { query: "備品" })).length).toBeGreaterThan(0);
  expect((await findFragments(env.DB, ward.wardId, "備品は？", 8)).length).toBeGreaterThan(0);
  expect((await postForm(realApp, `/${ward.slug}/admin/intake/${withdrawn.jobId}/withdraw`, {}, cookie)).status).toBe(303);
  expect(await searchArchive(env.DB, ward.wardId, { query: "備品" })).toEqual([]);
  expect(await findFragments(env.DB, ward.wardId, "備品は？", 8)).toEqual([]);
  expect((await searchArchive(env.DB, ward.wardId, { query: "会場" })).length).toBeGreaterThan(0);
});
