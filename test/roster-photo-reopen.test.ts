import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { getRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { claimRead, finishRead } from "../src/intake/store";
import { get, postForm, realApp } from "./helpers";

it("同じ名簿の写真を送り直すと、前の読み取り結果を開いて名簿に取り込める", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode("架空の名簿の写真")]);
  const received = await receive(env, {
    wardId: ward.wardId, via: "system", readKind: "general",
    parts: [{ kind: "photo", filename: "架空の名簿.jpg", mediaType: "image/jpeg", bytes }],
  });
  const attempt = await claimRead(env.DB, ward.wardId, received.jobId!, 60_000);
  expect(attempt).not.toBeNull();
  // AI は呼ばず、架空の写真に対する読み取り結果を置く。
  expect(await finishRead(env.DB, {
    wardId: ward.wardId, jobId: received.jobId!, attempt: attempt!, source: "model", packVersion: "roster-test@1", model: "fixture",
    body: {
      document_kind: "roster", original_years: [{ original_id: received.received[0]!.originalId, year: 2026 }], summary: "架空の名簿",
      text_blocks: [], fields: [], decisions: [], unreadable: [],
      tables: [{ name: "架空の世帯", original_id: received.received[0]!.originalId, locator: "1枚目", columns: ["世帯", "班"], rows: [
        { cells: ["架空の世帯A", "1班"], locator: "1行目", confidence: "high" },
      ] }],
    },
  })).toBe(true);
  const root = `/${ward.slug}/admin/answers/roster`;
  const form = new FormData();
  form.set("photo", new File([bytes], "架空の名簿.jpg", { type: "image/jpeg" }));
  const response = await realApp.request(`${root}/photo`, {
    method: "POST", headers: { origin: "http://localhost", cookie }, body: form,
  }, env);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(`${root}?job=${received.jobId}`);
  const page = await get(realApp, response.headers.get("location")!, cookie);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("架空の世帯A");
  expect((await postForm(realApp, `${root}/photo/import`, { jobId: received.jobId!, tableIndex: "0" }, cookie)).status).toBe(303);
  expect(await getRoster(env.DB, ward.wardId)).toEqual([{ household: "架空の世帯A", district: "1班" }]);
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM originals WHERE ward_id = ?").bind(ward.wardId).first())
    .toEqual({ count: 1 });
});
