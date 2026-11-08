import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { providerSnapshotRecords, snapshotRecords } from "../test/fixtures/snapshot-records.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
// 日次の書き手と同じ表・SELECTの順を使い、復元側の並べ方には依存しない。
const writer = readFileSync(join(root, "src/archive/snapshot.ts"), "utf8");
const tables = [...writer.matchAll(/\{ table: "([a-z_]+)", snapshot: true,/g)].map((match) => match[1]);
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
  db.prepare("INSERT INTO wards (ward_id, slug, name) VALUES (?, 'fixture-restore', '試しの復元確認区')").run(wardId);
  db.prepare(`INSERT INTO accounts (account_id, ward_id, name, name_key, login_id, password_salt, password_hash)
    VALUES ('z-creator', ?, '作成役', '作成役', 'fixture-creator', 'fictional-salt', 'fictional-hash')`).run(wardId);
  return db;
}

function project(db, id, year, seed = null) {
  db.prepare(`INSERT INTO projects (project_id, ward_id, kind, title, year, seed_project_id, closed_at, created_by_account_id)
    VALUES (?, ?, 'event', ?, ?, ?, ?, 'z-creator')`)
    .run(id, wardId, `試しのO'Brien祭${year}`, year, seed, year < 2026 ? `${year}-11-01T00:00:00Z` : null);
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
    assert.deepEqual(canonical(restored.prepare(`SELECT * FROM ${table} WHERE ward_id = ?`).all(data.wardId)), canonical(rows), table);
  }
}

test("前年の記録をもとに始めた行事を、新しい行事が先にあっても戻せる", (t) => {
  const db = fixture(t);
  project(db, "z-oldest", 2024);
  project(db, "m-previous", 2025, "z-oldest");
  project(db, "a-current", 2026, "m-previous");
  const data = snapshot(db);
  data.tables.projects.sort((a, b) => a.project_id.localeCompare(b.project_id));
  assert.equal(data.tables.projects[0].project_id, "a-current");
  roundTrip(t, data);
});

test("変更記録と写真の質問と認証の記録を、写しの表が逆順でも戻せる", (t) => {
  const db = fixture(t);
  project(db, "fixture-project", 2026);
  db.prepare(`INSERT INTO project_changes (change_id, ward_id, project_id, kind, target, status, dedupe_key, payload_hash, payload, result, pack_version, created_by_account_id)
    VALUES ('fixture-change', ?, 'fixture-project', 'item', 'place', 'applied', 'fixture-change', 'fictional-hash', '{}', '{}', 'fixture@1', 'z-creator')`).run(wardId);
  db.prepare(`INSERT INTO project_item_values (value_id, ward_id, project_id, item_key, scope, content, source_kind, source_ref, confidence, change_id, created_by_account_id)
    VALUES ('fixture-value', ?, 'fixture-project', 'place', 'current', '試しの公民館', 'person', 'z-creator', 'high', 'fixture-change', 'z-creator')`).run(wardId);
  db.prepare(`INSERT INTO project_rows (row_id, ward_id, project_id, table_key, scope, match_key, data, source_kind, source_ref, confidence, change_id, created_by_account_id)
    VALUES ('fixture-duty', ?, 'fixture-project', 'duties', 'current', 'fixture-duty', '{"name":"受付役"}', 'person', 'z-creator', 'high', 'fixture-change', 'z-creator')`).run(wardId);
  db.prepare(`INSERT INTO jobs (job_id, ward_id, project_id, via, task, status, created_at, updated_at)
    VALUES ('fixture-job', ?, 'fixture-project', 'line_direct', 'connect', 'done', '2026-11-06', '2026-11-06')`).run(wardId);
  db.prepare(`INSERT INTO originals (original_id, ward_id, job_id, position, kind, content_hash, media_type, byte_size, received_at)
    VALUES ('fixture-original', ?, 'fixture-job', 1, 'photo', 'fictional-hash', 'image/jpeg', 100, '2026-11-06')`).run(wardId);
  db.prepare(`INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, body, created_at)
    VALUES ('fixture-reading', ?, 'fixture-job', 'direct', 'fixture@1', '{"text_blocks":[]}', '2026-11-06')`).run(wardId);
  db.prepare(`INSERT INTO line_photo_batches (ward_id, batch_id, destination, source_type, source_id, sender_id, created_at, last_received_at, reply_token)
    VALUES (?, 'fixture-batch', 'fixture-destination', 'user', 'fixture-user', 'fixture-user', '2026-11-06', '2026-11-06', 'fictional-reply')`).run(wardId);
  db.prepare(`INSERT INTO line_photo_items (ward_id, batch_id, job_id, message_id, quote_token)
    VALUES (?, 'fixture-batch', 'fixture-job', 'fixture-message', 'fictional-quote')`).run(wardId);
  db.prepare(`INSERT INTO line_clarifications (ward_id, clarification_id, batch_id, job_id, original_id, topic, text)
    VALUES (?, 'fixture-clarification', 'fixture-batch', 'fixture-job', 'fixture-original', 'year', '試しの年の質問')`).run(wardId);
  db.prepare(`INSERT INTO line_clarification_answers (ward_id, event_id, clarification_id, job_id, answer_text, sender_label)
    VALUES (?, 'fixture-event', 'fixture-clarification', 'fixture-job', '試しの返事', '試しの役員')`).run(wardId);
  db.prepare(`INSERT INTO sign_in_links (link_id, ward_id, account_id, purpose, token_hash, expires_at, created_at, created_by_account_id)
    VALUES ('fixture-link', ?, 'z-creator', 'invite', 'fictional-token-hash', '2026-11-07', '2026-11-06', 'z-creator')`).run(wardId);
  db.prepare("UPDATE accounts SET sign_in_completed_at = NULL WHERE ward_id = ? AND account_id = 'z-creator'").run(wardId);
  const data = snapshot(db);
  data.tables = Object.fromEntries(Object.entries(data.tables).reverse());
  roundTrip(t, data);
});

test("返事で聞く欄が準備より先にある写しも、欄と入力済みの返事を保って戻せる", (t) => {
  const db = fixture(t);
  project(db, "fixture-project", 2026);
  db.prepare(`INSERT INTO project_answer_fields
    (ward_id, project_id, field_id, kind, label, created_at, created_by_account_id)
    VALUES (?, 'fixture-project', 'reply-note', 'text', '連絡事項', '2026-11-08T00:00:00Z', 'z-creator')`).run(wardId);
  db.prepare(`INSERT INTO project_answers
    (ward_id, project_id, answer_id, household, district, people_count, source, field_values)
    VALUES (?, 'fixture-project', 'reply', '田中', '1班', 2, 'web', ?)`)
    .run(wardId, JSON.stringify({ "reply-note": "受付の机を運びます。" }));
  const data = snapshot(db);
  data.tables = { project_answer_fields: data.tables.project_answer_fields, ...data.tables };
  roundTrip(t, data);
});

test("作った役員を後任が外した記録も、相互の参照を保って戻せる", (t) => {
  const db = fixture(t);
  db.prepare(`INSERT INTO accounts (account_id, ward_id, name, name_key, login_id, password_salt, password_hash, created_by_account_id)
    VALUES ('a-successor', ?, '後任役', '後任役', 'fixture-successor', 'fictional-salt', 'fictional-hash', 'z-creator')`).run(wardId);
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

function insertRecords(db, records) {
  for (const { table, data } of records) {
    const columns = Object.keys(data);
    db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(data));
  }
}

test("全ての保存対象に記録を持つ区を、紙番号・実行委員名簿・総会の委任を保って戻す", (t) => {
  const db = fixture(t);
  project(db, "fixture-project", 2026);
  insertRecords(db, snapshotRecords(wardId, "fixture-project", "z-creator"));
  const data = snapshot(db);
  const providerTables = new Set(providerSnapshotRecords().map((record) => record.table));
  for (const [table, rows] of Object.entries(data.tables)) {
    if (!providerTables.has(table)) assert.ok(rows.length > 0, `${table}の記録が試験にありません`);
  }
  // 比較記録を先頭に置いても、二つの元の資料と準備を先に戻せることを確かめる。
  data.tables = { original_comparisons: data.tables.original_comparisons, ...Object.fromEntries(Object.entries(data.tables).reverse()) };
  roundTrip(t, data);
});

test("提供側の受付の写しを、実在する区が無くても本文と一緒に戻す", (t) => {
  const db = database(t);
  insertRecords(db, providerSnapshotRecords());
  const data = { format: 1, wardId: "provider-contacts", tables: Object.fromEntries(
    [...providerSnapshotRecords()].reverse().map(({ table }) => [table, db.prepare(`SELECT * FROM ${table}`).all()])) };
  roundTrip(t, data);
});
