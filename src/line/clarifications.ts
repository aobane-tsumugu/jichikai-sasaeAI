import type { Env } from "../env";
import { newId } from "../core/ids";
import { getClient } from "../ai/deps";
import { writeClarification, type ClarificationPrompt } from "../ai/clarification";
import { getReadings } from "../intake/store";
import { addQuestion } from "../project/api";
import { lineChannelCredentials, sendLineQuestion } from "./api";
import { photoCheckMessage } from "../intake/photo-check";
import { sha256Hex } from "../intake/media";

// 実測前の仮の値。夜の質問、催促、無制限の通知を作らない。
export const PHOTO_GROUP_GAP_MS = 5000;
export const MAX_QUESTION_LENGTH = 800;
export const MAX_MONTHLY_PUSH_RECIPIENTS = 50;
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
}

export async function registerLinePhoto(db: D1Database, wardId: string, input: {
  destination: string; source: PhotoSource; jobId: string; messageId: string;
  imageSet?: { id?: string; index?: number; total?: number }; quoteToken?: string;
  replyToken?: string; now: Date;
}): Promise<string> {
  const { source, imageSet, now } = input;
  const setId = typeof imageSet?.id === "string" ? imageSet.id : null;
  const prior = await db.prepare(`SELECT batch_id FROM line_photo_batches WHERE ward_id = ? AND destination = ?
    AND source_type = ? AND source_id = ? AND sender_id = ? AND prepared_at IS NULL
    AND ((? IS NOT NULL AND image_set_id = ?) OR (? IS NULL AND image_set_id IS NULL AND last_received_at >= ?))
    ORDER BY last_received_at DESC LIMIT 1`).bind(wardId, input.destination, source.type, source.id, source.senderId,
      setId, setId, setId, new Date(now.getTime() - PHOTO_GROUP_GAP_MS).toISOString()).first<{ batch_id: string }>();
  // imageSet の同時受信でも同じ ID になる。送り先と送った人も必ず含める。
  const id = prior?.batch_id ?? await sha256Hex(JSON.stringify([input.destination, source.type, source.id, source.senderId,
    setId ? ["set", setId] : ["time", Math.floor(now.getTime() / PHOTO_GROUP_GAP_MS)]]));
  const expected = Number.isInteger(imageSet?.total) && imageSet!.total! > 0 && imageSet!.total! <= 30 ? imageSet!.total! : null;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO line_photo_batches
      (ward_id, batch_id, destination, source_type, source_id, sender_id, image_set_id, expected_count, created_at, last_received_at, reply_token, reply_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(wardId, id, input.destination, source.type, source.id, source.senderId, setId, expected, now.toISOString(), now.toISOString(), input.replyToken ?? null, now.toISOString()),
    db.prepare(`INSERT OR IGNORE INTO line_photo_items (ward_id, batch_id, job_id, message_id, image_index, quote_token)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(wardId, id, input.jobId, input.messageId, Number.isInteger(imageSet?.index) ? imageSet!.index! : null, input.quoteToken ?? null),
    db.prepare(`UPDATE line_photo_batches SET last_received_at = ?, reply_token = ?, reply_at = ? WHERE ward_id = ? AND batch_id = ? AND prepared_at IS NULL`)
      .bind(now.toISOString(), input.replyToken ?? null, now.toISOString(), wardId, id),
  ]);
  return id;
}

export interface ClarificationRow extends ClarificationPrompt {
  batch_id: string; job_id: string; original_id: string; question_id: string | null; project_id: string | null;
  answer: string | null;
  sent_at: string | null;
}

export async function listClarifications(db: D1Database, wardId: string, batchId?: string): Promise<ClarificationRow[]> {
  const result = await db.prepare(`SELECT c.clarification_id AS id, c.batch_id, c.job_id, c.original_id, c.topic, c.text,
    c.options, c.question_id, c.answer, c.sent_at, j.project_id FROM line_clarifications c
    JOIN jobs j ON j.ward_id = c.ward_id AND j.job_id = c.job_id
    WHERE c.ward_id = ? AND j.withdrawn_at IS NULL ${batchId ? "AND c.batch_id = ?" : ""} ORDER BY c.clarification_id`)
    .bind(...(batchId ? [wardId, batchId] : [wardId])).all<Omit<ClarificationRow, "options"> & { options: string }>();
  return result.results.map((row) => ({ ...row, options: JSON.parse(row.options) as string[] }));
}

/** 行事が後から分かった質問も、同じ役員の質問画面へつなぐ。 */
export async function attachClarificationQuestions(db: D1Database, wardId: string, jobId: string): Promise<void> {
  const rows = await db.prepare(`SELECT c.clarification_id, c.original_id, c.text, c.options, c.answer, j.project_id
    FROM line_clarifications c JOIN jobs j ON j.ward_id = c.ward_id AND j.job_id = c.job_id
    JOIN projects p ON p.ward_id = j.ward_id AND p.project_id = j.project_id
    WHERE c.ward_id = ? AND c.job_id = ? AND c.question_id IS NULL AND j.withdrawn_at IS NULL AND p.closed_at IS NULL`)
    .bind(wardId, jobId).all<{ clarification_id: string; original_id: string; text: string; options: string; answer: string | null; project_id: string }>();
  for (const row of rows.results) {
    const question = await addQuestion(db, wardId, row.project_id, {
      kind: "unreadable", text: row.text.length <= 500 ? row.text : "送った写真に読めないところがあります。届いたものの「送った資料についての質問」で、元の資料と詳しい内容を見られます。", target: "送った資料の確認", options: JSON.parse(row.options) as string[],
      source: { kind: "original", ref: row.original_id, locator: "写真の確認" }, packVersion: "line-clarification@1",
    });
    if (question.status === "added" || question.status === "same") {
      await db.prepare("UPDATE line_clarifications SET question_id = ? WHERE ward_id = ? AND clarification_id = ?")
        .bind(question.questionId, wardId, row.clarification_id).run();
      if (row.answer) await db.prepare("UPDATE project_questions SET state = 'answered', answer = ?, answered_at = ? WHERE ward_id = ? AND question_id = ? AND state = 'open'")
        .bind(row.answer, new Date().toISOString(), wardId, question.questionId).run();
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
  const claim = await env.DB.prepare("UPDATE line_photo_batches SET prepared_at = ? WHERE ward_id = ? AND batch_id = ? AND prepared_at IS NULL")
    .bind(now.toISOString(), wardId, batch.batch_id).run();
  if (!claim.meta.changes) return false;
  for (const [index, item] of items.results.entries()) {
    const originals = await env.DB.prepare("SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ? AND withdrawn_at IS NULL ORDER BY position")
      .bind(wardId, item.job_id).all<{ original_id: string }>();
    const readings = await getReadings(env.DB, wardId, item.job_id);
    const pending: Array<{ originalId: string; topic: ClarificationPrompt["topic"]; text: string; options: string[] }> = [];
    const paper = readings.some((reading) => "fields" in reading.body && reading.body.document_kind !== "photo");
    for (const reading of readings) {
      const unreadables = new Map<string, string[]>();
      for (const unreadable of reading.body.unreadable) {
        if (!originals.results.some((original) => original.original_id === unreadable.original_id)) continue;
        const notes = unreadables.get(unreadable.original_id) ?? [];
        notes.push(`${unreadable.locator}: ${unreadable.note}`);
        unreadables.set(unreadable.original_id, notes);
      }
      for (const [originalId, notes] of unreadables) pending.push({ originalId, topic: "unreadable", text: `${item.image_index ?? index + 1}枚目の${notes.join("。\n")}。読めるように撮り直せますか。`, options: [] });
      if ("fields" in reading.body && reading.body.document_kind !== "photo") {
        for (const year of reading.body.original_years) {
          if (year.year === null && originals.results.some((original) => original.original_id === year.original_id)) pending.push({
            originalId: year.original_id, topic: "year", text: `${item.image_index ?? index + 1}枚目は、今年のものでしょうか。去年のものでしょうか。`, options: ["今年のもの", "去年のもの"],
          });
        }
      }
    }
    if (!item.project_id && paper && originals.results[0]) {
      const candidates = await env.DB.prepare("SELECT title FROM projects WHERE ward_id = ? AND closed_at IS NULL ORDER BY created_at DESC LIMIT 6")
        .bind(wardId).all<{ title: string }>();
      pending.push({ originalId: originals.results[0].original_id, topic: "project", text: "受け取った紙は、どの行事のものですか。", options: candidates.results.map((candidate) => candidate.title).filter((title) => title.length <= 20) });
    }
    for (const question of pending) {
      const exists = await env.DB.prepare(`SELECT clarification_id FROM line_clarifications WHERE ward_id = ? AND batch_id = ? AND topic = ? ${question.topic === "project" ? "" : "AND original_id = ?"}`)
        .bind(wardId, batch.batch_id, question.topic, ...(question.topic === "project" ? [] : [question.originalId])).first();
      if (exists) continue;
      await env.DB.prepare(`INSERT INTO line_clarifications
      (ward_id, clarification_id, batch_id, job_id, original_id, topic, text, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(wardId, newId(), batch.batch_id, item.job_id, question.originalId, question.topic, question.text, JSON.stringify(question.options)).run();
    }
    await attachClarificationQuestions(env.DB, wardId, item.job_id);
  }
  const questions = (await listClarifications(env.DB, wardId, batch.batch_id)).filter((question) => !question.sent_at && !question.answer);
  if (!questions.length) return false;
  let text: string;
  try { text = await writeClarification(getClient(env), questions, items.results.length); }
  catch { text = questions.map((question) => question.text).join("\n"); }
  await env.DB.prepare("UPDATE line_photo_batches SET message_text = ? WHERE ward_id = ? AND batch_id = ?")
    .bind(text, wardId, batch.batch_id).run();
  return true;
}

export interface QuestionDeliveryDeps { fetch?: typeof fetch; now?: Date }

/** 読めない写真だけ、その場で一通の Reply にする。読めた写真には返さない。 */
export async function replyQuickPhotoChecks(env: Env, wardId: string, deps: QuestionDeliveryDeps = {}): Promise<void> {
  const now = deps.now ?? new Date();
  if (!isQuestionTime(now)) return;
  const batches = await env.DB.prepare(`SELECT * FROM line_photo_batches WHERE ward_id = ? AND quick_replied = 0
    AND sent_at IS NULL AND reply_at >= ?`).bind(wardId, new Date(now.getTime() - 45_000).toISOString()).all<Batch>();
  for (const batch of batches.results) {
    if (!batch.reply_token) continue;
    const items = await env.DB.prepare(`SELECT i.job_id, i.image_index, c.original_id, c.readability, c.reason, c.paper_kind AS paperKind
      FROM line_photo_items i JOIN intake_photo_checks c ON c.ward_id = i.ward_id AND c.job_id = i.job_id
      JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id
      WHERE i.ward_id = ? AND i.batch_id = ? AND j.withdrawn_at IS NULL ORDER BY i.image_index, j.created_at`)
      .bind(wardId, batch.batch_id).all<{ job_id: string; image_index: number | null; original_id: string } & import("../ai/photo-check").PhotoCheck>();
    if (batch.expected_count !== null && items.results.length < batch.expected_count) continue;
    if (batch.expected_count === null && now.getTime() - Date.parse(batch.last_received_at) < PHOTO_GROUP_GAP_MS) continue;
    const bad = items.results.filter((item) => item.readability === "unreadable");
    if (!bad.length) continue;
    const text = `${items.results.length}枚受け取りました。${bad.map((item) => `${item.image_index ?? items.results.indexOf(item) + 1}枚目は${photoCheckMessage(item)}。`).join("\n")}明るい場所で、紙の全体が入るように撮れますか。撮れないときは、このままでかまいません。`;
    if (!safeQuestionText(text)) continue;
    for (const item of bad) {
      const exists = await env.DB.prepare("SELECT clarification_id FROM line_clarifications WHERE ward_id = ? AND batch_id = ? AND original_id = ? AND topic = 'unreadable'")
        .bind(wardId, batch.batch_id, item.original_id).first();
      if (!exists) await env.DB.prepare(`INSERT INTO line_clarifications
        (ward_id, clarification_id, batch_id, job_id, original_id, topic, text) VALUES (?, ?, ?, ?, ?, 'unreadable', ?)`)
        .bind(wardId, newId(), batch.batch_id, item.job_id, item.original_id,
          `${item.image_index ?? items.results.indexOf(item) + 1}枚目は${photoCheckMessage(item)}。明るい場所で、紙の全体が入るように撮れますか。`).run();
      await attachClarificationQuestions(env.DB, wardId, item.job_id);
    }
    const credentials = await lineChannelCredentials(env, wardId, batch.destination);
    if (!credentials?.accessToken) continue;
    const claim = await env.DB.prepare(`UPDATE line_photo_batches SET quick_replied = 1 WHERE ward_id = ? AND batch_id = ? AND quick_replied = 0 AND send_claimed_at IS NULL
      AND (SELECT COALESCE(SUM(CASE WHEN reply_at >= ? THEN quick_replied ELSE 0 END + CASE WHEN send_claimed_at >= ? THEN 1 ELSE 0 END), 0)
        FROM line_photo_batches WHERE ward_id = ? AND source_type = ? AND source_id = ?) < ?`)
      .bind(wardId, batch.batch_id, questionDayStart(now), questionDayStart(now), wardId, batch.source_type, batch.source_id, MAX_DAILY_QUESTIONS).run();
    if (!claim.meta.changes) continue;
    try {
      const messageId = await sendLineQuestion(credentials.accessToken, { to: batch.source_id, replyToken: batch.reply_token, text, batchId: batch.batch_id, options: [] }, deps.fetch ?? fetch);
      await env.DB.batch([
        env.DB.prepare("UPDATE line_photo_batches SET quick_message_id = ?, quick_sent_at = ? WHERE ward_id = ? AND batch_id = ?").bind(messageId, now.toISOString(), wardId, batch.batch_id),
        env.DB.prepare("UPDATE line_clarifications SET sent_at = ? WHERE ward_id = ? AND batch_id = ? AND topic = 'unreadable'").bind(now.toISOString(), wardId, batch.batch_id),
      ]);
    } catch { /* 原本を残し、通常の読み取りを続ける。 */ }
  }
}

/** 読み取り後か五分ごとの処理が呼ぶ。答えが無い物を催促する処理は置かない。 */
export async function processPhotoBatches(env: Env, wardId: string, deps: QuestionDeliveryDeps = {}): Promise<void> {
  const now = deps.now ?? new Date();
  const batches = await env.DB.prepare(`SELECT * FROM line_photo_batches b WHERE b.ward_id = ? AND send_claimed_at IS NULL AND send_method IS NULL
    AND (prepared_at IS NULL OR message_text IS NOT NULL)
    AND EXISTS (SELECT 1 FROM line_photo_items i JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id WHERE i.ward_id = b.ward_id AND i.batch_id = b.batch_id AND j.withdrawn_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM line_photo_items i JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id WHERE i.ward_id = b.ward_id AND i.batch_id = b.batch_id AND j.withdrawn_at IS NULL AND j.read_at IS NULL)
    AND (expected_count IS NULL OR (SELECT COUNT(*) FROM line_photo_items i JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id WHERE i.ward_id = b.ward_id AND i.batch_id = b.batch_id AND j.withdrawn_at IS NULL) >= expected_count)
    AND (expected_count IS NOT NULL OR last_received_at <= ?)
    ORDER BY prepared_at IS NOT NULL, created_at LIMIT 30`).bind(wardId, new Date(now.getTime() - PHOTO_GROUP_GAP_MS).toISOString()).all<Batch>();
  for (const batch of batches.results) {
    if (!batch.prepared_at) await prepareQuestions(env, wardId, batch, now);
    // 保存した質問の全てを送る。長すぎる文は送らず、役員画面に残す。
    const current = await env.DB.prepare("SELECT message_text, reply_token, reply_at, quick_replied FROM line_photo_batches WHERE ward_id = ? AND batch_id = ?")
      .bind(wardId, batch.batch_id).first<{ message_text: string | null; reply_token: string | null; reply_at: string | null; quick_replied: number }>();
    if (!current?.message_text || !isQuestionTime(now)) continue;
    if (!safeQuestionText(current.message_text)) {
      await env.DB.prepare("UPDATE line_photo_batches SET send_method = 'screen' WHERE ward_id = ? AND batch_id = ? AND send_claimed_at IS NULL").bind(wardId, batch.batch_id).run();
      continue;
    }
    const credentials = await lineChannelCredentials(env, wardId, batch.destination);
    if (!credentials?.accessToken) continue;
    const questions = (await listClarifications(env.DB, wardId, batch.batch_id)).filter((question) => !question.sent_at && !question.answer);
    if (!questions.length) {
      await env.DB.prepare("UPDATE line_photo_batches SET send_method = 'screen' WHERE ward_id = ? AND batch_id = ? AND send_claimed_at IS NULL").bind(wardId, batch.batch_id).run();
      continue;
    }
    // 一段目の撮り直しを既に聞いた時は、同じ撮り直しを重ねて送らない。
    if (current.quick_replied && questions.every((question) => question.topic === "unreadable")) continue;
    const reply = !current.quick_replied && current.reply_token && current.reply_at && now.getTime() - Date.parse(current.reply_at) < 45_000 ? current.reply_token : null;
    let recipients = 0;
    if (!reply) {
      const dayStart = questionDayStart(now);
      const recent = await env.DB.prepare(`SELECT batch_id FROM line_photo_batches WHERE ward_id = ? AND source_type = ? AND source_id = ? AND send_claimed_at >= ? LIMIT 1`)
        .bind(wardId, batch.source_type, batch.source_id, dayStart).first();
      if (recent) continue;
      recipients = await pushRecipientCount(credentials.accessToken, batch, deps.fetch ?? fetch);
      if (!recipients) continue;
    }
    const month = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 7);
    const claim = await env.DB.prepare(`UPDATE line_photo_batches SET send_claimed_at = ?, push_recipients = ?, send_method = ?
      WHERE ward_id = ? AND batch_id = ? AND send_claimed_at IS NULL
      AND (? = 0 OR quick_replied = 0)
      AND (SELECT COALESCE(SUM(CASE WHEN reply_at >= ? THEN quick_replied ELSE 0 END + CASE WHEN send_claimed_at >= ? THEN 1 ELSE 0 END), 0)
        FROM line_photo_batches WHERE ward_id = ? AND source_type = ? AND source_id = ?) < ?
      AND (? = 0 OR (NOT EXISTS (SELECT 1 FROM line_photo_batches WHERE ward_id = ? AND source_type = ? AND source_id = ? AND send_claimed_at >= ?)
        AND (SELECT COALESCE(SUM(push_recipients), 0) FROM line_photo_batches WHERE ward_id = ? AND substr(datetime(send_claimed_at, '+9 hours'), 1, 7) = ?) + ? <= ?))`)
      .bind(now.toISOString(), recipients, reply ? "reply" : "push", wardId, batch.batch_id, reply ? 1 : 0,
        questionDayStart(now), questionDayStart(now), wardId, batch.source_type, batch.source_id, MAX_DAILY_QUESTIONS,
        recipients, wardId, batch.source_type, batch.source_id, questionDayStart(now), wardId, month, recipients, MAX_MONTHLY_PUSH_RECIPIENTS).run();
    if (!claim.meta.changes) continue;
    try {
      const sentId = await sendLineQuestion(credentials.accessToken, { to: batch.source_id, replyToken: reply,
        text: current.message_text, batchId: batch.batch_id, options: questions.flatMap((question) => question.options.map((label) => ({ label, id: question.id }))).slice(0, 6) }, deps.fetch ?? fetch);
      await env.DB.batch([
        env.DB.prepare("UPDATE line_photo_batches SET sent_at = ?, sent_message_id = ? WHERE ward_id = ? AND batch_id = ?")
          .bind(now.toISOString(), sentId, wardId, batch.batch_id),
        env.DB.prepare("UPDATE line_clarifications SET sent_at = ? WHERE ward_id = ? AND batch_id = ? AND sent_at IS NULL")
          .bind(now.toISOString(), wardId, batch.batch_id),
      ]);
    } catch { /* 応答が不明な書き込みは再送しない。質問は画面に残る。 */ }
  }
}

export async function sentQuestionsForSource(db: D1Database, wardId: string, destination: string, source: PhotoSource, context: { quotedMessageId?: string; clarificationId?: string; now?: Date } = {}): Promise<ClarificationRow[]> {
  const explicit = context.quotedMessageId || context.clarificationId;
  const batches = await db.prepare(`SELECT batch_id FROM line_photo_batches WHERE ward_id = ? AND destination = ? AND source_type = ? AND source_id = ?
    AND (sent_at IS NOT NULL OR quick_sent_at IS NOT NULL)
    ${context.quotedMessageId ? "AND (sent_message_id = ? OR quick_message_id = ?)" : ""}
    ${explicit ? "" : "AND COALESCE(sent_at, quick_sent_at) >= ?"}
    ORDER BY COALESCE(sent_at, quick_sent_at) DESC ${explicit ? "" : "LIMIT 1"}`)
    .bind(wardId, destination, source.type, source.id, ...(context.quotedMessageId ? [context.quotedMessageId, context.quotedMessageId] : []),
      ...(explicit ? [] : [new Date((context.now ?? new Date()).getTime() - 30 * 60_000).toISOString()]))
    .all<{ batch_id: string }>();
  const questions = (await Promise.all(batches.results.map((batch) => listClarifications(db, wardId, batch.batch_id)))).flat().filter((question) => question.sent_at);
  return context.clarificationId ? questions.filter((question) => question.id === context.clarificationId) : questions;
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
      db.prepare(`UPDATE line_clarifications SET answer = (SELECT group_concat(sender_label || ': ' || answer_text, char(10))
        FROM line_clarification_answers WHERE ward_id = ? AND clarification_id = ?) WHERE ward_id = ? AND clarification_id = ?`)
        .bind(wardId, question.id, wardId, question.id),
      ...(question.question_id ? [db.prepare(`UPDATE project_questions SET
        state = CASE WHEN (SELECT COUNT(DISTINCT answer_text) FROM line_clarification_answers WHERE ward_id = ? AND clarification_id = ?) > 1 THEN 'open' ELSE 'answered' END,
        answer = (SELECT answer FROM line_clarifications WHERE ward_id = ? AND clarification_id = ?), answered_at = ?
        WHERE ward_id = ? AND question_id = ? AND answered_by_account_id IS NULL`)
        .bind(wardId, question.id, wardId, question.id, now.toISOString(), wardId, question.question_id)] : []),
    ]);
    const received = await db.prepare("SELECT DISTINCT answer_text FROM line_clarification_answers WHERE ward_id = ? AND clarification_id = ?")
      .bind(wardId, question.id).all<{ answer_text: string }>();
    if (received.results.length > 1 && question.project_id) await addQuestion(db, wardId, question.project_id, {
      kind: "conflict", text: `送った資料について、違う答えが届いています。${question.text}`.slice(0, 500),
      target: "送った資料の確認",
      source: { kind: "original", ref: question.original_id, locator: "公式LINEで届いた答え" }, packVersion: "line-clarification-answer@1",
    });
  }
}

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
    return Number.isInteger(count) && count > 0 && quota.type === "limited" && Number(quota.value) - Number(usage.totalUsage) >= count ? count : 0;
  } catch { return 0; }
}
