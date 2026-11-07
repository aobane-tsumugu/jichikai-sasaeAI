import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { setClientFactory } from "../src/ai/deps";
import { GENERAL_READING_SCHEMA, type ProjectSuggestion, type Reading } from "../src/ai/schema";
import { seedAdmin } from "../src/core/testing";
import { materialGroupTemplate, pendingMaterialGroups } from "../src/intake/groups";
import { yearItemsForStart } from "../src/know/year";
import { createProject, getProjectState, listProjects } from "../src/project/api";
import { normalizeStartTitle, startTemplate } from "../src/project/start-template";
import { get, postForm, realApp } from "./helpers";

// このファイルの自治会、資料、名前、日付はすべて試験用の架空のデータ。
afterEach(() => setClientFactory(null));

async function saveReading(wardId: string, accountId: string, sources: {
  title: string; yearItem?: string; kind?: ProjectSuggestion["kind"]; documentKind?: Reading["document_kind"]; columns?: string[];
}[]) {
  const now = new Date().toISOString();
  // 原本ごとに一回の読み。別々に届いても同じ予定の資料はまとまる。
  for (const source of sources) {
    const jobId = crypto.randomUUID(), originalId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO jobs (job_id, ward_id, via, read_kind, sender_label, account_id, status, created_at, updated_at, read_at)
      VALUES (?, ?, 'admin', 'general', '試験用', ?, 'read', ?, ?, ?)`)
      .bind(jobId, wardId, accountId, now, now, now).run();
    await env.DB.prepare(`INSERT INTO originals (original_id, ward_id, job_id, position, filename, kind, media_type, content_hash, byte_size, received_at)
      VALUES (?, ?, ?, 1, ?, 'text', 'text/plain', ?, 1, ?)`)
      .bind(originalId, wardId, jobId, `${source.title}.txt`, originalId, now).run();
    const reading: Reading = {
      document_kind: source.documentKind ?? "announcement", summary: source.title,
      original_years: [{ original_id: originalId, year: 2025 }],
      project_suggestions: [{ original_id: originalId, title: source.title,
        ...(source.yearItem !== undefined ? { year_item: source.yearItem } : {}), ...(source.kind ? { kind: source.kind } : {}) }],
      text_blocks: [{ original_id: originalId, locator: "全文", text: source.title }],
      fields: [], tables: source.columns ? [{ name: "試験用の表", original_id: originalId, locator: "表", columns: source.columns,
        rows: [{ cells: ["12月20日", "一班", "試験一郎"], locator: "1行目", confidence: "high" }] }] : [], decisions: [], unreadable: [],
    };
    await env.DB.prepare(`INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at)
      VALUES (?, ?, ?, 'model', 'fixture@1', 'fixture', ?, ?)`)
      .bind(crypto.randomUUID(), wardId, jobId, JSON.stringify(reading), now).run();
  }
}

async function start(ward: { wardId: string; slug: string }, cookie: string, eventDay: string) {
  setClientFactory(() => { throw new Error("試験では実際のAIへ接続しません"); });
  const groups = await pendingMaterialGroups(env.DB, ward.wardId);
  expect(groups).toHaveLength(1);
  const response = await postForm(realApp, `/${ward.slug}/admin/intake/start`, { group: groups[0]!.key, eventDay, kind: "general_meeting" }, cookie);
  expect(response.status).toBe(303);
  const id = response.headers.get("location")?.split("/").at(-1);
  if (!id) throw new Error("始めた準備がありません");
  const state = await getProjectState(env.DB, ward.wardId, id);
  if (!state) throw new Error("始めた準備の中身がありません");
  return state;
}

it("年の前置き、文書の名前の後ろ、空白と記号を外して予定と比べ、種類は新しい読みの形に含めない", () => {
  expect(normalizeStartTitle("2025年度_秋の収穫祭のご案内")).toBe("秋の収穫祭");
  expect(normalizeStartTitle("２０２５年度　秋・の収穫祭のお知らせ")).toBe("秋の収穫祭");
  expect(normalizeStartTitle("2025年 秋の収穫祭の案内")).toBe("秋の収穫祭");
  const schema = GENERAL_READING_SCHEMA.properties.project_suggestions.items;
  expect(schema.required).toContain("year_item");
  expect(schema.properties).not.toHaveProperty("kind");
  expect(startTemplate("秋の収穫祭の会計").from).toBe("short");
  expect(startTemplate("2025年度_秋の収穫祭のご案内", [], [{ key: "autumn", title: "秋の収穫祭" }]))
    .toMatchObject({ kind: "event", from: "year_plan", yearItemTitle: "秋の収穫祭" });
});

it("一年の行に当てた資料はその行の型で始まり、古いkindと送信されたkindは使わない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  await env.DB.prepare("INSERT INTO ward_year_items (ward_id, item_id, title) VALUES (?, 'autumn', '秋の収穫祭')").bind(ward.wardId).run();
  await saveReading(ward.wardId, account.accountId, [{ title: "2025年度_秋の収穫祭のご案内", yearItem: "autumn", kind: "city_request" }]);
  const read = await (await get(realApp, `/${ward.slug}/admin/intake/read`, cookie)).text();
  expect(read).toContain("一年の予定の「秋の収穫祭」のやることを置きます");
  expect(read).not.toContain('name="kind"');
  const state = await start(ward, cookie, "2026-10-18");
  expect(state.project.kind).toBe("event");
  expect(state.mapTasks.map((task) => task.taskKey)).toEqual(["committee", "venue", "sponsors", "announcement", "answers", "duty_roster", "day", "report"]);
  expect(await pendingMaterialGroups(env.DB, other.ward.wardId)).toHaveLength(0);
  expect(await getProjectState(env.DB, other.ward.wardId, state.project.projectId)).toBeNull();
});

it("去年終わった同じ予定の仕事を、今年の当日に合わせて写し、去年の記録は変えない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  await env.DB.prepare("INSERT INTO ward_year_items (ward_id, item_id, title) VALUES (?, 'autumn', '秋の収穫祭')").bind(ward.wardId).run();
  const seed = await createProject(env.DB, ward.wardId, { title: "2025年度 秋の収穫祭", kind: "event", year: 2025, eventDay: "2025-10-19", taskKeys: ["announcement", "day", "report"] });
  await env.DB.prepare("UPDATE projects SET closed_at = ? WHERE ward_id = ? AND project_id = ?").bind("2025-11-01T00:00:00Z", ward.wardId, seed.projectId).run();
  await env.DB.prepare("UPDATE project_map_tasks SET name = '去年から引き継ぐ案内' WHERE ward_id = ? AND project_id = ? AND task_key = 'announcement'").bind(ward.wardId, seed.projectId).run();
  await saveReading(ward.wardId, account.accountId, [{ title: "収穫の集まりのご案内", yearItem: "秋の収穫祭" }]);
  expect(await (await get(realApp, `/${ward.slug}/admin/intake/read`, cookie)).text()).toContain("去年のやることを、今年の日に合わせて置き直します");
  const state = await start(ward, cookie, "2026-10-18");
  expect(state.mapTasks.map((task) => task.taskKey)).toEqual(["announcement", "day", "report"]);
  expect(state.mapTasks[0]).toMatchObject({ name: "去年から引き継ぐ案内", periodStart: "2026-09-03", periodEnd: "2026-09-18" });
  expect((await getProjectState(env.DB, ward.wardId, seed.projectId))?.project.deadlines.event_day).toBe("2025-10-19");
});

it("一年のどこにも当たらない資料とkindだけの古い読みは短い一般の型で始められる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  await saveReading(ward.wardId, account.accountId, [{ title: "町内の防犯灯の交換", kind: "city_request" }]);
  const read = await (await get(realApp, `/${ward.slug}/admin/intake/read`, cookie)).text();
  expect(read).toContain("知らせる、当日、まとめるの三つだけのやることで始めます");
  expect((await start(ward, cookie, "2026-12-20")).mapTasks.map((task) => task.taskKey)).toEqual(["announcement", "day", "report"]);
});

it.each(["rota", "other"] as const)("年末の知らせと当番表を%sとして読むと、今年は短い型に担当の仕事だけを足す", async (documentKind) => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  await env.DB.prepare("INSERT INTO ward_year_items (ward_id, item_id, title, added) VALUES (?, 'watch', '年末の見回り', 1)").bind(ward.wardId).run();
  await saveReading(ward.wardId, account.accountId, [
    { title: "2025年度_年末の見回りのお知らせ", yearItem: "watch" },
    { title: "2025年度_年末の見回りの当番表", yearItem: "年末の見回り", documentKind,
      ...(documentKind === "other" ? { columns: ["日", "班", "担当"] } : {}) },
  ]);
  const groups = await pendingMaterialGroups(env.DB, ward.wardId);
  expect(groups).toHaveLength(1);
  expect(groups[0]!.materials).toHaveLength(2);
  const template = materialGroupTemplate(groups[0]!, await listProjects(env.DB, ward.wardId, { includeClosed: true }), await yearItemsForStart(env.DB, ward.wardId));
  expect(template.yearItemTitle).toBe("年末の見回り");
  const read = await (await get(realApp, `/${ward.slug}/admin/intake/read`, cookie)).text();
  expect(read).toContain("担当を決める");
  const state = await start(ward, cookie, "2026-12-20");
  expect(state.project.year).toBe(2026);
  expect(state.mapTasks.map((task) => task.taskKey)).toEqual(["announcement", "assign", "day", "report"]);
  expect(state.mapTasks[1]).toMatchObject({ name: "担当を決める", periodStart: "2026-11-29", periodEnd: "2026-12-13" });
});

it("外した行と別の自治会の行を候補にせず、知らない印から種類を推測しない", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  await env.DB.prepare("INSERT INTO ward_year_items (ward_id, item_id, removed_at) VALUES (?, 'autumn', ?)").bind(ward.wardId, new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO ward_year_items (ward_id, item_id, title, added) VALUES (?, 'other-only', '別の自治会の予定', 1)").bind(other.ward.wardId).run();
  const candidates = await yearItemsForStart(env.DB, ward.wardId);
  expect(candidates.some((item) => item.key === "autumn" || item.key === "other-only")).toBe(false);
  expect(candidates.some((item) => item.key === "general-meeting")).toBe(true);
  await saveReading(ward.wardId, account.accountId, [{ title: "秋の行事", yearItem: "autumn", kind: "event" }]);
  const group = (await pendingMaterialGroups(env.DB, ward.wardId))[0]!;
  expect(group.yearItem).toBeUndefined();
  expect(materialGroupTemplate(group, [], candidates).from).toBe("short");
});

it("同じ名前の行事の資料は、AI が当てた一年の予定の行が違っても一つにまとまり、自治会の行を優先する", async () => {
  // 年間の予定の写真を読む前は型の行（秋の行事）、読んだ後は自治会の行（秋の収穫祭）が当たる。試験用のデータ。
  const { ward, account } = await seedAdmin(env.DB);
  await env.DB.prepare("INSERT INTO ward_year_items (ward_id, item_id, title, added) VALUES (?, 'ward-harvest', '秋の収穫祭', 1)").bind(ward.wardId).run();
  await saveReading(ward.wardId, account.accountId, [
    { title: "2025年度 秋の収穫祭", yearItem: "autumn" },
    { title: "秋の収穫祭", yearItem: "ward-harvest" },
    { title: "秋の収穫祭の当番表", yearItem: "ward-harvest" },
  ]);
  const groups = (await pendingMaterialGroups(env.DB, ward.wardId)).filter((group) => group.title);
  expect(groups).toHaveLength(1);
  expect(groups[0]!.materials).toHaveLength(3);
  expect(groups[0]!.yearItem).toBe("ward-harvest");
});

it("列の名前が「担当の世帯」のような当番表でも、短い型に「担当を決める」を足す", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  await env.DB.prepare("INSERT INTO ward_year_items (ward_id, item_id, title, added) VALUES (?, 'ward-patrol', '年末の見回り', 1)").bind(ward.wardId).run();
  await saveReading(ward.wardId, account.accountId, [
    { title: "年末の見回りの当番表", yearItem: "ward-patrol", documentKind: "other", columns: ["日", "回る班", "担当の世帯"] },
  ]);
  const [group] = (await pendingMaterialGroups(env.DB, ward.wardId)).filter((entry) => entry.title);
  const template = materialGroupTemplate(group!, await listProjects(env.DB, ward.wardId, { includeClosed: true }), await yearItemsForStart(env.DB, ward.wardId));
  expect(template.taskKeys).toEqual(["announcement", "assign", "day", "report"]);
});
