import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { seedAdmin } from "../src/core/testing";
import { sha256Hex } from "../src/intake/media";
import type { LineIntakePorts } from "../src/line/intake";
import { photoContextProject } from "../src/line/photo-context";
import { acceptLineWebhook } from "../src/line/webhook";
import { withEnv } from "./helpers";

it("受信記録にLINEのIDを残さず、同じ人の言葉を結び、問い合わせの返事先を保つ", async () => {
  const { ward } = await seedAdmin(env.DB);
  const runtime = withEnv({ LINE_CHANNEL_SECRET: "fictional-receipt-secret", LINE_CHANNEL_ACCESS_TOKEN: "fictional-receipt-token" });
  const destination = crypto.randomUUID();
  const groupId = crypto.randomUUID();
  const senderId = crypto.randomUUID();
  const strangerId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding) VALUES (?, ?, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN')")
    .bind(ward.wardId, destination).run();
  const ports: LineIntakePorts = {
    async matchInboxItem() { return { disposition: "unmatched", inquiry: true }; },
    async receiveOriginal() { throw new Error("問い合わせの文を資料に入れてはいけません"); },
    async assignProject() { throw new Error("この試験では行事に入れません"); },
    async discard() { throw new Error("問い合わせを消してはいけません"); },
  };
  const fakeLine: typeof fetch = async (url) => {
    if (String(url).includes("/member/")) return Response.json({ displayName: fixture.sheetHelper });
    throw new Error("この試験にない外部通信です");
  };
  const now = new Date();
  const send = async (source: { type: "user" | "group" | "room"; userId?: string; groupId?: string; roomId?: string }, text: string) => {
    const eventId = crypto.randomUUID();
    const body = JSON.stringify({ destination, events: [{ type: "message", webhookEventId: eventId, timestamp: now.getTime(), source,
      message: { type: "text", id: eventId, text, mention: { mentionees: [{ isSelf: true }] } } }] });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(runtime.LINE_CHANNEL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
    expect((await acceptLineWebhook(new Request("https://unit.test/hooks/line", {
      method: "POST", headers: { "x-line-signature": signature }, body,
    }), runtime, env.DB, { ports, fetch: fakeLine }, now)).status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM line_webhook_receipts WHERE ward_id = ? AND event_id = ?")
      .bind(ward.wardId, eventId).first<Record<string, string | number | null>>();
    if (!row) throw new Error("受信記録がありません");
    const sourceId = source.groupId ?? source.roomId ?? source.userId!;
    expect(row.source_hash).toBe(await sha256Hex(sourceId));
    expect(row.sender_hash).toBe(await sha256Hex(source.userId ?? sourceId));
    expect(row).not.toHaveProperty("source_id");
    expect(row).not.toHaveProperty("sender_id");
    expect(Object.values(row)).not.toContain(sourceId);
    if (source.userId) expect(Object.values(row)).not.toContain(source.userId);
    const inquiry = await env.DB.prepare("SELECT line_source_id, line_user_id FROM inquiry_records WHERE ward_id = ? AND line_bundle_id = ?")
      .bind(ward.wardId, row.bundle_id).first<{ line_source_id: string; line_user_id: string | null }>();
    expect(inquiry).toEqual({ line_source_id: sourceId, line_user_id: source.userId ?? null });
    return row;
  };
  const source = { type: "group" as const, groupId, userId: senderId };
  const first = await send(source, fixture.dutyText);
  const second = await send(source, fixture.previousMaterial);
  expect(second.bundle_id).toBe(first.bundle_id);
  expect((await send({ ...source, userId: strangerId }, fixture.reportText)).bundle_id).not.toBe(first.bundle_id);
  expect((await send({ ...source, groupId: crypto.randomUUID() }, fixture.reportText)).bundle_id).not.toBe(first.bundle_id);
  await send({ type: "user", userId: senderId }, fixture.dutyText);
  await send({ type: "room", roomId: crypto.randomUUID(), userId: senderId }, fixture.dutyText);
  // 送信者が分からない投稿は、同じ場所から続けて届いても結ばない。
  const unknown = await send({ type: "group", groupId }, fixture.dutyText);
  expect((await send({ type: "group", groupId }, fixture.previousMaterial)).bundle_id).not.toBe(unknown.bundle_id);
  // 問い合わせの文は届いたものには入らないので、一時の文も受信記録の印で絞る。
  const context = await photoContextProject(env.DB, ward.wardId, {
    batch_id: crypto.randomUUID(), destination, source_type: "group", source_id: groupId, sender_id: senderId,
    created_at: now.toISOString(), last_received_at: now.toISOString(), match_attempted_at: null, match_finished_at: null, match_reason: null,
  }, now);
  expect(context.after.map((text) => text.summary).sort()).toEqual([fixture.dutyText, fixture.previousMaterial].sort());
});
