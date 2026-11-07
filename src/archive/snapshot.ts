import { CRON } from "../core/cron";
import { WardBucket } from "../core/storage";
import type { Env } from "../env";
import { CONTACT_WARD } from "../contact/store";
import { putRecordSnapshot, withRecordLock } from "./backup";

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
  { table: "ops_monthly_ai_usage", snapshot: true, export: true, deletion: { cascade: "wards" } },
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
  { table: "ward_photo_policy", snapshot: "提供側が品質を確かめて有効にする設定。復旧後に勝手に有効にしない。", export: "提供側の設定。", deletion: { cascade: "wards" } },
  { table: "report_photo_drafts", snapshot: "作り直せる写真の下書き。原本から選び直す。", export: "準備中の写真。", deletion: { cascade: "projects" } },
  { table: "publication_photos", snapshot: "隠した写しは作り直せるので日次の写しに入れない。復旧後の自動再公開もしない。", export: true, deletion: { cascade: "projects" } },
  { table: "publication_records", snapshot: true, export: true, deletion: true },
  { table: "project_activity_pages", snapshot: true, export: true, deletion: true },
  { table: "inquiry_records", snapshot: true, export: true, deletion: true },
  { table: "city_request_details", snapshot: true, export: true, deletion: true },
  { table: "ward_annual_budgets", snapshot: true, export: true, deletion: true },
  { table: "ward_roster_entries", snapshot: true, export: true, deletion: true },
  { table: "ward_roster_settings", snapshot: true, export: true, deletion: true },
  // 免除の理由は要配慮の情報。役員の記録として渡し、公開・空間・配布の表には含めない。
  { table: "rota_exemptions", snapshot: true, export: true, deletion: true },
  { table: "rota_preparations", snapshot: true, export: true, deletion: true },
  { table: "rota_seat_changes", snapshot: true, export: true, deletion: true },
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
  { table: "ward_know_items", snapshot: true, export: true, deletion: true },
  { table: "ward_material_links", snapshot: true, export: true, deletion: { cascade: "originals" } },
  { table: "ward_year_items", snapshot: true, export: true, deletion: true },
  { table: "project_close_map", snapshot: true, export: true, deletion: true },
  { table: "project_close_reports", snapshot: true, export: true, deletion: true },
  { table: "archive_search_entries", snapshot: true, export: true, deletion: true },
  { table: "ops_deletion_queue", snapshot: true, export: "提供側で続ける消去の処理待ちなので区へ渡さない。", deletion: true },
  { table: "ops_deletion_marks", snapshot: true, export: true, deletion: "消去の記録なので残す。" },
  { table: "archive_backup_state", snapshot: "復旧後は複写を最初から照合する。", export: "提供側の複写の途中位置。", deletion: true },
];

export const SNAPSHOT_TABLES = WARD_TABLE_POLICY.filter((entry) => entry.snapshot === true).map((entry) => entry.table);

/** 提供側の処理が区を列挙する入口。本文の読み書きは呼び出し側で一つの区に絞る。 */
export async function listRecordWardIds(db: D1Database): Promise<Array<{ ward_id: string }>> {
  return (await db.prepare("SELECT ward_id FROM wards WHERE ward_id IS NOT NULL ORDER BY ward_id").all<{ ward_id: string }>()).results;
}

export async function writeDailyWardSnapshots(env: Env, now = new Date()): Promise<number> {
  const wards = await listRecordWardIds(env.DB);
  const day = now.toISOString().slice(0, 10);
  let saved = 0;
  for (const ward of wards) {
    await withRecordLock(env, ward.ward_id, async () => {
      if (!(await env.DB.prepare("SELECT ward_id FROM wards WHERE ward_id = ? AND is_active = 1").bind(ward.ward_id).first())) return;
      const tables: Record<string, unknown[]> = {};
      for (const table of SNAPSHOT_TABLES) {
        const rows = await env.DB.prepare(`SELECT * FROM ${table} WHERE ward_id = ?`).bind(ward.ward_id).all<Record<string, unknown>>();
        tables[table] = rows.results;
      }
      // 読み取り中に消去が始まっても、古い中身を新しい写しへ戻さない。
      const removals = await env.DB.prepare(`SELECT target_type, target_id FROM ops_deletion_queue WHERE ward_id = ?
        UNION SELECT target_type, target_id FROM ops_deletion_marks WHERE ward_id = ? AND target_type IS NOT NULL`)
        .bind(ward.ward_id, ward.ward_id).all<{ target_type: string; target_id: string | null }>();
      if (removals.results.some((row) => row.target_type === "ward")) return;
      let snapshot = JSON.stringify({ format: 1, wardId: ward.ward_id, capturedAt: now.toISOString(), tables });
      for (const removal of removals.results) {
        if (!removal.target_id) continue;
        // 取消直後に本人が「元に戻す」を押した申し込みは、新しい写しには残せる。
        if (removal.target_type === "help_offer" && await env.DB.prepare("SELECT offer_id FROM project_help_offers WHERE ward_id = ? AND offer_id = ?")
          .bind(ward.ward_id, removal.target_id).first()) continue;
        const rewritten = eraseSnapshotRecord(JSON.parse(snapshot) as unknown, ward.ward_id, removal.target_type, removal.target_id);
        if (rewritten === null) throw new Error("消去を反映した写しを作れませんでした");
        snapshot = rewritten;
      }
      await putRecordSnapshot(env, ward.ward_id, `snapshots/daily/${day}.json`, snapshot);
      saved += 1;
    });
  }
  // 提供側の受付は実在する区に属さないため、区の一覧とは別に写す。
  await withRecordLock(env, CONTACT_WARD, async () => {
    const tables: Record<string, unknown[]> = {};
    for (const table of ["provider_contacts", "provider_contact_messages", "provider_contact_throttle"]) {
      const rows = await env.DB.prepare(`SELECT * FROM ${table} WHERE ward_id = ?`).bind(CONTACT_WARD).all<Record<string, unknown>>();
      tables[table] = rows.results;
    }
    await putRecordSnapshot(env, CONTACT_WARD, `snapshots/daily/${day}.json`,
      JSON.stringify({ format: 1, wardId: CONTACT_WARD, capturedAt: now.toISOString(), tables }));
  });
  saved += 1;
  return saved;
}

export async function runSnapshotCron(event: ScheduledController, env: Env): Promise<void> {
  if (event.cron !== CRON.DAILY) return;
  const result = await writeDailyWardSnapshots(env);
  console.log("日次の写しを保存しました", result);
}

export function eraseSnapshotJob(snapshot: unknown, wardId: string, jobId: string, knownOriginalIds = new Set<string>(), knownReadingBodies = new Set<string>()): string | null {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return null;
  const doc = snapshot as { format?: unknown; wardId?: unknown; tables?: unknown };
  if (doc.format !== 1 || doc.wardId !== wardId || typeof doc.tables !== "object" || doc.tables === null || Array.isArray(doc.tables)) return null;
  const tables = doc.tables as Record<string, unknown>;
  const originalIds = new Set(knownOriginalIds);
  const readingBodies = new Set(knownReadingBodies);
  for (const row of snapshotRows(tables, "originals")) {
    if (row.job_id === jobId && typeof row.original_id === "string") originalIds.add(row.original_id);
  }
  for (const row of snapshotRows(tables, "readings")) {
    if (row.job_id === jobId && typeof row.body === "string") readingBodies.add(row.body);
  }
  eraseCopiedContent(tables, originalIds);
  const remove = (table: string, match: (row: Record<string, unknown>) => boolean) => {
    const rows = tables[table];
    if (Array.isArray(rows)) tables[table] = rows.filter((row) =>
      typeof row !== "object" || row === null || Array.isArray(row) || !match(row as Record<string, unknown>));
  };
  const changeIds = new Set<string>();
  if (Array.isArray(tables.project_changes)) {
    for (const value of tables.project_changes) {
      if (typeof value !== "object" || value === null) continue;
      const row = value as Record<string, unknown>;
      if (typeof row.source_ref === "string" && originalIds.has(row.source_ref) && typeof row.change_id === "string") changeIds.add(row.change_id);
    }
  }
  remove("project_questions", (row) =>
    (typeof row.source_ref === "string" && originalIds.has(row.source_ref)) ||
    (typeof row.change_id === "string" && changeIds.has(row.change_id)));
  if (Array.isArray(tables.project_map_tasks)) {
    for (const value of tables.project_map_tasks) {
      if (typeof value !== "object" || value === null) continue;
      const row = value as Record<string, unknown>;
      if ((typeof row.progress_source_ref === "string" && originalIds.has(row.progress_source_ref)) ||
          (typeof row.progress_change_id === "string" && changeIds.has(row.progress_change_id))) {
        Object.assign(row, { progress: "open", progress_source_kind: null, progress_source_ref: null,
          progress_source_locator: null, progress_confidence: null, progress_change_id: null });
      }
    }
  }
  remove("jobs", (row) => row.job_id === jobId);
  remove("originals", (row) => row.job_id === jobId || (typeof row.original_id === "string" && originalIds.has(row.original_id)));
  remove("ward_material_links", (row) => typeof row.original_id === "string" && originalIds.has(row.original_id));
  for (const table of ["readings", "job_runs", "job_tool_calls", "intake_photo_checks", "line_photo_items", "line_clarifications", "line_clarification_answers"]) remove(table, (row) => row.job_id === jobId);
  remove("paper_reading_slices", (row) => row.job_id === jobId || row.source_job_id === jobId);
  for (const table of ["project_item_values", "project_rows", "project_changes"]) {
    remove(table, (row) => typeof row.source_ref === "string" && originalIds.has(row.source_ref));
  }
  remove("project_answers", (row) => typeof row.original_id === "string" && originalIds.has(row.original_id));
  remove("line_inbox_items", (row) => row.job_id === jobId);
  remove("archive_search_entries", (row) =>
    (typeof row.source_id === "string" && originalIds.has(row.source_id)) ||
    (row.record_type === "reading" && typeof row.content === "string" && readingBodies.has(row.content)));
  return JSON.stringify(doc);
}

type SnapshotRow = Record<string, unknown>;

function snapshotRows(tables: Record<string, unknown>, table: string): SnapshotRow[] {
  const rows = tables[table];
  return Array.isArray(rows) ? rows.filter((row): row is SnapshotRow => typeof row === "object" && row !== null && !Array.isArray(row)) : [];
}

/** 配った本文は保ち、消す資料との対応が分かる表の行と検索記録だけを外す。 */
export function eraseCopiedContent(tables: Record<string, unknown>, originalIds: Set<string>): void {
  const rowSources = new Map<string, Array<string | null>>();
  const rowKey = (project: unknown, kind: unknown, data: unknown) => {
    if (typeof data !== "object" || data === null || Array.isArray(data)) return "";
    return JSON.stringify([project, kind, Object.entries(data).sort(([a], [b]) => a.localeCompare(b))]);
  };
  for (const row of snapshotRows(tables, "project_rows")) {
    if (typeof row.data !== "string" || typeof row.row_id !== "string") continue;
    const key = rowKey(row.project_id, row.table_key, JSON.parse(row.data) as unknown);
    rowSources.set(key, [...(rowSources.get(key) ?? []), typeof row.source_ref === "string" ? row.source_ref : null]);
  }
  // 直したあとの表だけで、過去に配った中身の出どころを決めない。
  for (const row of snapshotRows(tables, "project_changes")) {
    if (row.kind !== "row" || typeof row.payload !== "string" || typeof row.change_id !== "string") continue;
    const change = JSON.parse(row.payload) as { table?: unknown; data?: unknown };
    const key = rowKey(row.project_id, change.table, change.data);
    rowSources.set(key, [...(rowSources.get(key) ?? []), typeof row.source_ref === "string" ? row.source_ref : null]);
  }
  for (const row of snapshotRows(tables, "document_versions")) {
    if (typeof row.tables_snapshot === "string") {
      const entries: unknown = JSON.parse(row.tables_snapshot);
      if (!Array.isArray(entries)) throw new Error("配った表を読み取れませんでした");
      row.tables_snapshot = JSON.stringify(entries.flatMap((entry: unknown) => {
        if (typeof entry !== "object" || entry === null) return [entry];
        const tableRow = entry as SnapshotRow;
        if (typeof tableRow.sourceRef === "string" && originalIds.has(tableRow.sourceRef)) return [];
        if (tableRow.sourceRef === undefined) {
          const sources = rowSources.get(rowKey(row.project_id, tableRow.kind, tableRow.data));
          // 古い行は、同じ行事・種類・中身から出どころを確かめられたときだけ外す。
          if (sources?.length && sources.every((source) => source !== null && originalIds.has(source))) return [];
        }
        return [tableRow];
      }));
    }
  }
  const search = tables.archive_search_entries;
  if (Array.isArray(search)) tables.archive_search_entries = search.filter((value: unknown) => {
    if (typeof value !== "object" || value === null) return true;
    const row = value as SnapshotRow;
    return !(typeof row.source_id === "string" && originalIds.has(row.source_id));
  });
}

export function eraseSnapshotRecord(snapshot: unknown, wardId: string, type: string, id: string): string | null {
  if (type === "job") return eraseSnapshotJob(snapshot, wardId, id);
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return null;
  const doc = snapshot as { wardId?: unknown; tables?: Record<string, unknown> };
  if (doc.wardId !== wardId || typeof doc.tables !== "object" || doc.tables === null || Array.isArray(doc.tables)) return null;
  if (type === "project") {
    for (const job of snapshotRows(doc.tables, "jobs")) {
      if (job.project_id === id && typeof job.job_id === "string") {
        const rewritten = eraseSnapshotJob(doc, wardId, job.job_id);
        if (rewritten === null) return null;
        doc.tables = (JSON.parse(rewritten) as { tables: Record<string, unknown> }).tables;
      }
    }
    for (const [table, rows] of Object.entries(doc.tables)) {
      if (!Array.isArray(rows)) continue;
      doc.tables[table] = snapshotRows(doc.tables, table).filter((row) => row.project_id !== id).map((row) =>
        table === "projects" && row.seed_project_id === id ? { ...row, seed_project_id: null } : row);
    }
  } else {
    if (type === "provider_contact") {
      for (const table of ["provider_contacts", "provider_contact_messages"]) {
        if (doc.tables[table]) doc.tables[table] = snapshotRows(doc.tables, table).filter((row) => row.contact_id !== id);
      }
      return JSON.stringify(doc);
    }
    const target = type === "answer" ? ["project_answers", "answer_id"] : type === "inquiry" ? ["inquiry_records", "inquiry_id"] : type === "help_offer" ? ["project_help_offers", "offer_id"] : null;
    if (!target) return null;
    const [table, column] = target as [string, string];
    if (doc.tables[table]) doc.tables[table] = snapshotRows(doc.tables, table).filter((row) => row[column] !== id);
  }
  return JSON.stringify(doc);
}

