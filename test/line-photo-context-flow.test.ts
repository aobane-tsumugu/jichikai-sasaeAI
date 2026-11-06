import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { setClientFactory } from "../src/ai/deps";
import { MATCH_UNRELATED } from "../src/ai/match";
import type { Reading } from "../src/ai/schema";
import { seedAdmin } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import { setPipelineDeps } from "../src/intake/pipeline";
import { receive } from "../src/intake/receive";
import { getJob, getReadings, listOriginals } from "../src/intake/store";
import { listClarifications, processPhotoBatches, registerLinePhoto } from "../src/line/clarifications";
import { createLineIntakePorts } from "../src/line/intake";
import { PHOTO_CONTEXT_GAP_MS } from "../src/line/photo-context";
import { acceptLineWebhook } from "../src/line/webhook";
import { makeProjectPaperCode } from "../src/print/qr";
import { createProject } from "../src/project/api";
import { setEventDay } from "../src/project/actions";
import { get, postForm, realApp, withEnv } from "./helpers";

it("本物の受付と読みの流れで写真を残し、状況を優先し、各写真と重複に返す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const now = new Date("2026-11-06T01:00:00Z");
  const today = "2026-11-06";
  const first = await createProject(env.DB, ward.wardId, { kind: "event", title: fixture.draftTitle, year: 2026, eventDay: today, accountId: account.accountId });
  const second = await createProject(env.DB, ward.wardId, { kind: "event", title: fixture.dutyTitle, year: 2027, eventDay: "2027-11-06", accountId: account.accountId });
  await createProject(env.DB, other.ward.wardId, { kind: "event", title: fixture.reportText, year: 2026, eventDay: today, accountId: other.account.accountId });
  const runtime = withEnv({ LINE_CHANNEL_SECRET: "fictional-photo-secret", LINE_CHANNEL_ACCESS_TOKEN: "fictional-photo-token" });
  const destination = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding) VALUES (?, ?, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN')")
    .bind(ward.wardId, destination).run();
  let matchChoice = MATCH_UNRELATED;
  let matchCalls = 0;
  let readCalls = 0;
  const ai = new Anthropic({ apiKey: "fictional-photo-api-key", maxRetries: 0, fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { system: string; model: string; messages: Array<{ content: string | Array<{ type: string; text?: string }> }> };
    let result: unknown;
    if (request.system.includes("写真の文字")) result = { readability: "readable", paperKind: "photo", reason: "other" };
    else if (request.system.includes("どのプロジェクトの物かを選ぶ")) {
      matchCalls++;
      result = { choice: matchChoice, reason: "架空の当ての結果", intent: "material" };
    } else if (request.model === "claude-sonnet-5-5") {
      readCalls++;
      const content = request.messages[0]?.content;
      const originalId = Array.isArray(content) ? content.flatMap((block) => /^原本 ID: ([^（]+)/.exec(block.text ?? "")?.[1] ?? [])[0] : undefined;
      if (!originalId) throw new Error("本物の読み取りに原本のIDがありません");
      // 文字のない写真の読み。空の欄を繋げるへ渡さないことを確かめるための入力。
      result = { document_kind: "photo", summary: "", original_years: [{ original_id: originalId, year: null }],
        text_blocks: [], fields: [], tables: [], decisions: [], unreadable: [], project_suggestions: [] } satisfies Reading;
    } else result = { text: "この写真は、どの行事のものですか。" };
    return Response.json({ id: "fictional-message", type: "message", role: "assistant", model: request.model,
      content: [{ type: "text", text: JSON.stringify(result) }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  const messages: Array<{ replyToken?: string; to?: string; messages: Array<{ text: string; quoteToken?: string }> }> = [];
  const fakeLine: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path.includes("api-data.line.me")) {
      const tag = Number(/\/message\/(\d+)\//.exec(path)?.[1]);
      if (!Number.isInteger(tag)) throw new Error("架空の写真番号がありません");
      return new Response(new Uint8Array([...fixture.answerSheetPhotoBytes, tag]), { headers: { "content-type": "image/jpeg" } });
    }
    if (path.endsWith("/message/reply") || path.endsWith("/message/push")) {
      messages.push(JSON.parse(String(init?.body)) as (typeof messages)[number]);
      return Response.json({ sentMessages: [{ id: `fictional-sent-${messages.length}` }] });
    }
    if (path.includes("/member/")) return Response.json({ displayName: fixture.sheetHelper });
    if (path.endsWith("/message/quota")) return Response.json({ type: "limited", value: 200 });
    if (path.endsWith("/message/quota/consumption")) return Response.json({ totalUsage: 0 });
    if (path.endsWith("/members/count")) return Response.json({ count: 2 });
    throw new Error("予定していない外部通信です");
  };
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
  const ports = createLineIntakePorts(runtime, ctx);
  let eventNo = 0;
  const send = async (tags: number[], sender: string, at: Date, group?: string) => {
    const events = tags.map((tag, index) => ({ type: "message", webhookEventId: `fictional-event-${++eventNo}`, timestamp: at.getTime() + index,
      replyToken: `fictional-reply-${eventNo}`, source: group ? { type: "group", groupId: group, userId: sender } : { type: "user", userId: sender },
      message: { type: "image", id: String(tag), quoteToken: `fictional-quote-${tag}`, imageSet: { id: `fictional-set-${eventNo - index}`, index: index + 1, total: tags.length } } }));
    const body = JSON.stringify({ destination, events });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(runtime.LINE_CHANNEL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
    expect((await acceptLineWebhook(new Request("https://unit.test/hooks/line", { method: "POST", headers: { "x-line-signature": signature }, body }),
      runtime, env.DB, { ports, fetch: fakeLine }, at, ctx)).status).toBe(200);
    return Promise.all(events.map(async (event) => ({ event, item: await env.DB.prepare("SELECT job_id FROM line_inbox_items WHERE ward_id = ? AND event_id = ?")
      .bind(ward.wardId, event.webhookEventId).first<{ job_id: string }>() })));
  };
  const jobId = (value: Awaited<ReturnType<typeof send>>[number] | undefined) => {
    if (!value?.item) throw new Error("届いた写真がありません");
    return value.item.job_id;
  };
  setClientFactory(() => ai);
  setPipelineDeps({ createClient: () => ai });
  vi.stubGlobal("fetch", fakeLine);
  try {
    const received = await send([1, 2, 3], "fictional-person", now);
    expect(readCalls).toBe(3);
    expect(matchCalls).toBe(0); // 他区の同日行事と、来年の行事は候補を曖昧にしない。
    for (const photo of received) {
      expect(await getJob(env.DB, ward.wardId, jobId(photo))).toMatchObject({ project_id: first.projectId, status: "done", connect_attempt: 0, withdrawn_at: null });
      expect(messages.filter((message) => message.replyToken === photo.event.replyToken)).toHaveLength(1);
      expect(messages.find((message) => message.replyToken === photo.event.replyToken)?.messages[0]?.text).toBe("受け取りました。役員が確かめます。");
      const original = (await listOriginals(env.DB, ward.wardId, jobId(photo)))[0];
      if (!original?.r2_path) throw new Error("写真の保存場所がありません");
      expect(await new WardBucket(env.ORIGINALS, ward.wardId).get(original.r2_path)).not.toBeNull();
    }
    const map = await (await get(realApp, `/${ward.slug}/admin/projects/${first.projectId}/map`, cookie)).text();
    expect(map).toContain("最近届いた資料");
    for (const photo of received) expect(map).toContain((await listOriginals(env.DB, ward.wardId, jobId(photo)))[0]!.original_id);
    const beforeDuplicate = readCalls;
    const duplicate = (await send([1], "fictional-person", new Date(now.getTime() + 1000)))[0]!;
    expect(duplicate.item).toBeNull();
    expect(readCalls).toBe(beforeDuplicate);
    expect(messages.find((message) => message.replyToken === duplicate.event.replyToken)?.messages[0]?.text).toBe("同じ写真を受け取っています。");

    expect(await setEventDay(env.DB, ward.wardId, second.projectId, today, account.accountId)).toBe(true);
    const continued = await send([4], "fictional-person", new Date(now.getTime() + 2000));
    expect((await getJob(env.DB, ward.wardId, jobId(continued[0])))?.project_id).toBe(first.projectId);
    expect(matchCalls).toBe(0); // 時期が二つ重なっても、同じ人の直前の写真が先。

    // 別の人・場所・時間の幅の外では引き継がない。空の写真でも一問を残す。
    const unknown = await send([5], "fictional-other-person", new Date(now.getTime() + 3000));
    expect((await getJob(env.DB, ward.wardId, jobId(unknown[0])))?.project_id).toBeNull();
    const late = await send([6], "fictional-person", new Date(now.getTime() + PHOTO_CONTEXT_GAP_MS + 3000));
    expect((await getJob(env.DB, ward.wardId, jobId(late[0])))?.project_id).toBeNull();
    await processPhotoBatches(runtime, ward.wardId, { fetch: fakeLine, now: new Date(now.getTime() + PHOTO_CONTEXT_GAP_MS + 10_000) });
    expect((await listClarifications(env.DB, ward.wardId)).filter((question) => question.job_id === jobId(unknown[0]))).toEqual([
      expect.objectContaining({ topic: "project", text: "この写真は、どの行事のものですか。" }),
    ]);
    expect(messages.some((message) => message.to === "fictional-other-person" &&
      message.messages[0]?.text === "この写真は、どの行事のものですか。" && message.messages[0]?.quoteToken === "fictional-quote-5")).toBe(true);

    const group = "fictional-event-group";
    const groupPhoto = await send([7], "fictional-photographer", new Date(now.getTime() + 4000), group);
    expect(messages.filter((message) => message.replyToken === groupPhoto[0]?.event.replyToken)
      .every((message) => message.messages[0]?.text.includes("どの行事"))).toBe(true);
    const groupJob = jobId(groupPhoto[0]);
    expect((await getJob(env.DB, ward.wardId, groupJob))?.withdrawn_at).toBeNull();
    expect((await postForm(realApp, `/${ward.slug}/admin/inbox/${groupJob}`, { operation: "assign", projectId: second.projectId }, cookie)).status).toBe(303);
    const placed = await send([8], "fictional-another-photographer", new Date(now.getTime() + 5000), group);
    expect((await getJob(env.DB, ward.wardId, jobId(placed[0])))?.project_id).toBe(second.projectId);

    // 文字のある写真をAIが無関係と見ても残す。実際のreadOriginalsを通す。
    setPipelineDeps({ createClient: () => ai, readImpl: async (client, input) => {
      const { readOriginals } = await import("../src/ai/read");
      const result = await readOriginals(client, input);
      return { ...result, body: { ...result.body, summary: fixture.previousMaterial } };
    } });
    const unmatched = await send([9], "fictional-new-person", new Date(now.getTime() + 6000));
    expect(matchCalls).toBe(1);
    expect(await getJob(env.DB, ward.wardId, jobId(unmatched[0]))).toMatchObject({ project_id: null, status: "read", withdrawn_at: null });
    const unrelatedGroup = await send([10], "fictional-new-person", new Date(now.getTime() + 7000), "fictional-other-group");
    expect(matchCalls).toBe(2);
    expect((await getJob(env.DB, ward.wardId, jobId(unrelatedGroup[0])))?.withdrawn_at).toBeNull();
    matchChoice = second.projectId;
    const aiPlaced = await send([11], "fictional-newest-person", new Date(now.getTime() + 8000));
    expect((await getJob(env.DB, ward.wardId, jobId(aiPlaced[0])))?.project_id).toBe(second.projectId);

    // 回答票の符号は、結び付いているグループの行事より先。
    const code = await makeProjectPaperCode(env.DB, ward.wardId, first.projectId);
    if (!code) throw new Error("紙の符号がありません");
    const sheet = await receive(runtime, { wardId: ward.wardId, via: "line_group", readKind: "answer_sheet",
      parts: [{ kind: "photo", filename: fixture.answerSheetFilename, mediaType: "image/jpeg", bytes: new Uint8Array([...fixture.answerSheetPhotoBytes, 12]) }] });
    if (!sheet.jobId) throw new Error("回答票を受け取れません");
    await registerLinePhoto(env.DB, ward.wardId, { destination, source: { type: "group", id: group, senderId: "fictional-photographer" }, jobId: sheet.jobId, messageId: "12", now });
    setPipelineDeps({ createClient: () => ai, readImpl: async () => ({ body: { ...fixture.answerSheetReading,
      rows: fixture.answerSheetReading.rows.map((row) => ({ ...row, original_id: sheet.received[0]!.originalId, paper_code: code })) },
      packVersion: "photo-context-test@1", model: "fictional", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } }) });
    await ports.readPhoto?.(ward.wardId, sheet.jobId);
    expect((await getJob(env.DB, ward.wardId, sheet.jobId))?.project_id).toBe(first.projectId);
    expect(await getReadings(env.DB, ward.wardId, sheet.jobId)).toHaveLength(1);
    expect(await env.DB.prepare("SELECT 1 FROM line_unrelated_daily_counts WHERE ward_id = ?").bind(ward.wardId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM line_inbox_items WHERE ward_id = ?").bind(other.ward.wardId).first()).toBeNull();
    await Promise.all(pending);
  } finally {
    setPipelineDeps(null);
    setClientFactory(null);
    vi.unstubAllGlobals();
  }
});
