import { redirectedTalkPage } from "./fixtures/line-u83-page";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import * as anthropic from "../src/ai/anthropic";
import * as sessions from "../src/ai/session";
import { setClientFactory } from "../src/ai/deps";
import type { MatchResult } from "../src/ai/match";
import type { Reading } from "../src/ai/schema";
import { seedAdmin } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import { getJob, getReadings, listOriginals } from "../src/intake/store";
import { setPipelineDeps } from "../src/intake/pipeline";
import { createLineIntakePorts } from "../src/line/intake";
import { acceptLineWebhook } from "../src/line/webhook";
import { listClarifications, processPhotoBatches } from "../src/line/clarifications";
import { getBundleDecision, isOfficerSource, saveAiBundleDecision, PURPOSE_QUESTION, SHARE_QUESTION } from "../src/line/bundle-decisions";
import { applyChange, createProject, getProjectState } from "../src/project/api";
import { markReferenceSource, placeSource } from "../src/project/source";
import { get, postForm, realApp, withEnv } from "./helpers";

// 全て架空。受信・原本・読み取りの保存・当てるAI・接続・既存の質問フォームを通す。
async function setup(intent: NonNullable<MatchResult["intent"]>) {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の秋の集まり", year: 2026, accountId: account.accountId });
  const group = `fictional-u82-group-${crypto.randomUUID()}`;
  const destination = crypto.randomUUID();
  const runtime = withEnv({ LINE_CHANNEL_SECRET: "fictional-u82-secret", LINE_CHANNEL_ACCESS_TOKEN: "fictional-u82-token" });
  await env.DB.prepare("INSERT INTO ward_settings (ward_id, key, value) VALUES (?, 'line.officer_group', ?)")
    .bind(ward.wardId, group).run();
  await env.DB.prepare("INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding) VALUES (?, ?, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN')")
    .bind(ward.wardId, destination).run();
  const prompts: string[] = [];
  const replies: string[] = [];
  const ai = new Anthropic({ apiKey: "fictional-u82-ai-key", maxRetries: 0, fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { system: string; messages: Array<{ content: string }> };
    let result: unknown;
    if (request.system.includes("写真の文字")) result = { readability: "readable", paperKind: "photo", reason: "other" };
    else if (request.system.includes("どのプロジェクトの物かを選ぶ")) {
      const prompt = request.messages[0]?.content;
      if (!prompt) throw new Error("当てる文がありません");
      prompts.push(prompt);
      const residentPhoto = intent === "inquiry" && !prompt.includes("受け取った物の要約: 住民に知らせてほしい");
      result = { choice: residentPhoto ? "__uncertain__" : project.projectId, reason: "架空の写真と添えた言葉で目的を読みました。", intent,
        confident: !residentPhoto, attendanceAnswer: false, knowTopic: "none" };
    } else throw new Error("この試験にないAIの呼び出しです");
    return Response.json({ id: "fictional-u82-ai", type: "message", role: "assistant", model: "claude-haiku-5-5",
      content: [{ type: "text", text: JSON.stringify(result) }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  const date = "2026/11/19 10:00〜12:00";
  const place = "架空の遠方広場";
  const contact = "架空の外部催し係";
  const fields = [{ name: "日時", value: date }, { name: "場所", value: place }, { name: "連絡先", value: contact }];
  const factory = vi.spyOn(anthropic, "createAnthropic").mockReturnValue(ai);
  setClientFactory(() => ai);
  setPipelineDeps({ createClient: () => ai, readImpl: async (_client, input) => {
    const original = input.originals[0];
    if (!original) throw new Error("読む元の写真がありません");
    const body: Reading = { document_kind: "announcement", summary: "架空の催しのチラシ",
      original_years: [{ original_id: original.originalId, year: 2026 }],
      text_blocks: [{ original_id: original.originalId, locator: "全体", text: `${date} ${place} ${contact}` }],
      fields: fields.map((field) => ({ ...field, original_id: original.originalId, locator: field.name, confidence: "high" })),
      tables: [], decisions: [], unreadable: [],
      project_suggestions: [{ original_id: original.originalId, kind: "event", title: "架空の外の催し", date_text: date, place }],
      year_entries: [{ original_id: original.originalId, title: "架空の外の催し", month: 11, date_text: date }] };
    return { body, packVersion: "read-u82-fictional@1", model: "claude-sonnet-5-5", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } };
  } });
  // 繋げるエージェントが書く日時・場所・連絡先を同じapplyChangeへ渡す。外部の実AIは呼ばない。
  const dispatch = vi.spyOn(sessions, "dispatchProject").mockImplementation(async (_env, wardId, projectId) => {
    const jobs = await env.DB.prepare("SELECT job_id FROM jobs WHERE ward_id = ? AND project_id = ? AND status = 'read'")
      .bind(wardId, projectId).all<{ job_id: string }>();
    for (const job of jobs.results) {
      for (const reading of await getReadings(env.DB, wardId, job.job_id)) {
        if (!("fields" in reading.body)) continue;
        for (const field of reading.body.fields) {
          const key = field.name === "日時" ? "date_time" : field.name === "場所" ? "place" : "public_contact";
          const result = await applyChange(env.DB, wardId, projectId, { kind: "item", itemKey: key, value: field.value,
            source: { kind: "original", ref: field.original_id, locator: field.locator, year: 2026 }, confidence: "high", packVersion: "u82-connect@1" });
          expect(["applied", "same"]).toContain(result.status);
        }
      }
      await env.DB.prepare("UPDATE jobs SET status = 'done' WHERE ward_id = ? AND job_id = ?").bind(wardId, job.job_id).run();
    }
    return "started";
  });
  const fakeLine: typeof fetch = async (url, init) => {
    if (String(url).includes("api-data.line.me")) return new Response(new Uint8Array([...FIRST_SLICE.answerSheetPhotoBytes, 82]), { headers: { "content-type": "image/jpeg" } });
    if (String(url).includes("/member/")) return Response.json({ displayName: "架空の送信者" });
    if (String(url).endsWith("/message/reply")) {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ text: string }> };
      replies.push(...body.messages.map((message) => message.text));
      return Response.json({ sentMessages: [{ id: `fictional-u82-reply-${replies.length}` }] });
    }
    throw new Error("この試験にないLINEへの通信です");
  };
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
  const ports = createLineIntakePorts(runtime, ctx);
  let at = new Date("2026-11-07T01:00:00Z");
  let number = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  vi.stubGlobal("fetch", fakeLine);
  const send = async (text: string | null, sourceType: "group" | "user" = "group") => {
    at = new Date(at.getTime() + 60_000);
    vi.setSystemTime(at);
    const id = `fictional-u82-${++number}`;
    // 同じ利用者の一対一でも役員にはしない。
    const source = sourceType === "group" ? { type: "group", groupId: group, userId: "fictional-u82-person" } : { type: "user", userId: "fictional-u82-person" };
    const body = JSON.stringify({ destination, events: [{ type: "message", webhookEventId: id, timestamp: at.getTime(), replyToken: `${id}-reply`, source,
      message: text === null ? { type: "image", id: "82", imageSet: { id, index: 1, total: 1 } } : { type: "text", id, text } }] });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(runtime.LINE_CHANNEL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
    const response = await acceptLineWebhook(new Request("https://unit.test/hooks/line", { method: "POST", headers: { "x-line-signature": signature }, body }),
      runtime, env.DB, { ports, fetch: fakeLine }, at, ctx);
    expect(response.status).toBe(200);
    await Promise.all(pending.splice(0));
    return id;
  };
  const photo = async (eventId: string) => {
    const row = await env.DB.prepare("SELECT job_id, bundle_id, item_id FROM line_inbox_items WHERE ward_id = ? AND event_id = ?")
      .bind(ward.wardId, eventId).first<{ job_id: string; bundle_id: string; item_id: string }>();
    if (!row) throw new Error("届いた写真がありません");
    const original = (await listOriginals(env.DB, ward.wardId, row.job_id))[0];
    if (!original?.r2_path) throw new Error("元の写真がありません");
    return { ...row, original, path: original.r2_path };
  };
  const settle = async () => {
    at = new Date(at.getTime() + 11 * 60_000);
    vi.setSystemTime(at);
    await processPhotoBatches(runtime, ward.wardId, { now: at, fetch: fakeLine });
    await Promise.all(pending.splice(0));
  };
  const state = async () => {
    const result = await getProjectState(env.DB, ward.wardId, project.projectId);
    if (!result) throw new Error("架空の準備がありません");
    return result;
  };
  const cleanup = () => { factory.mockRestore(); dispatch.mockRestore(); setClientFactory(null); setPipelineDeps(null); vi.unstubAllGlobals(); vi.useRealTimers(); };
  return { ward, cookie, runtime, project, group, send, photo, settle, state, cleanup, prompts, dispatch, replies, date, place, contact };
}

it("U82: 役員の参考は原本と読み取りを残し、今年の日時・場所・連絡先・行事の日・一年の予定を変えない", async () => {
  const s = await setup("reference");
  try {
    const before = await s.state();
    const received = await s.photo(await s.send(null));
    await s.send("こんなデザインで作りたい");
    await s.settle();
    expect(await getBundleDecision(env.DB, s.ward.wardId, received.bundle_id)).toMatchObject({ action: "reference", project_id: s.project.projectId, decided_by: "ai" });
    expect(await getJob(env.DB, s.ward.wardId, received.job_id)).toMatchObject({ project_id: s.project.projectId, status: "done", withdrawn_at: null });
    expect((await getReadings(env.DB, s.ward.wardId, received.job_id))[0]?.body.summary).toBe("架空の催しのチラシ");
    expect(await new WardBucket(env.ORIGINALS, s.ward.wardId).get(received.path)).not.toBeNull();
    expect(s.dispatch).not.toHaveBeenCalled();
    const source = await markReferenceSource(env.DB, s.ward.wardId, { kind: "original", ref: received.original.original_id, year: 2026, qr: true });
    expect(source.reference).toBe(true);
    expect(placeSource(source, 2026)).toEqual({ scope: "reference", refYear: 2026 });
    // 仮に同じ写真から差分を書かれても、日時・場所・連絡先は参考に留まる。
    for (const [itemKey, value] of [["date_time", s.date], ["place", s.place], ["public_contact", s.contact]] as const) {
      expect((await applyChange(env.DB, s.ward.wardId, s.project.projectId, { kind: "item", itemKey, value,
        source, confidence: "high", packVersion: "u82-reference@1" })).status).toBe("applied");
    }
    const state = await s.state();
    expect(state.project.deadlines.event_day).toBeUndefined();
    expect(state.mapTasks).toEqual(before.mapTasks);
    for (const key of ["date_time", "place", "public_contact"]) {
      expect(state.items.find((item) => item.key === key)?.current).toBeNull();
      expect(state.items.find((item) => item.key === key)?.references).toHaveLength(1);
    }
    expect(await env.DB.prepare("SELECT item_id FROM ward_year_items WHERE ward_id = ? AND source_original_id = ?")
      .bind(s.ward.wardId, received.original.original_id).first()).toBeNull();
    expect((await listClarifications(env.DB, s.ward.wardId))).toHaveLength(0);
    expect(s.prompts.some((prompt) => prompt.includes("指定された役員グループ") && prompt.includes("こんなデザインで作りたい"))).toBe(true);
    const html = await redirectedTalkPage(`/${s.ward.slug}/admin/inbox/${received.item_id}/pick`, s.cookie, s.runtime);
    expect(html).toContain("架空の秋の集まりの参考にしました。");
  } finally { s.cleanup(); }
});

it("U82: 一対一の知らせてほしいは写真付きの問い合わせのまま", async () => {
  const s = await setup("inquiry");
  try {
    const received = await s.photo(await s.send(null, "user"));
    await s.send("住民に知らせてほしい", "user");
    await s.settle();
    expect(await getBundleDecision(env.DB, s.ward.wardId, received.bundle_id)).toMatchObject({ action: "inquiry", decided_by: "ai" });
    const inquiries = await env.DB.prepare("SELECT subject FROM inquiry_records WHERE ward_id = ? AND line_bundle_id = ?")
      .bind(s.ward.wardId, received.bundle_id).all<{ subject: string }>();
    expect(inquiries.results).toEqual([{ subject: "住民に知らせてほしい" }]);
    expect((await s.state()).project.deadlines.event_day).toBeUndefined();
    expect((await listClarifications(env.DB, s.ward.wardId))).toHaveLength(0);
  } finally { s.cleanup(); }
});

it("U82: 自分たちの案内の写真は今年の中身と行事の日に入る", async () => {
  const s = await setup("material");
  try {
    const received = await s.photo(await s.send(null));
    await s.settle();
    expect(await getBundleDecision(env.DB, s.ward.wardId, received.bundle_id)).toMatchObject({ action: "material" });
    const state = await s.state();
    expect(state.project.deadlines.event_day).toBe("2026-11-19");
    expect(state.items.find((item) => item.key === "date_time")?.current?.content).toBe(s.date);
    expect(state.items.find((item) => item.key === "place")?.current?.content).toBe(s.place);
    expect(await env.DB.prepare("SELECT title FROM ward_year_items WHERE ward_id = ? AND source_original_id = ?")
      .bind(s.ward.wardId, received.original.original_id).first()).toEqual({ title: "架空の外の催し" });
  } finally { s.cleanup(); }
});

it.each(["参考資料", "この準備の資料"])("U82: 目的不明には一問だけ置き、既存の画面で%sと答えられる", async (answer) => {
  const s = await setup("purpose_uncertain");
  try {
    await s.send("これを送ります");
    const received = await s.photo(await s.send(null));
    await s.settle();
    await s.settle();
    const questions = await listClarifications(env.DB, s.ward.wardId);
    expect(questions).toHaveLength(1);
    const question = questions[0];
    if (!question) throw new Error("目的を聞く質問がありません");
    expect(question.text).toBe(PURPOSE_QUESTION);
    expect(question.options).toEqual(["参考資料", "この準備の資料"]);
    expect(question.sent_at).toBeNull();
    // 保存した文と答えの値はそのままにし、画面では何を聞くのかと、押すと何が起きるかを書く。
    const talk = await redirectedTalkPage(`/${s.ward.slug}/admin/inbox/${received.item_id}/pick`, s.cookie, s.runtime);
    expect(talk).toContain("自治会が使うもの（自分たちのチラシや当番表など）ですか。それとも、よその催しのチラシのように、作るときの参考にするものですか。");
    expect(talk).toMatch(/value="この準備の資料">[^<]+で使う<\/button>/);
    expect(talk).toContain('value="参考資料">参考にする</button>');
    expect(talk).toContain("「参考にする」を選ぶと、写真に書かれた日時や場所を");
    expect(talk).not.toContain(PURPOSE_QUESTION);
    expect((await s.state()).project.deadlines.event_day).toBeUndefined();
    expect((await s.state()).items.find((item) => item.key === "place")?.current).toBeNull();
    expect(await env.DB.prepare("SELECT item_id FROM ward_year_items WHERE ward_id = ? AND source_original_id = ?")
      .bind(s.ward.wardId, received.original.original_id).first()).toBeNull();
    const response = await postForm(realApp, `/${s.ward.slug}/admin/inbox/questions/${question.id}`, { answer }, s.cookie, s.runtime);
    expect(response.status).toBe(303);
    const action = answer === "この準備の資料" ? "material" : "reference";
    expect(await getBundleDecision(env.DB, s.ward.wardId, received.bundle_id)).toMatchObject({ action, decided_by: "officer" });
    expect((await s.state()).project.deadlines.event_day).toBe(action === "material" ? "2026-11-19" : undefined);
    // 同じまとまりへのAIの後続判断と、別の自治会からの読み書きで人の答えは変わらない。
    await saveAiBundleDecision(env.DB, s.ward.wardId, received.bundle_id, "別のAIの判断", "confirm_purpose", null, new Date());
    expect(await getBundleDecision(env.DB, s.ward.wardId, received.bundle_id)).toMatchObject({ action, decided_by: "officer", project_id: s.project.projectId });
    const other = await seedAdmin(env.DB);
    await saveAiBundleDecision(env.DB, other.ward.wardId, received.bundle_id, "架空の別の自治会", "reference", null, new Date());
    expect(await getBundleDecision(env.DB, s.ward.wardId, received.bundle_id)).toMatchObject({ action, decided_by: "officer" });
  } finally { s.cleanup(); }
});

it("U82: 役員の住民に知らせたいは確認だけにし、下書きを作らない", async () => {
  const s = await setup("share");
  try {
    await s.send("住民に知らせたい");
    const received = await s.photo(await s.send(null));
    await s.settle();
    expect(await getBundleDecision(env.DB, s.ward.wardId, received.bundle_id)).toMatchObject({ action: "confirm_share" });
    expect((await listClarifications(env.DB, s.ward.wardId)).map((q) => q.text)).toEqual([SHARE_QUESTION]);
    expect(s.dispatch).not.toHaveBeenCalled();
    expect((await s.state()).documents).toHaveLength(0);
    expect((await s.state()).project.deadlines.event_day).toBeUndefined();
    const question = (await listClarifications(env.DB, s.ward.wardId))[0];
    if (!question) throw new Error("知らせる前の確認がありません");
    const talk = await redirectedTalkPage(`/${s.ward.slug}/admin/inbox/${received.item_id}/pick`, s.cookie, s.runtime);
    expect(talk).toContain("住民に知らせたいという言葉と一緒に届いた写真です。住民に知らせますか。");
    expect(talk).toContain("どちらを選んでも、ここからは住民に届きません。");
    expect((await postForm(realApp, `/${s.ward.slug}/admin/inbox/questions/${question.id}`, { answer: "知らせる" }, s.cookie, s.runtime)).status).toBe(303);
    expect(await getBundleDecision(env.DB, s.ward.wardId, received.bundle_id)).toMatchObject({ action: "reference", decided_by: "officer" });
    expect(s.dispatch).not.toHaveBeenCalled();
    expect((await s.state()).documents).toHaveLength(0);
    expect(await isOfficerSource(s.runtime, s.ward.wardId, "group", s.group)).toBe(true);
    expect(await isOfficerSource(s.runtime, s.ward.wardId, "group", "fictional-other-group")).toBe(false);
    expect(await isOfficerSource(s.runtime, s.ward.wardId, "user", s.group)).toBe(false);
    expect(await isOfficerSource(s.runtime, s.ward.wardId, "room", s.group)).toBe(false);
  } finally { s.cleanup(); }
});
