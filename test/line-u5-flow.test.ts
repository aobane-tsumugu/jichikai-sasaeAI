import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { setClientFactory } from "../src/ai/deps";
import type { Reading } from "../src/ai/schema";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { listClarifications, processPhotoBatches, registerLinePhoto } from "../src/line/clarifications";
import { acceptLineWebhook } from "../src/line/webhook";
import type { LineIntakePorts } from "../src/line/intake";
import { createProject } from "../src/project/api";
import { getDigestSettings } from "../src/settings/digest";
import { sendOfficerDigest } from "../src/line/digest";
import { saveDocument } from "../src/project/actions";
import { recordLineInquiry } from "../src/project/followup";
import { get, postForm, realApp, withEnv } from "./helpers";

it("写真を引用して一問ずつ聞き、撮り直しと分からないで閉じ、役員が元のトークへ返事を送り、翌朝知らせて雨は送らず配る", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: fixture.draftTitle, year: fixture.eventYear, accountId: account.accountId });
  const root = `/${ward.slug}/admin`;
  const now = new Date("2026-11-06T01:00:00Z");
  const secret = "fictional-u5-secret";
  const destination = crypto.randomUUID();
  const groupId = "C-fictional-u5-group";
  await env.DB.prepare("INSERT INTO ward_settings (ward_id, key, value) VALUES (?, 'line.officer_group', ?)").bind(ward.wardId, "C-fictional-officers").run();
  const runtime = withEnv({ LINE_CHANNEL_SECRET: secret, LINE_CHANNEL_ACCESS_TOKEN: "fictional-u5-token"});
  await env.DB.prepare("INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding) VALUES (?, ?, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN')")
    .bind(ward.wardId, destination).run();
  type Sent = { to?: string; replyToken?: string; messages: Array<{ text: string; quoteToken?: string; quickReply?: { items: Array<{ action: { type: string; data?: string } }> } }> };
  const sent: Sent[] = [];
  let rejected = false;
  const fakeLine: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("api-data.line.me")) return new Response(new Uint8Array(fixture.answerSheetPhotoBytes), { headers: { "content-type": "image/jpeg" } });
    if (url.endsWith("/message/reply") || url.endsWith("/message/push")) {
      if (rejected && url.endsWith("/push")) return Response.json({ message: "fictional rejection" }, { status: 400 });
      sent.push(JSON.parse(String(init?.body)) as Sent);
      return Response.json({ sentMessages: [{ id: `fictional-u5-${sent.length}` }] });
    }
    if (url.includes("/member/")) return Response.json({ displayName: fixture.sheetHelper });
    if (url.endsWith("/message/quota")) return Response.json({ type: "limited", value: 200 });
    if (url.endsWith("/consumption")) return Response.json({ totalUsage: 0 });
    if (url.endsWith("/members/count")) return Response.json({ count: 3 });
    throw new Error(`この試験で許可しないLINE呼び出し: ${url}`);
  };
  const fakeAi = new Anthropic({ apiKey: "fictional-u5-key", fetch: async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const question = (JSON.parse(body.messages[0]!.content) as { questions: Array<{ text: string }> }).questions[0];
    return Response.json({ id: "fictional-u5-ai", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: JSON.stringify({ text: question?.text }) }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  const photoJob = async (tag: number) => {
    const result = await receive(runtime, { wardId: ward.wardId, projectId: project.projectId, via: "line_group", parts: [{ kind: "photo", filename: fixture.answerSheetFilename,
      mediaType: "image/jpeg", bytes: new Uint8Array([...fixture.answerSheetPhotoBytes, tag]) }] });
    if (!result.jobId) throw new Error("架空の写真を受け付けられませんでした");
    return result.jobId;
  };
  const saveReading = async (jobId: string, unreadable: boolean, year: number | null) => {
    const original = await env.DB.prepare("SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ?").bind(ward.wardId, jobId).first<{ original_id: string }>();
    if (!original) throw new Error("元の写真がありません");
    const reading: Reading = { document_kind: "rota", summary: fixture.dutyText, original_years: [{ original_id: original.original_id, year }],
      text_blocks: [{ original_id: original.original_id, locator: "全体", text: fixture.dutyText }], fields: [], tables: [], decisions: [],
      unreadable: unreadable ? [{ original_id: original.original_id, locator: "下の時間", note: "時刻が読めません" }] : [] };
    await env.DB.prepare("INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at) VALUES (?, ?, ?, 'model', 'read-general@3', 'claude-sonnet-5-5', ?, ?)")
      .bind(crypto.randomUUID(), ward.wardId, jobId, JSON.stringify(reading), now.toISOString()).run();
    await env.DB.prepare("UPDATE jobs SET status = 'read', read_at = ? WHERE ward_id = ? AND job_id = ?").bind(now.toISOString(), ward.wardId, jobId).run();
  };
  const ports: LineIntakePorts = {
    receiveOriginal: async (_wardId, original) => {
      if (original.kind === "image") return photoJob(9);
      const result = await receive(runtime, { wardId: ward.wardId, projectId: project.projectId, via: "line_group", parts: [{ kind: "text", filename: "", mediaType: "text/plain", bytes: new TextEncoder().encode(original.text) }] });
      return result.jobId;
    },
    matchInboxItem: async () => ({ disposition: "matched", projectId: project.projectId }),
    assignProject: async (wardId, jobId, projectId) => { await env.DB.prepare("UPDATE jobs SET project_id = ? WHERE ward_id = ? AND job_id = ?").bind(projectId, wardId, jobId).run(); },
    discard: async () => { throw new Error("元の写真は消しません"); },
  };
  const webhook = async (event: object) => {
    const body = JSON.stringify({ destination, events: [event] });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
    return acceptLineWebhook(new Request("https://unit.test/hooks/line", { method: "POST", headers: { "x-line-signature": signature }, body }), runtime, env.DB, { fetch: fakeLine, ports, matchAnswer: async (_client, text, questions) => questions.slice(0, 1).map((question) => ({ id: question.id, text })) }, now);
  };
  setClientFactory(() => fakeAi);
  vi.stubGlobal("fetch", fakeLine);
  try {
    for (const index of [1, 2]) {
      const jobId = await photoJob(index);
      await registerLinePhoto(env.DB, ward.wardId, { destination, source: { type: "group", id: groupId, senderId: "fictional-photographer" }, jobId,
        messageId: `fictional-photo-${index}`, quoteToken: `fictional-quote-${index}`, replyToken: "fictional-photo-reply", imageSet: { id: "fictional-set", index, total: 2 }, now });
      await saveReading(jobId, index === 1, index === 1 ? fixture.eventYear : null);
    }
    await processPhotoBatches(runtime, ward.wardId, { fetch: fakeLine, now });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.messages[0]?.quoteToken).toBeTruthy();
    expect(sent[0]?.messages[0]?.text).not.toMatch(/\d枚目/);
    const questions = await listClarifications(env.DB, ward.wardId);
    expect(questions).toHaveLength(2);
    // 同じ場所の別の人からも答えられる。先に来た質問が年なら、ボタンで先へ進める。
    const answerOpen = async () => {
      const active = (await listClarifications(env.DB, ward.wardId)).find((q) => q.sent_at && !q.answer);
      if (!active) throw new Error("答えを待つ質問がありません");
      return active;
    };
    let active = await answerOpen();
    if (active.topic === "year") {
      await webhook({ type: "postback", webhookEventId: "fictional-year-first", replyToken: "fictional-year-first-reply", source: { type: "group", groupId, userId: "fictional-other" }, postback: { data: new URLSearchParams({ clarification: active.id, answer: "分からない" }).toString() } });
      active = await answerOpen();
    }
    expect(active.topic).toBe("unreadable");
    expect(sent.at(-1)?.messages[0]?.quickReply?.items.some((item) => item.action.type === "postback" && new URLSearchParams(item.action.data).get("retake") === "1")).toBe(true);
    if (!active.sent_message_id) throw new Error("引用する質問の送信記録がありません");
    await webhook({ type: "message", webhookEventId: "fictional-retake", replyToken: "fictional-retake-reply", source: { type: "group", groupId, userId: "fictional-other" }, message: { type: "image", id: "fictional-retake-image", quoteToken: "fictional-retake-quote", quotedMessageId: active.sent_message_id } });
    const retake = await env.DB.prepare("SELECT job_id FROM line_photo_items WHERE ward_id = ? AND retake_clarification_id = ?").bind(ward.wardId, active.id).first<{ job_id: string }>();
    if (!retake) throw new Error("撮り直しと質問が結び付いていません");
    await saveReading(retake.job_id, false, fixture.eventYear);
    await processPhotoBatches(runtime, ward.wardId, { fetch: fakeLine, now });
    expect((await listClarifications(env.DB, ward.wardId)).find((q) => q.id === active.id)?.answer).toContain("読み取れました");
    const last = (await listClarifications(env.DB, ward.wardId)).find((q) => !q.answer);
    if (last) await webhook({ type: "postback", webhookEventId: "fictional-year-last", replyToken: "fictional-year-last-reply", source: { type: "group", groupId, userId: "fictional-other" }, postback: { data: new URLSearchParams({ clarification: last.id, answer: "分からない" }).toString() } });
    expect(sent.at(-1)?.messages[0]?.text).toBe("聞くことは以上です。分からなかったところは役員が確かめます。");
    const completedCount = sent.length;
    await processPhotoBatches(runtime, ward.wardId, { fetch: fakeLine, now: new Date(now.getTime() + 3600_000) });
    expect(sent).toHaveLength(completedCount);
    expect(await listClarifications(env.DB, other.ward.wardId)).toHaveLength(0);

    // 一対一でも引用し、答えが無い間は完了も催促も送らない。文字でも答えられる。
    const directPhoto = await photoJob(10);
    await registerLinePhoto(env.DB, ward.wardId, { destination, source: { type: "user", id: "fictional-photo-user", senderId: "fictional-photo-user" }, jobId: directPhoto,
      messageId: "fictional-direct-photo", quoteToken: "fictional-direct-quote", replyToken: "fictional-direct-photo-reply", imageSet: { id: "fictional-direct-set", index: 1, total: 1 }, now });
    await saveReading(directPhoto, true, fixture.eventYear);
    await processPhotoBatches(runtime, ward.wardId, { fetch: fakeLine, now });
    expect(sent.at(-1)?.messages[0]?.quoteToken).toBe("fictional-direct-quote");
    const waitingCount = sent.length;
    await processPhotoBatches(runtime, ward.wardId, { fetch: fakeLine, now: new Date(now.getTime() + 3600_000) });
    expect(sent).toHaveLength(waitingCount);
    await webhook({ type: "message", webhookEventId: "fictional-text-answer", replyToken: "fictional-text-answer-reply", source: { type: "user", userId: "fictional-photo-user" }, message: { type: "text", id: "fictional-text-answer", text: fixture.publicDayText } });
    expect(sent.at(-1)?.messages[0]?.text).toContain("聞くことは以上です");

    // 問い合わせはAIを呼ばず受け、グループは元のグループ、一対一は本人へ送る。
    for (const [id, source] of [["fictional-group-inquiry", { type: "group", groupId, userId: "fictional-member" }], ["fictional-direct-inquiry", { type: "user", userId: "fictional-user" }]] as const) {
      await webhook({ type: "message", webhookEventId: id, replyToken: `${id}-reply`, source, message: { type: "text", id, text: `公式へ、${fixture.draftTitle}は何時ですか。` } });
    }
    const inquiry = await env.DB.prepare("SELECT inquiry_id FROM inquiry_records WHERE ward_id = ? AND line_event_id = 'fictional-group-inquiry'").bind(ward.wardId).first<{ inquiry_id: string }>();
    if (!inquiry) throw new Error("問い合わせが届いていません");
    const replyPath = `${root}/inquiries/${inquiry.inquiry_id}`;
    const beforeReply = sent.length;
    const reply = await postForm(realApp, replyPath, { answer: fixture.publicDayText, operation: "send" }, cookie, runtime);
    expect(reply.status).toBe(303);
    expect(sent.slice(beforeReply).map((message) => message.to).sort()).toEqual([groupId, "fictional-user"].sort());
    expect((await postForm(realApp, replyPath, { answer: fixture.publicDayText, operation: "send" }, cookie, runtime)).status).toBe(303);
    expect(sent).toHaveLength(beforeReply + 2);
    expect((await env.DB.prepare("SELECT answer FROM inquiry_records WHERE ward_id = ?").bind(ward.wardId).all<{ answer: string }>()).results.every((r) => r.answer === fixture.publicDayText)).toBe(true);
    await webhook({ type: "message", webhookEventId: "fictional-no-user", replyToken: "fictional-no-user-reply", source: { type: "group", groupId }, message: { type: "text", id: "fictional-no-user", text: `公式へ、${fixture.previousMaterial}を教えてください。` } });
    const noUser = await env.DB.prepare("SELECT inquiry_id FROM inquiry_records WHERE ward_id = ? AND line_event_id = 'fictional-no-user'").bind(ward.wardId).first<{ inquiry_id: string }>();
    if (!noUser) throw new Error("発言者のIDがないグループの問い合わせがありません");
    // 発言者のIDがなくても、届いたグループが分かればそこへ返せる。
    const noUserPath = `${root}/inquiries/${noUser.inquiry_id}`;
    const noUserHtml = await (await get(realApp, noUserPath, cookie, runtime)).text();
    expect(noUserHtml).toContain("1か所に送る");
    expect(noUserHtml).not.toContain("送り先が分からないため送れません");
    const beforeNoUserReply = sent.length;
    expect((await postForm(realApp, noUserPath, { answer: fixture.publicDayText, operation: "send" }, cookie, runtime)).status).toBe(303);
    expect(sent.slice(beforeNoUserReply)).toMatchObject([{ to: groupId, messages: [{ text: fixture.publicDayText }] }]);
    expect(await env.DB.prepare("SELECT line_user_id, answer, line_answer_sent_at IS NOT NULL AS sent, line_pending_answer FROM inquiry_records WHERE ward_id = ? AND inquiry_id = ?")
      .bind(ward.wardId, noUser.inquiry_id).first()).toEqual({ line_user_id: null, answer: fixture.publicDayText, sent: 1, line_pending_answer: null });
    expect((await postForm(realApp, noUserPath, { answer: fixture.publicDayText, operation: "send" }, cookie, runtime)).status).toBe(303);
    expect(sent).toHaveLength(beforeNoUserReply + 1);

    // 届いた場所そのものが分からない記録は、送らずに書いた返事を残す。
    await recordLineInquiry(env.DB, ward.wardId, { eventId: "fictional-no-target", receivedAt: now.toISOString(), text: fixture.previousMaterial,
      sourceType: "group", sourceId: "", userId: null, senderLabel: null });
    const noTarget = await env.DB.prepare("SELECT inquiry_id FROM inquiry_records WHERE ward_id = ? AND line_event_id = 'fictional-no-target'").bind(ward.wardId).first<{ inquiry_id: string }>();
    if (!noTarget) throw new Error("送り先が分からない問い合わせがありません");
    const noTargetPath = `${root}/inquiries/${noTarget.inquiry_id}`;
    expect(await (await get(realApp, noTargetPath, cookie, runtime)).text()).toContain("送り先が分からないため送れません");
    const beforeNoTargetReply = sent.length;
    const noTargetReply = await postForm(realApp, noTargetPath, { answer: fixture.publicDayText, operation: "send" }, cookie, runtime);
    expect(noTargetReply.status).toBe(400);
    expect(await noTargetReply.text()).toContain("電話や直接");
    expect(sent).toHaveLength(beforeNoTargetReply);
    expect(await env.DB.prepare("SELECT answer, line_answer_sent_at, line_pending_answer FROM inquiry_records WHERE ward_id = ? AND inquiry_id = ?")
      .bind(ward.wardId, noTarget.inquiry_id).first()).toEqual({ answer: "", line_answer_sent_at: null, line_pending_answer: fixture.publicDayText });
    rejected = true;
    expect((await postForm(realApp, replyPath, { answer: fixture.reportText, operation: "send" }, cookie, runtime)).status).toBe(502);
    expect(await (await get(realApp, replyPath, cookie, runtime)).text()).toContain(fixture.reportText);
    rejected = false;

    expect(await getDigestSettings(env.DB, ward.wardId)).toMatchObject({ cutoff: "00:00", send: "08:00" });
    const beforeDigest = sent.length;
    await sendOfficerDigest(runtime, ward.wardId, ward.slug, new Date("2026-11-06T23:00:00Z"), fakeLine);
    expect(sent).toHaveLength(beforeDigest + 1);
    expect(sent.at(-1)?.to).toBe("C-fictional-officers");
    await sendOfficerDigest(runtime, ward.wardId, ward.slug, new Date("2026-11-06T23:05:00Z"), fakeLine);
    expect(sent).toHaveLength(beforeDigest + 1);
    expect((await postForm(realApp, `${root}/settings/info`, { digest_cutoff: "01:00", digest_send: "09:00", digest_event_days: "4", digest_due_days: "2" }, cookie, runtime)).status).toBe(303);
    expect(await getDigestSettings(env.DB, ward.wardId)).toEqual({ cutoff: "01:00", send: "09:00", eventDays: 4, dueDays: 2 });

    // 配ったあとの雨の変更はAIなし。送らない選択が配布処理まで届く。
    await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, { kind: "announcement", title: "案内", scope: "public", basedOn: project.stateVersion, body: JSON.stringify({ text: fixture.publicAnnouncement, items: [] }) });
    const draft = await env.DB.prepare("SELECT document_id FROM documents WHERE ward_id = ? AND project_id = ? AND kind = 'announcement'").bind(ward.wardId, project.projectId).first<{ document_id: string }>();
    if (!draft) throw new Error("雨の変更の前の案内がありません");
    await env.DB.prepare("UPDATE document_versions SET published_at = '2026-11-06T01:00:00.000Z' WHERE ward_id = ? AND document_id = ?").bind(ward.wardId, draft.document_id).run();
    const rainHtml = await (await get(realApp, `${root}/projects/${project.projectId}/draft/notice`, cookie, runtime)).text();
    expect(rainHtml).toContain('name="lineDelivery"');
    const beforeRain = sent.length;
    const rain = await postForm(realApp, `${root}/projects/${project.projectId}/draft/rain-notice`, { templateId: "rain", eventName: fixture.draftTitle, place: fixture.previousPlace, dateTime: fixture.publicDayText, lineDelivery: "skip" }, cookie, runtime);
    expect(rain.status).toBe(303);
    expect(sent).toHaveLength(beforeRain);
    expect((await env.DB.prepare("SELECT line_status FROM publication_records WHERE ward_id = ? AND project_id = ?").bind(ward.wardId, project.projectId).all<{ line_status: string }>()).results).toEqual([{ line_status: "not_sent" }]);
    expect(await (await get(realApp, `${root}/`, cookie, runtime)).text()).not.toContain(`href="${root}/ledger"`);
  } finally { setClientFactory(null); vi.unstubAllGlobals(); }
});
