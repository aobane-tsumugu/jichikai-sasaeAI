import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { addAnswer, getAnswerTotals, listAnswers, listUnansweredByDistrict, replaceRoster } from "../src/answers/api";
import { getSpaceMaterials } from "../src/space/api";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { createProject, type DocumentKind } from "../src/project/api";
import { DEFAULT_ANSWER_LABELS } from "../src/settings/answer-labels";
import { get, postForm, realApp } from "./helpers";

it("名簿のない初年度から人数を答え、班と古い答えを保ち、新しい知らせを読んで手伝いを申し込む", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-10-01T03:00:00Z"));
  try {
    const { ward, account, cookie } = await seedAdmin(env.DB);
    const project = await createProject(env.DB, ward.wardId, {
      kind: "event", title: FIRST_SLICE.nextYearTitle, year: FIRST_SLICE.nextYear, accountId: account.accountId,
    });
    const base = `/${ward.slug}`;
    const answerPath = `${base}/answer/${project.projectId}`;
    const answersPath = `${base}/admin/answers/${project.projectId}`;
    const noticePath = `${base}/p/${project.projectId}`;
    const publish = async (kind: DocumentKind, text: string, items: { key: string; content: string }[]) => {
      expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
        kind, title: kind === "announcement" ? "案内" : kind === "notice" ? "知らせ" : "手伝いの募集",
        scope: "public", basedOn: project.stateVersion, body: JSON.stringify({ text, items }),
      })).toBe(true);
      const version = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM document_versions v
        JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
        WHERE v.ward_id = ? AND v.project_id = ? AND d.kind = ? ORDER BY v.version_no DESC LIMIT 1`)
        .bind(ward.wardId, project.projectId, kind).first<{ document_id: string; version_id: string; version_no: number }>();
      if (!version) throw new Error("配るものがありません。");
      expect((await postForm(realApp, `${base}/admin/publish/${project.projectId}/send`, {
        documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no), lineDelivery: "skip",
      }, cookie)).status).toBe(303);
      vi.setSystemTime(new Date(Date.now() + 1000));
      return version;
    };
    const initial = await (await get(realApp, answerPath)).text();
    expect(initial).toContain("分からない");
    expect(initial).toContain("代表者のお名前");
    const version = await publish("announcement", FIRST_SLICE.publicAnnouncement, [
      { key: "date_time", content: FIRST_SLICE.eventDay }, { key: "place", content: FIRST_SLICE.previousPlace },
      { key: "public_contact", content: FIRST_SLICE.firstOfficer },
    ]);
    const paperPath = `${base}/admin/print/${project.projectId}/${version.document_id}/${version.version_no}/answer`;
    const paperBefore = await (await get(realApp, paperPath, cookie)).text();
    for (const label of DEFAULT_ANSWER_LABELS) expect(paperBefore).toContain(label);
    expect(paperBefore).toContain("代表者のお名前");
    const counts = { children_count: "1", adults_count: "2", seniors_count: "1" };
    const invalid = await postForm(realApp, answerPath, { ...counts, household: "", district: "" });
    expect(invalid.status).toBe(400);
    const invalidHtml = await invalid.text();
    expect(invalidHtml).toContain("お名前が入っていません");
    expect(invalidHtml).toContain('name="seniors_count" type="number" min="0" max="1000" inputmode="numeric" value="1"');
    const sent = await postForm(realApp, answerPath, { ...counts, household: FIRST_SLICE.firstHousehold, district: "" });
    expect(sent.status).toBe(200);
    const receipt = await sent.text();
    expect(receipt).toContain("答えを受け付けました");
    expect(receipt).toContain(FIRST_SLICE.previousPlace);
    expect(receipt).toContain(FIRST_SLICE.firstOfficer);
    expect(receipt).toContain("もう一度送らず");
    expect((await postForm(realApp, answerPath, { ...counts, household: FIRST_SLICE.firstHousehold, district: "" })).status).toBe(200);
    await addAnswer(env.DB, ward.wardId, { projectId: project.projectId, household: FIRST_SLICE.phoneHousehold, district: "", peopleCount: 5, source: "phone" });
    const legacy = (await listAnswers(env.DB, ward.wardId, project.projectId)).find((answer) => answer.source === "phone");
    expect(legacy).toMatchObject({ peopleCount: 5, childrenCount: null, adultsCount: null, seniorsCount: null });
    if (!legacy) throw new Error("古い形の答えがありません。");
    expect(await (await get(realApp, `${answersPath}/${legacy.answerId}/edit`, cookie)).text()).toContain('name="people_count"');
    expect(await getAnswerTotals(env.DB, ward.wardId, project.projectId)).toEqual({ people: 13, helperRequests: 0 });
    const page = await (await get(realApp, `${answersPath}?view=list`, cookie)).text();
    expect(page).toContain("班が分からない 3世帯");
    expect(await (await get(realApp, answersPath, cookie)).text()).toContain("名簿はまだありません");
    const zero = await postForm(realApp, answerPath, { household: FIRST_SLICE.secondHousehold, district: "", children_count: "", adults_count: "", seniors_count: "" });
    expect(zero.status).toBe(200);
    expect(await zero.text()).not.toContain("次は");
    await replaceRoster(env.DB, ward.wardId, [
      { household: FIRST_SLICE.firstHousehold, district: FIRST_SLICE.district },
      { household: FIRST_SLICE.secondHousehold, district: FIRST_SLICE.district },
      { household: FIRST_SLICE.secondHousehold, district: `第二${FIRST_SLICE.district}` },
    ], { household: 0, district: 1 });
    expect(await listUnansweredByDistrict(env.DB, ward.wardId, project.projectId)).toEqual(expect.arrayContaining([
      { district: FIRST_SLICE.district, households: [FIRST_SLICE.secondHousehold] },
      { district: `第二${FIRST_SLICE.district}`, households: [FIRST_SLICE.secondHousehold] },
    ]));
    const qrPath = `${base}/q/${project.projectId}/${version.document_id}/${version.version_no}`;
    expect((await get(realApp, `${qrPath}?s=${encodeURIComponent(FIRST_SLICE.district)}`)).headers.get("location"))
      .toBe(`${noticePath}?s=${encodeURIComponent(FIRST_SLICE.district)}`);
    expect((await get(realApp, `${qrPath}?s=unknown`)).headers.get("location")).toBe(noticePath);
    const noticeHtml = await (await get(realApp, `${noticePath}?s=${encodeURIComponent(FIRST_SLICE.district)}`)).text();
    expect(noticeHtml).toContain(`${answerPath}?s=${encodeURIComponent(FIRST_SLICE.district)}`);
    expect(noticeHtml).toContain(`${FIRST_SLICE.nextYearTitle}のご案内`);
    expect(await (await get(realApp, `${answerPath}?s=${encodeURIComponent(FIRST_SLICE.district)}`)).text()).toContain("班が違うときは選び直す");
    expect((await getSpaceMaterials(env.DB, ward.wardId, project.projectId, FIRST_SLICE.district)).attendance).toHaveLength(0);
    expect((await getSpaceMaterials(env.DB, ward.wardId, project.projectId, null)).attendance).toHaveLength(4);
    const first = (await listAnswers(env.DB, ward.wardId, project.projectId))[0]!;
    expect((await postForm(realApp, `${answersPath}/${first.answerId}/edit`, { household: first.household, district: FIRST_SLICE.district, ...counts }, cookie)).status).toBe(303);
    expect((await getSpaceMaterials(env.DB, ward.wardId, project.projectId, FIRST_SLICE.district)).attendance).toHaveLength(1);
    expect((await postForm(realApp, `${base}/admin/settings/info`, {
      squads: FIRST_SLICE.district, contact: FIRST_SLICE.firstOfficer,
      answer_label_0: "子ども", answer_label_1: "大人", answer_label_2: "高齢の方",
    }, cookie)).status).toBe(303);
    const oldPaper = await (await get(realApp, paperPath, cookie)).text();
    for (const label of DEFAULT_ANSWER_LABELS) expect(oldPaper).toContain(label);
    expect(await (await get(realApp, answerPath)).text()).toContain(DEFAULT_ANSWER_LABELS[2]);
    await publish("announcement", FIRST_SLICE.publicAnnouncement, [
      { key: "date_time", content: FIRST_SLICE.eventDay }, { key: "place", content: FIRST_SLICE.previousPlace },
    ]);
    expect(await (await get(realApp, answerPath)).text()).not.toContain(DEFAULT_ANSWER_LABELS[2]);
    await publish("recruitment", FIRST_SLICE.draftText, [{ key: "helper_slots", content: FIRST_SLICE.helperTime }]);
    await publish("notice", FIRST_SLICE.rainAnnouncement, [{ key: "place", content: FIRST_SLICE.layoutPosition }]);
    const helpPath = `${base}/help/${project.projectId}`;
    expect((await get(realApp, `${base}/help`)).headers.get("location")).toBe(helpPath);
    const help = await (await get(realApp, helpPath)).text();
    expect(help.indexOf("新しいお知らせを読んでください")).toBeLessThan(help.indexOf(FIRST_SLICE.draftText));
    const rainPage = await (await get(realApp, noticePath)).text();
    expect(rainPage.indexOf(FIRST_SLICE.rainAnnouncement)).toBeLessThan(rainPage.indexOf("に配った案内"));
    const offered = await postForm(realApp, helpPath, { helper_name: FIRST_SLICE.sheetHelper, helper_times: FIRST_SLICE.helperTime });
    expect(offered.status).toBe(200);
    const offeredHtml = await offered.text();
    expect(offeredHtml).toContain("申し込みを受け付けました");
    expect(offeredHtml).toContain(FIRST_SLICE.helperTime);
    expect(offeredHtml).toContain(FIRST_SLICE.layoutPosition);
    expect(offeredHtml).toContain(FIRST_SLICE.firstOfficer);
    expect((await postForm(realApp, `${answersPath}/deadline`, { due_on: "2027-09-30" }, cookie)).status).toBe(303);
    const closed = await (await get(realApp, noticePath)).text();
    expect(closed).toContain("答えの受付は終わりました");
    expect(closed).not.toContain("参加する人数を答える");
  } finally {
    vi.useRealTimers();
  }
});
