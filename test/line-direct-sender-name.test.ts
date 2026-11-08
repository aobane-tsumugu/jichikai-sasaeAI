import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import type { LineIntakePorts } from "../src/line/intake";
import { acceptLineWebhook } from "../src/line/webhook";
import { withEnv } from "./helpers";

it("一対一で届いた物にも送った人の名前を付け、取れない時は名前なしにする", async () => {
  const { ward } = await seedAdmin(env.DB);
  const runtime = withEnv({ LINE_CHANNEL_SECRET: "fictional-direct-name-secret", LINE_CHANNEL_ACCESS_TOKEN: "fictional-direct-name-token" });
  const destination = crypto.randomUUID();
  const named = crypto.randomUUID();
  const unnamed = crypto.randomUUID();
  const directName = "試しの一対一の送り手";
  await env.DB.prepare("INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding) VALUES (?, ?, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN')")
    .bind(ward.wardId, destination).run();
  const ports: LineIntakePorts = {
    async matchInboxItem() { return { disposition: "unmatched", inquiry: false }; },
    async receiveOriginal(wardId, original) {
      const result = await receive(runtime, { wardId, via: original.sourceType === "user" ? "line_direct" : "line_group",
        parts: [{ kind: "text", filename: "line.txt", mediaType: "text/plain", bytes: new TextEncoder().encode(original.text) }] });
      return result.jobId;
    },
    async assignProject() { throw new Error("この試験では行事に入れません"); },
    async discard() { throw new Error("届いた物を消してはいけません"); },
  };
  const asked: string[] = [];
  const fakeLine: typeof fetch = async (url) => {
    asked.push(new URL(String(url)).pathname);
    if (String(url).endsWith(`/v2/bot/profile/${named}`)) return Response.json({ displayName: directName });
    if (String(url).includes("/v2/bot/profile/")) return new Response("not found", { status: 404 });
    if (String(url).includes("/member/")) return Response.json({ displayName: fixture.sheetHelper });
    throw new Error("この試験にない外部通信です");
  };
  const now = new Date();
  const send = async (source: { type: "user" | "group"; userId?: string; groupId?: string }, text: string) => {
    const eventId = crypto.randomUUID();
    const body = JSON.stringify({ destination, events: [{ type: "message", webhookEventId: eventId, timestamp: now.getTime(), source,
      message: { type: "text", id: eventId, text } }] });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(runtime.LINE_CHANNEL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
    expect((await acceptLineWebhook(new Request("https://unit.test/hooks/line", {
      method: "POST", headers: { "x-line-signature": signature }, body,
    }), runtime, env.DB, { ports, fetch: fakeLine }, now)).status).toBe(200);
    return env.DB.prepare("SELECT sender_display_name, sender_label FROM line_inbox_items WHERE ward_id = ? AND event_id = ?")
      .bind(ward.wardId, eventId).first<{ sender_display_name: string | null; sender_label: string }>();
  };
  expect(await send({ type: "user", userId: named }, fixture.dutyText)).toEqual({ sender_display_name: directName, sender_label: "LINE個別" });
  expect(asked).toContain(`/v2/bot/profile/${named}`);
  // プロフィールが取れない時は、名前を作らず名前なしで受ける。
  expect(await send({ type: "user", userId: unnamed }, fixture.previousMaterial)).toEqual({ sender_display_name: null, sender_label: "LINE個別" });
  // グループは今まで通りメンバーのプロフィールで取る。
  expect(await send({ type: "group", groupId: crypto.randomUUID(), userId: named }, fixture.reportText))
    .toEqual({ sender_display_name: fixture.sheetHelper, sender_label: "LINEグループ" });
});
