import { CRON } from "../core/cron";
import { WardBucket } from "../core/storage";
import type { Env } from "../env";

// 正本と運営上必要な記録だけを写す。AI の読み、実行計測、検索用索引、照合用の一時表は再作成できるため含めない。
const SNAPSHOT_TABLES = [
  "wards", "seats", "accounts", "devices", "ward_settings", "ward_ai",
  "jobs", "originals", "projects", "project_deadlines", "project_item_values", "project_rows",
  "documents", "document_versions", "project_questions", "project_map_tasks", "publication_records",
  "ward_roster_entries", "ward_roster_settings", "project_answers", "project_spaces", "project_space_invites", "project_space_members",
  "line_channels", "line_inbox_items", "line_unrelated_daily_counts", "project_close_map", "project_close_reports",
] as const;

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
