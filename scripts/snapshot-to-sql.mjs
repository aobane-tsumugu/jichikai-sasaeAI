import { readFileSync, writeFileSync } from "node:fs";

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
  for (const [table, rows] of Object.entries(snapshot.tables)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error("表の名前が不正です。");
    if (!Array.isArray(rows)) throw new Error(`表 ${table} の内容が配列ではありません。`);
    for (const row of rows) {
      if (typeof row !== "object" || row === null || row.ward_id !== snapshot.wardId) throw new Error(`表 ${table} に別の区の行があります。`);
      const columns = Object.keys(row);
      if (!columns.every((column) => /^[a-z_][a-z0-9_]*$/.test(column))) throw new Error(`表 ${table} の項目名が不正です。`);
      if (columns.length === 0) continue;
      const values = columns.map((column) => {
        const value = row[column];
        if (value === null) return "NULL";
        if (typeof value === "number") return String(value);
        if (typeof value === "boolean") return value ? "1" : "0";
        if (typeof value !== "string") throw new Error(`表 ${table} に未対応の値があります。`);
        return `'${value.replaceAll("'", "''")}'`;
      });
      statements.push(`INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${values.join(", ")});`);
    }
  }
  writeFileSync(outputPath, `${statements.join("\n")}\n`, { encoding: "utf8" });
  console.log(`${statements.length} 件の INSERT 文を出力しました。空の D1 にだけ実行してください。`);
}
