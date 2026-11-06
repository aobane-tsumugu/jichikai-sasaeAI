import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { WARD_TABLE_POLICY, writeDailyWardSnapshots } from "../src/archive/snapshot";
import { CRON } from "../src/core/cron";
import { WardBucket } from "../src/core/storage";
import { seedAdmin, seedSeat } from "../src/core/testing";
import { exportWard, requestWardDeletion, runDeletionCron } from "../src/ops/lifecycle";
import { createProject } from "../src/project/api";
import { CONTACT_WARD, contactByToken, messages, receiveContact } from "../src/contact/store";
import { PROVIDER_CONTACT_FIXTURE } from "../fixtures/provider-contact";
import { saveWardPhotoPolicy, activePhotoPolicy, PHOTO_MODEL_SHA256, PHOTO_PROFILE } from "../src/photos/policy";
import { photoHash, photoPublicationStatements, type PreparedPhoto } from "../src/photos/server";
import { saveDocument } from "../src/project/actions";
import { SOURCE_PNG, MASKED_PNG } from "./fixtures/report-photo";

it("区の全表を控えと写しの方針に含め、秘密を渡さず、他の区を残して消去できる", async () => {
  // 表の追加時に方針への記入を忘れたら、この一本で分かる。
  // D1の保護された内部表と、試験用の移行履歴には問い合わせない。
  const schema = await env.DB.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'",
  ).all<{ name: string; sql: string }>();
  const virtual = schema.results.filter((table) => /^CREATE VIRTUAL TABLE/i.test(table.sql)).map((table) => table.name);
  const wardTables: string[] = [];
  for (const { name } of schema.results) {
    // 全文索引とその内部表は元の記録から作る。元の記録の表はこのあと確かめる。
    if (virtual.some((table) => name === table || name.startsWith(`${table}_`))) continue;
    // D1では表名をバインドしたPRAGMA関数が拒否されるため、引用した表名で直接調べる。
    const columns = await env.DB.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all<{ name: string }>();
    if (columns.results.some((column) => column.name === "ward_id")) wardTables.push(name);
  }
  expect(wardTables.sort()).toEqual(WARD_TABLE_POLICY.map((entry) => entry.table).sort());
  for (const entry of WARD_TABLE_POLICY) {
    for (const choice of [entry.export, entry.snapshot, entry.deletion]) {
      if (typeof choice === "string") expect(choice.trim().length).toBeGreaterThan(0);
    }
    if (typeof entry.deletion === "object") {
      const keys = await env.DB.prepare(`PRAGMA foreign_key_list("${entry.table.replaceAll('"', '""')}")`)
        .all<{ table: string; on_delete: string }>();
      expect(keys.results).toContainEqual(expect.objectContaining({ table: entry.deletion.cascade, on_delete: "CASCADE" }));
    }
  }

  async function records() {
    const { ward, account } = await seedAdmin(env.DB);
    const w = ward.wardId;
    const seat = await seedSeat(env.DB, w, "架空の書記");
    await env.DB.prepare("UPDATE accounts SET seat_id = ? WHERE ward_id = ? AND account_id = ?").bind(seat, w, account.accountId).run();
    const project = await createProject(env.DB, w, { kind: "event", title: "架空の控え確認会", year: 2026, accountId: account.accountId });
    const p = project.projectId;
    const sourceBytes = Uint8Array.from(atob(SOURCE_PNG), (character) => character.charCodeAt(0));
    const sourceHash = await photoHash(sourceBytes);
    // ここで使うIDと本文と認証の値は全て試験用の架空のもの。
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO jobs (ward_id, job_id, project_id, via, task, status, created_at, updated_at)
        VALUES (?, ?, ?, 'line_direct', 'connect', 'done', '2026-11-06', '2026-11-06')`).bind(w, w, p),
      env.DB.prepare(`INSERT INTO originals (ward_id, original_id, job_id, position, kind, content_hash, media_type, byte_size, r2_path, received_at)
        VALUES (?, ?, ?, 1, 'photo', ?, 'image/png', ?, 'originals/fictional.jpg', '2026-11-06')`).bind(w, w, w, sourceHash, sourceBytes.length),
      env.DB.prepare(`INSERT INTO readings (ward_id, reading_id, job_id, source, pack_version, body, created_at)
        VALUES (?, ?, ?, 'direct', 'fixture@1', '{"text_blocks":[]}', '2026-11-06')`).bind(w, w, w),
      env.DB.prepare(`INSERT INTO paper_reading_slices (ward_id, job_id, source_job_id, body, created_at)
        VALUES (?, ?, ?, '{}', '2026-11-06')`).bind(w, w, w),
      env.DB.prepare(`INSERT INTO intake_photo_checks (ward_id, original_id, job_id, readability, paper_kind, reason)
        VALUES (?, ?, ?, 'readable', 'unknown', '架空の確認')`).bind(w, w, w),
      env.DB.prepare(`INSERT INTO line_photo_batches (ward_id, batch_id, destination, source_type, source_id, sender_id, created_at, last_received_at, reply_token)
        VALUES (?, ?, 'fictional-destination', 'user', 'fictional-user', 'fictional-user', '2026-11-06', '2026-11-06', 'fictional-reply-token')`).bind(w, w),
      env.DB.prepare(`INSERT INTO line_photo_items (ward_id, batch_id, job_id, message_id, quote_token, receipt_reply_token)
        VALUES (?, ?, ?, 'fictional-message', 'fictional-quote-token', 'fictional-receipt-token')`).bind(w, w, w),
      env.DB.prepare(`INSERT INTO line_clarifications (ward_id, clarification_id, batch_id, job_id, original_id, topic, text)
        VALUES (?, ?, ?, ?, ?, 'year', '架空の年の質問')`).bind(w, w, w, w, w),
      env.DB.prepare(`INSERT INTO line_clarification_answers (ward_id, event_id, clarification_id, job_id, answer_text, sender_label)
        VALUES (?, 'fictional-event', ?, ?, '架空の返事', '架空の役員')`).bind(w, w, w),
      env.DB.prepare(`INSERT INTO line_officer_digests (ward_id, day, claimed_at, recipients, usage_before, inquiry_count)
        VALUES (?, '2026-11-06', '2026-11-06', 1, 0, 1)`).bind(w),
      env.DB.prepare(`INSERT INTO line_photo_sources (ward_id, destination, source_type, source_id, project_id)
        VALUES (?, 'fictional-destination', 'group', 'fictional-group', ?)`).bind(w, p),
      env.DB.prepare(`INSERT INTO line_photo_context_texts (ward_id, destination, source_type, source_id, event_id, received_at, text, expires_at)
        VALUES (?, 'fictional-destination', 'user', 'fictional-user', 'fictional-context-event', '2026-11-06T00:00:00Z', '架空の写真の前後の文', '2026-11-07T00:00:00Z')`).bind(w),
      env.DB.prepare(`INSERT INTO project_help_offers (ward_id, offer_id, project_id, name, times, created_at)
        VALUES (?, ?, ?, '架空の手伝い', '架空の午後', '2026-11-06')`).bind(w, w, p),
      env.DB.prepare(`INSERT INTO sign_in_links (ward_id, link_id, account_id, purpose, token_hash, expires_at, created_at, created_by_account_id)
        VALUES (?, ?, ?, 'invite', 'fictional-link-hash', '2026-11-07', '2026-11-06', ?)`).bind(w, w, account.accountId, account.accountId),
      env.DB.prepare(`INSERT INTO login_attempts (ward_id, attempt_key, attempt_id, attempted_at)
        VALUES (?, 'fictional-attempt', 'fictional-attempt', '2026-11-06')`).bind(w),
      env.DB.prepare("INSERT INTO ward_ai_route_flags (ward_id, updated_at) VALUES (?, '2026-11-06')").bind(w),
      env.DB.prepare("INSERT INTO line_group_notices (ward_id, group_id, first_joined_at) VALUES (?, 'fictional-group', '2026-11-06')").bind(w),
      env.DB.prepare("INSERT INTO line_webhook_receipts (ward_id, event_id, expires_at) VALUES (?, 'fictional-event', '2026-11-07')").bind(w),
      env.DB.prepare("INSERT INTO ops_deletion_marks (ward_id, mark_id, scope, deleted_at) VALUES (?, ?, 'record', '2026-11-06')").bind(w, w),
    ]);
    const bucket = new WardBucket(env.ORIGINALS, w);
    await bucket.put("originals/fictional.jpg", sourceBytes);
    // 写真の3表も実際に行を持たせ、公開の条件を通った写しの書き出しと連動消去を確かめる。
    await saveWardPhotoPolicy(env.DB, w, { enabled: true, authorApprovedAt: "2026-11-06T00:00:00Z",
      qualityReportSha256: "a".repeat(64), providerId: "fictional-provider" });
    const policy = await activePhotoPolicy(env, w);
    if (!policy) throw new Error("架空の写真の設定を作れませんでした");
    const photo: PreparedPhoto = { photoId: w, originalId: w, sourceHash,
      maskedHash: await photoHash(Uint8Array.from(atob(MASKED_PNG), (character) => character.charCodeAt(0))),
      png: MASKED_PNG, width: 128, height: 128, faces: 1, policy, mode: "auto",
      masks: [{ x: 0, y: 0, width: 1, height: 1 }] };
    expect(await saveDocument(env.DB, w, p, account.accountId, {
      kind: "report", title: "架空の写真の報告", scope: "public", body: JSON.stringify({ text: "架空の報告です。", items: [] }), basedOn: 0,
    })).toBe(true);
    const version = await env.DB.prepare("SELECT document_id, version_id, version_no FROM document_versions WHERE ward_id = ? AND project_id = ?")
      .bind(w, p).first<{ document_id: string; version_id: string; version_no: number }>();
    if (!version) throw new Error("架空の報告を作れませんでした");
    await env.DB.batch([
      env.DB.prepare("UPDATE document_versions SET published_at = '2026-11-06' WHERE ward_id = ? AND version_id = ?").bind(w, version.version_id),
      env.DB.prepare(`INSERT INTO publication_records
        (ward_id, publication_id, project_id, document_id, version_id, version_no, line_status, published_at, published_by_account_id)
        VALUES (?, ?, ?, ?, ?, ?, 'not_sent', '2026-11-06', ?)`)
        .bind(w, w, p, version.document_id, version.version_id, version.version_no, account.accountId),
      env.DB.prepare(`INSERT INTO report_photo_drafts
        (ward_id, project_id, original_id, revision, state, mode, masks, prepared, updated_at)
        VALUES (?, ?, ?, ?, 'ready', 'auto', ?, ?, '2026-11-06')`)
        .bind(w, p, w, w, JSON.stringify(photo.masks), JSON.stringify(photo)),
      ...photoPublicationStatements(env.DB, w, p, w, [photo]),
    ]);
    return { ward, bucket };
  }
  const target = await records();
  const other = await records();
  const received = await receiveContact(env.DB, { ...PROVIDER_CONTACT_FIXTURE, kind: "access" });
  await writeDailyWardSnapshots(env, new Date("2026-11-06T00:00:00Z"));
  const providerBucket = new WardBucket(env.ORIGINALS, CONTACT_WARD);
  const providerObject = await providerBucket.get("snapshots/daily/2026-11-06.json");
  expect(providerObject).not.toBeNull();
  const providerSnapshot = await providerObject!.json<{ wardId: string; tables: Record<string, Record<string, string | number | null>[]> }>();
  expect(providerSnapshot.wardId).toBe(CONTACT_WARD);
  expect(providerSnapshot.tables.provider_contacts).toEqual([expect.objectContaining({ contact_id: received.id, ward_id: CONTACT_WARD, reach: PROVIDER_CONTACT_FIXTURE.reach })]);
  expect(providerSnapshot.tables.provider_contact_messages).toEqual([expect.objectContaining({ contact_id: received.id, ward_id: CONTACT_WARD, body: PROVIDER_CONTACT_FIXTURE.body })]);
  const snapshot = await (await target.bucket.get("snapshots/daily/2026-11-06.json"))!
    .json<{ tables: Record<string, Record<string, unknown>[]> }>();
  const exported = JSON.parse((await exportWard(env, target.ward.wardId)).body) as {
    tables: Record<string, Record<string, unknown>[]>; objects: { key: string }[];
  };
  const otherCounts = new Map<string, number>();
  for (const entry of WARD_TABLE_POLICY) {
    const rows = await env.DB.prepare(`SELECT * FROM ${entry.table} WHERE ward_id = ?`).bind(target.ward.wardId).all();
    if (entry.snapshot === true) {
      expect(snapshot.tables[entry.table], entry.table).toEqual(rows.results);
    } else {
      // 一時的な文など、復元しない方針の表は空配列としても写しに入れない。
      expect(snapshot.tables).not.toHaveProperty(entry.table);
    }
    if (entry.table === "line_photo_context_texts") expect(rows.results).toHaveLength(1);
    if (typeof entry.deletion === "object") if (!entry.table.startsWith("provider_contact")) expect(rows.results.length, entry.table).toBeGreaterThan(0);
    if (entry.export === true) {
      const expected = rows.results.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => !entry.omitExportColumns?.includes(column))));
      expect(exported.tables[entry.table], entry.table).toEqual(expected);
    } else {
      expect(exported.tables).not.toHaveProperty(entry.table);
    }
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${entry.table} WHERE ward_id = ?`).bind(other.ward.wardId).first<{ n: number }>();
    otherCounts.set(entry.table, count!.n);
  }
  expect(snapshot.tables.line_photo_items).toContainEqual(expect.objectContaining({ quote_token: "fictional-quote-token" }));
  expect(snapshot.tables).not.toHaveProperty("line_photo_context_texts");
  expect(exported.tables).not.toHaveProperty("line_photo_context_texts");
  expect(otherCounts.get("line_photo_context_texts")).toBe(1);
  expect(exported.tables.accounts![0]).not.toHaveProperty("password_hash");
  expect(exported.tables.sign_in_methods![0]).not.toHaveProperty("subject");
  expect(snapshot.tables).not.toHaveProperty("ward_photo_policy");
  expect(snapshot.tables).not.toHaveProperty("report_photo_drafts");
  expect(snapshot.tables).not.toHaveProperty("publication_photos");
  expect(exported.tables).not.toHaveProperty("ward_photo_policy");
  expect(exported.tables).not.toHaveProperty("report_photo_drafts");
  expect(exported.tables.publication_photos).toEqual([expect.objectContaining({
    photo_id: target.ward.wardId, masked_png: MASKED_PNG, model_sha256: PHOTO_MODEL_SHA256, profile: PHOTO_PROFILE,
  })]);
  expect(exported.objects.map((object) => object.key)).toEqual(["originals/fictional.jpg"]);

  await requestWardDeletion(env.DB, target.ward.wardId);
  for (let step = 0; step < 5; step++) {
    await runDeletionCron({ cron: CRON.EVERY_5_MIN } as ScheduledController, env);
    const pending = await env.DB.prepare("SELECT state FROM ops_deletion_queue WHERE ward_id = ?").bind(target.ward.wardId).first<{ state: string }>();
    expect(pending?.state).not.toBe("error");
    if (!pending) break;
  }
  for (const entry of WARD_TABLE_POLICY) {
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${entry.table} WHERE ward_id = ?`).bind(target.ward.wardId).first<{ n: number }>();
    // 一覧で親に任せた表も、実際に入れた行が連動して消えることを確かめる。
    expect(count!.n, entry.table).toBe(entry.table === "ops_deletion_marks" ? 2 : 0);
    const otherCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${entry.table} WHERE ward_id = ?`).bind(other.ward.wardId).first<{ n: number }>();
    expect(otherCount!.n, entry.table).toBe(otherCounts.get(entry.table));
  }
  expect((await target.bucket.list("")).keys.length).toBe(0);
  expect(new Uint8Array(await (await other.bucket.get("originals/fictional.jpg"))!.arrayBuffer()))
    .toEqual(Uint8Array.from(atob(SOURCE_PNG), (character) => character.charCodeAt(0)));
  // 区の消去で提供側の写しを失わず、その行を親から戻すと同じ受付を開ける。
  expect(await providerBucket.head("snapshots/daily/2026-11-06.json")).not.toBeNull();
  await env.DB.prepare("DELETE FROM provider_contacts WHERE ward_id = ? AND contact_id = ?").bind(CONTACT_WARD, received.id).run();
  expect(await contactByToken(env.DB, received.token)).toBeNull();
  for (const table of ["provider_contacts", "provider_contact_messages"]) {
    for (const row of providerSnapshot.tables[table]!) {
      const columns = Object.keys(row);
      await env.DB.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).bind(...Object.values(row)).run();
    }
  }
  expect(await contactByToken(env.DB, received.token)).toMatchObject({ contact_id: received.id, receipt: received.receipt });
  expect(await messages(env.DB, received.id)).toEqual([expect.objectContaining({ body: PROVIDER_CONTACT_FIXTURE.body })]);
});
