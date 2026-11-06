import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { seedAdmin } from "../src/core/testing";
import { replyLineText } from "../src/line/api";
import { lineQuotaAllows } from "../src/line/clarifications";
import { sendOfficerDigest } from "../src/line/digest";
import { getSetting, setSetting } from "../src/settings/store";
import { withEnv } from "./helpers";

it("朝の知らせは有料の上限まで200通を超えて送り、上限なしとReplyを区別する", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const group = "C-fictional-u27-officers";
  await setSetting(env.DB, ward.wardId, "line.officer_group", group);
  await env.DB.prepare(`INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding)
    VALUES (?, ?, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN')`)
    .bind(ward.wardId, crypto.randomUUID()).run();
  const runtime = withEnv({ LINE_CHANNEL_ACCESS_TOKEN: "fictional-u27-token", PUBLIC_BASE_URL: "https://example.invalid" });
  for (const received of ["2026-11-06T01:00:00Z", "2026-11-07T01:00:00Z"]) {
    await env.DB.prepare(`INSERT INTO inquiry_records
      (ward_id, inquiry_id, received_at, kind, subject, answer, created_by_account_id, created_at)
      VALUES (?, ?, ?, 'inquiry', ?, '', ?, ?)`)
      .bind(ward.wardId, crypto.randomUUID(), received, fixture.publicDayText, account.accountId, received).run();
  }
  let quota: { type: "limited"; value: number } | { type: "none" } = { type: "limited", value: 5000 };
  let used = 4996;
  let quotaReads = 0;
  let replies = 0;
  const pushes: Array<{ to: string; messages: Array<{ text: string }> }> = [];
  const fakeLine: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/message/quota")) { quotaReads++; return Response.json(quota); }
    if (url.endsWith("/message/quota/consumption")) return Response.json({ totalUsage: used });
    if (url.endsWith("/members/count")) return Response.json({ count: 4 });
    if (url.endsWith("/message/reply")) { replies++; return Response.json({}); }
    if (url.endsWith("/message/push")) {
      pushes.push(JSON.parse(String(init?.body)) as { to: string; messages: Array<{ text: string }> });
      return Response.json({});
    }
    throw new Error("試験にない外への呼び出しです");
  };
  const sentRows = async () => (await env.DB.prepare(`SELECT day, recipients, usage_before, sent_at
    FROM line_officer_digests WHERE ward_id = ? ORDER BY day`).bind(ward.wardId)
    .all<{ day: string; recipients: number; usage_before: number; sent_at: string | null }>()).results;
  const first = new Date("2026-11-06T23:00:00Z");
  await sendOfficerDigest(runtime, ward.wardId, ward.slug, first, fakeLine);
  expect(pushes).toHaveLength(1);
  expect(pushes[0]?.to).toBe(group);
  expect(pushes[0]?.messages[0]?.text).toContain(`/${ward.slug}/admin/inquiries`);
  expect(await sentRows()).toEqual([{ day: "2026-11-07", recipients: 4, usage_before: 4996, sent_at: first.toISOString() }]);

  // LINEの集計がまだ増えなくても、保存した5000通を基準に止める。
  const next = new Date("2026-11-07T23:00:00Z");
  await sendOfficerDigest(runtime, ward.wardId, ward.slug, next, fakeLine);
  expect(pushes).toHaveLength(1);
  expect(await getSetting(env.DB, ward.wardId, "line.delivery_alert.digest")).toContain("通数が足りない");

  const beforeReply = quotaReads;
  await replyLineText("fictional-u27-token", "fictional-u27-reply", fixture.publicDayText, fakeLine);
  expect(replies).toBe(1);
  expect(quotaReads).toBe(beforeReply);
  expect(await sentRows()).toHaveLength(1);

  quota = { type: "none" };
  used = 50000;
  await sendOfficerDigest(runtime, ward.wardId, ward.slug, next, fakeLine);
  await sendOfficerDigest(runtime, ward.wardId, ward.slug, next, fakeLine);
  expect(pushes).toHaveLength(2);
  expect(await sentRows()).toEqual([
    { day: "2026-11-07", recipients: 4, usage_before: 4996, sent_at: first.toISOString() },
    { day: "2026-11-08", recipients: 4, usage_before: 50000, sent_at: next.toISOString() },
  ]);
  expect(await getSetting(env.DB, ward.wardId, "line.delivery_alert.digest")).toBeNull();
});

it("質問の送信は、有料のプランの上限と上限なしのプランでも止まらない", () => {
  expect(lineQuotaAllows({ type: "limited", value: 5000 }, { totalUsage: 300 }, 7)).toBe(true);
  expect(lineQuotaAllows({ type: "limited", value: 200 }, { totalUsage: 198 }, 7)).toBe(false);
  expect(lineQuotaAllows({ type: "none" }, { totalUsage: 100000 }, 7)).toBe(true);
  expect(lineQuotaAllows({}, { totalUsage: 0 }, 7)).toBe(false);
});
