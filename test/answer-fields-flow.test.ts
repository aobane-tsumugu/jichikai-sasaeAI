import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { listAnswers } from "../src/answers/api";
import { getAnswerFields } from "../src/answers/fields";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { saveDocument, setEventDay } from "../src/project/actions";
import { createProject } from "../src/project/api";
import { setSetting } from "../src/settings/store";
import { get, postForm, realApp } from "./helpers";

/** 送った資料に、AI の読み取りを書いておく（試験では AI を呼ばない）。 */
async function material(wardId: string, projectId: string, filename: string, reading: Record<string, unknown>) {
  const got = await receive(env, { wardId, projectId, via: "admin", parts: [{ kind: "text", filename, mediaType: "text/plain", bytes: new TextEncoder().encode(filename) }] });
  await env.DB.prepare("INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at) VALUES (?, ?, ?, 'model', 'test@1', '', ?, ?)")
    .bind(crypto.randomUUID(), wardId, got.jobId, JSON.stringify({ original_years: [], text_blocks: [], tables: [], decisions: [], unreadable: [], fields: [], ...reading }), new Date().toISOString()).run();
}

async function publish(wardSlug: string, wardId: string, projectId: string, cookie: string) {
  const doc = await env.DB.prepare(`SELECT d.document_id, v.version_id, v.version_no FROM documents d JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = 'announcement' ORDER BY v.version_no DESC LIMIT 1`).bind(wardId, projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  expect((await postForm(realApp, `/${wardSlug}/admin/publish/${projectId}/send`, { documentId: doc!.document_id, versionId: doc!.version_id, versionNo: String(doc!.version_no), recipientScope: "member_households", lineDelivery: "skip" }, cookie)).status).toBe(303);
  return doc!;
}

it("年末の見回り: 去年の案内と回答票から日と班の欄を候補に出し、押すと足して、Webと紙に同じ欄が出て、答えの一覧で日ごとに数える", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  await setSetting(env.DB, ward.wardId, "squads", JSON.stringify(["1班", "2班"]));
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "年末の見回り", year: 2026, accountId: account.accountId, eventDay: "2026-12-26" });
  expect(await setEventDay(env.DB, ward.wardId, project.projectId, "2026-12-26", account.accountId, "2026-12-28")).toBe(true);
  await material(ward.wardId, project.projectId, "2025年度_年末の見回りのお知らせ.docx", {
    document_kind: "announcement", summary: "年末の見回りの案内",
    fields: [{ name: "申し込み", value: "12月15日（月）までに、班長へお伝えください 都合のよい日を選べます", confidence: "high", original_id: "x", locator: "表1/5行目" }],
  });
  await material(ward.wardId, project.projectId, "2025年度_年末の見回りの回答票.pdf", {
    document_kind: "answer_sheet", summary: "年末の見回りの回答票",
    fields: [{ name: "班", value: "", confidence: "high", original_id: "x", locator: "2行目" }, { name: "参加できる日", value: "□12月26日 □12月27日 □12月28日", confidence: "high", original_id: "x", locator: "4行目" }],
  });
  const root = `/${ward.slug}/admin/answers/${project.projectId}`;

  // 候補は出すが、押すまで足さない。班は班の名前がある自治会では今までどおり聞いている。
  let page = await (await get(realApp, `${root}?view=fields`, cookie)).text();
  expect(page).toContain("返事で聞く欄の候補があります");
  expect(page).toContain("「2025年度_年末の見回りのお知らせ.docx」に「都合のよい日を選べます」とありました。");
  expect(page).toContain("日を選ぶ欄を、今年の返事にも足しますか。押すまで足しません。");
  expect(page).toContain("代表者のお名前、参加するかどうか、人数、班です。");
  expect((await getAnswerFields(env.DB, ward.wardId, project.projectId, ["1班", "2班"])).fields).toEqual([]);

  // 班を外すと、回答票の班の欄が候補に出る。
  expect((await postForm(realApp, `${root}/fields/district/remove`, {}, cookie)).status).toBe(303);
  page = await (await get(realApp, `${root}?view=fields`, cookie)).text();
  expect(page).toContain("今は班を聞いていません。");
  expect(page).toContain("「2025年度_年末の見回りの回答票.pdf」の回答票には、日と班を聞く欄がありました。日を選ぶ欄と班を聞く欄を、今年の返事にも足しますか。");

  // 候補を押して、日と班を足す。
  const added = await postForm(realApp, `${root}/fields`, { kind: "days" }, cookie);
  expect(added.status).toBe(303);
  expect(added.headers.get("location")).toContain("done=field_added");
  expect((await postForm(realApp, `${root}/fields`, { kind: "district" }, cookie)).status).toBe(303);
  const current = await getAnswerFields(env.DB, ward.wardId, project.projectId, ["1班", "2班"]);
  expect(current.districtAsked).toBe(true);
  expect(current.fields).toEqual([expect.objectContaining({ kind: "days", label: "参加できる日", options: ["12月26日（土）", "12月27日（日）", "12月28日（月）"], multiple: true })]);
  const days = current.fields[0]!;
  page = await (await get(realApp, `${root}?view=fields`, cookie)).text();
  expect(page).toContain("選ぶ日は、12月26日（土）、12月27日（日）、12月28日（月）です。いくつでも選べます。");
  expect(page).not.toContain("返事で聞く欄の候補があります");

  // 案内の下書きの画面にも、返事で聞くことが出る。
  await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, { kind: "announcement", title: "年末の見回りのご案内", scope: "public", basedOn: 0,
    body: JSON.stringify({ text: "■いつ\n12月26日（土）から28日（月）まで\n\n■申し込み\n都合のよい日を選んで、返事をください。", items: [{ key: "date_time", content: "12月26日（土）から28日（月）まで" }] }) });
  const draft = await (await get(realApp, `/${ward.slug}/admin/projects/${project.projectId}/draft/announcement`, cookie)).text();
  expect(draft).toContain("代表者のお名前、参加するかどうか、人数、班、参加できる日です。住民のスマホの返事と紙の回答票に、同じ欄が出ます。");

  // Web の返事に日を選ぶ欄が出て、選んだ日が返事に残る。
  const publicPath = `/${ward.slug}/answer/${project.projectId}`;
  const form = await (await get(realApp, publicPath)).text();
  expect(form).toContain("参加できる日（いくつでも選べます）");
  expect(form).toContain(`name="field_${days.fieldId}" value="12月27日（日）"`);
  expect(form).toContain("<legend>班</legend>");
  const body = new URLSearchParams({ attend: "yes", household: "佐藤", district: "1班", adults_count: "2", children_count: "", seniors_count: "" });
  body.append(`field_${days.fieldId}`, "12月26日（土）");
  body.append(`field_${days.fieldId}`, "12月27日（日）");
  const sent = await realApp.request(publicPath, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", origin: "http://localhost" }, body: body.toString() }, env);
  expect(sent.status).toBe(200);
  expect(await sent.text()).toContain("<dt>参加できる日</dt><dd>12月26日（土）、12月27日（日）</dd>");
  // 選ぶ物に無い日は受けない。
  const wrong = new URLSearchParams({ attend: "yes", household: "鈴木", district: "", adults_count: "1" });
  wrong.append(`field_${days.fieldId}`, "1月1日");
  expect((await realApp.request(publicPath, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", origin: "http://localhost" }, body: wrong.toString() }, env)).status).toBe(400);

  // 電話の返事を入れる画面でも入れられる。
  const hand = await (await get(realApp, `${root}?view=hand`, cookie)).text();
  expect(hand).toContain(`name="field_${days.fieldId}"`);
  expect((await postForm(realApp, `${root}/phone`, { household: "高橋", district: "2班", attend: "yes", adults_count: "1", [`field_${days.fieldId}`]: "12月27日（日）" }, cookie)).status).toBe(303);
  expect((await listAnswers(env.DB, ward.wardId, project.projectId)).map((answer) => answer.fieldValues?.[days.fieldId])).toEqual([["12月26日（土）", "12月27日（日）"], ["12月27日（日）"]]);

  // 答えの一覧で、日ごとに世帯と人数を数える。
  let summary = await (await get(realApp, root, cookie)).text();
  expect(summary).toContain("参加できる日: 12月26日（土）は1世帯（2人）です。12月27日（日）は2世帯（3人）です。12月28日（月）は0世帯です。");

  // あとから足した欄は、今までの返事を消さず、空のまま数える。
  expect((await postForm(realApp, `${root}/fields`, { kind: "text" }, cookie)).status).toBe(303);
  summary = await (await get(realApp, root, cookie)).text();
  expect(summary).toContain("ひとこと: まだだれも書いていません。この欄が空の返事が2件あります。");
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toHaveLength(2);

  // 返事の一覧と、返事を直す画面でも、足した欄の答えを見て直せる。
  const list = await (await get(realApp, `${root}?view=list`, cookie)).text();
  expect(list).toContain("参加できる日: 12月26日（土）、12月27日（日）");
  const first = (await listAnswers(env.DB, ward.wardId, project.projectId))[0]!;
  const edit = await (await get(realApp, `${root}/${first.answerId}/edit`, cookie)).text();
  expect(edit).toMatch(new RegExp(`name="field_${days.fieldId}" value="12月26日（土）" checked`));
  expect((await postForm(realApp, `${root}/${first.answerId}/edit`, { household: "佐藤", district: "1班", attend: "yes", adults_count: "2", [`field_${days.fieldId}`]: "12月28日（月）" }, cookie)).status).toBe(303);
  expect((await listAnswers(env.DB, ward.wardId, project.projectId))[0]!.fieldValues?.[days.fieldId]).toEqual(["12月28日（月）"]);
  expect((await postForm(realApp, `${root}/${first.answerId}/edit`, { household: "佐藤", district: "1班", attend: "yes", adults_count: "2", [`field_${days.fieldId}`]: "12月26日（土）" }, cookie)).status).toBe(303);
  const restored = (await listAnswers(env.DB, ward.wardId, project.projectId))[0]!;
  expect(restored.fieldValues?.[days.fieldId]).toEqual(["12月26日（土）"]);

  // 紙の回答票にも同じ欄が出る（下書きの紙と、知らせたあとの紙）。班の名前がある自治会は班ごとに刷るので、紙に班の欄は出さない。
  const doc = await publish(ward.slug, ward.wardId, project.projectId, cookie);
  const paper = await (await get(realApp, `/${ward.slug}/admin/print/${project.projectId}/${doc.document_id}/${doc.version_no}/answer`, cookie)).text();
  expect(paper).toContain("参加できる日（いくつでも）");
  expect(paper).toContain("□ 12月26日（土）　□ 12月27日（日）　□ 12月28日（月）");
  expect(paper).toContain("ひとこと（書かなくてかまいません）");
  expect(paper).not.toContain("班（分からないときは空けてかまいません）");
  const preview = await (await get(realApp, `/${ward.slug}/admin/print/${project.projectId}/${doc.document_id}/${doc.version_no}/preview`, cookie)).text();
  expect(preview).toContain("□ 12月26日（土）　□ 12月27日（日）　□ 12月28日（月）");

  // 欄を外しても、今までの答えは消えない。
  expect((await postForm(realApp, `${root}/fields/${days.fieldId}/remove`, {}, cookie)).status).toBe(303);
  expect((await listAnswers(env.DB, ward.wardId, project.projectId))[0]!.fieldValues?.[days.fieldId]).toEqual(["12月26日（土）"]);
  expect(await (await get(realApp, publicPath)).text()).not.toContain("参加できる日");
});

it("班の名前が無い自治会では、班を型として出さず、Webでも紙でも班を聞かない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  await env.DB.prepare("DELETE FROM ward_settings WHERE ward_id = ? AND key = 'squads'").bind(ward.wardId).run();
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2026, accountId: account.accountId, eventDay: "2026-10-25" });
  await material(ward.wardId, project.projectId, "2025年度_秋の収穫祭の回答票.pdf", {
    document_kind: "answer_sheet", summary: "秋の収穫祭の回答票", fields: [{ name: "班", value: "", confidence: "high", original_id: "x", locator: "2行目" }],
  });
  const root = `/${ward.slug}/admin/answers/${project.projectId}`;
  const page = await (await get(realApp, `${root}?view=fields`, cookie)).text();
  expect(page).not.toContain("班を聞く欄がありました");
  expect(page).not.toContain("班を聞く</button>");
  expect(page).toContain("代表者のお名前、参加するかどうか、人数です。");
  expect((await postForm(realApp, `${root}/fields`, { kind: "district" }, cookie)).headers.get("location")).toContain("done=field_failed");
  await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, { kind: "announcement", title: "秋の収穫祭のご案内", scope: "public", basedOn: 0,
    body: JSON.stringify({ text: "秋の収穫祭を行います。", items: [] }) });
  const doc = await publish(ward.slug, ward.wardId, project.projectId, cookie);
  const paper = await (await get(realApp, `/${ward.slug}/admin/print/${project.projectId}/${doc.document_id}/${doc.version_no}/answer`, cookie)).text();
  expect(paper).toContain("代表者のお名前");
  expect(paper).not.toContain("班（分からないときは空けてかまいません）");
  expect(await (await get(realApp, `/${ward.slug}/answer/${project.projectId}`)).text()).not.toContain("<legend>班</legend>");
});

it("総会の返事には欄を足さない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "general_meeting", title: "総会", year: 2026, accountId: account.accountId });
  expect((await postForm(realApp, `/${ward.slug}/admin/answers/${project.projectId}/fields`, { kind: "days" }, cookie)).status).toBe(404);
  expect(await (await get(realApp, `/${ward.slug}/admin/answers/${project.projectId}?view=fields`, cookie)).text()).not.toContain("欄を足す");
  expect((await getAnswerFields(env.DB, ward.wardId, project.projectId, [])).fields).toEqual([]);
});
