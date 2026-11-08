import type Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { fictionalPaperPhoto } from "../fixtures/test-photo";
import { ANSWER_SHEET_SCHEMA, READ_PACK_VERSION, type AnswerSheetReading, type AnswerSheetRow } from "../src/ai/schema";
import { sheetFieldValues } from "../src/ai/read";
import { listAnswers } from "../src/answers/api";
import { addAnswerField, getAnswerFields, type AnswerField } from "../src/answers/fields";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { runRead } from "../src/intake/pipeline";
import { createProject } from "../src/project/api";
import { setSetting } from "../src/settings/store";
import { get, postForm, realApp } from "./helpers";

const days = ["12月26日（土）", "12月27日（日）", "12月28日（月）"];

async function setup(withFields = true) {
  const owner = await seedAdmin(env.DB);
  const { ward, account } = owner;
  await setSetting(env.DB, ward.wardId, "squads", JSON.stringify(["1班", "2班"]));
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "年末の見回り", year: 2026, accountId: account.accountId, eventDay: "2026-12-26",
  });
  if (withFields) {
    expect(await addAnswerField(env.DB, ward.wardId, project.projectId, "days", account.accountId, { options: days })).toBeTypeOf("string");
    expect(await addAnswerField(env.DB, ward.wardId, project.projectId, "text", account.accountId)).toBeTypeOf("string");
  }
  const fields = await getAnswerFields(env.DB, ward.wardId, project.projectId, ["1班", "2班"]);
  return { ...owner, project, fields, root: `/${ward.slug}/admin/answers/${project.projectId}` };
}

/** 外部APIの答えだけを固定し、写真の受付、読み取りの指示、保存、画面は製品の経路を使う。 */
async function readPhoto(s: Awaited<ReturnType<typeof setup>>, rows: Partial<AnswerSheetRow>[]) {
  const got = await receive(env, {
    wardId: s.ward.wardId, projectId: s.project.projectId, via: "admin", readKind: "answer_sheet", accountId: s.account.accountId,
    parts: [{ kind: "photo", filename: "年末の見回りの回答票.jpg", mediaType: "image/jpeg", bytes: fictionalPaperPhoto(crypto.randomUUID()) }],
  });
  if (!got.jobId || !got.received[0]) throw new Error("回答票を受け付けられませんでした。");
  const originalId = got.received[0].originalId;
  const reading: AnswerSheetReading = { summary: "年末の見回りの返事", unreadable: [], rows: rows.map((row, index) => ({
    household_name: `試験の世帯${index + 1}`, ward_group: "1班", children: 0, adults: 1, seniors: 0,
    not_attending: false, meeting_status: null, proxy_name: "", helper_names: [], helper_slots: [],
    note: "", confidence: "high", original_id: originalId, locator: `${index + 1}行目`, paper_code: "", ...row,
  })) };
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client = { messages: { create: async (request: Anthropic.MessageCreateParamsNonStreaming) => {
    requests.push(request);
    return { model: "fixture", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(reading) }],
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0 } };
  } } } as unknown as Anthropic;
  const deps = { createClient: () => client };
  expect(await runRead(env, s.ward.wardId, got.jobId, { deps })).toBe("read");
  expect(requests).toHaveLength(1);
  return { jobId: got.jobId, originalId, reading, requests, deps };
}

it("年末の見回りの写真から日と自由に書く欄を保存し、定義に無い日を外して、画面で日ごとに数える", async () => {
  const s = await setup();
  const day = s.fields.fields.find((field) => field.kind === "days")!;
  const text = s.fields.fields.find((field) => field.kind === "text")!;
  const photo = await readPhoto(s, [
    { adults: 2, children: 1, field_values: [
      { field_id: day.fieldId, values: [days[0]!, days[1]!, "12月29日（火）"] },
      { field_id: text.fieldId, values: ["20時に合流します"] },
      { field_id: "知らない欄", values: ["書き込まない"] },
    ] },
    { ward_group: "2班", field_values: [
      { field_id: day.fieldId, values: [days[1]!, days[1]!] }, { field_id: text.fieldId, values: [" "] },
    ] },
    // 人数だけ判読できない票も、読めた欄は手で人数を補ったときに同じ返事へ入る。
    { adults: null, field_values: [{ field_id: day.fieldId, values: [days[2]!, "12月29日（火）"] }, { field_id: text.fieldId, values: ["21時に合流します"] }] },
    // 欄を刷る前の古い票の読み取り（field_values自体が無い）。
    { household_name: "古い票の世帯" },
  ]);
  const request = photo.requests[0]!;
  const content = request.messages[0]!.content;
  if (!Array.isArray(content)) throw new Error("写真を渡す内容がありません。");
  const last = content[content.length - 1];
  if (last?.type !== "text") throw new Error("欄の定義を渡す文がありません。");
  expect(JSON.parse(last.text.split("\nこの準備の返事の欄の定義: ")[1]!)).toMatchObject(s.fields);
  expect(content.some((block) => block.type === "image")).toBe(true);
  expect(request.system).toContain("印の無い候補、読めない印は入れません");
  expect(request.system).toContain("紙に印字または記入された班の名前");
  expect(request.output_config?.format).toEqual({ type: "json_schema", schema: ANSWER_SHEET_SCHEMA });
  expect(unsupportedSchemaKeys(request.output_config?.format)).toEqual([]);

  let answers = await listAnswers(env.DB, s.ward.wardId, s.project.projectId);
  expect(answers).toHaveLength(3);
  expect(answers.find((answer) => answer.sheetRowIndex === 0)).toMatchObject({ peopleCount: 3, district: "1班",
    fieldValues: { [day.fieldId]: [days[0], days[1]], [text.fieldId]: "20時に合流します" } });
  expect(answers.find((answer) => answer.sheetRowIndex === 1)).toMatchObject({ peopleCount: 1, district: "2班", fieldValues: { [day.fieldId]: [days[1]] } });
  expect(answers.find((answer) => answer.sheetRowIndex === 3)?.fieldValues).toEqual({});
  expect(answers.find((answer) => answer.sheetRowIndex === 0)?.fieldValues).not.toHaveProperty("知らない欄");
  expect(answers.find((answer) => answer.sheetRowIndex === 1)?.fieldValues).not.toHaveProperty(text.fieldId);
  let summary = await (await get(realApp, s.root, s.cookie)).text();
  expect(summary).toContain("12月26日（土）は1世帯（3人）です。");
  expect(summary).toContain("12月27日（日）は2世帯（4人）です。");
  expect(summary).toContain("12月28日（月）は0世帯です。");

  const rowPath = `${s.root}/sheet/${photo.originalId}/row/2`;
  const counts = { household: "人数を直した世帯", district: "2班", attend: "yes", adults_count: "2", children_count: "0", seniors_count: "0" };
  expect((await postForm(realApp, rowPath, counts, s.cookie)).status).toBe(303);
  answers = await listAnswers(env.DB, s.ward.wardId, s.project.projectId);
  expect(answers).toHaveLength(4);
  const corrected = answers.find((answer) => answer.sheetRowIndex === 2)!;
  expect(corrected.fieldValues).toEqual({ [day.fieldId]: [days[2]], [text.fieldId]: "21時に合流します" });
  summary = await (await get(realApp, s.root, s.cookie)).text();
  expect(summary).toContain("12月28日（月）は1世帯（2人）です。");
  const list = await (await get(realApp, `${s.root}?view=list`, s.cookie)).text();
  expect(list).toContain("ひとこと: 21時に合流します");
  expect(list).not.toContain("12月29日（火）");

  // 役員が欄の答えを直した後は、行の再送信でも写真の読み直しでも上書きしない。
  expect((await postForm(realApp, `${s.root}/${corrected.answerId}/edit`, {
    ...counts, [`field_${day.fieldId}`]: days[0]!, [`field_${text.fieldId}`]: "役員が確認しました",
  }, s.cookie)).status).toBe(303);
  expect((await postForm(realApp, rowPath, counts, s.cookie)).status).toBe(303);
  expect((await listAnswers(env.DB, s.ward.wardId, s.project.projectId)).find((answer) => answer.answerId === corrected.answerId)?.fieldValues)
    .toEqual({ [day.fieldId]: [days[0]], [text.fieldId]: "役員が確認しました" });
  // 同じ写真をもう一度読む状態に戻し、AIの答えも変える。
  await env.DB.prepare("UPDATE jobs SET status = 'received', read_at = NULL WHERE ward_id = ? AND job_id = ?").bind(s.ward.wardId, photo.jobId).run();
  photo.reading.rows[2]!.adults = 2;
  photo.reading.rows[2]!.field_values = [{ field_id: day.fieldId, values: [days[1]!] }, { field_id: text.fieldId, values: ["読み直した文字"] }];
  expect(await runRead(env, s.ward.wardId, photo.jobId, { deps: photo.deps })).toBe("read");
  expect(photo.requests).toHaveLength(2);
  answers = await listAnswers(env.DB, s.ward.wardId, s.project.projectId);
  expect(answers).toHaveLength(4);
  expect(answers.find((answer) => answer.answerId === corrected.answerId)?.fieldValues)
    .toEqual({ [day.fieldId]: [days[0]], [text.fieldId]: "役員が確認しました" });
});

it("欄の定義が無い準備では従来の返事を保存し、AIが返した欄の答えは入れない", async () => {
  const s = await setup(false);
  await readPhoto(s, [
    { adults: 2, children: 1 },
    { ward_group: "2班", field_values: [{ field_id: "他の準備の欄", values: [days[0]!] }] },
  ]);
  const answers = await listAnswers(env.DB, s.ward.wardId, s.project.projectId);
  expect(answers).toHaveLength(2);
  expect(answers.find((answer) => answer.sheetRowIndex === 0)).toMatchObject({ peopleCount: 3, district: "1班", fieldValues: {} });
  expect(answers.find((answer) => answer.sheetRowIndex === 1)).toMatchObject({ peopleCount: 1, district: "2班", fieldValues: {} });
  for (const answer of answers) expect(answer.fieldValues).toEqual({});
  const summary = await (await get(realApp, s.root, s.cookie)).text();
  expect(summary).toContain("年末の見回り");
  expect(summary).not.toContain("12月26日（土）は");
});

it("一つだけ選ぶ欄の複数の印や候補外だけの答えを保存しない", () => {
  const field: AnswerField = { fieldId: "days", kind: "days", label: "参加できる日", options: days, multiple: false };
  const row: AnswerSheetRow = { household_name: "試験の世帯", ward_group: "", adults: 1, children: 0,
    helper_names: [], helper_slots: [], note: "", confidence: "high", original_id: "photo", locator: "1行目" };
  expect(sheetFieldValues({ ...row, field_values: [{ field_id: field.fieldId, values: [days[0]!, days[1]!] }] }, [field])).toEqual({});
  expect(sheetFieldValues({ ...row, field_values: [{ field_id: field.fieldId, values: ["12月29日（火）"] }] }, [field])).toEqual({});
  expect(sheetFieldValues({ ...row, field_values: [{ field_id: field.fieldId, values: [days[0]!] }] }, [field])).toEqual({ days: days[0] });
});

/** APIが受け付けない指定を、入れ子と配列の中まで調べる。 */
function unsupportedSchemaKeys(node: unknown, path = "schema"): string[] {
  if (!node || typeof node !== "object") return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "minItems" && typeof value === "number" && value > 1) found.push(`${path}.${key}`);
    if (["maxItems", "minLength", "maxLength", "minimum", "maximum", "multipleOf"].includes(key)) found.push(`${path}.${key}`);
    if (key === "type" && Array.isArray(value)) found.push(`${path}.${key}`);
    found.push(...unsupportedSchemaKeys(value, `${path}.${key}`));
  }
  return found;
}

it("回答票の形の決まりは欄の答えを含み、構造化出力が受け付ける指定だけを使う", () => {
  expect(READ_PACK_VERSION.answer_sheet).toBe("read-answer-sheet@8");
  expect(ANSWER_SHEET_SCHEMA.properties.rows.items.required).toContain("field_values");
  expect(ANSWER_SHEET_SCHEMA.properties.rows.items.properties.field_values.items).toEqual({
    type: "object", additionalProperties: false, required: ["field_id", "values"],
    properties: { field_id: { type: "string" }, values: { type: "array", items: { type: "string" } } },
  });
  expect(unsupportedSchemaKeys(ANSWER_SHEET_SCHEMA)).toEqual([]);
});
