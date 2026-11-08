import { DEFAULT_DIGEST, digestCutoff, digestPeriodLabel, getDigestSettings, inquiryNotice, type DigestSettings } from "../settings/digest";
import type { Env } from "../env";
import { isOfficerDigestTime } from "../core/cron";
import { lineAccessToken, officerGroupId, officerPushAllowance, pushOfficerDigest } from "./api";
import { deliveryAlert } from "./delivery-alert";
import { inquirySubject } from "../project/inquiry-send";
import { inquiryNoticeKey, OFFICER_NOTICE_USAGE_SQL } from "./inquiry-notice";

export const INQUIRY_NOTICE = inquiryNotice(DEFAULT_DIGEST);

export function nearInquiryDates(projects: Array<{ title: string; deadlines: Partial<Record<"event_day" | "answer_due" | "submit_due", string>> }>, today: string, settings: DigestSettings = DEFAULT_DIGEST): string[] {
  return projects.flatMap((project) => {
    const days = (date: string) => (Date.parse(date) - Date.parse(today)) / 86400_000;
    const event = project.deadlines.event_day;
    const due = project.deadlines.answer_due ?? project.deadlines.submit_due;
    if (event && days(event) >= 0 && days(event) <= settings.eventDays) return [`${project.title}まで、あと${days(event)}日です`];
    if (due && days(due) >= 0 && days(due) <= settings.dueDays) return [`${project.title}の${project.deadlines.answer_due ? "返事" : "提出"}の締切まで、あと${days(due)}日です`];
    return [];
  });
}

/** AIを呼ばず、件数と定まった手がかりだけで知らせを作る。 */
export function officerDigestText(subjects: string[], url: string, includesYesterday = false, receivedDays: string[] = []): string {
  const tomorrowDates = [...new Set(subjects.flatMap((subject, index) => subject.includes("明日") && receivedDays[index] ? [`${receivedDays[index]}に届きました`] : []))];
  const tomorrow = subjects.filter((subject) => subject.includes("明日")).length;
  const counts = new Map<string, number>();
  for (const subject of subjects) {
    const key = inquirySubject(subject);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const repeated = [...counts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
  return [`${includesYesterday ? "届いた" : "今日の"}問い合わせは${subjects.length}件です。`,
    ...(tomorrow ? [`「明日」と書かれたものが${tomorrow}件あります。${tomorrowDates.join("、")}`] : []),
    ...(repeated ? [`同じ内容のものが${repeated}件あります。`] : []),
    "役員の画面の「問い合わせと要望」で見られます。", url].join("\n");
}

/** 五分ごとの処理から、区で決めた送る時刻のあとに呼ぶ。応答が不明でも同じ日に再送しない。 */
export async function sendOfficerDigest(env: Env, wardId: string, slug: string, now = new Date(), request: typeof fetch = fetch): Promise<void> {
  const settings = await getDigestSettings(env.DB, wardId);
  if (!isOfficerDigestTime(now, settings.send)) return;
  const groupId = await officerGroupId(env, wardId);
  if (!groupId) return;
  const day = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  const prior = await env.DB.prepare("SELECT day FROM line_officer_digests WHERE ward_id = ? AND day = ?").bind(wardId, day).first();
  if (prior) return;
  const cutoff = digestCutoff(settings, now);
  const last = await env.DB.prepare("SELECT cutoff_at FROM line_officer_digests WHERE ward_id = ? ORDER BY day DESC LIMIT 1")
    .bind(wardId).first<{ cutoff_at: string | null }>();
  const since = last?.cutoff_at ?? new Date(cutoff.getTime() - 86400_000).toISOString();
  if (Date.parse(since) >= cutoff.getTime()) return;
  const inquiries = await env.DB.prepare(`SELECT q.inquiry_id, q.subject, q.received_at FROM inquiry_records q
    LEFT JOIN ward_settings s ON s.ward_id = q.ward_id AND s.key = 'line.inquiry_notice:' || q.inquiry_id
    WHERE q.ward_id = ? AND q.kind IN ('inquiry', 'request') AND julianday(q.received_at) < julianday(?)
    AND (julianday(q.received_at) >= julianday(?) OR json_extract(s.value, '$.status') = 'fallback')
    AND (s.value IS NULL OR json_extract(s.value, '$.status') = 'fallback')
    ORDER BY q.received_at, q.inquiry_id`).bind(wardId, cutoff.toISOString(), since)
    .all<{ inquiry_id: string; subject: string; received_at: string }>();
  if (!inquiries.results.length) return;
  const token = await lineAccessToken(env, wardId);
  if (!token) return;
  let budget;
  try { budget = await officerPushAllowance(token, groupId, request); }
  catch { await deliveryAlert(env.DB, wardId, "digest", "問い合わせの通知を送れる通数を確かめられませんでした。"); return; }
  if (!budget) { await deliveryAlert(env.DB, wardId, "digest", "問い合わせの通知を送れる通数を確かめられませんでした。"); return; }
  const month = day.slice(0, 7);
  // LINE側の通数の反映が遅れても、自分が送った人数を下回らせない。
  const usage = await env.DB.prepare(OFFICER_NOTICE_USAGE_SQL).bind(budget.used, wardId, month, wardId, month).first<{ used: number }>();
  const used = usage?.used ?? budget.used;
  if (budget.limit !== null && used + budget.recipients > budget.limit) {
    await deliveryAlert(env.DB, wardId, "digest", "自治会のLINEの通数が足りないため、問い合わせの通知を止めました。問い合わせは役員の画面で見られます。"); return;
  }
  const base = new URL(env.PUBLIC_BASE_URL);
  if (base.protocol !== "https:") return;
  const url = new URL(`/${encodeURIComponent(slug)}/admin/inquiries`, base).toString();
  const claim = await env.DB.prepare(`INSERT OR IGNORE INTO line_officer_digests
    (ward_id, day, claimed_at, recipients, usage_before, inquiry_count, cutoff_at)
    SELECT ?, ?, ?, ?, (${OFFICER_NOTICE_USAGE_SQL}), ?, ?
    WHERE (? IS NULL OR (${OFFICER_NOTICE_USAGE_SQL}) + ? <= ?)`)
    .bind(wardId, day, now.toISOString(), budget.recipients, budget.used, wardId, month, wardId, month,
      inquiries.results.length, cutoff.toISOString(), budget.limit, budget.used, wardId, month, wardId, month,
      budget.recipients, budget.limit).run();
  if (!claim.meta.changes) return;
  // 朝の送信中に即時送信が同じ問い合わせを取らないよう、問い合わせごとにも記録する。
  const notices = [];
  for (const row of inquiries.results) {
    const key = inquiryNoticeKey(row.inquiry_id);
    await env.DB.prepare(`INSERT OR IGNORE INTO ward_settings (ward_id, key, value)
      VALUES (?, ?, '{"status":"fallback"}')`).bind(wardId, key).run();
    const taken = await env.DB.prepare(`UPDATE ward_settings SET value = json_set(value, '$.status', 'digest_claimed')
      WHERE ward_id = ? AND key = ? AND json_extract(value, '$.status') = 'fallback'`).bind(wardId, key).run();
    if (taken.meta.changes) notices.push(row);
  }
  if (!notices.length) return;
  const receivedDays = notices.map((row) => new Date(Date.parse(row.received_at) + 9 * 3600_000).toISOString().slice(0, 10));
  try {
    await pushOfficerDigest(token, groupId, `${digestPeriodLabel(settings, cutoff)}の分です。\n` + officerDigestText(notices.map((row) => row.subject), url,
      receivedDays.some((received) => received < day), receivedDays), crypto.randomUUID(), request);
  } catch (error) {
    await env.DB.batch(notices.map((row) => env.DB.prepare(`UPDATE ward_settings SET value = json_set(value, '$.status', 'fallback')
      WHERE ward_id = ? AND key = ?`).bind(wardId, inquiryNoticeKey(row.inquiry_id))));
    await deliveryAlert(env.DB, wardId, "digest", "問い合わせの通知を自治会のLINEに送れませんでした。問い合わせは役員の画面で見られます。");
    throw error;
  }
  await env.DB.batch(notices.map((row) => env.DB.prepare(`UPDATE ward_settings SET value = json_set(value, '$.status', 'digest')
    WHERE ward_id = ? AND key = ?`).bind(wardId, inquiryNoticeKey(row.inquiry_id))));
  await env.DB.prepare("UPDATE line_officer_digests SET sent_at = ? WHERE ward_id = ? AND day = ?")
    .bind(now.toISOString(), wardId, day).run();
  await deliveryAlert(env.DB, wardId, "digest", null);
}
