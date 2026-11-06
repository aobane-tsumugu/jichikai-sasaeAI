import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { READ_PACK_VERSION, type AnswerSheetReading } from "../src/ai/schema";
import { getAnswerTotals, listAnswers } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { formatJstDate } from "../src/core/time";
import { runRead } from "../src/intake/pipeline";
import { receive } from "../src/intake/receive";
import { opensOf } from "../src/map/template";
import { getEditableDocument, saveDocument } from "../src/project/actions";
import { createProject, getProjectState, type DocumentKind } from "../src/project/api";
import type { DocumentBody } from "../src/project/document-body";
import { get, postForm, realApp } from "./helpers";

it("過ぎた締切を知らせて配り、雨の変更後に答えと手伝いを受け、紙の空欄を同じ数に入れる", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-10-01T03:00:00Z"));
  try {
    const { ward, account, cookie } = await seedAdmin(env.DB);
    const project = await createProject(env.DB, ward.wardId, {
      kind: "event", title: fixture.nextYearTitle, year: fixture.nextYear, accountId: account.accountId,
    });
    const id = project.projectId;
    const root = `/${ward.slug}/admin`;
    const read = async (path: string) => {
      const response = await get(realApp, path, cookie);
      expect(response.status).toBe(200);
      return response.text();
    };
    const save = async (kind: DocumentKind, body: DocumentBody) => {
      const state = await getProjectState(env.DB, ward.wardId, id);
      if (!state) throw new Error("架空の行事がありません");
      expect(await saveDocument(env.DB, ward.wardId, id, account.accountId, {
        kind, title: fixture.draftTitle, scope: "public", basedOn: state.project.stateVersion, body: JSON.stringify(body),
      })).toBe(true);
    };
    const latest = async (kind: DocumentKind) => {
      const row = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no, v.body FROM documents d
        JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
        WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = ? ORDER BY v.version_no DESC LIMIT 1`)
        .bind(ward.wardId, id, kind).first<{ document_id: string; version_id: string; version_no: number; body: string }>();
      if (!row) throw new Error("架空の文書がありません");
      return row;
    };
    const publish = async (kind: DocumentKind) => {
      const row = await latest(kind);
      expect((await postForm(realApp, `${root}/publish/${id}/send`, {
        documentId: row.document_id, versionId: row.version_id, versionNo: String(row.version_no), lineDelivery: "skip",
      }, cookie)).status).toBe(303);
      return row;
    };
    const oldDue = `${fixture.eventYear}-10-01`;
    const announcementBody: DocumentBody = { text: `${fixture.publicAnnouncement}\n締切：${oldDue}`, items: [
      { key: "place", content: fixture.previousPlace }, { key: "date_time", content: fixture.publicDayText },
      { key: "due", content: oldDue },
    ] };
    await save("announcement", announcementBody);
    const announcementDraft = await latest("announcement");
    const fields = { documentId: announcementDraft.document_id, versionId: announcementDraft.version_id,
      versionNo: String(announcementDraft.version_no), lineDelivery: "skip" };
    const confirm = await postForm(realApp, `${root}/publish/${id}/confirm`, fields, cookie);
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain("本文の締切は過ぎているため、このまま配ると答えの受付が続きますが、締切は配ったあとに変えられます。");
    const announcement = await publish("announcement");
    const original = (await latest("announcement")).body;
    const paperBase = `${root}/print/${id}/${announcement.document_id}/${announcement.version_no}`;
    for (const path of [`${paperBase}/preview`, `${paperBase}/announcement`, `${paperBase}/answer`]) {
      expect(await read(path)).toContain("いない欄は、空けたままでかまいません");
    }
    // 項目を持たない知らせだけのときは、配った案内の場所を使う。
    await save("notice", { text: fixture.rainAnnouncement, items: [] });
    await publish("notice");
    const answerPath = `/${ward.slug}/answer/${id}`;
    const answer = async () => postForm(realApp, answerPath, {
      household: fixture.firstHousehold, district: "", attend: "yes", adults_count: "2", children_count: "", seniors_count: "",
      submission_id: crypto.randomUUID(),
    });
    const beforeRain = await answer();
    expect(beforeRain.status).toBe(200);
    expect(await beforeRain.text()).toContain(`<dd>${fixture.previousPlace}</dd>`);
    await save("recruitment", { text: fixture.draftText, items: [{ key: "helper_slots", content: fixture.helperTime }] });
    await publish("recruitment");
    const rain = await postForm(realApp, `${root}/projects/${id}/draft/rain-notice`, {
      templateId: "rain", eventName: project.title, place: fixture.layoutSpot, dateTime: fixture.eventDay, lineDelivery: "skip",
    }, cookie);
    expect(rain.status).toBe(303);
    expect(await read(rain.headers.get("location")!)).toContain("区のページに載せました");
    const notice = await getEditableDocument(env.DB, ward.wardId, id, "notice");
    expect(notice).not.toBeNull();
    const rainBody = JSON.parse(notice!.body) as DocumentBody;
    expect(rainBody.items).toEqual(expect.arrayContaining([
      { key: "place", content: fixture.layoutSpot }, { key: "date_time", content: fixture.eventDay },
    ]));
    // 案内を同じ内容で配り直したあとも、新しい知らせの場所を優先する。
    await save("announcement", announcementBody);
    vi.setSystemTime(new Date("2027-10-01T03:01:00Z"));
    await publish("announcement");
    const afterRain = await answer();
    expect(afterRain.status).toBe(200);
    const done = await afterRain.text();
    expect(done).toContain(`<dd>${fixture.layoutSpot}</dd>`);
    expect(done).toContain(`<dd>${formatJstDate(fixture.eventDay)}</dd>`);
    expect(done).not.toContain(`<dd>${fixture.previousPlace}</dd>`);
    const help = await postForm(realApp, `/${ward.slug}/help/${id}`, {
      helper_name: fixture.sheetHelper, helper_times: fixture.helperTime,
    });
    expect(help.status).toBe(200);
    expect(await help.text()).toContain(`<dd>${fixture.layoutSpot}</dd>`);
    const oldBody = await env.DB.prepare("SELECT body FROM document_versions WHERE ward_id = ? AND project_id = ? AND version_id = ?")
      .bind(ward.wardId, id, announcement.version_id).first<{ body: string }>();
    expect(oldBody?.body).toBe(original);
    const publicPage = await read(`/${ward.slug}/p/${id}`);
    expect(publicPage).toContain(rainBody.text);
    expect(publicPage).toContain(announcementBody.text);
    expect(publicPage.indexOf(rainBody.text)).toBeLessThan(publicPage.indexOf(announcementBody.text));

    const received = await receive(env, {
      wardId: ward.wardId, projectId: id, via: "admin", readKind: "answer_sheet", accountId: account.accountId,
      parts: [{ kind: "photo", filename: fixture.answerSheetFilename, mediaType: "image/jpeg", bytes: new Uint8Array(fixture.answerSheetPhotoBytes) }],
    });
    const originalId = received.received[0]!.originalId;
    // 確認できる空欄は0、判読できない人数はnullとして読み取る。
    const row = { ...fixture.answerSheetReading.rows[0]!, original_id: originalId, children: 0, seniors: 0 };
    const reading: AnswerSheetReading = { ...fixture.answerSheetReading, rows: [
      { ...row, adults: 2, household_name: fixture.firstHousehold },
      { ...row, adults: null, children: null, seniors: null, household_name: fixture.secondHousehold },
      { ...row, adults: null, not_attending: true, household_name: fixture.phoneHousehold },
      { ...row, adults: null, children: 1 },
      { ...row, adults: 2, children: null },
      { ...row, adults: 2, seniors: null },
      { ...row, adults: 0, not_attending: false },
    ] };
    // AIだけを架空の写真の読み取りで置き換え、実際の保存と集計を通す。
    expect(await runRead(env, ward.wardId, received.jobId!, { deps: {
      createClient: () => new Anthropic({ apiKey: fixture.passphrase }),
      readImpl: async () => ({ body: reading, packVersion: READ_PACK_VERSION.answer_sheet, model: "fixture",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } }),
    } })).toBe("read");
    const sheets = (await listAnswers(env.DB, ward.wardId, id)).filter((entry) => entry.originalId === originalId);
    expect(sheets).toHaveLength(2);
    expect(sheets.map((entry) => entry.sheetRowIndex).sort()).toEqual([0, 2]);
    expect(sheets).toEqual(expect.arrayContaining([
      expect.objectContaining({ household: fixture.firstHousehold, peopleCount: 2, adultsCount: 2, childrenCount: 0, seniorsCount: 0 }),
      expect.objectContaining({ household: fixture.phoneHousehold, peopleCount: 0, adultsCount: 0, childrenCount: 0, seniorsCount: 0 }),
    ]));
    const answersPage = await read(`${root}/answers/${id}?view=list`);
    expect(answersPage).toContain(`action="${root}/answers/${id}/sheet/${originalId}/row/1"`);
    expect(answersPage).toContain("人数が読めませんでした");
    expect((await getAnswerTotals(env.DB, ward.wardId, id)).people).toBe(6);

    for (const kind of ["notice", "report"] as const) {
      if (kind === "report") { await save(kind, { text: fixture.reportText, items: [] }); await publish(kind); }
      const document = await latest(kind);
      const base = `${root}/print/${id}/${document.document_id}/${document.version_no}`;
      for (const path of [`${base}/preview`, `${base}/announcement`]) {
        const paper = await read(path);
        expect(paper).toContain(kind === "notice" ? rainBody.text : fixture.reportText);
        expect(paper).not.toContain('class="answer-slip');
        expect(paper.match(/class="sheet"/g)).toHaveLength(1);
      }
      expect(await read(base)).not.toContain("回答票");
      expect((await get(realApp, `${base}/answer`, cookie)).status).toBe(404);
    }
    expect(opensOf("general_meeting", "minutes")).toEqual(["materials"]);
  } finally {
    vi.useRealTimers();
  }
});
