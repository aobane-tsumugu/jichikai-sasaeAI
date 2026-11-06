import type { Env } from "../env";
import { newId } from "../core/ids";
import { getClient } from "../ai/deps";
import { writeClarification, type ClarificationPrompt } from "../ai/clarification";
import { getReadings } from "../intake/store";
import { addQuestion } from "../project/api";
import { lineChannelCredentials, replyLineText, pushInquiryAnswer, inquiryPushAllowance, sendLineQuestion } from "./api";
import { photoCheckMessage } from "../intake/photo-check";
import { sha256Hex } from "../intake/media";
import { matchPendingLinePhotos } from "../intake/pipeline";
import { PHOTO_AFTER_MS, purgePhotoTexts } from "./photo-context";

// 実測前の仮の値。夜の質問、催促、無制限の通知を作らない。
export const PHOTO_GROUP_GAP_MS = 5000;
export const MAX_QUESTION_LENGTH = 800;
export const MAX_MONTHLY_PUSH_RECIPIENTS = 50;

/** none は LINE 側の上限なし。区ごとの月の上限は別に数える。 */
export function lineQuotaAllows(quota: { type?: unknown; value?: unknown }, usage: { totalUsage?: unknown }, count: number): boolean {
  if (quota.type === "none") return true;
  return quota.type === "limited" && Number(quota.value) - Number(usage.totalUsage) >= count;
}
export const MAX_DAILY_QUESTIONS = 3;
export const isQuestionTime = (now: Date) => {
  const hour = new Date(now.getTime() + 9 * 3600_000).getUTCHours();
  return hour >= 8 && hour < 20;
};
const questionDayStart = (now: Date) => new Date(new Date(now.getTime() + 9 * 3600_000).setUTCHours(0, 0, 0, 0) - 9 * 3600_000).toISOString();

export interface PhotoSource {
  type: "user" | "group" | "room";
  id: string;
  senderId: string;
}

interface Batch {
  batch_id: string; destination: string; source_type: PhotoSource["type"]; source_id: string;
  expected_count: number | null; created_at: string; last_received_at: string;
  reply_token: string | null; reply_at: string | null; quick_replied: number;
  prepared_at: string | null; message_text: string | null; sent_at: string | null;
  screen_answered_at: string | null;
  match_finished_at: string | null;
}

export async function registerLinePhoto(db: D1Database, wardId: string, input: {
  destination: string; source: PhotoSource; jobId: string; messageId: string;
  imageSet?: { id?: string; index?: number; total?: number }; quoteToken?: string;
  replyToken?: string; now: Date;
}): Promise<string> {
  const { source, imageSet, now } = input;
  const setId = typeof imageSet?.id === "string" ? imageSet.id : null;
  const prior = await db.prepare(`SELECT batch_id FROM line_photo_batches WHERE ward_id = ? AND destination = ?
    AND source_type = ? AND source_id = ? AND sender_id = ? AND prepared_at IS NULL AND send_claimed_at IS NULL
    AND ((? IS NOT NULL AND image_set_id = ?) OR (? IS NULL AND image_set_id IS NULL AND last_received_at >= ?))
    ORDER BY last_received_at DESC LIMIT 1`).bind(wardId, input.destination, source.type, source.id, source.senderId,
      setId, setId, setId, new Date(now.getTime() - PHOTO_GROUP_GAP_MS).toISOString()).first<{ batch_id: string }>();
  // imageSet の同時受信でも同じ ID になる。送り先と送った人も必ず含める。
  const id = prior?.batch_id ?? await sha256Hex(JSON.stringify([input.destination, source.type, source.id, source.senderId,
    setId ? ["set", setId] : ["time", input.jobId]]));
  const expected = Number.isInteger(imageSet?.total) && imageSet!.total! > 0 && imageSet!.total! <= 30 ? imageSet!.total! : null;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO line_photo_batches
      (ward_id, batch_id, destination, source_type, source_id, sender_id, image_set_id, expected_count, created_at, last_received_at, reply_token, reply_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(wardId, id, input.destination, source.type, source.id, source.senderId, setId, expected, now.toISOString(), now.toISOString(), input.replyToken ?? null, now.toISOString()),
    db.prepare(`INSERT OR IGNORE INTO line_photo_items (ward_id, batch_id, job_id, message_id, image_index, quote_token, receipt_reply_token)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(wardId, id, input.jobId, input.messageId, Number.isInteger(imageSet?.index) ? imageSet!.index! : null, input.quoteToken ?? null, input.replyToken ?? null),
    db.prepare(`UPDATE line_photo_batches SET last_received_at = ?, reply_token = ?, reply_at = ? WHERE ward_id = ? AND batch_id = ? AND prepared_at IS NULL`)
      .bind(now.toISOString(), input.replyToken ?? null, now.toISOString(), wardId, id),
  ]);
  return id;
}

export interface ClarificationRow extends ClarificationPrompt {
  batch_id: string; job_id: string; original_id: string; question_id: string | null; project_id: string | null;
  answer: string | null;
  sent_at: string | null;
  message_text: string | null; sent_message_id: string | null; answered_unknown: number;
}

export async function listClarifications(db: D1Database, wardId: string, batchId?: string): Promise<ClarificationRow[]> {
  const result = await db.prepare(`SELECT c.clarification_id AS id, c.batch_id, c.job_id, c.original_id, c.topic, c.text,
    c.options, c.question_id, c.answer, c.sent_at, c.message_text, c.sent_message_id, c.answered_unknown, j.project_id FROM line_clarifications c
    JOIN jobs j ON j.ward_id = c.ward_id AND j.job_id = c.job_id
    WHERE c.ward_id = ? AND j.withdrawn_at IS NULL ${batchId ? "AND c.batch_id = ?" : ""} ORDER BY j.created_at, c.original_id, CASE c.topic WHEN 'unreadable' THEN 0 WHEN 'year' THEN 1 ELSE 2 END, c.clarification_id`)
    .bind(...(batchId ? [wardId, batchId] : [wardId])).all<Omit<ClarificationRow, "options"> & { options: string }>();
  return result.results.map((row) => ({ ...row, options: JSON.parse(row.options) as string[] }));
}

/** 行事が後から分かった質問も、同じ役員の質問画面へつなぐ。 */
export async function attachClarificationQuestions(db: D1Database, wardId: string, jobId: string): Promise<void> {
  const rows = await db.prepare(`SELECT c.clarification_id, c.original_id, c.text, c.options, c.answer, c.answered_unknown, j.project_id
    FROM line_clarifications c JOIN jobs j ON j.ward_id = c.ward_id AND j.job_id = c.job_id
    JOIN projects p ON p.ward_id = j.ward_id AND p.project_id = j.project_id
    WHERE c.ward_id = ? AND c.job_id = ? AND c.question_id IS NULL AND j.withdrawn_at IS NULL AND p.closed_at IS NULL`)
    .bind(wardId, jobId).all<{ clarification_id: string; original_id: string; text: string; options: string; answer: string | null; answered_unknown: number; project_id: string }>();
  for (const row of rows.results) {
    const question = await addQuestion(db, wardId, row.project_id, {
      kind: "unreadable", text: row.text.length <= 500 ? row.text : "送った写真に読めないところがあります。届いたものの「送った資料についての質問」で、元の資料と詳しい内容を見られます。", target: "送った資料の確認", options: JSON.parse(row.options) as string[],
      source: { kind: "original", ref: row.original_id, locator: "写真の確認" }, packVersion: "line-clarification@1",
    });
    if (question.status === "added" || question.status === "same") {
      await db.prepare("UPDATE line_clarifications SET question_id = ? WHERE ward_id = ? AND clarification_id = ?")
        .bind(question.questionId, wardId, row.clarification_id).run();
      if (row.answer) {
        const answers = await db.prepare("SELECT DISTINCT answer_text FROM line_clarification_answers WHERE ward_id = ? AND clarification_id = ?")
          .bind(wardId, row.clarification_id).all<{ answer_text: string }>();
        if (answers.results.length > 1) await db.prepare("UPDATE project_questions SET kind = 'conflict', state = 'open', answer = ?, detail = ? WHERE ward_id = ? AND question_id = ?")
          .bind(row.answer, JSON.stringify({ options: answers.results.map((answer) => answer.answer_text) }), wardId, question.questionId).run();
        else await db.prepare("UPDATE project_questions SET state = ?, answer = ?, answered_at = ? WHERE ward_id = ? AND question_id = ? AND state = 'open'")
          .bind(row.answered_unknown ? "open" : "answered", row.answer, new Date().toISOString(), wardId, question.questionId).run();
      }
    }
  }
}

async function prepareQuestions(env: Env, wardId: string, batch: Batch, now: Date): Promise<boolean> {
  const items = await env.DB.prepare(`SELECT i.job_id, i.image_index, j.read_at, j.project_id, j.status FROM line_photo_items i
    JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id
    WHERE i.ward_id = ? AND i.batch_id = ? AND j.withdrawn_at IS NULL ORDER BY i.image_index, j.created_at, i.job_id`)
    .bind(wardId, batch.batch_id).all<{ job_id: string; image_index: number | null; read_at: string | null; project_id: string | null; status: string }>();
  if (!items.results.length || items.results.some((item) => !item.read_at)) return false;
  if (batch.expected_count !== null && items.results.length < batch.expected_count) return false;
  if (batch.expected_count === null && now.getTime() - Date.parse(batch.last_received_at) < PHOTO_GROUP_GAP_MS) return false;
  if (items.results.some((item) => !item.project_id) &&
    (!batch.match_finished_at || now.getTime() < Date.parse(batch.last_received_at) + PHOTO_AFTER_MS)) return false;
  const claim = await env.DB.prepare("UPDATE line_photo_batches SET prepared_at = ? WHERE ward_id = ? AND batch_id = ? AND prepared_at IS NULL")
    .bind(now.toISOString(), wardId, batch.batch_id).run();
  if (!claim.meta.changes) return false;
  for (const item of items.results) {
    const originals = await env.DB.prepare("SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ? AND withdrawn_at IS NULL ORDER BY position")
      .bind(wardId, item.job_id).all<{ original_id: string }>();
    const readings = await getReadings(env.DB, wardId, item.job_id);
    const pending: Array<{ originalId: string; topic: ClarificationPrompt["topic"]; text: string; options: string[] }> = [];
    for (const reading of readings) {
      const unreadables = new Map<string, string[]>();
      for (const unreadable of reading.body.unreadable) {
        if (!originals.results.some((original) => original.original_id === unreadable.original_id)) continue;
        const notes = unreadables.get(unreadable.original_id) ?? [];
        // 前後から読める一文字は読み取り側で解決する。聞くのは残った箇所だけ。
        notes.push(`${unreadable.locator.replace(/\d+\s*枚目[の\s]*/g, "")}: ${unreadable.note}`);
        unreadables.set(unreadable.original_id, notes);
      }
      for (const [originalId, notes] of unreadables) for (const note of notes) pending.push({ originalId, topic: "unreadable", text: `この写真の${note}。何と書かれていますか。`, options: ["分からない"] });
      if ("fields" in reading.body && reading.body.document_kind !== "photo") {
        for (const year of reading.body.original_years) {
          const dated = reading.body.text_blocks.filter((b) => b.original_id === year.original_id).some((b) => /(?:20\d{2}年|令和\s*\d+年|平成\s*\d+年)/.test(b.text));
          if (year.year === null && !dated && originals.results.some((original) => original.original_id === year.original_id)) pending.push({
            originalId: year.original_id, topic: "year", text: "この写真は、今年のものですか。去年か、それより前のものですか。", options: ["今年のもの", "去年か、それより前のもの", "分からない"],
          });
        }
      }
    }
    if (!item.project_id && originals.results[0]) {
      const candidates = await env.DB.prepare("SELECT title FROM projects WHERE ward_id = ? AND closed_at IS NULL ORDER BY created_at DESC LIMIT 6")
        .bind(wardId).all<{ title: string }>();
      pending.push({ originalId: originals.results[0].original_id, topic: "project", text: "この写真は、どの行事のものですか。", options: candidates.results.map((candidate) => candidate.title).filter((title) => title.length <= 20) });
    }
    for (const question of pending) {
      if (question.topic === "year" && item.project_id) {
        const answered = await env.DB.prepare(`SELECT c.clarification_id FROM line_clarifications c
          JOIN line_photo_batches b ON b.ward_id = c.ward_id AND b.batch_id = c.batch_id
          JOIN jobs j ON j.ward_id = c.ward_id AND j.job_id = c.job_id
          WHERE c.ward_id = ? AND b.destination = ? AND b.source_type = ? AND b.source_id = ?
          AND b.sender_id = (SELECT sender_id FROM line_photo_batches WHERE ward_id = ? AND batch_id = ?)
          AND j.project_id = ? AND j.withdrawn_at IS NULL AND c.topic = 'year' AND c.answer IS NOT NULL
          AND b.last_received_at >= ? LIMIT 1`)
          .bind(wardId, batch.destination, batch.source_type, batch.source_id, wardId, batch.batch_id, item.project_id,
            new Date(Date.parse(batch.created_at) - 30 * 60_000).toISOString()).first();
        if (answered) continue;
      }
      const exists = await env.DB.prepare(`SELECT clarification_id FROM line_clarifications WHERE ward_id = ? AND batch_id = ? AND topic = ?
        ${question.topic === "project" || question.topic === "year" ? "" : "AND original_id = ? AND (text = ? OR text LIKE 'この写真は%')"}`)
        .bind(wardId, batch.batch_id, question.topic, ...(question.topic === "project" || question.topic === "year" ? [] : [question.originalId, question.text])).first();
      if (exists) continue;
      await env.DB.prepare(`INSERT INTO line_clarifications
      (ward_id, clarification_id, batch_id, job_id, original_id, topic, text, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(wardId, newId(), batch.batch_id, item.job_id, question.originalId, question.topic, question.text, JSON.stringify(question.options)).run();
    }
    await attachClarificationQuestions(env.DB, wardId, item.job_id);
  }
  const questions = await listClarifications(env.DB, wardId, batch.batch_id);
  for (const question of questions.filter((q) => !q.sent_at && !q.answer)) {
    let text = question.text;
    try { text = await writeClarification(getClient(env), [question], items.results.length); } catch { /* 保存した質問を使う。 */ }
    text = text.replace(/\d+\s*枚目[のは、\s]*/g, "この写真の");
    if (question.topic === "unreadable") text += "\n文字で答えるか、撮り直した写真を送ってください。分からないでもかまいません。";
    await env.DB.prepare("UPDATE line_clarifications SET message_text = ? WHERE ward_id = ? AND clarification_id = ?")
      .bind(text, wardId, question.id).run();
  }
  await env.DB.prepare("UPDATE line_photo_batches SET message_text = 'ready' WHERE ward_id = ? AND batch_id = ?")
    .bind(wardId, batch.batch_id).run();
  return true;
}

export interface QuestionDeliveryDeps { fetch?: typeof fetch; now?: Date }

/** 写真へのReplyを使う前に記録する。届いたか不明な時も同じReplyを再送しない。 */
async function claimPhotoReply(db: D1Database, wardId: string, replyToken: string, now: Date): Promise<boolean> {
  const item = await db.prepare("SELECT receipt_claimed_at FROM line_photo_items WHERE ward_id = ? AND receipt_reply_token = ?")
    .bind(wardId, replyToken).first<{ receipt_claimed_at: string | null }>();
  // 質問への答えのReplyは写真のものではない。
  if (!item) return true;
  const claimed = await db.prepare(`UPDATE line_photo_items SET receipt_claimed_at = ?
    WHERE ward_id = ? AND receipt_reply_token = ? AND receipt_claimed_at IS NULL`).bind(now.toISOString(), wardId, replyToken).run();
  if (!claimed.meta.changes) return false;
  await db.prepare("UPDATE line_photo_batches SET reply_token = NULL WHERE ward_id = ? AND reply_token = ?")
    .bind(wardId, replyToken).run();
  return true;
}

/** 一対一の各写真を保存した直後に決まった受領を返す。Replyを使った印を残し、後の質問は通数の枠を通したPushにする。 */
export async function replyPhotoReceipt(env: Env, wardId: string, jobId: string, deps: QuestionDeliveryDeps = {}): Promise<void> {
  const item = await env.DB.prepare(`SELECT i.receipt_reply_token, b.destination, j.project_id FROM line_photo_items i
    JOIN line_photo_batches b ON b.ward_id = i.ward_id AND b.batch_id = i.batch_id
    JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id
    WHERE i.ward_id = ? AND i.job_id = ? AND b.source_type = 'user' AND i.receipt_claimed_at IS NULL`)
    .bind(wardId, jobId).first<{ receipt_reply_token: string | null; destination: string; project_id: string | null }>();
  if (!item?.receipt_reply_token) return;
  const credentials = await lineChannelCredentials(env, wardId, item.destination);
  if (!credentials?.accessToken || !(await claimPhotoReply(env.DB, wardId, item.receipt_reply_token, deps.now ?? new Date()))) return;
  try {
    await replyLineText(credentials.accessToken, item.receipt_reply_token,
      item.project_id ? "受け取りました。" : "受け取りました。役員が確かめます。", deps.fetch ?? fetch);
  } catch { console.error("写真の受領を返せませんでした", wardId, jobId); }
}

/** 読めない写真だけ先に聞く。引用した一枚について一問だけ送る。 */
export async function replyQuickPhotoChecks(env: Env, wardId: string, deps: QuestionDeliveryDeps = {}): Promise<void> {
  const now = deps.now ?? new Date();
  if (!isQuestionTime(now)) return;
  const batches = await env.DB.prepare(`SELECT * FROM line_photo_batches WHERE ward_id = ? AND prepared_at IS NULL
    AND send_claimed_at IS NULL AND reply_at >= ?`).bind(wardId, new Date(now.getTime() - 45_000).toISOString()).all<Batch>();
  for (const batch of batches.results) {
    const items = await env.DB.prepare(`SELECT i.job_id, i.retake_clarification_id, c.original_id, c.readability, c.reason, c.paper_kind AS paperKind
      FROM line_photo_items i JOIN intake_photo_checks c ON c.ward_id = i.ward_id AND c.job_id = i.job_id
      JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id
      WHERE i.ward_id = ? AND i.batch_id = ? AND j.withdrawn_at IS NULL ORDER BY i.image_index, j.created_at`)
      .bind(wardId, batch.batch_id).all<{ job_id: string; original_id: string; retake_clarification_id: string | null } & import("../ai/photo-check").PhotoCheck>();
    if (batch.expected_count !== null && items.results.length < batch.expected_count) continue;
    if (batch.expected_count === null && now.getTime() - Date.parse(batch.last_received_at) < PHOTO_GROUP_GAP_MS) continue;
    for (const item of items.results.filter((i) => i.readability === "unreadable" && !i.retake_clarification_id)) {
      const exists = await env.DB.prepare("SELECT clarification_id FROM line_clarifications WHERE ward_id = ? AND batch_id = ? AND original_id = ? AND topic = 'unreadable'")
        .bind(wardId, batch.batch_id, item.original_id).first();
      if (!exists) await env.DB.prepare(`INSERT INTO line_clarifications
        (ward_id, clarification_id, batch_id, job_id, original_id, topic, text, options) VALUES (?, ?, ?, ?, ?, 'unreadable', ?, ?)`)
        .bind(wardId, newId(), batch.batch_id, item.job_id, item.original_id,
          `この写真は${photoCheckMessage(item)}。文字で答えるか、明るい場所で撮り直して送ってください。分からないでもかまいません。`, JSON.stringify(["分からない"])).run();
      await attachClarificationQuestions(env.DB, wardId, item.job_id);
    }
    await deliverNextQuestion(env, wardId, batch, batch.reply_token, deps);
  }
}

/** 次は答えのReplyでだけ聞く。答えがない物への催促は置かない。 */
async function deliverNextQuestion(env: Env, wardId: string, batch: Batch, replyToken: string | null, deps: QuestionDeliveryDeps, fromLineAnswer = false): Promise<void> {
  if (batch.screen_answered_at && !fromLineAnswer) return;
  const now = deps.now ?? new Date();
  if (!isQuestionTime(now)) return;
  const questions = await listClarifications(env.DB, wardId, batch.batch_id);
  if (questions.some((q) => q.sent_at && !q.answer)) return;
  const question = questions.find((q) => !q.answer && !q.sent_at);
  if (!question) return;
  // 別のまとまりで聞いている間も、同じ場所に次の質問を重ねない。
  const open = await env.DB.prepare(`SELECT c.clarification_id FROM line_clarifications c JOIN line_photo_batches b
    ON b.ward_id = c.ward_id AND b.batch_id = c.batch_id WHERE c.ward_id = ? AND b.destination = ?
    AND b.source_type = ? AND b.source_id = ? AND c.sent_at IS NOT NULL AND c.answer IS NULL
    AND EXISTS (SELECT 1 FROM jobs j WHERE j.ward_id = c.ward_id AND j.job_id = c.job_id AND j.withdrawn_at IS NULL) LIMIT 1`)
    .bind(wardId, batch.destination, batch.source_type, batch.source_id).first();
  if (open) return;
  const text = batch.source_type === "user" ? question.text : question.message_text ?? question.text;
  if (!safeQuestionText(text)) return;
  const credentials = await lineChannelCredentials(env, wardId, batch.destination);
  if (!credentials?.accessToken) return;
  const first = !questions.some((q) => q.sent_at);
  if (!first && !replyToken) return;
  let recipients = 0;
  if (!replyToken) {
    recipients = await pushRecipientCount(credentials.accessToken, batch, deps.fetch ?? fetch);
    if (!recipients) return;
  }
  if (first) {
    const claim = await env.DB.prepare(`UPDATE line_photo_batches SET send_claimed_at = ?, send_method = ?, push_recipients = ?
      WHERE ward_id = ? AND batch_id = ? AND send_claimed_at IS NULL
      AND (SELECT COUNT(*) FROM line_photo_batches WHERE ward_id = ? AND source_type = ? AND source_id = ? AND send_claimed_at >= ?) < ?
      AND NOT EXISTS (SELECT 1 FROM line_photo_batches b JOIN line_clarifications c ON c.ward_id = b.ward_id AND c.batch_id = b.batch_id
        JOIN jobs j ON j.ward_id = c.ward_id AND j.job_id = c.job_id
        WHERE b.ward_id = ? AND b.destination = ? AND b.source_type = ? AND b.source_id = ? AND b.batch_id <> ?
        AND j.withdrawn_at IS NULL AND c.answer IS NULL AND (b.send_claimed_at IS NOT NULL OR c.sent_at IS NOT NULL))
      AND (SELECT COALESCE(SUM(push_recipients), 0) FROM line_photo_batches WHERE ward_id = ?
        AND substr(datetime(send_claimed_at, '+9 hours'), 1, 7) = ?) + ? <= ?`)
      .bind(now.toISOString(), replyToken ? "reply" : "push", recipients, wardId, batch.batch_id,
        wardId, batch.source_type, batch.source_id, questionDayStart(now), MAX_DAILY_QUESTIONS,
        wardId, batch.destination, batch.source_type, batch.source_id, batch.batch_id,
        wardId, new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 7), recipients, MAX_MONTHLY_PUSH_RECIPIENTS).run();
    if (!claim.meta.changes) return;
  }
  const claim = await env.DB.prepare(`UPDATE line_clarifications SET send_claimed_at = ? WHERE ward_id = ? AND clarification_id = ? AND send_claimed_at IS NULL AND answer IS NULL`)
    .bind(now.toISOString(), wardId, question.id).run();
  if (!claim.meta.changes) return;
  if (replyToken && !(await claimPhotoReply(env.DB, wardId, replyToken, now))) {
    // 受領が先にReplyを使った。まだ送信していない質問は、次の処理で送れるよう戻す。
    await env.DB.prepare(`UPDATE line_clarifications SET send_claimed_at = NULL
      WHERE ward_id = ? AND clarification_id = ? AND sent_at IS NULL AND send_claimed_at = ?`)
      .bind(wardId, question.id, now.toISOString()).run();
    if (first) await env.DB.prepare(`UPDATE line_photo_batches SET send_claimed_at = NULL, send_method = NULL
      WHERE ward_id = ? AND batch_id = ? AND sent_at IS NULL AND send_claimed_at = ?`)
      .bind(wardId, batch.batch_id, now.toISOString()).run();
    return;
  }
  const photo = await env.DB.prepare("SELECT quote_token FROM line_photo_items WHERE ward_id = ? AND job_id = ?")
    .bind(wardId, question.job_id).first<{ quote_token: string | null }>();
  try {
    const messageId = await sendLineQuestion(credentials.accessToken, { to: batch.source_id, replyToken, text, batchId: batch.batch_id,
      quoteToken: photo?.quote_token, camera: question.topic === "unreadable", clarificationId: question.id,
      options: question.options.map((label) => ({ label, id: question.id })) }, deps.fetch ?? fetch);
    await env.DB.batch([
      env.DB.prepare("UPDATE line_clarifications SET sent_at = ?, sent_message_id = ? WHERE ward_id = ? AND clarification_id = ?")
        .bind(now.toISOString(), messageId, wardId, question.id),
      env.DB.prepare("UPDATE line_photo_batches SET sent_at = ?, sent_message_id = ?, answer_reply_token = NULL, answer_reply_at = NULL WHERE ward_id = ? AND batch_id = ?")
        .bind(now.toISOString(), messageId, wardId, batch.batch_id),
    ]);
  } catch { /* 届いたか不明な送信は繰り返さず、役員の画面に残す。 */ }
}

/** 答えを受けたときだけ、次の質問か完了を一度返す。AIは呼ばない。 */
export async function replyAfterClarification(env: Env, wardId: string, batchId: string, replyToken: string | undefined, deps: QuestionDeliveryDeps = {}): Promise<void> {
  if (!replyToken) return;
  const now = deps.now ?? new Date();
  const batch = await env.DB.prepare("SELECT * FROM line_photo_batches WHERE ward_id = ? AND batch_id = ?")
    .bind(wardId, batchId).first<Batch & { completed_at: string | null }>();
  if (!batch || batch.completed_at) return;
  await env.DB.prepare("UPDATE line_photo_batches SET answer_reply_token = ?, answer_reply_at = ? WHERE ward_id = ? AND batch_id = ?")
    .bind(replyToken, now.toISOString(), wardId, batchId).run();
  const questions = await listClarifications(env.DB, wardId, batchId);
  if (questions.some((q) => !q.answer)) {
    await deliverNextQuestion(env, wardId, batch, replyToken, deps, true);
    return;
  }
  if (!batch.prepared_at || !batch.message_text || !questions.length) return;
  const credentials = await lineChannelCredentials(env, wardId, batch.destination);
  if (!credentials?.accessToken) return;
  const claim = await env.DB.prepare("UPDATE line_photo_batches SET completed_at = ? WHERE ward_id = ? AND batch_id = ? AND completed_at IS NULL")
    .bind(now.toISOString(), wardId, batchId).run();
  if (!claim.meta.changes) return;
  if (!(await claimPhotoReply(env.DB, wardId, replyToken, now))) return;
  try {
    await replyLineText(credentials.accessToken, replyToken, questions.some((q) => q.answered_unknown)
      ? "聞くことは以上です。分からなかったところは役員が確かめます。" : "確認できました。聞くことは以上です。ありがとうございます。", deps.fetch ?? fetch);
  } catch { /* 完了だけをPushで送り直さない。 */ }
}

/** 撮り直しは元の写真を残して読み、読めたときだけ元の質問を閉じる。 */
async function resolveRetakes(env: Env, wardId: string, deps: QuestionDeliveryDeps): Promise<void> {
  const rows = await env.DB.prepare(`SELECT i.job_id, i.retake_clarification_id, b.reply_token FROM line_photo_items i
    JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id JOIN line_photo_batches b ON b.ward_id = i.ward_id AND b.batch_id = i.batch_id
    JOIN line_clarifications c ON c.ward_id = i.ward_id AND c.clarification_id = i.retake_clarification_id
    WHERE i.ward_id = ? AND j.read_at IS NOT NULL AND j.withdrawn_at IS NULL AND c.answer IS NULL`)
    .bind(wardId).all<{ job_id: string; retake_clarification_id: string; reply_token: string | null }>();
  for (const row of rows.results) {
    const readings = await getReadings(env.DB, wardId, row.job_id);
    if (!readings.length || readings.some((r) => r.body.unreadable.length) || !readings.some((r) => "fields" in r.body ? r.body.text_blocks.length || r.body.fields.length : r.body.rows.length)) continue;
    const question = (await listClarifications(env.DB, wardId)).find((q) => q.id === row.retake_clarification_id);
    if (!question) continue;
    await saveClarificationAnswers(env.DB, wardId, `retake:${row.job_id}`, row.job_id, "撮り直した写真", [{ question, text: "撮り直した写真で読み取れました。" }], deps.now ?? new Date());
    await replyAfterClarification(env, wardId, question.batch_id, row.reply_token ?? undefined, deps);
  }
}

/** 画面で答えがそろったときも、質問を送った場所へ完了を一度書く。 */
export async function completeScreenClarifications(env: Env, wardId: string, deps: QuestionDeliveryDeps = {}): Promise<void> {
  const batches = await env.DB.prepare(`SELECT b.batch_id, b.destination, b.source_type, b.source_id FROM line_photo_batches b
    WHERE b.ward_id = ? AND b.screen_answered_at IS NOT NULL AND b.completed_at IS NULL
      AND EXISTS (SELECT 1 FROM line_clarifications c WHERE c.ward_id = b.ward_id AND c.batch_id = b.batch_id AND c.sent_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM line_clarifications c JOIN jobs j ON j.ward_id = c.ward_id AND j.job_id = c.job_id
        WHERE c.ward_id = b.ward_id AND c.batch_id = b.batch_id AND c.answer IS NULL AND j.withdrawn_at IS NULL)
    LIMIT 30`).bind(wardId).all<Pick<Batch, "batch_id" | "destination" | "source_type" | "source_id">>();
  for (const batch of batches.results) {
    const credentials = await lineChannelCredentials(env, wardId, batch.destination);
    if (!credentials?.accessToken) continue;
    const request = deps.fetch ?? fetch;
    try {
      const allowance = await inquiryPushAllowance(credentials.accessToken, [{ type: batch.source_type, id: batch.source_id }], request);
      if (!allowance?.enough) continue;
      const claim = await env.DB.prepare("UPDATE line_photo_batches SET completed_at = ? WHERE ward_id = ? AND batch_id = ? AND completed_at IS NULL")
        .bind((deps.now ?? new Date()).toISOString(), wardId, batch.batch_id).run();
      if (!claim.meta.changes) continue;
      await pushInquiryAnswer(credentials.accessToken, batch.source_id, "役員が画面で答えを残しました。聞くことは以上です。ありがとうございます。", crypto.randomUUID(), request);
    } catch { /* 届いたか分からない完了は重ねて送らない。 */ }
  }
}

export async function processPhotoBatches(env: Env, wardId: string, deps: QuestionDeliveryDeps = {}): Promise<void> {
  const now = deps.now ?? new Date();
  await purgePhotoTexts(env.DB, wardId, now);
  await matchPendingLinePhotos(env, wardId, now);
  await completeScreenClarifications(env, wardId, deps);
  await resolveRetakes(env, wardId, deps);
  const batches = await env.DB.prepare(`SELECT * FROM line_photo_batches b WHERE b.ward_id = ? AND b.prepared_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM line_photo_items i WHERE i.ward_id = b.ward_id AND i.batch_id = b.batch_id AND i.retake_clarification_id IS NOT NULL)
    AND EXISTS (SELECT 1 FROM line_photo_items i JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id
      WHERE i.ward_id = b.ward_id AND i.batch_id = b.batch_id AND j.withdrawn_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM line_photo_items i JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id
      WHERE i.ward_id = b.ward_id AND i.batch_id = b.batch_id AND j.withdrawn_at IS NULL AND j.read_at IS NULL)
    AND (b.expected_count IS NULL OR (SELECT COUNT(*) FROM line_photo_items i WHERE i.ward_id = b.ward_id AND i.batch_id = b.batch_id) >= b.expected_count)
    AND (b.expected_count IS NOT NULL OR b.last_received_at <= ?)
    ORDER BY b.created_at LIMIT 30`).bind(wardId, new Date(now.getTime() - PHOTO_GROUP_GAP_MS).toISOString()).all<Batch>();
  for (const batch of batches.results) await prepareQuestions(env, wardId, batch, now);
  const ready = await env.DB.prepare(`SELECT * FROM line_photo_batches b WHERE b.ward_id = ? AND b.prepared_at IS NOT NULL AND b.message_text IS NOT NULL AND b.completed_at IS NULL
    AND (EXISTS (SELECT 1 FROM line_clarifications c JOIN jobs j ON j.ward_id = c.ward_id AND j.job_id = c.job_id
      WHERE c.ward_id = b.ward_id AND c.batch_id = b.batch_id AND j.withdrawn_at IS NULL AND c.answer IS NULL AND c.sent_at IS NULL)
      OR (b.answer_reply_token IS NOT NULL AND NOT EXISTS (SELECT 1 FROM line_clarifications c
        WHERE c.ward_id = b.ward_id AND c.batch_id = b.batch_id AND c.answer IS NULL))) ORDER BY b.created_at LIMIT 30`)
    .bind(wardId).all<Batch & { answer_reply_token: string | null; answer_reply_at: string | null }>();
  for (const batch of ready.results) {
    const reply = batch.answer_reply_token && batch.answer_reply_at && now.getTime() - Date.parse(batch.answer_reply_at) < 45_000
      ? batch.answer_reply_token : !batch.sent_at && batch.reply_at && now.getTime() - Date.parse(batch.reply_at) < 45_000 ? batch.reply_token : null;
    if (batch.answer_reply_token && reply) await replyAfterClarification(env, wardId, batch.batch_id, reply, deps);
    else await deliverNextQuestion(env, wardId, batch, reply, deps);
  }
}

export async function sentQuestionsForSource(db: D1Database, wardId: string, destination: string, source: PhotoSource, context: { quotedMessageId?: string; clarificationId?: string; requireReference?: boolean; now?: Date } = {}): Promise<ClarificationRow[]> {
  if (context.requireReference && !context.quotedMessageId && !context.clarificationId) return [];
  const rows = await db.prepare(`SELECT c.clarification_id FROM line_clarifications c JOIN line_photo_batches b
    ON b.ward_id = c.ward_id AND b.batch_id = c.batch_id WHERE c.ward_id = ? AND b.destination = ? AND b.source_type = ? AND b.source_id = ?
    AND c.sent_at IS NOT NULL AND c.answer IS NULL
    ${!context.quotedMessageId && !context.clarificationId ? "AND c.sent_at >= ?" : ""}
    ${context.quotedMessageId ? "AND c.sent_message_id = ?" : ""} ${context.clarificationId ? "AND c.clarification_id = ?" : ""}
    ORDER BY c.sent_at DESC LIMIT 1`).bind(wardId, destination, source.type, source.id,
      ...(!context.quotedMessageId && !context.clarificationId ? [new Date((context.now ?? new Date()).getTime() - 30 * 60_000).toISOString()] : []),
      ...(context.quotedMessageId ? [context.quotedMessageId] : []), ...(context.clarificationId ? [context.clarificationId] : []))
    .all<{ clarification_id: string }>();
  if (!rows.results.length) return [];
  return (await listClarifications(db, wardId)).filter((q) => q.id === rows.results[0]!.clarification_id);
}

/** 答えは出どころのある資料。運営上の決定や配る内容には書き込まない。 */
export async function saveClarificationAnswers(db: D1Database, wardId: string, eventId: string, jobId: string, sender: string, answers: Array<{ question: ClarificationRow; text: string }>, now: Date): Promise<void> {
  await db.prepare("UPDATE jobs SET instruction = ? WHERE ward_id = ? AND job_id = ?")
    .bind("公式が送った資料について尋ねたことへの答えです。出どころ付きの資料として扱い、運営上の正式な決定にせず、配る内容を変えないでください。確認できたことと元の写真はget_readingにあります。", wardId, jobId).run();
  for (const { question, text } of answers) {
    // 同時に別の人が答えても、片方を上書きせず両方を残す。
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO line_clarification_answers (ward_id, event_id, clarification_id, job_id, answer_text, sender_label) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(wardId, eventId, question.id, jobId, text, sender),
      db.prepare(`UPDATE line_clarifications SET answered_unknown = MAX(answered_unknown, ?), answer = (SELECT group_concat(sender_label || ': ' || answer_text, char(10))
        FROM line_clarification_answers WHERE ward_id = ? AND clarification_id = ?) WHERE ward_id = ? AND clarification_id = ?`)
        .bind(isUnknownAnswer(text) ? 1 : 0, wardId, question.id, wardId, question.id),
      ...(question.question_id ? [db.prepare(`UPDATE project_questions SET
        state = CASE WHEN (SELECT COUNT(DISTINCT answer_text) FROM line_clarification_answers WHERE ward_id = ? AND clarification_id = ?) > 1 THEN 'open' WHEN ? = 1 THEN 'open' ELSE 'answered' END,
        answer = (SELECT answer FROM line_clarifications WHERE ward_id = ? AND clarification_id = ?), answered_at = ?
        WHERE ward_id = ? AND question_id = ? AND answered_by_account_id IS NULL`)
        .bind(wardId, question.id, isUnknownAnswer(text) ? 1 : 0, wardId, question.id, now.toISOString(), wardId, question.question_id)] : []),
    ]);
    const received = await db.prepare("SELECT DISTINCT answer_text FROM line_clarification_answers WHERE ward_id = ? AND clarification_id = ?")
      .bind(wardId, question.id).all<{ answer_text: string }>();
    if (received.results.length > 1 && question.question_id) await db.prepare(`UPDATE project_questions SET kind = 'conflict', state = 'open', detail = ?,
      text = ? WHERE ward_id = ? AND question_id = ? AND answered_by_account_id IS NULL`)
      .bind(JSON.stringify({ options: received.results.map((row) => row.answer_text), lineClarificationId: question.id }),
        `送った資料について、違う答えが届いています。${question.text}`.slice(0, 500), wardId, question.question_id).run();
  }
}

export const isUnknownAnswer = (text: string) => /^(?:分からない|わからない|分かりません|わかりません)[。！!\s]*$/.test(text.trim());

export function safeQuestionText(text: string): boolean {
  return text.trim().length > 0 && text.length <= MAX_QUESTION_LENGTH && !/(?:https?:|www\.|[a-z0-9-]+\.[a-z]{2,}(?:\/|\b)|[\u0000-\u0008])/i.test(text) &&
    !/(?:\]\s*\(|href\s*=|(?:^|[\s(（])(?:\/|[a-z][a-z0-9+.-]*:))/i.test(text) &&
    !/(?:今年どう|決めて|配(?:る|布する)内容|全(?:部|て).{0,8}(?:確認|点検)|雨.{0,8}(?:場所|会場).{0,8}(?:どう|どこ))/.test(text);
}

async function pushRecipientCount(token: string, batch: Batch, fetcher: typeof fetch): Promise<number> {
  const get = async (path: string): Promise<Record<string, unknown>> => {
    const response = await fetcher(`https://api.line.me/v2/bot/${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error("LINEの送信枠を確認できません");
    return await response.json() as Record<string, unknown>;
  };
  try {
    const [quota, usage, members] = await Promise.all([
      get("message/quota"), get("message/quota/consumption"),
      batch.source_type === "user" ? Promise.resolve({ count: 1 }) : get(`${batch.source_type}/${encodeURIComponent(batch.source_id)}/members/count`),
    ]);
    const count = Number(members.count);
    return Number.isInteger(count) && count > 0 && lineQuotaAllows(quota, usage, count) ? count : 0;
  } catch { return 0; }
}
