import type { Env } from "../env";
import { lineAccessToken, officerGroupId, officerPushAllowance, pushOfficerDigest } from "./api";
import { lineBundleContents, PHOTO_GROUP_GAP_MS } from "./photo-context";
import { hasSenderName, senderText } from "./sender";

// 表を増やさず、自治会ごとの内部の送信記録を残す。本文、名前、送り先は写さない。
export const INQUIRY_NOTICE_PREFIX = "line.inquiry_notice:";
export const inquiryNoticeKey = (id: string) => INQUIRY_NOTICE_PREFIX + id;

export async function queueInquiryNotice(db: D1Database, wardId: string, inquiryId: string): Promise<void> {
  await db.prepare(`INSERT OR IGNORE INTO ward_settings (ward_id, key, value)
    VALUES (?, ?, '{"status":"waiting"}')`).bind(wardId, inquiryNoticeKey(inquiryId)).run();
}

/** 通数の反映の遅れと同時送信に備え、送信を記録する同じSQLの中で使う。 */
export const OFFICER_NOTICE_USAGE_SQL = `SELECT MAX(?,
  COALESCE((SELECT MAX(usage_before + recipients) FROM line_officer_digests WHERE ward_id = ? AND substr(day, 1, 7) = ?), 0),
  COALESCE((SELECT MAX(json_extract(value, '$.usageBefore') + json_extract(value, '$.recipients')) FROM ward_settings
    WHERE ward_id = ? AND key GLOB 'line.inquiry_notice:*' AND json_extract(value, '$.month') = ?), 0)) AS used`;

export function immediateInquiryText(text: string, name: string | null, photoCount: number, url: string): string {
  const characters = Array.from(text);
  return ["住民から問い合わせが届きました。",
    ...(hasSenderName(name) ? [`送った人: ${senderText(name)}`] : []),
    `「${characters.slice(0, 300).join("")}${characters.length > 300 ? "…" : ""}」`,
    ...(photoCount ? [`写真${photoCount}枚が付いています。`] : []),
    "返事は役員の画面の問い合わせから送れます。", url].join("\n");
}

/** 写真がそろった一対一の問い合わせを一度だけ送る。失敗したものは朝に回す。AIは呼ばない。 */
export async function sendPendingInquiryNotices(env: Env, wardId: string, now = new Date(), request: typeof fetch = fetch): Promise<void> {
  const rows = await env.DB.prepare(`SELECT q.inquiry_id, q.subject, q.line_sender_label, q.line_bundle_id
    FROM inquiry_records q WHERE q.ward_id = ? AND q.line_source_type = 'user'
    AND EXISTS (SELECT 1 FROM ward_settings s WHERE s.ward_id = q.ward_id AND s.key = 'line.inquiry_notice:' || q.inquiry_id
      AND json_extract(s.value, '$.status') = 'waiting')
    AND NOT EXISTS (SELECT 1 FROM line_bundle_decisions d WHERE d.ward_id = q.ward_id AND d.bundle_id = q.line_bundle_id AND d.action <> 'inquiry')
    AND NOT EXISTS (SELECT 1 FROM line_inbox_items i JOIN line_photo_items p ON p.ward_id = i.ward_id AND p.job_id = i.job_id
      JOIN line_photo_batches b ON b.ward_id = p.ward_id AND b.batch_id = p.batch_id
      WHERE i.ward_id = q.ward_id AND i.bundle_id = q.line_bundle_id AND
        ((b.expected_count IS NOT NULL AND (SELECT COUNT(*) FROM line_photo_items x WHERE x.ward_id = b.ward_id AND x.batch_id = b.batch_id) < b.expected_count)
          OR (b.expected_count IS NULL AND b.last_received_at > ?)))
    ORDER BY q.received_at, q.inquiry_id`).bind(wardId, new Date(now.getTime() - PHOTO_GROUP_GAP_MS).toISOString()).all<{
      inquiry_id: string; subject: string; line_sender_label: string | null; line_bundle_id: string | null;
    }>();
  if (!rows.results.length) return;
  const ward = await env.DB.prepare("SELECT slug FROM wards WHERE ward_id = ?").bind(wardId).first<{ slug: string }>();
  for (const row of rows.results) {
    const key = inquiryNoticeKey(row.inquiry_id);
    const claim = await env.DB.prepare(`UPDATE ward_settings SET value = '{"status":"claimed"}', updated_at = ?
      WHERE ward_id = ? AND key = ? AND json_extract(value, '$.status') = 'waiting'`)
      .bind(now.toISOString(), wardId, key).run();
    if (!claim.meta.changes) continue;
    let status = "fallback";
    try {
      const groupId = await officerGroupId(env, wardId);
      const token = groupId ? await lineAccessToken(env, wardId) : null;
      if (!ward || !groupId || !token) continue;
      const base = new URL(env.PUBLIC_BASE_URL);
      if (base.protocol !== "https:") continue;
      const budget = await officerPushAllowance(token, groupId, request);
      if (!budget) continue;
      const month = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 7);
      // 朝の知らせ一回分の通数を残す。同時に別の問い合わせを送る処理ともD1の更新で順番を決める。
      const reserved = await env.DB.prepare(`UPDATE ward_settings SET value = json_object('status', 'claimed', 'month', ?,
        'usageBefore', (${OFFICER_NOTICE_USAGE_SQL}), 'recipients', ?) WHERE ward_id = ? AND key = ?
        AND (? IS NULL OR (${OFFICER_NOTICE_USAGE_SQL}) + ? * 2 <= ?)`)
        .bind(month, budget.used, wardId, month, wardId, month, budget.recipients, wardId, key,
          budget.limit, budget.used, wardId, month, wardId, month, budget.recipients, budget.limit).run();
      if (!reserved.meta.changes) continue;
      const photos = row.line_bundle_id ? (await lineBundleContents(env.DB, wardId, row.line_bundle_id)).photos.length : 0;
      const url = new URL(`/${encodeURIComponent(ward.slug)}/admin/inquiries/${encodeURIComponent(row.inquiry_id)}`, base).toString();
      await pushOfficerDigest(token, groupId, immediateInquiryText(row.subject, row.line_sender_label, photos, url), crypto.randomUUID(), request);
      status = "sent";
    } catch { /* 送信できなくても問い合わせの受付と住民への一言は取り消さない。 */ }
    finally {
      await env.DB.prepare("UPDATE ward_settings SET value = json_set(value, '$.status', ?), updated_at = ? WHERE ward_id = ? AND key = ?")
        .bind(status, now.toISOString(), wardId, key).run();
    }
  }
}
