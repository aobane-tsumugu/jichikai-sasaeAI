import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { snapshotToSql } from "../scripts/snapshot-to-sql.mjs";
import { SNAPSHOT_TABLES, writeDailyWardSnapshots } from "../src/archive/snapshot";
import { CONTACT_WARD, receiveContact } from "../src/contact/store";
import { seedAdmin } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import { lookupPaperCode, makePaperCode } from "../src/print/qr";
import { createProject } from "../src/project/api";
import { snapshotRecords } from "./fixtures/snapshot-records";
import { get, realApp } from "./helpers";

it("日次の写しをSQLに戻し、役員画面・紙の番号・元の資料・受付を読み、全文索引を作り直せる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の復元確認会", year: 2026, accountId: account.accountId });
  const w = ward.wardId, p = project.projectId;
  for (const { table, data } of snapshotRecords(w, p, account.accountId)) {
    const columns = Object.keys(data);
    await env.DB.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).bind(...Object.values(data)).run();
  }
  // 消した番号が間にある区でも、最後の番号を巻き戻さない。
  await env.DB.batch([
    env.DB.prepare("UPDATE wards SET paper_project_seq = 50 WHERE ward_id = ?").bind(w),
    env.DB.prepare("UPDATE projects SET paper_no = 7, paper_document_seq = 60 WHERE ward_id = ? AND project_id = ?").bind(w, p),
    env.DB.prepare("UPDATE documents SET paper_no = 11 WHERE ward_id = ? AND document_id = ?").bind(w, `${w}-document`),
  ]);
  const paperCode = await makePaperCode(env.DB, w, p, `${w}-document`, 1);
  expect(paperCode).toBe("P7-D11-V1");
  const bucket = new WardBucket(env.ORIGINALS, w);
  const originalKey = `originals/${w}-original`;
  const originalBody = "架空の復旧先公民館";
  await bucket.put(originalKey, originalBody, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  const contact = await receiveContact(env.DB, { kind: "access", wardName: "架空の復元確認区", name: "架空の依頼役", reach: "restore@example.invalid", body: "架空の問い合わせです。" });
  await writeDailyWardSnapshots(env, new Date("2026-11-06T00:00:00Z"));
  const key = "snapshots/daily/2026-11-06.json";
  const wardSnapshot = await (await bucket.get(key))!.json();
  const providerBucket = new WardBucket(env.ORIGINALS, CONTACT_WARD);
  const providerSnapshot = await (await providerBucket.get(key))!.json();
  const wardSql = snapshotToSql(wardSnapshot).sql;
  const providerSql = snapshotToSql(providerSnapshot).sql;

  // 試験で作った区だけを空にする。別の区と実環境には触れない。
  for (const table of [...SNAPSHOT_TABLES].reverse()) {
    await env.DB.prepare(`DELETE FROM ${table} WHERE ward_id = ?`).bind(w).run();
  }
  await env.DB.prepare("DELETE FROM provider_contacts WHERE ward_id = ?").bind(CONTACT_WARD).run();
  await env.DB.prepare("DELETE FROM provider_contact_throttle WHERE ward_id = ?").bind(CONTACT_WARD).run();
  await bucket.delete(originalKey);
  expect((await get(realApp, `/${ward.slug}/admin/`, cookie)).status).toBe(404);
  await env.DB.exec(wardSql);
  await env.DB.exec(providerSql);
  // SQLとは別に保管した元の資料も、同じ区IDとキーで戻す。
  await bucket.put(originalKey, originalBody, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });

  const root = `/${ward.slug}/admin`;
  for (const [path, text] of [
    [`${root}/`, "架空の復元確認会"],
    [`${root}/projects/${p}`, "架空の復旧先公民館"],
    [`${root}/projects/${p}/committee`, "架空の委員"],
    [`${root}/answers/${p}?view=list`, "架空の世帯"],
    [`${root}/settings/people`, account.name],
    [`${root}/intake/originals/${w}-original`, originalBody],
  ]) {
    const response = await get(realApp, path!, cookie);
    expect(response.status, path).toBe(200);
    expect((await response.text()).includes(text!)).toBe(true);
  }
  expect(await lookupPaperCode(env.DB, w, paperCode!)).toEqual({ projectId: p, documentId: `${w}-document`, version: 1 });
  const next = await createProject(env.DB, w, { kind: "event", title: "架空の復旧後の行事", year: 2027, accountId: account.accountId });
  expect(await env.DB.prepare("SELECT paper_no FROM projects WHERE ward_id = ? AND project_id = ?").bind(w, next.projectId).first("paper_no")).toBe(51);
  await env.DB.prepare("INSERT INTO documents (document_id, ward_id, project_id, kind, title, scope) VALUES (?, ?, ?, 'notice', '架空の復旧後の知らせ', 'public')")
    .bind(`${w}-next-document`, w, p).run();
  expect(await env.DB.prepare("SELECT paper_no FROM documents WHERE ward_id = ? AND document_id = ?").bind(w, `${w}-next-document`).first("paper_no")).toBe(61);
  const thread = await get(realApp, `/contact/${contact.token}`);
  expect(thread.status).toBe(200);
  expect((await thread.text()).includes("架空の問い合わせです。")).toBe(true);

  const search = `${root}/archive/search?q=${encodeURIComponent("復旧先")}`;
  const searchShowsOriginal = async () => {
    const response = await get(realApp, search, cookie);
    expect(response.status).toBe(200);
    // 検索語は「」で強調されるため、入力欄にはない本文の続きで結果を確かめる。
    return (await response.text()).includes("公民館");
  };
  expect(await searchShowsOriginal()).toBe(true);
  await env.DB.prepare("DELETE FROM archive_search_fts WHERE rowid IN (SELECT entry_id FROM archive_search_entries WHERE ward_id = ?)").bind(w).run();
  expect(await searchShowsOriginal()).toBe(false);
  await env.DB.prepare("INSERT INTO archive_search_fts (rowid, content) SELECT entry_id, content FROM archive_search_entries WHERE ward_id = ?").bind(w).run();
  expect(await searchShowsOriginal()).toBe(true);
});
