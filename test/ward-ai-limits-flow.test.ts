import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { fictionalPaperPhoto } from "../fixtures/test-photo";
import { sweepConnections } from "../src/ai/complete";
import { setClientFactory } from "../src/ai/deps";
import { MATCH_UNRELATED } from "../src/ai/match";
import { dispatchProject, setWorkersRoute } from "../src/ai/session";
import { WardBucket } from "../src/core/storage";
import { seedAdmin, seedWard } from "../src/core/testing";
import { runRead, sweepReads, type PipelineDeps } from "../src/intake/pipeline";
import { receive } from "../src/intake/receive";
import { getJob, listOriginals } from "../src/intake/store";
import { createLineIntakePorts } from "../src/line/intake";
import { acceptLineWebhook } from "../src/line/webhook";
import { getWardAiLimits, recordAiMatchUsage } from "../src/ops/metrics";
import { createOpsSession, OPS_COOKIE } from "../src/ops/session";
import { createProject } from "../src/project/api";
import { get, opsEnv, postForm, realApp, withEnv } from "./helpers";

it("U74: 制限なしの受付、月の上限で待って解除後に再開、LINEの超過分の原本保管を通す", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const other = await seedWard(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "試しの資料確認", year: 2026, accountId: account.accountId });
  const cookie = `${OPS_COOKIE}=${await createOpsSession(opsEnv)}`;
  let readCalls = 0;
  let connectCalls = 0;
  const client = new Anthropic({ apiKey: "fictional-u74-key", maxRetries: 0, fetch: async (url, init) => {
    if (!String(url).endsWith("/messages")) throw new Error("試しのMessages以外へは接続しません");
    const request = JSON.parse(String(init?.body)) as { model: string };
    if (request.model === "claude-haiku-5-5") return Response.json({ id: "fictional-u74-match", type: "message", role: "assistant", model: request.model,
      content: [{ type: "text", text: JSON.stringify({ choice: MATCH_UNRELATED, reason: "試しの写真の確認です" }) }],
      stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 } });
    connectCalls++;
    return Response.json({ id: "fictional-u74-message", type: "message", role: "assistant", model: "claude-sonnet-5-5",
      content: [{ type: "text", text: "資料を確認しました。" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 } });
  } });
  const deps: PipelineDeps = { createClient: () => client, readImpl: async (_client, input) => {
    readCalls++;
    return { body: { document_kind: "photo", original_years: input.originals.map((o) => ({ original_id: o.originalId, year: 2026 })),
      summary: "試しの写真です", text_blocks: input.originals.map((o) => ({ original_id: o.originalId, locator: "全体", text: "試しの写真" })),
      fields: [], tables: [], decisions: [], unreadable: [] }, packVersion: "read-general@2", model: "claude-sonnet-5-5",
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0 } };
  } };
  const photo = async () => {
    const result = await receive(env, { wardId: ward.wardId, via: "admin", parts: [{ kind: "photo", filename: "試しの写真.jpg",
      mediaType: "image/jpeg", bytes: fictionalPaperPhoto(crypto.randomUUID()) }] });
    if (!result.jobId) throw new Error("試しの写真を受け取れませんでした");
    return result.jobId;
  };
  const save = async (values: Record<string, string>) => {
    const response = await postForm(realApp, `/ops/wards/${ward.slug}/budget`, values, cookie, opsEnv);
    expect(response.status).toBe(200);
  };
  setClientFactory(() => client);
  try {
    expect((await getWardAiLimits(env.DB, ward.wardId)).monthlyLimitCents).toBe(0);
    const first = await photo();
    expect(await runRead(env, ward.wardId, first, { deps })).toBe("read");
    expect(readCalls).toBe(1);
    await save({ monthlyLimit: "0.01" });
    await recordAiMatchUsage(env.DB, ward.wardId, { input_tokens: 10_000, output_tokens: 0 });
    expect((await getWardAiLimits(env.DB, ward.wardId)).monthlyBlocked).toBe(true);
    expect((await getWardAiLimits(env.DB, other.wardId)).monthlyBlocked).toBe(false);
    const waiting = await photo();
    expect(await runRead(env, ward.wardId, waiting, { deps })).toBe("skipped");
    expect(await getJob(env.DB, ward.wardId, waiting)).toMatchObject({ status: "received", attempt: 0, failure: "" });
    const original = (await listOriginals(env.DB, ward.wardId, waiting))[0];
    if (!original?.r2_path) throw new Error("待っている写真の原本がありません");
    expect(await new WardBucket(env.ORIGINALS, ward.wardId).get(original.r2_path)).not.toBeNull();
    const direct = await receive(env, { wardId: ward.wardId, via: "admin", projectId: project.projectId,
      parts: [{ kind: "text", filename: "試しの文.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("試しの準備の報告") }] });
    expect(await dispatchProject(env, ward.wardId, project.projectId)).toBe("limited");
    expect(connectCalls).toBe(0);
    expect(readCalls).toBe(1);
    expect(await (await get(realApp, "/ops/alerts", cookie, opsEnv)).text()).toContain("月の上限で待っている資料2件");
    // 受付は先月でも、使用量は動いた今月で数える。
    await env.DB.prepare("UPDATE jobs SET created_at = '2020-01-01T00:00:00Z' WHERE ward_id = ? AND job_id = ?").bind(ward.wardId, first).run();
    expect((await getWardAiLimits(env.DB, ward.wardId)).costCents).toBeGreaterThan(2);
    const future = new Date(); future.setUTCMonth(future.getUTCMonth() + 1);
    expect((await getWardAiLimits(env.DB, ward.wardId, future)).monthlyBlocked).toBe(false);
    await save({ monthlyLimit: "100" });
    await env.DB.prepare("UPDATE jobs SET updated_at = '2020-01-01T00:00:00Z' WHERE ward_id = ? AND job_id = ?").bind(ward.wardId, waiting).run();
    await sweepReads(env, deps);
    expect(readCalls).toBe(2);
    await setWorkersRoute(env.DB, ward.wardId, true);
    await sweepConnections(env);
    expect(connectCalls).toBe(1);
    expect(direct.jobId && await getJob(env.DB, ward.wardId, direct.jobId)).toMatchObject({ status: "done", failure: "" });

    await save({ saveLineDailyLimit: "1", lineSenderDailyLimit: "1" });
    const runtime = withEnv({ LINE_CHANNEL_SECRET: "fictional-u74-secret", LINE_CHANNEL_ACCESS_TOKEN: "fictional-u74-token" });
    const destination = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding) VALUES (?, ?, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN')")
      .bind(ward.wardId, destination).run();
    let matches = 0;
    const replies: string[] = [];
    const ports = createLineIntakePorts(runtime, { waitUntil: () => { throw new Error("超過分のAIを始めてはいけません"); } }, async () => {
      matches++;
      return { choice: MATCH_UNRELATED, reason: "試しの雑談です", usage: { input_tokens: 10, output_tokens: 1 } };
    });
    const fakeLine: typeof fetch = async (url, init) => {
      if (String(url).includes("/content")) return new Response(fictionalPaperPhoto("試しのLINEの写真"), { headers: { "content-type": "image/jpeg" } });
      if (String(url).endsWith("/message/reply")) {
        const value = JSON.parse(String(init?.body)) as { messages: Array<{ text: string }> };
        replies.push(...value.messages.map((message) => message.text));
        return Response.json({ sentMessages: [{ id: "fictional-receipt" }] });
      }
      throw new Error("試しのLINE以外へは接続しません");
    };
    const send = async (kind: "text" | "image", now: Date, id = crypto.randomUUID(), sender = "fictional-u74-sender") => {
      const body = JSON.stringify({ destination, events: [{ type: "message", webhookEventId: id, timestamp: now.getTime(), replyToken: id,
        source: { type: "user", userId: sender }, message: { type: kind, id, text: `試しの文${id}` } }] });
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(runtime.LINE_CHANNEL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
      const response = await acceptLineWebhook(new Request("https://unit.test/hooks/line", { method: "POST", headers: { "x-line-signature": signature }, body }),
        runtime, env.DB, { ports, fetch: fakeLine }, now);
      expect(response.status).toBe(200);
      return id;
    };
    const now = new Date();
    await send("text", now); // 雑談は今までどおり保存しないが、一日の受付に数える。
    expect(matches).toBe(1);
    const limitedText = await send("text", now);
    await send("image", now);
    await send("text", now, limitedText); // 再送は増やさない。
    expect(matches).toBe(1);
    expect(replies).toContain("受け取りました。役員が確かめます。");
    const held = await env.DB.prepare("SELECT job_id, status, failure FROM jobs WHERE ward_id = ? AND ai_limit_reason = 'sender'")
      .bind(ward.wardId).all<{ job_id: string; status: string; failure: string }>();
    expect(held.results).toHaveLength(2);
    for (const job of held.results) {
      expect(job).toMatchObject({ status: "received", failure: "" });
      expect(await runRead(env, ward.wardId, job.job_id, { deps })).toBe("skipped");
      const saved = (await listOriginals(env.DB, ward.wardId, job.job_id))[0];
      if (!saved?.r2_path) throw new Error("超過分の原本がありません");
      expect(await new WardBucket(env.ORIGINALS, ward.wardId).get(saved.r2_path)).not.toBeNull();
    }
    await send("text", now, crypto.randomUUID(), "fictional-other-sender");
    await send("text", new Date(now.getTime() + 24 * 3600_000));
    expect(matches).toBe(3);
    await save({ saveLineDailyLimit: "1", lineSenderDailyLimit: "0" });
    await save({ monthlyLimit: "0" });
    const settings = await (await get(realApp, `/ops/wards/${ward.slug}/budget`, cookie, opsEnv)).text();
    expect(settings).toContain("月の上限: 制限なし");
    expect(settings).toContain("LINEの一日上限: 制限なし");
    expect(await (await get(realApp, "/ops/alerts", cookie, opsEnv)).text()).toContain("元の資料だけ残したもの2件");
  } finally { setClientFactory(null); }
});
