import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/this-year/answers/LINE_webhook.json";
import { seedWard, uniqueSlug } from "../core/testing";
import type { Env } from "../env";
import { listInboxItems } from "./index";
import { acceptLineWebhook, verifyLineSignature } from "./webhook";
import { createLineIntakePorts } from "./intake";
import { MATCH_NEW, MATCH_UNRELATED } from "../ai/match";

interface FixtureEvent {
  type?: string;
  webhookEventId: string;
  timestamp: number;
  replyToken?: string;
  source: { type: string; userId?: string; groupId?: string; roomId?: string };
  message: { type: string; id: string; text?: string };
}
interface FixtureBody {
  destination: string;
  events: FixtureEvent[];
}

function fixtureBody(destination: string): string {
  const cloned = JSON.parse(JSON.stringify(fixture)) as FixtureBody;
  cloned.destination = destination;
  return JSON.stringify(cloned);
}

async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return btoa(Array.from(signature, (value) => String.fromCharCode(value)).join(""));
}

describe("公式LINEと届いたもの", () => {
  it("生の本文の正しい署名を受け、異なる署名を拒む", async () => {
    const secret = "fictional-line-secret";
    const body = fixtureBody("U-fixture-signature");
    const signature = await sign(body, secret);
    expect(await verifyLineSignature(body, signature, secret)).toBe(true);
    expect(await verifyLineSignature(body, `${signature.slice(0, -2)}AA`, secret)).toBe(false);
  });

  it("署名済みwebhookの重複を一度だけ受け、届いたもの一覧に架空の文を出す", async () => {
    const ward = await seedWard(env.DB, uniqueSlug("line-test"));
    const destination = `U-fixture-${crypto.randomUUID()}`;
    const body = fixtureBody(destination);
    const secret = "fictional-line-secret";
    await env.DB.prepare(`INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding)
      VALUES (?, ?, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN')`)
      .bind(ward.wardId, destination).run();
    const runtime = { ...env, LINE_CHANNEL_SECRET: secret, LINE_CHANNEL_ACCESS_TOKEN: "fictional-token" } as Env;
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) };
    const ports = createLineIntakePorts(runtime, ctx, async (_wardId, original) => ({
      choice: original.text?.includes("特売") ? MATCH_UNRELATED : MATCH_NEW,
      reason: "試験用の判定",
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const dependencies = { fetch, ports };
    const makeRequest = async () => new Request("https://unit.test/hooks/line", {
      method: "POST",
      headers: { "x-line-signature": await sign(body, secret), "content-type": "application/json" },
      body,
    });

    const rejected = await acceptLineWebhook(
      new Request("https://unit.test/hooks/line", { method: "POST", headers: { "x-line-signature": "wrong" }, body }),
      runtime,
      env.DB,
      dependencies,
      new Date(),
      ctx,
    );
    expect(rejected.status).toBe(401);

    const first = await acceptLineWebhook(await makeRequest(), runtime, env.DB, dependencies, new Date(), ctx);
    const duplicate = await acceptLineWebhook(await makeRequest(), runtime, env.DB, dependencies, new Date(), ctx);
    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    const inbox = await listInboxItems(env.DB, ward.wardId);
    expect(inbox).toHaveLength(2);
    expect(inbox.every((item) => item.original_text === null)).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE ward_id = ? AND via = 'line_direct'").bind(ward.wardId).first<{ count: number }>())?.count).toBe(2);
    expect((await env.DB.prepare("SELECT item_count FROM line_unrelated_daily_counts WHERE ward_id = ?").bind(ward.wardId).first<{ item_count: number }>())?.item_count).toBe(1);
    await Promise.all(pending);
  });

  it("公式LINEのグループの文も束2の届いたものにする", async () => {
    const ward = await seedWard(env.DB, uniqueSlug("line-group-test"));
    const destination = `U-fixture-group-${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding) VALUES (?, ?, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN')").bind(ward.wardId, destination).run();
    const secret = "fictional-line-secret";
    const payload = JSON.parse(fixtureBody(destination)) as FixtureBody;
    const groupEvent = payload.events[0];
    if (!groupEvent) throw new Error("架空のLINE事例がありません");
    groupEvent.webhookEventId = `group-${crypto.randomUUID()}`;
    groupEvent.source = { type: "group", userId: "U-fixture-user", groupId: "C-fixture-group" };
    groupEvent.message.text = "架空の実行委員会からの連絡";
    payload.events = [groupEvent];
    const body = JSON.stringify(payload);
    const runtime = { ...env, LINE_CHANNEL_SECRET: secret, LINE_CHANNEL_ACCESS_TOKEN: "fictional-token" } as Env;
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) };
    const ports = createLineIntakePorts(runtime, ctx, async () => ({
      choice: MATCH_NEW, reason: "新しい行事か確認が必要です", usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const response = await acceptLineWebhook(new Request("https://unit.test/hooks/line", {
      method: "POST", headers: { "x-line-signature": await sign(body, secret) }, body,
    }), runtime, env.DB, { fetch: async () => Response.json({ displayName: "架空の表示名" }), ports }, new Date(), ctx);
    expect(response.status).toBe(200);
    const job = await env.DB.prepare("SELECT via, sender_label FROM jobs WHERE ward_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(ward.wardId).first<{ via: string; sender_label: string }>();
    expect(job).toMatchObject({ via: "line_group", sender_label: "U-fixture-user" });
    expect(await listInboxItems(env.DB, ward.wardId)).toHaveLength(1);
    const sender = await env.DB.prepare("SELECT sender_display_name, sender_label FROM line_inbox_items WHERE ward_id = ? LIMIT 1")
      .bind(ward.wardId).first<{ sender_display_name: string; sender_label: string }>();
    expect(sender).toMatchObject({ sender_display_name: "架空の表示名", sender_label: "LINEグループ" });
    await Promise.all(pending);
  });

  it("LINEグループに入った案内は同じグループへ一度だけ送る", async () => {
    const ward = await seedWard(env.DB, uniqueSlug("line-join-test"));
    const destination = `U-fixture-join-${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding) VALUES (?, ?, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN')").bind(ward.wardId, destination).run();
    const secret = "fictional-line-secret";
    const payload = JSON.parse(fixtureBody(destination)) as FixtureBody;
    const event = payload.events[0];
    if (!event) throw new Error("架空のLINE事例がありません");
    event.type = "join";
    event.webhookEventId = `join-${crypto.randomUUID()}`;
    event.replyToken = "fictional-reply-token";
    event.source = { type: "group", groupId: "C-fixture-join-group" };
    payload.events = [event];
    let sent = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      sent += 1;
      const body = String(init?.body ?? "");
      expect(body).toContain("貼られたものは全部記録に残ります");
      return new Response(null, { status: 200 });
    };
    const runtime = { ...env, LINE_CHANNEL_SECRET: secret, LINE_CHANNEL_ACCESS_TOKEN: "fictional-token" } as Env;
    const ports = createLineIntakePorts(runtime, { waitUntil: () => undefined }, async () => ({
      choice: MATCH_NEW, reason: "試験用", usage: { input_tokens: 1, output_tokens: 1 },
    }));
    for (let repeat = 0; repeat < 2; repeat += 1) {
      if (repeat === 1) event.webhookEventId = `join-${crypto.randomUUID()}`;
      const body = JSON.stringify(payload);
      const response = await acceptLineWebhook(new Request("https://unit.test/hooks/line", {
        method: "POST", headers: { "x-line-signature": await sign(body, secret) }, body,
      }), runtime, env.DB, { fetch: fetcher, ports }, new Date());
      expect(response.status).toBe(200);
    }
    expect(sent).toBe(1);
  });
});
