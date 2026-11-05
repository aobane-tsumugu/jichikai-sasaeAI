import { env } from "cloudflare:workers";
import Anthropic from "@anthropic-ai/sdk";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { callTool } from "../src/ai/mcp";
import { setClientFactory } from "../src/ai/deps";
import type { Reading } from "../src/ai/schema";
import { seedAdmin } from "../src/core/testing";
import { sha256Hex } from "../src/intake/media";
import { receive } from "../src/intake/receive";
import { runRead } from "../src/intake/pipeline";
import { applyChange, createProject, getProjectState } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

async function setup() {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: FIRST_SLICE.nextYearTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId,
  });
  const input = await receive(env, {
    wardId: ward.wardId, projectId: project.projectId, via: "admin", accountId: account.accountId,
    parts: [{ kind: "text", filename: FIRST_SLICE.dutyTitle, mediaType: "text/plain",
      bytes: new TextEncoder().encode(FIRST_SLICE.rainAnnouncement) }],
  });
  const originalId = input.received[0]?.originalId;
  if (!input.jobId || !originalId) throw new Error("架空の資料を受け取れませんでした");
  const ticket = `tk_${crypto.randomUUID()}`;
  await env.DB.prepare("UPDATE jobs SET status = 'connecting', ticket_hash = ? WHERE ward_id = ? AND job_id = ?")
    .bind(await sha256Hex(ticket), ward.wardId, input.jobId).run();
  const write = async (args: Record<string, unknown>) => {
    const result = await callTool(env, ward.wardId, "write_change", {
      ticket, original_id: originalId, locator: FIRST_SLICE.previousLocator, confidence: "high", ...args,
    });
    expect(result.isError).toBeUndefined();
    return JSON.parse(result.content[0]?.text ?? "null") as { status: string; duplicate?: boolean };
  };
  const state = async () => {
    const value = await getProjectState(env.DB, ward.wardId, project.projectId);
    if (!value) throw new Error("架空のプロジェクトがありません");
    return value;
  };
  return { ward, account, cookie, project, originalId, ticket, write, state, root: `/${ward.slug}/admin/projects/${project.projectId}` };
}

it("年不明は参考に留まり、印のある食い違いだけを問い、選ぶと人の入力として今年に入る", async () => {
  const { ward, account, project, cookie, root, originalId, ticket, write, state } = await setup();
  for (const itemKey of ["place", "content", "rain_plan"] as const) {
    await applyChange(env.DB, ward.wardId, project.projectId, {
      kind: "item", itemKey, value: FIRST_SLICE.previousPlace, source: { kind: "person", accountId: account.accountId },
      confidence: "high", packVersion: "person-test@1",
    });
  }
  // 年は本文にも名前にも無い。読み取りと名前を、繋げる手が両方受け取れる。
  const reading = await callTool(env, ward.wardId, "get_reading", { ticket });
  const body = JSON.parse(reading.content[0]?.text ?? "null") as {
    originals: Array<{ original_id: string; filename: string }>;
    readings: Array<{ body: { original_years: Array<{ original_id: string; year: number | null }> } }>;
  };
  expect(body.originals).toContainEqual({ original_id: originalId, filename: FIRST_SLICE.dutyTitle });
  expect(body.readings[0]?.body.original_years).toEqual([{ original_id: originalId, year: null }]);
  // source_year で year を迂回しても今年には入らない。
  expect((await write({ kind: "item", target: "rain_plan", data: { value: FIRST_SLICE.rainAnnouncement, source_year: FIRST_SLICE.eventYear }, confidence: "low" })).status).toBe("applied");
  expect((await state()).questions).toHaveLength(0);
  for (const target of ["place", "content", "due"] as const) {
    expect((await write({ kind: "item", target, data: { value: FIRST_SLICE.rainAnnouncement }, maybe_this_year: true })).status).toBe("applied");
  }
  let current = await state();
  expect(current.questions).toHaveLength(2); // 締切は今年が空なので問わない。
  expect(current.items.find((item) => item.key === "place")?.current?.content).toBe(FIRST_SLICE.previousPlace);
  expect(current.items.find((item) => item.key === "place")?.references[0]).toMatchObject({
    content: FIRST_SLICE.rainAnnouncement, refYear: null, source: { kind: "original", ref: originalId, year: null },
  });
  const question = current.questions.find((q) => q.target === "place");
  if (!question) throw new Error("場所の問いがありません");
  expect(question.text).toBe(`「場所」が食い違っています。今は「${FIRST_SLICE.previousPlace}」です。年の書いていない資料には「${FIRST_SLICE.rainAnnouncement}」とあります。どちらにしますか。`);
  expect(question.options).toEqual([FIRST_SLICE.previousPlace, FIRST_SLICE.rainAnnouncement]);
  expect((await write({ kind: "item", target: "place", data: { value: FIRST_SLICE.rainAnnouncement }, maybe_this_year: true })).duplicate).toBe(true);
  expect((await state()).questions).toHaveLength(2);
  expect((await postForm(realApp, `${root}/questions/${question.questionId}`, { answer: FIRST_SLICE.rainAnnouncement }, cookie)).status).toBe(303);
  current = await state();
  expect(current.items.find((item) => item.key === "place")?.current).toMatchObject({
    content: FIRST_SLICE.rainAnnouncement, source: { kind: "person" },
  });
  expect(current.items.find((item) => item.key === "due")?.current).toBeNull();
  expect(current.items.find((item) => item.key === "rain_plan")?.current?.content).toBe(FIRST_SLICE.previousPlace);
});

it("この資料は今年の物で項目と表を入れ直し、違う中身は上書きせず問いにする", async () => {
  const { ward, account, project, cookie, root, originalId, write, state } = await setup();
  await applyChange(env.DB, ward.wardId, project.projectId, {
    kind: "item", itemKey: "place", value: FIRST_SLICE.previousPlace, source: { kind: "person", accountId: account.accountId },
    confidence: "high", packVersion: "person-test@1",
  });
  await applyChange(env.DB, ward.wardId, project.projectId, {
    kind: "row", table: "sponsors", data: { name: FIRST_SLICE.sponsorName, amount: FIRST_SLICE.sponsorAmount },
    source: { kind: "original", ref: originalId, locator: FIRST_SLICE.previousLocator, year: FIRST_SLICE.eventYear },
    confidence: "high", packVersion: "current-test@1",
  });
  expect(await (await get(realApp, root, cookie)).text()).not.toContain("この資料は今年の物</button>");
  for (const target of ["place", "content"] as const) {
    await write({ kind: "item", target, data: { value: FIRST_SLICE.rainAnnouncement } });
  }
  await write({ kind: "row", target: "sponsors", data: { name: FIRST_SLICE.sponsorName, amount: FIRST_SLICE.sponsorAmount + 1 }, maybe_this_year: true });
  await write({ kind: "row", target: "layout", data: { spot: FIRST_SLICE.layoutSpot, position: FIRST_SLICE.layoutPosition } });
  let current = await state();
  expect(current.questions).toHaveLength(0);
  expect(current.tables.sponsors.filter((row) => row.scope === "reference")).toHaveLength(1);
  const page = await (await get(realApp, root, cookie)).text();
  const action = `${root}/materials/${originalId}/this-year`;
  expect(page).toContain(`action="${action}"`);
  expect(page).toContain("この資料は今年の物</button>");
  expect(page).toContain("今年の中身と違う所は、上書きせず問いに並びます。");
  expect((await postForm(realApp, action, {}, cookie)).status).toBe(303);
  current = await state();
  expect(current.items.find((item) => item.key === "content")?.current).toMatchObject({
    content: FIRST_SLICE.rainAnnouncement, source: { kind: "original", ref: originalId, year: FIRST_SLICE.eventYear },
  });
  expect(current.items.find((item) => item.key === "place")?.current?.content).toBe(FIRST_SLICE.previousPlace);
  expect(current.tables.layout).toHaveLength(1);
  expect(current.tables.layout[0]).toMatchObject({ scope: "current", source: { year: FIRST_SLICE.eventYear } });
  expect(current.tables.sponsors).toHaveLength(1);
  expect(current.tables.sponsors[0]?.data.amount).toBe(FIRST_SLICE.sponsorAmount);
  expect(current.questions).toHaveLength(2);
  expect(current.questions.find((q) => q.target === "place")?.options).toEqual([FIRST_SLICE.previousPlace, FIRST_SLICE.rainAnnouncement]);
  expect(await (await get(realApp, root, cookie)).text()).not.toContain("この資料は今年の物</button>");
  // 二度押しで問いを増やさず、別の区や別のプロジェクトからは年を直せない。
  expect((await postForm(realApp, action, {}, cookie)).status).toBe(303);
  expect((await state()).questions).toHaveLength(2);
  const other = await seedAdmin(env.DB);
  const denied = await postForm(realApp, `/${other.ward.slug}/admin/projects/${project.projectId}/materials/${originalId}/this-year`, {}, other.cookie);
  expect(denied.headers.get("location")).toContain("?error=");
  expect((await state()).questions).toHaveLength(2);
});

it("年のある原本と無い原本を一緒に送っても、年の無い内容は年不明の参考に留まる", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: FIRST_SLICE.nextYearTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId,
  });
  // 架空の写真二枚と、展開した Word と文字の資料を一度に送る。本物の AI は呼ばない。
  const input = await receive(env, {
    wardId: ward.wardId, projectId: project.projectId, via: "admin", accountId: account.accountId,
    parts: [
      ...[0, 1].map((i) => ({ kind: "photo" as const, filename: `${i}-${FIRST_SLICE.dutyTitle}.jpg`, mediaType: "image/jpeg",
        bytes: new Uint8Array([...FIRST_SLICE.answerSheetPhotoBytes, i]) })),
      { kind: "file", filename: `${FIRST_SLICE.draftTitle}.docx`, mediaType: "",
        bytes: new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]),
        extracted: { format: "docx", paragraphs: [`${FIRST_SLICE.eventYear}年。${FIRST_SLICE.reportText}`], tables: [] } },
      { kind: "file", filename: `${FIRST_SLICE.phoneHousehold}.txt`, mediaType: "text/plain",
        bytes: new TextEncoder().encode(FIRST_SLICE.rainAnnouncement) },
    ],
  });
  const [datedPhoto, undatedPhoto, datedWord, undatedText] = input.received;
  if (!input.jobId || !datedPhoto || !undatedPhoto || !datedWord || !undatedText) throw new Error("架空の原本が足りません");
  const modelReading: Reading = {
    document_kind: "memo", summary: FIRST_SLICE.dutyTitle,
    original_years: [{ original_id: datedPhoto.originalId, year: FIRST_SLICE.eventYear }, { original_id: undatedPhoto.originalId, year: null }],
    text_blocks: [
      { original_id: datedPhoto.originalId, locator: FIRST_SLICE.previousLocator, text: `${FIRST_SLICE.eventYear}年。${FIRST_SLICE.dutyText}` },
      { original_id: undatedPhoto.originalId, locator: FIRST_SLICE.previousLocator, text: FIRST_SLICE.previousPlace },
    ],
    fields: [
      { original_id: datedPhoto.originalId, locator: FIRST_SLICE.previousLocator, name: "行事の中身", value: FIRST_SLICE.dutyText, confidence: "high" },
      { original_id: undatedPhoto.originalId, locator: FIRST_SLICE.previousLocator, name: "場所", value: FIRST_SLICE.previousPlace, confidence: "high" },
    ],
    tables: [], decisions: [], unreadable: [],
  };
  const client = new Anthropic({
    apiKey: "test-only", maxRetries: 0,
    fetch: async () => Response.json({
      id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: JSON.stringify(modelReading) }], usage: { input_tokens: 100, output_tokens: 100 },
    }),
  });
  setClientFactory(() => { throw new Error("試験から本物の Anthropic は呼べません"); });
  try {
    expect(await runRead(env, ward.wardId, input.jobId, { deps: { createClient: () => client } })).toBe("read");
  } finally {
    setClientFactory(null);
  }
  const ticket = `tk_${crypto.randomUUID()}`;
  await env.DB.prepare("UPDATE jobs SET status = 'connecting', ticket_hash = ? WHERE ward_id = ? AND job_id = ?")
    .bind(await sha256Hex(ticket), ward.wardId, input.jobId).run();
  const result = await callTool(env, ward.wardId, "get_reading", { ticket });
  expect(result.isError).toBeUndefined();
  const body = JSON.parse(result.content[0]!.text) as { readings: Array<{ body: Reading }> };
  expect(body.readings.flatMap((reading) => reading.body.original_years)).toEqual(expect.arrayContaining([
    { original_id: datedPhoto.originalId, year: FIRST_SLICE.eventYear }, { original_id: undatedPhoto.originalId, year: null },
    { original_id: datedWord.originalId, year: FIRST_SLICE.eventYear }, { original_id: undatedText.originalId, year: null },
  ]));
  for (const [original, target, value] of [
    [datedPhoto, "content", FIRST_SLICE.dutyText], [undatedPhoto, "place", FIRST_SLICE.previousPlace],
    [datedWord, "due", FIRST_SLICE.reportText], [undatedText, "rain_plan", FIRST_SLICE.rainAnnouncement],
  ] as const) {
    const change = await callTool(env, ward.wardId, "write_change", {
      ticket, kind: "item", original_id: original.originalId, locator: FIRST_SLICE.previousLocator,
      // 繋げる AI が別の原本の年を誤って渡しても、出どころの原本の年だけを使う。
      year: FIRST_SLICE.eventYear, target, data: { value }, confidence: "high",
    });
    expect(change.isError).toBeUndefined();
    expect(JSON.parse(change.content[0]!.text)).toMatchObject({ status: "applied" });
  }
  const state = await getProjectState(env.DB, ward.wardId, project.projectId);
  expect(state?.items.find((item) => item.key === "content")?.current).toMatchObject({ content: FIRST_SLICE.dutyText });
  expect(state?.items.find((item) => item.key === "due")?.current).toMatchObject({ content: FIRST_SLICE.reportText });
  for (const [target, original, value] of [
    ["place", undatedPhoto, FIRST_SLICE.previousPlace], ["rain_plan", undatedText, FIRST_SLICE.rainAnnouncement],
  ] as const) {
    const item = state?.items.find((entry) => entry.key === target);
    expect(item?.current).toBeNull();
    expect(item?.references).toHaveLength(1);
    expect(item?.references[0]).toMatchObject({ content: value, refYear: null, source: { ref: original.originalId, year: null } });
  }
});
