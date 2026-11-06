import { DEFAULT_DIGEST, getDigestSettings, inquiryNotice, type DigestSettings } from "../settings/digest";
import type { Env } from "../env";
import { isOfficerDigestTime } from "../core/cron";
import { lineAccessToken, officerGroupId, officerPushAllowance, pushOfficerDigest } from "./api";

export const INQUIRY_NOTICE = inquiryNotice(DEFAULT_DIGEST);

export function nearInquiryDates(projects: Array<{ title: string; deadlines: Partial<Record<"event_day" | "answer_due" | "submit_due", string>> }>, today: string, settings: DigestSettings = DEFAULT_DIGEST): string[] {
  return projects.flatMap((project) => {
    const days = (date: string) => (Date.parse(date) - Date.parse(today)) / 86400_000;
    const event = project.deadlines.event_day;
    const due = project.deadlines.answer_due ?? project.deadlines.submit_due;
    if (event && days(event) >= 0 && days(event) <= settings.eventDays) return [`${project.title}まで、あと${days(event)}日です`];
    if (due && days(due) >= 0 && days(due) <= settings.dueDays) return [`${project.title}の${project.deadlines.answer_due ? "答え" : "提出"}の締切まで、あと${days(due)}日です`];
    return [];
  });
}

/** AIを呼ばず、件数と定まった手がかりだけで知らせを作る。 */
export function officerDigestText(subjects: string[], url: string, includesYesterday = false, receivedDays: string[] = []): string {
  const tomorrowDates = [...new Set(subjects.flatMap((subject, index) => subject.includes("明日") && receivedDays[index] ? [`${receivedDays[index]}に届きました`] : []))];
  const tomorrow = subjects.filter((subject) => subject.includes("明日")).length;
  const counts = new Map<string, number>();
  for (const subject of subjects) {
    const key = subject.normalize("NFKC").replace(/\s+/g, "").trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const repeated = [...counts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
  return [`${includesYesterday ? "届いた" : "今日の"}問い合わせは${subjects.length}件です。`,
    ...(tomorrow ? [`「明日」と書かれたものが${tomorrow}件あります。${tomorrowDates.join("、")}`] : []),
    ...(repeated ? [`同じ内容のものが${repeated}件あります。`] : []),
    "役員の画面の「届いたもの」で見られます。", url].join("\n");
}

/** 五分ごとの処理から、区で決めた送る時刻のあとに呼ぶ。応答が不明でも同じ日に再送しない。 */
export async function sendOfficerDigest(env: Env, wardId: string, slug: string, now = new Date(), request: typeof fetch = fetch): Promise<void> {
  const settings = await getDigestSettings(env.DB, wardId);
  if (!isOfficerDigestTime(now, settings.send)) return;
  const groupId = officerGroupId(env, wardId);
  if (!groupId) return;
  const day = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  const prior = await env.DB.prepare("SELECT day FROM line_officer_digests WHERE ward_id = ? AND day = ?").bind(wardId, day).first();
  if (prior) return;
  let cutoff = new Date(`${day}T${settings.cutoff}:00+09:00`);
  if (cutoff > new Date(`${day}T${settings.send}:00+09:00`)) cutoff = new Date(cutoff.getTime() - 86400_000);
  const last = await env.DB.prepare("SELECT cutoff_at FROM line_officer_digests WHERE ward_id = ? ORDER BY day DESC LIMIT 1")
    .bind(wardId).first<{ cutoff_at: string | null }>();
  const since = last?.cutoff_at ?? new Date(cutoff.getTime() - 86400_000).toISOString();
  const inquiries = await env.DB.prepare(`SELECT subject, received_at FROM inquiry_records
    WHERE ward_id = ? AND kind IN ('inquiry', 'request') AND julianday(received_at) >= julianday(?) AND julianday(received_at) < julianday(?)
    ORDER BY received_at, inquiry_id`).bind(wardId, since, cutoff.toISOString()).all<{ subject: string; received_at: string }>();
  if (!inquiries.results.length) return;
  const token = await lineAccessToken(env, wardId);
  if (!token) return;
  const budget = await officerPushAllowance(token, groupId, request);
  if (!budget) return;
  const month = day.slice(0, 7);
  // LINE側の通数の反映が遅れても、自分が送った人数を下回らせない。
  const usage = await env.DB.prepare(`SELECT COALESCE(MAX(usage_before + recipients), 0) AS used
    FROM line_officer_digests WHERE ward_id = ? AND substr(day, 1, 7) = ?`).bind(wardId, month).first<{ used: number }>();
  const used = Math.max(budget.used, usage?.used ?? 0);
  if (used + budget.recipients > budget.limit) return;
  const base = new URL(env.PUBLIC_BASE_URL);
  if (base.protocol !== "https:") return;
  const url = new URL(`/${encodeURIComponent(slug)}/admin/inbox`, base).toString();
  const claim = await env.DB.prepare(`INSERT OR IGNORE INTO line_officer_digests
    (ward_id, day, claimed_at, recipients, usage_before, inquiry_count, cutoff_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(wardId, day, now.toISOString(), budget.recipients, used, inquiries.results.length, cutoff.toISOString()).run();
  if (!claim.meta.changes) return;
  const receivedDays = inquiries.results.map((row) => new Date(Date.parse(row.received_at) + 9 * 3600_000).toISOString().slice(0, 10));
  await pushOfficerDigest(token, groupId, officerDigestText(inquiries.results.map((row) => row.subject), url,
    receivedDays.some((received) => received < day), receivedDays), crypto.randomUUID(), request);
  await env.DB.prepare("UPDATE line_officer_digests SET sent_at = ? WHERE ward_id = ? AND day = ?")
    .bind(now.toISOString(), wardId, day).run();
}
