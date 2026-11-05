import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Reading } from "../src/ai/schema";
import { getRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { get, postForm, realApp } from "./helpers";

it("写真の読み取りの先に空の表があっても、選んだ表の世帯を名簿に取り込める", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const received = await receive(env, {
    wardId: ward.wardId, via: "system", accountId: account.accountId,
    parts: [{ kind: "text", filename: "架空の名簿の読み取り", mediaType: "text/plain", bytes: new TextEncoder().encode("架空の名簿") }],
  });
  const originalId = received.received[0]!.originalId;
  const reading: Reading = {
    document_kind: "roster", original_years: [{ original_id: originalId, year: 2026 }], summary: "架空の名簿の写真から読んだ表",
    text_blocks: [], fields: [], decisions: [], unreadable: [],
    tables: [
      { name: "架空の空の表", original_id: originalId, locator: "上", columns: ["世帯", "班"], rows: [] },
      { name: "架空の世帯の表", original_id: originalId, locator: "下", columns: ["世帯", "班"], rows: [
        { cells: ["架空の世帯A", "1班"], locator: "1行目", confidence: "high" },
      ] },
    ],
  };
  // AI は呼ばず、写真から返った読み取りを置く。
  await env.DB.prepare("UPDATE readings SET body = ? WHERE ward_id = ? AND job_id = ?")
    .bind(JSON.stringify(reading), ward.wardId, received.jobId).run();
  const root = `/${ward.slug}/admin/answers/roster`;
  const page = await get(realApp, `${root}?job=${received.jobId}`, cookie);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("架空の世帯A");
  expect(html).not.toContain("架空の空の表");
  const tableIndex = /name="tableIndex" value="(\d+)"/.exec(html)?.[1];
  expect(tableIndex).toBe("1");
  expect((await postForm(realApp, `${root}/photo/import`, { jobId: received.jobId!, tableIndex: tableIndex! }, cookie)).status).toBe(303);
  expect((await getRoster(env.DB, ward.wardId)).map(({ household, district }) => ({ household, district })))
    .toEqual([{ household: "架空の世帯A", district: "1班" }]);
});
