import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { fictionalPaperPhoto } from "../fixtures/test-photo";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { KNOW_BASE, listKnowItems } from "../src/know/store";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

const read = async (path: string, cookie: string) => (await get(realApp, path, cookie)).text();

it("十五項目を基本に、書く、外す、戻す、足す、名前を変える", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const list = await read(`${root}/know`, cookie);
  expect(KNOW_BASE).toHaveLength(15);
  for (const base of KNOW_BASE) expect(list).toContain(base.title);
  expect(list).toContain("15項目のうち0項目が入っています。");
  await postForm(realApp, `${root}/know/meeting`, { body: "毎年4月。半数以上の出席で成立。" }, cookie);
  const after = await read(`${root}/know`, cookie);
  expect(after).toContain("毎年4月。半数以上の出席で成立。");
  expect(after).toContain("15項目のうち1項目が入っています。");
  await postForm(realApp, `${root}/know/duties/remove`, {}, cookie);
  const removed = await read(`${root}/know`, cookie);
  expect(removed).toContain("外した項目（1つ）");
  expect(removed).toContain("14項目のうち1項目が入っています。");
  await postForm(realApp, `${root}/know/duties/restore`, {}, cookie);
  await postForm(realApp, `${root}/know/events/title`, { title: "祭りと行事" }, cookie);
  const added = await postForm(realApp, `${root}/know`, { title: "架空の水路の管理" }, cookie);
  const page = await read(added.headers.get("location")!, cookie);
  expect(page).toContain("架空の水路の管理");
  const final = await read(`${root}/know`, cookie);
  expect(final).toContain("祭りと行事");
  expect(final).toContain("架空の水路の管理");
  expect(final).toContain("16項目のうち1項目が入っています。");
  expect((await get(realApp, `${root}/know/none`, cookie)).status).toBe(404);
});

it("預からない物は欄の上に書き、会計の項目でも書ける", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const page = await read(`/${ward.slug}/admin/know/accounts`, cookie);
  expect(page).toContain("このサービスでは通帳、印鑑、暗証番号を預かりません");
  expect(await read(`/${ward.slug}/admin/know/handover`, cookie)).toContain("このサービスでは鍵とパスワードを預かりません");
});

it("総会を閉じたあと直されていない項目と、時間の経った項目に見直しの合図を出し、今のままでよいを残せる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  await postForm(realApp, `${root}/know/meeting`, { body: "架空の総会の決まり" }, cookie);
  await env.DB.prepare("UPDATE ward_know_items SET reviewed_at = '2026-01-10T00:00:00.000Z' WHERE ward_id = ? AND item_id = 'meeting'").bind(ward.wardId).run();
  const meeting = await createProject(env.DB, ward.wardId, { kind: "general_meeting", title: "架空の総会", year: 2026, accountId: account.accountId });
  await env.DB.prepare("UPDATE projects SET closed_at = '2026-04-20T00:00:00.000Z' WHERE ward_id = ? AND project_id = ?").bind(ward.wardId, meeting.projectId).run();
  const stale = (await listKnowItems(env.DB, ward.wardId, new Date("2026-05-01T00:00:00Z"))).items.find((item) => item.id === "meeting")!;
  expect(stale.state).toBe("old");
  expect(stale.note).toBe("総会のあと直されていません");
  await postForm(realApp, `${root}/know/meeting/reviewed`, {}, cookie);
  expect((await listKnowItems(env.DB, ward.wardId)).items.find((item) => item.id === "meeting")!.state).toBe("fact");
  await env.DB.prepare("UPDATE ward_know_items SET reviewed_at = '2025-01-10T00:00:00.000Z' WHERE ward_id = ? AND item_id = 'meeting'").bind(ward.wardId).run();
  await env.DB.prepare("UPDATE projects SET closed_at = '2024-04-20T00:00:00.000Z' WHERE ward_id = ? AND project_id = ?").bind(ward.wardId, meeting.projectId).run();
  const old = (await listKnowItems(env.DB, ward.wardId, new Date("2026-03-01T00:00:00Z"))).items.find((item) => item.id === "meeting")!;
  expect(old.state).toBe("old");
  expect(old.note).toBe("1年2か月前に見直しました");
});

it("区の資料は行き先の無い紙も出し、項目につなげても一枚のまま残り、他の区からは見えない", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  expect(await read(`${root}/files`, cookie)).toContain("まだ資料はありません");
  const received = await receive(env, { wardId: ward.wardId, via: "admin", parts: [{ kind: "photo", filename: "架空の規約.jpg", mediaType: "image/jpeg", bytes: new Uint8Array(fictionalPaperPhoto()) }] });
  const originalId = received.received[0]!.originalId;
  const files = await read(`${root}/files`, cookie);
  expect(files).toContain("架空の規約.jpg");
  expect(files).toContain("どこにもつながっていません");
  await postForm(realApp, `${root}/know/meeting/links`, { originalId }, cookie);
  const linked = await read(`${root}/files`, cookie);
  expect(linked).toContain(KNOW_BASE.find((base) => base.key === "meeting")!.title);
  expect(linked).not.toContain("どこにもつながっていません");
  expect(await read(`${root}/know/meeting`, cookie)).toContain("つながりを外す");
  expect((await postForm(realApp, `/${other.ward.slug}/admin/know/meeting/links`, { originalId }, other.cookie)).status).toBe(404);
  expect(await read(`/${other.ward.slug}/admin/files`, other.cookie)).not.toContain("架空の規約");
});

it("行き先のない写真は聞かずに区の資料へ残し、名簿と読めた写真だけを聞き、答えたら二度聞かない", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const photo = async (n: number, documentKind: string) => {
    const got = await receive(env, { wardId: ward.wardId, via: "line_direct", parts: [{ kind: "photo", filename: `LINE写真${n}.jpg`, mediaType: "image/jpeg", bytes: new Uint8Array([...fictionalPaperPhoto(), n]) }] });
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE jobs SET status = 'read', read_at = ? WHERE ward_id = ? AND job_id = ?").bind(now, ward.wardId, got.jobId).run();
    await env.DB.prepare("INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at) VALUES (?, ?, ?, 'model', 'read-general@3', 'claude-sonnet-5-5', ?, ?)")
      .bind(`reading-${n}`, ward.wardId, got.jobId, JSON.stringify({ document_kind: documentKind, original_years: [], summary: `架空の紙${n}`, project_suggestions: [], text_blocks: [], fields: [], tables: [], decisions: [], unreadable: [] }), now).run();
    await env.DB.prepare("INSERT INTO line_inbox_items (ward_id, item_id, event_id, sender_id, original_kind, received_at, disposition, job_id) VALUES (?, ?, ?, 'U-fictional', 'image', ?, 'unmatched', ?)")
      .bind(ward.wardId, `item-${n}`, `event-${n}`, now, got.jobId).run();
    return got.jobId!;
  };
  await photo(1, "other");
  const rosterJob = await photo(2, "roster");
  const inbox = await read(`${root}/inbox`, cookie);
  expect(inbox).toContain("質問があります（1件）");
  expect(inbox).toContain("この紙で、世帯の名簿を入れ直しますか？");
  expect(inbox).toContain("どこにもつながっていません");
  expect(inbox).toContain("架空の紙1");
  expect(await read(`${root}/`, cookie)).toContain("届いた紙に質問が1件あります");
  expect(await read(`${root}/files`, cookie)).toContain("架空の紙1");
  await postForm(realApp, `${root}/inbox/roster/${rosterJob}/skip`, {}, cookie);
  const after = await read(`${root}/inbox`, cookie);
  expect(after).not.toContain("この紙で、世帯の名簿を入れ直しますか？");
  expect(after).toContain("架空の紙2");
  const pick = await read(`${root}/inbox/item-1/pick`, cookie);
  expect(pick).toContain("役員が知っておくことにつなげる");
  expect(pick).toContain("総会");
});
