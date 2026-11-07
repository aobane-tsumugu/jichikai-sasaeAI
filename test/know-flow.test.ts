import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { fictionalPaperPhoto } from "../fixtures/test-photo";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { KNOW_TOPICS, type KnowTopic } from "../src/ai/schema";
import { applyWardReading } from "../src/know/apply";
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
  expect(inbox).toContain("この資料で、世帯の名簿を入れ直しますか？");
  expect(inbox).toContain("どこにもつながっていません");
  expect(inbox).toContain("架空の紙1");
  expect(await read(`${root}/`, cookie)).toContain("届いた写真やファイルのうち、1件に質問があります");
  expect(await read(`${root}/files`, cookie)).toContain("架空の紙1");
  await postForm(realApp, `${root}/inbox/roster/${rosterJob}/skip`, {}, cookie);
  const after = await read(`${root}/inbox`, cookie);
  expect(after).not.toContain("この資料で、世帯の名簿を入れ直しますか？");
  expect(after).toContain("架空の紙2");
  const pick = await read(`${root}/inbox/item-1/pick`, cookie);
  expect(pick).toContain("役員が知っておくことにつなげる");
  expect(pick).toContain("総会");
});

it("一年の地図は一般の例から始まり、行事が入ると置き換わり、外す、戻す、足すができる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const empty = await read(`${root}/`, cookie);
  expect(empty).toContain("まず、手元の資料を十件送ってください");
  expect(empty).toContain("年末の役員会");
  expect(empty).toContain("仮の内容");
  await postForm(realApp, `${root}/year/drill/remove`, {}, cookie);
  const year = await read(`${root}/year`, cookie);
  expect(year).toContain("外した行（1つ）");
  expect(year).not.toContain('<b>防災訓練</b>');
  await postForm(realApp, `${root}/year/drill/restore`, {}, cookie);
  await postForm(realApp, `${root}/year`, { title: "架空の草刈り", month: "6" }, cookie);
  expect(await read(`${root}/year`, cookie)).toContain("架空の草刈り");
  await createProject(env.DB, ward.wardId, { kind: "general_meeting", title: "架空の定期総会", year: 2026, accountId: account.accountId });
  await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の秋祭り", year: 2026, eventDay: "2026-10-18", accountId: account.accountId });
  const home = await read(`${root}/`, cookie);
  expect(home).toContain("架空の定期総会");
  expect(home).toContain("日はまだ決まっていません");
  expect(home).not.toContain('<b>定期総会</b>');
  expect(home).toContain("架空の秋祭り");
  expect(home).not.toContain('<b>秋の行事</b>');
});

it("AIが読んだ内容を空の項目へ入れ、役員が書いた文は上書きせず質問にし、外した項目には入れない", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const received = await receive(env, { wardId: ward.wardId, via: "admin", parts: [{ kind: "photo", filename: "架空の規約.jpg", mediaType: "image/jpeg", bytes: new Uint8Array(fictionalPaperPhoto()) }] });
  const original_id = received.received[0]!.originalId;
  const reading = (facts: { topic: KnowTopic; text: string }[], entries: { title: string; month: number | null }[] = []) => ({ document_kind: "rules", original_years: [], summary: "架空の規約", text_blocks: [], fields: [], tables: [], decisions: [], unreadable: [],
    ward_facts: facts.map((fact) => ({ original_id, ...fact })), year_entries: entries.map((entry) => ({ original_id, date_text: "", ...entry })) }) as never;
  await postForm(realApp, `${root}/know/dues`, { body: "年3,600円" }, cookie);
  await postForm(realApp, `${root}/know/safety/remove`, {}, cookie);
  await applyWardReading(env.DB, ward.wardId, reading([{ topic: "meeting", text: "毎年4月に開く" }, { topic: "dues", text: "年4,800円" }, { topic: "safety", text: "架空の防災" }], [{ title: "架空の一斉清掃", month: 5 }, { title: "月の分からない行事", month: null }]));
  const { items, removed } = await listKnowItems(env.DB, ward.wardId);
  expect(items.find((item) => item.id === "meeting")).toMatchObject({ body: "毎年4月に開く", state: "fact", note: "届いた資料から読み取りました" });
  expect(items.find((item) => item.id === "dues")).toMatchObject({ body: "年3,600円", state: "checking", proposed: "年4,800円" });
  expect(removed.find((item) => item.id === "safety")!.body).toBe("");
  const page = await read(`${root}/know/dues`, cookie);
  expect(page).toContain("この内容にする");
  expect(await read(`${root}/know/meeting`, cookie)).toContain("つながりを外す");
  await postForm(realApp, `${root}/know/dues/proposal`, { use: "yes" }, cookie);
  expect((await listKnowItems(env.DB, ward.wardId)).items.find((item) => item.id === "dues")).toMatchObject({ body: "年4,800円", state: "fact" });
  const year = await read(`${root}/year`, cookie);
  expect(year).toContain("架空の一斉清掃");
  expect(year).not.toContain("月の分からない行事");
  expect(year).not.toContain("<b>春の清掃</b>");
  await applyWardReading(env.DB, ward.wardId, reading([], [{ title: "架空の一斉清掃", month: 5 }]));
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM ward_year_items WHERE ward_id = ? AND title = '架空の一斉清掃'").bind(ward.wardId).first<{ n: number }>())?.n).toBe(1);
  expect(KNOW_BASE.map((base) => base.key)).toEqual([...KNOW_TOPICS]);
});

it("地図の行から種類と名前を選んだ状態で行事を始められる", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const page = await read(`${root}/year/general-meeting`, cookie);
  expect(page).toContain(`/projects?kind=general_meeting&amp;title=`);
  const start = await read(`${root}/projects?kind=general_meeting&title=${encodeURIComponent("定期総会")}`, cookie);
  expect(start).toContain('value="定期総会"');
  expect(start).toContain('<input type="hidden" name="kind" value="general_meeting"/>');
});

it("行事が増えてもトップの地図は今に近い行に絞り、全部は一年の画面で見る", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  for (let index = 0; index < 30; index += 1) await createProject(env.DB, ward.wardId, { kind: "event", title: `架空の集まり${index}`, year: 2026, accountId: account.accountId });
  const home = await read(`${root}/`, cookie);
  expect(home.match(/class="map-row /g)?.length).toBe(14);
  expect(home).toContain("一年を全部見る");
  expect((await read(`${root}/year`, cookie)).match(/class="map-row /g)!.length).toBeGreaterThan(30);
});

it("作ったばかりの行事は、行事が多い区でもトップから開け、質問は地図より上に出る", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  for (let index = 0; index < 20; index += 1) await createProject(env.DB, ward.wardId, { kind: "event", title: `架空の古い集まり${index}`, year: 2026, eventDay: "2026-05-10", accountId: account.accountId });
  const fresh = await createProject(env.DB, ward.wardId, { kind: "request", title: "架空の作ったばかりの要望", year: 2026, accountId: account.accountId });
  const home = await read(`${root}/`, cookie);
  expect(home).toContain(`/projects/${fresh.projectId}/map`);
  expect(home).toContain("架空の作ったばかりの要望");
  expect(home).toContain("ほかの行事（16件）は一年の画面で見る");
});

it("紙は行事から外して区の資料だけに置け、移しても前の行事の中身は消さずに知らせ、地図のどの行も外して戻せる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const first = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の夏祭り", year: 2026, accountId: account.accountId });
  const second = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の秋祭り", year: 2026, accountId: account.accountId });
  const got = await receive(env, { wardId: ward.wardId, projectId: first.projectId, via: "admin", parts: [{ kind: "photo", filename: "架空の紙.jpg", mediaType: "image/jpeg", bytes: new Uint8Array(fictionalPaperPhoto()) }] });
  await env.DB.prepare("UPDATE jobs SET status = 'done' WHERE ward_id = ? AND job_id = ?").bind(ward.wardId, got.jobId).run();
  const pick = await read(`${root}/inbox/city/${got.jobId}/pick`, cookie);
  expect(pick).toContain("この行事から外す");
  const moved = await postForm(realApp, `${root}/inbox/city/${got.jobId}`, { operation: "assign", projectId: second.projectId }, cookie);
  const movedPage = await read(moved.headers.get("location")!, cookie);
  expect(movedPage).toContain("架空の秋祭りに入れました");
  expect(movedPage).toContain("架空の夏祭りの下書きに、ここから入った内容が残っていることがあります");
  // 繋いでいる間は動かせない。繋ぎ終わった後に外す。
  await env.DB.prepare("UPDATE jobs SET status = 'done' WHERE ward_id = ? AND job_id = ?").bind(ward.wardId, got.jobId).run();
  const detached = await postForm(realApp, `${root}/inbox/city/${got.jobId}`, { operation: "detach" }, cookie);
  const detachedPage = await read(detached.headers.get("location")!, cookie);
  expect(detachedPage).toContain("架空の秋祭りから外しました。「区の資料」に残っています。");
  expect((await env.DB.prepare("SELECT project_id FROM jobs WHERE ward_id = ? AND job_id = ?").bind(ward.wardId, got.jobId).first<{ project_id: string | null }>())?.project_id).toBeNull();
  expect(await read(`${root}/files`, cookie)).toContain("架空の紙.jpg");
  await applyWardReading(env.DB, ward.wardId, { document_kind: "year_plan", original_years: [], summary: "", text_blocks: [], fields: [], tables: [], decisions: [], unreadable: [], ward_facts: [], year_entries: [{ original_id: got.received[0]!.originalId, title: "架空の読み違えた行事", month: 7, date_text: "" }] } as never);
  const id = (await env.DB.prepare("SELECT item_id FROM ward_year_items WHERE ward_id = ? AND title = '架空の読み違えた行事'").bind(ward.wardId).first<{ item_id: string }>())!.item_id;
  expect(await read(`${root}/year/${id}`, cookie)).toContain("この行を外す");
  await postForm(realApp, `${root}/year/${id}/remove`, {}, cookie);
  const year = await read(`${root}/year`, cookie);
  expect(year).toContain("外した行（1つ）");
  expect(year).not.toContain("<b>架空の読み違えた行事</b>");
  await postForm(realApp, `${root}/year/${id}/restore`, {}, cookie);
  expect(await read(`${root}/year`, cookie)).toContain("<b>架空の読み違えた行事</b>");
});

it('日付のない行事も、名前の似た仮の行に重ねて二重に出さない', async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  await createProject(env.DB, ward.wardId, { kind: 'event', title: '架空の防災訓練', year: 2026, accountId: account.accountId });
  const home = await read(`/${ward.slug}/admin/`, cookie);
  expect(home).toContain('架空の防災訓練');
  expect(home).not.toContain('<b>防災訓練</b>');
  expect(home).toContain('<b>夏の行事</b>');
});

it("進めている行事は作った順に新しい物から出し、来年の行事に押し出されない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  for (let index = 0; index < 6; index += 1) await createProject(env.DB, ward.wardId, { kind: "general_meeting", title: `架空の来年の総会${index}`, year: 2027, accountId: account.accountId });
  const fresh = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の今年作った行事", year: 2026, accountId: account.accountId });
  await env.DB.prepare("UPDATE projects SET created_at = '2099-01-01T00:00:00.000Z' WHERE ward_id = ? AND project_id = ?").bind(ward.wardId, fresh.projectId).run();
  const home = await read(`/${ward.slug}/admin/`, cookie);
  expect(home).toContain(`/projects/${fresh.projectId}/map`);
});

it("進めている行事の帯は、資料と答えの数で五段の濃さになり、数と凡例も添える", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const quiet = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の静かな行事", year: 2026, eventDay: "2026-07-10", accountId: account.accountId });
  const busy = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空のにぎやかな行事", year: 2026, eventDay: "2026-10-10", accountId: account.accountId });
  for (let index = 0; index < 10; index += 1) await env.DB.prepare(`INSERT INTO project_answers (answer_id, ward_id, project_id, household, district, people_count, source) VALUES (?, ?, ?, ?, '1班', 1, 'web')`).bind(`answer-${index}`, ward.wardId, busy.projectId, `架空の世帯${index}`).run();
  const home = await read(`/${ward.slug}/admin/`, cookie);
  expect(home).toMatch(new RegExp(`map-row fact l1" href="[^"]*${quiet.projectId}`));
  expect(home).toMatch(new RegExp(`map-row fact l3" href="[^"]*${busy.projectId}`));
  expect(home).toContain("答え10件");
  expect(home).not.toContain("済んだ仕事");
  expect(home).toContain("40件から");
  expect(home).toContain("5〜14件");
  expect(home).toContain('<i class="q">10</i>');
  expect(home).toContain('<i class="q">4月</i>');
  expect(home).toContain("<i>11</i>");
});

it("一年の行から始めると何の準備かを聞かず、段取りの先頭に準備の始まり、当日、終わりが出る", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const row = await read(`${root}/year/general-meeting`, cookie);
  expect(row).toContain("今年の定期総会の準備を始める");
  const form = await read(`${root}/projects?kind=general_meeting&title=${encodeURIComponent("定期総会")}`, cookie);
  expect(form).toContain("今年の定期総会の準備を始める");
  expect(form).not.toContain("何の準備ですか");
  expect(form).toContain('<input type="hidden" name="kind" value="general_meeting"/>');
  const plain = await read(`${root}/projects`, cookie);
  expect(plain).toContain("何の準備ですか");
  expect(plain).toContain("ごみ当番のように、順番で回すもの");
  const undated = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の日のない祭り", year: 2026, accountId: account.accountId });
  const undatedMap = await read(`${root}/projects/${undated.projectId}/map`, cookie);
  expect(undatedMap).toContain("当日がまだ決まっていません");
  const dated = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の日のある祭り", year: 2026, eventDay: "2026-11-28", accountId: account.accountId });
  const datedMap = await read(`${root}/projects/${dated.projectId}/map`, cookie);
  expect(datedMap).toContain("<dt>準備を始める</dt>");
  expect(datedMap).toContain("<dt>当日</dt>");
  expect(datedMap).toContain("<dt>終わる</dt>");
  expect(datedMap).not.toContain("当日がまだ決まっていません");
});
