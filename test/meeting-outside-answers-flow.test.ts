import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import * as session from "../src/ai/session";
import { listAnswers, replaceRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import { receive } from "../src/intake/receive";
import { createLineIntakePorts } from "../src/line/intake";
import { createProject } from "../src/project/api";
import { createInvite } from "../src/space/api";
import { cookieFrom, get, postForm, realApp } from "./helpers";

it("試しの総会の返事をLINEからも世帯で数え、実行委員・班長と記録に同じ意味で出し、行事の人数を保つ", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "general_meeting", title: "総会", year: fixture.eventYear, accountId: account.accountId,
  });
  const id = project.projectId;
  const root = `/${ward.slug}/admin`;
  const space = `/${ward.slug}/space/${id}`;
  const answersPath = `${root}/answers/${id}`;
  const close = `${root}/close/${id}`;
  const record = `${root}/archive/${id}`;
  await replaceRoster(env.DB, ward.wardId, [fixture.firstHousehold, fixture.secondHousehold, fixture.rosterName, fixture.firstOfficer]
    .map((household) => ({ household, district: fixture.district })), { household: 0, district: 1 });
  expect((await postForm(realApp, `/${ward.slug}/answer/${id}`, {
    household: fixture.firstHousehold, district: fixture.district, meeting_status: "attend", proxy_name: "",
  })).status).toBe(200);
  expect((await postForm(realApp, `${answersPath}/phone`, {
    household: fixture.phoneHousehold, district: "", meeting_status: "absent", proxy_name: "",
  }, cookie)).status).toBe(303);

  const ports = createLineIntakePorts(env, { waitUntil: () => undefined });
  const lineAnswer = async (projectId: string, text: string) => {
    const received = await receive(env, {
      wardId: ward.wardId, projectId, via: "line_direct",
      parts: [{ kind: "text", filename: "試しのLINEの文.txt", mediaType: "text/plain", bytes: new TextEncoder().encode(text) }],
    });
    const originalId = received.received[0]?.originalId;
    if (!received.jobId || !originalId || !ports.saveAnswerReply) throw new Error("試しの文を受け付けられません。");
    await ports.saveAnswerReply(ward.wardId, projectId, {
      eventId: crypto.randomUUID(), senderId: "試しの送信者", sourceType: "user", kind: "text", text,
      receivedAt: new Date().toISOString(),
    }, received.jobId);
    return originalId;
  };
  // 委任先も名簿にあるが、答えた世帯には名乗った人を使う。
  await lineAnswer(id, `${fixture.secondHousehold}です。${fixture.firstOfficer}に委任します。`);
  await lineAnswer(id, `${fixture.rosterName}です。委任します。`);
  await lineAnswer(id, "出席しません。");
  const unreadableText = `${fixture.phoneHousehold}です。大人2人です。`;
  const unreadable = await lineAnswer(id, unreadableText);
  await lineAnswer(id, `${fixture.phoneHousehold}です。出席・委任・欠席は未定です。`);
  const saved = await listAnswers(env.DB, ward.wardId, id);
  expect(saved).toHaveLength(5);
  expect(saved.every((answer) => answer.peopleCount === 0)).toBe(true);
  expect(saved.filter((answer) => answer.source === "line")).toEqual(expect.arrayContaining([
    expect.objectContaining({ household: fixture.secondHousehold, district: fixture.district, meetingStatus: "proxy", proxyName: fixture.firstOfficer }),
    expect.objectContaining({ household: fixture.rosterName, district: fixture.district, meetingStatus: "proxy", proxyName: "" }),
    expect.objectContaining({ household: "名前の分からない答え", district: "", meetingStatus: "absent", proxyName: "" }),
  ]));
  const original = await env.DB.prepare("SELECT r2_path FROM originals WHERE ward_id = ? AND original_id = ?")
    .bind(ward.wardId, unreadable).first<{ r2_path: string }>();
  if (!original) throw new Error("読めない答えの元の文が残っていません。");
  expect(await (await new WardBucket(env.ORIGINALS, ward.wardId).get(original.r2_path))?.text()).toBe(unreadableText);

  const checkCounts = (html: string, answered: number, attend: number, proxy: number, absent: number) => {
    for (const [count, label] of [[answered, "(?:返事のあった世帯|\\d+世帯のうち)"], [attend, "出席"], [proxy, "委任"], [absent, "欠席"]] as const) {
      expect(html).toMatch(new RegExp(`<b>${count}<small>世帯</small></b><span>${label}`));
    }
    expect(html).not.toContain("人数が読めません");
    expect(html).not.toContain("参加すると返事をした人数");
    expect(html).not.toContain("0<small>人");
  };
  checkCounts(await (await get(realApp, answersPath, cookie)).text(), 5, 1, 2, 2);
  expect((await postForm(realApp, `${root}/space/${id}/open`, { passphrase: fixture.passphrase }, cookie)).status).toBe(200);
  const entered = await postForm(realApp, `${space}/enter`, { passphrase: fixture.passphrase });
  const memberCookie = cookieFrom(entered, `space_${id}`);
  if (!memberCookie) throw new Error("実行委員の入口がありません。");
  const memberPage = await (await get(realApp, space, memberCookie)).text();
  checkCounts(memberPage, 5, 1, 2, 2);
  expect(memberPage).toContain(`委任（委任する相手：${fixture.firstOfficer}）`);
  expect(memberPage).toContain("委任（委任する相手：空欄）");
  expect(memberPage).toContain(`${fixture.district}: 返事のあった世帯3世帯 / 出席1世帯 / 委任2世帯 / 欠席0世帯`);
  const token = await createInvite(env.DB, ward.wardId, id, "leader", fixture.district, account.accountId, true);
  const leaderEntry = await get(realApp, `${space}/person/${token}`);
  const leaderCookie = cookieFrom(leaderEntry, `space_${id}`);
  if (!leaderCookie) throw new Error("班長の入口がありません。");
  const leaderPage = await (await get(realApp, space, leaderCookie)).text();
  checkCounts(leaderPage, 3, 1, 2, 0);
  expect(leaderPage).toContain(fixture.firstOfficer);
  expect(leaderPage).not.toContain(fixture.phoneHousehold);
  expect(await (await get(realApp, space)).text()).not.toContain(fixture.firstOfficer);

  // AIへの外部接続だけを止め、下書きを依頼する画面と保存した指示は本物を使う。
  const dispatch = vi.spyOn(session, "dispatchProject").mockResolvedValue("busy");
  try {
    expect((await postForm(realApp, `${close}/prepare`, {}, cookie)).status).toBe(303);
  } finally { dispatch.mockRestore(); }
  const instruction = await env.DB.prepare("SELECT instruction FROM jobs WHERE ward_id = ? AND project_id = ? AND task = 'report'")
    .bind(ward.wardId, id).first<string>("instruction");
  expect(instruction).toContain("返事のあった世帯5世帯 / 出席1世帯 / 委任2世帯 / 欠席2世帯");
  expect(instruction).toContain("当日の出席人数に置き換えず");
  expect(instruction).not.toContain(fixture.firstOfficer);
  const closing = await (await get(realApp, close, cookie)).text();
  expect(closing).not.toContain("人数が読めません");
  expect(closing).not.toContain("0<small>人");
  expect(closing).not.toContain('id="report-public"');
  expect(closing).toContain(`href="${root}/projects/${id}/draft/notice"`);
  // 住民への知らせは別に配り、議事録は閉じる画面の役員用の欄に残す。
  expect((await postForm(realApp, `${root}/projects/${id}/draft/notice/save`, {
    title: "総会のお知らせ", scope: "public", based_on: "0", text: fixture.reportText,
  }, cookie)).status).toBe(303);
  const notice = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM documents d
    JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = 'notice' ORDER BY v.version_no DESC LIMIT 1`)
    .bind(ward.wardId, id).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!notice) throw new Error("住民へ配る試しの知らせがありません。");
  expect((await postForm(realApp, `${root}/publish/${id}/send`, {
    documentId: notice.document_id, versionId: notice.version_id, versionNo: String(notice.version_no), lineDelivery: "skip",
  }, cookie)).status).toBe(303);
  const minutes = `${fixture.nextYearChange}\n委任する相手：${fixture.firstOfficer}`;
  const form = new FormData();
  form.append("body", "");
  form.append("body", minutes);
  expect((await realApp.request(`${close}/finalize`, {
    method: "POST", headers: { cookie, origin: "http://localhost" }, body: form,
  }, env)).status).toBe(303);
  const recordPage = await (await get(realApp, record, cookie)).text();
  checkCounts(recordPage, 5, 1, 2, 2);
  expect(recordPage).toContain(minutes);
  expect(recordPage).toContain(`委任（委任する相手：${fixture.firstOfficer}）`);
  expect(recordPage).not.toContain("参加0人");
  expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM publication_records r
    JOIN documents d ON d.ward_id = r.ward_id AND d.document_id = r.document_id
    WHERE r.ward_id = ? AND r.project_id = ? AND d.kind = 'report'`)
    .bind(ward.wardId, id).first<number>("n")).toBe(0);
  const publicPage = await (await get(realApp, `/${ward.slug}/p/${id}`)).text();
  expect(publicPage).toContain(fixture.reportText);
  expect(publicPage).not.toContain(minutes);
  expect(publicPage).not.toContain(fixture.firstOfficer);

  const event = await createProject(env.DB, ward.wardId, {
    kind: "event", title: fixture.draftTitle, year: fixture.eventYear, accountId: account.accountId,
  });
  await lineAnswer(event.projectId, `${fixture.firstHousehold}です。大人2人、子ども1人です。`);
  expect(await listAnswers(env.DB, ward.wardId, event.projectId)).toMatchObject([
    { peopleCount: 3, adultsCount: 2, childrenCount: 1, meetingStatus: null },
  ]);
  expect((await postForm(realApp, `${root}/close/${event.projectId}/finalize`, { body: fixture.reportText }, cookie)).status).toBe(303);
  expect(await (await get(realApp, `${root}/archive/${event.projectId}`, cookie)).text()).toContain("参加すると返事をした人数3人");
});
