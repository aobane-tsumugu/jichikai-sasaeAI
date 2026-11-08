import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { packVersionFor, readOriginals, systemFor } from "../src/ai/read";
import { READ_PACK_VERSION, type Reading } from "../src/ai/schema";
import { SUGGEST_PACK_VERSION, suggestProjects } from "../src/ai/suggest";
import { seedAdmin } from "../src/core/testing";
import { pendingMaterialGroups } from "../src/intake/groups";
import { getReadings } from "../src/intake/store";
import { applyWardReading } from "../src/know/apply";
import { get, realApp } from "./helpers";

// 資料の中身とAIの応答は試しのデータ。通信を代え、実際のAIの認識精度とは分けて確かめる。
function expectExclusions(system: string) {
  expect(system).toContain("自治会の年間の予定そのもの（一年の行事の一覧の表や写真）はproject_suggestionsに入れません");
  expect(system).toContain("一つの準備の資料ではなく、一年の予定（ward_year_items）に入れる資料なので、中身はyear_entriesに残してください");
  expect(system).toContain("ほかの町や団体が主催し、この自治会が準備しない行事のチラシや案内");
  expect(system).toContain("町外の夏祭りのチラシ」）はproject_suggestionsに入れません");
  expect(system).toContain("この自治会が準備する行事ではないためです");
  expect(system).toContain("一年の予定の候補に似た名前があってもyear_itemを当てず、参考の資料として");
}

function modelResponse(body: unknown) {
  return Response.json({ id: "fixture-reading", type: "message", role: "assistant", model: "claude-sonnet-5-5",
    stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text: JSON.stringify(body) }],
    usage: { input_tokens: 100, output_tokens: 100 } });
}

function readingFor(originalId: string, source: "year" | "outside" | "local"): Reading {
  const title = source === "year" ? "年間の予定" : source === "outside" ? "町外の夏祭り" : "秋の収穫祭";
  const text = source === "year" ? "4月 総会、10月 秋の収穫祭" : source === "outside" ? "主催はほかの町の団体。8月15日に夏祭りを開きます。" : "この自治会の秋の収穫祭を10月18日に開きます。";
  return {
    document_kind: source === "year" ? "year_plan" : "announcement", summary: `${title}の資料です。`,
    original_years: [{ original_id: originalId, year: 2026 }],
    // 対象外の二つには候補がなく、この自治会の行事には候補がある応答を使う。
    project_suggestions: source === "local" ? [{ original_id: originalId, title, year_item: "autumn", date_text: "10月18日", place: "" }] : [],
    year_entries: source === "year" ? [
      { original_id: originalId, title: "総会", month: 4, date_text: "4月" },
      { original_id: originalId, title: "秋の収穫祭", month: 10, date_text: "10月" },
    ] : [],
    text_blocks: [{ original_id: originalId, locator: "本文", text }],
    fields: [], tables: source === "year" ? [{ original_id: originalId, locator: "一覧", name: title, columns: ["月", "行事"],
      rows: [{ cells: ["4月", "総会"], locator: "1行目", confidence: "high" }, { cells: ["10月", "秋の収穫祭"], locator: "2行目", confidence: "high" }] }] : [],
    decisions: [], unreadable: [],
  };
}

it.each(["general", "restore"] as const)("%sの読みの指示は年間の予定とほかの団体の行事を候補から外す理由を含む", (kind) => {
  expectExclusions(systemFor(kind));
  expect(packVersionFor(kind)).toBe(kind === "general" ? "read-general@6" : "read-restore@6");
  expect(packVersionFor(kind)).toBe(READ_PACK_VERSION[kind]);
});

it("文字やWord・Excelの指示も二つを候補から外し、一回の呼び出しで通常の候補と一年の予定を残す", async () => {
  const originals = [
    { original_id: "year", filename: "年間の予定.xlsx" },
    { original_id: "outside", filename: "町外の夏祭りのチラシ.docx" },
    { original_id: "local", filename: "秋の収穫祭.txt" },
  ];
  const readings = [readingFor("year", "year"), readingFor("outside", "outside"), readingFor("local", "local")];
  const reading: Reading = { ...readings[0]!, text_blocks: readings.flatMap((body) => body.text_blocks) };
  const suggestions = readings.flatMap((body) => body.project_suggestions ?? []);
  const yearEntries = readings.flatMap((body) => body.year_entries ?? []);
  let calls = 0;
  const client = new Anthropic({ apiKey: "fixture-not-a-real-key", maxRetries: 0, fetch: async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body)) as { system: string; messages: { content: string }[] };
    expectExclusions(request.system);
    expect(request.messages[0]!.content).toContain("主催はほかの町の団体");
    return modelResponse({ project_suggestions: suggestions, ward_facts: [], year_entries: yearEntries });
  } });
  const result = await suggestProjects(client, reading, originals, [{ key: "summer", title: "夏祭り" }, { key: "autumn", title: "秋の収穫祭" }]);
  expect(calls).toBe(1);
  expect(result.suggestions).toEqual(suggestions);
  expect(result.suggestions).toHaveLength(1);
  expect(result.yearEntries).toEqual(yearEntries);
  expect(result.yearEntries).toHaveLength(2);
  expect(SUGGEST_PACK_VERSION).toBe("suggest-project@3");
});

it("年間の予定の写真と町外のチラシに候補がない読みを保存すると、画面には通常の行事だけが準備の候補に出る", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const sources = [
    { key: "year", filename: "年間の予定の写真.jpg" },
    { key: "outside", filename: "町外の夏祭りのチラシ.jpg" },
    { key: "local", filename: "秋の収穫祭の案内.jpg" },
  ] as const;
  let calls = 0;
  for (const source of sources) {
    const jobId = crypto.randomUUID(), originalId = crypto.randomUUID();
    const body = readingFor(originalId, source.key);
    const client = new Anthropic({ apiKey: "fixture-not-a-real-key", maxRetries: 0, fetch: async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init?.body)) as { system: string };
      expectExclusions(request.system);
      return modelResponse(body);
    } });
    const result = await readOriginals(client, { kind: "general", yearItems: [{ key: "summer", title: "夏祭り" }, { key: "autumn", title: "秋の収穫祭" }],
      originals: [{ originalId, filename: source.filename, position: 1, mediaType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) }] });
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO jobs (job_id, ward_id, via, read_kind, account_id, status, created_at, updated_at, read_at)
      VALUES (?, ?, 'admin', 'general', ?, 'read', ?, ?, ?)`)
      .bind(jobId, ward.wardId, account.accountId, now, now, now).run();
    await env.DB.prepare(`INSERT INTO originals (original_id, ward_id, job_id, position, filename, kind, media_type, content_hash, byte_size, received_at)
      VALUES (?, ?, ?, 1, ?, 'photo', 'image/jpeg', ?, 3, ?)`)
      .bind(originalId, ward.wardId, jobId, source.filename, originalId, now).run();
    await env.DB.prepare(`INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at)
      VALUES (?, ?, ?, 'model', ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), ward.wardId, jobId, result.packVersion, result.model, JSON.stringify(result.body), now).run();
    await applyWardReading(env.DB, ward.wardId, result.body);
    const saved = await getReadings(env.DB, ward.wardId, jobId);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.body).toEqual(result.body);
    expect(saved[0]!.pack_version).toBe("read-general@6");
    expect(saved[0]!.body).toMatchObject({ text_blocks: body.text_blocks });
  }
  expect(calls).toBe(3);
  const groups = await pendingMaterialGroups(env.DB, ward.wardId);
  expect(groups.filter((group) => group.title).map((group) => group.title)).toEqual(["秋の収穫祭"]);
  expect(groups.flatMap((group) => group.materials)).toHaveLength(3);
  const response = await get(realApp, `/${ward.slug}/admin/intake/read`, cookie);
  expect(response.status).toBe(200);
  const page = await response.text();
  expect(page).toContain("秋の収穫祭の資料のようです</h2>");
  expect(page).not.toContain("年間の予定の資料のようです</h2>");
  expect(page).not.toContain("町外の夏祭りの資料のようです</h2>");
  expect(page).toContain("年間の予定の写真.jpg");
  expect(page).toContain("自治会の基本情報と一年の予定に入れました");
  expect(page).toContain("町外の夏祭りのチラシ.jpg");
  expect(page).toContain("どの準備の資料か分からなかったもの");
  const year = await env.DB.prepare("SELECT title, month FROM ward_year_items WHERE ward_id = ? AND source_original_id IS NOT NULL ORDER BY month")
    .bind(ward.wardId).all<{ title: string; month: number }>();
  expect(year.results).toEqual([{ title: "総会", month: 4 }, { title: "秋の収穫祭", month: 10 }]);
});
