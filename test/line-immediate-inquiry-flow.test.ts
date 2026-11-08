import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { sendOfficerDigest } from "../src/line/digest";
import { immediateInquiryText, inquiryNoticeKey, sendPendingInquiryNotices } from "../src/line/inquiry-notice";
import type { LineIntakePorts } from "../src/line/intake";
import { acceptLineWebhook } from "../src/line/webhook";
import { getSetting, setSetting } from "../src/settings/store";
import { withEnv } from "./helpers";
import { recordLineInquiry } from "../src/project/followup";

type Message = { type: string; text?: string };
type Delivery = { to?: string; replyToken?: string; messages: Message[] };
type Event = {
  type: "message"; webhookEventId: string; timestamp: number; replyToken: string;
  source: { type: "user"; userId: string };
  message: { type: "text" | "image"; id: string; text?: string; imageSet?: { id: string; total: number; index: number } };
};

async function setup(hasGroup = true) {
  const { ward } = await seedAdmin(env.DB);
  const now = new Date("2026-11-06T01:00:00.000Z");
  const destination = crypto.randomUUID();
  const group = "test-u102-officers";
  const runtime = withEnv({ LINE_CHANNEL_SECRET: "test-u102-secret", LINE_CHANNEL_ACCESS_TOKEN: "test-u102-token", PUBLIC_BASE_URL: "https://example.invalid" });
  await env.DB.prepare(`INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding)
    VALUES (?, ?, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN')`).bind(ward.wardId, destination).run();
  if (hasGroup) await setSetting(env.DB, ward.wardId, "line.officer_group", group);
  const pushes: Delivery[] = [];
  const replies: Delivery[] = [];
  let used = 0;
  let limit: number | null = 200;
  let failure: "http" | "network" | "quota" | null = null;
  let displayName: string | null = "送信者";
  let matchCalls = 0;
  const fakeLine: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("api-data.line.me")) return new Response(new Uint8Array([...fixture.answerSheetPhotoBytes, ...new TextEncoder().encode(url)]), { headers: { "content-type": "image/jpeg" } });
    if (url.includes("/profile/")) return displayName ? Response.json({ displayName }) : new Response(null, { status: 404 });
    if (url.endsWith("/message/quota")) {
      if (failure === "quota") throw new Error("通数を取得できません");
      return Response.json(limit === null ? { type: "none" } : { type: "limited", value: limit });
    }
    if (url.endsWith("/consumption")) return Response.json({ totalUsage: used });
    if (url.endsWith("/members/count")) return Response.json({ count: 3 });
    if (url.endsWith("/message/reply")) { replies.push(JSON.parse(String(init?.body)) as Delivery); return Response.json({}); }
    if (url.endsWith("/message/push")) {
      pushes.push(JSON.parse(String(init?.body)) as Delivery);
      if (failure === "network") throw new Error("送信の応答がありません");
      return failure === "http" ? new Response(null, { status: 500 }) : Response.json({});
    }
    throw new Error("試験にないLINEの呼び出しです");
  };
  const ports: LineIntakePorts = {
    matchInboxItem: async () => { matchCalls++; return { disposition: "unmatched", inquiry: true }; },
    receiveOriginal: async (_wardId, original) => {
      if (original.kind !== "image" || !original.bytes) throw new Error("問い合わせの文に読み取りの仕事を作ってはいけません");
      const result = await receive(runtime, { wardId: ward.wardId, via: "line_direct", parts: [{ kind: "photo", filename: "問い合わせ.jpg",
        mediaType: "image/jpeg", bytes: new Uint8Array(original.bytes) }] });
      if (!result.jobId) throw new Error("問い合わせの写真を受け付けられませんでした");
      return result.jobId;
    },
    readPhoto: async () => undefined,
    assignProject: async () => { throw new Error("問い合わせを準備に入れてはいけません"); },
    discard: async () => { throw new Error("問い合わせを捨ててはいけません"); },
  };
  const event = (id: string, text = "集合場所を教えてください。"): Event => ({
    type: "message", webhookEventId: id, timestamp: now.getTime(), replyToken: `${id}-reply`,
    source: { type: "user", userId: "test-u102-resident" }, message: { type: "text", id, text },
  });
  const send = async (events: Event[], at = now) => {
    const body = JSON.stringify({ destination, events });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(runtime.LINE_CHANNEL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
    expect((await acceptLineWebhook(new Request("https://example.invalid/hooks/line", { method: "POST", headers: { "x-line-signature": signature }, body }),
      runtime, env.DB, { fetch: fakeLine, ports }, at)).status).toBe(200);
  };
  const records = async () => (await env.DB.prepare("SELECT inquiry_id, subject FROM inquiry_records WHERE ward_id = ?")
    .bind(ward.wardId).all<{ inquiry_id: string; subject: string }>()).results;
  const digest = (at = new Date("2026-11-06T23:00:00.000Z")) => sendOfficerDigest(runtime, ward.wardId, ward.slug, at, fakeLine);
  return { ward, runtime, now, group, pushes, replies, send, event, records, digest, fakeLine,
    setUsed: (value: number) => { used = value; }, setLimit: (value: number | null) => { limit = value; },
    setFailure: (value: typeof failure) => { failure = value; }, setName: (value: string | null) => { displayName = value; },
    matchCalls: () => matchCalls };
}

it("U102: 署名付きの問い合わせを一通だけ役員グループへ送り、再送と朝の知らせに重ねない", async () => {
  const s = await setup();
  const e = s.event("test-u102-text");
  await s.send([e]);
  await s.send([e]);
  const rows = await s.records();
  expect(rows).toHaveLength(1);
  expect(s.matchCalls()).toBe(1);
  expect(s.pushes).toEqual([{ to: s.group, messages: [{ type: "text", text: ["住民から問い合わせが届きました。", "送った人: 送信者さん",
    "「集合場所を教えてください。」", "返事は役員の画面の問い合わせから送れます。",
    `https://example.invalid/${s.ward.slug}/admin/inquiries/${rows[0]!.inquiry_id}`].join("\n") }] }]);
  expect(s.replies).toHaveLength(1);
  expect(s.replies[0]?.messages).toEqual([{ type: "text", text: "役員に伝えて、内容を確認します。" }]);
  await s.digest();
  expect(s.pushes).toHaveLength(1);
});

it("U102: 写真が別々に届いても全枚数を待って一通にし、写真そのものと後着分は送らない", async () => {
  const s = await setup();
  const photo = (id: string, index: number): Event => ({ ...s.event(id),
    message: { type: "image", id, imageSet: { id: "test-u102-set", total: 2, index } } });
  const first = photo("test-u102-photo-1", 1);
  const second = photo("test-u102-photo-2", 2);
  await s.send([s.event("test-u102-photo-text"), first]);
  expect(s.pushes).toHaveLength(0);
  await s.send([second]);
  expect(s.pushes).toHaveLength(1);
  expect(s.pushes[0]?.messages).toHaveLength(1);
  expect(s.pushes[0]?.messages[0]?.type).toBe("text");
  expect(s.pushes[0]?.messages[0]?.text).toContain("写真2枚が付いています。");
  expect(s.pushes[0]?.messages[0]?.text).toContain("集合場所を教えてください。");
  await s.send([second]);
  const later = photo("test-u102-later-photo", 1);
  later.message.imageSet = { id: "test-u102-later-set", total: 1, index: 1 };
  await s.send([later]);
  await s.digest();
  expect(s.pushes).toHaveLength(1);
});

it("U102: 写真の組番号がない時は既存の5秒の間を待ち、同時に呼ばれても一通だけ送る", async () => {
  const s = await setup();
  const photo = (id: string): Event => ({ ...s.event(id), message: { type: "image", id } });
  await s.send([s.event("test-u102-gap-text"), photo("test-u102-gap-1"), photo("test-u102-gap-2")]);
  expect(s.pushes).toHaveLength(0);
  const ready = new Date(s.now.getTime() + 5000);
  await Promise.all([
    sendPendingInquiryNotices(s.runtime, s.ward.wardId, ready, s.fakeLine),
    sendPendingInquiryNotices(s.runtime, s.ward.wardId, ready, s.fakeLine),
  ]);
  expect(s.pushes).toHaveLength(1);
  expect(s.pushes[0]?.messages[0]?.text).toContain("写真2枚が付いています。");
});

it("U102: 別の自治会と導入前の記録を即時送信せず、送れなかった古い問い合わせは朝に残す", async () => {
  const s = await setup();
  const other = await setup();
  for (const ward of [s.ward, other.ward]) await recordLineInquiry(env.DB, ward.wardId, {
    eventId: `test-u102-older-${ward.wardId}`, receivedAt: "2026-11-01T01:00:00.000Z", text: "以前届いた問い合わせです。",
    sourceType: "user", sourceId: "test-u102-older-user", senderLabel: null,
  });
  s.setFailure("quota");
  await s.send([s.event("test-u102-carry")]);
  expect(s.pushes).toHaveLength(0);
  s.setFailure(null);
  await sendPendingInquiryNotices(s.runtime, s.ward.wardId, s.now, s.fakeLine);
  expect(s.pushes).toHaveLength(0);
  // グループを指定できなかった日も、前日より前へ取り残さない。
  await s.digest(new Date("2026-11-08T23:00:00.000Z"));
  expect(s.pushes).toHaveLength(1);
  expect(s.pushes[0]?.to).toBe(s.group);
  expect(s.pushes[0]?.messages[0]?.text).toContain("問い合わせは1件です。");
  expect(other.pushes).toHaveLength(0);
});

for (const reason of ["near", "http", "network", "quota", "group"] as const) {
  it(`U102: ${reason}で即時送信できない問い合わせだけを朝に一度知らせる`, async () => {
    const s = await setup(reason !== "group");
    if (reason === "near") { s.setLimit(200); s.setUsed(195); }
    else if (reason !== "group") s.setFailure(reason);
    s.setName(null);
    const e = s.event(`test-u102-${reason}`);
    await s.send([e]);
    await s.send([e]);
    const attempts = reason === "http" || reason === "network" ? 1 : 0;
    expect(s.pushes).toHaveLength(attempts);
    expect(s.replies[0]?.messages[0]?.text).toBe("役員に伝えて、内容を確認します。");
    const rows = await s.records();
    expect(rows).toHaveLength(1);
    expect(JSON.parse((await getSetting(env.DB, s.ward.wardId, inquiryNoticeKey(rows[0]!.inquiry_id)))!).status).toBe("fallback");
    if (attempts) expect(s.pushes[0]?.messages[0]?.text).not.toContain("送った人:");
    s.setFailure(null);
    if (reason === "group") {
      await s.digest();
      expect(s.pushes).toHaveLength(0);
      await setSetting(env.DB, s.ward.wardId, "line.officer_group", s.group);
    }
    await s.digest();
    expect(s.pushes).toHaveLength(attempts + 1);
    expect(s.pushes.at(-1)?.to).toBe(s.group);
    expect(s.pushes.at(-1)?.messages[0]?.text).toContain("問い合わせは1件です。");
    expect(s.pushes.at(-1)?.messages[0]?.text).toContain(`/${s.ward.slug}/admin/inquiries`);
    await s.digest();
    await s.digest(new Date("2026-11-07T23:00:00.000Z"));
    expect(s.pushes).toHaveLength(attempts + 1);
  });
}

it("U102: 月の集計が遅れても即時送信を数え、朝の知らせ一回分を残す", async () => {
  const s = await setup();
  s.setLimit(9);
  for (let i = 0; i < 3; i++) {
    const e = s.event(`test-u102-budget-${i}`);
    e.source.userId = `test-u102-resident-${i}`;
    await s.send([e]);
  }
  expect(s.pushes).toHaveLength(2);
  await s.digest();
  expect(s.pushes).toHaveLength(3);
  expect(s.pushes.at(-1)?.messages[0]?.text).toContain("問い合わせは1件です。");
});

it("U102: 原文の300文字を保ち、名前がない時は省く", () => {
  const text = "あ".repeat(301);
  const message = immediateInquiryText(text, null, 0, "https://example.invalid/inquiries");
  expect(message).toContain(`「${"あ".repeat(300)}…」`);
  expect(message).not.toContain(text);
  expect(message).not.toContain("送った人:");
  expect(message).not.toContain("写真");
  expect(immediateInquiryText("あ".repeat(300), "LINE個別", 1, "https://example.invalid/inquiries")).not.toContain("…");
});
