import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { readOriginals } from "../src/ai/read";
import type { Reading } from "../src/ai/schema";
import { suggestProjects } from "../src/ai/suggest";
import { seedAdmin } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import { receive } from "../src/intake/receive";
import { getReadings, listOriginals } from "../src/intake/store";
import { pendingMaterialGroups } from "../src/intake/groups";
import { applyWardReading } from "../src/know/apply";
import { makeOriginalDateZip } from "./fixtures/original-dates";
import { get, realApp } from "./helpers";

function response(body: unknown) {
  return Response.json({ id: "test-reading", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn", stop_sequence: null,
    content: [{ type: "text", text: JSON.stringify(body) }], usage: { input_tokens: 100, output_tokens: 100 } });
}

interface ModelRequest {
  system: string;
  messages: { content: string }[];
  output_config: { format: { schema: { properties: Record<string, { description: string }> } } };
}

function checkInstructions(request: Pick<ModelRequest, "output_config">) {
  for (const field of ["project_suggestions", "ward_facts", "year_entries"]) {
    const description = request.output_config.format.schema.properties[field]!.description;
    expect(description).toContain("個人の家計簿");
    expect(description).toContain("買い物のメモ");
    expect(description).toContain("残します");
  }
}

it("Excelの家計簿を二度送り、個人の買い物のメモも送っても、資料と表を残し、基本情報と一年の予定には入れない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const personalIds: string[] = [];
  const jobIds: string[] = [];
  let calls = 0;
  const definitions = [
    { filename: "家計簿.xlsx", name: "個人の家計簿", rows: [["11月1日", "食費", "1200"]], personal: true },
    { filename: "家計簿.xlsx", name: "個人の家計簿", rows: [["11月1日", "食費", "1200"]], personal: true },
    { filename: "買い物のメモ.xlsx", name: "個人の買い物のメモ", rows: [["牛乳", "たまご", "玉ねぎ"]], personal: true },
    { filename: "自治会の会計.xlsx", name: "自治会の会計", rows: [["予算と決算は総会で報告する"]], personal: false },
    { filename: "年間の予定.xlsx", name: "自治会の年間の予定", rows: [["5月", "清掃"]], personal: false },
  ];
  for (const [index, definition] of definitions.entries()) {
    // 保存情報だけ違う再送を用意する。家計簿の表は一度目と同じ。
    const bytes = await makeOriginalDateZip({ "xl/workbook.xml": `<workbook><sheets><sheet name="${definition.name}"/></sheets></workbook>`,
      "docProps/core.xml": `<coreProperties><revision>${index + 1}</revision></coreProperties>` }, false);
    const received = await receive(env, { wardId: ward.wardId, projectId: null, via: "admin", accountId: account.accountId,
      parts: [{ kind: "file", filename: definition.filename, mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes,
        extracted: { format: "xlsx", paragraphs: [], tables: [{ name: definition.name, rows: definition.rows }] } }] });
    expect(received.received).toHaveLength(1);
    const jobId = received.jobId!;
    jobIds.push(jobId);
    const originalId = received.received[0]!.originalId;
    if (definition.personal) personalIds.push(originalId);
    const before = (await getReadings(env.DB, ward.wardId, jobId))[0]!.body;
    if (!("fields" in before)) throw new Error("表を読み取れませんでした");
    const expected = { project_suggestions: [],
      ward_facts: index === 3 ? [{ original_id: originalId, topic: "accounts", text: definition.rows[0]![0]! }] : [],
      year_entries: index === 4 ? [{ original_id: originalId, title: "清掃", month: 5, date_text: "5月" }] : [] };
    const client = new Anthropic({ apiKey: "test-only", maxRetries: 0, fetch: async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init?.body)) as ModelRequest;
      checkInstructions(request);
      expect(request.messages[0]!.content).toContain(definition.name);
      return response(expected);
    } });
    const suggested = await suggestProjects(client, before, [{ original_id: originalId, filename: definition.filename }]);
    expect(suggested.wardFacts).toEqual(expected.ward_facts);
    expect(suggested.yearEntries).toEqual(expected.year_entries);
    expect(suggested.suggestions).toHaveLength(0);
    const body: Reading = { ...before, project_suggestions: suggested.suggestions, ward_facts: suggested.wardFacts, year_entries: suggested.yearEntries };
    await env.DB.prepare("UPDATE readings SET body = ? WHERE ward_id = ? AND job_id = ? AND source = 'direct'")
      .bind(JSON.stringify(body), ward.wardId, jobId).run();
    await applyWardReading(env.DB, ward.wardId, body);
    expect((await getReadings(env.DB, ward.wardId, jobId))[0]!.body).toEqual(body);
    expect(body.tables).toEqual(before.tables);
    expect(body.tables[0]!.rows.map((row) => row.cells)).toEqual(definition.rows);
    const originals = await listOriginals(env.DB, ward.wardId, jobId);
    expect(originals).toHaveLength(1);
    expect(originals[0]).toMatchObject({ original_id: originalId, withdrawn_at: null });
    const stored = await new WardBucket(env.ORIGINALS, ward.wardId).get(originals[0]!.r2_path!);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);
  }
  expect(calls).toBe(5);
  const links = await env.DB.prepare("SELECT original_id FROM ward_material_links WHERE ward_id = ? AND target_kind = 'know_item'")
    .bind(ward.wardId).all<{ original_id: string }>();
  expect(links.results).toHaveLength(1);
  expect(personalIds).not.toContain(links.results[0]!.original_id);
  const know = await env.DB.prepare("SELECT body FROM ward_know_items WHERE ward_id = ? AND item_id = 'accounts'")
    .bind(ward.wardId).first();
  expect(know).toEqual({ body: "予算と決算は総会で報告する" });
  const year = await env.DB.prepare("SELECT title, source_original_id FROM ward_year_items WHERE ward_id = ? AND source_original_id IS NOT NULL")
    .bind(ward.wardId).all<{ title: string; source_original_id: string }>();
  expect(year.results).toHaveLength(1);
  expect(year.results[0]!.title).toBe("清掃");
  expect(personalIds).not.toContain(year.results[0]!.source_original_id);
  const groups = await pendingMaterialGroups(env.DB, ward.wardId);
  expect(groups.flatMap((group) => group.materials).filter((material) => personalIds.includes(material.original.original_id))).toHaveLength(3);
  expect(groups.filter((group) => group.title)).toHaveLength(0);
  const page = await (await get(realApp, `/${ward.slug}/admin/intake/read`, cookie)).text();
  expect(page).toContain("次の3件は、AIが読みましたが、どの準備の資料か分かりませんでした。");
  const used = page.match(/「[^<]*自治会の基本情報と一年の予定に入れました。/)?.[0];
  expect(used).toBeDefined();
  expect(used).toContain("自治会の会計.xlsx");
  expect(used).toContain("年間の予定.xlsx");
  expect(used).not.toContain("家計簿");
  expect(used).not.toContain("買い物のメモ");
  for (const jobId of jobIds.slice(0, 3)) expect(page).toContain(`value="${jobId}"`);
});

it.each(["general", "restore"] as const)("%sの指示でも個人資料を外し、自治会の会計と予定を一緒に読んでも取り違えない", async (kind) => {
  const body: Reading = { document_kind: "other", summary: "個人の家計簿と自治会の資料", original_years: [],
    project_suggestions: [{ original_id: "event", title: "清掃", year_item: "cleaning", date_text: "5月10日", place: "集会所" }],
    ward_facts: [{ original_id: "accounts", topic: "accounts", text: "自治会の決算は総会で報告する" }],
    year_entries: [{ original_id: "year", title: "清掃", month: 5, date_text: "5月10日" }],
    text_blocks: [{ original_id: "personal", locator: "題", text: "個人の家計簿" }], fields: [],
    tables: [{ original_id: "personal", locator: "表", name: "家計簿", columns: ["日付", "食費"], rows: [{ cells: ["11月1日", "1200"], confidence: "high", locator: "1行目" }] }],
    decisions: [], unreadable: [] };
  const client = new Anthropic({ apiKey: "test-only", maxRetries: 0, fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as Pick<ModelRequest, "system" | "output_config">;
    expect(request.system).toContain("個人の家計簿、買い物のメモ");
    expect(request.system).toContain("project_suggestions、ward_facts、year_entriesのどれにも入れません");
    expect(request.system).toContain("繰り返し送られても");
    checkInstructions(request);
    return response(body);
  } });
  const result = await readOriginals(client, { kind, originals: ["personal", "accounts", "year", "event"].map((originalId, index) => ({
    originalId, filename: `${originalId}.jpg`, position: index + 1, mediaType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) })) });
  expect(result.body).toMatchObject({ project_suggestions: body.project_suggestions, ward_facts: body.ward_facts,
    year_entries: body.year_entries, tables: body.tables, text_blocks: body.text_blocks });
});
