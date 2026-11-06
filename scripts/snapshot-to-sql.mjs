import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function sqlValue(value, table) {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value !== "string") throw new Error(`表 ${table} に未対応の値があります。`);
  return `'${value.replaceAll("'", "''")}'`;
}

// 同じ表の行を指す項目は、一旦NULLで入れ、全行がそろってから戻す。
// 作成者を後任が外したアカウントでは、参照が相互になるため行順だけでは戻せない。
const SELF_REFERENCES = {
  accounts: { key: "account_id", columns: ["created_by_account_id", "removed_by_account_id"] },
  projects: { key: "project_id", columns: ["seed_project_id"] },
};

// 写しの項目順によらず、外部キーの親を先に戻す。
const TABLE_PARENTS = {
  accounts: ["seats"],
  devices: ["accounts"], sign_in_methods: ["accounts"], sign_in_links: ["accounts"],
  provider_contact_messages: ["provider_contacts"],
  ward_settings: ["accounts"], projects: ["accounts"], jobs: ["accounts"],
  originals: ["jobs"], readings: ["jobs", "projects"], job_runs: ["jobs"], job_tool_calls: ["jobs"],
  paper_reading_slices: ["jobs"], intake_photo_checks: ["originals", "jobs"],
  project_deadlines: ["projects", "accounts"], project_changes: ["projects", "accounts"],
  project_item_values: ["projects", "project_changes", "accounts"],
  project_rows: ["projects", "project_changes", "accounts"],
  documents: ["projects"], document_versions: ["documents", "projects", "accounts"],
  project_questions: ["projects", "project_changes", "accounts"],
  project_map_tasks: ["projects", "project_changes", "seats"],
  publication_records: ["document_versions", "documents", "projects", "accounts"],
  project_activity_pages: ["projects", "accounts"], inquiry_records: ["accounts"],
  city_request_details: ["projects", "accounts"], ward_annual_budgets: ["accounts"],
  project_answers: ["projects", "accounts"], project_help_offers: ["projects"],
  project_answer_submissions: ["projects"],
  project_spaces: ["projects", "accounts"], project_space_invites: ["projects", "accounts"],
  project_space_members: ["projects"], line_photo_items: ["line_photo_batches", "jobs"],
  line_clarifications: ["line_photo_batches", "jobs", "originals", "project_questions"],
  line_clarification_answers: ["line_clarifications", "jobs"], line_photo_sources: ["projects"],
  project_close_map: ["projects", "project_map_tasks", "accounts"],
  project_close_reports: ["projects", "accounts"],
  // 読み取りを入れると索引も自動でできるので、写しの索引はそのあとに置き直す。
  archive_search_entries: ["projects", "readings"],
};

/** CLIとローカルの復元試験で同じ変換を使う。ここではDBやファイルへ書かない。 */
export function snapshotToSql(snapshot) {
  if (snapshot.format !== 1 || typeof snapshot.wardId !== "string" || typeof snapshot.tables !== "object" || snapshot.tables === null) {
    throw new Error("写しの形式が合いません。");
  }
  const statements = [];
  const referenceUpdates = [];
  const tables = new Map();
  function addTable(table) {
    if (tables.has(table) || !Object.hasOwn(snapshot.tables, table)) return;
    if (table !== "wards") addTable("wards");
    for (const parent of Object.hasOwn(TABLE_PARENTS, table) ? TABLE_PARENTS[table] : []) addTable(parent);
    tables.set(table, snapshot.tables[table]);
  }
  for (const table of Object.keys(snapshot.tables)) addTable(table);
  for (const [table, rows] of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error("表の名前が不正です。");
    if (!Array.isArray(rows)) throw new Error(`表 ${table} の内容が配列ではありません。`);
    // アカウントと読み取りのINSERTで自動作成された行を、写しの内容に置き直す。
    if (table === "sign_in_methods" || table === "archive_search_entries") {
      statements.push(`DELETE FROM "${table}" WHERE "ward_id" = ${sqlValue(snapshot.wardId, table)};`);
    }
    for (const row of rows) {
      if (typeof row !== "object" || row === null || row.ward_id !== snapshot.wardId) throw new Error(`表 ${table} に別の区の行があります。`);
      const columns = Object.keys(row);
      if (!columns.every((column) => /^[a-z_][a-z0-9_]*$/.test(column))) throw new Error(`表 ${table} の項目名が不正です。`);
      if (columns.length === 0) continue;
      const selfReference = Object.hasOwn(SELF_REFERENCES, table) ? SELF_REFERENCES[table] : undefined;
      const delayed = columns.filter((column) => selfReference?.columns.includes(column) && row[column] !== null);
      const values = columns.map((column) => {
        const value = sqlValue(row[column], table);
        return delayed.includes(column) ? "NULL" : value;
      });
      statements.push(`INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${values.join(", ")});`);
      if (delayed.length) {
        const assignments = delayed.map((column) => `"${column}" = ${sqlValue(row[column], table)}`);
        referenceUpdates.push(`UPDATE "${table}" SET ${assignments.join(", ")} WHERE "ward_id" = ${sqlValue(snapshot.wardId, table)} AND "${selfReference.key}" = ${sqlValue(row[selfReference.key], table)};`);
      }
      // アカウント追加時に自動で入る時刻より、写しに残る時刻を優先する。
      if (table === "accounts" && Object.hasOwn(row, "sign_in_completed_at")) {
        referenceUpdates.push(`UPDATE "accounts" SET "sign_in_completed_at" = ${sqlValue(row.sign_in_completed_at, table)} WHERE "ward_id" = ${sqlValue(snapshot.wardId, table)} AND "account_id" = ${sqlValue(row.account_id, table)};`);
      }
    }
  }
  return { sql: `${[...statements, ...referenceUpdates].join("\n")}\n`, statements: statements.length, referenceUpdates: referenceUpdates.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    console.error("使い方: node scripts/snapshot-to-sql.mjs <写し.json> <復元.sql>");
    process.exitCode = 2;
  } else {
    const converted = snapshotToSql(JSON.parse(readFileSync(inputPath, "utf8")));
    writeFileSync(outputPath, converted.sql, { encoding: "utf8" });
    console.log(`${converted.statements}件の復元用の文と${converted.referenceUpdates}件の参照などを戻すUPDATE文を出力しました。空のD1にだけ実行してください。`);
  }
}
