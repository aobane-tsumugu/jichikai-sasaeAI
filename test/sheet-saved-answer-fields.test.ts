import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { listAnswers } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { claimRead, finishRead } from "../src/intake/store";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("回答票で人が直した内容が、開き直した入力欄とそのままの再送信でも残る", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の回答票の確認", year: 2026, accountId: account.accountId,
  });
  const received = await receive(env, {
    wardId: ward.wardId, projectId: project.projectId, via: "admin", readKind: "answer_sheet", accountId: account.accountId,
    parts: [{ kind: "photo", filename: "架空の回答票.jpg", mediaType: "image/jpeg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 3]) }],
  });
  const originalId = received.received[0]!.originalId;
  const attempt = await claimRead(env.DB, ward.wardId, received.jobId!, 60_000);
  expect(attempt).not.toBeNull();
  // AI は呼ばず、架空の写真の読み取り結果を置く。
  expect(await finishRead(env.DB, {
    wardId: ward.wardId, jobId: received.jobId!, attempt: attempt!, source: "model", packVersion: "sheet-fields-test@1", model: "fixture",
    body: { summary: "架空の回答票", unreadable: [], rows: [{
      household_name: "架空の読み取り世帯", ward_group: "架空の一班", adults: 2, children: 1,
      helper_names: ["架空の手伝う人"], helper_slots: ["受付"], note: "", confidence: "high", original_id: originalId, locator: "1行目",
    }] },
  })).toBe(true);
  const path = `/${ward.slug}/admin/answers/${project.projectId}`;
  const rowPath = `${path}/sheet/${originalId}/row/0`;
  const corrected = { attend: "no", household: "架空の直した世帯", district: "架空の二班", children_count: "0", adults_count: "0", seniors_count: "0", helper_name: "", helper_times: "" };
  expect((await postForm(realApp, rowPath, corrected, cookie)).status).toBe(303);
  const before = await listAnswers(env.DB, ward.wardId, project.projectId);
  const page = await get(realApp, `${path}?view=list`, cookie);
  expect(page.status).toBe(200);
  const html = await page.text();
  const form = [...html.matchAll(/<form\b[^>]*action="([^"]*)"[^>]*>([\s\S]*?)<\/form>/g)]
    .find((match) => match[1] === rowPath)?.[2];
  expect(form).toBeDefined();
  const fields: Record<string, string> = {};
  for (const [input] of form!.matchAll(/<input\b[^>]*>/g)) {
    if (/type="radio"/.test(input) && !/checked/.test(input)) continue;
    const name = /name="([^"]*)"/.exec(input)?.[1];
    const value = /value="([^"]*)"/.exec(input)?.[1];
    if (name && value !== undefined) fields[name] = value;
  }
  expect(fields).toMatchObject(corrected);
  expect((await postForm(realApp, rowPath, fields, cookie)).status).toBe(303);
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toEqual(before);
});
