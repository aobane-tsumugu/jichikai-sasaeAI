// Managed Agents: 区ごとの agent、vault、MCP の口の鍵、提供側で一つの environment を整え、入力ごとにセッションを開く。
// プロジェクトの中は一つずつ（同じプロジェクトで繋げているのが無い時だけ、次を開く）。
// agent に渡す手は MCP の五つだけで、read、bash などは付けない（agent_toolset を渡さない）。原本は渡さない。
import { nowIso } from "../core/ids";
import type { Env } from "../env";
import { sha256Hex } from "../intake/media";
import { projectDirectory } from "../intake/project-port";
import { startRun, getJob } from "../intake/store";
import type { JobRow } from "../intake/types";
import { base64urlEncode } from "./anthropic";
import { MODEL } from "./anthropic";
import { getClient } from "./deps";
import { firstMessage, MCP_SERVER_NAME, PACK_SYSTEM, PACK_VERSION } from "./pack";

/** environment の名前。提供側で一つ。最初の区が名前で探して作り、他の区は同じ物を見つける。 */
export const ENVIRONMENT_NAME = "jichikai-sasae";
/** セッション一つの予算（セント）。根拠のある数は実測の後に置く（設計書 5.9）。それまでの仮の歯止め。 */
export const SESSION_BUDGET_CENTS = 10_000;
/** 繋げるの試行の上限。超えたら failed（役員が「もう一度」を押せる）。 */
export const CONNECT_MAX_ATTEMPTS = 3;
const SETUP_LEASE_MS = 120_000;

export class AiSetupBusy extends Error {
  constructor() {
    super("この区の agent を別の処理が作っています");
    this.name = "AiSetupBusy";
  }
}

export interface WardAiRow {
  ward_id: string;
  environment_id: string | null;
  vault_id: string | null;
  credential_id: string | null;
  mcp_token_hash: string | null;
  agent_id: string | null;
  agent_version: number | null;
  pack_version: string | null;
}

export interface ReadyWardAi extends WardAiRow {
  environment_id: string;
  vault_id: string;
  agent_id: string;
  agent_version: number;
}

export function mcpUrl(env: Pick<Env, "PUBLIC_BASE_URL">, slug: string): string {
  const base = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  if (!base) throw new Error("PUBLIC_BASE_URL が空です（MCP の口の URL を作れません）");
  return `${base}/${slug}/mcp`;
}

function randomToken(bytes = 32): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function loadWardAi(db: D1Database, wardId: string): Promise<WardAiRow> {
  return (await db.prepare("SELECT * FROM ward_ai WHERE ward_id = ?").bind(wardId).first<WardAiRow>()) as WardAiRow;
}

async function saveWardAi(db: D1Database, wardId: string, fields: Partial<WardAiRow>): Promise<void> {
  const keys = Object.keys(fields) as Array<keyof WardAiRow>;
  if (keys.length === 0) return;
  await db
    .prepare(`UPDATE ward_ai SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE ward_id = ?`)
    .bind(...keys.map((k) => fields[k] ?? null), nowIso(), wardId)
    .run();
}

function isReady(row: WardAiRow): row is ReadyWardAi {
  return !!(row.environment_id && row.vault_id && row.agent_id && row.agent_version);
}

/**
 * 区の agent 一式を整える。作った物から順に ID を D1 に入れるので、途中で止まっても続きから作れる。
 * 同時に二つが作らないよう貸し出しを使い、取れなければ AiSetupBusy（呼び出し側は後で試す）。
 */
export async function ensureWardAi(env: Env, ward: { wardId: string; slug: string }): Promise<ReadyWardAi> {
  const db = env.DB;
  const now = nowIso();
  await db
    .prepare("INSERT OR IGNORE INTO ward_ai (ward_id, created_at, updated_at) VALUES (?, ?, ?)")
    .bind(ward.wardId, now, now)
    .run();
  let row = await loadWardAi(db, ward.wardId);
  const client = getClient(env);

  if (isReady(row)) {
    // 包みを直していれば、agent を更新して新しい版にする（走っているセッションには届かない）
    if (row.pack_version !== PACK_VERSION) {
      const updated = await client.beta.agents.update(row.agent_id, { version: row.agent_version, system: PACK_SYSTEM });
      await saveWardAi(db, ward.wardId, { agent_version: updated.version, pack_version: PACK_VERSION });
      row = await loadWardAi(db, ward.wardId);
    }
    return row as ReadyWardAi;
  }

  const lease = new Date(Date.now() + SETUP_LEASE_MS).toISOString();
  const claimed = await db
    .prepare(
      `UPDATE ward_ai SET setup_lease = ?, updated_at = ?
        WHERE ward_id = ? AND (setup_lease IS NULL OR setup_lease < ?)`,
    )
    .bind(lease, now, ward.wardId, now)
    .run();
  if ((claimed.meta.changes ?? 0) === 0) throw new AiSetupBusy();

  try {
    row = await loadWardAi(db, ward.wardId);
    if (!row.environment_id) {
      let found: string | null = null;
      for await (const environment of client.beta.environments.list()) {
        if (environment.name === ENVIRONMENT_NAME && !environment.archived_at) {
          found = environment.id;
          break;
        }
      }
      const id =
        found ??
        (
          await client.beta.environments.create({
            name: ENVIRONMENT_NAME,
            config: {
              type: "cloud",
              networking: { type: "limited", allow_package_managers: false, allow_mcp_servers: true },
            },
          })
        ).id;
      await saveWardAi(db, ward.wardId, { environment_id: id });
      row.environment_id = id;
    }
    if (!row.vault_id) {
      const vault = await client.beta.vaults.create({ display_name: `jichikai ${ward.slug}` });
      await saveWardAi(db, ward.wardId, { vault_id: vault.id });
      row.vault_id = vault.id;
    }
    if (!row.credential_id) {
      const token = randomToken();
      const credential = await client.beta.vaults.credentials.create(row.vault_id as string, {
        display_name: `MCP ${ward.slug}`,
        auth: { type: "static_bearer", mcp_server_url: mcpUrl(env, ward.slug), token },
      });
      await saveWardAi(db, ward.wardId, { credential_id: credential.id, mcp_token_hash: await sha256Hex(token) });
      row.credential_id = credential.id;
    }
    if (!row.agent_id) {
      const agent = await client.beta.agents.create({
        name: `jichikai-${ward.slug}`,
        model: { id: MODEL.main, effort: "medium" },
        system: PACK_SYSTEM,
        mcp_servers: [{ type: "url", name: MCP_SERVER_NAME, url: mcpUrl(env, ward.slug) }],
        // 手は MCP の五つだけ。permission_policy の既定は always_ask なので always_allow を明示する
        tools: [
          {
            type: "mcp_toolset",
            mcp_server_name: MCP_SERVER_NAME,
            default_config: { permission_policy: { type: "always_allow" } },
          },
        ],
      });
      await saveWardAi(db, ward.wardId, {
        agent_id: agent.id,
        agent_version: agent.version,
        pack_version: PACK_VERSION,
      });
    }
  } finally {
    await db.prepare("UPDATE ward_ai SET setup_lease = NULL WHERE ward_id = ?").bind(ward.wardId).run();
  }
  return (await loadWardAi(db, ward.wardId)) as ReadyWardAi;
}

/** 札（推測できない乱数）。要約だけを D1 に置き、平文はセッションの最初のメッセージにだけ入れる。 */
export function newTicket(): string {
  return `tk_${randomToken(24)}`;
}

export type DispatchResult = "started" | "busy" | "empty" | "retry" | "failed";

/**
 * そのプロジェクトで、読み終わった一番古い入力を一つ、繋げる。同じプロジェクトで繋げている物があれば何もしない
 * （前の入力の完了の後に次を送る。二枚の写真が近い時刻に入っても、同じ状態に対して直列に繋がる）。
 * 予約は D1 の一つの UPDATE で取るので、競り合っても一つしか開かない。
 */
export async function dispatchProject(env: Env, wardId: string, projectId: string): Promise<DispatchResult> {
  // 実在しない、閉じたプロジェクトには繋げない。入った物は読み終わりのまま待つ（付け替えられる）
  if (!(await projectDirectory().isOpen(env.DB, wardId, projectId))) return "empty";
  const ticket = newTicket();
  const hash = await sha256Hex(ticket);
  const now = nowIso();
  const claimed = await env.DB.prepare(
    `UPDATE jobs SET status = 'connecting', ticket_hash = ?, connect_started_at = ?, connect_attempt = connect_attempt + 1, updated_at = ?
      WHERE ward_id = ?
        AND job_id = (SELECT job_id FROM jobs WHERE ward_id = ? AND project_id = ? AND status = 'read' ORDER BY created_at LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM jobs WHERE ward_id = ? AND project_id = ? AND status = 'connecting')`,
  )
    .bind(hash, now, now, wardId, wardId, projectId, wardId, projectId)
    .run();
  if ((claimed.meta.changes ?? 0) === 0) {
    const busy = await env.DB.prepare(
      "SELECT 1 AS x FROM jobs WHERE ward_id = ? AND project_id = ? AND status = 'connecting' LIMIT 1",
    )
      .bind(wardId, projectId)
      .first();
    return busy ? "busy" : "empty";
  }
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE ticket_hash = ?").bind(hash).first<JobRow>();
  if (!job) return "failed";
  try {
    await openSession(env, job, ticket);
    return "started";
  } catch (err) {
    console.error("セッションを開けませんでした", wardId, job.job_id, err instanceof Error ? `${err.name}: ${err.message}` : "不明な失敗");
    // 試行の上限までは read に戻して、Cron が後で開き直す。上限を超えたら failed（役員が「もう一度」を押せる）
    const exhausted = job.connect_attempt >= CONNECT_MAX_ATTEMPTS;
    await env.DB.prepare(
      `UPDATE jobs SET status = ?, failure = ?, ticket_hash = NULL, finished_at = ?, updated_at = ?
        WHERE ward_id = ? AND job_id = ? AND status = 'connecting' AND session_id IS NULL`,
    )
      .bind(exhausted ? "failed" : "read", exhausted ? "connect" : "", exhausted ? nowIso() : null, nowIso(), wardId, job.job_id)
      .run();
    return exhausted ? "failed" : "retry";
  }
}

/** 予約した入力のセッションを開く。最初のメッセージに札を入れて渡し、原本は渡さない。 */
async function openSession(env: Env, job: JobRow, ticket: string): Promise<string> {
  const ward = await env.DB.prepare("SELECT ward_id, slug FROM wards WHERE ward_id = ?")
    .bind(job.ward_id)
    .first<{ ward_id: string; slug: string }>();
  if (!ward) throw new Error("区が見つかりません");
  const budget = await env.DB.prepare("SELECT session_budget_cents FROM ops_ward_limits WHERE ward_id = ?")
    .bind(job.ward_id)
    .first<{ session_budget_cents: number }>();
  const ai = await ensureWardAi(env, { wardId: ward.ward_id, slug: ward.slug });
  const client = getClient(env);
  const session = await client.beta.sessions.create({
    agent: { type: "agent", id: ai.agent_id, version: ai.agent_version },
    environment_id: ai.environment_id,
    vault_ids: [ai.vault_id],
    title: `入力 ${job.job_id.slice(0, 8)}`,
    metadata: { ward_id: job.ward_id, job_id: job.job_id, task: job.task },
    budget: { type: "limit", max_list_cost: { amount: String((budget?.session_budget_cents ?? SESSION_BUDGET_CENTS) / 100), currency: "USD" } },
    initial_events: [
      { type: "user.message", content: [{ type: "text", text: firstMessage({ ticket, task: job.task, instruction: job.instruction }) }] },
    ],
  });
  await env.DB.prepare("UPDATE jobs SET session_id = ? WHERE ward_id = ? AND job_id = ? AND status = 'connecting'")
    .bind(session.id, job.ward_id, job.job_id)
    .run();
  await startRun(env.DB, {
    wardId: job.ward_id,
    jobId: job.job_id,
    kind: "connect",
    attempt: job.connect_attempt,
    model: MODEL.main,
    sessionId: session.id,
  });
  return session.id;
}

/** 札から入力を割り出す。繋げている入力の札だけが通る（完了したら札は失効する）。 */
export async function jobByTicket(db: D1Database, wardId: string, ticket: string): Promise<JobRow | null> {
  if (!ticket.startsWith("tk_") || ticket.length > 200) return null;
  return db
    .prepare("SELECT * FROM jobs WHERE ward_id = ? AND ticket_hash = ? AND status = 'connecting'")
    .bind(wardId, await sha256Hex(ticket))
    .first<JobRow>();
}

