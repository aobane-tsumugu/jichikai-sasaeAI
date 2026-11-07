import type Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { snapshotToSql } from "../scripts/snapshot-to-sql.mjs";
import { deleteSession, pendingSessions } from "../src/ai/complete";
import { setClientFactory } from "../src/ai/deps";
import { PACK_VERSION } from "../src/ai/pack";
import { dispatchProject } from "../src/ai/session";
import { cancelHelpOffer, listHelpOffers, restoreHelpOffer } from "../src/answers/help";
import { SNAPSHOT_TABLES, writeDailyWardSnapshots } from "../src/archive/snapshot";
import { CRON } from "../src/core/cron";
import { WardBucket } from "../src/core/storage";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { getJob, setJobProject, startRun, withdrawJob } from "../src/intake/store";
import { requestJobDeletion, requestWardDeletion, runDeletionCron } from "../src/ops/lifecycle";
import { saveDocument } from "../src/project/actions";
import { applyChange, createProject, getProjectState } from "../src/project/api";
import { listSubmittedItems, recordLineInquiry } from "../src/project/followup";
import { currentPublicationTables, type PublishedTableRow } from "../src/space/publication-tables";
import { get, postForm, realApp } from "./helpers";

it("取消と原本の消去を写しにも反映して戻し、古いAI処理があっても区を最後まで消せる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const w = ward.wardId;
  const root = `/${ward.slug}/admin`;
  const bucket = new WardBucket(env.ORIGINALS, w);
  const otherBucket = new WardBucket(env.ORIGINALS, other.ward.wardId);
  const city = await createProject(env.DB, w, { kind: "city_request", title: fixture.draftTitle, year: fixture.eventYear, accountId: account.accountId });
  const event = await createProject(env.DB, w, { kind: "event", title: fixture.nextYearTitle, year: fixture.eventYear, accountId: account.accountId });
  const input = async (projectId: string, text: string) => {
    const result = await receive(env, { wardId: w, projectId, via: "admin", accountId: account.accountId,
      parts: [{ kind: "text", filename: text, mediaType: "text/plain", bytes: new TextEncoder().encode(text) }] });
    if (!result.jobId || !result.received[0]) throw new Error("架空の資料を受け付けられませんでした");
    return { jobId: result.jobId, originalId: result.received[0].originalId };
  };
  const material = await input(city.projectId, fixture.rosterName);
  const withdrawal = await input(event.projectId, fixture.previousMaterial);
  const wardMaterial = await input(event.projectId, fixture.rainAnnouncement);
  const oldSession = `fictional-old-${w}`;
  const goneSession = `fictional-gone-${w}`;
  const newSession = `fictional-new-${w}`;
  const wardSession = `fictional-ward-${w}`;
  const deleted: string[] = [];
  let rejectOld = true;
  const client = { beta: {
    sessions: {
      create: async () => ({ id: newSession }),
      delete: async (id: string) => {
        if (rejectOld && id === oldSession) throw Object.assign(new Error("架空の一時的な失敗"), { status: 503 });
        deleted.push(id);
        return { id };
      },
    },
    agents: { archive: async (id: string) => ({ id }) },
    vaults: { delete: async (id: string) => ({ id }) },
  } } as unknown as Anthropic;
  setClientFactory(() => client);
  const tick = () => runDeletionCron({ cron: CRON.EVERY_5_MIN } as ScheduledController, env);
  const drain = async () => {
    for (let step = 0; step < 40; step++) {
      const queue = await env.DB.prepare("SELECT state FROM ops_deletion_queue WHERE ward_id = ?").bind(w).all<{ state: string }>();
      if (!queue.results.length) return;
      await tick();
    }
    throw new Error("架空の自治会の消去が終わりませんでした");
  };
  try {
    await env.DB.prepare("UPDATE jobs SET status = 'done', session_id = ? WHERE ward_id = ? AND job_id = ?")
      .bind(oldSession, w, material.jobId).run();
    await startRun(env.DB, { wardId: w, jobId: material.jobId, kind: "connect", attempt: 1, model: "fixture", sessionId: oldSession });
    expect(await deleteSession(env, w, material.jobId, oldSession)).toBe(false);
    // 現在の番号が成功した別の実行へ変わっても、古い消し損ねは実行履歴に残る。
    await env.DB.prepare("UPDATE jobs SET session_id = ? WHERE ward_id = ? AND job_id = ?").bind(goneSession, w, material.jobId).run();
    await startRun(env.DB, { wardId: w, jobId: material.jobId, kind: "connect", attempt: 2, model: "fixture", sessionId: goneSession });
    expect(await deleteSession(env, w, material.jobId, goneSession)).toBe(true);
    expect(await setJobProject(env.DB, w, material.jobId, city.projectId)).toBe(true);
    await env.DB.prepare(`INSERT INTO ward_ai (ward_id, environment_id, vault_id, agent_id, agent_version, pack_version, created_at, updated_at)
      VALUES (?, 'fictional-environment', 'fictional-vault', 'fictional-agent', 1, ?, '2026-11-05', '2026-11-05')`).bind(w, PACK_VERSION).run();
    expect(await dispatchProject(env, w, city.projectId)).toBe("started");
    expect((await getJob(env.DB, w, material.jobId))?.session_deleted_at).toBeNull();
    expect((await pendingSessions(env.DB, w, material.jobId)).map((row) => row.session_id).sort()).toEqual([newSession, oldSession].sort());
    // 区の削除には、消去済みの現在の番号と、未回収の古い番号を持つ仕事も残す。
    await env.DB.prepare("UPDATE jobs SET status = 'done', session_id = ?, session_deleted_at = '2026-11-05' WHERE ward_id = ? AND job_id = ?")
      .bind(goneSession, w, wardMaterial.jobId).run();
    await startRun(env.DB, { wardId: w, jobId: wardMaterial.jobId, kind: "connect", attempt: 1, model: "fixture", sessionId: wardSession });

    for (const [name, source] of [[fixture.rosterName, { kind: "original" as const, ref: material.originalId, year: fixture.eventYear }],
      [fixture.firstOfficer, { kind: "person" as const, accountId: account.accountId }]] as const) {
      expect((await applyChange(env.DB, w, city.projectId, { kind: "row", table: "committee", data: { name, role: "受付", contact: "" }, source,
        confidence: "high", packVersion: "fixture-deletion@1" })).status).toBe("applied");
    }
    const state = await getProjectState(env.DB, w, city.projectId);
    if (!state) throw new Error("架空の仕事がありません");
    expect(await saveDocument(env.DB, w, city.projectId, account.accountId, { kind: "report", title: fixture.draftTitle, scope: "staff",
      basedOn: state.project.stateVersion, body: JSON.stringify({ text: fixture.rosterName, items: [] }) })).toBe(true);
    const version = await env.DB.prepare("SELECT document_id, version_id, version_no, body FROM document_versions WHERE ward_id = ? AND project_id = ?")
      .bind(w, city.projectId).first<{ document_id: string; version_id: string; version_no: number; body: string }>();
    if (!version) throw new Error("架空の本文がありません");
    const tables = await currentPublicationTables(env.DB, w, city.projectId);
    expect(tables.find((row) => row.data.name === fixture.rosterName)?.sourceRef).toBe(material.originalId);
    // 配布済みの記録を用意する。消去後もこの番号と配布の記録は保つ。
    await env.DB.batch([
      env.DB.prepare("UPDATE document_versions SET tables_snapshot = ?, published_at = '2026-11-05' WHERE ward_id = ? AND version_id = ?")
        .bind(JSON.stringify(tables), w, version.version_id),
      env.DB.prepare(`INSERT INTO publication_records (publication_id, ward_id, project_id, document_id, version_id, version_no, line_status, published_at, published_by_account_id)
        VALUES (?, ?, ?, ?, ?, ?, 'not_sent', '2026-11-05', ?)`).bind(crypto.randomUUID(), w, city.projectId, version.document_id, version.version_id, version.version_no, account.accountId),
    ]);
    expect((await postForm(realApp, `${root}/requests/city/${city.projectId}`, { operation: "save", submittedWhat: fixture.draftTitle,
      submittedTo: fixture.wardName, submittedOn: fixture.eventDay, answerVersionId: version.version_id, submissionId: crypto.randomUUID() }, cookie)).status).toBe(303);
    expect((await listSubmittedItems(env.DB, w, city.projectId))[0]?.body).toContain(fixture.rosterName);
    expect((await postForm(realApp, `${root}/close/${city.projectId}/finalize`, {}, cookie)).status).toBe(303);
    await env.DB.batch([
      env.DB.prepare("UPDATE city_request_details SET answer_draft = ? WHERE ward_id = ? AND project_id = ?")
        .bind(fixture.reportText, w, city.projectId),
      env.DB.prepare("UPDATE project_close_reports SET body = ? WHERE ward_id = ? AND project_id = ? AND scope = 'staff'")
        .bind(fixture.reportText, w, city.projectId),
    ]);
    await recordLineInquiry(env.DB, w, { eventId: crypto.randomUUID(), receivedAt: "2026-11-05T00:00:00Z", text: fixture.publicAnnouncement,
      sourceType: "user", sourceId: `fictional-source-${w}`, senderLabel: null });
    const inquiryId = await env.DB.prepare("SELECT inquiry_id FROM inquiry_records WHERE ward_id = ?").bind(w).first<string>("inquiry_id");
    if (!inquiryId) throw new Error("架空の問い合わせがありません");
    const cancelledId = crypto.randomUUID();
    const closedId = crypto.randomUUID();
    for (const [id, name] of [[cancelledId, fixture.phoneHelper], [closedId, fixture.sheetHelper]] as const) {
      await env.DB.prepare("INSERT INTO project_help_offers (offer_id, ward_id, project_id, name, times, created_at) VALUES (?, ?, ?, ?, ?, '2026-11-05')")
        .bind(id, w, event.projectId, name, fixture.helperTime).run();
    }
    await otherBucket.put("originals/keep", fixture.reportText);
    await writeDailyWardSnapshots(env, new Date("2026-11-05T00:00:00Z"));
    expect(await withdrawJob(env, w, withdrawal.jobId)).toBe(true);
    expect(await (await get(realApp, `${root}/settings/deletion`, cookie)).text()).toContain(fixture.previousMaterial);
    expect((await postForm(realApp, `${root}/inquiries/${inquiryId}/remove`, {}, cookie)).status).toBe(200);
    const receipt = await cancelHelpOffer(env.DB, w, event.projectId, cancelledId);
    if (!receipt) throw new Error("架空の取消ができませんでした");
    expect(await restoreHelpOffer(env.DB, w, event.projectId, receipt)).toBe(true);
    expect(await cancelHelpOffer(env.DB, w, event.projectId, cancelledId)).not.toBeNull();
    expect((await postForm(realApp, `${root}/close/${event.projectId}/finalize`, {}, cookie)).status).toBe(303);
    expect(await listHelpOffers(env.DB, w, event.projectId)).toHaveLength(0);
    const queueId = await requestJobDeletion(env.DB, w, material.jobId);
    // 一つのAI側の失敗があっても、後から受けた消去を進める。
    for (let step = 0; step < 14; step++) await tick();
    expect(await env.DB.prepare("SELECT state FROM ops_deletion_queue WHERE ward_id = ? AND queue_id = ?").bind(w, queueId).first("state")).toBe("error");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM ops_deletion_queue WHERE ward_id = ? AND target_type IN ('inquiry', 'help_offer')").bind(w).first("n")).toBe(0);
    rejectOld = false;
    // 失敗の行も次の巡回で拾ってから、残りを最後まで進める。
    await tick();
    await drain();
    const preserved = await env.DB.prepare("SELECT body, tables_snapshot FROM document_versions WHERE ward_id = ? AND version_id = ?")
      .bind(w, version.version_id).first<{ body: string; tables_snapshot: string }>();
    expect(preserved).not.toBeNull();
    expect(preserved?.body).toBe(version.body);
    expect(preserved?.tables_snapshot).not.toContain(fixture.rosterName);
    expect(preserved?.tables_snapshot).toContain(fixture.firstOfficer);
    expect(await env.DB.prepare("SELECT version_id FROM publication_records WHERE ward_id = ? AND version_id = ?").bind(w, version.version_id).first("version_id")).toBe(version.version_id);
    expect((await listSubmittedItems(env.DB, w, city.projectId))[0]?.body).toBe(version.body);
    expect(await env.DB.prepare("SELECT answer_draft FROM city_request_details WHERE ward_id = ? AND project_id = ?")
      .bind(w, city.projectId).first("answer_draft")).toBe(fixture.reportText);
    expect(await env.DB.prepare("SELECT body FROM project_close_reports WHERE ward_id = ? AND project_id = ? AND scope = 'staff'")
      .bind(w, city.projectId).first("body")).toBe(fixture.reportText);
    expect(await bucket.get(`originals/${material.originalId}`)).toBeNull();
    expect(deleted.filter((id) => id === oldSession)).toHaveLength(1);

    const snapshotObject = await bucket.get("snapshots/daily/2026-11-05.json");
    if (!snapshotObject) throw new Error("架空の写しがありません");
    const snapshot = await snapshotObject.text();
    for (const erased of [fixture.previousMaterial, fixture.publicAnnouncement, fixture.phoneHelper, fixture.sheetHelper]) expect(snapshot).not.toContain(erased);
    // 取り下げや取消前に作った写しを、実際に空にした同じ架空の区へ戻す。
    await env.DB.prepare("UPDATE wards SET is_active = 0 WHERE ward_id = ?").bind(w).run();
    for (const table of [...SNAPSHOT_TABLES].reverse()) await env.DB.prepare(`DELETE FROM ${table} WHERE ward_id = ?`).bind(w).run();
    await env.DB.exec(snapshotToSql(JSON.parse(snapshot) as unknown).sql);
    expect(await env.DB.prepare("SELECT job_id FROM jobs WHERE ward_id = ? AND job_id = ?").bind(w, withdrawal.jobId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT inquiry_id FROM inquiry_records WHERE ward_id = ? AND inquiry_id = ?").bind(w, inquiryId).first()).toBeNull();
    expect(await listHelpOffers(env.DB, w, event.projectId)).toHaveLength(0);
    expect((await listSubmittedItems(env.DB, w, city.projectId))[0]?.body).toBe(version.body);
    expect(await env.DB.prepare("SELECT answer_draft FROM city_request_details WHERE ward_id = ? AND project_id = ?")
      .bind(w, city.projectId).first("answer_draft")).toBe(fixture.reportText);
    expect(await env.DB.prepare("SELECT body FROM project_close_reports WHERE ward_id = ? AND project_id = ? AND scope = 'staff'")
      .bind(w, city.projectId).first("body")).toBe(fixture.reportText);
    const archive = await get(realApp, `${root}/archive/${city.projectId}`, cookie);
    expect(archive.status).toBe(200);
    expect(await archive.text()).toContain(fixture.rosterName);
    await requestWardDeletion(env.DB, w);
    await drain();
    expect(await env.DB.prepare("SELECT ward_id FROM wards WHERE ward_id = ?").bind(w).first()).toBeNull();
    expect((await bucket.list("")).keys).toHaveLength(0);
    expect(deleted.filter((id) => id === goneSession)).toHaveLength(1);
    expect(deleted.filter((id) => id === wardSession)).toHaveLength(1);
    expect(await env.DB.prepare("SELECT ward_id FROM wards WHERE ward_id = ?").bind(other.ward.wardId).first()).not.toBeNull();
    expect(await (await otherBucket.get("originals/keep"))!.text()).toBe(fixture.reportText);
  } finally {
    setClientFactory(null);
  }
});

it("資料を取り下げて消しても知らせた案内と日次の本文を保ち、出どころが分かる表の行だけを外す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const w = ward.wardId;
  const project = await createProject(env.DB, w, { kind: "event", title: fixture.nextYearTitle, year: fixture.eventYear, accountId: account.accountId });
  const root = `/${ward.slug}`;
  const bucket = new WardBucket(env.ORIGINALS, w);
  const inputs: Array<{ jobId: string; originalId: string; name: string; readingBody: string }> = [];
  for (const name of [fixture.phoneHelper, fixture.sheetHelper]) {
    // 文字の受付で、読み取り全体と原本ごとの本文が自動で索引に入る。手で重ねて足さない。
    const received = await receive(env, { wardId: w, projectId: project.projectId, via: "admin", accountId: account.accountId,
      parts: [{ kind: "text", filename: name, mediaType: "text/plain", bytes: new TextEncoder().encode(name) }] });
    if (!received.jobId || !received.received[0]) throw new Error("架空の資料を受け付けられませんでした");
    const originalId = received.received[0].originalId;
    const readingBody = await env.DB.prepare("SELECT body FROM readings WHERE ward_id = ? AND job_id = ?")
      .bind(w, received.jobId).first<string>("body");
    if (!readingBody) throw new Error("架空の資料の読み取りがありません");
    inputs.push({ jobId: received.jobId, originalId, name, readingBody });
    expect((await applyChange(env.DB, w, project.projectId, { kind: "row", table: "committee", data: { name, role: fixture.helperTime },
      source: { kind: "original", ref: originalId, year: fixture.eventYear }, confidence: "high", packVersion: "fixture-deletion@1" })).status).toBe("applied");
  }
  const [withdrawal, removal] = inputs;
  if (!withdrawal || !removal) throw new Error("架空の資料が足りません");
  expect((await applyChange(env.DB, w, project.projectId, { kind: "row", table: "committee", data: { name: fixture.firstOfficer },
    source: { kind: "person", accountId: account.accountId }, confidence: "high", packVersion: "fixture-deletion@1" })).status).toBe("applied");
  const state = await getProjectState(env.DB, w, project.projectId);
  if (!state) throw new Error("架空の行事がありません");
  expect(await saveDocument(env.DB, w, project.projectId, account.accountId, { kind: "announcement", title: fixture.draftTitle,
    scope: "public", basedOn: state.project.stateVersion, body: JSON.stringify({ text: fixture.publicAnnouncement, items: [] }) })).toBe(true);
  const version = await env.DB.prepare("SELECT document_id, version_id, version_no FROM document_versions WHERE ward_id = ? AND project_id = ?")
    .bind(w, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!version) throw new Error("架空の案内がありません");
  expect((await postForm(realApp, `${root}/admin/publish/${project.projectId}/send`, { documentId: version.document_id,
    versionId: version.version_id, versionNo: String(version.version_no), lineDelivery: "skip" }, cookie)).status).toBe(303);
  const body = await env.DB.prepare("SELECT body FROM document_versions WHERE ward_id = ? AND version_id = ?")
    .bind(w, version.version_id).first<string>("body");
  if (body === null) throw new Error("架空の知らせた案内の本文がありません");
  expect(body).toContain(fixture.publicAnnouncement);
  const tables = await currentPublicationTables(env.DB, w, project.projectId);
  expect(tables).toHaveLength(3);
  // 古い表には出どころのない行もある。対応する記録がある行と、分からない行を一緒に残しておく。
  const unknown: PublishedTableRow = { kind: "committee", data: { name: fixture.requestedBy } };
  const legacy = tables.map(({ kind, data }) => ({ kind, data }));
  const savedTables = [...tables, ...legacy, unknown];
  await env.DB.prepare("UPDATE document_versions SET tables_snapshot = ? WHERE ward_id = ? AND version_id = ?")
    .bind(JSON.stringify(savedTables), w, version.version_id).run();
  // 二つ目の古い行は、現在の表ではなく変更の記録だけで出どころを確かめる。
  await env.DB.prepare("UPDATE project_rows SET data = ? WHERE ward_id = ? AND project_id = ? AND source_ref = ?")
    .bind(JSON.stringify({ name: fixture.sponsorName }), w, project.projectId, removal.originalId).run();
  await env.DB.prepare(`INSERT INTO archive_search_entries (ward_id, project_id, record_type, year, source_id, content, created_at)
    VALUES (?, ?, 'report', ?, ?, ?, '2026-11-05')`).bind(w, project.projectId, fixture.eventYear, version.version_id, body).run();
  await writeDailyWardSnapshots(env, new Date("2026-11-05T00:00:00Z"));

  type SearchEntry = { record_type: string; source_id: string; content: string };
  const searchKey = ({ record_type, source_id, content }: SearchEntry) => JSON.stringify([record_type, source_id, content]);
  const check = async (expected: PublishedTableRow[], remainingSources: string[]) => {
    const preserved = await env.DB.prepare("SELECT body, tables_snapshot FROM document_versions WHERE ward_id = ? AND version_id = ?")
      .bind(w, version.version_id).first<{ body: string; tables_snapshot: string }>();
    expect(preserved?.body).toBe(body);
    expect(JSON.parse(preserved!.tables_snapshot)).toEqual(expected);
    const page = await get(realApp, `${root}/p/${project.projectId}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(fixture.publicAnnouncement);
    // source_idが空の読み取り全体も、対象の資料と一緒に消え、残す資料の分だけ保たれる。
    const expectedSearch: SearchEntry[] = inputs.filter((input) => remainingSources.includes(input.originalId)).flatMap((input) => [
      { record_type: "reading", source_id: "", content: input.readingBody },
      { record_type: "reading", source_id: input.originalId, content: input.name },
    ]);
    expectedSearch.push({ record_type: "report", source_id: version.version_id, content: body });
    const search = await env.DB.prepare("SELECT record_type, source_id, content FROM archive_search_entries WHERE ward_id = ? AND project_id = ?")
      .bind(w, project.projectId).all<SearchEntry>();
    expect(search.results.map(searchKey).sort()).toEqual(expectedSearch.map(searchKey).sort());
    const object = await bucket.get("snapshots/daily/2026-11-05.json");
    if (!object) throw new Error("架空の日次の写しがありません");
    const snapshot = await object.json<{ tables: { document_versions: { version_id: string; body: string; tables_snapshot: string }[];
      archive_search_entries: SearchEntry[] } }>();
    const copied = snapshot.tables.document_versions.find((row) => row.version_id === version.version_id);
    expect(copied?.body).toBe(body);
    expect(JSON.parse(copied!.tables_snapshot)).toEqual(expected);
    expect(snapshot.tables.archive_search_entries.map(searchKey).sort()).toEqual(expectedSearch.map(searchKey).sort());
  };
  const drain = async () => {
    for (let step = 0; step < 12; step++) {
      if (!(await env.DB.prepare("SELECT queue_id FROM ops_deletion_queue WHERE ward_id = ?").bind(w).first())) return;
      await runDeletionCron({ cron: CRON.EVERY_5_MIN } as ScheduledController, env);
    }
    throw new Error("架空の資料の消去が終わりませんでした");
  };
  await check(savedTables, inputs.map((input) => input.originalId));
  expect(await withdrawJob(env, w, withdrawal.jobId)).toBe(true);
  await drain();
  const afterWithdrawal = savedTables.filter((row) => row.data.name !== withdrawal.name);
  await check(afterWithdrawal, [removal.originalId]);
  await requestJobDeletion(env.DB, w, removal.jobId);
  await drain();
  const afterRemoval = afterWithdrawal.filter((row) => row.data.name !== removal.name);
  await check(afterRemoval, []);
  // 消去後に作る写しにも、配った本文と出どころの分からない行を保つ。
  await writeDailyWardSnapshots(env, new Date("2026-11-05T01:00:00Z"));
  await check(afterRemoval, []);
});
