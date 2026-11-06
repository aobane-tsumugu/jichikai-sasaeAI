import { readFileSync, writeFileSync } from "node:fs";

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

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error("使い方: node scripts/snapshot-to-sql.mjs <写し.json> <復元.sql>");
  process.exitCode = 2;
} else {
  const snapshot = JSON.parse(readFileSync(inputPath, "utf8"));
  if (snapshot.format !== 1 || typeof snapshot.wardId !== "string" || typeof snapshot.tables !== "object" || snapshot.tables === null) {
    throw new Error("写しの形式が合いません。");
  }
  const statements = [];
  const referenceUpdates = [];
  const tables = new Map();
  for (const [table, rows] of Object.entries(snapshot.tables)) {
    // 日次の写しでは、変更の記録が、それを指す項目と表の行よりあとにある。
    if ((table === "project_item_values" || table === "project_rows") && Object.hasOwn(snapshot.tables, "project_changes")) {
      tables.set("project_changes", snapshot.tables.project_changes);
    }
    tables.set(table, rows);
  }
  for (const [table, rows] of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error("表の名前が不正です。");
    if (!Array.isArray(rows)) throw new Error(`表 ${table} の内容が配列ではありません。`);
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
    }
  }
  writeFileSync(outputPath, `${[...statements, ...referenceUpdates].join("\n")}\n`, { encoding: "utf8" });
  console.log(`${statements.length}件のINSERT文と${referenceUpdates.length}件の参照を戻すUPDATE文を出力しました。空のD1にだけ実行してください。`);
}
