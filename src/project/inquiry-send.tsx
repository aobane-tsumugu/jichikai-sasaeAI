import type { Context } from "hono";
import type { AdminEnv } from "../env";
import { adminPath } from "../core/auth";
import { nowIso } from "../core/ids";
import { Layout } from "../core/ui";
import { adminResult } from "../core/admin-ui";
import { inquiryPushAllowance, lineAccessToken, pushInquiryAnswer, LineSendRejected } from "../line/api";
import { deliveryAlert } from "../line/delivery-alert";

export interface InquiryRow {
  inquiry_id: string; received_at: string; kind: "inquiry" | "request"; subject: string;
  line_pending_answer: string | null; line_user_id: string | null; line_source_id: string | null;
  line_answer_sent_at: string | null; line_send_claimed_at: string | null; line_send_error: string | null;
  answer: string; submitted_to_city: number; line_source_type: string | null;
  line_sender_label: string | null; line_replied_at: string | null; answer_history: string;
  line_reply_batch: string | null; line_retry_key: string | null; line_retry_started_at: string | null;
}

/** 元の文は残し、同じ内容の比べと見出しからだけ呼びかけを外す。 */
export const inquirySubject = (text: string) => text.trim().replace(/^(公式へ|自治会へ)[\s、,:：。]*/, "").trim();
export const inquiryTarget = (row: InquiryRow) => row.line_source_type === "user" ? row.line_user_id
  : row.line_source_type === "group" || row.line_source_type === "room" ? row.line_source_id : null;
export const sameInquiry = (a: InquiryRow, b: InquiryRow) => inquirySubject(a.subject) === inquirySubject(b.subject)
  && (a.answer === b.answer || Boolean(a.line_reply_batch && a.line_reply_batch === b.line_reply_batch));

export async function sendInquiry(c: Context<AdminEnv>, record: InquiryRow, group: InquiryRow[], answer: string) {
  const { ward, account } = c.var;
  const path = adminPath(ward, `/inquiries/${encodeURIComponent(record.inquiry_id)}`);
  const now = nowIso();
  if (group.some((row) => row.line_send_claimed_at && (row.line_pending_answer !== answer || Date.parse(now) - Date.parse(row.line_send_claimed_at) < 60_000))) {
    return adminResult(c, "返事を送っているところです。", 409, { href: path, label: "問い合わせに戻る" }, "少し待ってから、送った結果を確かめてください。");
  }
  const batch = record.line_reply_batch ?? record.inquiry_id;
  const targets = new Map<string, InquiryRow[]>();
  for (const row of group.filter((row) => row.line_source_type)) {
    const id = inquiryTarget(row);
    if (id) targets.set(id, [...(targets.get(id) ?? []), row]);
  }
  // 送った文が同じなら、その場所には重ねて送らない。
  const pending = [...targets].filter(([, rows]) => !rows.some((row) => row.line_answer_sent_at && row.answer === answer));
  await c.env.DB.batch(group.map((row) => c.env.DB.prepare(`UPDATE inquiry_records SET line_reply_batch = ?, line_pending_answer = ?
    WHERE ward_id = ? AND inquiry_id = ?`).bind(batch, row.line_answer_sent_at && row.answer === answer ? null : answer, ward.wardId, row.inquiry_id)));
  const token = await lineAccessToken(c.env, ward.wardId);
  let reason = "";
  if (!token || !targets.size) reason = "LINEでは返せません。だれか分かるときは、電話や直接返事をしてください。";
  if (!reason && token && pending.length) {
    try {
      const allowance = await inquiryPushAllowance(token, pending.map(([id, rows]) => ({ id, type: rows[0]!.line_source_type! })));
      if (!allowance) reason = "送れる通数を確かめられないため、送っていません。";
      else if (!allowance.enough) reason = "今月、自治会のLINEで送れる通数が足りないため、送っていません。";
    } catch { reason = "送れる通数を確かめられないため、送っていません。"; }
  }
  const failed: string[] = [];
  if (!reason && token) for (const [id, rows] of pending) {
    const row = rows.find((row) => row.line_retry_key && row.line_pending_answer === answer) ?? rows[0]!;
    const continuing = row.line_pending_answer === answer && row.line_retry_key;
    const expired = continuing && row.line_retry_started_at && Date.parse(now) - Date.parse(row.line_retry_started_at) >= 24 * 3600_000;
    if ((expired && row.line_send_error !== "rejected") || (row.line_send_claimed_at && !row.line_retry_key)) {
      failed.push(id); reason = "前の送信結果を確かめられません。電話や直接返事をしてください。"; continue;
    }
    const key = continuing && !expired ? row.line_retry_key! : crypto.randomUUID();
    const started = continuing && !expired ? row.line_retry_started_at ?? now : now;
    const claim = await c.env.DB.prepare(`UPDATE inquiry_records SET line_send_claimed_at = ?, line_retry_key = ?, line_retry_started_at = ?, line_send_error = NULL
      WHERE ward_id = ? AND inquiry_id = ? AND (line_send_claimed_at IS NULL OR line_send_claimed_at < ?)`)
      .bind(now, key, started, ward.wardId, row.inquiry_id, new Date(Date.parse(now) - 60_000).toISOString()).run();
    if (!claim.meta.changes) { failed.push(id); continue; }
    try { await pushInquiryAnswer(token, id, answer, key); }
    catch (error) {
      failed.push(id);
      await c.env.DB.prepare(`UPDATE inquiry_records SET line_send_claimed_at = NULL, line_send_error = ? WHERE ward_id = ? AND inquiry_id = ?`)
        .bind(error instanceof LineSendRejected && error.status >= 400 && error.status < 500 ? "rejected" : "unconfirmed", ward.wardId, row.inquiry_id).run();
      continue;
    }
    await c.env.DB.batch(rows.map((row) => {
      const history = JSON.parse(row.answer_history) as Array<{ answer: string; submitted_to_city: number; created_at: string; created_by_account_id?: string }>;
      // 市に伝えたかどうかは送るときに変えない。今の値をそのまま残す。
      history.push({ answer, submitted_to_city: row.submitted_to_city, created_at: now, created_by_account_id: account.accountId });
      return c.env.DB.prepare(`UPDATE inquiry_records SET answer = ?, answer_history = ?, line_answer_sent_at = ?,
        line_send_claimed_at = NULL, line_send_error = NULL, line_pending_answer = NULL, line_retry_key = NULL, line_retry_started_at = NULL
        WHERE ward_id = ? AND inquiry_id = ?`).bind(answer, JSON.stringify(history), now, ward.wardId, row.inquiry_id);
    }));
  }
  if (reason || failed.length || group.some((row) => row.line_source_type && !inquiryTarget(row))) {
    const message = reason || "自治会のLINEの返事を送れない相手がいます。";
    await deliveryAlert(c.env.DB, ward.wardId, "reply", message);
    const count = reason ? pending.length : failed.length;
    const unit = pending.filter(([id]) => reason || failed.includes(id)).some(([, rows]) => rows[0]!.line_source_type !== "user") ? "か所" : "人";
    return c.html(<Layout title="返事を送れませんでした" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
      <a class="back" href={path}>← 問い合わせへ</a><h1>返事を送れませんでした</h1>
      <div class="notice warn"><strong>{message}</strong><p>送れた返事と、まだ送れていない文は残しています。</p></div>
      <h2>書いた返事</h2><p class="preserve-lines">{answer}</p>
      <section class="next"><strong>次は</strong>{count && !reason.includes("電話や直接") ? <><p>まだ送れていない{count}{unit}にだけ、もう一度送れます。</p>
        <form method="post" action={path}><input type="hidden" name="answer" value={answer} /><button name="operation" value="retry">{count}{unit}に送り直す</button></form></>
        : <><p>だれか分かるときは、電話や直接返事をしてください。</p><a class="button" href={path}>どう返事をしたかを残す</a></>}</section>
      <a class="quiet" href={path}>問い合わせに戻る</a>
    </Layout>, !token || !targets.size ? 400 : 502);
  }
  await deliveryAlert(c.env.DB, ward.wardId, "reply", null);
  return c.redirect(`${path}?sent=1`, 303);
}
