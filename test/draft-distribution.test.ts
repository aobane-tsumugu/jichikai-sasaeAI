import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { replaceRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { getDraftPack } from "../src/draft/packs";
import { receive } from "../src/intake/receive";
import { saveAIDraft, setMapTask } from "../src/project/actions";
import { applyChange, createProject, getProjectState, type DocumentKind } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("去年から案を作り、新しい資料が入っても全戸に配り、地図と報告を残す", async () => {
  let broadcasts = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v2/bot/insight/followers")) return Response.json({ status: "ready", followers: 1 });
    if (url.endsWith("/v2/bot/message/quota")) return Response.json({ type: "limited", value: 200 });
    if (url.endsWith("/v2/bot/message/quota/consumption")) return Response.json({ totalUsage: 0 });
    if (url.endsWith("/v2/bot/message/broadcast")) {
      broadcasts += 1;
      return new Response(null, { status: 200 });
    }
    throw new Error("この試験で予定していない外部通信です");
  });
  try {
    const { ward, account, cookie } = await seedAdmin(env.DB);
    const project = await createProject(env.DB, ward.wardId, {
      kind: "event", title: FIRST_SLICE.nextYearTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId,
    });
    const root = `/${ward.slug}/admin`;
    const received = await receive(env, {
      wardId: ward.wardId, projectId: project.projectId, via: "admin", accountId: account.accountId,
      parts: [{ kind: "text", filename: "", mediaType: "text/plain", bytes: new TextEncoder().encode(FIRST_SLICE.previousMaterial) }],
    });
    const original = received.received[0];
    if (!original) throw new Error("架空の資料を受け付けられませんでした");
    expect((await applyChange(env.DB, ward.wardId, project.projectId, {
      kind: "item", itemKey: "place", value: FIRST_SLICE.previousPlace,
      source: { kind: "original", ref: original.originalId, year: FIRST_SLICE.sourceYear, locator: FIRST_SLICE.previousLocator },
      confidence: "high", packVersion: "draft-distribution-test@1",
    })).status).toBe("applied");
    expect((await applyChange(env.DB, ward.wardId, project.projectId, {
      kind: "item", itemKey: "date_time", value: FIRST_SLICE.publicDayText,
      source: { kind: "person", accountId: account.accountId }, confidence: "high", packVersion: "draft-distribution-test@1",
    })).status).toBe("applied");
    const draftHtml = await (await get(realApp, `${root}/projects/${project.projectId}/draft/announcement`, cookie)).text();
    expect(draftHtml).toContain(`value="${FIRST_SLICE.previousPlace}"`);
    expect(draftHtml).toContain(`value="${FIRST_SLICE.publicDayText}"`);
    expect(draftHtml).toContain(`${FIRST_SLICE.sourceYear}年の資料から案に入れました。`);
    expect(await (await get(realApp, `${root}/projects/${project.projectId}`, cookie)).text()).not.toContain("混入を確かめる");
    expect((await get(realApp, `${root}/projects/${project.projectId}/check`, cookie)).status).toBe(404);

    // AI は呼ばず、記録の内容から作った案を保存し、以後は実際の配る経路を通す。
    const saveDraft = async (kind: DocumentKind, text: string) => {
      const state = await getProjectState(env.DB, ward.wardId, project.projectId);
      if (!state) throw new Error("プロジェクトが見つかりません");
      expect(await saveAIDraft(env.DB, ward.wardId, project.projectId, kind, getDraftPack(kind).version, {
        text, items: [{ key: "place", content: FIRST_SLICE.previousPlace, source: FIRST_SLICE.oldYearSource }],
        based_on_state_version: state.project.stateVersion,
      })).toBe(true);
      const row = await env.DB.prepare(`SELECT d.document_id, v.version_id, v.version_no FROM documents d
        JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
        WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = ? ORDER BY v.version_no DESC LIMIT 1`)
        .bind(ward.wardId, project.projectId, kind).first<{ document_id: string; version_id: string; version_no: number }>();
      if (!row) throw new Error("保存した案が見つかりません");
      return { documentId: row.document_id, versionId: row.version_id, versionNo: String(row.version_no) };
    };
    const announcement = await saveDraft("announcement", `${FIRST_SLICE.draftText}\n雨天時: （確認中）`);
    await replaceRoster(env.DB, ward.wardId, [{ household: FIRST_SLICE.firstHousehold, district: FIRST_SLICE.district }], { household: 0, district: 1 });
    expect((await applyChange(env.DB, ward.wardId, project.projectId, {
      kind: "item", itemKey: "rain_plan", value: FIRST_SLICE.rainAnnouncement,
      source: { kind: "person", accountId: account.accountId }, confidence: "high", packVersion: "draft-distribution-test@1",
    })).status).toBe("applied");
    const confirmFields = { ...announcement, targetMode: "district", district: FIRST_SLICE.district, copies_0: "3", lineDelivery: "skip" };
    expect((await postForm(realApp, `${root}/publish/${project.projectId}/confirm`, {
      ...confirmFields, recipientScope: "member_households",
    }, cookie)).status).toBe(400);
    const confirmed = await postForm(realApp, `${root}/publish/${project.projectId}/confirm`, {
      ...confirmFields, recipientScope: "all_households",
    }, cookie);
    expect(confirmed.status).toBe(200);
    const confirmHtml = await confirmed.text();
    expect(confirmHtml).toContain("ここに表示した内容で配れます。");
    expect(confirmHtml).toContain("まだ決まっていない所: （確認中）");
    expect(confirmHtml).toContain("配る相手: 全戸");
    const distribution = JSON.stringify({ mode: "district", targets: [{ district: FIRST_SLICE.district, copies: 3 }] });
    const sendFields = { ...announcement, recipientScope: "all_households", distribution, lineDelivery: "skip" };
    expect((await postForm(realApp, `${root}/publish/${project.projectId}/send`, sendFields, cookie)).status).toBe(303);
    const published = await env.DB.prepare(`SELECT recipient_scope, distribution FROM publication_records
      WHERE ward_id = ? AND project_id = ? AND version_id = ?`)
      .bind(ward.wardId, project.projectId, announcement.versionId).first<{ recipient_scope: string; distribution: string }>();
    expect(published).toEqual({ recipient_scope: "all_households", distribution });
    const publicHtml = await (await get(realApp, `/${ward.slug}/p/${project.projectId}`)).text();
    expect(publicHtml).toContain(FIRST_SLICE.draftText);
    expect(publicHtml).not.toContain(FIRST_SLICE.rainAnnouncement);
    const state = await getProjectState(env.DB, ward.wardId, project.projectId);
    const task = state?.mapTasks.find((row) => row.taskKey === "announcement");
    expect(task?.progress).toBe("done");
    if (!task) throw new Error("案内を配る仕事が見つかりません");
    expect(await setMapTask(env.DB, ward.wardId, project.projectId, task.taskId, {
      name: task.name, start: task.periodStart ?? "", end: task.periodEnd ?? "", progress: "started", seatId: null,
    })).toBe(true);
    const next = await saveDraft("announcement", FIRST_SLICE.publicAnnouncement);
    expect((await postForm(realApp, `${root}/publish/${project.projectId}/send`, { ...sendFields, ...next }, cookie)).status).toBe(303);
    expect((await getProjectState(env.DB, ward.wardId, project.projectId))?.mapTasks.find((row) => row.taskId === task.taskId)?.progress).toBe("started");

    const duty = await saveDraft("duty_roster", FIRST_SLICE.dutyText);
    expect((await postForm(realApp, `${root}/publish/${project.projectId}/space`, duty, cookie)).status).toBe(303);
    expect((await getProjectState(env.DB, ward.wardId, project.projectId))?.mapTasks.find((row) => row.taskKey === "duty_roster")?.progress).toBe("done");

    const report = await saveDraft("report", FIRST_SLICE.reportText);
    const publishHtml = await (await get(realApp, `${root}/publish/${project.projectId}`, cookie)).text();
    const reportSection = publishHtml.split('<section class="panel"').find((section) => section.includes(`value="${report.documentId}"`));
    expect(reportSection).toBeDefined();
    expect(reportSection).not.toContain('name="lineDelivery"');
    const reportConfirm = await postForm(realApp, `${root}/publish/${project.projectId}/confirm`, {
      ...confirmFields, ...report, recipientScope: "all_households", lineDelivery: "send",
    }, cookie);
    expect(await reportConfirm.text()).toContain("今回は公式 LINE に送りません。");
    expect((await postForm(realApp, `${root}/publish/${project.projectId}/send`, {
      ...sendFields, ...report, lineDelivery: "send",
    }, cookie)).status).toBe(303);
    expect(await env.DB.prepare("SELECT line_status FROM publication_records WHERE ward_id = ? AND project_id = ? AND version_id = ?")
      .bind(ward.wardId, project.projectId, report.versionId).first()).toEqual({ line_status: "not_sent" });
    expect(broadcasts).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});
