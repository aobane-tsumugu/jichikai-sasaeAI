import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { seedAdmin } from "../src/core/testing";
import { applyChange, createProject, getProjectState } from "../src/project/api";
import { saveDocument } from "../src/project/actions";
import { addAnswer } from "../src/answers/api";
import { openSpace } from "../src/space/api";
import { setSetting } from "../src/settings/store";
import { lookupPaperCode, lookupPrintQr, printQrUrl, projectPaperQrUrl, qrSvg } from "../src/print/qr";
import { get, postForm, realApp } from "./helpers";
import { sendLatest } from "./helpers";

// 80行の登録から配布、閉じた記録まで実際のD1と画面を通すため、この試験だけ30秒まで待つ。
it("配る前の記入用紙から、班長の紙、閉じたあとの本文と答えと報告へつながる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: fixture.draftTitle, year: fixture.eventYear, accountId: account.accountId,
  });
  const root = `/${ward.slug}/admin`;
  const source = { kind: "person" as const, accountId: account.accountId };
  // 一枚に収まらない分も、既存の試しの資料から作った行で確かめる。
  for (let index = 1; index <= 40; index++) {
    const result = await applyChange(env.DB, ward.wardId, project.projectId, {
      kind: "row", table: "sponsors", data: { name: `${fixture.sponsorName}${index}`, amount: fixture.sponsorAmount, reply: "yes" },
      source, confidence: "high", packVersion: "paper-flow@1",
    });
    expect(result.status).toBe("applied");
    expect((await applyChange(env.DB, ward.wardId, project.projectId, {
      kind: "row", table: "duties", data: { slot: String(index), task: fixture.helperTime, assignee: `${fixture.sheetHelper}${index}` },
      source, confidence: "high", packVersion: "paper-flow@1",
    })).status).toBe("applied");
  }
  const meeting = await get(realApp, `${root}/print/${project.projectId}/paper/meeting`, cookie);
  expect(meeting.status).toBe(200);
  const paper = await meeting.text();
  const code = paper.match(/P[1-9][0-9]*-D0-V1/)?.[0];
  expect(code).toBeDefined();
  expect(await lookupPaperCode(env.DB, ward.wardId, code!)).toMatchObject({ projectId: project.projectId });
  const qr = projectPaperQrUrl("http://localhost", ward.slug, project.projectId);
  expect(await lookupPrintQr(env.DB, ward.wardId, ward.slug, qr)).toMatchObject({ projectId: project.projectId });
  const other = await seedAdmin(env.DB);
  expect(await lookupPrintQr(env.DB, other.ward.wardId, ward.slug, qr)).toBeNull();
  const sponsors = await (await get(realApp, `${root}/print/${project.projectId}/paper/sponsors`, cookie)).text();
  for (let index = 1; index <= 40; index++) expect(sponsors).toContain(`${fixture.sponsorName}${index}`);
  expect(sponsors).not.toContain("ほかに");
  expect(sponsors).not.toContain("overflow: hidden");
  const unpublished = await env.DB.prepare("SELECT COUNT(*) AS count FROM publication_records WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, project.projectId).first<{ count: number }>();
  expect(unpublished?.count).toBe(0);
  const map = await (await get(realApp, `${root}/projects/${project.projectId}/map`, cookie)).text();
  expect(map).toContain(`${root}/print/${project.projectId}`);
  expect(map).toContain(`/intake?project=${project.projectId}#send-form`);

  await setSetting(env.DB, ward.wardId, "squads", JSON.stringify([fixture.district]), account.accountId);
  await openSpace(env.DB, ward.wardId, project.projectId, fixture.passphrase, account.accountId);
  const state = await getProjectState(env.DB, ward.wardId, project.projectId);
  expect(state).not.toBeNull();
  expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
    kind: "announcement", title: fixture.draftTitle, scope: "public",
    body: JSON.stringify({ text: fixture.publicAnnouncement, items: [{ key: "place", content: fixture.previousPlace }] }), basedOn: state!.project.stateVersion,
  })).toBe(true);
  const version = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM documents d
    JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = 'announcement'`)
    .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  expect(version).not.toBeNull();
  const sent = await postForm(realApp, `${root}/publish/${project.projectId}/send`, {
    documentId: version!.document_id, versionId: version!.version_id, versionNo: String(version!.version_no), lineDelivery: "skip",
  }, cookie);
  expect(sent.status).toBe(303);
  const printRoot = `${root}/print/${project.projectId}/${version!.document_id}/${version!.version_no}`;
  const dutyPaper = await (await get(realApp, `${printRoot}/duty`, cookie)).text();
  for (let index = 1; index <= 40; index++) expect(dutyPaper).toContain(`${fixture.sheetHelper}${index}`);
  expect(dutyPaper).not.toContain("ほかに");
  const leader = await postForm(realApp, `${printRoot}/leader`, {}, cookie);
  expect(leader.status).toBe(200);
  const leaderPaper = await leader.text();
  const publicQr = printQrUrl("http://localhost", ward.slug, { projectId: project.projectId, documentId: version!.document_id, version: version!.version_no, squad: fixture.district });
  expect(leaderPaper).not.toContain(qrSvg(publicQr));
  const members = await env.DB.prepare("SELECT role, district FROM project_space_members WHERE ward_id = ? AND project_id = ? AND revoked_at IS NULL")
    .bind(ward.wardId, project.projectId).all<{ role: string; district: string }>();
  expect(members.results).toEqual([{ role: "leader", district: fixture.district }]);
  expect((await applyChange(env.DB, ward.wardId, project.projectId, {
    kind: "row", table: "decisions", data: { what: fixture.rainAnnouncement }, source, confidence: "high", packVersion: "paper-flow@1",
  })).status).toBe("applied");
  await addAnswer(env.DB, ward.wardId, { projectId: project.projectId, household: fixture.firstHousehold, district: fixture.district,
    peopleCount: 3, helperName: fixture.sheetHelper, helperTimes: fixture.helperTime, source: "phone", accountId: account.accountId });
  expect((await get(realApp, `${root}/close/${project.projectId}`, cookie)).status).toBe(200);
  expect((await postForm(realApp, `${root}/close/${project.projectId}/report/public`, { body: fixture.reportText }, cookie)).status).toBe(303);
  expect((await postForm(realApp, `${root}/close/${project.projectId}/report/staff`, { body: fixture.nextYearChange }, cookie)).status).toBe(303);
  // 住民への報告は、終わりにする前にほかの連絡と同じ送り方で送る（L-319）。
  expect((await sendLatest(ward.slug, ward.wardId, project.projectId, "report", cookie)).status).toBe(303);
  expect((await postForm(realApp, `${root}/close/${project.projectId}/finalize`, {}, cookie)).status).toBe(303);
  const publicPage = await (await get(realApp, `/${ward.slug}/p/${project.projectId}`)).text();
  expect(publicPage).toContain(fixture.reportText);
  expect(publicPage).toContain(fixture.publicAnnouncement);
  expect(publicPage).not.toContain(fixture.nextYearChange);
  expect(publicPage).not.toContain(fixture.sponsorName);
  expect(publicPage).not.toContain(fixture.firstHousehold);
  const archive = await (await get(realApp, `${root}/archive/${project.projectId}`, cookie)).text();
  for (const text of [fixture.publicAnnouncement, fixture.reportText, fixture.nextYearChange, fixture.firstHousehold, fixture.sheetHelper, fixture.helperTime, fixture.rainAnnouncement, `${fixture.sponsorName}40`]) expect(archive).toContain(text);
  const report = await env.DB.prepare(`SELECT r.line_status FROM publication_records r JOIN documents d
    ON d.ward_id = r.ward_id AND d.document_id = r.document_id WHERE r.ward_id = ? AND r.project_id = ? AND d.kind = 'report'`)
    .bind(ward.wardId, project.projectId).first<{ line_status: string }>();
  expect(report?.line_status).toBe("not_sent");
}, 30_000);
