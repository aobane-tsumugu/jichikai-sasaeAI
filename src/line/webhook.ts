import { nowIso } from "../core/ids";
import type { Env } from "../env";
import { createLineIntakePorts, type LineIntakePorts, type LineOriginal } from "./intake";

const RECEIPT_RETENTION_DAYS = 30;

interface LineMessageEvent {
  type?: string;
  webhookEventId?: string;
  timestamp?: number;
  source?: { type?: string; userId?: string };
  message?: { type?: string; id?: string; text?: string };
}

interface LineWebhookBody {
  destination?: string;
  events?: LineMessageEvent[];
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return mismatch === 0;
}

export async function verifyLineSignature(rawBody: string | Uint8Array, signature: string, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;
  let supplied: Uint8Array;
  try {
    supplied = Uint8Array.from(atob(signature), (character) => character.charCodeAt(0));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = typeof rawBody === "string" ? new TextEncoder().encode(rawBody) : rawBody;
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
  return constantTimeEqual(expected, supplied);
}

function addDays(date: Date, days: number): string {
  const expires = new Date(date.getTime());
  expires.setUTCDate(expires.getUTCDate() + days);
  return expires.toISOString();
}

function isMessageEvent(event: LineMessageEvent): event is LineMessageEvent & {
  webhookEventId: string;
  source: { type: "user"; userId: string };
  message: { type: "text" | "image"; id: string; text?: string };
} {
  return event.type === "message" && Boolean(event.webhookEventId) &&
    event.source?.type === "user" && Boolean(event.source.userId) &&
    (event.message?.type === "text" || event.message?.type === "image") && Boolean(event.message.id);
}

export interface WebhookDependencies {
  fetch: typeof fetch;
  ports: LineIntakePorts;
}

async function getImageContent(messageId: string, token: string, fetcher: typeof fetch) {
  const response = await fetcher(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`LINE content request failed (${response.status})`);
  return {
    bytes: await response.arrayBuffer(),
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
  };
}

export async function acceptLineWebhook(
  request: Request,
  env: Env,
  db: D1Database,
  dependencies: WebhookDependencies = {
    fetch,
    ports: createLineIntakePorts(db, env.ORIGINALS),
  },
  now = new Date(),
): Promise<Response> {
  const rawBody = new Uint8Array(await request.arrayBuffer());
  const signature = request.headers.get("x-line-signature") ?? "";
  if (!(await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET))) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: LineWebhookBody;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(rawBody)) as LineWebhookBody;
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  if (typeof payload.destination !== "string" || !Array.isArray(payload.events)) {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  // destination は複数区から区を引くためのチャンネル台帳。解決後の全ての問い合わせは ward_id で絞る。
  const channel = await db.prepare(`
    SELECT ward_id FROM line_channels WHERE destination = ?
  `).bind(payload.destination).first<{ ward_id: string }>();
  if (!channel) return Response.json({ error: "unknown channel" }, { status: 404 });
  const wardId = channel.ward_id;
  await db.prepare(`
    DELETE FROM line_webhook_receipts WHERE ward_id = ? AND expires_at <= ?
  `).bind(wardId, now.toISOString()).run();

  for (const event of payload.events) {
    const eventId = event.webhookEventId;
    if (!eventId) continue;
    const stored = await db.prepare(`
      SELECT item_id FROM line_inbox_items WHERE ward_id = ? AND event_id = ?
    `).bind(wardId, eventId).first<{ item_id: string }>();
    if (stored) continue;
    const receipt = await db.prepare(`
      INSERT OR IGNORE INTO line_webhook_receipts (ward_id, event_id, expires_at)
      VALUES (?, ?, ?)
    `).bind(wardId, eventId, addDays(now, RECEIPT_RETENTION_DAYS)).run();
    if (receipt.meta.changes === 0 || !isMessageEvent(event)) continue;

    try {
      const original: LineOriginal = {
        eventId,
        senderId: event.source.userId,
        receivedAt: new Date(event.timestamp ?? now.getTime()).toISOString(),
        kind: event.message.type,
        ...(event.message.type === "text" ? { text: event.message.text ?? "" } : {}),
      };
      if (event.message.type === "image") {
        const content = await getImageContent(event.message.id, env.LINE_CHANNEL_ACCESS_TOKEN, dependencies.fetch);
        original.bytes = content.bytes;
        original.contentType = content.contentType;
      }
      const match = await dependencies.ports.matchInboxItem(wardId, original);
      if (match.disposition === "unrelated") {
        const day = original.receivedAt.slice(0, 10);
        await db.prepare(`
          INSERT INTO line_unrelated_daily_counts (ward_id, day, item_count)
          VALUES (?, ?, 1)
          ON CONFLICT (ward_id, day) DO UPDATE SET item_count = item_count + 1
        `).bind(wardId, day).run();
        continue;
      }
      const itemId = await dependencies.ports.receiveOriginal(wardId, original);
      if (match.disposition === "matched") {
        await db.prepare(`
          UPDATE line_inbox_items
          SET disposition = 'matched', matched_project_id = ?, matched_project_name = ?, match_reason = ?
          WHERE ward_id = ? AND item_id = ?
        `).bind(match.projectId ?? null, match.projectName ?? null, match.reason ?? null, wardId, itemId).run();
      }
    } catch (error) {
      await db.prepare(`
        DELETE FROM line_webhook_receipts WHERE ward_id = ? AND event_id = ?
      `).bind(wardId, eventId).run();
      throw error;
    }
  }
  return Response.json({ ok: true });
}
