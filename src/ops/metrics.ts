// 提供側の費用と処理状況。すべて区を指定して読む。

export interface MonthlyMetrics {
  month: string;
  inputs: number;
  readRuns: number;
  connectRuns: number;
  readTokens: number;
  connectTokens: number;
  readEstimateCents: number;
  actualRunCostCents: number;
  durationMs: number;
  failed: number;
  attention: number;
}

export interface WardMetrics {
  wardId: string;
  name: string;
  slug: string;
  monthlyLimitCents: number;
  lineSenderDailyLimit: number;
  months: MonthlyMetrics[];
}

interface InputRow {
  month: string;
  inputs: number;
}

interface RunRow {
  month: string;
  kind: "read" | "connect";
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  list_cost_cents: number;
  duration_ms: number;
}

interface StatusRow {
  month: string;
  status: "failed" | "attention";
  count: number;
}

interface LimitRow {
  monthly_limit_cents: number;
  line_sender_daily_limit: number;
}

/** 日本での暦月。資料を受けた月と、AIを動かした月は分ける。 */
export function aiLimitMonth(now = new Date()): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 7);
}

/** job_runsに残らない当て先の確認。本文や送信元は記録せず、既存の読み取り単価で概算する。 */
export async function recordAiMatchUsage(db: D1Database, wardId: string, usage: { input_tokens: number; output_tokens: number }): Promise<void> {
  await db.prepare(`INSERT INTO ops_monthly_ai_usage (ward_id, month, input_tokens, output_tokens) VALUES (?, ?, ?, ?)
    ON CONFLICT (ward_id, month) DO UPDATE SET input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens`)
    .bind(wardId, aiLimitMonth(), usage.input_tokens, usage.output_tokens).run();
}

export async function getWardAiLimits(db: D1Database, wardId: string, now = new Date()) {
  const limit = await db.prepare("SELECT monthly_limit_cents, line_sender_daily_limit FROM ops_ward_limits WHERE ward_id = ?")
    .bind(wardId).first<LimitRow>();
  const cost = await db.prepare(`SELECT COALESCE(SUM(CASE WHEN kind = 'read'
    THEN (input_tokens * 2.0 + output_tokens * 10.0 + cache_read_tokens * 0.1) / 10000.0
    ELSE list_cost_cents END), 0) AS cents FROM job_runs
    WHERE ward_id = ? AND substr(datetime(started_at, '+9 hours'), 1, 7) = ?`)
    .bind(wardId, aiLimitMonth(now)).first<{ cents: number }>();
  const monthlyLimitCents = limit?.monthly_limit_cents ?? 0;
  const matching = await db.prepare("SELECT input_tokens, output_tokens FROM ops_monthly_ai_usage WHERE ward_id = ? AND month = ?")
    .bind(wardId, aiLimitMonth(now)).first<{ input_tokens: number; output_tokens: number }>();
  const costCents = (cost?.cents ?? 0) + ((matching?.input_tokens ?? 0) * 2 + (matching?.output_tokens ?? 0) * 10) / 10_000;
  return { monthlyLimitCents, lineSenderDailyLimit: limit?.line_sender_daily_limit ?? 0,
    costCents, monthlyBlocked: monthlyLimitCents > 0 && costCents >= monthlyLimitCents };
}

/** 開始前にだけ判定する。待っている間は試行回数を増やさない。 */
export async function canStartJobAi(db: D1Database, wardId: string, jobId: string): Promise<boolean> {
  const job = await db.prepare("SELECT ai_limit_reason FROM jobs WHERE ward_id = ? AND job_id = ? AND withdrawn_at IS NULL")
    .bind(wardId, jobId).first<{ ai_limit_reason: string }>();
  if (!job || job.ai_limit_reason === "sender") return false;
  const limits = await getWardAiLimits(db, wardId);
  await db.prepare(`UPDATE jobs SET ai_limit_reason = ?, status = CASE
    WHEN ? = 1 AND status = 'read' THEN 'received'
    WHEN ? = 0 AND ai_limit_reason = 'monthly' AND status = 'received' AND read_at IS NOT NULL THEN 'read'
    ELSE status END WHERE ward_id = ? AND job_id = ? AND ai_limit_reason <> 'sender'`)
    .bind(limits.monthlyBlocked ? "monthly" : "", limits.monthlyBlocked ? 1 : 0, limits.monthlyBlocked ? 1 : 0, wardId, jobId).run();
  return !limits.monthlyBlocked;
}

export async function wardLimitWaiting(db: D1Database, wardId: string): Promise<{ monthly: number; sender: number }> {
  const row = await db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN ai_limit_reason = 'monthly' THEN 1 ELSE 0 END), 0) AS monthly,
    COALESCE(SUM(CASE WHEN ai_limit_reason = 'sender' THEN 1 ELSE 0 END), 0) AS sender
    FROM jobs WHERE ward_id = ? AND withdrawn_at IS NULL AND status IN ('received', 'reading', 'read')`)
    .bind(wardId).first<{ monthly: number; sender: number }>();
  return row ?? { monthly: 0, sender: 0 };
}

// Anthropic Claude Sonnet 5.5 の標準 API 単価（USD/百万 token）。
// 入力 $2、出力 $10、cache read $0.10 をセントに換算して概算する。
function estimateReadCostCents(inputTokens: number, outputTokens: number, cacheReadTokens: number): number {
  return (inputTokens * 2 + outputTokens * 10 + cacheReadTokens * 0.1) / 10_000;
}

export async function getWardMetrics(db: D1Database, ward: { wardId: string; slug: string; name: string }): Promise<WardMetrics> {
  const [inputs, runs, statuses, limit, matching] = await Promise.all([
    db.prepare(
      `SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS inputs
         FROM jobs WHERE ward_id = ? AND task = 'connect' GROUP BY substr(created_at, 1, 7) ORDER BY month DESC`,
    ).bind(ward.wardId).all<InputRow>(),
    db.prepare(
      `SELECT substr(datetime(r.started_at, '+9 hours'), 1, 7) AS month, r.kind, COUNT(*) AS runs,
              SUM(r.input_tokens) AS input_tokens, SUM(r.output_tokens) AS output_tokens,
              SUM(r.cache_read_tokens) AS cache_read_tokens, SUM(r.list_cost_cents) AS list_cost_cents,
              SUM(r.duration_ms) AS duration_ms
         FROM job_runs r JOIN jobs j ON j.ward_id = r.ward_id AND j.job_id = r.job_id
        WHERE j.ward_id = ? GROUP BY substr(datetime(r.started_at, '+9 hours'), 1, 7), r.kind ORDER BY month DESC`,
    ).bind(ward.wardId).all<RunRow>(),
    db.prepare(
      `SELECT substr(COALESCE(finished_at, updated_at), 1, 7) AS month, status, COUNT(*) AS count
         FROM jobs WHERE ward_id = ? AND status IN ('failed', 'attention')
         GROUP BY substr(COALESCE(finished_at, updated_at), 1, 7), status ORDER BY month DESC`,
    ).bind(ward.wardId).all<StatusRow>(),
    db.prepare("SELECT monthly_limit_cents, line_sender_daily_limit FROM ops_ward_limits WHERE ward_id = ?")
      .bind(ward.wardId).first<LimitRow>(),
    db.prepare("SELECT month, input_tokens, output_tokens FROM ops_monthly_ai_usage WHERE ward_id = ?")
      .bind(ward.wardId).all<{ month: string; input_tokens: number; output_tokens: number }>(),
  ]);

  const byMonth = new Map<string, MonthlyMetrics>();
  const month = (key: string): MonthlyMetrics => {
    let value = byMonth.get(key);
    if (!value) {
      value = {
        month: key, inputs: 0, readRuns: 0, connectRuns: 0,
        readTokens: 0, connectTokens: 0, readEstimateCents: 0,
        actualRunCostCents: 0, durationMs: 0, failed: 0, attention: 0,
      };
      byMonth.set(key, value);
    }
    return value;
  };

  for (const row of inputs.results) month(row.month).inputs = row.inputs;
  for (const row of runs.results) {
    const target = month(row.month);
    const tokens = row.input_tokens + row.output_tokens + row.cache_read_tokens;
    if (row.kind === "connect") target.actualRunCostCents += row.list_cost_cents;
    if (row.kind === "read") {
      target.readRuns = row.runs;
      target.readTokens = tokens;
      target.readEstimateCents = estimateReadCostCents(row.input_tokens, row.output_tokens, row.cache_read_tokens);
    } else {
      target.connectRuns = row.runs;
      target.connectTokens = tokens;
    }
    target.durationMs += row.duration_ms;
  }
  for (const row of statuses.results) month(row.month)[row.status] = row.count;
  for (const row of matching.results) {
    const target = month(row.month);
    target.readTokens += row.input_tokens + row.output_tokens;
    target.readEstimateCents += (row.input_tokens * 2 + row.output_tokens * 10) / 10_000;
  }

  return {
    ...ward,
    monthlyLimitCents: limit?.monthly_limit_cents ?? 0,
    lineSenderDailyLimit: limit?.line_sender_daily_limit ?? 0,
    months: [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month)),
  };
}

export interface QueueJob {
  jobId: string;
  filename: string;
  createdAt: string;
  status: "received" | "reading" | "read" | "connecting" | "attention" | "failed";
  failure: string;
  projectId: string | null;
  via: string;
  task: string;
}

export async function listWardQueue(db: D1Database, wardId: string): Promise<QueueJob[]> {
  const rows = await db.prepare(
    `SELECT j.job_id, j.created_at, j.status, j.failure, j.project_id, j.via, j.task,
       (SELECT o.filename FROM originals o WHERE o.ward_id = j.ward_id AND o.job_id = j.job_id AND o.withdrawn_at IS NULL ORDER BY o.position LIMIT 1) AS filename
       FROM jobs j WHERE j.ward_id = ? AND status IN ('received', 'reading', 'read', 'connecting', 'attention', 'failed')
       ORDER BY CASE status WHEN 'attention' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END, created_at DESC`,
  ).bind(wardId).all<{
    job_id: string;
    filename: string | null;
    created_at: string;
    status: QueueJob["status"];
    failure: string;
    project_id: string | null;
    via: string;
    task: string;
  }>();
  return rows.results.map((row) => ({
    jobId: row.job_id,
    filename: row.filename ?? "",
    createdAt: row.created_at,
    status: row.status,
    failure: row.failure,
    projectId: row.project_id,
    via: row.via,
    task: row.task,
  }));
}
