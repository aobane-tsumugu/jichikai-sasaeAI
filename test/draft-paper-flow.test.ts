import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { callTool } from "../src/ai/mcp";
import { PACK_VERSION } from "../src/ai/pack";
import { sha256Hex } from "../src/core/password";
import { seedAdmin } from "../src/core/testing";
import { getDraftPack } from "../src/draft/packs";
import { receive } from "../src/intake/receive";
import { getEditableDocument, saveAIDraft } from "../src/project/actions";
import { applyChange, createProject, getProjectState, type DocumentKind } from "../src/project/api";
import type { DocumentBody } from "../src/project/document-body";
import { paperHeading } from "../src/project/heading";
import { articleParagraphs } from "../src/publish";
import { createInvite, openSpace } from "../src/space/api";
import { readPublicationTables } from "../src/space/publication-tables";
import { cookieFrom, get, postForm, realApp, withEnv } from "./helpers";

it("資料から当番の下書きを行にし、役員が直して紙と実行委員と班長のページへ配り、案内を一か所で直して記録を残す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  // 固定の本文や題だけで成立しないよう、入力ごとに違う架空の名前と場所をフォームへ渡す。
  const suffix = crypto.randomUUID().slice(0, 8);
  const title = `${FIRST_SLICE.nextYearTitle} ${suffix}`;
  const helper = `${FIRST_SLICE.phoneHelper} ${suffix}`;
  const editedHelper = `${FIRST_SLICE.sheetHelper} ${suffix}`;
  const oldPlace = `${FIRST_SLICE.previousPlace} ${suffix}`;
  const itemPlace = `${FIRST_SLICE.layoutPosition} ${suffix}`;
  const textPlace = `${FIRST_SLICE.layoutSpot} ${suffix}`;
  const date = `${FIRST_SLICE.sourceYear}年${FIRST_SLICE.publicDayText}`;
  const slot = "10:30-12:00"; // fixtures の架空の当番表と同じ時間帯。
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title, year: FIRST_SLICE.eventYear, accountId: account.accountId,
  });
  const id = project.projectId;
  const root = `/${ward.slug}/admin`;
  const received = await receive(env, {
    wardId: ward.wardId, projectId: id, via: "admin", accountId: account.accountId,
    parts: [{ kind: "text", filename: "", mediaType: "text/plain", bytes: new TextEncoder().encode(
      `${FIRST_SLICE.previousMaterial}\n日時: ${date}\n場所: ${oldPlace}\n${slot} / ${FIRST_SLICE.helperTime} / ${helper}\n${slot} / ${FIRST_SLICE.layoutSpot} / ${helper}`,
    ) }],
  });
  const original = received.received[0];
  if (!original) throw new Error("架空の資料が入りませんでした");
  const source = { kind: "original" as const, ref: original.originalId, year: FIRST_SLICE.sourceYear, locator: FIRST_SLICE.previousLocator };
  for (const [itemKey, value] of [["place", oldPlace], ["date_time", date]] as const) {
    expect((await applyChange(env.DB, ward.wardId, id, {
      kind: "item", itemKey, value, source, confidence: "high", packVersion: "draft-paper-flow@1",
    })).status).toBe("applied");
  }
  for (const task of [FIRST_SLICE.helperTime, FIRST_SLICE.layoutSpot]) {
    expect((await applyChange(env.DB, ward.wardId, id, {
      kind: "row", table: "duties", data: { slot, task, assignee: helper },
      source, confidence: "high", packVersion: "draft-paper-flow@1",
    })).status).toBe("applied");
  }
  const state = async () => {
    const value = await getProjectState(env.DB, ward.wardId, id);
    if (!value) throw new Error("行事がありません");
    return value;
  };
  const latest = async (kind: DocumentKind) => {
    const row = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no, v.body, v.tables_snapshot
      FROM document_versions v JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
      WHERE v.ward_id = ? AND v.project_id = ? AND d.kind = ? ORDER BY v.version_no DESC LIMIT 1`)
      .bind(ward.wardId, id, kind).first<{ document_id: string; version_id: string; version_no: number; body: string; tables_snapshot: string | null }>();
    if (!row) throw new Error("文書がありません");
    return row;
  };
  const fields = (row: Awaited<ReturnType<typeof latest>>) => ({ documentId: row.document_id, versionId: row.version_id, versionNo: String(row.version_no) });
  const draftDuty = async () => {
    const current = await state();
    const ticket = `tk_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO jobs (job_id, ward_id, project_id, via, task, instruction, status, ticket_hash, account_id, created_at, updated_at)
      VALUES (?, ?, ?, 'system', 'draft', ?, 'connecting', ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), ward.wardId, id, getDraftPack("duty_roster").instruction, await sha256Hex(ticket), account.accountId, now, now).run();
    // 実際の MCP の入口へ、状態から起こした AI の応答を渡す。外部の AI は呼ばない。
    const result = await callTool(env, ward.wardId, "write_change", {
      ticket, kind: "draft", target: "duty_roster", confidence: "high",
      data: {
        text: FIRST_SLICE.dutyText, title: "当番表", items: [{ key: "place", content: oldPlace, source: FIRST_SLICE.oldYearSource }], pack_version: getDraftPack("duty_roster").version,
        based_on_state_version: current.project.stateVersion,
        duties: current.tables.duties.filter((row) => row.scope === "reference").map((row) => ({ ...row.data, source_year: row.refYear })),
      },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: "applied" });
  };
  expect(PACK_VERSION).toBe("connect@12");
  await draftDuty();
  const dutyRows = (await state()).tables.duties.filter((row) => row.scope === "current");
  expect(dutyRows).toHaveLength(2);
  expect(dutyRows.every((row) => row.source.kind === "ai_proposal" && row.confidence === "low" && row.source.year === FIRST_SLICE.sourceYear)).toBe(true);
  const firstRow = dutyRows[0];
  if (!firstRow) throw new Error("当番の行がありません");
  const draftHtml = await (await get(realApp, `${root}/projects/${id}/draft/duty_roster`, cookie)).text();
  expect(draftHtml).toContain(`/draft/duty-row/${firstRow.rowId}`);
  expect((await postForm(realApp, `${root}/projects/${id}/draft/duty-row/${firstRow.rowId}`, {
    slot: String(firstRow.data.slot), task: String(firstRow.data.task), assignee: editedHelper, attendance: "no_change",
  }, cookie)).status).toBe(303);
  await draftDuty();
  expect((await state()).tables.duties.find((row) => row.rowId === firstRow.rowId)?.data.assignee).toBe(editedHelper);
  const duty = await latest("duty_roster");
  expect(JSON.parse(duty.body).text).not.toContain(helper);
  expect((await postForm(realApp, `${root}/publish/${id}/space`, fields(duty), cookie)).status).toBe(303);
  expect((await state()).items.find((item) => item.key === "place")?.current).toMatchObject({ content: oldPlace, source: { kind: "person" } });
  expect((await getEditableDocument(env.DB, ward.wardId, id, "duty_roster"))?.stale).toBe(false);
  const snapshot = readPublicationTables((await latest("duty_roster")).tables_snapshot);
  expect(snapshot?.filter((row) => row.kind === "duties")).toHaveLength(2);
  expect(snapshot?.some((row) => row.data.assignee === editedHelper)).toBe(true);
  const dutyPaper = await (await get(realApp, `${root}/print/${id}/${duty.document_id}/${duty.version_no}/duty`, cookie)).text();
  expect(dutyPaper).toContain(helper);
  expect(dutyPaper).toContain(editedHelper);
  await openSpace(env.DB, ward.wardId, id, FIRST_SLICE.passphrase, account.accountId);
  const token = await createInvite(env.DB, ward.wardId, id, "member", null, account.accountId, true);
  const entered = await get(realApp, `/${ward.slug}/space/${id}/person/${token}`);
  const memberCookie = cookieFrom(entered, `space_${id}`);
  if (!memberCookie) throw new Error("実行委員と班長のページに入れません");
  const space = await (await get(realApp, `/${ward.slug}/space/${id}`, memberCookie)).text();
  expect(space).toContain(helper);
  expect(space).toContain(editedHelper);

  const body = { text: `${FIRST_SLICE.draftText}\n${oldPlace}\n${date}`, items: [{ key: "place", content: oldPlace }, { key: "date_time", content: date }] };
  expect(await saveAIDraft(env.DB, ward.wardId, id, "announcement", getDraftPack("announcement").version, {
    ...body, title: "案内", based_on_state_version: (await state()).project.stateVersion,
  })).toBe(true);
  const save = async (text: string, place: string) => {
    expect((await postForm(realApp, `${root}/projects/${id}/draft/announcement/save`, {
      title: "案内", scope: "public", based_on: String((await state()).project.stateVersion),
      text, item_place: place, item_date_time: date,
    }, cookie)).status).toBe(303);
    return JSON.parse((await latest("announcement")).body) as DocumentBody;
  };
  const itemEdited = await save(body.text, itemPlace);
  expect(itemEdited.text).toContain(itemPlace);
  expect(itemEdited.text).not.toContain(oldPlace);
  expect((await state()).items.find((item) => item.key === "place")?.current?.content).toBe(itemPlace);
  expect((await state()).items.find((item) => item.key === "date_time")?.current).toBeNull();
  const textEdited = await save(itemEdited.text.replace(itemPlace, textPlace), itemPlace);
  expect(textEdited.items.some((item) => item.key === "place")).toBe(false);
  expect(articleParagraphs(JSON.stringify(textEdited)).join("\n")).not.toContain(itemPlace);
  // 本文と項目を同時に変えても、役員の書いた文を優先する。
  expect(await saveAIDraft(env.DB, ward.wardId, id, "announcement", getDraftPack("announcement").version, {
    ...body, title: "案内", based_on_state_version: (await state()).project.stateVersion,
  })).toBe(true);
  const bothEdited = await save(body.text.replace(oldPlace, textPlace), itemPlace);
  expect(bothEdited.text).toContain(textPlace);
  expect(bothEdited.items.some((item) => item.key === "place")).toBe(false);
  expect(articleParagraphs(JSON.stringify(bothEdited)).join("\n")).not.toContain(itemPlace);
  const longText = `${bothEdited.text}\n${Array.from({ length: 40 }, (_, i) => `${i + 1}. ${FIRST_SLICE.draftText}`).join("\n")}`;
  await save(longText, "");
  expect((await state()).items.find((item) => item.key === "date_time")?.current).toBeNull();

  const messages: string[] = [];
  const bindings = withEnv({ LINE_CHANNEL_ACCESS_TOKEN: "fictional-token", PUBLIC_BASE_URL: "https://example.test" });
  await env.DB.prepare(`INSERT INTO line_channels (ward_id, destination, access_token_binding)
    VALUES (?, ?, 'LINE_CHANNEL_ACCESS_TOKEN')`).bind(ward.wardId, `fictional-${suffix}`).run();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/insight/followers")) return Response.json({ status: "ready", followers: 1 });
    if (url.endsWith("/message/quota")) return Response.json({ type: "limited", value: 200 });
    if (url.endsWith("/message/quota/consumption")) return Response.json({ totalUsage: 0 });
    if (url.endsWith("/message/broadcast")) {
      const sent = JSON.parse(String(init?.body)) as { messages: { text: string }[] };
      messages.push(...sent.messages.map((message) => message.text));
      return new Response(null, { status: 200 });
    }
    throw new Error("この試験で予定していない外部通信です");
  });
  try {
    const announcement = await latest("announcement");
    expect((await postForm(realApp, `${root}/publish/${id}/send`, { ...fields(announcement), lineDelivery: "send" }, cookie, bindings)).status).toBe(303);
    expect(messages).toEqual([`${title} 案内\nhttps://example.test/${ward.slug}/p/${id}`]);
    expect(paperHeading(title, `${title}案内`)).toBe(`${title}案内`);
    const recordedDate = (await state()).items.find((item) => item.key === "date_time")?.current;
    expect(recordedDate).toMatchObject({ content: date, source: { kind: "person" } });
    expect((await getEditableDocument(env.DB, ward.wardId, id, "announcement"))?.stale).toBe(false);
    const printRoot = `${root}/print/${id}/${announcement.document_id}/${announcement.version_no}`;
    const longPaper = await (await get(realApp, `${printRoot}/announcement`, cookie)).text();
    expect(longPaper).toContain(`${title} 案内`);
    expect(longPaper).toContain("回答票");
    expect(longPaper.match(/class="sheet"/g)).toHaveLength(2);
    const answerPaper = await (await get(realApp, `${printRoot}/answer`, cookie)).text();
    expect(answerPaper.match(/class="sheet"/g)).toHaveLength(1);
    expect(answerPaper).toContain("代表者のお名前");
    const leaderPaper = await (await postForm(realApp, `${printRoot}/leader`, {}, cookie)).text();
    expect(leaderPaper.match(/class="sheet"/g)).toHaveLength(1);
    expect(leaderPaper).toContain("班長さんへ");
    expect(leaderPaper).not.toContain("区の設定で班の名前を入れる");
    const anonymousLeader = await env.DB.prepare(`SELECT district FROM project_space_members
      WHERE ward_id = ? AND project_id = ? AND role = 'leader'`).bind(ward.wardId, id).first<{ district: string | null }>();
    expect(anonymousLeader?.district).toBe("");
    // 短い本文も同じ、班名の無い一枚になる。
    await save(FIRST_SLICE.draftText, "");
    const short = await latest("announcement");
    expect((await postForm(realApp, `${root}/publish/${id}/send`, { ...fields(short), lineDelivery: "skip" }, cookie, bindings)).status).toBe(303);
    const shortPaper = await (await get(realApp, `${root}/print/${id}/${short.document_id}/${short.version_no}/announcement`, cookie)).text();
    expect(shortPaper.match(/class="sheet"/g)).toHaveLength(1);
    expect(shortPaper).toContain("回答票");
  } finally {
    vi.unstubAllGlobals();
  }

  const tasks = (await state()).mapTasks;
  const done = tasks.find((task) => task.progress === "done");
  const open = tasks.find((task) => task.progress === "open");
  if (!done || !open) throw new Error("済んだ仕事とこれからの仕事がありません");
  const activityHtml = await (await get(realApp, `${root}/close/${id}?view=activity`, cookie)).text();
  const checkbox = (html: string, taskId: string) => {
    const tag = html.match(/<input\b[^>]*>/g)?.find((entry) => entry.includes('name="taskId"') && entry.includes(`value="${taskId}"`));
    if (!tag) throw new Error("活動紹介で選ぶ仕事がありません");
    return tag;
  };
  expect(checkbox(activityHtml, done.taskId)).toContain("checked");
  expect(checkbox(activityHtml, open.taskId)).not.toContain("checked");
  expect((await postForm(realApp, `${root}/close/${id}/activity`, { taskId: open.taskId, introduction: FIRST_SLICE.reportText, action: "save" }, cookie)).status).toBe(303);
  const chosen = await (await get(realApp, `${root}/close/${id}?view=activity`, cookie)).text();
  expect(checkbox(chosen, open.taskId)).toContain("checked");
  expect(checkbox(chosen, done.taskId)).not.toContain("checked");
});
