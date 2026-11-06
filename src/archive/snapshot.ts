import { CRON } from "../core/cron";
import { WardBucket } from "../core/storage";
import type { Env } from "../env";

/** 区の記録の扱い。文字列は一覧から外す理由。並びは外部キーの親から子。 */
export interface WardTablePolicy {
  table: string;
  snapshot: true | string;
  export: true | string;
  // 認証に使う値を区への書き出しから除く。復旧用の写しには保つ。
  omitExportColumns?: readonly string[];
  deletion: true | string | { cascade: string };
}

export const WARD_TABLE_POLICY: readonly WardTablePolicy[] = [
  { table: "wards", snapshot: true, export: true, deletion: true },
  { table: "seats", snapshot: true, export: true, deletion: true },
  { table: "accounts", snapshot: true, export: true, deletion: true, omitExportColumns: ["password_salt", "password_hash"] },
  { table: "devices", snapshot: true, export: "端末の認証情報なので区へ渡さない。", deletion: true },
  { table: "sign_in_methods", snapshot: true, export: true, deletion: { cascade: "accounts" }, omitExportColumns: ["subject", "email"] },
  { table: "sign_in_links", snapshot: true, export: "一度だけ使える入口の認証情報なので区へ渡さない。", deletion: true },
  { table: "login_attempts", snapshot: true, export: "認証の試行記録なので区へ渡さない。", deletion: true },
  { table: "provider_contacts", snapshot: true, export: "提供側の受付で、区へ渡す記録ではない。", deletion: "提供側の受付は区の消去と別に、閉じて30日で写真を消す。" },
  { table: "provider_contact_messages", snapshot: true, export: "提供側の受付で、区へ渡す記録ではない。", deletion: { cascade: "provider_contacts" } },
  { table: "provider_contact_throttle", snapshot: true, export: "連続送信を抑える一時の記録。", deletion: "一時の記録で、区の記録ではない。" },
  { table: "provider_ward_contacts", snapshot: true, export: "提供側が本人を確かめる手がかりで、区へ渡さない。", deletion: true },
  { table: "ward_settings", snapshot: true, export: true, deletion: true },
  { table: "ops_ward_limits", snapshot: true, export: true, deletion: true },
  { table: "ward_ai", snapshot: true, export: "提供側のAI接続と認証の設定なので区へ渡さない。", deletion: true },
  { table: "ward_ai_route_flags", snapshot: true, export: true, deletion: true },
  { table: "projects", snapshot: true, export: true, deletion: true },
  { table: "jobs", snapshot: true, export: true, deletion: true, omitExportColumns: ["ticket_hash"] },
  { table: "originals", snapshot: true, export: true, deletion: true },
  { table: "readings", snapshot: true, export: true, deletion: true },
  { table: "job_runs", snapshot: true, export: true, deletion: true },
  { table: "job_tool_calls", snapshot: true, export: true, deletion: true },
  { table: "paper_reading_slices", snapshot: true, export: true, deletion: true },
  { table: "intake_photo_checks", snapshot: true, export: true, deletion: { cascade: "originals" } },
  { table: "project_deadlines", snapshot: true, export: true, deletion: true },
  { table: "project_changes", snapshot: true, export: true, deletion: true },
  { table: "project_item_values", snapshot: true, export: true, deletion: true },
  { table: "project_rows", snapshot: true, export: true, deletion: true },
  { table: "documents", snapshot: true, export: true, deletion: true },
  { table: "document_versions", snapshot: true, export: true, deletion: true },
  { table: "project_questions", snapshot: true, export: true, deletion: true },
  { table: "project_map_tasks", snapshot: true, export: true, deletion: true },
  { table: "publication_records", snapshot: true, export: true, deletion: true },
  { table: "project_activity_pages", snapshot: true, export: true, deletion: true },
  { table: "inquiry_records", snapshot: true, export: true, deletion: true },
  { table: "city_request_details", snapshot: true, export: true, deletion: true },
  { table: "ward_annual_budgets", snapshot: true, export: true, deletion: true },
  { table: "ward_roster_entries", snapshot: true, export: true, deletion: true },
  { table: "ward_roster_settings", snapshot: true, export: true, deletion: true },
  { table: "project_answers", snapshot: true, export: true, deletion: true },
  { table: "project_answer_submissions", snapshot: true, export: "同じ送信の再処理を見分ける内部の番号で、区へ渡す記録ではない。", deletion: true },
  { table: "project_help_offers", snapshot: true, export: true, deletion: { cascade: "projects" } },
  { table: "project_spaces", snapshot: true, export: true, deletion: true, omitExportColumns: ["passphrase_salt", "passphrase_hash"] },
  { table: "project_space_invites", snapshot: true, export: true, deletion: true, omitExportColumns: ["token_hash"] },
  { table: "project_space_members", snapshot: true, export: true, deletion: true, omitExportColumns: ["token_hash"] },
  { table: "line_channels", snapshot: true, export: true, deletion: true },
  { table: "line_webhook_receipts", snapshot: true, export: true, deletion: true },
  { table: "line_inbox_items", snapshot: true, export: true, deletion: true },
  { table: "line_unrelated_daily_counts", snapshot: true, export: true, deletion: true },
  { table: "line_group_notices", snapshot: true, export: true, deletion: true },
  { table: "line_officer_digests", snapshot: true, export: true, deletion: { cascade: "wards" } },
  { table: "line_photo_batches", snapshot: true, export: "reply_tokenとanswer_reply_tokenを持つ一時の表なので区へ渡さない。", deletion: true },
  { table: "line_photo_items", snapshot: true, export: "quote_tokenとreceipt_reply_tokenを持つ一時の表なので区へ渡さない。", deletion: { cascade: "line_photo_batches" } },
  { table: "line_clarifications", snapshot: true, export: true, deletion: { cascade: "originals" } },
  { table: "line_clarification_answers", snapshot: true, export: true, deletion: { cascade: "line_clarifications" } },
  { table: "line_photo_sources", snapshot: true, export: true, deletion: { cascade: "projects" } },
  { table: "line_photo_context_texts", snapshot: "写真を当てる間だけ使い、長くても1日で消す文。記録に戻さない。", export: "写真の判断のための一時的な文で、区の記録ではない。", deletion: true },
  { table: "project_close_map", snapshot: true, export: true, deletion: true },
  { table: "project_close_reports", snapshot: true, export: true, deletion: true },
  { table: "archive_search_entries", snapshot: true, export: true, deletion: true },
  { table: "ops_deletion_queue", snapshot: true, export: "提供側で続ける消去の処理待ちなので区へ渡さない。", deletion: true },
  { table: "ops_deletion_marks", snapshot: true, export: true, deletion: "消去の記録なので残す。" },
];

export const SNAPSHOT_TABLES = WARD_TABLE_POLICY.filter((entry) => entry.snapshot === true).map((entry) => entry.table);

export async function writeDailyWardSnapshots(env: Env, now = new Date()): Promise<number> {
  const wards = await env.DB.prepare("SELECT ward_id FROM wards WHERE ward_id IS NOT NULL ORDER BY ward_id").all<{ ward_id: string }>();
  const day = now.toISOString().slice(0, 10);
  let saved = 0;
  for (const ward of wards.results) {
    const tables: Record<string, unknown[]> = {};
    for (const table of SNAPSHOT_TABLES) {
      const rows = await env.DB.prepare(`SELECT * FROM ${table} WHERE ward_id = ?`).bind(ward.ward_id).all<Record<string, unknown>>();
      tables[table] = rows.results;
    }
    const snapshot = JSON.stringify({ format: 1, wardId: ward.ward_id, capturedAt: now.toISOString(), tables });
    await new WardBucket(env.ORIGINALS, ward.ward_id).put(`snapshots/daily/${day}.json`, snapshot, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    saved += 1;
  }
  return saved;
}

export async function runSnapshotCron(event: ScheduledController, env: Env): Promise<void> {
  if (event.cron !== CRON.DAILY) return;
  const result = await writeDailyWardSnapshots(env);
  console.log("日次の写しを保存しました", result);
}
