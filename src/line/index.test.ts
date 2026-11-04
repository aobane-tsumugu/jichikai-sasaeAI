import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/this-year/answers/LINE_webhook.json";
import { seedWard, uniqueSlug } from "../core/testing";
import type { Env } from "../env";
import { listInboxItems } from "./index";
import { acceptLineWebhook, verifyLineSignature } from "./webhook";

interface FixtureEvent {
  webhookEventId: string;
  timestamp: number;
  source: { type: string; userId: string };
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

describe("公式 LINE と受け箱", () => {
  it("生の本文の正しい署名を受け、異なる署名を拒む", async () => {
    const secret = "fictional-line-secret";
    const body = fixtureBody("U-fixture-signature");
    const signature = await sign(body, secret);
    expect(await verifyLineSignature(body, signature, secret)).toBe(true);
    expect(await verifyLineSignature(body, `${signature.slice(0, -2)}AA`, secret)).toBe(false);
  });

  it("署名済み webhook の重複を一度だけ受け、受け箱一覧に架空の文を出す", async () => {
    const ward = await seedWard(env.DB, uniqueSlug("line-test"));
    const destination = `U-fixture-${crypto.randomUUID()}`;
    const body = fixtureBody(destination);
    const secret = "fictional-line-secret";
    await env.DB.prepare(`INSERT INTO line_channels (ward_id, destination) VALUES (?, ?)`)
      .bind(ward.wardId, destination).run();
    const runtime = { ...env, LINE_CHANNEL_SECRET: secret, LINE_CHANNEL_ACCESS_TOKEN: "fictional-token" } as Env;
    const makeRequest = async () => new Request("https://unit.test/hooks/line", {
      method: "POST",
      headers: { "x-line-signature": await sign(body, secret), "content-type": "application/json" },
      body,
    });

    const rejected = await acceptLineWebhook(
      new Request("https://unit.test/hooks/line", { method: "POST", headers: { "x-line-signature": "wrong" }, body }),
      runtime,
      env.DB,
    );
    expect(rejected.status).toBe(401);

    const first = await acceptLineWebhook(await makeRequest(), runtime, env.DB);
    const duplicate = await acceptLineWebhook(await makeRequest(), runtime, env.DB);
    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    const inbox = await listInboxItems(env.DB, ward.wardId);
    expect(inbox).toHaveLength(3);
    expect(inbox.map((item) => item.original_text)).toContain(
      "2班の架空 橋本です。大人2人と子ども1人で行きます。受付なら手伝えます。",
    );
  });
});
