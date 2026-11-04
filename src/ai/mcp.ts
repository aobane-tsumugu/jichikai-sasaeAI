// MCP の口（/:ward/mcp）。状態を持たない Streamable HTTP を Workers に手書きする（Durable Objects は要らない）。
// agent が呼ぶ手は五つだけ。区は URL とトークン（vault の static_bearer）で、プロジェクトは札で割り出し、
// 引数のプロジェクト ID は信じない。書く手は出どころの実在を検査し、実在しなければ捨てて、捨てたことを残す。
import { Hono } from "hono";
import type { Env, WardEnv } from "../env";
import { sha256Hex } from "../intake/media";
import { getReadings, originalInProject } from "../intake/store";
import type { JobRow } from "../intake/types";
import { PACK_VERSION } from "./pack";
import { projectApi } from "./project-binding";
import type { ChangeKind, Confidence, WriteContext } from "./project-contract";
import { jobByTicket } from "./session";

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_DISCARDS_KEPT = 20;

const ticketProp = { type: "string", description: "最初のメッセージにある札。そのまま書き写す" } as const;

export const TOOLS = [
  {
    name: "list_open_projects",
    description: "開いているプロジェクトの一覧（題、種類、年）。入った物が別のプロジェクトの話に見える時だけ使う。",
    inputSchema: { type: "object", properties: { ticket: ticketProp }, required: ["ticket"], additionalProperties: false },
  },
  {
    name: "get_project_state",
    description: "書く先のプロジェクトの今の状態（項目、表、文書、決めたこと。今年の中身と参考の中身）。",
    inputSchema: { type: "object", properties: { ticket: ticketProp }, required: ["ticket"], additionalProperties: false },
  },
  {
    name: "get_reading",
    description: "この入力の読み取り。原本ごとの文字、項目と行への当てはめ、読めなかった所。original_id と locator は出どころに使う。",
    inputSchema: { type: "object", properties: { ticket: ticketProp }, required: ["ticket"], additionalProperties: false },
  },
  {
    name: "write_change",
    description:
      "差分を一つ書く。kind は item（項目の中身）、row（表の行）、decision（決めたこと）、conflict（状態の中身との食い違い）、map_task（地図の仕事の済み、進み）、draft（文書の下書き）、map_draft（地図の下書き）。" +
      "item、row、decision、conflict、map_task は original_id と locator（get_reading にある物）が要る。実在しない出どころの差分は捨てられる。",
    inputSchema: {
      type: "object",
      properties: {
        ticket: ticketProp,
        kind: { type: "string", enum: ["item", "row", "decision", "conflict", "map_task", "draft", "map_draft"] },
        year: { type: "integer", description: "資料の年（get_reading の document_year）。資料に年が無ければ書かない" },
        original_id: { type: "string", description: "出どころの原本の ID（get_reading の original_id）" },
        locator: { type: "string", description: "元の箇所（get_reading の locator）" },
        target: { type: "string", description: "書く対象。項目の名前、表と相手、地図の仕事の名前、文書の種類など" },
        data: { type: "object", description: "種類ごとの中身（値、行のセル、文など）" },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
      },
      required: ["ticket", "kind", "target", "data", "confidence"],
      additionalProperties: false,
    },
  },
  {
    name: "write_question",
    description: "決められない物、食い違い、確かさが低い物を問いとして書く。",
    inputSchema: {
      type: "object",
      properties: {
        ticket: ticketProp,
        kind: { type: "string", enum: ["unreadable", "decide", "map_gap"], description: "unreadable は読めなかった所、decide は決めてほしい物、map_gap は地図に足りない物" },
        target: { type: "string", description: "何についての問いか（項目の名前、「表の名前:相手」など）" },
        text: { type: "string", description: "役員への問い（一文）" },
        original_id: { type: "string" },
        locator: { type: "string" },
        options: { type: "array", items: { type: "string" }, description: "選べる答えがあれば" },
      },
      required: ["ticket", "text"],
      additionalProperties: false,
    },
  },
] as const;

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

function asString(v: unknown, max = 4000): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function sourceExists(db: D1Database, job: JobRow, originalId: string): Promise<boolean> {
  return originalInProject(db, job.ward_id, job.project_id as string, originalId);
}

async function recordDiscard(db: D1Database, job: JobRow, reason: string): Promise<void> {
  const current = JSON.parse(job.discards || "[]") as string[];
  const next = [...current, reason].slice(-MAX_DISCARDS_KEPT);
  await db
    .prepare("UPDATE jobs SET discard_count = discard_count + 1, discards = ? WHERE ward_id = ? AND job_id = ?")
    .bind(JSON.stringify(next), job.ward_id, job.job_id)
    .run();
}

export async function callTool(env: Env, wardId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const job = await jobByTicket(env.DB, wardId, asString(args.ticket, 200));
  if (!job) return fail("札が使えません。札を最初のメッセージからそのまま書き写してください（完了した入力の札は使えません）。");
  if (!job.project_id) return fail("この入力はまだプロジェクトが決まっていません。");
  const api = projectApi();
  const ctx: WriteContext = {
    wardId,
    projectId: job.project_id,
    jobId: job.job_id,
    packVersion: PACK_VERSION,
    agentVersion: null,
  };

  switch (name) {
    case "list_open_projects":
      return ok(await api.listOpenProjects(env, wardId));
    case "get_project_state":
      return ok(await api.getProjectState(env, wardId, job.project_id));
    case "get_reading": {
      const readings = await getReadings(env.DB, wardId, job.job_id);
      return ok({ job_task: job.task, instruction: job.instruction, readings });
    }
    case "write_change": {
      const kind = asString(args.kind, 20) as ChangeKind;
      if (!["item", "row", "decision", "conflict", "map_task", "draft", "map_draft"].includes(kind)) return fail("kind が違います。");
      const confidence = (["high", "medium", "low"].includes(asString(args.confidence, 10)) ? args.confidence : "low") as Confidence;
      const needsSource = kind !== "draft" && kind !== "map_draft";
      const originalId = asString(args.original_id, 100);
      if (needsSource && !(await sourceExists(env.DB, job, originalId))) {
        await recordDiscard(env.DB, job, `出どころの原本が見つからない差分を捨てました（${kind}: ${asString(args.target, 60)}）`);
        return fail("出どころ（original_id）がこのプロジェクトに実在しないので、この差分は捨てました。get_reading にある original_id を使ってください。");
      }
      const result = await api.applyChange(env, ctx, {
        kind,
        originalId: originalId || null,
        locator: asString(args.locator, 200),
        year: Number.isInteger(args.year) ? (args.year as number) : null,
        target: asString(args.target, 200),
        data: args.data ?? {},
        confidence,
      });
      return ok(result);
    }
    case "write_question": {
      const text = asString(args.text, 1000).trim();
      if (!text) return fail("問いの文が空です。");
      const originalId = asString(args.original_id, 100);
      const options = Array.isArray(args.options) ? args.options.filter((o): o is string => typeof o === "string").slice(0, 8) : [];
      const questionKind = ["unreadable", "decide", "map_gap"].includes(asString(args.kind, 20))
        ? (args.kind as "unreadable" | "decide" | "map_gap")
        : "decide";
      const result = await api.addQuestion(env, ctx, {
        kind: questionKind,
        target: asString(args.target, 200),
        text,
        originalId: originalId && (await sourceExists(env.DB, job, originalId)) ? originalId : null,
        locator: asString(args.locator, 200),
        options,
      });
      return ok(result);
    }
    default:
      return fail(`${name} という手はありません。`);
  }
}

async function handleRpc(env: Env, wardId: string, msg: Rpc): Promise<object | null> {
  const id = msg.id ?? null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  // id の無い物は通知。返事は要らない
  if (msg.id === undefined) return null;
  switch (msg.method) {
    case "initialize": {
      const asked = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "";
      return reply({
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : (SUPPORTED_PROTOCOLS[0] as string),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "jichikai-sasae", version: "1" },
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = asString(msg.params?.name, 80);
      const args = (typeof msg.params?.arguments === "object" && msg.params.arguments !== null ? msg.params.arguments : {}) as Record<string, unknown>;
      try {
        return reply(await callTool(env, wardId, name, args));
      } catch (err) {
        console.error("MCP の手が失敗しました", name, err instanceof Error ? `${err.name}: ${err.message}` : "");
        return reply(fail("この手は今動きません。少し待って、もう一度呼んでください。"));
      }
    }
    default:
      return error(-32601, "対応していない method です");
  }
}

/** 区ごとの口の鍵。vault に入れた物の要約と合うか。 */
async function authorized(env: Env, wardId: string, header: string | undefined): Promise<boolean> {
  const token = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1];
  if (!token) return false;
  const row = await env.DB.prepare("SELECT mcp_token_hash FROM ward_ai WHERE ward_id = ?")
    .bind(wardId)
    .first<{ mcp_token_hash: string | null }>();
  return !!row?.mcp_token_hash && row.mcp_token_hash === (await sha256Hex(token));
}

export const mcpPub = new Hono<WardEnv>();

mcpPub.post("/mcp", async (c) => {
  const wardId = c.var.ward.wardId;
  if (!(await authorized(c.env, wardId, c.req.header("authorization")))) {
    return c.json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON ではありません" } }, 400);
  }
  const messages = (Array.isArray(body) ? body : [body]) as Rpc[];
  const replies = (await Promise.all(messages.map((m) => handleRpc(c.env, wardId, m)))).filter((r): r is object => r !== null);
  if (replies.length === 0) return c.body(null, 202);
  return c.json(Array.isArray(body) ? replies : replies[0]);
});

// サーバーから送る流れは持たない（状態を持たない）。
mcpPub.get("/mcp", (c) => c.body(null, 405, { allow: "POST" }));
mcpPub.delete("/mcp", (c) => c.body(null, 405, { allow: "POST" }));
