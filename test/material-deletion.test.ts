import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { writeDailyWardSnapshots } from "../src/archive/snapshot";
import { CRON } from "../src/core/cron";
import { WardBucket } from "../src/core/storage";
import { seedAccount, seedAdmin, seedDeviceCookie } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { claimRead, finishRead, getReadings, withdrawOriginal } from "../src/intake/store";
import { applyLineFact, applyWardReading } from "../src/know/apply";
import { saveKnowItem } from "../src/know/store";
import { runDeletionCron } from "../src/ops/lifecycle";
import { saveDocument } from "../src/project/actions";
import { addQuestion, applyChange, createProject, getProjectState } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

const tick = { cron: CRON.EVERY_5_MIN } as ScheduledController;
const snapshotKey = "snapshots/daily/2026-11-08.json";

async function finish(wardId: string) {
  for (let i = 0; i < 5; i++) {
    if (!await env.DB.prepare("SELECT 1 FROM ops_deletion_queue WHERE ward_id = ? LIMIT 1").bind(wardId).first()) break;
    await runDeletionCron(tick, env);
  }
  expect(await env.DB.prepare("SELECT COUNT(*) FROM ops_deletion_queue WHERE ward_id = ?").bind(wardId).first("COUNT(*)")).toBe(0);
}

it("準備の一件だけを別の役員が消せ、残す資料と準備と下書きと知らせた記録を保つ", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const w = ward.wardId;
  const project = await createProject(env.DB, w, { kind: "event", title: "資料を確かめる準備", year: 2026, accountId: account.accountId });
  const input = await receive(env, { wardId: w, projectId: project.projectId, via: "admin", accountId: account.accountId,
    parts: ["消す会場の文", "残す持ち物の文"].map((text) => ({ kind: "text", filename: `${text}.txt`, mediaType: "text/plain", bytes: new TextEncoder().encode(text) })) });
  const removed = input.received[0]!.originalId, kept = input.received[1]!.originalId;
  for (const change of [
    { itemKey: "place" as const, value: "消す今年の会場", ref: removed, year: 2026 },
    { itemKey: "place" as const, value: "消す去年の会場", ref: removed, year: 2025 },
    { itemKey: "belongings" as const, value: "残す持ち物", ref: kept, year: 2026 },
  ]) expect((await applyChange(env.DB, w, project.projectId, { kind: "item", itemKey: change.itemKey, value: change.value,
    // 同じ資料の同じ項目を別の年として読む処理は、別の版で登録する。
    source: { kind: "original", ref: change.ref, year: change.year }, confidence: "high", packVersion: `deletion-${change.year}@1` })).status).toBe("applied");
  for (const [ref, text] of [[removed, "消す資料の質問"], [kept, "残す資料の質問"]]) {
    expect((await addQuestion(env.DB, w, project.projectId, { kind: "decide", text: text!, source: { kind: "original", ref: ref!, year: 2026 }, packVersion: "deletion@1" })).status).toBe("added");
  }
  expect((await addQuestion(env.DB, w, project.projectId, { kind: "decide", text: "消す比較の質問",
    source: { kind: "original", ref: kept, year: 2026 }, packVersion: "deletion@1" })).status).toBe("added");
  await env.DB.prepare("UPDATE project_questions SET detail = ? WHERE ward_id = ? AND project_id = ? AND text = '消す比較の質問'")
    .bind(JSON.stringify({ items: [{ sources: [{ kind: "original", ref: removed }, { kind: "original", ref: kept }] }] }), w, project.projectId).run();
  const state = (await getProjectState(env.DB, w, project.projectId))!;
  expect(await saveDocument(env.DB, w, project.projectId, account.accountId, { kind: "announcement", title: "知らせた内容",
    scope: "public", basedOn: state.project.stateVersion, body: JSON.stringify({ text: "役員が書いた案内", items: [] }) })).toBe(true);
  const version = await env.DB.prepare("SELECT version_id, document_id, version_no, body FROM document_versions WHERE ward_id = ? AND project_id = ?")
    .bind(w, project.projectId).first<{ version_id: string; document_id: string; version_no: number; body: string }>();
  if (!version) throw new Error("試しの文書がありません");
  const copiedRows = [removed, kept].map((ref) => ({ kind: "duties", data: { name: ref === removed ? "消す表の担当" : "残す表の担当" }, sourceRef: ref }));
  await env.DB.batch([
    env.DB.prepare("UPDATE document_versions SET tables_snapshot = ?, published_at = '2026-11-08' WHERE ward_id = ? AND version_id = ?")
      .bind(JSON.stringify(copiedRows), w, version.version_id),
    env.DB.prepare(`INSERT INTO publication_records (publication_id, ward_id, project_id, document_id, version_id, version_no, line_status, published_at, published_by_account_id)
      VALUES (?, ?, ?, ?, ?, ?, 'not_sent', '2026-11-08', ?)`)
      .bind(crypto.randomUUID(), w, project.projectId, version.document_id, version.version_id, version.version_no, account.accountId),
  ]);
  await writeDailyWardSnapshots(env, new Date("2026-11-08T00:00:00Z"));
  const root = `/${ward.slug}/admin`;
  const entry = `${root}/intake/originals/${removed}/withdraw`;
  expect(await (await get(realApp, `${root}/projects/${project.projectId}`, cookie)).text()).toContain(entry);
  expect(await (await get(realApp, `${root}/intake/originals/${removed}`, cookie)).text()).toContain(entry);
  const other = await seedAccount(env.DB, w, "別の試験役員");
  const otherCookie = await seedDeviceCookie(env.DB, w, other.accountId);
  const confirmation = await (await get(realApp, entry, otherCookie)).text();
  for (const word of ["元のファイル", "読み取った内容", "今年の内容", "去年の参考", "AIからの質問", "消さずに戻る"]) expect(confirmation).toContain(word);
  expect((await postForm(realApp, entry, {}, otherCookie)).status).toBe(200);
  expect(await env.DB.prepare("SELECT withdrawn_at FROM originals WHERE ward_id = ? AND original_id = ?").bind(w, removed).first("withdrawn_at")).toEqual(expect.any(String));
  expect((await get(realApp, `${root}/intake/originals/${removed}?raw=1`, cookie)).status).toBe(404);
  const immediately = await (await get(realApp, `${root}/projects/${project.projectId}`, cookie)).text();
  expect(immediately).not.toContain(entry);
  expect(immediately).toContain(`${root}/intake/originals/${kept}`);
  expect((await getReadings(env.DB, w, input.jobId!)).every((row) => !JSON.stringify(row.body).includes("消す会場の文"))).toBe(true);
  await finish(w);
  const after = (await getProjectState(env.DB, w, project.projectId))!;
  expect(after.project.projectId).toBe(project.projectId);
  expect(after.items.find((item) => item.key === "place")).toMatchObject({ current: null, references: [] });
  expect(after.items.find((item) => item.key === "belongings")?.current?.content).toBe("残す持ち物");
  expect(after.questions.map((question) => question.text)).toEqual(["残す資料の質問"]);
  expect(await (await get(realApp, `${root}/projects/${project.projectId}`, cookie)).text()).toContain("まだ分からないこと:");
  expect(await env.DB.prepare("SELECT body, tables_snapshot FROM document_versions WHERE ward_id = ? AND version_id = ?").bind(w, version.version_id).first())
    .toEqual({ body: version.body, tables_snapshot: JSON.stringify([copiedRows[1]]) });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM publication_records WHERE ward_id = ? AND version_id = ?").bind(w, version.version_id).first("n")).toBe(1);
  const bucket = new WardBucket(env.ORIGINALS, w);
  expect(await bucket.get(`originals/${removed}`)).toBeNull();
  expect(await (await bucket.get(`originals/${kept}`))!.text()).toBe("残す持ち物の文");
  const snapshot = await (await bucket.get(snapshotKey))!.text();
  for (const text of [removed, "消す今年の会場", "消す去年の会場", "消す資料の質問", "消す比較の質問", "消す会場の文", "消す表の担当"]) expect(snapshot).not.toContain(text);
  for (const text of [kept, "残す持ち物", "残す資料の質問", "役員が書いた案内"]) expect(snapshot).toContain(text);
});

it("基本情報の文と質問と結び付きを資料一件の分だけ消し、人の文とほかの資料の文を保つ", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const w = ward.wardId;
  const input = await receive(env, { wardId: w, via: "admin", accountId: account.accountId,
    parts: ["消す基本情報", "残す基本情報"].map((text) => ({ kind: "text", filename: `${text}.txt`, mediaType: "text/plain", bytes: new TextEncoder().encode(text) })) });
  const removed = input.received[0]!.originalId, kept = input.received[1]!.originalId;
  const reading = (await getReadings(env.DB, w, input.jobId!))[0]!;
  if (!("fields" in reading.body)) throw new Error("試しの読み取りの形が違います");
  const body = { ...reading.body, ward_facts: [
    { topic: "meeting" as const, text: "消す開き方\n消す成立の決まり", original_id: removed },
    { topic: "meeting" as const, text: "残す総会の文", original_id: kept },
    { topic: "delivery" as const, text: "消す配り方の候補", original_id: removed },
  ] };
  await env.DB.prepare("UPDATE readings SET body = ? WHERE ward_id = ? AND job_id = ? AND source = ?").bind(JSON.stringify(body), w, input.jobId, reading.source).run();
  await saveKnowItem(env.DB, w, "delivery", { body: "役員が書いた配り方" });
  await applyWardReading(env.DB, w, body);
  await applyLineFact(env.DB, w, input.jobId!, "safety", "消す基本情報");
  await writeDailyWardSnapshots(env, new Date("2026-11-08T00:00:00Z"));
  expect(await withdrawOriginal(env, w, removed)).toBe(true);
  await finish(w);
  expect(await env.DB.prepare("SELECT body FROM ward_know_items WHERE ward_id = ? AND item_id = 'meeting'").bind(w).first("body")).toBe("残す総会の文");
  expect(await env.DB.prepare("SELECT body, proposed_text, proposed_original_id FROM ward_know_items WHERE ward_id = ? AND item_id = 'delivery'").bind(w).first())
    .toEqual({ body: "役員が書いた配り方", proposed_text: "", proposed_original_id: null });
  expect(await env.DB.prepare("SELECT body FROM ward_know_items WHERE ward_id = ? AND item_id = 'safety'").bind(w).first("body")).toBe("");
  expect((await env.DB.prepare("SELECT original_id FROM ward_material_links WHERE ward_id = ?").bind(w).all<{ original_id: string }>()).results)
    .toEqual([{ original_id: kept }]);
  const snapshot = await (await new WardBucket(env.ORIGINALS, w).get(snapshotKey))!.text();
  for (const text of [removed, "消す開き方", "消す成立の決まり", "消す配り方の候補", "消す基本情報"]) expect(snapshot).not.toContain(text);
  expect(snapshot).toContain("残す総会の文");
  expect(snapshot).toContain("役員が書いた配り方");
});

it("自治会をまたいだ一件削除とログインしていない操作を通さない", async () => {
  const mine = await seedAdmin(env.DB), other = await seedAdmin(env.DB);
  const input = await receive(env, { wardId: mine.ward.wardId, via: "admin", parts: [{ kind: "text", filename: "残す文.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("自治会で保つ文") }] });
  const original = input.received[0]!.originalId;
  expect(await withdrawOriginal(env, other.ward.wardId, original)).toBe(false);
  expect((await postForm(realApp, `/${other.ward.slug}/admin/intake/originals/${original}/withdraw`, {}, other.cookie)).status).toBe(409);
  expect((await postForm(realApp, `/${mine.ward.slug}/admin/intake/originals/${original}/withdraw`, {})).status).toBe(303);
  expect(await env.DB.prepare("SELECT withdrawn_at FROM originals WHERE ward_id = ? AND original_id = ?").bind(mine.ward.wardId, original).first())
    .toEqual({ withdrawn_at: null });
});

it("読み取り中に一件を消しても、古い読み取りがその資料を書き戻さず残りを読み直せる", async () => {
  const { ward } = await seedAdmin(env.DB);
  const w = ward.wardId;
  const input = await receive(env, { wardId: w, via: "admin", parts: ["消す途中の文", "残す途中の文"].map((text) =>
    ({ kind: "text", filename: `${text}.txt`, mediaType: "text/plain", bytes: new TextEncoder().encode(text) })) });
  const old = (await getReadings(env.DB, w, input.jobId!))[0]!;
  await env.DB.prepare("UPDATE jobs SET status = 'received' WHERE ward_id = ? AND job_id = ?").bind(w, input.jobId).run();
  const attempt = await claimRead(env.DB, w, input.jobId!, 60_000);
  if (!attempt) throw new Error("試しの読み取りを始められませんでした");
  expect(await withdrawOriginal(env, w, input.received[0]!.originalId)).toBe(true);
  expect(await finishRead(env.DB, { wardId: w, jobId: input.jobId!, attempt, source: old.source, model: old.model, packVersion: old.pack_version, body: old.body })).toBe(false);
  expect(await claimRead(env.DB, w, input.jobId!, 60_000)).toBe(attempt + 1);
  const remaining = JSON.stringify((await getReadings(env.DB, w, input.jobId!)).map((row) => row.body));
  expect(remaining).not.toContain("消す途中の文");
  expect(remaining).toContain("残す途中の文");
});
