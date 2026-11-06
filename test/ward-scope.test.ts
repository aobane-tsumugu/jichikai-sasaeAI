/// <reference types="vite/client" />
import { expect, it } from "vitest";
import { checkWardScope, inspectSql } from "../scripts/check-ward-scope.ts";

const sources = Object.fromEntries(Object.entries(import.meta.glob<string>("../src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,sql}", { eager: true, query: "?raw", import: "default" }))
  .map(([file, text]) => [file.slice(3), text]));
const migrations = import.meta.glob<string>("../migrations/**/*.sql", { eager: true, query: "?raw", import: "default" });

it("全SQLとR2を検査し、架空の絞り漏れを足すと失敗する", () => {
  const result = checkWardScope(sources, migrations);
  expect(result.prepared).toBeGreaterThan(0);
  expect(result.queries.length).toBeGreaterThanOrEqual(result.prepared);
  expect(result.r2References).toBeGreaterThan(0);
  expect(result.issues).toEqual([]);

  // 架空のSQL。実在のデータは読み書きしない。同じ表名で入れ子になった場合も確認する。
  const scoped = "SELECT p.title FROM projects p JOIN jobs j ON j.ward_id = p.ward_id AND j.project_id = p.project_id WHERE p.ward_id = ? AND p.project_id = ?";
  const tables = new Set(["projects", "jobs"]);
  expect(inspectSql(scoped, tables)).toEqual([]);
  for (const broken of [
    scoped.replace("p.ward_id = ? AND ", ""),
    scoped.replace("j.ward_id = p.ward_id AND ", ""),
    `${scoped} OR 1 = 1`,
    "SELECT ward_id FROM projects WHERE project_id = ? /* ward_id = ? */",
    "SELECT * FROM projects p WHERE p.ward_id = ? AND EXISTS (SELECT 1 FROM jobs j WHERE j.project_id = p.project_id)",
    "SELECT * FROM projects WHERE ward_id = ? AND EXISTS (SELECT 1 FROM projects WHERE project_id = ?)",
    "UPDATE projects SET title = ? WHERE project_id = ?",
    "DELETE FROM projects WHERE project_id = ?",
    "INSERT INTO projects (project_id, title) VALUES (?, ?)",
    "INSERT INTO projects (project_id, ward_id) VALUES (?, NULL)",
    "SELECT title FROM projects WHERE ward_id = ? UNION SELECT title FROM projects",
  ]) expect(inspectSql(broken, tables), broken).not.toEqual([]);

  const changed = checkWardScope({ ...sources, "src/ward-scope-fictional.ts": `
    // 架空の検査用。実行はしない。
    const sql = ${JSON.stringify(scoped.replace("p.ward_id = ? AND ", ""))};
    db.prepare(sql);
    env.ORIGINALS.get("fictional-ward/original");
    const bucket = env["ORIGINALS"];
    bucket.delete("fictional-ward/original");
  ` }, migrations);
  const found = changed.issues.filter((issue) => issue.file === "src/ward-scope-fictional.ts");
  expect(found.some((issue) => issue.sql?.startsWith("SELECT") && issue.message.includes("ward_id"))).toBe(true);
  expect(found.filter((issue) => issue.message.includes("WardBucket"))).toHaveLength(2);
});
