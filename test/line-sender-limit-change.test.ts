import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { MATCH_UNRELATED } from "../src/ai/match";
import { seedAdmin } from "../src/core/testing";
import { createLineIntakePorts } from "../src/line/intake";
import { acceptLineWebhook } from "../src/line/webhook";
import { createOpsSession, OPS_COOKIE } from "../src/ops/session";
import { opsEnv, postForm, realApp, withEnv } from "./helpers";

it("一日の上限を増やすと断った受信を除いて新しい文を処理し、増やした件数も超えない", async () => {
  const { ward } = await seedAdmin(env.DB);
  const cookie = `${OPS_COOKIE}=${await createOpsSession(opsEnv)}`;
  const saveLimit = async (limit: number) => {
    expect((await postForm(realApp, `/ops/wards/${ward.slug}/budget`, {
      saveLineDailyLimit: "1", lineSenderDailyLimit: String(limit),
    }, cookie, opsEnv)).status).toBe(200);
  };
  await saveLimit(1);

  const runtime = withEnv({ LINE_CHANNEL_SECRET: "fictional-limit-change-secret", LINE_CHANNEL_ACCESS_TOKEN: "fictional-limit-change-token" });
  const destination = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding) VALUES (?, ?, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN')")
    .bind(ward.wardId, destination).run();
  let matches = 0;
  const ports = createLineIntakePorts(runtime, { waitUntil: () => { throw new Error("架空の試験でAIの読み取りを始めてはいけません。"); } }, async () => {
    matches++;
    return { choice: MATCH_UNRELATED, reason: "架空の文の確認です。", usage: { input_tokens: 10, output_tokens: 1 } };
  });
  const fakeLine: typeof fetch = async (url) => {
    if (String(url).endsWith("/message/reply")) return Response.json({ sentMessages: [{ id: "fictional-limit-change-reply" }] });
    throw new Error("架空のLINE以外へは接続しません。");
  };
  const now = new Date();
  const send = async (id = crypto.randomUUID()) => {
    const body = JSON.stringify({ destination, events: [{ type: "message", webhookEventId: id, timestamp: now.getTime(), replyToken: id,
      source: { type: "user", userId: "fictional-limit-change-sender" }, message: { type: "text", id, text: `架空の文${id}` } }] });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(runtime.LINE_CHANNEL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
    const response = await acceptLineWebhook(new Request("https://unit.test/hooks/line", {
      method: "POST", headers: { "x-line-signature": signature }, body,
    }), runtime, env.DB, { ports, fetch: fakeLine }, now);
    expect(response.status).toBe(200);
    return id;
  };

  await send();
  const refused = await send();
  await send();
  expect(matches).toBe(1);
  await saveLimit(2);
  await send(refused); // 断った同じ受信を自動で処理し直す機能は足さない。
  expect(matches).toBe(1);
  const admitted = await send();
  expect(matches).toBe(2);
  await send(admitted);
  await send();
  expect(matches).toBe(2);
});
