import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { setClientFactory } from "../src/ai/deps";
import { MATCH_PACK_VERSION, MATCH_UNRELATED, matchProject } from "../src/ai/match";
import { getAnswerTotals, listAnswers, replaceRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import { getJob, listOriginals } from "../src/intake/store";
import { registerLinePhoto } from "../src/line/clarifications";
import { createLineIntakePorts, type LineOriginal } from "../src/line/intake";
import { acceptLineWebhook } from "../src/line/webhook";
import { createProject } from "../src/project/api";
import { withEnv } from "./helpers";

it("U29: 一対一とグループの作業連絡を残し、出欠だけ数え、同名の答えと写真直後の文を捨てない", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: fixture.draftTitle, year: fixture.eventYear, accountId: account.accountId,
  });
  await replaceRoster(env.DB, ward.wardId, [
    { household: fixture.firstHousehold, district: fixture.district },
    { household: fixture.firstHousehold, district: "二班" },
  ], { household: 0, district: 1 });
  const runtime = withEnv({ LINE_CHANNEL_SECRET: "fictional-u29-secret", LINE_CHANNEL_ACCESS_TOKEN: "fictional-u29-token" });
  const destination = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding) VALUES (?, ?, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN')")
    .bind(ward.wardId, destination).run();
  const now = new Date("2026-11-06T01:00:00Z");
  let attendance: unknown = false;
  let unrelated = false;
  let fail = false;
  let matchCalls = 0;
  const ai = new Anthropic({ apiKey: "fictional-u29-api-key", maxRetries: 0, fetch: async (url, init) => {
    // 繋げる処理の外部呼び出しも偽物にする。この試験はLINEの受付と出欠までを扱う。
    if (!String(url).endsWith("/messages")) return Response.json({ error: { type: "overloaded_error", message: "fictional unavailable" } }, { status: 529 });
    matchCalls++;
    const request = JSON.parse(String(init?.body)) as {
      system: string;
      output_config: { format: { schema: { required: string[]; properties: { attendanceAnswer: { type: string } } } } };
    };
    expect(request.system).toContain("設営は3人で進めます");
    expect(request.output_config.format.schema.required).toContain("attendanceAnswer");
    expect(request.output_config.format.schema.properties.attendanceAnswer.type).toBe("boolean");
    if (fail) return Response.json({ error: { type: "overloaded_error", message: "fictional unavailable" } }, { status: 529 });
    return Response.json({ id: "fictional-u29-message", type: "message", role: "assistant", model: "claude-haiku-5-5",
      content: [{ type: "text", text: JSON.stringify({ choice: unrelated ? MATCH_UNRELATED : project.projectId,
        reason: "届いた文から判断しました。", intent: "material", attendanceAnswer: attendance }) }],
      stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  const sent: Array<{ replyToken: string; messages: Array<{ text: string }> }> = [];
  const fakeLine: typeof fetch = async (url, init) => {
    if (String(url).includes("/member/")) return Response.json({ displayName: fixture.sheetHelper });
    if (String(url).endsWith("/message/reply")) {
      sent.push(JSON.parse(String(init?.body)) as (typeof sent)[number]);
      return Response.json({ sentMessages: [{ id: `fictional-u29-reply-${sent.length}` }] });
    }
    throw new Error("予定していない外部通信です");
  };
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
  const ports = createLineIntakePorts(runtime, ctx, async (_wardId, original) => matchProject(ai, {
    candidates: [{ id: project.projectId, title: project.title }], summary: original.text ?? "", officialAddressed: original.officialAddressed,
  }));
  if (!ports.saveAnswerReply) throw new Error("LINEの返事を保存する口がありません");
  const saveAnswer = vi.spyOn(ports, "saveAnswerReply");
  let eventNo = 0;
  const send = async (text: string, group: boolean, eventId = `fictional-u29-${++eventNo}`) => {
    const body = JSON.stringify({ destination, events: [{ type: "message", webhookEventId: eventId,
      timestamp: now.getTime(), replyToken: `${eventId}-reply`,
      source: group ? { type: "group", groupId: "fictional-u29-group", userId: "fictional-u29-member" } : { type: "user", userId: "fictional-u29-person" },
      message: { type: "text", id: eventId, text } }] });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(runtime.LINE_CHANNEL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
    const response = await acceptLineWebhook(new Request("https://unit.test/hooks/line", {
      method: "POST", headers: { "x-line-signature": signature }, body,
    }), runtime, env.DB, { ports, fetch: fakeLine }, now, ctx);
    expect(response.status).toBe(200);
    return eventId;
  };
  const inbox = (eventId: string) => env.DB.prepare("SELECT job_id, disposition FROM line_inbox_items WHERE ward_id = ? AND event_id = ?")
    .bind(ward.wardId, eventId).first<{ job_id: string; disposition: string }>();
  const checkMaterial = async (eventId: string, text: string, matched: boolean) => {
    const item = await inbox(eventId);
    if (!item) throw new Error("文が届いたものに残っていません");
    expect(item.disposition).toBe(matched ? "matched" : "unmatched");
    expect((await getJob(env.DB, ward.wardId, item.job_id))?.project_id).toBe(matched ? project.projectId : null);
    const original = (await listOriginals(env.DB, ward.wardId, item.job_id))[0];
    if (!original?.r2_path) throw new Error("元の文の保存場所がありません");
    expect(await (await new WardBucket(env.ORIGINALS, ward.wardId).get(original.r2_path))?.text()).toBe(text);
  };
  setClientFactory(() => ai);
  vi.stubGlobal("fetch", fakeLine);
  try {
    expect(MATCH_PACK_VERSION).toBe("match@5");
    for (const group of [false, true]) {
      const suffix = group ? fixture.dutyTitle : fixture.draftTitle;
      const initialCalls = matchCalls;
      const work = `設営は3人で進めます。${suffix}`;
      const workId = await send(work, group);
      await checkMaterial(workId, work, true);
      expect(matchCalls).toBe(initialCalls + 1);
      expect(saveAnswer).toHaveBeenCalledTimes(group ? 2 : 0);
      // 再送で当て直さず、答えも増やさない。
      await send(work, group, workId);
      expect(matchCalls).toBe(initialCalls + 1);
      for (const message of [`3人分の机を手配しました。${suffix}`, `3人でよいか決めましょう。${suffix}`]) {
        const id = await send(message, group);
        await checkMaterial(id, message, true);
      }
      const count = group ? 3 : 2;
      attendance = true;
      await send(`${fixture.firstHousehold}です。大人${count}人で参加します。`, group);
      await send(`${fixture.secondHousehold}です。参加しません。${suffix}`, group);
      attendance = false;
      expect(saveAnswer).toHaveBeenCalledTimes(group ? 4 : 2);

      // まだ読んでいる写真の直後でも、文は原本に入り、当ての資料にも残る。
      const photo: LineOriginal = { eventId: `fictional-u29-photo-${group}`, senderId: group ? "fictional-u29-member" : "fictional-u29-person",
        sourceType: group ? "group" : "user", receivedAt: new Date(now.getTime() - 1000).toISOString(), kind: "image",
        bytes: new Uint8Array([...fixture.answerSheetPhotoBytes, group ? 2 : 1]).buffer, contentType: "image/jpeg" };
      const jobId = await ports.receiveOriginal(ward.wardId, photo);
      if (!jobId) throw new Error("試しの写真を受け付けられません");
      await registerLinePhoto(env.DB, ward.wardId, { destination, source: {
        type: photo.sourceType, id: group ? "fictional-u29-group" : photo.senderId, senderId: photo.senderId,
      }, jobId, messageId: photo.eventId, now: new Date(now.getTime() - 1000) });
      const reservation = `公民館の予約が取れました。${suffix}`;
      const beforeReservation = matchCalls;
      const id = await send(reservation, group);
      await checkMaterial(id, reservation, true);
      expect(matchCalls).toBe(beforeReservation + 1);
      expect(await env.DB.prepare("SELECT text FROM line_photo_context_texts WHERE ward_id = ? AND event_id = ?")
        .bind(ward.wardId, id).first()).toEqual({ text: reservation });
      unrelated = true;
      const chat = await send(`おはようございます。${suffix}`, group);
      expect(await inbox(chat)).toBeNull();
      unrelated = false;
      fail = true;
      const failedText = `${fixture.phoneHousehold}です。大人4人で参加します。${suffix}`;
      const beforeFailure = matchCalls;
      const failedId = await send(failedText, group);
      await checkMaterial(failedId, failedText, false);
      expect(await env.DB.prepare("SELECT inquiry_id FROM inquiry_records WHERE ward_id = ? AND line_event_id = ?")
        .bind(ward.wardId, failedId).first()).toBeNull();
      expect(matchCalls).toBe(beforeFailure + 3);
      expect(sent.filter((message) => message.replyToken === `${failedId}-reply`)).toHaveLength(0);
      fail = false;
    }
    // 真偽が欠けた応答や文字のtrueでは、人数を数えない。
    for (const value of [undefined, "true"]) {
      attendance = value;
      await send(`${fixture.phoneHousehold}です。大人5人で参加します。${String(value)}`, true);
    }
    expect(saveAnswer).toHaveBeenCalledTimes(4);
    expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toHaveLength(4);
    expect((await listAnswers(env.DB, ward.wardId, project.projectId)).filter((answer) => answer.household === fixture.firstHousehold))
      .toEqual(expect.arrayContaining([expect.objectContaining({ district: "", peopleCount: 2 }), expect.objectContaining({ district: "", peopleCount: 3 })]));
    expect((await getAnswerTotals(env.DB, ward.wardId, project.projectId)).people).toBe(5);
    expect(sent).toHaveLength(0);
    await Promise.all(pending);
  } finally {
    await Promise.allSettled(pending);
    setClientFactory(null);
    vi.unstubAllGlobals();
  }
});
