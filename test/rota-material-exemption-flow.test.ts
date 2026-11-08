import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { callTool } from "../src/ai/mcp";
import { replaceRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { sha256Hex } from "../src/intake/media";
import { receive } from "../src/intake/receive";
import { applyChange, createProject, getProjectState } from "../src/project/api";
import { exemptions } from "../src/rota/store";
import { createInvite } from "../src/space/api";
import { MATERIAL_EXEMPTION_FIXTURE as material, ROTA_REVIEW_FIXTURE as fixture } from "./fixtures/rota";
import { cookieFrom, get, postForm, realApp } from "./helpers";

it("架空の免除資料から一問だけ出し、答えるまでは担当を保ち、理由を直して答えると今年だけ外して理由を配らない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  await replaceRoster(env.DB, ward.wardId, [fixture.first, fixture.exempt]
    .map((household) => ({ household, district: fixture.district })), { household: 0, district: 1 });
  const project = await createProject(env.DB, ward.wardId, {
    kind: "duty", title: fixture.title, year: 2026, accountId: account.accountId,
  });
  const id = project.projectId;
  const draft = `${root}/projects/${id}/draft/duty_roster`;
  const questions = `${root}/projects/${id}/questions`;
  expect((await postForm(realApp, `${draft}/start`, {}, cookie)).headers.get("location")).toContain("notice=saved");
  const state = async () => {
    const value = await getProjectState(env.DB, ward.wardId, id);
    if (!value) throw new Error("架空の当番がありません。");
    return value;
  };
  const before = (await state()).tables.duties.filter((row) => row.scope === "current");
  const exemptRow = before.find((row) => row.data.assignee === fixture.exempt);
  if (!exemptRow) throw new Error("架空の対象者の担当がありません。");
  // 実際の受付で文字の資料を受け、同じ読み取りとMCPの書き込みを使う。AIの接続判断だけを模す。
  const input = await receive(env, {
    wardId: ward.wardId, projectId: id, via: "admin", accountId: account.accountId,
    parts: [{ kind: "text", filename: material.filename, mediaType: "text/plain", bytes: new TextEncoder().encode(material.text) }],
  });
  const originalId = input.received[0]?.originalId;
  if (!input.jobId || !originalId) throw new Error("架空の免除資料を送れませんでした。");
  const ticket = `tk_${crypto.randomUUID()}`;
  await env.DB.prepare("UPDATE jobs SET status = 'connecting', ticket_hash = ? WHERE ward_id = ? AND job_id = ?")
    .bind(await sha256Hex(ticket), ward.wardId, input.jobId).run();
  const reading = await callTool(env, ward.wardId, "get_reading", { ticket });
  expect(reading.isError).toBeUndefined();
  expect(reading.content[0]?.text).toContain(material.sentence);
  const args = { ticket, original_id: originalId, locator: "段落2", kind: "decision", confidence: "high", data: { what: material.sentence } };
  const connected = await callTool(env, ward.wardId, "write_change", args);
  expect(connected.isError).toBeUndefined();
  expect(JSON.parse(connected.content[0]?.text ?? "null")).toMatchObject({ status: "held" });
  await callTool(env, ward.wardId, "write_change", args);
  let current = await state();
  expect(current.questions).toHaveLength(1);
  expect(current.tables.decisions).toHaveLength(0);
  expect(await exemptions(env.DB, ward.wardId)).toHaveLength(0);
  expect(current.tables.duties.find((row) => row.rowId === exemptRow.rowId)?.data.assignee).toBe(fixture.exempt);
  const question = current.questions[0]!;
  const action = `${questions}/${question.questionId}/exemption`;
  const html = await (await get(realApp, questions, cookie)).text();
  expect(html).toContain(`${fixture.exempt}さんを今年の当番から外しますか`);
  expect(html).toContain(material.sentence);
  expect(html).toContain(`action="${action}"`);
  expect(html).toContain('name="reason"');
  expect(html).not.toContain('name="starts_on"');
  expect(html).not.toContain('name="ends_on"');
  expect((await postForm(realApp, action, { action: "later" }, cookie)).headers.get("location")).toContain("notice=later");
  expect((await postForm(realApp, `${draft}/start`, {}, cookie)).headers.get("location")).toContain("notice=saved");
  expect((await state()).tables.duties.find((row) => row.rowId === exemptRow.rowId)?.data.assignee).toBe(fixture.exempt);
  expect(await exemptions(env.DB, ward.wardId)).toHaveLength(0);
  expect((await postForm(realApp, action, { action: "今年の当番から外す", reason: material.editedReason }, cookie))
    .headers.get("location")).toContain("notice=exempted");
  expect(await exemptions(env.DB, ward.wardId)).toMatchObject([{
    household: fixture.exempt, district: fixture.district, reason: material.editedReason,
    starts_on: "2026-01-01", ends_on: "2026-12-31",
  }]);
  current = await state();
  expect(current.questions).toHaveLength(0);
  expect(current.tables.decisions).toHaveLength(0);
  expect(current.tables.duties.find((row) => row.rowId === exemptRow.rowId)?.data.assignee).toBe("");
  expect(current.tables.duties.some((row) => row.data.assignee === fixture.first)).toBe(true);
  // 同じ答えを送り直しても、免除を二重に作らない。
  expect((await postForm(realApp, action, { action: "今年の当番から外す", reason: material.editedReason }, cookie))
    .headers.get("location")).toContain("error=exemption_answer_failed");
  expect(await exemptions(env.DB, ward.wardId)).toHaveLength(1);
  const officer = await (await get(realApp, `${root}/rota/exemptions`, cookie)).text();
  expect(officer).toContain(material.editedReason);
  expect(officer).toContain("この免除を取り消す");
  expect((await postForm(realApp, `${draft}/save`, {
    title: FIRST_SLICE.dutyTitle, scope: "space", text: FIRST_SLICE.dutyText, based_on: String(current.project.stateVersion),
  }, cookie)).headers.get("location")).toContain("notice=saved");
  const document = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
    WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1`).bind(ward.wardId, id)
    .first<{ document_id: string; version_id: string; version_no: number }>();
  if (!document) throw new Error("架空の当番表の下書きがありません。");
  expect((await postForm(realApp, `${root}/publish/${id}/space`, {
    documentId: document.document_id, versionId: document.version_id, versionNo: String(document.version_no),
  }, cookie)).status).toBe(303);
  expect((await postForm(realApp, `${root}/space/${id}/open`, { passphrase: FIRST_SLICE.passphrase }, cookie)).status).toBe(200);
  const invite = await createInvite(env.DB, ward.wardId, id, "member", null, account.accountId, true);
  const entered = await get(realApp, `/${ward.slug}/space/${id}/person/${invite}`);
  const memberCookie = cookieFrom(entered, `space_${id}`);
  if (!memberCookie) throw new Error("架空の実行委員のページに入れません。");
  for (const page of [await (await get(realApp, `/${ward.slug}/space/${id}`, memberCookie)).text(),
    await (await get(realApp, `/${ward.slug}/`)).text(),
    await (await get(realApp, `${root}/print/${id}/${document.document_id}/${document.version_no}/preview`, cookie)).text()]) {
    expect(page).not.toContain(material.sentence);
    expect(page).not.toContain(material.editedReason);
    expect(page).not.toContain("免除");
  }
});

it("架空の通年の当番で今年の免除を答えると、翌年1月から3月も対象の世帯を割り当てない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  await replaceRoster(env.DB, ward.wardId, [fixture.first, fixture.exempt]
    .map((household) => ({ household, district: fixture.district })), { household: 0, district: 1 });
  const project = await createProject(env.DB, ward.wardId, {
    kind: "duty", title: "架空の通年のごみ当番", year: 2026, accountId: account.accountId,
  });
  const root = `/${ward.slug}/admin`;
  expect((await postForm(realApp, `${root}/rota/${project.projectId}/weekly`, { weekday: "1" }, cookie)).status).toBe(303);
  // 架空の資料の免除を読み取った変更から、役員への質問を作る。
  expect((await applyChange(env.DB, ward.wardId, project.projectId, {
    kind: "row", table: "decisions", data: { what: material.sentence },
    source: { kind: "original", ref: "fictional-annual-exemption", locator: "架空の引き継ぎメモ", year: 2026 },
    confidence: "high", packVersion: "rota-annual-exemption-fictional@1",
  })).status).toBe("held");
  const before = await getProjectState(env.DB, ward.wardId, project.projectId);
  const question = before?.questions.find((entry) => entry.target?.startsWith("rota_exemption:"));
  if (!question) throw new Error("架空の免除の質問がありません。");
  expect((await postForm(realApp, `${root}/projects/${project.projectId}/questions/${question.questionId}/exemption`, {
    action: "今年の当番から外す", reason: material.editedReason,
  }, cookie)).headers.get("location")).toContain("notice=exempted");

  const state = await getProjectState(env.DB, ward.wardId, project.projectId);
  const duties = state?.tables.duties.filter((row) => row.scope === "current") ?? [];
  expect(duties).toHaveLength(52);
  expect(duties.some((row) => String(row.data.slot).startsWith("2027-"))).toBe(true);
  expect(duties.every((row) => row.data.assignee === fixture.first)).toBe(true);
  expect(await exemptions(env.DB, ward.wardId)).toMatchObject([{
    household: fixture.exempt, starts_on: "2026-04-01", ends_on: "2027-03-31",
  }]);
});
