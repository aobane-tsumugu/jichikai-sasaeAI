import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { setClientFactory } from "../src/ai/deps";
import { MATCH_UNRELATED, matchProject } from "../src/ai/match";
import type { Reading } from "../src/ai/schema";
import * as sessions from "../src/ai/session";
import { seedAdmin } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import { setPipelineDeps } from "../src/intake/pipeline";
import { quickCheckPhotos } from "../src/intake/photo-check";
import { receive } from "../src/intake/receive";
import { getJob, listOriginals } from "../src/intake/store";
import { listClarifications, registerLinePhoto, replyQuickPhotoChecks } from "../src/line/clarifications";
import { createLineIntakePorts } from "../src/line/intake";
import { acceptLineWebhook } from "../src/line/webhook";
import { createProject } from "../src/project/api";
import { withEnv } from "./helpers";

it("U59: 次の写真を決めつけず、引用と撮り直しの選択だけ結び、一時の当て失敗は再判定する", async () => {
  // 架空の区・資料だけを使い、署名付き受付、D1、R2、読み取りと当てを通す。
  const { ward, account } = await seedAdmin(env.DB);
  const first = await createProject(env.DB, ward.wardId, { kind: "event", title: fixture.draftTitle, year: fixture.eventYear, accountId: account.accountId });
  const second = await createProject(env.DB, ward.wardId, { kind: "event", title: fixture.dutyTitle, year: fixture.eventYear, accountId: account.accountId });
  const runtime = withEnv({ LINE_CHANNEL_SECRET: "fictional-u59-secret", LINE_CHANNEL_ACCESS_TOKEN: "fictional-u59-token" });
  const destination = crypto.randomUUID();
  const source = { type: "group" as const, id: "fictional-u59-group", senderId: "fictional-u59-sender" };
  await env.DB.prepare("INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding) VALUES (?, ?, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN')")
    .bind(ward.wardId, destination).run();
  // 架空資料に画像見出しを付け、実際の寸法確認も通す。画像の読み取り精度は測らない。
  const image = (tag: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 3, 32, 4, 0, 3, 1, 1, 0, ...fixture.answerSheetPhotoBytes, tag]);
  let unreadable = false;
  let textFailures = 0;
  let textCalls = 0;
  const photoPrompts: string[] = [];
  const ai = new Anthropic({ apiKey: "fictional-u59-api-key", maxRetries: 0, fetch: async (url, init) => {
    if (!String(url).endsWith("/messages")) throw new Error("試験にないAI呼び出しです");
    const request = JSON.parse(String(init?.body)) as { system: string; model: string; messages: Array<{ content: string | Array<{ text?: string }> }> };
    const content = request.messages[0]?.content;
    let result: unknown;
    if (request.system.includes("写真の文字")) result = { readability: unreadable ? "unreadable" : "readable", paperKind: "photo", reason: "blurred" };
    else if (request.system.includes("どのプロジェクトの物かを選ぶ")) {
      if (typeof content !== "string") throw new Error("当てる資料がありません");
      if (content.includes("写真を当てるための一時的な資料")) {
        photoPrompts.push(content);
        result = { choice: second.projectId, confident: true, reason: "別の行事の写真です。", intent: "material", attendanceAnswer: false };
      } else {
        textCalls++;
        if (textFailures-- > 0) return Response.json({ error: { type: "overloaded_error", message: "fictional unavailable" } }, { status: 529 });
        result = { choice: MATCH_UNRELATED, reason: "架空のあいさつです。", intent: "material", attendanceAnswer: false };
      }
    } else if (request.model === "claude-sonnet-5-5") {
      const originalId = Array.isArray(content) ? content.flatMap((block) => /^原本 ID: ([^（]+)/.exec(block.text ?? "")?.[1] ?? [])[0] : undefined;
      if (!originalId) throw new Error("読み取りに元の資料がありません");
      result = { document_kind: "photo", summary: fixture.dutyText,
        original_years: [{ original_id: originalId, year: fixture.eventYear }],
        text_blocks: [{ original_id: originalId, locator: "全体", text: fixture.dutyText }],
        fields: [], tables: [], decisions: [], unreadable: [] } satisfies Reading;
    } else throw new Error("試験にないAIの仕事です");
    return Response.json({ id: "fictional-u59-message", type: "message", role: "assistant", model: request.model,
      content: [{ type: "text", text: JSON.stringify(result) }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  const sent: Array<{ messages: Array<{ text: string; quickReply?: { items: Array<{ action: { label: string; type: string; data: string } }> } }> }> = [];
  const fakeLine: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path.includes("api-data.line.me")) {
      const tag = Number(/\/message\/(\d+)\//.exec(path)?.[1]);
      if (!Number.isInteger(tag)) throw new Error("架空の写真番号がありません");
      return new Response(image(tag), { headers: { "content-type": "image/jpeg" } });
    }
    if (path.includes("/member/")) return Response.json({ displayName: fixture.sheetHelper });
    if (path.endsWith("/message/reply")) {
      sent.push(JSON.parse(String(init?.body)) as (typeof sent)[number]);
      return Response.json({ sentMessages: [{ id: `fictional-u59-sent-${sent.length}` }] });
    }
    throw new Error("試験にないLINE呼び出しです");
  };
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
  const ports = createLineIntakePorts(runtime, ctx, async (_wardId, original) => matchProject(ai, {
    candidates: [{ id: first.projectId, title: first.title }, { id: second.projectId, title: second.title }],
    summary: original.text ?? "", officialAddressed: original.officialAddressed,
  }));
  let now = new Date("2026-11-06T01:00:00Z");
  let eventNo = 0;
  const send = async (message: { type: "image" | "text"; id: string; text?: string; quotedMessageId?: string } | { data: string }, sender = source.senderId, direct = false) => {
    now = new Date(now.getTime() + 6000);
    vi.setSystemTime(now);
    const eventId = `fictional-u59-event-${++eventNo}`;
    const body = JSON.stringify({ destination, events: [{ type: "data" in message ? "postback" : "message", webhookEventId: eventId,
      timestamp: now.getTime(), replyToken: `${eventId}-reply`, source: direct ? { type: "user", userId: sender } : { type: "group", groupId: source.id, userId: sender },
      ...("data" in message ? { postback: message } : { message: { ...message, ...(message.type === "image" ? { imageSet: { id: eventId, index: 1, total: 1 } } : {}) } }) }] });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(runtime.LINE_CHANNEL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
    expect((await acceptLineWebhook(new Request("https://unit.test/hooks/line", { method: "POST", headers: { "x-line-signature": signature }, body }),
      runtime, env.DB, { ports, fetch: fakeLine }, now, ctx)).status).toBe(200);
    return eventId;
  };
  const inbox = (eventId: string) => env.DB.prepare("SELECT job_id FROM line_inbox_items WHERE ward_id = ? AND event_id = ?")
    .bind(ward.wardId, eventId).first<{ job_id: string }>();
  const photo = async (id: number, quotedMessageId?: string, sender?: string) => {
    const eventId = await send({ type: "image", id: String(id), quotedMessageId }, sender);
    const item = await inbox(eventId);
    if (!item) throw new Error("写真が届いていません");
    return item.job_id;
  };
  const retakeId = (jobId: string) => env.DB.prepare("SELECT retake_clarification_id FROM line_photo_items WHERE ward_id = ? AND job_id = ?")
    .bind(ward.wardId, jobId).first<{ retake_clarification_id: string | null }>();
  const ask = async (tag: number) => {
    const input = { wardId: ward.wardId, projectId: first.projectId, via: "line_group" as const,
      parts: [{ kind: "photo" as const, filename: fixture.answerSheetFilename, mediaType: "image/jpeg", bytes: image(tag) }] };
    const received = await receive(runtime, input);
    if (!received.jobId) throw new Error("質問の元の写真がありません");
    await registerLinePhoto(env.DB, ward.wardId, { destination, source, jobId: received.jobId, messageId: `fictional-original-${tag}`,
      imageSet: { id: `fictional-seed-${tag}`, total: 1, index: 1 }, replyToken: `fictional-seed-reply-${tag}`, now });
    unreadable = true;
    await quickCheckPhotos(runtime, input, received.jobId);
    unreadable = false;
    await replyQuickPhotoChecks(runtime, ward.wardId, { fetch: fakeLine, now });
    const question = (await listClarifications(env.DB, ward.wardId)).find((q) => q.job_id === received.jobId);
    if (!question?.sent_message_id) throw new Error("写真への質問が送られていません");
    return question;
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.stubGlobal("fetch", fakeLine);
  setClientFactory(() => ai);
  setPipelineDeps({ createClient: () => ai });
  // 資料をつないで下書きを作る仕事は対象外。読み取りと当ての通信は上の偽物を使う。
  const dispatch = vi.spyOn(sessions, "dispatchProject").mockResolvedValue("busy");
  try {
    const question = await ask(100);
    const ordinary = await photo(1);
    expect(await retakeId(ordinary)).toEqual({ retake_clarification_id: null });
    expect((await getJob(env.DB, ward.wardId, ordinary))?.project_id).toBe(second.projectId);
    expect(photoPrompts.at(-1)).toContain(question.id);
    expect(photoPrompts.at(-1)).toContain(question.text);
    expect((await listClarifications(env.DB, ward.wardId)).find((q) => q.id === question.id)?.answer).toBeNull();
    const quoted = await photo(2, question.sent_message_id!);
    expect(await retakeId(quoted)).toEqual({ retake_clarification_id: question.id });
    expect((await getJob(env.DB, ward.wardId, quoted))?.project_id).toBe(first.projectId);
    expect((await listClarifications(env.DB, ward.wardId)).find((q) => q.id === question.id)?.answer).toContain("読み取れました");

    const next = await ask(101);
    const action = sent.at(-1)?.messages[0]?.quickReply?.items.find((item) => item.action.label === "撮り直す")?.action;
    if (!action) throw new Error("撮り直す選択肢がありません");
    expect(action.type).toBe("postback");
    await send({ data: action.data });
    expect((await listClarifications(env.DB, ward.wardId)).find((q) => q.id === next.id)?.answer).toBeNull();
    const another = await photo(3, undefined, "fictional-u59-other-sender");
    expect(await retakeId(another)).toEqual({ retake_clarification_id: null });
    expect(photoPrompts.at(-1)).not.toContain(`"summary":"${next.id}"`);
    const selected = await photo(4);
    expect(await retakeId(selected)).toEqual({ retake_clarification_id: next.id });
    expect((await getJob(env.DB, ward.wardId, selected))?.project_id).toBe(first.projectId);
    expect((await listClarifications(env.DB, ward.wardId)).find((q) => q.id === next.id)?.answer).toContain("読み取れました");
    expect(await retakeId(await photo(5))).toEqual({ retake_clarification_id: null });

    textFailures = 1;
    const beforeRetry = textCalls;
    const chat = await send({ type: "text", id: "fictional-chat", text: "おはようございます。" });
    expect(textCalls).toBe(beforeRetry + 2);
    expect(await inbox(chat)).toBeNull();
    expect(await env.DB.prepare("SELECT item_count FROM line_unrelated_daily_counts WHERE ward_id = ? AND day = ?")
      .bind(ward.wardId, now.toISOString().slice(0, 10)).first()).toEqual({ item_count: 1 });
    textFailures = 3;
    const beforeStop = textCalls;
    const stoppedText = `架空の文です。${fixture.previousMaterial}`;
    const stopped = await send({ type: "text", id: "fictional-stopped", text: stoppedText }, "fictional-u59-direct", true);
    expect(textCalls).toBe(beforeStop + 3);
    const kept = await inbox(stopped);
    if (!kept) throw new Error("失敗が続いた文が届いたものにありません");
    expect((await getJob(env.DB, ward.wardId, kept.job_id))?.project_id).toBeNull();
    const original = (await listOriginals(env.DB, ward.wardId, kept.job_id))[0];
    if (!original?.r2_path) throw new Error("失敗が続いた文の元の資料がありません");
    expect(await (await new WardBucket(env.ORIGINALS, ward.wardId).get(original.r2_path))?.text()).toBe(stoppedText);
    expect(await env.DB.prepare("SELECT inquiry_id FROM inquiry_records WHERE ward_id = ? AND line_event_id = ?")
      .bind(ward.wardId, stopped).first()).toBeNull();
    await Promise.all(pending);
  } finally {
    dispatch.mockRestore();
    setClientFactory(null);
    setPipelineDeps(null);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
