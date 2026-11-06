import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import * as session from "../src/ai/session";
import { READ_PACK_VERSION, type Reading } from "../src/ai/schema";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { readDraftMaterials } from "../src/draft/materials";
import { applyChange, createProject, getProjectState, addQuestion } from "../src/project/api";
import { saveAIDraft, saveDocument } from "../src/project/actions";
import { getDraftPack } from "../src/draft/packs";
import { get, postForm, realApp } from "./helpers";

// fixturesの架空資料を使う。AIの外部起動と読み取りの応答だけを置き換える。
it("役員会を2回閉じ、前回の決定と未決、年の決定と運営メモと報告を総会から翌年へ残す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const read = async (path: string) => {
    const response = await get(realApp, `${root}${path}`, cookie);
    expect(response.status).toBe(200);
    return response.text();
  };
  const closeMeeting = async (projectId: string, decision: string) => {
    const body = new URLSearchParams();
    body.append("body", "");
    body.append("body", fixture.reportText);
    body.set("decisions", decision);
    const response = await realApp.request(`${root}/close/${projectId}/finalize`, {
      method: "POST", headers: { cookie, origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" }, body,
    }, env);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).not.toContain("error=");
  };
  const startAgenda = async (projectId: string) => {
    const dispatch = vi.spyOn(session, "dispatchProject").mockResolvedValue("busy");
    try {
      const ctx = createExecutionContext();
      const response = await realApp.fetch(new Request(`http://localhost${root}/projects/${projectId}/draft/procedure/start`, {
        method: "POST", headers: { cookie, origin: "http://localhost" }, body: new URLSearchParams({ instruction: "" }),
      }), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(response.headers.get("location")).toContain("notice=started");
      return await env.DB.prepare("SELECT instruction FROM jobs WHERE ward_id = ? AND project_id = ? AND task = 'draft' ORDER BY created_at DESC LIMIT 1")
        .bind(ward.wardId, projectId).first<string>("instruction");
    } finally { dispatch.mockRestore(); }
  };

  for (const [index, decision] of [fixture.publicAnnouncement, fixture.rainAnnouncement].entries()) {
    const project = await createProject(env.DB, ward.wardId, { kind: "board_meeting", title: `${fixture.draftTitle}${index + 1}`,
      year: fixture.eventYear, eventDay: `${fixture.eventYear}-0${index + 1}-10`, accountId: account.accountId });
    const agenda = await read(`/projects/${project.projectId}/draft/procedure`);
    if (index === 0) expect(agenda).toContain("記録はまだありません");
    else {
      expect(agenda).toContain(fixture.publicAnnouncement);
      expect(agenda).toContain(fixture.nextYearTask);
      expect(agenda).toContain(fixture.reportText);
      expect(await startAgenda(project.projectId)).toContain(fixture.publicAnnouncement);
    }
    // modelの読み取りは写真・PDFに対応する。文字資料では元の資料の年がこの読み取りに引き継がれない。
    const input = await receive(env, { wardId: ward.wardId, projectId: project.projectId, via: "admin", accountId: account.accountId,
      parts: [{ kind: "photo", filename: `${fixture.draftTitle}${index + 1}.jpg`, mediaType: "image/jpeg",
        bytes: new Uint8Array([...fixture.answerSheetPhotoBytes, index]) }] });
    const originalId = input.received[0]?.originalId;
    if (!originalId || !input.jobId) throw new Error("架空の議事の資料を受け付けられませんでした");
    expect(input.needsModelRead).toBe(true);
    const reading: Reading = {
      document_kind: "memo", summary: fixture.draftTitle,
      original_years: [{ original_id: originalId, year: fixture.eventYear }],
      text_blocks: [{ original_id: originalId, locator: fixture.previousLocator, text: `${fixture.eventYear}年\n${decision}` }],
      fields: [], tables: [],
      decisions: [{ text: decision, confidence: "high", original_id: originalId, locator: fixture.previousLocator }],
      unreadable: [],
    };
    await env.DB.prepare(`INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at)
      VALUES (?, ?, ?, 'model', ?, 'fictional-model', ?, ?)`)
      .bind(crypto.randomUUID(), ward.wardId, input.jobId, READ_PACK_VERSION.general, JSON.stringify(reading), new Date().toISOString()).run();
    expect(await readDraftMaterials(env.DB, ward.wardId, project.projectId)).toEqual([{
      original_years: reading.original_years, text_blocks: reading.text_blocks, fields: reading.fields,
      tables: reading.tables, decisions: reading.decisions, unreadable: reading.unreadable,
    }]);
    expect((await applyChange(env.DB, ward.wardId, project.projectId, { kind: "row", table: "decisions", data: { what: fixture.draftText },
      source: { kind: "ai_proposal", year: fixture.eventYear }, confidence: "low", packVersion: "fictional-proposal@1", requestId: crypto.randomUUID() })).status).toBe("applied");
    expect((await addQuestion(env.DB, ward.wardId, project.projectId, { kind: "decide", text: fixture.nextYearTask,
      source: { kind: "person", accountId: account.accountId }, packVersion: "fictional-question@1", requestId: crypto.randomUUID() })).status).toBe("added");
    expect(await saveAIDraft(env.DB, ward.wardId, project.projectId, "report", getDraftPack("report", "board_meeting").version, {
      title: "議事録", scope: "staff", text: fixture.reportText, items: [{ key: "content", content: fixture.reportText }],
    })).toBe(true);
    const closing = await read(`/close/${project.projectId}`);
    expect(closing).toContain("AIが資料から拾った下書き");
    expect(closing).toContain(decision);
    expect(closing).toContain(fixture.reportText);
    const beforeClose = await getProjectState(env.DB, ward.wardId, project.projectId);
    expect(beforeClose?.tables.decisions).toHaveLength(1);
    expect(beforeClose?.tables.decisions[0]?.source.kind).toBe("ai_proposal");
    // 役員が不要な下書きを消し、決めた内容だけを残す。閉じる前に決定として保存されない。
    await closeMeeting(project.projectId, decision);
    await closeMeeting(project.projectId, decision);
    const state = await getProjectState(env.DB, ward.wardId, project.projectId);
    expect(state?.project.closedAt).toBeTruthy();
    expect(state?.tables.decisions).toHaveLength(1);
    expect(state?.tables.decisions[0]).toMatchObject({ data: { what: decision }, source: { kind: "person" } });
    expect((await get(realApp, `/${ward.slug}/p/${project.projectId}`)).status).toBe(404);
  }

  const event = await createProject(env.DB, ward.wardId, { kind: "event", title: fixture.nextYearTitle, year: fixture.eventYear, accountId: account.accountId });
  for (const direction of ["income", "expense"] as const) {
    expect((await applyChange(env.DB, ward.wardId, event.projectId, { kind: "row", table: "ledger",
      data: { direction, counterpart: fixture.sponsorName, amount: fixture.sponsorAmount }, source: { kind: "person", accountId: account.accountId },
      confidence: "high", packVersion: "fictional-ledger@1", requestId: crypto.randomUUID() })).status).toBe("applied");
  }
  expect((await applyChange(env.DB, ward.wardId, event.projectId, { kind: "row", table: "ledger",
    data: { direction: "income", counterpart: fixture.requestedBy, amount: fixture.sponsorAmount }, source: { kind: "ai_proposal", year: fixture.eventYear },
    confidence: "low", packVersion: "fictional-ledger@1", requestId: crypto.randomUUID() })).status).toBe("applied");
  expect((await postForm(realApp, `${root}/close/${event.projectId}/finalize`, { body: fixture.reportText }, cookie)).status).toBe(303);
  const other = await seedAdmin(env.DB);
  const otherBoard = await createProject(env.DB, other.ward.wardId, { kind: "board_meeting", title: fixture.dutyTitle, year: fixture.eventYear, accountId: other.account.accountId });
  await applyChange(env.DB, other.ward.wardId, otherBoard.projectId, { kind: "row", table: "decisions", data: { what: fixture.dutyText },
    source: { kind: "person", accountId: other.account.accountId }, confidence: "high", packVersion: "fictional-other@1", requestId: crypto.randomUUID() });
  const general = await createProject(env.DB, ward.wardId, { kind: "general_meeting", title: fixture.draftTitle, year: fixture.eventYear, accountId: account.accountId });
  const agenda = await read(`/projects/${general.projectId}/draft/procedure`);
  expect(agenda).toContain(fixture.publicAnnouncement);
  expect(agenda).toContain(fixture.rainAnnouncement);
  expect(agenda).toContain(`収入: ${fixture.sponsorAmount.toLocaleString("ja-JP")}円`);
  expect(agenda).toContain(`支出: ${fixture.sponsorAmount.toLocaleString("ja-JP")}円`);
  expect(agenda).toContain(fixture.reportText);
  expect(agenda).not.toContain(fixture.dutyText);
  expect(agenda).not.toContain(fixture.draftText);
  const instruction = await startAgenda(general.projectId);
  expect(instruction).toContain(fixture.publicAnnouncement);
  expect(instruction).toContain(`"income":${fixture.sponsorAmount}`);
  expect(instruction).not.toContain(fixture.dutyText);
  expect(await saveDocument(env.DB, ward.wardId, general.projectId, account.accountId, {
    kind: "procedure", title: "議案の資料", scope: "staff", basedOn: general.stateVersion,
    body: JSON.stringify({ text: fixture.previousMaterial, items: [{ key: "content", content: fixture.previousMaterial }] }),
  })).toBe(true);
  await read(`/close/${general.projectId}`);
  await closeMeeting(general.projectId, fixture.nextYearChange);
  const nextYear = await createProject(env.DB, ward.wardId, { kind: "general_meeting", title: fixture.nextYearTitle, year: fixture.nextYear, accountId: account.accountId });
  const nextAgenda = await read(`/projects/${nextYear.projectId}/draft/procedure`);
  expect(nextAgenda).toContain(`${fixture.eventYear}年の会議で決めたこと`);
  expect(nextAgenda).toContain(fixture.publicAnnouncement);
  expect(nextAgenda).toContain(fixture.nextYearChange);
  expect(nextAgenda).toContain(fixture.reportText);
  expect(nextAgenda).toContain(fixture.previousMaterial);
  expect(nextAgenda).toContain("収入: 記録はまだありません");
  expect(nextAgenda).not.toContain(`収入: ${fixture.sponsorAmount.toLocaleString("ja-JP")}円`);
});
