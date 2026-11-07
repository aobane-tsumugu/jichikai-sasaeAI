import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import { setClientFactory } from "../src/ai/deps";
import { seedAdmin } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import { quickCheckPhotos } from "../src/intake/photo-check";
import { receive } from "../src/intake/receive";
import { listOriginals } from "../src/intake/store";
import { listClarifications, replyQuickPhotoChecks } from "../src/line/clarifications";
import type { LineIntakePorts } from "../src/line/intake";
import { acceptLineWebhook } from "../src/line/webhook";
import { createProject } from "../src/project/api";
import { fictionalStoredPhoto } from "./fixtures/phone-photo";
import { get, realApp, withEnv } from "./helpers";

it("最初の画面から去年の記録を読み、写真はAIが止まっても受領を返し、その後の質問は通数の枠を守る", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const closeRecord = async (wardId: string, accountId: string) => {
    const project = await createProject(env.DB, wardId, { kind: "event", title: fixture.nextYearTitle, year: fixture.sourceYear, accountId });
    await env.DB.prepare("UPDATE projects SET closed_at = ? WHERE ward_id = ? AND project_id = ?")
      .bind("2025-11-06T01:00:00.000Z", wardId, project.projectId).run();
    return project;
  };
  await closeRecord(other.ward.wardId, other.account.accountId);
  expect(await (await get(realApp, `${root}/`, cookie)).text()).toContain("まず、手元の紙を十枚送ってください");
  const record = await closeRecord(ward.wardId, account.accountId);
  const home = await (await get(realApp, `${root}/`, cookie)).text();
  expect(home).not.toContain("まず、手元の紙を十枚送ってください");
  expect(home).toContain(`class="button" href="${root}/archive/${record.projectId}?view=seed">今年を始める</a>`);
  expect(home).toContain(`href="${root}/archive/${record.projectId}"`);
  const archive = await get(realApp, `${root}/archive`, cookie);
  expect(archive.status).toBe(200);
  expect(await archive.text()).toContain(`href="${root}/archive/${record.projectId}"`);
  const detail = await get(realApp, `${root}/archive/${record.projectId}`, cookie);
  expect(detail.status).toBe(200);
  expect(await detail.text()).toContain(fixture.nextYearTitle);

  const secret = "fictional-u66-secret";
  const runtime = withEnv({ LINE_CHANNEL_SECRET: secret, LINE_CHANNEL_ACCESS_TOKEN: "fictional-u66-token" });
  const destination = crypto.randomUUID();
  const now = new Date("2026-11-07T01:00:00.000Z");
  await env.DB.prepare("INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding) VALUES (?, ?, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN')")
    .bind(ward.wardId, destination).run();
  type Sent = { url: string; body: { to?: string; replyToken?: string; messages: Array<{ text: string; quoteToken?: string }> } };
  const sent: Sent[] = [];
  let usage = 200;
  const fakeLine: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("api-data.line.me")) return new Response(fictionalStoredPhoto(), { headers: { "content-type": "image/jpeg" } });
    if (url.endsWith("/message/reply") || url.endsWith("/message/push")) {
      sent.push({ url, body: JSON.parse(String(init?.body)) as Sent["body"] });
      return Response.json({ sentMessages: [{ id: `fictional-u66-sent-${sent.length}` }] });
    }
    if (url.endsWith("/message/quota")) return Response.json({ type: "limited", value: 200 });
    if (url.endsWith("/message/quota/consumption")) return Response.json({ totalUsage: usage });
    throw new Error(`この試験で許可しないLINE呼び出し: ${url}`);
  };
  let signalAi!: () => void;
  let releaseAi!: () => void;
  const aiStarted = new Promise<void>((resolve) => { signalAi = resolve; });
  const aiStopped = new Promise<void>((resolve) => { releaseAi = resolve; });
  const stoppedAi = new Anthropic({ apiKey: "fictional-u66-key", maxRetries: 0, fetch: async () => {
    signalAi();
    await aiStopped;
    return Response.json({ error: { type: "overloaded_error", message: "fictional unavailable" } }, { status: 529 });
  } });
  const ports: LineIntakePorts = {
    async receiveOriginal(wardId, original) {
      if (!original.bytes) throw new Error("架空の写真がありません");
      return (await receive(runtime, { wardId, via: "line_direct", parts: [{ kind: "photo", filename: fixture.answerSheetFilename,
        mediaType: "image/jpeg", bytes: new Uint8Array(original.bytes) }] })).jobId;
    },
    async checkPhoto(wardId, original, jobId) {
      if (!original.bytes) throw new Error("架空の写真がありません");
      await quickCheckPhotos(runtime, { wardId, via: "line_direct", parts: [{ kind: "photo", filename: fixture.answerSheetFilename,
        mediaType: "image/jpeg", bytes: new Uint8Array(original.bytes) }] }, jobId);
    },
    async matchInboxItem() { throw new Error("写真の受領前にAIで当てません"); },
    async assignProject() { throw new Error("この写真には当て先がありません"); },
    async discard() { throw new Error("受け取った写真を捨てません"); },
  };
  const body = JSON.stringify({ destination, events: [{ type: "message", webhookEventId: "fictional-u66-photo",
    timestamp: now.getTime(), replyToken: "fictional-u66-reply", source: { type: "user", userId: "fictional-u66-user" },
    message: { type: "image", id: "fictional-u66-image", quoteToken: "fictional-u66-quote", imageSet: { id: "fictional-u66-set", index: 1, total: 1 } } }] });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
  const request = () => new Request("https://unit.test/hooks/line", { method: "POST", headers: { "x-line-signature": signature }, body });
  setClientFactory(() => stoppedAi);
  const processing = acceptLineWebhook(request(), runtime, env.DB, { fetch: fakeLine, ports }, now);
  try {
    // AIの応答を止めたまま、保存と受領が済んでいることを確かめる。
    await aiStarted;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: expect.stringMatching(/\/message\/reply$/),
      body: { replyToken: "fictional-u66-reply", messages: [{ text: "受け取りました。役員が確かめます。" }] } });
    const item = await env.DB.prepare("SELECT job_id, receipt_claimed_at FROM line_photo_items WHERE ward_id = ?")
      .bind(ward.wardId).first<{ job_id: string; receipt_claimed_at: string | null }>();
    if (!item) throw new Error("保存された写真がありません");
    expect(item.receipt_claimed_at).toBe(now.toISOString());
    const originals = await listOriginals(env.DB, ward.wardId, item.job_id);
    expect(originals).toHaveLength(1);
    expect(await new WardBucket(runtime.ORIGINALS, ward.wardId).get(originals[0]!.r2_path!)).not.toBeNull();
    releaseAi();
    expect((await processing).status).toBe(200);
    expect(await env.DB.prepare("SELECT readability FROM intake_photo_checks WHERE ward_id = ? AND job_id = ?")
      .bind(ward.wardId, item.job_id).first()).toEqual({ readability: "unknown" });
    expect((await acceptLineWebhook(request(), runtime, env.DB, { fetch: fakeLine, ports }, now)).status).toBe(200);
    expect(sent).toHaveLength(1);

    // 後で読めないところが見つかっても、受領のReplyを使い回さない。
    await env.DB.prepare("UPDATE intake_photo_checks SET readability = 'unreadable', reason = 'blurred' WHERE ward_id = ? AND job_id = ?")
      .bind(ward.wardId, item.job_id).run();
    await replyQuickPhotoChecks(runtime, ward.wardId, { fetch: fakeLine, now });
    expect(sent).toHaveLength(1); // 通数の枠が尽きた間は質問を送らない。
    expect(await listClarifications(env.DB, ward.wardId)).toHaveLength(1);
    usage = 199;
    await replyQuickPhotoChecks(runtime, ward.wardId, { fetch: fakeLine, now });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ url: expect.stringMatching(/\/message\/push$/),
      body: { to: "fictional-u66-user", messages: [{ quoteToken: "fictional-u66-quote" }] } });
    expect(sent[1]?.body.replyToken).toBeUndefined();
    await replyQuickPhotoChecks(runtime, ward.wardId, { fetch: fakeLine, now });
    expect(sent).toHaveLength(2);
    expect(await env.DB.prepare("SELECT send_method, push_recipients FROM line_photo_batches WHERE ward_id = ?")
      .bind(ward.wardId).first()).toEqual({ send_method: "push", push_recipients: 1 });
    expect(await listClarifications(env.DB, other.ward.wardId)).toHaveLength(0);
  } finally {
    releaseAi();
    await processing.finally(() => setClientFactory(null));
  }
});
