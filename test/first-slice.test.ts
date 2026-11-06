import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setClientFactory } from "../src/ai/deps";
import { runRead, setPipelineDeps, type PipelineDeps } from "../src/intake/pipeline";
import { getReadings } from "../src/intake/api";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { uniqueSlug } from "../src/core/testing";
import { applyChange, getProjectState } from "../src/project/api";
import { saveAIDraft, saveDocument } from "../src/project/actions";
import { replaceRoster, listAnswers, listUnansweredByDistrict, getAnswerTotals } from "../src/answers/api";
import { OPS_COOKIE } from "../src/ops/session";
import { OPS_ID, OPS_PASSWORD, cookieFrom, get, opsEnv, postForm, realApp } from "./helpers";

afterEach(() => {
  setClientFactory(null);
  setPipelineDeps(null);
  vi.unstubAllGlobals();
});

describe("秋の収穫祭の最初の一片", () => {
  it("開設から来年の種まで役員画面と公開経路を通す", async () => {
    // 段 0: 提供側の HTTP 経路で区と最初の役員を開き、発行された資格で入る。
    const opsLogin = await postForm(realApp, "/ops/login", { id: OPS_ID, password: OPS_PASSWORD }, undefined, opsEnv);
    const opsCookie = cookieFrom(opsLogin, OPS_COOKIE);
    expect(opsLogin.status).toBe(303);
    expect(opsCookie).toBeTruthy();
    const slug = uniqueSlug("first-slice");
    const openedWard = await postForm(realApp, "/ops/wards", {
      name: FIRST_SLICE.wardName, slug, firstAccountName: FIRST_SLICE.firstOfficer,
    }, opsCookie ?? undefined, opsEnv, { accept: "application/json" });
    expect(openedWard.status).toBe(201);
    const openedBody = await openedWard.json() as { slug: string; account: { name: string; password: string } };
    const wardRow = await env.DB.prepare("SELECT ward_id, slug FROM wards WHERE slug = ?").bind(openedBody.slug)
      .first<{ ward_id: string; slug: string }>();
    if (!wardRow) throw new Error("開いた区が見つかりません");
    const ward = { wardId: wardRow.ward_id, slug: wardRow.slug };
    const loggedIn = await postForm(realApp, `/${openedBody.slug}/admin/login`, openedBody.account);
    expect(loggedIn.status).toBe(303);
    const cookie = cookieFrom(loggedIn, "device");
    if (!cookie) throw new Error("役員画面に入る札がありません");
    const accountRow = await env.DB.prepare("SELECT account_id FROM accounts WHERE ward_id = ? AND name = ?")
      .bind(ward.wardId, FIRST_SLICE.firstOfficer).first<{ account_id: string }>();
    if (!accountRow) throw new Error("最初の役員が見つかりません");
    const account = { accountId: accountRow.account_id };
    // 試験中に実際の Anthropic へ出ないようにし、回答票の読取だけ試験用の応答に置き換える。
    setClientFactory(() => { throw new Error("この試験から Anthropic へ接続してはいけません"); });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v2/bot/insight/followers")) return Response.json({ status: "ready", followers: 1 });
      if (url.endsWith("/v2/bot/message/quota")) return Response.json({ type: "limited", value: 200 });
      if (url.endsWith("/v2/bot/message/quota/consumption")) return Response.json({ totalUsage: 0 });
      if (url.endsWith("/v2/bot/message/broadcast")) return new Response(null, { status: 200 });
      throw new Error(`試験で許可していない送信先です: ${url}`);
    });

    // 段 0: 区を開き、役員画面に入る。
    const home = await get(realApp, `/${ward.slug}/admin/`, cookie);
    expect(home.status).toBe(200);

    // 段 1: HTTP でプロジェクトを開き、前年の原本と参考の中身、案を入れる。
    const opened = await postForm(realApp, `/${ward.slug}/admin/projects`, { kind: "event", year: "2026" }, cookie);
    expect(opened.status).toBe(303);
    const mapLocation = opened.headers.get("location") ?? "";
    const projectId = /\/projects\/([^/]+)\/map$/.exec(mapLocation)?.[1];
    expect(projectId).toBeTruthy();
    const project = await (async () => {
      const row = await env.DB.prepare("SELECT project_id, state_version FROM projects WHERE ward_id = ? AND project_id = ?")
        .bind(ward.wardId, projectId).first<{ project_id: string; state_version: number }>();
      return row;
    })();
    expect(project).not.toBeNull();
    const renamed = await postForm(realApp, `/${ward.slug}/admin/projects/${projectId}/title`, { title: FIRST_SLICE.nextYearTitle }, cookie);
    expect(renamed.status).toBe(303);
    const mapPage = await get(realApp, mapLocation, cookie);
    const mapHtml = await mapPage.text();
    expect(mapPage.status).toBe(200);
    const materialPath = `/${ward.slug}/admin/intake?project=${encodeURIComponent(projectId as string)}#send-form`;
    expect(mapHtml).toContain(`href="${materialPath}"`);
    expect(mapHtml).toContain(`/admin/projects/${projectId}/draft`);
    expect(mapHtml).toContain(`/admin/answers?project=${encodeURIComponent(projectId as string)}`);
    expect(mapHtml).toContain(`/admin/projects/${projectId}#ledger`);
    // 地図から送る画面を開き、送り先を選び直さずに材料を送れる。
    const materialPage = await get(realApp, materialPath, cookie);
    expect(materialPage.status).toBe(200);
    const materialHtml = await materialPage.text();
    expect(materialHtml).toContain('<form id="send-form"');
    expect(materialHtml).toContain(`<option value="${projectId}" selected="">`);
    const material = await postForm(realApp, `/${ward.slug}/admin/intake`, { project_id: projectId as string, text: FIRST_SLICE.previousMaterial }, cookie);
    expect(material.status).toBe(303);
    const original = await env.DB.prepare(`SELECT o.original_id FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id
      WHERE o.ward_id = ? AND j.project_id = ? ORDER BY o.received_at DESC LIMIT 1`).bind(ward.wardId, projectId).first<{ original_id: string }>();
    const originalId = original?.original_id;
    expect(originalId).toBeTruthy();
    const reference = await applyChange(env.DB, ward.wardId, projectId as string, {
      kind: "item", itemKey: "place", value: FIRST_SLICE.previousPlace, source: { kind: "original", ref: originalId as string, locator: FIRST_SLICE.previousLocator, year: FIRST_SLICE.sourceYear },
      confidence: "high", packVersion: "first-slice@1",
    });
    expect(reference.status).toBe("applied");
    const beforeDraft = await getProjectState(env.DB, ward.wardId, projectId as string);
    const base = beforeDraft?.project.stateVersion ?? 0;
    expect(await saveAIDraft(env.DB, ward.wardId, projectId as string, "announcement", "first-slice@1", {
      title: FIRST_SLICE.draftTitle, scope: "public", text: FIRST_SLICE.draftText, based_on_state_version: base,
      items: [{ key: "place", content: FIRST_SLICE.previousPlace, source: FIRST_SLICE.oldYearSource }],
    })).toBe(true);
    const draftPage = await get(realApp, `/${ward.slug}/admin/projects/${projectId}/draft/announcement`, cookie);
    expect(draftPage.status).toBe(200);
    expect(await draftPage.text()).toContain(FIRST_SLICE.previousPlace);

    const queuedDraftId = crypto.randomUUID();
    const queuedAt = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO jobs (job_id, ward_id, project_id, via, task, instruction, status, created_at, updated_at)
      VALUES (?, ?, ?, 'system', 'draft', ?, 'read', ?, ?)`)
      .bind(queuedDraftId, ward.wardId, projectId, "当番表の案を起こす。対象の文書: duty_roster。範囲: space。", queuedAt, queuedAt).run();
    const queuedDutyPage = await get(realApp, `/${ward.slug}/admin/projects/${projectId}/draft/duty_roster`, cookie);
    const queuedDutyHtml = await queuedDutyPage.text();
    expect(queuedDutyPage.status).toBe(200);
    expect(queuedDutyHtml).toContain('data-ai-status="read"');
    expect(queuedDutyHtml).toContain("順番を待っています");
    expect(queuedDutyHtml).toContain(`action="/${ward.slug}/admin/projects/${projectId}/draft/duty_roster/save"`);
    const savedManualDuty = await postForm(realApp, `/${ward.slug}/admin/projects/${projectId}/draft/duty_roster/save`, {
      based_on: String(beforeDraft?.project.stateVersion ?? 0), title: "当番表", scope: "space", text: "担当を役員で記入します。",
    }, cookie);
    expect(savedManualDuty.status).toBe(303);
    const manualDutyPage = await get(realApp, `/${ward.slug}/admin/projects/${projectId}/draft/duty_roster`, cookie);
    expect(await manualDutyPage.text()).toContain("担当を役員で記入します。");
    await env.DB.prepare("DELETE FROM jobs WHERE ward_id = ? AND job_id = ?").bind(ward.wardId, queuedDraftId).run();

    // 公開の検査用の名簿と、公開してはいけない協賛額を役員だけの状態に置く。
    await replaceRoster(env.DB, ward.wardId, [
      { household: FIRST_SLICE.rosterName, district: FIRST_SLICE.district },
    ], { household: 0, district: 1 });
    await applyChange(env.DB, ward.wardId, projectId as string, {
      kind: "row", table: "sponsors", data: { name: FIRST_SLICE.sponsorName, amount: FIRST_SLICE.sponsorAmount },
      source: { kind: "person", accountId: account.accountId }, confidence: "high", packVersion: "first-slice@1",
    });

    // 段 2: 役員が案を直して HTTP で配り、公開ページと印刷用ページを開く。
    const state = await getProjectState(env.DB, ward.wardId, projectId as string);
    const basedOn = state?.project.stateVersion ?? 0;
    const saved = await saveDocument(env.DB, ward.wardId, projectId as string, account.accountId, {
      kind: "announcement", title: FIRST_SLICE.draftTitle, scope: "public",
      body: JSON.stringify({ text: FIRST_SLICE.publicAnnouncement, items: [] }), basedOn,
    });
    expect(saved).toBe(true);
    const document = await env.DB.prepare(`SELECT d.document_id, v.version_id, v.version_no, p.state_version FROM documents d
      JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
      JOIN projects p ON p.ward_id = d.ward_id AND p.project_id = d.project_id
      WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = 'announcement'
      ORDER BY v.version_no DESC LIMIT 1`).bind(ward.wardId, projectId).first<{ document_id: string; version_id: string; version_no: number; state_version: number }>();
    expect(document).not.toBeNull();
    const confirm = await postForm(realApp, `/${ward.slug}/admin/publish/${projectId}/confirm`, {
      documentId: document!.document_id, versionId: document!.version_id, versionNo: String(document!.version_no),
      recipientScope: "all_households", distribution: "",
    }, cookie);
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain("配ります。");
    const published = await postForm(realApp, `/${ward.slug}/admin/publish/${projectId}/send`, {
      documentId: document!.document_id, versionId: document!.version_id, versionNo: String(document!.version_no),
      stateVersion: String(document!.state_version), recipientScope: "all_households", distribution: "",
    }, cookie);
    expect(published.status).toBe(303);
    const publicUrl = `/${ward.slug}/p/${projectId}`;
    const publicOne = await get(realApp, publicUrl);
    const firstPublicBody = await publicOne.text();
    expect(publicOne.status).toBe(200);
    expect(firstPublicBody).toContain("10月24日");
    expect(firstPublicBody).not.toContain(FIRST_SLICE.rosterName);
    expect(firstPublicBody).not.toContain(FIRST_SLICE.amountNotPublished);
    const publication = await env.DB.prepare("SELECT document_id, version_no FROM publication_records WHERE ward_id = ? AND project_id = ?")
      .bind(ward.wardId, projectId).first<{ document_id: string; version_no: number }>();
    expect(publication).not.toBeNull();
    const print = await get(realApp, `/${ward.slug}/admin/print/${projectId}/${publication!.document_id}/${publication!.version_no}/announcement`, cookie);
    expect(print.status).toBe(200);
    expect(await print.text()).toContain("@page");

    // 段 3: Web、電話、回答票の読み取りを答えに入れ、未回答を数える。
    await replaceRoster(env.DB, ward.wardId, [
      { household: FIRST_SLICE.firstHousehold, district: FIRST_SLICE.district },
      { household: FIRST_SLICE.secondHousehold, district: FIRST_SLICE.district },
    ], { household: 0, district: 1 });
    const answerPrint = await get(realApp, `/${ward.slug}/admin/print/${projectId}/${publication!.document_id}/${publication!.version_no}/answer`, cookie);
    const answerPrintHtml = await answerPrint.text();
    expect(answerPrint.status).toBe(200);
    expect(answerPrintHtml).toContain(`班: ${FIRST_SLICE.district}`);
    expect(answerPrintHtml).toContain(`回答票`);
    expect((await get(realApp, `/${ward.slug}/answer/${projectId}`)).status).toBe(200);
    const webAnswer = await postForm(realApp, `/${ward.slug}/answer/${projectId}`, {
      household: FIRST_SLICE.firstHousehold, district: FIRST_SLICE.district, people_count: "3", helper_name: "", helper_times: "",
    });
    expect(webAnswer.status).toBe(200);
    expect((await postForm(realApp, `/${ward.slug}/admin/answers/${projectId}/phone`, {
      household: FIRST_SLICE.phoneHousehold, district: FIRST_SLICE.district, people_count: "2", helper_name: FIRST_SLICE.phoneHelper, helper_times: FIRST_SLICE.helperTime,
    }, cookie)).status).toBe(303);
    const sheetDeps: PipelineDeps = {
      createClient: () => ({}) as Anthropic,
      readImpl: async () => ({ body: FIRST_SLICE.answerSheetReading, packVersion: "read-answer-sheet@1", model: "claude-sonnet-5-5", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } }),
    };
    setPipelineDeps(sheetDeps);
    const form = new FormData();
    form.set("part", new File([new Uint8Array(FIRST_SLICE.answerSheetPhotoBytes)], FIRST_SLICE.answerSheetFilename, { type: "image/jpeg" }));
    form.set("project_id", projectId as string);
    const sheetResponse = await realApp.request(`/${ward.slug}/admin/answers/${projectId}/sheet`, {
      method: "POST", headers: { origin: "http://localhost", cookie }, body: form,
    }, env);
    expect(sheetResponse.status).toBe(303);
    const sheetJob = await env.DB.prepare("SELECT job_id, read_kind FROM jobs WHERE ward_id = ? AND project_id = ? AND read_kind = 'answer_sheet' ORDER BY created_at DESC LIMIT 1")
      .bind(ward.wardId, projectId).first<{ job_id: string; read_kind: string }>();
    expect(sheetJob?.read_kind).toBe("answer_sheet");
    if (sheetJob) await runRead(env, ward.wardId, sheetJob.job_id, { deps: sheetDeps });
    const sheetReading = sheetJob ? (await getReadings(env.DB, ward.wardId, sheetJob.job_id))[0] : undefined;
    expect(sheetReading?.body).toHaveProperty("rows.0.household_name", FIRST_SLICE.firstHousehold);
    const sheetOriginal = await env.DB.prepare("SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ?")
      .bind(ward.wardId, sheetJob?.job_id ?? "").first<{ original_id: string }>();
    expect(sheetOriginal).not.toBeNull();
    const sheetAnswer = await postForm(realApp, `/${ward.slug}/admin/answers/${projectId}/sheet/${sheetOriginal!.original_id}/row/0`, {
      household: FIRST_SLICE.firstHousehold, district: FIRST_SLICE.district, people_count: "3", helper_name: FIRST_SLICE.sheetHelper, helper_times: FIRST_SLICE.helperTime,
    }, cookie);
    expect(sheetAnswer.status).toBe(303);
    const answerList = await listAnswers(env.DB, ward.wardId, projectId as string);
    expect(answerList.map((answer) => answer.source).sort()).toEqual(["phone", "sheet", "web"]);
    expect(await getAnswerTotals(env.DB, ward.wardId, projectId as string)).toEqual({ people: 8, helperRequests: 2 });
    expect(await listUnansweredByDistrict(env.DB, ward.wardId, projectId as string)).toEqual([{ district: FIRST_SLICE.district, households: [FIRST_SLICE.secondHousehold] }]);
    const answersPage = await get(realApp, `/${ward.slug}/admin/answers/${projectId}?view=unanswered`, cookie);
    expect(await answersPage.text()).toContain(FIRST_SLICE.secondHousehold);
    expect((await get(realApp, publicUrl)).status).toBe(200);

    // 段 4: 当番表と配置を空間に配り、合言葉なしでは中身を見られない。
    await applyChange(env.DB, ward.wardId, projectId as string, {
      kind: "row", table: "layout", data: { spot: FIRST_SLICE.layoutSpot, position: FIRST_SLICE.layoutPosition },
      source: { kind: "person", accountId: account.accountId }, confidence: "high", packVersion: "first-slice@1",
    });
    expect(await saveDocument(env.DB, ward.wardId, projectId as string, account.accountId, {
      kind: "duty_roster", title: FIRST_SLICE.dutyTitle, scope: "space",
      body: JSON.stringify({ text: FIRST_SLICE.dutyText, items: [] }), basedOn: (await getProjectState(env.DB, ward.wardId, projectId as string))?.project.stateVersion ?? 0,
    })).toBe(true);
    expect((await postForm(realApp, `/${ward.slug}/admin/space/${projectId}/open`, { passphrase: FIRST_SLICE.passphrase }, cookie)).status).toBe(303);
    const locked = await get(realApp, `/${ward.slug}/space/${projectId}`);
    expect(locked.status).toBe(200);
    expect(await locked.text()).not.toContain(FIRST_SLICE.dutyText);
    const enter = await postForm(realApp, `/${ward.slug}/space/${projectId}/enter`, { passphrase: FIRST_SLICE.passphrase });
    expect(enter.status).toBe(303);
    const spaceCookie = cookieFrom(enter, `space_${projectId}`);
    const spacePage = await get(realApp, `/${ward.slug}/space/${projectId}`, spaceCookie ?? undefined);
    const spaceBody = await spacePage.text();
    expect(spacePage.status).toBe(200);
    expect(spaceBody).toContain("文書はまだ配っていません。");
    expect(spaceBody).not.toContain(FIRST_SLICE.dutyText);
    expect(spaceBody).not.toContain(FIRST_SLICE.layoutSpot);
    expect(spaceBody).not.toContain(FIRST_SLICE.layoutPosition);

    // 保存と入室だけでは表を出さず、役員が配った後に文書と表を一緒に見せる。
    const dutyVersion = await env.DB.prepare(`SELECT d.document_id, v.version_id, v.version_no FROM documents d
      JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
      WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = 'duty_roster'
      ORDER BY v.version_no DESC LIMIT 1`)
      .bind(ward.wardId, projectId).first<{ document_id: string; version_id: string; version_no: number }>();
    if (!dutyVersion) throw new Error("配る当番表がありません。");
    const dutyPublished = await postForm(realApp, `/${ward.slug}/admin/publish/${projectId}/space`, {
      documentId: dutyVersion.document_id, versionId: dutyVersion.version_id, versionNo: String(dutyVersion.version_no),
    }, cookie);
    expect(dutyPublished.status).toBe(303);
    expect(dutyPublished.headers.get("location")).toBe(`/${ward.slug}/admin/publish/${projectId}?space=sent`);
    const distributedSpace = await get(realApp, `/${ward.slug}/space/${projectId}`, spaceCookie ?? undefined);
    const distributedSpaceBody = await distributedSpace.text();
    expect(distributedSpace.status).toBe(200);
    expect(distributedSpaceBody).toContain(FIRST_SLICE.dutyText);
    expect(distributedSpaceBody).toContain(FIRST_SLICE.layoutSpot);
    expect(distributedSpaceBody).toContain(FIRST_SLICE.layoutPosition);
    expect(distributedSpaceBody).not.toContain("文書はまだ配っていません。");
    const lockedAfterDistribution = await get(realApp, `/${ward.slug}/space/${projectId}`);
    const lockedAfterDistributionBody = await lockedAfterDistribution.text();
    expect(lockedAfterDistribution.status).toBe(200);
    expect(lockedAfterDistributionBody).not.toContain(FIRST_SLICE.dutyText);
    expect(lockedAfterDistributionBody).not.toContain(FIRST_SLICE.layoutSpot);
    const publicSpaceCheck = await get(realApp, publicUrl);
    const publicSpaceBody = await publicSpaceCheck.text();
    expect(publicSpaceBody).not.toContain(FIRST_SLICE.dutyText);
    expect(publicSpaceBody).not.toContain(FIRST_SLICE.layoutSpot);

    // 段 5: 雨天変更の二版目を配り、同じ URL に二版が積もる。
    const secondState = await getProjectState(env.DB, ward.wardId, projectId as string);
    await saveDocument(env.DB, ward.wardId, projectId as string, account.accountId, {
      kind: "announcement", title: FIRST_SLICE.draftTitle, scope: "public",
      body: JSON.stringify({ text: FIRST_SLICE.rainAnnouncement, items: [] }), basedOn: secondState?.project.stateVersion ?? 0,
    });
    const second = await env.DB.prepare(`SELECT d.document_id, v.version_id, v.version_no, p.state_version FROM documents d
      JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
      JOIN projects p ON p.ward_id = d.ward_id AND p.project_id = d.project_id
      WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = 'announcement'
      ORDER BY v.version_no DESC LIMIT 1`).bind(ward.wardId, projectId).first<{ document_id: string; version_id: string; version_no: number; state_version: number }>();
    expect(second).not.toBeNull();
    expect(second!.version_no).toBeGreaterThan(document!.version_no);
    expect((await postForm(realApp, `/${ward.slug}/admin/publish/${projectId}/confirm`, {
      documentId: second!.document_id, versionId: second!.version_id, versionNo: String(second!.version_no), recipientScope: "all_households", distribution: "",
    }, cookie)).status).toBe(200);
    expect((await postForm(realApp, `/${ward.slug}/admin/publish/${projectId}/send`, {
      documentId: second!.document_id, versionId: second!.version_id, versionNo: String(second!.version_no), stateVersion: String(second!.state_version), recipientScope: "all_households", distribution: "",
    }, cookie)).status).toBe(303);
    const publicTwo = await get(realApp, publicUrl);
    const twoVersions = await publicTwo.text();
    expect(publicTwo.status).toBe(200);
    expect(twoVersions).toContain(FIRST_SLICE.publicDayText);
    expect(twoVersions).toContain(FIRST_SLICE.rainAnnouncement);
    expect(twoVersions).not.toContain(FIRST_SLICE.firstHousehold);
    expect((await get(realApp, `/${ward.slug}/p/${projectId}`)).status).toBe(200);

    // 段 6: 報告を保存し、地図を直して閉じる。閉じた後は書けず、記録から来年の種を開く。
    expect((await postForm(realApp, `/${ward.slug}/admin/close/${projectId}/prepare`, {}, cookie)).status).toBe(303);
    const mapTask = await env.DB.prepare("SELECT task_id FROM project_close_map WHERE ward_id = ? AND project_id = ? LIMIT 1")
      .bind(ward.wardId, projectId).first<{ task_id: string }>();
    expect(mapTask).not.toBeNull();
    const report = await postForm(realApp, `/${ward.slug}/admin/close/${projectId}/report/public`, { body: FIRST_SLICE.reportText }, cookie);
    expect(report.status).toBe(303);
    const reportVersion = await env.DB.prepare(`SELECT d.document_id, v.version_id, v.version_no, p.state_version FROM documents d
      JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
      JOIN projects p ON p.ward_id = d.ward_id AND p.project_id = d.project_id
      WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = 'report'`).bind(ward.wardId, projectId).first<{ document_id: string; version_id: string; version_no: number; state_version: number }>();
    expect(reportVersion).not.toBeNull();
    const reportConfirm = await postForm(realApp, `/${ward.slug}/admin/publish/${projectId}/confirm`, {
      documentId: reportVersion!.document_id, versionId: reportVersion!.version_id, versionNo: String(reportVersion!.version_no),
      recipientScope: "all_households", distribution: "",
    }, cookie);
    expect(reportConfirm.status).toBe(200);
    const reportPublish = await postForm(realApp, `/${ward.slug}/admin/publish/${projectId}/send`, {
      documentId: reportVersion!.document_id, versionId: reportVersion!.version_id, versionNo: String(reportVersion!.version_no),
      stateVersion: String(reportVersion!.state_version), recipientScope: "all_households", distribution: "",
    }, cookie);
    expect(reportPublish.status).toBe(303);
    const edited = await postForm(realApp, `/${ward.slug}/admin/close/${projectId}/map/${mapTask!.task_id}`, {
      period: FIRST_SLICE.nextYearPeriod, name: FIRST_SLICE.nextYearTask, progress: "done", requestedBy: FIRST_SLICE.requestedBy, difficulty: FIRST_SLICE.nextYearDifficulty, nextYear: FIRST_SLICE.nextYearChange,
    }, cookie);
    expect(edited.status).toBe(303);
    expect((await postForm(realApp, `/${ward.slug}/admin/close/${projectId}/finalize`, {}, cookie)).status).toBe(303);
    const editAfterClose = await postForm(realApp, `/${ward.slug}/admin/close/${projectId}/map/${mapTask!.task_id}`, {
      period: "後", name: "書き換えない", progress: "open", requestedBy: "", difficulty: "", nextYear: "",
    }, cookie);
    expect(editAfterClose.status).toBe(303);
    const savedTask = await env.DB.prepare("SELECT name FROM project_close_map WHERE ward_id = ? AND project_id = ? AND task_id = ?")
      .bind(ward.wardId, projectId, mapTask!.task_id).first<{ name: string }>();
    expect(savedTask?.name).toBe(FIRST_SLICE.nextYearTask);
    expect((await get(realApp, `/${ward.slug}/admin/archive/${projectId}`, cookie)).status).toBe(200);
    const seeded = await postForm(realApp, `/${ward.slug}/admin/archive/${projectId}/seed`, {
      title: FIRST_SLICE.nextYearTitle, year: String(FIRST_SLICE.nextYear), eventDay: FIRST_SLICE.eventDay,
    }, cookie);
    expect(seeded.status).toBe(303);
    const seedLocation = seeded.headers.get("location") ?? "";
    const nextId = new URL(seedLocation, "http://localhost").searchParams.get("started");
    expect(nextId).toBeTruthy();
    expect(nextId).not.toBe(projectId);
    expect((await getProjectState(env.DB, ward.wardId, nextId as string))?.project.projectId).toBe(nextId);
    expect((await get(realApp, `/${ward.slug}/admin/projects/${nextId}/map`, cookie)).status).toBe(200);
  });
});
