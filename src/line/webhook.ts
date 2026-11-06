import { nowIso } from "../core/ids";
import type { Env } from "../env";
import { createLineIntakePorts, type InboxMatch, type LineIntakePorts, type LineOriginal } from "./intake";
import type { Waitable } from "../intake/types";
import { getLineMemberDisplayName, lineChannelCredentials, replyLineText } from "./api";
import { getClient } from "../ai/deps";
import { matchClarificationAnswer } from "../ai/clarification";
import { recordLineInquiry } from "../project/followup";
import { PHOTO_GROUP_GAP_MS, processPhotoBatches, registerLinePhoto, replyQuickPhotoChecks, saveClarificationAnswers, sentQuestionsForSource, type ClarificationRow, type PhotoSource } from "./clarifications";

const RECEIPT_RETENTION_DAYS = 30;

interface LineMessageEvent {
  type?: string;
  webhookEventId?: string;
  timestamp?: number;
  replyToken?: string;
  joined?: { members?: Array<{ userId?: string }> };
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
  message?: { type?: string; id?: string; text?: string; imageSet?: { id?: string; index?: number; total?: number }; quoteToken?: string; quotedMessageId?: string;
    mention?: { mentionees?: Array<{ isSelf?: boolean }> } };
  postback?: { data?: string };
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
  matchAnswer?: typeof matchClarificationAnswer;
}

const looksLikeInquiry = (text: string) => /[?？]|(?:です|ます|でしょう|なの|ません)か[。\s]*$|教えて|知りたい|お願い(?:します|したい)|相談|要望/.test(text);

function photoSource(source: NonNullable<LineMessageEvent["source"]>): PhotoSource | null {
  const id = source.type === "user" ? source.userId : source.type === "group" ? source.groupId : source.type === "room" ? source.roomId : null;
  return id && (source.type === "user" || source.type === "group" || source.type === "room") ? { type: source.type, id, senderId: source.userId ?? "" } : null;
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
  let receivedPhoto = false;
  const photoChecksPending: Promise<void>[] = [];
  for (let event of events) {
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
          await replyLineText(accessToken, event.replyToken, "このグループに貼られたものは全部記録に残ります。", fetcher);
          await db.prepare("UPDATE line_group_notices SET notice_sent_at = ? WHERE ward_id = ? AND group_id = ? AND notice_sent_at IS NULL")
            .bind(now.toISOString(), wardId, event.source.groupId).run();
        } catch (error) {
          await db.prepare("DELETE FROM line_group_notices WHERE ward_id = ? AND group_id = ? AND notice_sent_at IS NULL")
            .bind(wardId, event.source.groupId).run();
          console.error("LINEグループへの案内を送れませんでした", wardId, error instanceof Error ? error.name : "");
        }
      }
      continue;
    }
    const postback = event.type === "postback" && typeof event.postback?.data === "string" ? new URLSearchParams(event.postback.data) : null;
    if (postback) {
      if (!postback.get("clarification") || !postback.get("answer") || !event.source) continue;
      event = { ...event, type: "message", message: { type: "text", id: eventId, text: postback.get("answer")! } };
    }
    if (!isMessageEvent(event)) continue;

    try {
      const source = photoSource(event.source);
      if (!source) continue;
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
        officialAddressed: event.source.type === "user" || event.message.mention?.mentionees?.some((mention) => mention.isSelf === true) || /^公式(?:へ|さん|[\s:：、])/.test(event.message.text ?? ""),
      };
      if (event.message.type === "image") {
        const content = await getImageContent(event.message.id, accessToken, fetcher);
        original.bytes = content.bytes;
        original.contentType = content.contentType;
      }
      // テキストは受信ジョブを作る前に分類する。無関係な文はジョブや原本を残さず、日次集計だけに加える。
      let match: InboxMatch | null = null;
      let answers: Array<{ question: ClarificationRow; text: string }> = [];
      if (original.kind === "text") {
        const questions = await sentQuestionsForSource(db, wardId, payload.destination!, source, {
          quotedMessageId: event.message.quotedMessageId, clarificationId: postback?.get("clarification") ?? undefined, now,
        });
        if (event.message.quotedMessageId && questions.length) original.officialAddressed = true;
        if (postback) {
          const question = questions.find((question) => question.options.includes(original.text ?? ""));
          if (!question) continue;
          answers = [{ question, text: original.text ?? "" }];
        } else if (questions.length && !looksLikeInquiry(original.text ?? "")) {
          try {
            const matched = await (dependencies?.matchAnswer ?? matchClarificationAnswer)(getClient(env), original.text ?? "", questions);
            answers = matched.flatMap((answer) => {
              const question = questions.find((question) => question.id === answer.id);
              return question ? [{ question, text: original.text ?? "" }] : [];
            });
          } catch { /* AI が止まっていても、資料や問い合わせとして受ける。 */ }
        }
        if (answers.length) {
          const projectIds = [...new Set(answers.flatMap((answer) => answer.question.project_id ? [answer.question.project_id] : []))];
          match = projectIds.length === 1 ? { disposition: "matched", projectId: projectIds[0] } : { disposition: "unmatched" };
          if (!projectIds.length && answers.some((answer) => answer.question.topic === "project")) {
            try { match = await ports.matchInboxItem(wardId, { ...original, officialAddressed: false }); } catch { /* 行事が分からなくても受ける。 */ }
          }
        } else if (original.officialAddressed && looksLikeInquiry(original.text ?? "")) {
          match = { disposition: "unmatched", inquiry: true };
        } else try {
          match = await ports.matchInboxItem(wardId, original);
        } catch (error) {
          console.error("LINEの当て先を確認できませんでした", wardId, eventId, error instanceof Error ? error.name : "");
          match = { disposition: "unmatched", reason: "当て先を確認できませんでした", inquiry: original.officialAddressed };
        }
        if (original.officialAddressed && match?.inquiry) {
          await recordLineInquiry(db, wardId, { eventId, receivedAt: original.receivedAt, text: original.text ?? "", sourceType: source.type, sourceId: source.id, senderLabel: original.senderDisplayName ?? null });
          if (event.replyToken) try {
            await replyLineText(accessToken, event.replyToken, "役員に伝えて、内容を確認します。", fetcher);
            await db.prepare("UPDATE inquiry_records SET line_replied_at = ? WHERE ward_id = ? AND line_event_id = ?")
              .bind(now.toISOString(), wardId, eventId).run();
          } catch { /* 届いた問い合わせは消さず、返事を約束しない。 */ }
          continue;
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
        original.senderDisplayName, original.sourceType === "group" ? "LINEグループ" : original.sourceType === "room" ? "LINE複数人トーク" : "LINE個別",
        itemId,
      ).run();
      if (original.kind === "image") {
        await registerLinePhoto(db, wardId, { destination: payload.destination!, source, jobId: itemId, messageId: event.message.id,
          imageSet: event.message.imageSet, quoteToken: event.message.quoteToken, replyToken: event.replyToken, now });
        receivedPhoto = true;
        if (ports.checkPhoto) photoChecksPending.push(ports.checkPhoto(wardId, original, itemId).catch(() => undefined));
      }
      if (answers.length) {
        await saveClarificationAnswers(db, wardId, eventId, itemId, original.senderDisplayName || "LINEで答えた人", answers, now);
        if (match?.projectId && answers.some((answer) => answer.question.topic === "project")) {
          const batchIds = [...new Set(answers.filter((answer) => answer.question.topic === "project").map((answer) => answer.question.batch_id))];
          for (const batchId of batchIds) {
            const photos = await db.prepare("SELECT job_id FROM line_photo_items WHERE ward_id = ? AND batch_id = ?").bind(wardId, batchId).all<{ job_id: string }>();
            for (const photo of photos.results) await ports.assignProject(wardId, photo.job_id, match.projectId);
          }
        }
      }
      // 文は届いた文そのもので当てる。写真は束 2 が読み取りを終えてから当てる。
      if (match?.disposition === "matched" && match.projectId) {
        if (!answers.length) await ports.saveAnswerReply?.(wardId, match.projectId, original, itemId);
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
  if (receivedPhoto) {
    await Promise.all(photoChecksPending);
    // imageSet の無い連続写真にも、短い間だけまとめる余地を持たせる。
    if (!dependencies) await new Promise((resolve) => setTimeout(resolve, PHOTO_GROUP_GAP_MS));
    const deliveryNow = dependencies ? now : new Date();
    await replyQuickPhotoChecks(env, wardId, { fetch: fetcher, now: deliveryNow });
    await processPhotoBatches(env, wardId, { fetch: fetcher, now: deliveryNow });
  }
  };
  const work = processEvents();
  if (dependencies) await work;
  else ctx.waitUntil(work.catch((error) => {
    console.error("LINEの処理に失敗しました", wardId, error instanceof Error ? error.name : "unknown");
  }));
  return Response.json({ ok: true });
}
