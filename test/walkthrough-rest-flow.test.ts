import Anthropic from "@anthropic-ai/sdk";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { checkInquiry, checkWorkersRoute, type CheckPorts } from "../scripts/walkthrough-rest";
import { setClientFactory } from "../src/ai/deps";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { recordLineInquiry } from "../src/project/followup";
import { realApp, withEnv } from "./helpers";

it("U72: 役員の試しの返事の結果と、資料のWorkers経路の完了を見て設定を戻す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: FIRST_SLICE.draftTitle, year: 2026, accountId: account.accountId });
  const runtime = withEnv({ LINE_SIM_CHANNEL_SECRET: "fictional-u72-secret", LINE_SIM_CHANNEL_ACCESS_TOKEN: "fictional-u72-token" });
  await env.DB.prepare("INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding) VALUES (?, ?, 'LINE_SIM_CHANNEL_SECRET', 'LINE_SIM_CHANNEL_ACCESS_TOKEN')")
    .bind(ward.wardId, "U" + "0".repeat(32)).run();
  const contexts: ReturnType<typeof createExecutionContext>[] = [];
  let uploads = 0;
  const ports: CheckPorts = {
    query: async (sql) => {
      expect(sql).toContain("ward_id");
      return (await env.DB.prepare(sql).all<Record<string, unknown>>()).results;
    },
    request: async (path, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("origin", "http://localhost");
      headers.set("cookie", cookie);
      if (path.endsWith("/intake") && init.method === "POST") uploads++;
      const ctx = createExecutionContext();
      contexts.push(ctx);
      const response = await realApp.fetch(new Request("http://localhost" + path, { ...init, headers }), runtime, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    },
    sleep: async () => { throw new Error("この試験では完了まで処理してからD1を読みます"); },
  };
  let lineChecks = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("api.line.me") || !url.includes("/message/quota")) throw new Error("LINEの送信APIや実際の外部通信は呼びません");
    lineChecks++;
    return Response.json({ message: "試しの鍵です" }, { status: 401 });
  });
  let aiCalls = 0;
  const client = new Anthropic({ apiKey: "fictional-u72-ai", maxRetries: 0, fetch: async () => {
    aiCalls++;
    return Response.json({ id: "fictional-u72-response", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: "試しの資料を確認しました。" }], usage: { input_tokens: 10, output_tokens: 10 } });
  } });
  setClientFactory(() => client);
  try {
    expect(await checkInquiry(ward.slug, ports)).toMatchObject({ result: "飛ばす", reason: `${ward.slug}区に問い合わせの記録がありません` });
    await recordLineInquiry(env.DB, ward.wardId, { eventId: "line-sim-u72", receivedAt: new Date().toISOString(), text: FIRST_SLICE.draftTitle + "は何時ですか？",
      sourceType: "user", sourceId: "U-fictional-u72", senderLabel: "試しの問い合わせ" });
    expect(await checkInquiry(ward.slug, ports)).toMatchObject({ result: "通過", status: 502 });
    expect(lineChecks).toBeGreaterThan(0);
    expect(await env.DB.prepare("SELECT line_pending_answer FROM inquiry_records WHERE ward_id = ?").bind(ward.wardId).first("line_pending_answer")).toBe(FIRST_SLICE.publicAnnouncement);

    const previousTime = "2026-11-01T00:00:00.000Z";
    await env.DB.prepare("INSERT INTO ward_ai_route_flags (ward_id, use_workers_route, updated_at) VALUES (?, 0, ?), (?, 0, ?)")
      .bind(ward.wardId, previousTime, other.ward.wardId, previousTime).run();
    const readFlag = (wardId: string) => env.DB.prepare("SELECT use_workers_route, updated_at FROM ward_ai_route_flags WHERE ward_id = ?")
      .bind(wardId).first();
    const previous = await readFlag(ward.wardId);
    for (const forbidden of ["kakuu", "demoku"]) await expect(checkWorkersRoute(forbidden, project.projectId, FIRST_SLICE.publicAnnouncement, ports)).rejects.toThrow("使えません");
    expect(uploads).toBe(0);
    await checkWorkersRoute(ward.slug, project.projectId, FIRST_SLICE.publicAnnouncement, ports);
    expect(uploads).toBe(1);
    expect(aiCalls).toBeGreaterThan(0);
    expect(await readFlag(ward.wardId)).toEqual(previous);
    expect(await readFlag(other.ward.wardId)).toEqual(previous);
    const job = await env.DB.prepare("SELECT status, session_id, stop_reason FROM jobs WHERE ward_id = ? AND project_id = ?")
      .bind(ward.wardId, project.projectId).first();
    expect(job).toMatchObject({ status: "done", session_id: null, stop_reason: "end_turn" });

    // 受付の応答が失われても設定を戻す。元の設定行が無い場合も元へ戻す。
    await env.DB.prepare("DELETE FROM ward_ai_route_flags WHERE ward_id = ?").bind(ward.wardId).run();
    await expect(checkWorkersRoute(ward.slug, project.projectId, FIRST_SLICE.publicAnnouncement, {
      ...ports, request: async () => { throw new Error("試しの応答切断"); },
    })).rejects.toThrow("試しの応答切断");
    expect(await readFlag(ward.wardId)).toBeNull();
    expect(await readFlag(other.ward.wardId)).toEqual(previous);
  } finally {
    await Promise.allSettled(contexts.map(waitOnExecutionContext));
    setClientFactory(null);
    vi.unstubAllGlobals();
  }
});
