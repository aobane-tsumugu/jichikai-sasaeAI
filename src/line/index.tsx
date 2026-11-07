import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { CRON } from "../core/cron";
import type { AdminEnv, AppEnv } from "../env";
import { adminPath } from "../core/auth";
import { adminResult } from "../core/admin-ui";
import { answerQuestion } from "../project/actions";
import { markRosterAnswered } from "../intake/store";
import { sendOfficerDigest } from "./digest";
import { completeScreenClarifications, listClarifications, processPhotoBatches } from "./clarifications";
import { acceptLineWebhook } from "./webhook";
import { purgePhotoTexts } from "./photo-context";
import { talkAdmin } from "./talk-pages";
import { conversationFor } from "./talks";

export async function listInboxItems(db: D1Database, wardId: string): Promise<{ item_id: string; job_id: string | null; original_kind: string; original_text: string | null; matched_project_name: string | null; disposition: string }[]> {
  const result = await db.prepare(`
    SELECT i.bundle_id, i.item_id, i.job_id, i.original_kind, i.original_text, i.received_at, i.disposition, i.sender_display_name, i.sender_label,
      i.matched_project_name, i.match_reason, j.project_id AS job_project_id
    FROM line_inbox_items i LEFT JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id
    WHERE i.ward_id = ? AND (i.job_id IS NULL OR j.withdrawn_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM inquiry_records q WHERE q.ward_id = i.ward_id AND q.line_bundle_id = i.bundle_id)
    ORDER BY i.received_at DESC, i.item_id
  `).bind(wardId).all<{ item_id: string; job_id: string | null; original_kind: string; original_text: string | null; matched_project_name: string | null; disposition: string }>();
  return result.results;
}

const admin = new Hono<AdminEnv>();
admin.route("/", talkAdmin);

admin.post("/inbox/questions/:clarificationId", async (c) => {
  const { ward, account } = c.var;
  const question = (await listClarifications(c.env.DB, ward.wardId)).find((question) => question.id === c.req.param("clarificationId"));
  if (!question) return c.notFound();
  const choices = await c.env.DB.prepare("SELECT DISTINCT answer_text FROM line_clarification_answers WHERE ward_id = ? AND clarification_id = ?")
    .bind(ward.wardId, question.id).all<{ answer_text: string }>();
  if (question.answer && (choices.results.length <= 1 || choices.results.some((row) => row.answer_text === question.answer))) return c.notFound();
  const form = await c.req.formData();
  const value = form.get("unknown") === "1" ? "分からない" : String(form.get("answer") ?? "").trim();
  const target = await conversationFor(c.env.DB, ward.wardId, { jobId: question.job_id });
  const returnTo = target ? adminPath(ward, target) : adminPath(ward, "/inbox");
  const back = { href: returnTo, label: "質問に戻る" };
  if (!value || value.length > 2000) return adminResult(c, "答えを入れてください。", 400, back, "分かるところを2000文字までで書いてください。");
  if (question.project_id && question.question_id) {
    if (!await answerQuestion(c.env.DB, ward.wardId, question.project_id, question.question_id, value === "分からない" ? "unknown" : "answer", value, account.accountId)) return adminResult(c, "答えを残せませんでした。", 409, back, "質問が閉じられていないか確かめてください。");
  } else await c.env.DB.batch([
    c.env.DB.prepare("UPDATE line_clarifications SET answer = ?, answered_unknown = ? WHERE ward_id = ? AND clarification_id = ? AND (answer IS NULL OR answer = ?)").bind(value, value === "分からない" ? 1 : 0, ward.wardId, question.id, question.answer),
    c.env.DB.prepare("UPDATE line_photo_batches SET screen_answered_at = ?, answer_reply_token = NULL, answer_reply_at = NULL WHERE ward_id = ? AND batch_id = ?").bind(new Date().toISOString(), ward.wardId, question.batch_id),
  ]);
  await completeScreenClarifications(c.env, ward.wardId);
  const [page, anchor] = returnTo.split("#");
  return c.redirect(`${page}?n=answered${anchor ? `&at=${anchor.slice(6)}#${anchor}` : ""}`, 303);
});

admin.post("/inbox/roster/:jobId/skip", async (c) => {
  await markRosterAnswered(c.env.DB, c.var.ward.wardId, c.req.param("jobId"), "skipped");
  return c.redirect(`/${c.var.ward.slug}/admin/inbox?n=roster`, 303);
});

export const line: Bundle = {
  admin,
  async scheduled(event, env) {
    if (event.cron !== CRON.EVERY_5_MIN) return;
    // 最初に接続先の台帳から区だけを取り出し、以後の読み書きは全てその区に限定する。
    const wards = await env.DB.prepare(`SELECT DISTINCT l.ward_id, w.slug FROM line_channels l JOIN wards w ON w.ward_id = l.ward_id
      WHERE w.ward_id = l.ward_id AND w.is_active = 1`).all<{ ward_id: string; slug: string }>();
    const now = new Date();
    // 接続を外した区でも、一時的な文の期限を延ばさない。
    const contextWards = await env.DB.prepare("SELECT DISTINCT ward_id FROM line_photo_context_texts WHERE ward_id IS NOT NULL")
      .all<{ ward_id: string }>();
    for (const ward of contextWards.results) await purgePhotoTexts(env.DB, ward.ward_id, now);
    for (const ward of wards.results) {
      try {
        await sendOfficerDigest(env, ward.ward_id, ward.slug, now);
      }
      catch { console.error("役員への通知を送れませんでした", ward.ward_id); }
      await processPhotoBatches(env, ward.ward_id);
    }
  },
  hooks: new Hono<AppEnv>().post("/line", async (c) =>
    acceptLineWebhook(c.req.raw, c.env, c.env.DB, undefined, new Date(), c.executionCtx),
  ),
};

export { getLineAllowance, sendLineTitleAndUrl, lineAccessToken } from "./api";
