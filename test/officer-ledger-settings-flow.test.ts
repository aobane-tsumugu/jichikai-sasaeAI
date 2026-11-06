import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { applyChange, createProject, getProjectState } from "../src/project/api";
import { saveDocument } from "../src/project/actions";
import { DOCUMENT_KINDS } from "../src/project/model";
import { recordLineInquiry } from "../src/project/followup";
import { get, postForm, realApp } from "./helpers";

it("名簿のない一年目に資料を送り、問い合わせの答えと協賛の運営メモを残す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const read = async (path: string) => {
    const response = await get(realApp, path, cookie);
    expect(response.status, path).toBe(200);
    return response.text();
  };
  const follow = async (response: Response) => {
    expect(response.status).toBe(303);
    const path = response.headers.get("location");
    if (!path) throw new Error("操作のあとの画面がありません");
    return read(path);
  };

  expect(await read(`${root}/inquiries`)).toContain("届いている問い合わせはありません");
  expect(await read(`${root}/requests/city`)).toContain("まだ出していない依頼はありません");
  expect(await read(`${root}/ledger`)).toContain("行事はまだありません");
  expect(await read(`${root}/archive/map`)).toContain("予定はまだありません");
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: fixture.nextYearTitle, year: fixture.nextYear,
    eventDay: fixture.eventDay, accountId: account.accountId,
  });
  const id = project.projectId;
  const send = await read(`${root}/intake?project=${id}`);
  expect(send).toContain(`${fixture.nextYearTitle}に資料を送る`);
  expect(send).toContain(`name="project_id" value="${id}"`);
  expect(send).toContain(`href="${root}/projects/${id}/map"`);
  const received = await receive(env, {
    wardId: ward.wardId, projectId: id, via: "admin", accountId: account.accountId,
    // 題が「案内」だけの、実際に送られる形でも資料を開ける。
    parts: [{ kind: "text", filename: "案内", mediaType: "text/plain", bytes: new TextEncoder().encode(fixture.publicAnnouncement) }],
  });
  const original = received.received[0];
  if (!original) throw new Error("架空の資料を受け取れませんでした");
  const originalPath = `${root}/intake/originals/${original.originalId}`;
  const originalPage = await read(`${originalPath}?back=${encodeURIComponent(`${root}/projects/${id}/ledger`)}`);
  expect(originalPage).toContain(fixture.publicAnnouncement);
  expect(originalPage).toContain(`href="${root}/projects/${id}/ledger"`);
  expect(await read(`${root}/intake/received?project=${id}`)).toContain(`${fixture.nextYearTitle}に資料を預かりました`);

  for (const name of [fixture.firstHousehold, null]) {
    await recordLineInquiry(env.DB, ward.wardId, {
      eventId: crypto.randomUUID(), receivedAt: new Date().toISOString(),
      text: fixture.publicAnnouncement, sourceType: name ? "group" : "user",
      sourceId: crypto.randomUUID(), senderLabel: name,
    });
  }
  const inquiries = await read(`${root}/inquiries`);
  expect(inquiries).toContain("同じ内容が2件あります");
  expect(inquiries).toContain(`「${fixture.publicDayText}」と書かれています`);
  expect(inquiries).toContain("知らせを待たずに、ときどき見てください");
  const inquiry = await env.DB.prepare("SELECT inquiry_id FROM inquiry_records WHERE ward_id = ? ORDER BY received_at LIMIT 1")
    .bind(ward.wardId).first<{ inquiry_id: string }>();
  if (!inquiry) throw new Error("架空の問い合わせがありません");
  const inquiryPath = `${root}/inquiries/${inquiry.inquiry_id}`;
  const inquiryPage = await read(inquiryPath);
  expect(inquiryPage).toContain("返事を書いて送ると、来たところへ届き");
  expect(inquiryPage).toContain('<button name="operation" value="send">1か所に送る</button>');
  expect(inquiryPage).toContain('<button class="secondary" name="operation" value="record">どう答えたかを残す</button>');
  expect(inquiryPage).toContain("公式LINEで返事を送れない人がいます");
  expect(inquiryPage).toContain("送り先が分からないため送れません");
  expect(inquiryPage).toContain("電話や直接答えたときは、その内容を記録してください");
  const saved = await follow(await postForm(realApp, inquiryPath, {
    answer: fixture.reportText, submittedToCity: "yes", kind: "request", operation: "record",
  }, cookie));
  expect(saved).toContain("新しい記録が足されます");
  expect(saved).toContain("問い合わせの一覧を開く");
  await follow(await postForm(realApp, inquiryPath, { answer: fixture.nextYearChange, kind: "request", operation: "record" }, cookie));
  const notes = await read(inquiryPath);
  expect(notes).toContain(fixture.reportText);
  expect(notes).toContain(fixture.nextYearChange);
  expect(await read(`${inquiryPath}/original`)).toContain(fixture.publicAnnouncement);
  const rawInquiries = await env.DB.prepare("SELECT subject, answer, answer_history, line_answer_sent_at FROM inquiry_records WHERE ward_id = ?")
    .bind(ward.wardId).all<{ subject: string; answer: string; answer_history: string; line_answer_sent_at: string | null }>();
  expect(rawInquiries.results).toHaveLength(2);
  for (const row of rawInquiries.results) {
    expect(row.subject).toBe(fixture.publicAnnouncement);
    expect(row.answer).toBe(fixture.nextYearChange);
    expect(JSON.parse(row.answer_history)).toHaveLength(2);
    expect(row.line_answer_sent_at).toBeNull();
  }

  expect((await applyChange(env.DB, ward.wardId, id, {
    kind: "row", table: "sponsors", data: { name: fixture.sponsorName, reply: "yes" },
    source: { kind: "original", ref: original.originalId, locator: fixture.previousLocator, year: fixture.nextYear },
    confidence: "medium", packVersion: "ledger-flow@1", requestId: crypto.randomUUID(),
  })).status).toBe("applied");
  const state = await getProjectState(env.DB, ward.wardId, id);
  const sponsor = state?.tables.sponsors.find((r) => r.scope === "current");
  if (!sponsor) throw new Error("架空の協賛の行がありません");
  const ledgerPath = `${root}/projects/${id}/ledger`;
  expect(await read(ledgerPath)).toContain("額の情報なし");
  const edited = await follow(await postForm(realApp, `${ledgerPath}/${sponsor.rowId}`, {
    counterpart: fixture.sponsorName, amount: String(fixture.sponsorAmount), direction: "income", note: fixture.reportText,
  }, cookie));
  expect(edited).toContain("元の資料は変わりません");
  expect(edited).toContain(`${fixture.sponsorAmount.toLocaleString("ja-JP")}円`);
  const after = await getProjectState(env.DB, ward.wardId, id);
  expect(after?.tables.sponsors.find((r) => r.rowId === sponsor.rowId)).toMatchObject({
    source: { kind: "original", ref: original.originalId },
  });
  expect(after?.tables.sponsors.find((r) => r.rowId === sponsor.rowId)?.data.amount).toBeUndefined();
  expect(after?.tables.ledger.find((r) => r.data.memoGroup === "sponsors")).toMatchObject({
    data: { amount: fixture.sponsorAmount }, source: { kind: "original", ref: original.originalId }, personFields: expect.arrayContaining(["amount"]),
  });
  const raw = await get(realApp, `${originalPath}?raw=1`, cookie);
  expect(await raw.text()).toBe(fixture.publicAnnouncement);
  expect(await read(`${ledgerPath}/${sponsor.rowId}`)).toContain(`value="${fixture.sponsorAmount}"`);
  const memoEntry = await read(`${root}/ledger`);
  expect(memoEntry).toContain(`href="${root}/projects/${id}/map"`);
  expect(memoEntry).not.toContain('name="budgetIncome"');
  expect(memoEntry).not.toContain('name="settlementDraft"');
  // 名簿を入れなくても、一般的な題の下書きを全種類で読める。
  for (const kind of DOCUMENT_KINDS) {
    const beforeDraft = await getProjectState(env.DB, ward.wardId, id);
    if (!beforeDraft) throw new Error("架空の行事がありません");
    expect(await saveDocument(env.DB, ward.wardId, id, account.accountId, {
      kind, title: "案内", scope: kind === "duty_roster" ? "space" : "public", basedOn: beforeDraft.project.stateVersion,
      body: JSON.stringify({ text: fixture.publicAnnouncement, items: [{ key: "place", content: fixture.previousPlace }] }),
    })).toBe(true);
  }
  expect((await applyChange(env.DB, ward.wardId, id, {
    kind: "item", itemKey: "place", value: fixture.layoutSpot, source: { kind: "person", accountId: account.accountId },
    confidence: "high", packVersion: "ledger-flow@1", requestId: crypto.randomUUID(),
  })).status).toBe("applied");
  for (const kind of DOCUMENT_KINDS) {
    const draftPath = `${root}/projects/${id}/draft/${kind}`;
    const draft = await read(draftPath);
    expect(draft).toContain("新しい資料が届きました");
    expect(draft).toContain(`action="${draftPath}/save"`);
    expect(draft).toContain(fixture.publicAnnouncement);
    expect(draft).toContain("前の下書きに戻す");
  }
  const noticePath = `${root}/projects/${id}/draft/notice`;
  const beforeNotice = await getProjectState(env.DB, ward.wardId, id);
  if (!beforeNotice) throw new Error("架空の行事がありません");
  const noticeSaved = await follow(await postForm(realApp, `${noticePath}/save`, {
    title: "知らせ", scope: "public", based_on: String(beforeNotice.project.stateVersion),
    text: fixture.rainAnnouncement, item_place: fixture.layoutSpot,
  }, cookie));
  expect(noticeSaved).toContain("保存しました。まだ配っていません");
  expect(noticeSaved).toContain(fixture.rainAnnouncement);
  const noticeRestored = await follow(await postForm(realApp, `${noticePath}/restore/1`, {}, cookie));
  expect(noticeRestored).toContain("前の下書きに戻しました。今の下書きも残ります。");
  expect(noticeRestored).toContain(`action="${noticePath}/save"`);
  expect(noticeRestored).toContain(`<textarea id="text" name="text" rows="10" maxlength="20000">${fixture.publicAnnouncement}</textarea>`);
  const city = await createProject(env.DB, ward.wardId, { kind: "city_request", title: fixture.draftTitle, year: fixture.eventYear, accountId: account.accountId });
  const cityPath = `${root}/requests/city/${city.projectId}`;
  expect(await follow(await postForm(realApp, cityPath, { operation: "save", answerDraft: fixture.reportText, dueOn: fixture.eventDay }, cookie))).toContain("出した日がまだ空です");
  expect(await read(cityPath)).toContain(fixture.reportText);
  const today = await read(`${root}/projects/today`);
  expect(today).toContain("締切のあるもの");
  expect(today).toContain("締切のないもの");
  expect(today).not.toContain("まだ答えていない世帯");
  expect(await read(`${root}/archive/map`)).toContain('class="row-link"');

  for (const path of [`/inquiries/${inquiry.inquiry_id}`, `/projects/${id}/ledger/${sponsor.rowId}`, `/intake/originals/${original.originalId}?raw=1`]) {
    expect((await get(realApp, `/${other.ward.slug}/admin${path}`, other.cookie)).status).toBe(404);
  }
  const infoSaved = await follow(await postForm(realApp, `${root}/settings/info`, { contact: fixture.requestedBy, squads: "" }, cookie));
  expect(infoSaved).toContain("すでに配った案内は変わりません");
  const templateSaved = await follow(await postForm(realApp, `${root}/settings/templates`, { name: fixture.draftTitle, body: fixture.draftText }, cookie));
  expect(templateSaved).toContain("次に知らせを作るときから");
  expect(await read(`${root}/settings/people`)).toContain("役員の一覧");
  const removed = await postForm(realApp, `${inquiryPath}/remove`, {}, cookie);
  expect(removed.status).toBe(200);
  expect(await removed.text()).toContain("問い合わせの記録を消しました");
  expect((await get(realApp, inquiryPath, cookie)).status).toBe(404);
});
