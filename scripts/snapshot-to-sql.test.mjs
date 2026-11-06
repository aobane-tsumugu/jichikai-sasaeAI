import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// 日次の書き手と同じ表・SELECTの順を使い、復元側の並べ方には依存しない。
const writer = readFileSync(join(root, "src/archive/snapshot.ts"), "utf8");
const tables = [...writer.match(/const SNAPSHOT_TABLES = \[([\s\S]*?)\] as const/)[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
const wardId = "fixture-restore-ward";

function database(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(join(root, "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(root, "migrations", name), "utf8"));
  }
  return db;
}

function fixture(t) {
  const db = database(t);
  db.prepare("INSERT INTO wards (ward_id, slug, name) VALUES (?, 'fixture-restore', '架空の復元確認区')").run(wardId);
  db.prepare(`INSERT INTO accounts (account_id, ward_id, name, name_key, login_id, password_salt, password_hash)
    VALUES ('z-creator', ?, '架空 作成役', '架空作成役', 'fixture-creator', 'fictional-salt', 'fictional-hash')`).run(wardId);
  return db;
}

function project(db, id, year, seed = null) {
  db.prepare(`INSERT INTO projects (project_id, ward_id, kind, title, year, seed_project_id, closed_at, created_by_account_id)
    VALUES (?, ?, 'event', ?, ?, ?, ?, 'z-creator')`)
    .run(id, wardId, `架空のO'Brien祭${year}`, year, seed, year < 2026 ? `${year}-11-01T00:00:00Z` : null);
}

function snapshot(db) {
  return { format: 1, wardId, tables: Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} WHERE ward_id = ?`).all(wardId)])) };
}

function convert(t, data) {
  const dir = mkdtempSync(join(tmpdir(), "sasae-restore-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, "snapshot.json");
  const output = join(dir, "restore.sql");
  writeFileSync(input, JSON.stringify(data));
  const result = spawnSync(process.execPath, [join(root, "scripts/snapshot-to-sql.mjs"), input, output], { encoding: "utf8" });
  return { result, output };
}

function roundTrip(t, data) {
  const { result, output } = convert(t, data);
  assert.equal(result.status, 0, result.stderr);
  const restored = database(t);
  restored.exec(readFileSync(output, "utf8"));
  assert.equal(restored.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.deepEqual(restored.prepare("PRAGMA foreign_key_check").all(), []);
  for (const [table, rows] of Object.entries(data.tables)) {
    const canonical = (entries) => entries.map((row) => JSON.stringify(row)).sort();
    assert.deepEqual(canonical(restored.prepare(`SELECT * FROM ${table} WHERE ward_id = ?`).all(wardId)), canonical(rows), table);
  }
}

test("前年の記録をもとに始めた行事を、日次の行順のまま戻せる", (t) => {
  const db = fixture(t);
  project(db, "z-oldest", 2024);
  project(db, "m-previous", 2025, "z-oldest");
  project(db, "a-current", 2026, "m-previous");
  const data = snapshot(db);
  assert.equal(data.tables.projects[0].project_id, "a-current");
  roundTrip(t, data);
});

test("変更記録を持つ項目と当番の行を、値と出どころを保って戻せる", (t) => {
  const db = fixture(t);
  project(db, "fixture-project", 2026);
  db.prepare(`INSERT INTO project_changes (change_id, ward_id, project_id, kind, target, status, dedupe_key, payload_hash, payload, result, pack_version, created_by_account_id)
    VALUES ('fixture-change', ?, 'fixture-project', 'item', 'place', 'applied', 'fixture-change', 'fictional-hash', '{}', '{}', 'fixture@1', 'z-creator')`).run(wardId);
  db.prepare(`INSERT INTO project_item_values (value_id, ward_id, project_id, item_key, scope, content, source_kind, source_ref, confidence, change_id, created_by_account_id)
    VALUES ('fixture-value', ?, 'fixture-project', 'place', 'current', '架空の公民館', 'person', 'z-creator', 'high', 'fixture-change', 'z-creator')`).run(wardId);
  db.prepare(`INSERT INTO project_rows (row_id, ward_id, project_id, table_key, scope, match_key, data, source_kind, source_ref, confidence, change_id, created_by_account_id)
    VALUES ('fixture-duty', ?, 'fixture-project', 'duties', 'current', 'fixture-duty', '{"name":"架空 受付役"}', 'person', 'z-creator', 'high', 'fixture-change', 'z-creator')`).run(wardId);
  const data = snapshot(db);
  assert.ok(tables.indexOf("project_item_values") < tables.indexOf("project_changes"));
  roundTrip(t, data);
});

test("作った役員を後任が外した記録も、相互の参照を保って戻せる", (t) => {
  const db = fixture(t);
  db.prepare(`INSERT INTO accounts (account_id, ward_id, name, name_key, login_id, password_salt, password_hash, created_by_account_id)
    VALUES ('a-successor', ?, '架空 後任役', '架空後任役', 'fixture-successor', 'fictional-salt', 'fictional-hash', 'z-creator')`).run(wardId);
  db.prepare("UPDATE accounts SET removed_at = '2026-11-06T00:00:00Z', removed_by_account_id = 'a-successor' WHERE ward_id = ? AND account_id = 'z-creator'").run(wardId);
  roundTrip(t, snapshot(db));
});

test("別の区の行を含む写しではSQLを出力しない", (t) => {
  const data = snapshot(fixture(t));
  data.tables.accounts[0].ward_id = "fixture-other-ward";
  const { result, output } = convert(t, data);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /別の区の行/);
  assert.throws(() => readFileSync(output), { code: "ENOENT" });
});
