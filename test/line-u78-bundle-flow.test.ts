import { redirectedTalkPage } from "./fixtures/line-u83-page";
import { listTalks } from "../src/line/talks";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { U62_TEXT_FLOW as texts } from "../fixtures/line-sim/u62-text-flow";
import { buildMatchPrompt, MATCH_NEW, MATCH_UNRELATED } from "../src/ai/match";
import type { Reading } from "../src/ai/schema";
import { seedAdmin } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import { receive } from "../src/intake/receive";
import { setPipelineDeps } from "../src/intake/pipeline";
import { listOriginals } from "../src/intake/store";
import { listClarifications, processPhotoBatches } from "../src/line/clarifications";
import { createLineIntakePorts, type LineIntakePorts, type LineOriginal } from "../src/line/intake";
import { clearPhotoTexts, lineBundleContents, photoContextProject, PHOTO_TEXT_TTL_MS, purgePhotoTexts } from "../src/line/photo-context";
import { acceptLineWebhook } from "../src/line/webhook";
import { get, realApp, withEnv } from "./helpers";

it("U78: 写真と言葉を送信者ごとに10分で結び、一回受領し、一件の問い合わせと一枚の画面に残す", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const runtime = withEnv({ LINE_CHANNEL_SECRET: "fictional-u78-secret", LINE_CHANNEL_ACCESS_TOKEN: "fictional-u78-token" });
  const destination = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding) VALUES (?, ?, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN')")
    .bind(ward.wardId, destination).run();
  const sent: Array<{ replyToken: string; messages: Array<{ text: string }> }> = [];
  const fakeLine: typeof fetch = async (url, init) => {
    if (String(url).includes("api-data.line.me")) {
      const tag = Number(/\/message\/(\d+)\//.exec(String(url))?.[1]);
      if (!Number.isInteger(tag)) throw new Error("試しの写真の番号がありません");
      return new Response(new Uint8Array([...fixture.answerSheetPhotoBytes, tag]), { headers: { "content-type": "image/jpeg" } });
    }
    if (String(url).includes("/member/")) return Response.json({ displayName: fixture.sheetHelper });
    if (String(url).endsWith("/message/reply")) {
      sent.push(JSON.parse(String(init?.body)) as (typeof sent)[number]);
      return Response.json({ sentMessages: [{ id: `fictional-u78-reply-${sent.length}` }] });
    }
    throw new Error("この試験にない外部通信です");
  };
  const judged: LineOriginal[] = [];
  const matcher = createLineIntakePorts(runtime, { waitUntil: () => undefined }, async (_wardId, original) => {
    judged.push(original);
    return { choice: original.text === texts.chat ? MATCH_UNRELATED : MATCH_NEW,
      reason: "試しの資料の読みと言葉で判断しました。", intent: original.text?.includes(texts.questions[1]!.text) || (original.text?.includes(texts.questions[0]!.text) && original.photoSummaries?.includes(fixture.previousMaterial)) ? "inquiry" : "material",
      attendanceAnswer: false, usage: { input_tokens: 1, output_tokens: 1 } };
  });
  // 署名、受付、D1、R2、当ての入力と画面は本体を通す。写真の読みだけ試しの資料の読みを保存する。
  const ports: LineIntakePorts = {
    matchInboxItem: matcher.matchInboxItem,
    async receiveOriginal(wardId, original) {
      const result = await receive(runtime, { wardId, via: original.sourceType === "user" ? "line_direct" : "line_group",
        parts: [{ kind: original.kind === "image" ? "photo" : "text", filename: fixture.answerSheetFilename,
          mediaType: original.contentType ?? "text/plain", bytes: original.bytes ? new Uint8Array(original.bytes) : new TextEncoder().encode(original.text) }] });
      return result.jobId;
    },
    async readPhoto(wardId, jobId) {
      const original = (await listOriginals(env.DB, wardId, jobId))[0];
      if (!original) throw new Error("読み取る写真がありません");
      const reading: Reading = { document_kind: "photo", summary: fixture.previousMaterial,
        original_years: [{ original_id: original.original_id, year: fixture.eventYear }],
        text_blocks: [{ original_id: original.original_id, locator: "全体", text: fixture.previousMaterial }],
        fields: [], tables: [], decisions: [], unreadable: [] };
      await env.DB.prepare("INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at) VALUES (?, ?, ?, 'model', 'read-general@3', 'claude-sonnet-5-5', ?, ?)")
        .bind(crypto.randomUUID(), wardId, jobId, JSON.stringify(reading), new Date().toISOString()).run();
      await env.DB.prepare("UPDATE jobs SET status = 'read', read_at = ? WHERE ward_id = ? AND job_id = ?")
        .bind(new Date().toISOString(), wardId, jobId).run();
    },
    async assignProject() { throw new Error("この試験では行事を決めません"); },
    async discard() { throw new Error("写真をAIの判断で消しません"); },
  };
  let at = new Date("2026-11-07T01:00:00Z");
  let number = 0;
  const send = async (message: string | number, person: string, minutes = 1, group?: string) => {
    at = new Date(at.getTime() + minutes * 60_000);
    vi.setSystemTime(at);
    const eventId = `fictional-u78-${String(++number).padStart(3, "0")}`;
    const body = JSON.stringify({ destination, events: [{ type: "message", webhookEventId: eventId, timestamp: at.getTime(), replyToken: `${eventId}-reply`,
      source: group ? { type: "group", groupId: group, userId: person } : { type: "user", userId: person },
      message: typeof message === "number" ? { type: "image", id: String(message), imageSet: { id: eventId, index: 1, total: 1 } }
        : { type: "text", id: eventId, text: message } }] });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(runtime.LINE_CHANNEL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
    expect((await acceptLineWebhook(new Request("https://unit.test/hooks/line", { method: "POST", headers: { "x-line-signature": signature }, body }),
      runtime, env.DB, { ports, fetch: fakeLine }, at)).status).toBe(200);
    return eventId;
  };
  const item = async (eventId: string) => {
    const row = await env.DB.prepare("SELECT item_id, job_id, bundle_id FROM line_inbox_items WHERE ward_id = ? AND event_id = ?")
      .bind(ward.wardId, eventId).first<{ item_id: string; job_id: string; bundle_id: string }>();
    if (!row) throw new Error("届いたものがありません");
    return row;
  };
  const receipt = async (eventId: string) => {
    const row = await env.DB.prepare("SELECT bundle_id FROM line_webhook_receipts WHERE ward_id = ? AND event_id = ?")
      .bind(ward.wardId, eventId).first<{ bundle_id: string }>();
    if (!row) throw new Error("受け取りの記録がありません");
    return row;
  };
  const inquiry = async (bundleId: string) => {
    const rows = await env.DB.prepare("SELECT inquiry_id, subject, line_bundle_id FROM inquiry_records WHERE ward_id = ? AND line_bundle_id = ?")
      .bind(ward.wardId, bundleId).all<{ inquiry_id: string; subject: string; line_bundle_id: string }>();
    expect(rows.results).toHaveLength(1);
    return rows.results[0]!;
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubGlobal("fetch", fakeLine);
  const photoAi = new Anthropic({ apiKey: "fictional-u78-ai-key", maxRetries: 0, fetch: async () => Response.json({
    id: "fictional-u78-photo-match", type: "message", role: "assistant", model: "claude-haiku-5-5",
    content: [{ type: "text", text: JSON.stringify({ choice: "__uncertain__", confident: false, reason: "試しの写真の行事は分かりません。", intent: "material", attendanceAnswer: false, knowTopic: "none" }) }],
    stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
  }) });
  setPipelineDeps({ createClient: () => photoAi });
  try {
    const firstPhoto = await item(await send(201, "fictional-u78-first"));
    const firstText = await receipt(await send(texts.questions[0]!.text, "fictional-u78-first"));
    expect(firstText.bundle_id).toBe(firstPhoto.bundle_id);
    expect(judged.at(-1)?.photoSummaries).toEqual([fixture.previousMaterial]);
    const firstInquiry = await inquiry(firstPhoto.bundle_id);
    expect(firstInquiry.subject).toBe(texts.questions[0]!.text);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.messages[0]?.text).toContain("受け取りました");
    // 受領を返した後の問い合わせの一言は重ねない。
    expect(sent.some((s) => s.messages[0]?.text === "役員に伝えて、内容を確認します。")).toBe(false);
    const root = `/${ward.slug}/admin`;
    const html = await (await get(realApp, `${root}/inquiries/${firstInquiry.inquiry_id}`, cookie, runtime)).text();
    expect(html).toContain(`${root}/inbox/${firstPhoto.item_id}/original`);
    expect(html).toContain("一緒に送られた言葉");
    expect(html).toContain(texts.questions[0]!.text);
    expect((await get(realApp, `${root}/inbox/${firstPhoto.item_id}/original`, cookie, runtime)).headers.get("content-type")).toBe("image/jpeg");
    const inboxHtml = await (await get(realApp, `${root}/inbox`, cookie, runtime)).text();
    expect(inboxHtml).toContain("/inbox/talks/");
    const conversation = await redirectedTalkPage(`${root}/inbox/${firstPhoto.item_id}/pick`, cookie, runtime);
    expect(conversation).toContain(`${root}/inquiries/${firstInquiry.inquiry_id}`);
    expect(conversation).toContain(texts.questions[0]!.text);
    expect(inboxHtml).not.toContain(`${root}/inbox/${firstPhoto.item_id}/pick`);

    // 言葉が先なら、写真を読み終えた時点で一件の問い合わせになる。
    const reverseText = await item(await send(texts.questions[0]!.text, "fictional-u78-reverse"));
    const reversePhoto = await item(await send(202, "fictional-u78-reverse"));
    expect(reversePhoto.bundle_id).toBe(reverseText.bundle_id);
    expect((await inquiry(reversePhoto.bundle_id)).subject).toBe(texts.questions[0]!.text);
    expect(sent).toHaveLength(2);
    expect(judged.some((o) => o.bundleId === reversePhoto.bundle_id && o.photoSummaries?.includes(fixture.previousMaterial))).toBe(true);
    // 10分ちょうど、さらにその投稿から10分ちょうども同じ。最初からの経過では区切らない。
    const continued = await receipt(await send(fixture.dutyText, "fictional-u78-reverse", 10));
    const continuedAgain = await receipt(await send(fixture.reportText, "fictional-u78-reverse", 10));
    expect(continued.bundle_id).toBe(reverseText.bundle_id);
    expect(continuedAgain.bundle_id).toBe(reverseText.bundle_id);
    expect((await inquiry(reverseText.bundle_id)).subject).toBe([texts.questions[0]!.text, fixture.dutyText, fixture.reportText].join("\n"));
    expect(sent).toHaveLength(2);
    const separated = await item(await send(fixture.previousMaterial, "fictional-u78-reverse", 10 + 1 / 60_000));
    expect(separated.bundle_id).not.toBe(reverseText.bundle_id);

    // 同じグループでも、別の人の文と写真を入れない。
    const groupPhoto = await item(await send(203, "fictional-u78-member", 1, "fictional-u78-group"));
    const stranger = await item(await send(fixture.reportText, "fictional-u78-stranger", 1, "fictional-u78-group"));
    const caption = await item(await send(fixture.dutyText, "fictional-u78-member", 1, "fictional-u78-group"));
    expect(caption.bundle_id).not.toBe(groupPhoto.bundle_id);
    expect(stranger.bundle_id).not.toBe(groupPhoto.bundle_id);
    const groupContents = await lineBundleContents(env.DB, ward.wardId, groupPhoto.bundle_id);
    expect(groupContents.text).toBe("");
    expect((await lineBundleContents(env.DB, ward.wardId, caption.bundle_id)).text).toBe(fixture.dutyText);
    expect(groupContents.photos.map((p) => p.item_id)).toEqual([groupPhoto.item_id]);
    const pick = await redirectedTalkPage(`${root}/inbox/${groupPhoto.item_id}/pick`, cookie, runtime);
    expect(pick).toContain(fixture.dutyText);
    const groupOriginal = (await listOriginals(env.DB, ward.wardId, groupPhoto.job_id))[0];
    if (!groupOriginal) throw new Error("元の写真がありません");
    expect(pick).toContain(`${root}/intake/originals/${groupOriginal.original_id}`);
    expect(pick).toContain(fixture.reportText);
    expect(pick.indexOf(fixture.reportText)).toBeLessThan(pick.indexOf(fixture.dutyText));
    const batch = await env.DB.prepare(`SELECT b.* FROM line_photo_batches b JOIN line_photo_items p ON p.ward_id = b.ward_id AND p.batch_id = b.batch_id
      WHERE b.ward_id = ? AND p.job_id = ?`).bind(ward.wardId, groupPhoto.job_id).first<import("../src/line/photo-context").PhotoBatchContext>();
    if (!batch) throw new Error("写真の受け取りがありません");
    const context = await photoContextProject(env.DB, ward.wardId, batch, at);
    expect(context.after.map((t) => t.summary)).toEqual([fixture.dutyText]);
    expect(JSON.stringify(context)).not.toContain(fixture.reportText);
    await clearPhotoTexts(env.DB, ward.wardId, batch);
    await purgePhotoTexts(env.DB, ward.wardId, new Date(at.getTime() + PHOTO_TEXT_TTL_MS));
    expect((await lineBundleContents(env.DB, ward.wardId, caption.bundle_id)).text).toBe(fixture.dutyText);
    const groupTalk = (await listTalks(env.DB, ward.wardId)).find((talk) => talk.posts.some((post) => post.itemId === groupPhoto.item_id));
    if (!groupTalk) throw new Error("グループの会話がありません");
    expect(groupTalk.posts.map((post) => post.itemId)).toEqual([groupPhoto.item_id, stranger.item_id, caption.item_id]);

    const beforeEarly = sent.length;
    const early = await receipt(await send(texts.questions[1]!.text, "fictional-u78-early"));
    expect(sent).toHaveLength(beforeEarly + 1);
    expect(sent.at(-1)?.messages[0]?.text).toBe("役員に伝えて、内容を確認します。");
    const earlyPhoto = await item(await send(204, "fictional-u78-early"));
    expect(earlyPhoto.bundle_id).toBe(early.bundle_id);
    expect(sent).toHaveLength(beforeEarly + 1);
    expect((await inquiry(early.bundle_id)).subject).toBe(texts.questions[1]!.text);

    const beforeGroup = sent.length;
    const groupRequest = await item(await send(texts.questions[0]!.text, "fictional-u78-group-request", 1, "fictional-u78-request-talk"));
    expect(sent).toHaveLength(beforeGroup);
    const requestPhoto = await item(await send(205, "fictional-u78-group-request", 1, "fictional-u78-request-talk"));
    expect(requestPhoto.bundle_id).toBe(groupRequest.bundle_id);
    expect(sent).toHaveLength(beforeGroup + 1);
    expect(sent.at(-1)?.messages[0]?.text).toBe("役員に伝えて、内容を確認します。");
    await inquiry(requestPhoto.bundle_id);

    await processPhotoBatches(runtime, ward.wardId, { fetch: fakeLine, now: at });
    expect((await listClarifications(env.DB, ward.wardId)).some((q) => [firstPhoto.job_id, reversePhoto.job_id].includes(q.job_id))).toBe(false);
    const chat = await send(texts.chat, "fictional-u78-chat");
    expect(await env.DB.prepare("SELECT item_id FROM line_inbox_items WHERE ward_id = ? AND event_id = ?").bind(ward.wardId, chat).first()).toBeNull();
    expect(await env.DB.prepare("SELECT text FROM line_photo_context_texts WHERE ward_id = ? AND event_id = ?").bind(ward.wardId, chat).first()).toBeNull();
    const original = (await listOriginals(env.DB, ward.wardId, firstPhoto.job_id))[0];
    if (!original?.r2_path) throw new Error("元の写真がありません");
    expect(await new WardBucket(env.ORIGINALS, ward.wardId).get(original.r2_path)).not.toBeNull();
    expect((await lineBundleContents(env.DB, other.ward.wardId, firstPhoto.bundle_id)).items).toHaveLength(0);
    expect((await get(realApp, `/${other.ward.slug}/admin/inbox/${firstPhoto.item_id}/original`, other.cookie, runtime)).status).toBe(404);
    expect(buildMatchPrompt({ candidates: [], summary: texts.questions[0]!.text, officialAddressed: true, photoSummaries: [fixture.previousMaterial] }))
      .toContain(fixture.previousMaterial);
  } finally {
    setPipelineDeps(null);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
