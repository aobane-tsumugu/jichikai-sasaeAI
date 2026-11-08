import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { LINE_SHARING as sharing } from "./fixtures/line-sharing";
import * as anthropic from "../src/ai/anthropic";
import { setClientFactory } from "../src/ai/deps";
import { MATCH_NEW, MATCH_UNCERTAIN } from "../src/ai/match";
import type { Reading } from "../src/ai/schema";
import { seedAdmin } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import { setPipelineDeps } from "../src/intake/pipeline";
import { getJob, listOriginals } from "../src/intake/store";
import { applyWardReading } from "../src/know/apply";
import { listClarifications, processPhotoBatches } from "../src/line/clarifications";
import { createLineIntakePorts } from "../src/line/intake";
import { acceptLineWebhook } from "../src/line/webhook";
import { get, realApp, withEnv } from "./helpers";

it("U78の続き: 外の催しを知らせる頼みは写真付きの問い合わせに残し、一年の行事にしない", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const runtime = withEnv({ LINE_CHANNEL_SECRET: "fictional-sharing-secret", LINE_CHANNEL_ACCESS_TOKEN: "fictional-sharing-token" });
  const destination = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding) VALUES (?, ?, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN')")
    .bind(ward.wardId, destination).run();
  // 同じ原本のIDを持つ別の区の予定と、人が入れた予定には触れない。
  await env.DB.prepare("INSERT INTO ward_year_items (ward_id, item_id, title, month, added) VALUES (?, ?, ?, 11, 1)")
    .bind(ward.wardId, crypto.randomUUID(), sharing.manualTitle).run();
  const sent: Array<{ replyToken: string; messages: Array<{ text: string }> }> = [];
  const fakeLine: typeof fetch = async (url, init) => {
    if (String(url).includes("api-data.line.me")) {
      const tag = Number(/\/message\/(\d+)\//.exec(String(url))?.[1]);
      if (!Number.isInteger(tag)) throw new Error("試しの写真番号がありません");
      return new Response(new Uint8Array([...fixture.answerSheetPhotoBytes, tag]), { headers: { "content-type": "image/jpeg" } });
    }
    if (String(url).endsWith("/message/reply")) {
      sent.push(JSON.parse(String(init?.body)) as (typeof sent)[number]);
      return Response.json({ sentMessages: [{ id: `fictional-sharing-reply-${sent.length}` }] });
    }
    throw new Error("この試験にない外部通信です");
  };
  const prompts: string[] = [];
  const ai = new Anthropic({ apiKey: "fictional-sharing-ai-key", maxRetries: 0, fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { system: string; messages: Array<{ content: string }> };
    let result: unknown;
    if (request.system.includes("写真の文字")) result = { readability: "readable", paperKind: "photo", reason: "other" };
    else if (request.system.includes("どのプロジェクトの物かを選ぶ")) {
      const prompt = request.messages[0]?.content;
      if (typeof prompt !== "string") throw new Error("当てる文がありません");
      prompts.push(prompt);
      const inquiry = sharing.requests.some((r) => prompt.includes(`受け取った物の要約: ${r.text}`));
      // 外の催しで行事の候補に当たらなくても、対応を頼む目的を先に使う。
      result = { choice: inquiry ? MATCH_NEW : MATCH_UNCERTAIN, intent: inquiry ? "inquiry" : "material",
        confident: false, attendanceAnswer: false, knowTopic: "none", reason: "試しの外の催しを知らせる頼みです。" };
    } else throw new Error("この試験にないAIの呼び出しです");
    return Response.json({ id: "fictional-sharing-ai", type: "message", role: "assistant", model: "claude-haiku-5-5",
      content: [{ type: "text", text: JSON.stringify(result) }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  let readCount = 0;
  const readings: Reading[] = [];
  const factory = vi.spyOn(anthropic, "createAnthropic").mockReturnValue(ai);
  setClientFactory(() => ai);
  setPipelineDeps({ createClient: () => ai, readImpl: async (_client, input) => {
    const original = input.originals[0];
    if (!original) throw new Error("読み取る写真がありません");
    const title = sharing.requests[readCount++]?.title ?? sharing.photoOnlyTitle;
    const body: Reading = { document_kind: "announcement", summary: title,
      original_years: [{ original_id: original.originalId, year: fixture.eventYear }],
      text_blocks: [{ original_id: original.originalId, locator: "全体", text: `${title} ${sharing.dateText}` }],
      fields: [{ original_id: original.originalId, locator: "日時", name: "日時", value: sharing.dateText, confidence: "high" }],
      tables: [], decisions: [], unreadable: [],
      project_suggestions: [{ original_id: original.originalId, kind: "event", title, date_text: sharing.dateText, place: fixture.previousPlace }],
      // 問題を再現する読み。写真だけの判断が一年の予定を返しても、問い合わせには採用しない。
      year_entries: [{ original_id: original.originalId, title, month: 11, date_text: sharing.dateText }] };
    readings.push(body);
    await env.DB.prepare("INSERT INTO ward_year_items (ward_id, item_id, title, month, added, source_original_id) VALUES (?, ?, ?, 11, 1, ?)")
      .bind(other.ward.wardId, crypto.randomUUID(), title, original.originalId).run();
    return { body, packVersion: "read-general@3", model: "claude-sonnet-5-5", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } };
  } });
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
  const ports = createLineIntakePorts(runtime, ctx);
  let at = new Date("2026-11-07T01:00:00Z");
  let number = 0;
  const send = async (message: string | number, person: string) => {
    at = new Date(at.getTime() + 60_000);
    vi.setSystemTime(at);
    const eventId = `fictional-sharing-${++number}`;
    const body = JSON.stringify({ destination, events: [{ type: "message", webhookEventId: eventId, timestamp: at.getTime(), replyToken: `${eventId}-reply`,
      source: { type: "user", userId: person }, message: typeof message === "number"
        ? { type: "image", id: String(message), imageSet: { id: eventId, index: 1, total: 1 } }
        : { type: "text", id: eventId, text: message } }] });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(runtime.LINE_CHANNEL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
    expect((await acceptLineWebhook(new Request("https://unit.test/hooks/line", { method: "POST", headers: { "x-line-signature": signature }, body }),
      runtime, env.DB, { ports, fetch: fakeLine }, at, ctx)).status).toBe(200);
    await Promise.all(pending.splice(0));
    return eventId;
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubGlobal("fetch", fakeLine);
  try {
    for (const [index, request] of sharing.requests.entries()) {
      const person = `fictional-sharing-person-${index}`;
      const before = sent.length;
      if (!request.photoFirst) await send(request.text, person);
      const photoEvent = await send(210 + index, person);
      if (request.photoFirst) await send(request.text, person);
      const photo = await env.DB.prepare("SELECT item_id, job_id, bundle_id FROM line_inbox_items WHERE ward_id = ? AND event_id = ?")
        .bind(ward.wardId, photoEvent).first<{ item_id: string; job_id: string; bundle_id: string }>();
      if (!photo) throw new Error("届いた写真がありません");
      const inquiries = await env.DB.prepare("SELECT inquiry_id, subject FROM inquiry_records WHERE ward_id = ? AND line_bundle_id = ?")
        .bind(ward.wardId, photo.bundle_id).all<{ inquiry_id: string; subject: string }>();
      expect(inquiries.results).toHaveLength(1);
      expect(inquiries.results[0]?.subject).toBe(request.text);
      expect(sent).toHaveLength(before + 1);
      expect(await getJob(env.DB, ward.wardId, photo.job_id)).toMatchObject({ project_id: null, withdrawn_at: null, status: "read" });
      const original = (await listOriginals(env.DB, ward.wardId, photo.job_id))[0];
      if (!original?.r2_path) throw new Error("元の写真がありません");
      expect(await new WardBucket(env.ORIGINALS, ward.wardId).get(original.r2_path)).not.toBeNull();
      const html = await (await get(realApp, `/${ward.slug}/admin/inquiries/${inquiries.results[0]!.inquiry_id}`, cookie, runtime)).text();
      expect(html).toContain(request.text);
      expect(html).toContain(`/${ward.slug}/admin/inbox/${photo.item_id}/original`);
      expect(await env.DB.prepare("SELECT title FROM ward_year_items WHERE ward_id = ? AND source_original_id = ?")
        .bind(ward.wardId, original.original_id).first()).toBeNull();
    }
    // 写真だけなら従来どおり。読み取りにある予定は一年に入り、問い合わせにはしない。
    const alone = await send(220, "fictional-sharing-photo-only");
    const aloneItem = await env.DB.prepare("SELECT bundle_id FROM line_inbox_items WHERE ward_id = ? AND event_id = ?")
      .bind(ward.wardId, alone).first<{ bundle_id: string }>();
    if (!aloneItem) throw new Error("写真だけの届いたものがありません");
    expect(await env.DB.prepare("SELECT title FROM ward_year_items WHERE ward_id = ? AND title = ?")
      .bind(ward.wardId, sharing.photoOnlyTitle).first()).toEqual({ title: sharing.photoOnlyTitle });
    expect(await env.DB.prepare("SELECT inquiry_id FROM inquiry_records WHERE ward_id = ? AND line_bundle_id = ?")
      .bind(ward.wardId, aloneItem.bundle_id).first()).toBeNull();
    // 写真の再処理でも、問い合わせから行事を復活させない。
    const firstReading = readings[0];
    if (!firstReading) throw new Error("写真の読み取りがありません");
    await applyWardReading(env.DB, ward.wardId, firstReading);
    await processPhotoBatches(runtime, ward.wardId, { fetch: fakeLine, now: at });
    expect((await env.DB.prepare("SELECT title FROM ward_year_items WHERE ward_id = ? ORDER BY title")
      .bind(ward.wardId).all<{ title: string }>()).results.map((row) => row.title).sort())
      .toEqual([sharing.manualTitle, sharing.photoOnlyTitle].sort());
    expect((await env.DB.prepare("SELECT title FROM ward_year_items WHERE ward_id = ?")
      .bind(other.ward.wardId).all()).results).toHaveLength(sharing.requests.length + 1);
    expect(await env.DB.prepare("SELECT project_id FROM projects WHERE ward_id = ?").bind(ward.wardId).first()).toBeNull();
    expect((await listClarifications(env.DB, ward.wardId)).filter((q) => q.topic === "project")).toHaveLength(0);
    expect(prompts.some((prompt) => prompt.includes("知らせてほしい") && prompt.includes("写真付きの問い合わせ"))).toBe(true);
  } finally {
    factory.mockRestore();
    setClientFactory(null);
    setPipelineDeps(null);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
