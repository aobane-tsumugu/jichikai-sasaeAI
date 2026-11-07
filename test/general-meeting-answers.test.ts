import type Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { listAnswers, replaceRoster } from "../src/answers/api";
import { MEETING_NOTE_NAME } from "../src/answers/meeting";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { runRead, setPipelineDeps } from "../src/intake/pipeline";
import { getReadings } from "../src/intake/store";
import { saveDocument } from "../src/project/actions";
import { createProject } from "../src/project/api";
import { saveTemplates } from "../src/settings/store";
import { get, postForm, realApp } from "./helpers";

it("架空の総会の案内からWebで答え、読めた紙・手入力・読み取りの訂正を世帯の同じ数に入れる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "general_meeting", title: "総会（架空）", year: FIRST_SLICE.eventYear, accountId: account.accountId });
  const base = `/${ward.slug}`;
  const pub = `${base}/answer/${project.projectId}`;
  const admin = `${base}/admin/answers/${project.projectId}`;
  const district = FIRST_SLICE.district;
  // 名前は既存fixturesの架空の入力を使う。最後の世帯は未回答のまま残す。
  await replaceRoster(env.DB, ward.wardId, [FIRST_SLICE.firstHousehold, FIRST_SLICE.secondHousehold, FIRST_SLICE.phoneHousehold, FIRST_SLICE.rosterName]
    .map((household) => ({ household, district })), { household: 0, district: 1 });
  const note = "署名・押印については、案内の連絡先にお尋ねください。";
  await saveTemplates(env.DB, ward.wardId, [{ id: "meeting", name: MEETING_NOTE_NAME, body: note }], account.accountId);
  expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
    kind: "announcement", title: "総会の案内（架空）", scope: "public", basedOn: project.stateVersion,
    body: JSON.stringify({ text: "総会を開きます（架空）。", items: [{ key: "place", content: FIRST_SLICE.previousPlace }] }),
  })).toBe(true);
  const version = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM document_versions v
    JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id WHERE v.ward_id = ? AND v.project_id = ? AND d.kind = 'announcement'`)
    .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!version) throw new Error("架空の案内が保存されていません。");
  expect((await postForm(realApp, `${base}/admin/publish/${project.projectId}/send`, {
    documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no), lineDelivery: "skip",
  }, cookie)).status).toBe(303);
  const notice = await (await get(realApp, `${base}/p/${project.projectId}`)).text();
  expect(notice).toContain(pub);
  const first = await get(realApp, pub);
  expect(first.headers.get("Cache-Control")).toContain("no-store");
  const html = await first.text();
  expect(html).toContain(note);
  for (const label of ["出席する", "委任する", "欠席する"]) expect(html).toContain(label);
  expect(html).not.toContain('name="adults_count"');
  const submission = /name="submission_id" value="([^"]+)"/.exec(html)?.[1];
  if (!submission) throw new Error("架空のWeb回答の送信番号がありません。");
  const web = { household: FIRST_SLICE.firstHousehold, district, meeting_status: "proxy", proxy_name: "", submission_id: submission };
  const invalid = await postForm(realApp, pub, { ...web, meeting_status: "" });
  expect(invalid.status).toBe(400);
  expect(await invalid.text()).toContain(`value="${FIRST_SLICE.firstHousehold}"`);
  for (const response of await Promise.all([postForm(realApp, pub, web), postForm(realApp, pub, web)])) {
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("委任する相手：空欄");
  }
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toMatchObject([{ meetingStatus: "proxy", proxyName: "", childrenCount: null, adultsCount: null, seniorsCount: null }]);

  const paper = await (await get(realApp, `${base}/admin/print/${project.projectId}/${version.document_id}/${version.version_no}/announcement`, cookie)).text();
  for (const label of ["□出席", "□委任", "□欠席", "委任する相手", "代表者のお名前", "委任状", "ここで切り取る", note]) expect(paper).toContain(label);
  expect(paper).not.toContain("参加する人数");
  const preview = await (await get(realApp, `${base}/admin/print/${project.projectId}/${version.document_id}/${version.version_no}/preview`, cookie)).text();
  expect(preview).toContain("□委任");
  expect(preview).not.toContain("参加する人数");

  const received = await receive(env, {
    wardId: ward.wardId, projectId: project.projectId, via: "admin", readKind: "answer_sheet", accountId: account.accountId,
    parts: [{ kind: "photo", filename: FIRST_SLICE.answerSheetFilename, mediaType: "image/jpeg", bytes: new Uint8Array(FIRST_SLICE.answerSheetPhotoBytes) }],
  });
  if (!received.jobId || !received.received[0]) throw new Error("架空の回答票が受け付けられていません。");
  const originalId = received.received[0].originalId;
  // 読み取りの外部APIだけを架空の応答にする。受付、R2、D1、集計、画面は製品の経路を使う。
  setPipelineDeps({
    createClient: () => Object.create(null) as Anthropic,
    readImpl: async (_client, options) => {
      expect(options.generalMeeting).toBe(true);
      const row = { ...FIRST_SLICE.answerSheetReading.rows[0]!, original_id: originalId, adults: null, children: null, seniors: null,
        helper_names: [], helper_slots: [], proxy_name: "", ward_group: district };
      return { packVersion: "read-answer-sheet@7", model: "fixture", usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0 },
        body: { summary: "架空の総会の回答票", rows: [
          { ...row, household_name: FIRST_SLICE.secondHousehold, meeting_status: "attend", locator: "1枚目" },
          { ...row, household_name: FIRST_SLICE.rosterName, meeting_status: null, confidence: "low", locator: "2枚目", note: "出欠の印が読めませんでした" },
        ], unreadable: [{ original_id: originalId, locator: "2枚目", note: "出欠の印が読めませんでした" }] } };
    },
  });
  try {
    expect(await runRead(env, ward.wardId, received.jobId)).toBe("read");
  } finally { setPipelineDeps(null); }
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toHaveLength(2);
  const reading = await getReadings(env.DB, ward.wardId, received.jobId);
  expect(reading[0]?.body).toMatchObject({ rows: [expect.objectContaining({ meeting_status: "attend" }), expect.objectContaining({ meeting_status: null })] });
  const correction = await (await get(realApp, `${admin}?view=read`, cookie)).text();
  expect(correction).toContain("出欠の印が読めませんでした");
  expect(correction).toContain("まだ数に入れていません");
  expect(correction).not.toContain('name="adults_count"');
  const hand = { household: FIRST_SLICE.phoneHousehold, district, meeting_status: "absent", proxy_name: "" };
  expect(await (await get(realApp, `${admin}?view=hand`, cookie)).text()).toContain("委任する");
  expect((await postForm(realApp, `${admin}/phone`, hand, cookie)).status).toBe(303);
  const summary = await (await get(realApp, admin, cookie)).text();
  for (const label of ["世帯のうち", "出席", "委任", "欠席", "まだ返事のない世帯 1世帯", "出席と委任を合わせて2世帯です"]) expect(summary).toContain(label);
  expect(summary).toMatch(/<b>3<small>世帯<\/small><\/b><span>\d+世帯のうち/);
  for (const label of ["出席", "委任", "欠席"]) expect(summary).toMatch(new RegExp(`<b>1<small>世帯</small></b><span>${label}`));
  expect(summary).not.toContain("成立");

  const rowPath = `${admin}/sheet/${originalId}/row/1`;
  const fixed = { household: FIRST_SLICE.rosterName, district, meeting_status: "proxy", proxy_name: FIRST_SLICE.firstOfficer };
  expect((await postForm(realApp, rowPath, fixed, cookie)).status).toBe(303);
  expect((await postForm(realApp, rowPath, fixed, cookie)).status).toBe(303);
  const answers = await listAnswers(env.DB, ward.wardId, project.projectId);
  expect(answers).toHaveLength(4);
  expect(answers.filter((answer) => answer.meetingStatus === "proxy")).toHaveLength(2);
  const fromWeb = answers.find((answer) => answer.source === "web");
  if (!fromWeb) throw new Error("架空のWeb回答がありません。");
  const editPath = `${admin}/${fromWeb.answerId}/edit`;
  const edit = await (await get(realApp, editPath, cookie)).text();
  expect(edit).toContain("委任する");
  expect(edit).not.toContain('name="adults_count"');
  expect((await postForm(realApp, editPath, { ...web, meeting_status: "attend" }, cookie)).status).toBe(303);
  expect((await postForm(realApp, pub, web)).status).toBe(200);
  expect((await listAnswers(env.DB, ward.wardId, project.projectId)).find((answer) => answer.answerId === fromWeb.answerId)).toMatchObject({ meetingStatus: "attend", proxyName: "" });
  expect(await (await get(realApp, `${admin}?view=unanswered`, cookie)).text()).toContain("まだ返事のない世帯はありません。");
});
