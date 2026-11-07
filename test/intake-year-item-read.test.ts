import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { readOriginals } from "../src/ai/read";
import { cleanProjectSuggestions, type Reading } from "../src/ai/schema";
import { seedAdmin } from "../src/core/testing";
import { yearItemsForStart } from "../src/know/year";

it("写真の一回の読みの中で、この自治会の一年の候補から行を当て、kindなしの応答を保つ", async () => {
  const { ward } = await seedAdmin(env.DB);
  await env.DB.prepare("INSERT INTO ward_year_items (ward_id, item_id, title, added) VALUES (?, 'watch', '年末の見回り', 1)").bind(ward.wardId).run();
  await env.DB.prepare("INSERT INTO ward_year_items (ward_id, item_id, removed_at) VALUES (?, 'summer', ?)").bind(ward.wardId, new Date().toISOString()).run();
  const candidates = await yearItemsForStart(env.DB, ward.wardId);
  const body: Reading = {
    document_kind: "announcement", summary: "試験用の年末の見回り", original_years: [{ original_id: "fixture-original", year: 2025 }],
    project_suggestions: [{ original_id: "fixture-original", title: "2025年度_年末の見回りのお知らせ", year_item: "watch", date_text: "12月20日", place: "" }],
    text_blocks: [{ original_id: "fixture-original", locator: "題", text: "年末の見回りのお知らせ" }], fields: [], tables: [], decisions: [], unreadable: [],
  };
  let calls = 0;
  const client = new Anthropic({ apiKey: "fixture-not-a-real-key", maxRetries: 0, fetch: async (_url, init) => {
    calls += 1;
    const request = JSON.parse(String(init?.body)) as { system: string; messages: { content: { type: string; text?: string }[] }[] };
    expect(request.system).toContain("kindは書かず");
    const prompt = request.messages[0]!.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    expect(prompt).toContain('"key":"watch","title":"年末の見回り"');
    expect(prompt).toContain('"key":"general-meeting","title":"定期総会"');
    expect(prompt).not.toContain('"key":"summer"');
    return Response.json({ id: "fixture-reading", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: JSON.stringify(body) }], usage: { input_tokens: 100, output_tokens: 100 } });
  } });
  const result = await readOriginals(client, { kind: "general", yearItems: candidates,
    originals: [{ originalId: "fixture-original", filename: "試験用.jpg", mediaType: "image/jpeg", position: 1, bytes: new Uint8Array([1, 2, 3]) }] });
  expect(calls).toBe(1);
  if (!("fields" in result.body)) throw new Error("一般の読みがありません");
  expect(result.body.project_suggestions).toEqual(body.project_suggestions);
  expect(result.body.project_suggestions?.[0]).not.toHaveProperty("kind");
  expect(cleanProjectSuggestions([{ original_id: "old", title: "古い資料", kind: "city_request" }], ["old"]))
    .toEqual([{ original_id: "old", title: "古い資料", kind: "city_request", date_text: "", place: "" }]);
});
