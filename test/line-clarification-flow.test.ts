import { conversationFor } from "../src/line/talks";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { setClientFactory } from "../src/ai/deps";
import type { Reading } from "../src/ai/schema";
import { seedAdmin, seedWard } from "../src/core/testing";
import type { Env } from "../src/env";
import { receive } from "../src/intake/receive";
import { photoChecks, quickCheckPhotos } from "../src/intake/photo-check";
import { setJobProject } from "../src/intake/store";
import { attachClarificationQuestions, listClarifications, processPhotoBatches, replyQuickPhotoChecks } from "../src/line/clarifications";
import type { LineIntakePorts } from "../src/line/intake";
import { acceptLineWebhook } from "../src/line/webhook";
import { createProject, getProjectState } from "../src/project/api";
import { get, realApp, withEnv } from "./helpers";

it("写真をまとめて同じ場所で聞き、別の人の答えを受け、聞いていない問い合わせは役員へ渡す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const other = await seedWard(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: FIRST_SLICE.draftTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId });
  const now = new Date("2026-11-06T01:00:00Z");
  const destination = crypto.randomUUID();
  const group = "C-fictional-photo-group";
  const secret = "fictional-webhook-secret";
  const runtime: Env = withEnv({ LINE_CHANNEL_SECRET: secret, LINE_CHANNEL_ACCESS_TOKEN: "fictional-access-token" });
  await env.DB.prepare("INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding) VALUES (?, ?, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN')")
    .bind(ward.wardId, destination).run();

  // 試しの資料のバイトに技術上の画像見出しを付け、寸法の処理も通す。画像の中身の精度を測る試験ではない。
  const image = (tag: number, short = 800) => new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, short >>> 8, short & 255, 4, 0, 3, 1, 1, 0, ...FIRST_SLICE.answerSheetPhotoBytes, tag]);
  const sent: Array<{ url: string; body: { to?: string; replyToken?: string; messages: Array<{ text: string; quickReply?: { items: Array<{ action: { data: string } }> } }> } }> = [];
  let modelCalls = 0;
  const fakeAi = new Anthropic({ apiKey: "fictional-api-key", maxRetries: 0, fetch: async (_url, init) => {
    modelCalls++;
    const request = JSON.parse(String(init?.body)) as { system: string };
    const value = request.system.includes("写真の文字") ? { readability: "readable", paperKind: "rota", reason: "other" } : { text: "2枚受け取りました。2枚目は、今年のものでしょうか。去年のものでしょうか。" };
    return Response.json({ id: "fictional-message", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: JSON.stringify(value) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  const fakeLine: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path.includes("api-data.line.me")) return new Response(image(path.includes("photo-2") ? 2 : 1), { headers: { "content-type": "image/jpeg" } });
    if (path.endsWith("/message/reply") || path.endsWith("/message/push")) {
      sent.push({ url: path, body: JSON.parse(String(init?.body)) as (typeof sent)[number]["body"] });
      return Response.json({ sentMessages: [{ id: `fictional-sent-${sent.length}` }] });
    }
    if (path.includes("/member/")) return Response.json({ displayName: FIRST_SLICE.sheetHelper });
    if (path.endsWith("/message/quota")) return Response.json({ type: "limited", value: 200 });
    if (path.endsWith("/message/quota/consumption")) return Response.json({ totalUsage: 200 });
    if (path.endsWith("/members/count")) return Response.json({ count: 7 });
    throw new Error(`試験にないLINE呼び出し: ${path}`);
  };
  const ports: LineIntakePorts = {
    async receiveOriginal(wardId, original) {
      const result = await receive(runtime, { wardId, projectId: project.projectId, via: original.sourceType === "user" ? "line_direct" : "line_group", senderLabel: original.senderDisplayName ?? "",
        parts: [{ kind: original.kind === "text" ? "text" : "photo", filename: FIRST_SLICE.answerSheetFilename,
          mediaType: original.kind === "text" ? "text/plain" : "image/jpeg", bytes: original.kind === "text" ? new TextEncoder().encode(original.text) : new Uint8Array(original.bytes!) }] });
      return result.jobId;
    },
    async checkPhoto(wardId, original, jobId) {
      await quickCheckPhotos(runtime, { wardId, via: "line_group", parts: [{ kind: "photo", filename: FIRST_SLICE.answerSheetFilename, mediaType: "image/jpeg", bytes: new Uint8Array(original.bytes!) }] }, jobId);
    },
    async matchInboxItem() { return { disposition: "matched", projectId: project.projectId }; },
    async assignProject(wardId, jobId, projectId) {
      await setJobProject(env.DB, wardId, jobId, projectId);
      await attachClarificationQuestions(env.DB, wardId, jobId);
    },
    async discard() { throw new Error("この流れで元の資料を捨てません"); },
  };
  const webhook = async (events: unknown[], at = now) => {
    const body = JSON.stringify({ destination, events });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
    return acceptLineWebhook(new Request("https://unit.test/hooks/line", { method: "POST", headers: { "x-line-signature": signature }, body }), runtime, env.DB, { fetch: fakeLine, ports }, at);
  };
  setClientFactory(() => fakeAi);
  try {
    const photos = [1, 2].map((index) => ({ type: "message", webhookEventId: `fictional-photo-${index}`, timestamp: now.getTime(), replyToken: `fictional-reply-${index}`,
      source: { type: "group", groupId: group, userId: "fictional-photographer" },
      message: { type: "image", id: `photo-${index}`, imageSet: { id: "fictional-image-set", index, total: 2 }, quoteToken: "fictional-quote" } }));
    expect((await webhook(photos)).status).toBe(200);
    expect(sent).toHaveLength(0); // 読める写真には返さない。
    const items = await env.DB.prepare("SELECT job_id, image_index FROM line_photo_items WHERE ward_id = ? ORDER BY image_index")
      .bind(ward.wardId).all<{ job_id: string; image_index: number }>();
    expect(items.results).toHaveLength(2);
    for (const item of items.results) {
      expect((await photoChecks(env.DB, ward.wardId, item.job_id))[0]).toMatchObject({ width: 1024, height: 800, readability: "readable", paperKind: "rota" });
      const original = await env.DB.prepare("SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ?").bind(ward.wardId, item.job_id).first<{ original_id: string }>();
      if (!original) throw new Error("試しの資料が保存されていません");
      const reading: Reading = { document_kind: "rota", summary: FIRST_SLICE.dutyText,
        original_years: [{ original_id: original.original_id, year: item.image_index === 1 ? 2026 : null }],
        text_blocks: [{ original_id: original.original_id, locator: "全体", text: FIRST_SLICE.dutyText }],
        fields: [{ name: "日時", value: FIRST_SLICE.publicDayText, confidence: "high", original_id: original.original_id, locator: "上" }], tables: [], decisions: [], unreadable: [] };
      await env.DB.prepare("INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at) VALUES (?, ?, ?, 'model', 'read-general@3', 'claude-sonnet-5-5', ?, ?)")
        .bind(crypto.randomUUID(), ward.wardId, item.job_id, JSON.stringify(reading), now.toISOString()).run();
      await env.DB.prepare("UPDATE jobs SET status = 'read', read_at = ? WHERE ward_id = ? AND job_id = ?").bind(now.toISOString(), ward.wardId, item.job_id).run();
    }
    await processPhotoBatches(runtime, ward.wardId, { fetch: fakeLine, now });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toMatch(/\/message\/reply$/);
    expect(sent[0]?.body.replyToken).toBe("fictional-reply-2");
    expect(sent[0]?.body.to).toBeUndefined();
    const question = (await listClarifications(env.DB, ward.wardId))[0];
    if (!question?.question_id) throw new Error("役員の質問に載っていません");
    expect((await getProjectState(env.DB, ward.wardId, project.projectId))?.questions).toEqual(expect.arrayContaining([expect.objectContaining({ questionId: question.question_id, state: "open" })]));
    const action = sent[0]!.body.messages[0]!.quickReply!.items[0]!.action.data;
    expect((await webhook([{ type: "postback", webhookEventId: "fictional-answer", source: { type: "group", groupId: group, userId: "fictional-other-member" }, postback: { data: action } }])).status).toBe(200);
    expect(sent).toHaveLength(1); // 答えに返事はしない。
    expect(await env.DB.prepare("SELECT state FROM project_questions WHERE ward_id = ? AND question_id = ?").bind(ward.wardId, question.question_id).first()).toEqual({ state: "answered" });
    expect((await getProjectState(env.DB, ward.wardId, project.projectId))?.questions.some((active) => active.questionId === question.question_id)).toBe(false);
    expect((await env.DB.prepare("SELECT job_id FROM line_clarification_answers WHERE ward_id = ?").bind(ward.wardId).all()).results).toHaveLength(1);

    const beforeInquiry = modelCalls;
    const inquiry = { type: "message", webhookEventId: "fictional-inquiry", replyToken: "fictional-inquiry-reply", source: { type: "user", userId: "fictional-resident" }, message: { type: "text", id: "fictional-inquiry-text", text: `${FIRST_SLICE.draftTitle}は何時からですか。` } };
    await webhook([inquiry]);
    await webhook([inquiry]);
    expect(modelCalls).toBe(beforeInquiry);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.body.messages[0]?.text).toBe("役員に伝えて、内容を確認します。");
    expect((await env.DB.prepare("SELECT subject, answer, created_by_account_id FROM inquiry_records WHERE ward_id = ?").bind(ward.wardId).all()).results)
      .toEqual([{ subject: inquiry.message.text, answer: "", created_by_account_id: null }]);
    expect((await listClarifications(env.DB, other.wardId))).toHaveLength(0);
    const inquiryRow = await env.DB.prepare("SELECT inquiry_id FROM inquiry_records WHERE ward_id = ? AND line_event_id = ?").bind(ward.wardId, "fictional-inquiry").first<{ inquiry_id: string }>();
    if (!inquiryRow) throw new Error("問い合わせがありません");
    const conversation = await conversationFor(env.DB, ward.wardId, { inquiryId: inquiryRow.inquiry_id });
    if (!conversation) throw new Error("元の会話がありません");
    const inbox = await (await get(realApp, `/${ward.slug}/admin${conversation}`, cookie, runtime)).text();
    expect(inbox).toContain(inquiry.message.text);
    expect(await (await get(realApp, `/${ward.slug}/admin/inquiries`, cookie, runtime)).text()).toContain(inquiry.message.text);
    await processPhotoBatches(runtime, ward.wardId, { fetch: fakeLine, now: new Date(now.getTime() + 3600_000) });
    expect(sent).toHaveLength(2); // 答えがあっても無くても、自動の催促はしない。

    const small = await receive(runtime, { wardId: ward.wardId, projectId: project.projectId, via: "admin", parts: [{ kind: "photo", filename: FIRST_SLICE.answerSheetFilename, mediaType: "image/jpeg", bytes: image(3, 300) }] });
    if (!small.jobId) throw new Error("小さい画像も元の資料として受け取る必要があります");
    await quickCheckPhotos(runtime, { wardId: ward.wardId, via: "admin", parts: [{ kind: "photo", filename: FIRST_SLICE.answerSheetFilename, mediaType: "image/jpeg", bytes: image(3, 300) }] }, small.jobId);
    expect((await photoChecks(env.DB, ward.wardId, small.jobId))[0]).toMatchObject({ readability: "unreadable", reason: "small" });
    const receipt = await (await get(realApp, `/${ward.slug}/admin/intake/received`, cookie, runtime)).text();
    expect(receipt).toContain("撮り直す");
    expect(receipt).toContain("このままにする");
    await replyQuickPhotoChecks(runtime, ward.wardId, { fetch: fakeLine, now: new Date("2026-11-06T14:00:00Z") });
    expect(sent).toHaveLength(2);
  } finally { setClientFactory(null); }
});
