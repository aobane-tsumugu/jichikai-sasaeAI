import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { ROTA_REVIEW_FIXTURE as fixture } from "./fixtures/rota";
import { addAnswer, getRoster, listAnswers, replaceRoster, unansweredRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { saveCommitteeRow, saveDocument } from "../src/project/actions";
import { applyChange, createProject, getProjectState } from "../src/project/api";
import { createInvite } from "../src/space/api";
import { activityFacts } from "../src/ward/activity";
import { cookieFrom, get, postForm, realApp } from "./helpers";

it("架空の初年度の名簿から始め、翌年は残る担当を保ち、同じ答えの数と配った名簿を画面と紙で読む", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const roster = [fixture.first, fixture.exempt, fixture.removed, fixture.fourth]
    .map((household) => ({ household, district: fixture.district }));
  await replaceRoster(env.DB, ward.wardId, roster, { household: 0, district: 1 });
  const previous = await createProject(env.DB, ward.wardId, {
    kind: "duty", title: fixture.title, year: 2025, accountId: account.accountId,
  });
  const previousDraft = `${root}/projects/${previous.projectId}/draft/duty_roster`;
  expect(await (await get(realApp, previousDraft, cookie)).text()).toContain("名簿の順です");
  expect((await postForm(realApp, `${previousDraft}/start`, {}, cookie)).headers.get("location")).toContain("notice=saved");
  const initial = await getProjectState(env.DB, ward.wardId, previous.projectId);
  if (!initial) throw new Error("架空の初年度の当番がありません。");
  const initialRows = initial.tables.duties.filter((row) => row.scope === "current");
  expect(initialRows.map((row) => row.data.assignee)).toEqual((await getRoster(env.DB, ward.wardId)).map((entry) => entry.household));
  expect(initialRows).toHaveLength(4);
  // 役員が直した去年の表。一つの欄に複数の名前があり、ほかの欄は班・団体・人数。
  const assignments = [`${fixture.first}、${fixture.exempt}、${fixture.removed}`, ...fixture.groups];
  for (const [index, row] of initialRows.entries()) {
    expect((await postForm(realApp, `${root}/projects/${previous.projectId}/draft/duty-row/${row.rowId}`, {
      slot: fixture.slots[index]!, task: fixture.task, assignee: assignments[index]!, attendance: "no_change",
    }, cookie)).headers.get("location")).toContain("notice=saved");
  }
  await env.DB.prepare("UPDATE projects SET closed_at = ? WHERE ward_id = ? AND project_id = ?")
    .bind("2025-12-31T00:00:00.000Z", ward.wardId, previous.projectId).run();
  await replaceRoster(env.DB, ward.wardId, roster.slice(0, 2), { household: 0, district: 1 });
  const project = await createProject(env.DB, ward.wardId, {
    kind: "duty", title: fixture.title, year: 2026, eventDay: "2026-11-08", seedProjectId: previous.projectId, accountId: account.accountId,
  });
  const id = project.projectId;
  const draft = `${root}/projects/${id}/draft/duty_roster`;
  expect((await postForm(realApp, `${root}/rota/exemptions`, {
    household: JSON.stringify(roster[1]), reason: FIRST_SLICE.reportText, starts_on: "2026-01-01", ends_on: "2026-12-31",
  }, cookie)).headers.get("location")).toContain("saved=1");
  expect((await postForm(realApp, `${draft}/start`, {}, cookie)).headers.get("location")).toContain("notice=saved");
  let state = await getProjectState(env.DB, ward.wardId, id);
  if (!state) throw new Error("架空の翌年の当番がありません。");
  const current = state.tables.duties.filter((row) => row.scope === "current");
  expect(current.map((row) => row.data.assignee)).toEqual([fixture.first, ...fixture.groups]);
  for (const row of current) {
    expect((await postForm(realApp, `${root}/projects/${id}/draft/duty-row/${row.rowId}`, {
      slot: String(row.data.slot), task: fixture.task, assignee: String(row.data.assignee), attendance: "present",
    }, cookie)).headers.get("location")).toContain("notice=saved");
  }
  const source = { kind: "person" as const, accountId: account.accountId };
  expect((await applyChange(env.DB, ward.wardId, id, {
    kind: "row", table: "duties", data: { slot: "夜", task: fixture.task, assignee: `${fixture.first}、${fixture.groups[1]}`, attendance: "present" },
    source, confidence: "high", packVersion: "rota-review-fictional@1",
  })).status).toBe("applied");
  const facts = await activityFacts(env.DB, ward.wardId, id);
  expect(facts.facts).toEqual([
    `${fixture.task}は午前の1人（当番表の担当）`, "手伝った人は1人（当番表で出席が記録された人）",
  ]);
  expect((await applyChange(env.DB, ward.wardId, id, {
    kind: "row", table: "committee", data: { name: fixture.exempt, role: fixture.committeeRole, contact: fixture.contact },
    source, confidence: "high", packVersion: "rota-review-fictional@1",
  })).status).toBe("applied");
  state = await getProjectState(env.DB, ward.wardId, id);
  if (!state) throw new Error("架空の下書きがありません。");
  expect(await saveDocument(env.DB, ward.wardId, id, account.accountId, {
    kind: "duty_roster", scope: "space", title: FIRST_SLICE.dutyTitle, basedOn: state.project.stateVersion,
    body: JSON.stringify({ text: FIRST_SLICE.dutyText, items: [] }),
  })).toBe(true);
  const version = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
    WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1`).bind(ward.wardId, id)
    .first<{ document_id: string; version_id: string; version_no: number }>();
  if (!version) throw new Error("架空の当番表の下書きがありません。");
  const paper = `${root}/print/${id}/${version.document_id}/${version.version_no}`;
  const preview = await get(realApp, `${paper}/preview`, cookie);
  expect(preview.status).toBe(200);
  const paperHtml = await preview.text();
  for (const text of [fixture.first, fixture.exempt, fixture.committeeRole, fixture.contact, ...fixture.groups]) expect(paperHtml).toContain(text);
  const confirm = await get(realApp, `${root}/publish/${id}/confirm?kind=duty_roster`, cookie);
  expect(confirm.status).toBe(200);
  const confirmHtml = await confirm.text();
  expect(confirmHtml.split(fixture.contact)).toHaveLength(3);
  expect((await postForm(realApp, `${root}/publish/${id}/space`, {
    documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no),
  }, cookie)).status).toBe(303);
  const committee = state.tables.committee.find((row) => row.scope === "current");
  if (!committee) throw new Error("架空の実行委員がありません。");
  expect(await saveCommitteeRow(env.DB, ward.wardId, id, committee.rowId, account.accountId, {
    name: fixture.fourth, role: fixture.committeeRole, contact: fixture.contact,
  })).toBe(true);
  const printed = await get(realApp, `${paper}/duty`, cookie);
  expect(printed.status).toBe(200);
  const printedHtml = await printed.text();
  expect(printedHtml).toContain(fixture.exempt);
  expect(printedHtml).not.toContain(fixture.fourth);
  // 配り直す前の紙の見え方は今の下書き。配った紙とは分ける。
  const nextPreview = await get(realApp, `${paper}/preview`, cookie);
  expect(nextPreview.status).toBe(200);
  const nextHtml = await nextPreview.text();
  expect(nextHtml).toContain(fixture.fourth);
  expect(nextHtml).not.toContain(fixture.exempt);
  // 同じ班の同名世帯と別の班の同名世帯。別に届いた答えは残し、同じ回答票の読み直しだけ更新する。
  const sameNames = [fixture.district, fixture.district, fixture.otherDistrict].map((district) => ({ district, household: fixture.first }));
  await replaceRoster(env.DB, ward.wardId, sameNames, { household: 0, district: 1 });
  for (const entry of sameNames.slice(0, 2)) await addAnswer(env.DB, ward.wardId, { ...entry, projectId: id, peopleCount: 1, source: "web" });
  const sheet = { ...sameNames[2]!, projectId: id, peopleCount: 1, source: "sheet" as const, originalId: "fictional-u53-answer", sheetRowIndex: 0 };
  const answerId = await addAnswer(env.DB, ward.wardId, sheet);
  expect(await addAnswer(env.DB, ward.wardId, { ...sheet, peopleCount: 2 })).toBe(answerId);
  const answers = await listAnswers(env.DB, ward.wardId, id);
  expect(answers).toHaveLength(3);
  expect(unansweredRoster(sameNames, answers)).toHaveLength(0);
  expect((await postForm(realApp, `${root}/space/${id}/open`, { passphrase: FIRST_SLICE.passphrase }, cookie)).status).toBe(200);
  const space = `/${ward.slug}/space/${id}`;
  const token = await createInvite(env.DB, ward.wardId, id, "member", null, account.accountId, true);
  const entered = await get(realApp, `${space}/person/${token}`);
  const memberCookie = cookieFrom(entered, `space_${id}`);
  if (!memberCookie) throw new Error("架空の実行委員の入口に入れません。");
  const memberHtml = await (await get(realApp, space, memberCookie)).text();
  const officerHtml = await (await get(realApp, `${root}/answers/${id}`, cookie)).text();
  for (const html of [memberHtml, officerHtml]) expect(html).toContain("<b>3<small>世帯</small></b>");
  expect(memberHtml).toContain("答えた世帯の一覧（3世帯）");
  expect(memberHtml).toContain("<b>4<small>人</small></b>");
  expect(memberHtml).toContain(fixture.exempt);
  expect(memberHtml).not.toContain(fixture.fourth);
});
