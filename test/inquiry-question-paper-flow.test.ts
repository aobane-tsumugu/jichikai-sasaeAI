import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import type { Reading } from "../src/ai/schema";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { claimRead, finishRead } from "../src/intake/store";
import { attachClarificationQuestions, listClarifications, processPhotoBatches, registerLinePhoto, saveClarificationAnswers } from "../src/line/clarifications";
import { sendOfficerDigest } from "../src/line/digest";
import type { LineIntakePorts } from "../src/line/intake";
import { acceptLineWebhook } from "../src/line/webhook";
import { createProject, getProjectState } from "../src/project/api";
import { saveDocument } from "../src/project/actions";
import { getSetting, setSetting } from "../src/settings/store";
import { digestCutoff, digestPeriodLabel } from "../src/settings/digest";
import { get, postForm, realApp, withEnv } from "./helpers";

it("混ざった送り先の返事を残った場所へだけ送り直し、時刻の知らせと画面の質問、下書きの紙をつなぐ", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const now = new Date("2026-11-06T01:00:00Z");
  const destination = crypto.randomUUID();
  const group = "C-fictional-u13-group";
  const secret = "fictional-u13-secret";
  await env.DB.prepare("INSERT INTO ward_settings (ward_id, key, value) VALUES (?, 'line.officer_group', ?)").bind(ward.wardId, "C-fictional-u13-officers").run();
  const runtime = withEnv({ LINE_CHANNEL_SECRET: secret, LINE_CHANNEL_ACCESS_TOKEN: "fictional-u13-token"});
  await env.DB.prepare("INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding) VALUES (?, ?, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN')").bind(ward.wardId, destination).run();
  const calls: Array<{ to: string; text: string; key: string }> = [];
  const accepted = new Set<string>();
  let lostReply = true;
  let used = 0;
  let replies = 0;
  const fakeLine: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/message/quota")) return Response.json({ type: "limited", value: 200 });
    if (url.endsWith("/consumption")) return Response.json({ totalUsage: used });
    if (url.endsWith("/members/count")) return Response.json({ count: 4 });
    if (url.includes("/insight/followers?")) return Response.json({ status: "ready", followers: 2 });
    if (url.includes("/profile/") || url.includes("/member/")) return Response.json({ displayName: fixture.sheetHelper });
    if (url.endsWith("/message/reply")) { replies += 1; return Response.json({ sentMessages: [{ id: crypto.randomUUID() }] }); }
    if (url.endsWith("/message/push")) {
      const body = JSON.parse(String(init?.body)) as { to: string; messages: Array<{ text: string }> };
      const key = new Headers(init?.headers).get("X-Line-Retry-Key") ?? "";
      calls.push({ to: body.to, text: body.messages[0]!.text, key });
      if (accepted.has(key)) return new Response(null, { status: 409, headers: { "x-line-accepted-request-id": "fictional-u13-accepted" } });
      accepted.add(key);
      if (body.to === group && lostReply) { lostReply = false; throw new TypeError("試しの応答切断"); }
      return Response.json({ sentMessages: [{ id: crypto.randomUUID() }] });
    }
    throw new Error(`試験にない外への呼び出し: ${url}`);
  };
  const ports: LineIntakePorts = {
    receiveOriginal: async () => { throw new Error("問い合わせを資料には入れません"); },
    matchInboxItem: async () => { throw new Error("問い合わせにAIを使いません"); },
    assignProject: async () => { throw new Error("問い合わせを行事に割り当てません"); },
    discard: async () => { throw new Error("資料を消しません"); },
  };
  const webhook = async (id: string, source: { type: "user" | "group"; userId?: string; groupId?: string }, text: string) => {
    const body = JSON.stringify({ destination, events: [{ type: "message", webhookEventId: id, timestamp: now.getTime(), replyToken: id, source, message: { type: "text", id, text } }] });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
    expect((await acceptLineWebhook(new Request("https://unit.test/hooks/line", { method: "POST", headers: { "x-line-signature": signature }, body }), runtime, env.DB, { fetch: fakeLine, ports }, now)).status).toBe(200);
  };
  vi.stubGlobal("fetch", fakeLine);
  try {
    const subject = `${fixture.draftTitle}は何時ですか？`;
    await webhook("fictional-u13-direct-a", { type: "user", userId: "U-fictional-u13-a" }, subject);
    await webhook("fictional-u13-direct-b", { type: "user", userId: "U-fictional-u13-b" }, subject);
    await webhook("fictional-u13-group", { type: "group", groupId: group, userId: "U-fictional-u13-member" }, `公式へ、${subject}`);
    const row = await env.DB.prepare("SELECT inquiry_id FROM inquiry_records WHERE ward_id = ? AND line_event_id = ?").bind(ward.wardId, "fictional-u13-direct-a").first<{ inquiry_id: string }>();
    if (!row) throw new Error("問い合わせがありません");
    const path = `${root}/inquiries/${row.inquiry_id}`;
    expect(await (await get(realApp, path, cookie, runtime)).text()).toContain("3か所に送る");
    expect(await (await get(realApp, `${path}/original`, cookie, runtime)).text()).toContain(`公式へ、${subject}`);
    const failed = await postForm(realApp, path, { operation: "send", answer: fixture.publicDayText }, cookie, runtime);
    expect(failed.status).toBe(502);
    expect(await failed.text()).toContain("1か所に送り直す");
    expect(calls).toHaveLength(3);
    expect((await postForm(realApp, path, { operation: "retry", answer: fixture.publicDayText }, cookie, runtime)).status).toBe(303);
    expect(calls).toHaveLength(4);
    expect(calls.filter((call) => call.to === group).map((call) => call.key)).toEqual([calls.find((call) => call.to === group)!.key, calls.find((call) => call.to === group)!.key]);
    expect(calls.filter((call) => call.to.startsWith("U-")).map((call) => call.to).sort()).toEqual(["U-fictional-u13-a", "U-fictional-u13-b"]);
    used = 200;
    const limited = await postForm(realApp, path, { operation: "send", answer: fixture.reportText }, cookie, runtime);
    expect(await limited.text()).toContain("通数が足りない"); expect(calls).toHaveLength(4);
    expect(await getSetting(env.DB, ward.wardId, "line.delivery_alert.reply")).toContain("通数が足りない");
    used = 0;
    await webhook("fictional-u13-no-user", { type: "group", groupId: group }, `公式へ、${fixture.previousMaterial}を教えてください。`);
    const noUser = await env.DB.prepare("SELECT inquiry_id FROM inquiry_records WHERE ward_id = ? AND line_event_id = ?").bind(ward.wardId, "fictional-u13-no-user").first<{ inquiry_id: string }>();
    if (!noUser) throw new Error("発言者のIDがないグループの問い合わせがありません");
    const noSend = await (await get(realApp, `${root}/inquiries/${noUser.inquiry_id}`, cookie, runtime)).text();
    expect(noSend).not.toContain("送り先が分からないため送れません");
    expect(noSend).toContain('value="send"');
    const sendError = await postForm(realApp, `${root}/inquiries/${noUser.inquiry_id}`, { operation: "send", answer: fixture.publicDayText }, cookie, runtime);
    expect(sendError.status).toBe(303);
    expect(calls.at(-1)?.to).toBe(group);
    expect((await postForm(realApp, `${root}/inquiries/${noUser.inquiry_id}`, { operation: "wish" }, cookie, runtime)).status).toBe(303);
    expect(await (await get(realApp, `${root}/inquiries/${noUser.inquiry_id}?wish=1`, cookie, runtime)).text()).toContain("市に伝える要望にしました");
    expect((await get(realApp, `/${other.ward.slug}/admin/inquiries/${row.inquiry_id}`, other.cookie, runtime)).status).toBe(404);

    used = 0;
    const digestNow = new Date("2026-11-06T23:00:00Z");
    const beforeDigest = calls.length;
    await sendOfficerDigest(runtime, other.ward.wardId, other.ward.slug, digestNow, fakeLine);
    expect(calls).toHaveLength(beforeDigest);
    const settings = { cutoff: "08:00", send: "08:00", eventDays: 7, dueDays: 3 };
    expect(digestCutoff(settings, digestNow).toISOString()).toBe("2026-11-05T23:00:00.000Z");
    await sendOfficerDigest(runtime, ward.wardId, ward.slug, digestNow, fakeLine);
    expect(calls).toHaveLength(beforeDigest + 1);
    expect(calls.at(-1)?.text).toContain("昨日（11月6日）");
    expect(calls.at(-1)?.text).toContain(`${ward.slug}/admin/inquiries`);
    expect(digestPeriodLabel({ ...settings, cutoff: "21:00" }, new Date("2026-11-06T12:00:00Z"))).toBe("11月6日 21時まで");

    const project = await createProject(env.DB, ward.wardId, { kind: "event", title: fixture.draftTitle, year: fixture.eventYear, accountId: account.accountId });
    const photo = await receive(runtime, { wardId: ward.wardId, projectId: project.projectId, via: "line_direct", parts: [{ kind: "photo", filename: fixture.answerSheetFilename, mediaType: "image/jpeg", bytes: new Uint8Array(fixture.answerSheetPhotoBytes) }] });
    if (!photo.jobId || !photo.received[0]) throw new Error("写真がありません");
    const batch = await registerLinePhoto(env.DB, ward.wardId, { destination, source: { type: "user", id: "U-fictional-u13-photo", senderId: "U-fictional-u13-photo" }, jobId: photo.jobId, messageId: "fictional-u13-photo", now });
    await env.DB.prepare("INSERT INTO line_clarifications (ward_id, clarification_id, batch_id, job_id, original_id, topic, text, options, sent_at) VALUES (?, ?, ?, ?, ?, 'year', ?, ?, ?)")
      .bind(ward.wardId, "fictional-u13-question", batch, photo.jobId, photo.received[0].originalId, fixture.previousMaterial, JSON.stringify(["今年のもの", "去年のもの", "分からない"]), now.toISOString()).run();
    await env.DB.prepare("UPDATE line_photo_batches SET prepared_at = ?, message_text = 'ready' WHERE ward_id = ? AND batch_id = ?").bind(now.toISOString(), ward.wardId, batch).run();
    await attachClarificationQuestions(env.DB, ward.wardId, photo.jobId);
    const question = (await listClarifications(env.DB, ward.wardId, batch))[0];
    if (!question?.question_id) throw new Error("役員の質問につながっていません");
    const questionsPath = `${root}/projects/${project.projectId}/questions`;
    expect(await (await get(realApp, questionsPath, cookie, runtime)).text()).toContain("去年か、それより前のもの");
    await saveClarificationAnswers(env.DB, ward.wardId, "fictional-u13-answer-a", photo.jobId, fixture.sheetHelper, [{ question, text: fixture.publicDayText }], now);
    await saveClarificationAnswers(env.DB, ward.wardId, "fictional-u13-answer-b", photo.jobId, fixture.phoneHelper, [{ question, text: fixture.previousMaterial }], now);
    expect(await (await get(realApp, questionsPath, cookie, runtime)).text()).toContain("二つを見比べる");
    const compare = await (await get(realApp, `${questionsPath}/${question.question_id}/compare`, cookie, runtime)).text();
    expect(compare).toContain('type="radio"'); expect(compare).toContain(fixture.publicDayText); expect(compare).toContain(fixture.previousMaterial);
    const beforeScreenAnswer = calls.length;
    const beforeScreenReplies = replies;
    expect((await postForm(realApp, `${questionsPath}/${question.question_id}`, { action: "answer", answer: fixture.publicDayText }, cookie, runtime)).status).toBe(303);
    await processPhotoBatches(runtime, ward.wardId, { fetch: fakeLine, now });
    expect(calls).toHaveLength(beforeScreenAnswer + 1); expect(replies).toBe(beforeScreenReplies);
    expect(calls.at(-1)?.text).toContain("聞くことは以上です");
    await processPhotoBatches(runtime, ward.wardId, { fetch: fakeLine, now });
    expect(calls).toHaveLength(beforeScreenAnswer + 1);
    expect((await getProjectState(env.DB, ward.wardId, project.projectId))?.questions).toHaveLength(0);

    expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, { kind: "announcement", title: "案内", scope: "public", basedOn: project.stateVersion, body: JSON.stringify({ text: fixture.publicAnnouncement, items: [{ key: "date_time", content: fixture.publicDayText }] }) })).toBe(true);
    const document = await env.DB.prepare("SELECT document_id, version_id, version_no FROM document_versions WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1").bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
    if (!document) throw new Error("下書きがありません");
    const paperPath = `${root}/print/${project.projectId}/${document.document_id}/${document.version_no}`;
    const paper = await (await get(realApp, `${paperPath}/preview`, cookie, runtime)).text();
    expect(paper).toContain("下書きです。まだ知らせていません。"); expect(paper).toContain("回答票"); expect(paper).not.toContain("<svg");
    expect(await (await get(realApp, `${root}/print/${project.projectId}`, cookie, runtime)).text()).toContain(`${paperPath}/preview`);
    used = 200;
    expect((await postForm(realApp, `${root}/publish/${project.projectId}/send`, { documentId: document.document_id, versionId: document.version_id, versionNo: String(document.version_no), lineDelivery: "send" }, cookie, runtime)).status).toBe(303);
    expect(calls).toHaveLength(beforeScreenAnswer + 1);
    expect(await getSetting(env.DB, ward.wardId, "line.delivery_alert.publish")).toContain("通数が足りない");
    const printList = await (await get(realApp, `${root}/print/${project.projectId}`, cookie, runtime)).text();
    expect(printList).toContain(`href="${paperPath}/announcement"`); expect(printList).not.toContain(`${paperPath}/preview`);
    await setSetting(env.DB, ward.wardId, "line.digest", JSON.stringify(settings));
    expect(await (await get(realApp, `${root}/inquiries`, cookie, runtime)).text()).toContain("翌日の8時");
    const draftReading: Reading = { document_kind: "announcement", summary: fixture.publicAnnouncement,
      original_years: [{ original_id: photo.received[0].originalId, year: null }],
      text_blocks: [{ original_id: photo.received[0].originalId, locator: fixture.previousLocator, text: `下書きです。まだ知らせていません。\n${fixture.publicAnnouncement}` }],
      fields: [{ original_id: photo.received[0].originalId, locator: fixture.previousLocator, name: "日時", value: fixture.publicDayText, confidence: "high" }],
      tables: [], decisions: [], unreadable: [],
    };
    const draftAttempt = await claimRead(env.DB, ward.wardId, photo.jobId, 90_000);
    if (draftAttempt === null) throw new Error("下書きの紙を読み始められません");
    await finishRead(env.DB, { wardId: ward.wardId, jobId: photo.jobId, attempt: draftAttempt,
      source: "model", packVersion: "u13@1", model: "fictional", body: draftReading });
    expect(await env.DB.prepare("SELECT 1 FROM readings WHERE ward_id = ? AND job_id = ?").bind(ward.wardId, photo.jobId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM originals WHERE ward_id = ? AND original_id = ? AND withdrawn_at IS NULL").bind(ward.wardId, photo.received[0].originalId).first()).toBeNull();
    const mixed = await receive(runtime, { wardId: ward.wardId, projectId: project.projectId, via: "admin", accountId: account.accountId,
      parts: [11, 12].map((suffix) => ({ kind: "photo" as const, filename: fixture.answerSheetFilename, mediaType: "image/jpeg", bytes: new Uint8Array([...fixture.answerSheetPhotoBytes, suffix]) })) });
    const [draftPhoto, materialPhoto] = mixed.received;
    if (!mixed.jobId || !draftPhoto || !materialPhoto) throw new Error("一緒に送った写真がありません");
    const mixedReading: Reading = { ...draftReading,
      text_blocks: [
        { original_id: draftPhoto.originalId, locator: fixture.previousLocator, text: `下書きです。\n${fixture.previousMaterial}` },
        { original_id: materialPhoto.originalId, locator: fixture.previousLocator, text: fixture.publicAnnouncement },
      ],
      original_years: [draftPhoto, materialPhoto].map((original) => ({ original_id: original.originalId, year: null })),
      fields: [
        { original_id: draftPhoto.originalId, locator: fixture.previousLocator, name: "日時", value: fixture.publicDayText, confidence: "high" },
        { original_id: materialPhoto.originalId, locator: fixture.previousLocator, name: "場所", value: fixture.previousPlace, confidence: "high" },
      ],
    };
    const mixedAttempt = await claimRead(env.DB, ward.wardId, mixed.jobId, 90_000);
    if (mixedAttempt === null) throw new Error("一緒に送った写真を読み始められません");
    await finishRead(env.DB, { wardId: ward.wardId, jobId: mixed.jobId, attempt: mixedAttempt,
      source: "model", packVersion: "u13@1", model: "fictional", body: mixedReading });
    const kept = await env.DB.prepare("SELECT body FROM readings WHERE ward_id = ? AND job_id = ?").bind(ward.wardId, mixed.jobId).first<{ body: string }>();
    if (!kept) throw new Error("下書きではない写真まで外されました");
    const body = JSON.parse(kept.body) as Reading;
    expect(body.text_blocks.map((block) => block.original_id)).toEqual([materialPhoto.originalId]);
    expect(body.fields.map((field) => field.original_id)).toEqual([materialPhoto.originalId]);
    expect(kept.body).not.toContain("下書きです");
    expect(body.summary).toBe(fixture.publicAnnouncement);
  } finally { vi.unstubAllGlobals(); }
});
