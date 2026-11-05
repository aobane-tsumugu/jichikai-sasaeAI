import { nowIso } from "../core/ids";
import type { Env } from "../env";
import { createLineIntakePorts, type InboxMatch, type LineIntakePorts, type LineOriginal } from "./intake";
import type { Waitable } from "../intake/types";
import { getLineMemberDisplayName, lineChannelCredentials, replyLineText } from "./api";

const RECEIPT_RETENTION_DAYS = 30;

interface LineMessageEvent {
  type?: string;
  webhookEventId?: string;
  timestamp?: number;
  replyToken?: string;
  joined?: { members?: Array<{ userId?: string }> };
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
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
  source: { type: "user" | "group" | "room"; userId?: string; groupId?: string; roomId?: string };
  message: { type: "text" | "image"; id: string; text?: string };
} {
  return event.type === "message" && Boolean(event.webhookEventId) &&
    ((event.source?.type === "user" && Boolean(event.source.userId)) ||
      (event.source?.type === "group" && Boolean(event.source.groupId)) ||
      (event.source?.type === "room" && Boolean(event.source.roomId))) &&
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
  dependencies?: WebhookDependencies,
  now = new Date(),
  ctx: Waitable = { waitUntil: (promise) => void promise },
): Promise<Response> {
  const ports = dependencies?.ports ?? createLineIntakePorts(env, ctx);
  const fetcher = dependencies?.fetch ?? fetch;
  const rawBody = new Uint8Array(await request.arrayBuffer());
  const signature = request.headers.get("x-line-signature") ?? "";
  let payload: LineWebhookBody;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(rawBody)) as LineWebhookBody;
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  if (!payload || typeof payload.destination !== "string" || !Array.isArray(payload.events)) {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  // destination は複数区から区を引くためのチャンネル台帳。解決後の全ての問い合わせは ward_id で絞る。
  const channel = await db.prepare(`
    SELECT ward_id FROM line_channels WHERE destination = ?
  `).bind(payload.destination).first<{ ward_id: string }>();
  if (!channel) return Response.json({ error: "unknown channel" }, { status: 404 });
  const wardId = channel.ward_id;
  const credentials = await lineChannelCredentials(env, wardId, payload.destination);
  if (!credentials?.channelSecret) return Response.json({ error: "channel not configured" }, { status: 503 });
  if (!(await verifyLineSignature(rawBody, signature, credentials.channelSecret))) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }
  if (!credentials.accessToken) return Response.json({ error: "channel not configured" }, { status: 503 });
  const accessToken = credentials.accessToken;
  await db.prepare(`
    DELETE FROM line_webhook_receipts WHERE ward_id = ? AND expires_at <= ?
  `).bind(wardId, now.toISOString()).run();

  // LINE は応答を待たずに接続を切ることがある。AI の当てを待つと処理ごと止まるので、応答を先に返す。
  const events = payload.events;
  const processEvents = async (): Promise<void> => {
  for (const event of events) {
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
    if (receipt.meta.changes === 0) continue;

    if (event.type === "join" && event.source?.type === "group" && event.source.groupId && event.replyToken) {
      const prior = await db.prepare("SELECT notice_sent_at FROM line_group_notices WHERE ward_id = ? AND group_id = ?")
        .bind(wardId, event.source.groupId).first<{ notice_sent_at: string | null }>();
      if (!prior) {
        const inserted = await db.prepare(`INSERT OR IGNORE INTO line_group_notices (ward_id, group_id, first_joined_at)
          VALUES (?, ?, ?)`).bind(wardId, event.source.groupId, now.toISOString()).run();
        if ((inserted.meta.changes ?? 0) === 0) continue;
        try {
          await replyLineText(accessToken, event.replyToken, "このグループに貼られた物は全部記録に残ります。", fetcher);
          await db.prepare("UPDATE line_group_notices SET notice_sent_at = ? WHERE ward_id = ? AND group_id = ? AND notice_sent_at IS NULL")
            .bind(now.toISOString(), wardId, event.source.groupId).run();
        } catch (error) {
          await db.prepare("DELETE FROM line_group_notices WHERE ward_id = ? AND group_id = ? AND notice_sent_at IS NULL")
            .bind(wardId, event.source.groupId).run();
          console.error("LINE グループへの案内を送れませんでした", wardId, error instanceof Error ? error.name : "");
        }
      }
      continue;
    }
    if (!isMessageEvent(event)) continue;

    try {
      const original: LineOriginal = {
        eventId,
        senderId: event.source.userId ?? event.source.groupId ?? event.source.roomId ?? "",
        sourceType: event.source.type,
        receivedAt: new Date(event.timestamp ?? now.getTime()).toISOString(),
        kind: event.message.type,
        senderDisplayName: event.source.type === "group" || event.source.type === "room"
          ? await getLineMemberDisplayName(accessToken, event.source, fetcher)
          : null,
        ...(event.message.type === "text" ? { text: event.message.text ?? "" } : {}),
      };
      if (event.message.type === "image") {
        const content = await getImageContent(event.message.id, accessToken, fetcher);
        original.bytes = content.bytes;
        original.contentType = content.contentType;
      }
      // テキストは受信ジョブを作る前に分類する。無関係な文はジョブや原本を残さず、日次集計だけに加える。
      let match: InboxMatch | null = null;
      if (original.kind === "text") {
        try {
          match = await ports.matchInboxItem(wardId, original);
        } catch (error) {
          console.error("LINE の当て先を確認できませんでした", wardId, eventId, error instanceof Error ? error.name : "");
          match = { disposition: "unmatched", reason: "当て先を確認できませんでした" };
        }
      }
      if (match?.disposition === "unrelated") {
        const day = original.receivedAt.slice(0, 10);
        await db.prepare(`INSERT INTO line_unrelated_daily_counts (ward_id, day, item_count)
          VALUES (?, ?, 1) ON CONFLICT (ward_id, day) DO UPDATE SET item_count = item_count + 1`).bind(wardId, day).run();
        continue;
      }
      const itemId = await ports.receiveOriginal(wardId, original);
      if (!itemId) continue;
      await db.prepare(`
        INSERT INTO line_inbox_items (
          ward_id, item_id, event_id, sender_id, original_kind, original_text,
          original_object_key, received_at, sender_display_name, sender_label, matched_project_id, matched_project_name,
          match_reason, disposition, job_id
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, 'unmatched', ?)
      `).bind(
        wardId, itemId, eventId, original.senderId, original.kind, original.receivedAt,
        original.senderDisplayName, original.sourceType === "group" ? "LINE グループ" : original.sourceType === "room" ? "LINE 複数人トーク" : "LINE 個別",
        itemId,
      ).run();
      // 文は届いた文そのもので当てる。写真は束 2 が読み取りを終えてから当てる。
      if (match?.disposition === "matched" && match.projectId) {
        await ports.saveAnswerReply?.(wardId, match.projectId, original, itemId);
        await ports.assignProject(wardId, itemId, match.projectId);
      }
      await db.prepare(`
        UPDATE line_inbox_items SET disposition = ?, matched_project_id = ?, matched_project_name = ?, match_reason = ?
        WHERE ward_id = ? AND item_id = ?
      `).bind(match?.disposition === "matched" && match.projectId ? "matched" : "unmatched",
        match?.projectId ?? null, match?.projectName ?? null, match?.reason ?? null, wardId, itemId).run();
    } catch (error) {
      await db.prepare(`
        DELETE FROM line_webhook_receipts WHERE ward_id = ? AND event_id = ?
      `).bind(wardId, eventId).run();
      throw error;
    }
  }
  };
  const work = processEvents();
  if (dependencies) await work;
  else ctx.waitUntil(work.catch((error) => {
    console.error("LINE の処理に失敗しました", wardId, error instanceof Error ? error.name : "unknown");
  }));
  return Response.json({ ok: true });
}
