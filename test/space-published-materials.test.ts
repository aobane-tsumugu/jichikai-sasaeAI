import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import Anthropic from "@anthropic-ai/sdk";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { getAnswerTotals, listAnswers } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { runRead, setPipelineDeps, type PipelineDeps } from "../src/intake/pipeline";
import { saveDocument } from "../src/project/actions";
import { applyChange, createProject, getProjectState } from "../src/project/api";
import type { RowData } from "../src/project/model";
import { cookieFrom, get, postForm, realApp } from "./helpers";

it("空間には配った文書を読みやすく出し、班長の回答票を役員と同じ集計に一度だけ入れる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: FIRST_SLICE.nextYearTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId,
  });
  const projectId = project.projectId;
  const admin = `/${ward.slug}/admin`;
  const spacePath = `/${ward.slug}/space/${projectId}`;
  const setup = await get(realApp, `${admin}/space/${projectId}`, cookie);
  const setupHtml = await setup.text();
  const generated = setupHtml.match(/name="passphrase"[^>]*value="([^"]+)"/u)?.[1];
  expect(generated).toMatch(/^[ぁ-ん]+・[ぁ-ん]+・[ぁ-ん]+・\d{5}$/u);
  expect(setup.headers.get("cache-control")).toBe("private, no-store");
  if (!generated) throw new Error("合言葉が用意されていません。");
  // 用意された言葉を書き換えても、その言葉で入れる。
  const passphrase = `${generated}${FIRST_SLICE.passphrase}`;
  expect((await postForm(realApp, `${admin}/space/${projectId}/open`, { passphrase }, cookie)).status).toBe(303);
  expect((await postForm(realApp, `${spacePath}/enter`, { passphrase })).status).toBe(303);
  const leaderResponse = await postForm(realApp, `${admin}/space/${projectId}/leader`, { district: FIRST_SLICE.district }, cookie);
  const leaderHtml = await leaderResponse.text();
  const leaderUrl = leaderHtml.match(/http:\/\/localhost\/[^<]+\/person\/([a-f0-9]+)/u)?.[0];
  if (!leaderUrl) throw new Error("班長の専用URLがありません。");
  const entered = await get(realApp, leaderUrl);
  const memberCookie = cookieFrom(entered, `space_${projectId}`);
  if (!memberCookie) throw new Error("班長が空間に入れません。");

  const source = { kind: "person" as const, accountId: account.accountId };
  const rows: { table: "sponsors" | "duties" | "layout"; data: RowData }[] = [
    { table: "sponsors", data: { name: FIRST_SLICE.sponsorName, reply: "yes", amount: FIRST_SLICE.sponsorAmount } },
    { table: "duties", data: { slot: FIRST_SLICE.helperTime, assignee: FIRST_SLICE.sheetHelper, attendance: "present" } },
    { table: "layout", data: { spot: FIRST_SLICE.layoutSpot, position: FIRST_SLICE.layoutPosition } },
  ];
  for (const input of rows) {
    const changed = await applyChange(env.DB, ward.wardId, projectId, {
      kind: "row", ...input, source, confidence: "high", packVersion: "space-materials-test@1",
    });
    expect(changed.status).toBe("applied");
  }
  const current = await getProjectState(env.DB, ward.wardId, projectId);
  if (!current) throw new Error("プロジェクトがありません。");
  const save = (text: string, scope: "space" | "staff" = "space") => saveDocument(env.DB, ward.wardId, projectId, account.accountId, {
    kind: "duty_roster", title: text, scope,
    body: JSON.stringify({ text, items: [{ key: "place", content: FIRST_SLICE.previousPlace }] }), basedOn: current.project.stateVersion,
  });
  expect(await save(FIRST_SLICE.dutyText)).toBe(true);
  const before = await (await get(realApp, spacePath, memberCookie)).text();
  expect(before).toContain("文書はまだ配っていません。");
  expect(before).not.toContain(FIRST_SLICE.dutyText);
  const published = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
    WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1`)
    .bind(ward.wardId, projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!published) throw new Error("配る文書がありません。");
  expect((await postForm(realApp, `${admin}/publish/${projectId}/space`, {
    documentId: published.document_id, versionId: published.version_id, versionNo: String(published.version_no),
  }, cookie)).status).toBe(303);
  // 作り直し中に見せる範囲と題も変わっても、配った本文と範囲を保つ。
  expect(await save(FIRST_SLICE.reportText, "staff")).toBe(true);
  const html = await (await get(realApp, spacePath, memberCookie)).text();
  for (const value of [FIRST_SLICE.dutyText, FIRST_SLICE.previousPlace, FIRST_SLICE.sponsorName, FIRST_SLICE.sheetHelper,
    FIRST_SLICE.layoutSpot, FIRST_SLICE.layoutPosition, "時間帯", "担当", "置く位置", "可", "出席", "回答票を撮って送る"]) {
    expect(html).toContain(value);
  }
  for (const value of [FIRST_SLICE.reportText, FIRST_SLICE.amountNotPublished, "&quot;text&quot;", "&quot;assignee&quot;", "<pre"]) {
    expect(html).not.toContain(value);
  }

  const deps: PipelineDeps = {
    // 読み取りは fixtures の応答で置き換え、認証や外部APIを呼ばない。
    createClient: () => new Anthropic({ credentials: () => { throw new Error("試験から外部APIは呼びません。"); } }),
    readImpl: async (_client, { kind }) => {
      expect(kind).toBe("answer_sheet");
      return { body: FIRST_SLICE.answerSheetReading, packVersion: "read-answer-sheet@1", model: "claude-sonnet-5-5",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } };
    },
  };
  setPipelineDeps(deps);
  try {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(FIRST_SLICE.answerSheetPhotoBytes)], FIRST_SLICE.answerSheetFilename, { type: "image/jpeg" }));
    const context = createExecutionContext();
    const sent = await realApp.request(`${spacePath}/send-answer`, {
      method: "POST", headers: { origin: "http://localhost", cookie: memberCookie }, body: form,
    }, env, context);
    expect(sent.status).toBe(303);
    expect(sent.headers.get("location")).toBe(`${spacePath}?sent=answer`);
    const job = await env.DB.prepare("SELECT job_id, read_kind FROM jobs WHERE ward_id = ? AND project_id = ? AND via = 'space'")
      .bind(ward.wardId, projectId).first<{ job_id: string; read_kind: string }>();
    expect(job?.read_kind).toBe("answer_sheet");
    if (!job) throw new Error("回答票が受け付けられていません。");
    await waitOnExecutionContext(context);
    await runRead(env, ward.wardId, job.job_id, { deps });
    expect(await getAnswerTotals(env.DB, ward.wardId, projectId)).toEqual({ people: 3, helperRequests: 1 });
    expect(await listAnswers(env.DB, ward.wardId, projectId)).toMatchObject([
      { household: FIRST_SLICE.firstHousehold, district: FIRST_SLICE.district, source: "sheet", peopleCount: 3 },
    ]);
    const repeated = new FormData();
    repeated.set("file", new File([new Uint8Array(FIRST_SLICE.answerSheetPhotoBytes)], FIRST_SLICE.answerSheetFilename, { type: "image/jpeg" }));
    const repeatedContext = createExecutionContext();
    expect((await realApp.request(`${spacePath}/send-answer`, {
      method: "POST", headers: { origin: "http://localhost", cookie: memberCookie }, body: repeated,
    }, env, repeatedContext)).status).toBe(303);
    await waitOnExecutionContext(repeatedContext);
    expect(await getAnswerTotals(env.DB, ward.wardId, projectId)).toEqual({ people: 3, helperRequests: 1 });
    expect(await listAnswers(env.DB, ward.wardId, projectId)).toHaveLength(1);
    expect(await (await get(realApp, `${admin}/answers/${projectId}?view=list`, cookie)).text()).toContain(FIRST_SLICE.firstHousehold);
  } finally {
    setPipelineDeps(null);
  }
});
