import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Reading } from "../src/ai/schema";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { applyWardReading } from "../src/know/apply";
import { wardYear } from "../src/know/year";
import { weeklyRota } from "../src/rota/schedule";
import type { Exemption } from "../src/rota/store";

it("53回の月曜がある年も全部割り当て、免除の始めと終わりの日だけ飛ばす", () => {
  // 世帯と免除は架空。自治会の一年は4月から翌年3月。2024年4月1日と2025年3月31日はどちらも月曜になる。
  const roster = [{ household: "一世帯", district: "1班" }, { household: "二世帯", district: "1班" }];
  const exemption: Exemption = { ...roster[0]!, exemption_id: "weekly-fictional", reason: "一時的に休む",
    starts_on: "2024-04-01", ends_on: "2024-04-08", recorded_at: "2024-03-01T00:00:00Z", withdrawn_at: null };
  const rows = weeklyRota(2024, 1, roster, [exemption]);
  expect(rows).toHaveLength(53);
  expect(rows[0]?.data.slot).toBe("2024-04-01");
  expect(rows.at(-1)?.data.slot).toBe("2025-03-31");
  expect(rows.slice(0, 4).map((row) => row.data.assignee)).toEqual(["二世帯", "二世帯", "一世帯", "二世帯"]);
  expect(rows.every((row) => new Date(String(row.data.slot)).getUTCDay() === 1)).toBe(true);
  expect(weeklyRota(2024, 1, roster, [{ ...exemption, withdrawn_at: "2024-04-01T00:00:00Z" }])[0]?.data.assignee).toBe("一世帯");
  const allExempt = weeklyRota(2024, 1, roster, roster.map((entry, index) => ({ ...exemption, ...entry, exemption_id: `weekly-${index}`, ends_on: "2025-03-31" })));
  expect(allExempt).toHaveLength(53);
  expect(allExempt.every((row) => row.data.assignee === "" && row.explanation.includes("担当できる世帯がありません"))).toBe(true);
});

it("届いた通年の予定は月がなくても保存し、同じ資料を読み直しても予定を増やさない", async () => {
  const { ward } = await seedAdmin(env.DB);
  const received = await receive(env, { wardId: ward.wardId, via: "admin", parts: [{ kind: "text", filename: "一年の進め方.txt", mediaType: "text/plain",
    bytes: new TextEncoder().encode("ごみ当番は毎週月曜。市報の配布は毎月。") }] });
  const originalId = received.received[0]?.originalId;
  if (!originalId) throw new Error("見本の資料がありません");
  const body: Reading = { document_kind: "year_plan", original_years: [], summary: "一年の進め方", fields: [], tables: [], decisions: [], unreadable: [], text_blocks: [],
    year_entries: [{ original_id: originalId, title: "ごみ当番", month: null, date_text: "毎週月曜" }, { original_id: originalId, title: "市報の配布", month: 4, date_text: "毎月" }] };
  await applyWardReading(env.DB, ward.wardId, body);
  await applyWardReading(env.DB, ward.wardId, body);
  const saved = await env.DB.prepare("SELECT title, month, recurrence_text FROM ward_year_items WHERE ward_id = ? ORDER BY title")
    .bind(ward.wardId).all<{ title: string; month: number | null; recurrence_text: string }>();
  expect(saved.results).toHaveLength(2);
  expect(saved.results.every((row) => row.month === null && row.recurrence_text)).toBe(true);
  const table = await wardYear(env.DB, ward, [], [], "2026-11-08");
  expect(table.rows.find((row) => row.title === "ごみ当番")).toMatchObject({ from: 0, to: 100, note: "毎週月曜。資料1件が入っています。" });
  expect(table.rows.find((row) => row.title === "市報の配布")).toMatchObject({ from: 0, to: 100, note: "毎月。資料1件が入っています。" });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE ward_id = ?").bind(ward.wardId).first<number>("n")).toBe(0);
});
