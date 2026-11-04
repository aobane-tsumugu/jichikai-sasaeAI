// Managed Agents の流れ（agent の用意、セッション、直列化、MCP の五つの手、webhook、完了、Cron）を、偽の Anthropic で確かめる。
// 本物の API は呼ばない。
import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { Webhook } from "standardwebhooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTask } from "../src/ai/api";
import { checkSession, decide, sweepConnections } from "../src/ai/complete";
import { setClientFactory } from "../src/ai/deps";
import { PACK_VERSION } from "../src/ai/pack";
import { setProjectApi } from "../src/ai/project-binding";
import type { ProjectApi } from "../src/ai/project-contract";
import { dispatchProject, ensureWardAi } from "../src/ai/session";
import { callTool } from "../src/ai/mcp";
import { createProject, getProjectState } from "../src/project/api";
import { realApp } from "./helpers";
import { receive } from "../src/intake/receive";
import { getJob } from "../src/intake/store";
import { seedWard } from "../src/core/testing";
import { sha256Hex } from "../src/intake/media";

const PROJECT = "proj-1";

interface Calls {
  envCreated: number;
  vaults: number;
  credentials: Array<{ vault: string; auth: Record<string, unknown> }>;
  agents: Array<Record<string, unknown>>;
  agentUpdates: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
  deleted: string[];
}

/** 偽の Anthropic。sessionState で、セッションの今と events を決める。 */
function fakeAnthropic() {
  const calls: Calls = { envCreated: 0, vaults: 0, credentials: [], agents: [], agentUpdates: [], sessions: [], deleted: [] };
  const state = new Map<string, { status: string; events: Array<Record<string, unknown>>; usage?: unknown }>();
  let n = 0;
  // 試験の間で D1 は共有されるので、セッションの ID は偽ごとに重ならないようにする
  const prefix = crypto.randomUUID().slice(0, 8);
  const sid = (k: number) => `sesn_${prefix}_${k}`;
  const real = new Anthropic({ apiKey: "試験" });
  const client = {
    beta: {
      environments: {
        list: () => (async function* () {})(),
        create: async () => (calls.envCreated++, { id: "env_1" }),
      },
      vaults: {
        create: async () => (calls.vaults++, { id: "vlt_1" }),
        credentials: { create: async (vault: string, params: { auth: Record<string, unknown> }) => (calls.credentials.push({ vault, auth: params.auth }), { id: "cred_1" }) },
      },
      agents: {
        create: async (p: Record<string, unknown>) => (calls.agents.push(p), { id: "agent_1", version: 1 }),
        update: async (id: string, p: Record<string, unknown>) => (calls.agentUpdates.push({ id, ...p }), { id, version: 2 }),
      },
      sessions: {
        create: async (p: Record<string, unknown>) => {
          calls.sessions.push(p);
          const id = sid(++n);
          state.set(id, { status: "running", events: [] });
          return { id };
        },
        retrieve: async (id: string) => {
          const s = state.get(id);
          if (!s) throw Object.assign(new Error("not found"), { status: 404 });
          return { id, status: s.status, usage: s.usage, metadata: {} };
        },
        delete: async (id: string) => (calls.deleted.push(id), state.delete(id), { id }),
        events: { list: (id: string) => (async function* () { for (const e of state.get(id)?.events ?? []) yield e; })() },
      },
      webhooks: real.beta.webhooks,
    },
  } as unknown as Anthropic;
  const finish = (id: string, stopReason: string, status = "idle", usage?: unknown) => {
    state.set(id, { status, events: [{ type: "session.status_idle", stop_reason: { type: stopReason } }], usage });
  };
  return { client, calls, state, finish, sid };
}

const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(crypto.randomUUID())]);

/** 読み終わった入力を作る（直接読む文字なので、モデルを通さない）。 */
async function readyJob(wardId: string, text = crypto.randomUUID()) {
  const out = await receive(env, { wardId, via: "admin", projectId: PROJECT, parts: [{ kind: "text", filename: "", mediaType: "text/plain", bytes: new TextEncoder().encode(text) }] });
  return { jobId: out.jobId as string, originalId: out.received[0]?.originalId as string };
}

let fake: ReturnType<typeof fakeAnthropic>;
beforeEach(() => {
  fake = fakeAnthropic();
  setClientFactory(() => fake.client);
});
afterEach(() => {
  setClientFactory(null);
  setProjectApi(null);
});

describe("agent の用意", () => {
  it("区ごとに environment、vault、MCP の鍵、agent を一度だけ作り、手は MCP の五つだけにする", async () => {
    const ward = await seedWard(env.DB);
    const ai = await ensureWardAi(env, ward);
    expect(ai).toMatchObject({ environment_id: "env_1", vault_id: "vlt_1", agent_id: "agent_1", agent_version: 1, pack_version: PACK_VERSION });
    const url = `${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/${ward.slug}/mcp`;
    expect(fake.calls.credentials[0]?.auth).toMatchObject({ type: "static_bearer", mcp_server_url: url });
    const token = fake.calls.credentials[0]?.auth.token as string;
    expect(ai.mcp_token_hash).toBe(await sha256Hex(token));
    const agent = fake.calls.agents[0] as { model: { id: string }; tools: unknown[]; mcp_servers: unknown[] };
    expect(agent.model.id).toBe("claude-sonnet-5-5");
    expect(agent.mcp_servers).toEqual([{ type: "url", name: "kiroku", url }]);
    // agent_toolset は渡さない。mcp_toolset は always_allow を明示する
    expect(agent.tools).toEqual([{ type: "mcp_toolset", mcp_server_name: "kiroku", default_config: { permission_policy: { type: "always_allow" } } }]);
    await ensureWardAi(env, ward);
    expect(fake.calls.agents).toHaveLength(1);
    expect(fake.calls.vaults).toBe(1);
  });

  it("包みの版が変われば agent を更新する", async () => {
    const ward = await seedWard(env.DB);
    await ensureWardAi(env, ward);
    await env.DB.prepare("UPDATE ward_ai SET pack_version = 'old' WHERE ward_id = ?").bind(ward.wardId).run();
    const ai = await ensureWardAi(env, ward);
    expect(fake.calls.agentUpdates).toHaveLength(1);
    expect(ai.agent_version).toBe(2);
  });

  it("作る途中で止まっても、続きから作る", async () => {
    const ward = await seedWard(env.DB);
    let failOnce = true;
    const original = fake.client.beta.agents.create;
    (fake.client.beta.agents as { create: unknown }).create = async (p: never) => {
      if (failOnce) { failOnce = false; throw new Error("一時の失敗"); }
      return original.call(fake.client.beta.agents, p);
    };
    await expect(ensureWardAi(env, ward)).rejects.toThrow("一時の失敗");
    const ai = await ensureWardAi(env, ward);
    expect(ai.agent_id).toBe("agent_1");
    expect(fake.calls.vaults).toBe(1);
  });
});

describe("セッションとプロジェクトの中の直列化", () => {
  it("読み終わった入力にセッションを開き、札は要約だけを持つ。原本は渡さない", async () => {
    const ward = await seedWard(env.DB);
    const { jobId } = await readyJob(ward.wardId, "雨天は屋内");
    expect(await dispatchProject(env, ward.wardId, PROJECT)).toBe("started");
    const job = await getJob(env.DB, ward.wardId, jobId);
    expect(job).toMatchObject({ status: "connecting", session_id: fake.sid(1), connect_attempt: 1 });
    const params = fake.calls.sessions[0] as { agent: unknown; vault_ids: string[]; budget: unknown; metadata: Record<string, string>; initial_events: Array<{ content: Array<{ text: string }> }>; resources?: unknown };
    expect(params.agent).toEqual({ type: "agent", id: "agent_1", version: 1 });
    expect(params.vault_ids).toEqual(["vlt_1"]);
    expect(params.budget).toEqual({ type: "limit", max_list_cost: { amount: "100", currency: "USD" } });
    expect(params.metadata).toMatchObject({ ward_id: ward.wardId, job_id: jobId });
    expect(params.resources).toBeUndefined();
    const message = params.initial_events[0]?.content[0]?.text as string;
    const ticket = /札: (tk_\S+)/.exec(message)?.[1] as string;
    expect(job?.ticket_hash).toBe(await sha256Hex(ticket));
    expect(message).not.toContain("雨天は屋内");
    expect(message).not.toContain(PROJECT);
  });

  it("同じプロジェクトでは一つずつ。完了すると次が開く。別のプロジェクトは待たない", async () => {
    const ward = await seedWard(env.DB);
    const first = await readyJob(ward.wardId);
    await new Promise((r) => setTimeout(r, 5));
    const second = await readyJob(ward.wardId);
    expect(await dispatchProject(env, ward.wardId, PROJECT)).toBe("started");
    expect(await dispatchProject(env, ward.wardId, PROJECT)).toBe("busy");
    expect((await getJob(env.DB, ward.wardId, second.jobId))?.status).toBe("read");
    expect(fake.calls.sessions).toHaveLength(1);
    // 競り合っても一つしか開かない
    const racers = await Promise.all([dispatchProject(env, ward.wardId, PROJECT), dispatchProject(env, ward.wardId, PROJECT)]);
    expect(racers).toEqual(["busy", "busy"]);

    fake.finish(fake.sid(1), "end_turn");
    expect(await checkSession(env, ward.wardId, first.jobId)).toBe("done");
    expect(await getJob(env.DB, ward.wardId, first.jobId)).toMatchObject({ status: "done", ticket_hash: null, stop_reason: "end_turn" });
    expect(fake.calls.deleted).toEqual([fake.sid(1)]);
    // 完了の後、次の入力が自動で開く
    expect(await getJob(env.DB, ward.wardId, second.jobId)).toMatchObject({ status: "connecting", session_id: fake.sid(2) });
    // 二度確かめても一度しか効かない
    expect(await checkSession(env, ward.wardId, first.jobId)).toBe("skipped");
  });

  it("要対応（予算の上限）、失敗（終わったのに end_turn が無い）、動いている間は待つ", async () => {
    expect(decide("running", null).outcome).toBe("running");
    expect(decide("idle", "end_turn").outcome).toBe("done");
    expect(decide("idle", "budget_reached").outcome).toBe("attention");
    expect(decide("idle", "requires_action").outcome).toBe("attention");
    expect(decide("terminated", null)).toEqual({ outcome: "failed", failure: "connect" });
    expect(decide("idle", null).outcome).toBe("running");

    const ward = await seedWard(env.DB);
    const a = await readyJob(ward.wardId);
    await dispatchProject(env, ward.wardId, PROJECT);
    expect(await checkSession(env, ward.wardId, a.jobId)).toBe("running");
    fake.finish(fake.sid(1), "budget_reached", "idle", { input_tokens: 50, output_tokens: 7, list_cost: { amount: "100" } });
    expect(await checkSession(env, ward.wardId, a.jobId)).toBe("attention");
    const run = await env.DB.prepare("SELECT status, stop_reason, input_tokens, output_tokens, list_cost_cents FROM job_runs WHERE ward_id = ? AND job_id = ? AND kind = 'connect'").bind(ward.wardId, a.jobId).first();
    expect(run).toEqual({ status: "ok", stop_reason: "budget_reached", input_tokens: 50, output_tokens: 7, list_cost_cents: 100 });

    const b = await readyJob(ward.wardId);
    await dispatchProject(env, ward.wardId, PROJECT);
    expect((await getJob(env.DB, ward.wardId, b.jobId))?.status).toBe("connecting");
    fake.state.set(fake.sid(2), { status: "terminated", events: [] });
    expect(await checkSession(env, ward.wardId, b.jobId)).toBe("failed");
    expect(await getJob(env.DB, ward.wardId, b.jobId)).toMatchObject({ status: "failed", failure: "connect" });
  });

  it("開けなかった入力は read に戻り、試行の上限で failed になる。失敗した物は読み直さず繋げ直せる", async () => {
    const ward = await seedWard(env.DB);
    const { jobId } = await readyJob(ward.wardId);
    setClientFactory(() => { throw new Error("つながらない"); });
    expect(await dispatchProject(env, ward.wardId, PROJECT)).toBe("retry");
    expect(await getJob(env.DB, ward.wardId, jobId)).toMatchObject({ status: "read", ticket_hash: null });
    await dispatchProject(env, ward.wardId, PROJECT);
    expect(await dispatchProject(env, ward.wardId, PROJECT)).toBe("failed");
    expect(await getJob(env.DB, ward.wardId, jobId)).toMatchObject({ status: "failed", failure: "connect", connect_attempt: 3 });
    const { retryJob } = await import("../src/intake/api");
    setClientFactory(() => fake.client);
    const pending: Promise<unknown>[] = [];
    expect(await retryJob(env, { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as never, ward.wardId, jobId)).toBe(true);
    await Promise.all(pending);
    expect(await getJob(env.DB, ward.wardId, jobId)).toMatchObject({ status: "connecting", connect_attempt: 1, failure: "" });
  });

  it("動いているセッションは、中断を送ってから消す", async () => {
    const ward = await seedWard(env.DB);
    const a = await readyJob(ward.wardId);
    await dispatchProject(env, ward.wardId, PROJECT);
    const sessions = (fake.client.beta as unknown as { sessions: { delete: (id: string) => Promise<unknown>; events: { send?: unknown } } }).sessions;
    const sent: unknown[] = [];
    let interrupted = false;
    const realDelete = sessions.delete;
    sessions.delete = async (id: string) => {
      if (!interrupted) throw Object.assign(new Error("Cannot delete session while it is running"), { status: 400 });
      return realDelete(id);
    };
    sessions.events.send = async (_id: string, body: unknown) => (sent.push(body), (interrupted = true));
    await env.DB.prepare("UPDATE jobs SET connect_started_at = ? WHERE ward_id = ? AND job_id = ?").bind(new Date(Date.now() - 30 * 60_000).toISOString(), ward.wardId, a.jobId).run();
    expect(await checkSession(env, ward.wardId, a.jobId)).toBe("failed");
    expect(sent).toEqual([{ events: [{ type: "user.interrupt" }] }]);
    expect((await getJob(env.DB, ward.wardId, a.jobId))?.session_deleted_at).toBeTruthy();
  }, 15000);

  it("Cron は、動き続ける入力を時間切れで失敗にし、消し損ねを消し、待っている物を送る", async () => {
    const ward = await seedWard(env.DB);
    const a = await readyJob(ward.wardId);
    await dispatchProject(env, ward.wardId, PROJECT);
    await env.DB.prepare("UPDATE jobs SET connect_started_at = ? WHERE ward_id = ? AND job_id = ?").bind(new Date(Date.now() - 30 * 60_000).toISOString(), ward.wardId, a.jobId).run();
    const swept = await sweepConnections(env);
    expect(swept.checked).toBeGreaterThanOrEqual(1);
    expect(await getJob(env.DB, ward.wardId, a.jobId)).toMatchObject({ status: "failed", failure: "connect" });
    expect(fake.calls.deleted).toContain(fake.sid(1));
    // 消し損ねた物（session_deleted_at が空のまま終わった物）
    await env.DB.prepare("UPDATE jobs SET session_deleted_at = NULL WHERE ward_id = ? AND job_id = ?").bind(ward.wardId, a.jobId).run();
    expect((await sweepConnections(env)).deleted).toBeGreaterThanOrEqual(1);
    expect((await getJob(env.DB, ward.wardId, a.jobId))?.session_deleted_at).toBeTruthy();
  });

  it("下書きなどの原本の無い仕事も、同じ順番に入る", async () => {
    const ward = await seedWard(env.DB);
    const pending: Promise<unknown>[] = [];
    const id = await startTask(env, { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as never, { wardId: ward.wardId, projectId: PROJECT, task: "draft", instruction: "案内の下書きを起こす" });
    await Promise.all(pending);
    expect(await getJob(env.DB, ward.wardId, id)).toMatchObject({ status: "connecting", task: "draft", via: "system" });
    const text = (fake.calls.sessions[0] as { initial_events: Array<{ content: Array<{ text: string }> }> }).initial_events[0]?.content[0]?.text;
    expect(text).toContain("仕事: draft");
    expect(text).toContain("案内の下書きを起こす");
  });
});

/** JSON-RPC を MCP の口に送る。 */
async function rpc(slug: string, token: string | null, body: unknown) {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const res = await realApp.request(`/${slug}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }, env, ctx);
  return res;
}

async function mcpSetup() {
  const ward = await seedWard(env.DB);
  const { jobId, originalId } = await readyJob(ward.wardId);
  await dispatchProject(env, ward.wardId, PROJECT);
  const token = fake.calls.credentials[0]?.auth.token as string;
  const message = (fake.calls.sessions[0] as { initial_events: Array<{ content: Array<{ text: string }> }> }).initial_events[0]?.content[0]?.text as string;
  const ticket = /札: (tk_\S+)/.exec(message)?.[1] as string;
  return { ward, jobId, originalId, token, ticket };
}

const call = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const textOf = async (res: Response) => ((await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;

describe("MCP の口", () => {
  it("鍵が無い、違う、他の区の鍵は 401。GET は 405", async () => {
    const { ward, token } = await mcpSetup();
    expect((await rpc(ward.slug, null, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    expect((await rpc(ward.slug, "違う鍵", { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    const other = await seedWard(env.DB);
    expect((await rpc(other.slug, token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    const get = await realApp.request(`/${ward.slug}/mcp`, {}, env);
    expect(get.status).toBe(405);
  });

  it("initialize、通知、ping、tools/list が決まりの形で返る。手は五つ", async () => {
    const { ward, token } = await mcpSetup();
    const init = await (await rpc(ward.slug, token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).json() as { result: { protocolVersion: string; capabilities: { tools: unknown } } };
    expect(init.result.protocolVersion).toBe("2025-03-26");
    expect(init.result.capabilities.tools).toBeDefined();
    expect((await rpc(ward.slug, token, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect(await (await rpc(ward.slug, token, { jsonrpc: "2.0", id: 2, method: "ping" })).json()).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    const list = await (await rpc(ward.slug, token, { jsonrpc: "2.0", id: 3, method: "tools/list" })).json() as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["list_open_projects", "get_project_state", "get_reading", "write_change", "write_question"]);
    const unknown = await (await rpc(ward.slug, token, { jsonrpc: "2.0", id: 4, method: "resources/list" })).json() as { error: { code: number } };
    expect(unknown.error.code).toBe(-32601);
  });

  it("札が無い、違う、完了した後は使えない。引数のプロジェクト ID は信じない", async () => {
    const { ward, jobId, token, ticket } = await mcpSetup();
    const bad = await textOf(await rpc(ward.slug, token, call(1, "get_reading", { ticket: "tk_違う" })));
    expect(bad.isError).toBe(true);
    const seen: string[] = [];
    setProjectApi({ ...stubApi(), getProjectState: async (_e, _w, projectId) => (seen.push(projectId), { ok: true }) });
    const good = await textOf(await rpc(ward.slug, token, call(2, "get_project_state", { ticket, projectId: "別のプロジェクト", project_id: "別" })));
    expect(good.isError).toBeUndefined();
    expect(seen).toEqual([PROJECT]);
    const reading = JSON.parse((await textOf(await rpc(ward.slug, token, call(3, "get_reading", { ticket })))).content[0]?.text as string) as { readings: Array<{ source: string }> };
    expect(reading.readings[0]?.source).toBe("direct");
    // 完了したら札は失効する
    fake.finish(fake.sid(1), "end_turn");
    await checkSession(env, ward.wardId, jobId);
    const after = await textOf(await rpc(ward.slug, token, call(4, "get_reading", { ticket })));
    expect(after.isError).toBe(true);
  });

  it("差分を書く手は、出どころが実在する物だけを束 3 に渡し、実在しない物は捨てて残す", async () => {
    const { ward, jobId, originalId, token, ticket } = await mcpSetup();
    const writes: Array<{ kind: string; originalId: string | null; projectId: string }> = [];
    setProjectApi({
      ...stubApi(),
      applyChange: async (_e, ctx, change) => (writes.push({ kind: change.kind, originalId: change.originalId, projectId: ctx.projectId }), { status: "applied" }),
    });
    const ok = await textOf(await rpc(ward.slug, token, call(1, "write_change", { ticket, kind: "item", original_id: originalId, locator: "1 行目", target: "日時", data: { value: "10月24日" }, confidence: "high" })));
    expect(JSON.parse(ok.content[0]?.text as string)).toEqual({ status: "applied" });
    // 別の区の原本、でたらめな ID
    const foreign = await seedWard(env.DB);
    const other = await readyJob(foreign.wardId);
    for (const bogus of [other.originalId, "でたらめ", ""]) {
      const res = await textOf(await rpc(ward.slug, token, call(2, "write_change", { ticket, kind: "row", original_id: bogus, target: "協賛先", data: {}, confidence: "high" })));
      expect(res.isError).toBe(true);
    }
    // 下書きは出どころの原本が要らない
    const draft = await textOf(await rpc(ward.slug, token, call(3, "write_change", { ticket, kind: "draft", target: "案内", data: { text: "…" }, confidence: "medium" })));
    expect(draft.isError).toBeUndefined();
    expect(writes).toEqual([
      { kind: "item", originalId, projectId: PROJECT },
      { kind: "draft", originalId: null, projectId: PROJECT },
    ]);
    const job = await getJob(env.DB, ward.wardId, jobId);
    expect(job?.discard_count).toBe(3);
    expect(JSON.parse(job?.discards ?? "[]")).toHaveLength(3);
    // 問い
    const asked: string[] = [];
    setProjectApi({ ...stubApi(), addQuestion: async (_e, _c, q) => (asked.push(q.text), { status: "added" }) });
    await rpc(ward.slug, token, call(4, "write_question", { ticket, text: "傘置きの担当は追加でよいか", original_id: "でたらめ" }));
    expect(asked).toEqual(["傘置きの担当は追加でよいか"]);
    expect((await textOf(await rpc(ward.slug, token, call(5, "write_question", { ticket, text: " " })))).isError).toBe(true);
  });
});

function stubApi(): ProjectApi {
  return {
    listOpenProjects: async () => [],
    getProjectState: async () => ({}),
    applyChange: async () => ({ status: "applied" }),
    addQuestion: async () => ({ status: "added" }),
  };
}

describe("webhook の受け口", () => {
  const secret = `whsec_${btoa("test-signing-key-0123456789abcdef")}`;

  async function post(body: object, signed = true) {
    const payload = JSON.stringify(body);
    const id = `msg_${crypto.randomUUID()}`;
    const now = new Date();
    const headers: Record<string, string> = { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(Math.floor(now.getTime() / 1000)) };
    headers["webhook-signature"] = signed ? new Webhook(secret).sign(id, now, payload) : "v1,AAAA";
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const res = await realApp.request("/hooks/anthropic", { method: "POST", headers, body: payload }, { ...env, ANTHROPIC_WEBHOOK_SIGNING_KEY: secret }, ctx);
    await Promise.all(pending);
    return res;
  }

  it("署名の合う物だけを受ける（SDK の unwrap が Workers で動く）。3xx は返さない", async () => {
    const res = await post({ type: "event", id: "whe_1", created_at: "2026-11-05T00:00:00Z", data: { type: "session.status_idled", id: "sesn_x" } });
    expect(res.status).toBe(204);
    const forged = await post({ type: "event", id: "whe_2", data: { type: "session.status_idled", id: "sesn_x" } }, false);
    expect(forged.status).toBe(400);
    expect(res.status < 300 || res.status >= 400).toBe(true);
  });

  it("session.status_idled で、その入力を完了にしてセッションを消す", async () => {
    const ward = await seedWard(env.DB);
    const { jobId } = await readyJob(ward.wardId);
    await dispatchProject(env, ward.wardId, PROJECT);
    fake.finish(fake.sid(1), "end_turn");
    const res = await post({ type: "event", id: "whe_3", data: { type: "session.status_idled", id: fake.sid(1) } });
    expect(res.status).toBe(204);
    expect(await getJob(env.DB, ward.wardId, jobId)).toMatchObject({ status: "done" });
    expect(fake.calls.deleted).toEqual([fake.sid(1)]);
    // 同じ知らせがもう一度来ても何も起きない
    expect((await post({ type: "event", id: "whe_3", data: { type: "session.status_idled", id: fake.sid(1) } })).status).toBe(204);
    expect(fake.calls.deleted).toEqual([fake.sid(1)]);
  });
});

describe("束 3 の API との繋ぎ", () => {
  it("札から割り出したプロジェクトに、項目、表の行、決めたこと、問いを書き、実在しない出どころと不正な鍵は書かない", async () => {
    const ward = await seedWard(env.DB);
    const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭（架空）", year: 2026 });
    const out = await receive(env, {
      wardId: ward.wardId,
      via: "admin",
      projectId: project.projectId,
      parts: [{ kind: "text", filename: "", mediaType: "text/plain", bytes: new TextEncoder().encode("公民館前の広場。協賛は商店Aが 6000 円") }],
    });
    const originalId = out.received[0]?.originalId as string;
    await dispatchProject(env, ward.wardId, project.projectId);
    const message = (fake.calls.sessions[0] as { initial_events: Array<{ content: Array<{ text: string }> }> }).initial_events[0]?.content[0]?.text as string;
    const ticket = /札: (tk_\S+)/.exec(message)?.[1] as string;
    const run = async (name: string, args: Record<string, unknown>) => {
      const r = await callTool(env, ward.wardId, name, { ticket, ...args });
      return { isError: r.isError, body: r.content[0]?.text ?? "" };
    };
    const status = (r: { body: string }) => (JSON.parse(r.body) as { status: string; reason?: string }).status;

    expect(status(await run("write_change", { kind: "item", original_id: originalId, locator: "1 行目", year: 2026, target: "place", data: { value: "公民館前の広場" }, confidence: "high" }))).toBe("applied");
    expect(status(await run("write_change", { kind: "row", original_id: originalId, locator: "1 行目", year: 2026, target: "sponsors", data: { name: "商店A", reply: "yes", amount: 6000 }, confidence: "high" }))).toBe("applied");
    expect(status(await run("write_change", { kind: "decision", original_id: originalId, locator: "1 行目", year: 2026, target: "会場", data: { what: "会場は公民館前の広場", decidedOn: "9月12日" }, confidence: "medium" }))).toBe("applied");
    expect(status(await run("write_question", { kind: "decide", target: "rain_plan", text: "雨天時の会場はどこにしますか", original_id: originalId, locator: "1 行目" }))).toBe("added");

    const state = JSON.stringify(await getProjectState(env.DB, ward.wardId, project.projectId));
    expect(state).toContain("公民館前の広場");
    expect(state).toContain("商店A");
    expect(state).toContain("雨天時の会場はどこにしますか");

    // 実在しない出どころは MCP の手が捨てる。不正な鍵は束 3 に渡さず断る
    expect((await run("write_change", { kind: "item", original_id: "でたらめ", target: "place", data: { value: "x" }, confidence: "high" })).isError).toBe(true);
    const badKey = await run("write_change", { kind: "item", original_id: originalId, locator: "1", target: "場所", data: { value: "x" }, confidence: "high" });
    expect(status(badKey)).toBe("rejected");
    const draft = await run("write_change", { kind: "draft", target: "announcement", data: { text: "x" }, confidence: "medium" });
    expect(status(draft)).toBe("rejected");
    // 同じ差分の二度目は同じ物でした（束 3 の冪等）
    const again = JSON.parse((await run("write_change", { kind: "item", original_id: originalId, locator: "1 行目", year: 2026, target: "place", data: { value: "公民館前の広場" }, confidence: "high" })).body) as { status: string; duplicate: boolean };
    expect(again.duplicate || again.status === "same").toBe(true);
  });
});
