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
}

// Anthropic Claude Sonnet 5.5 の標準 API 単価（USD/百万 token）。
// 入力 $2、出力 $10、cache read $0.10 をセントに換算して概算する。
function estimateReadCostCents(inputTokens: number, outputTokens: number, cacheReadTokens: number): number {
  return Math.round((inputTokens * 2 + outputTokens * 10 + cacheReadTokens * 0.1) / 10_000);
}

export async function getWardMetrics(db: D1Database, ward: { wardId: string; slug: string; name: string }): Promise<WardMetrics> {
  const [inputs, runs, statuses, limit] = await Promise.all([
    db.prepare(
      `SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS inputs
         FROM jobs WHERE ward_id = ? AND task = 'connect' GROUP BY substr(created_at, 1, 7) ORDER BY month DESC`,
    ).bind(ward.wardId).all<InputRow>(),
    db.prepare(
      `SELECT substr(j.created_at, 1, 7) AS month, r.kind, COUNT(*) AS runs,
              SUM(r.input_tokens) AS input_tokens, SUM(r.output_tokens) AS output_tokens,
              SUM(r.cache_read_tokens) AS cache_read_tokens, SUM(r.list_cost_cents) AS list_cost_cents,
              SUM(r.duration_ms) AS duration_ms
         FROM job_runs r JOIN jobs j ON j.ward_id = r.ward_id AND j.job_id = r.job_id
        WHERE j.ward_id = ? GROUP BY substr(j.created_at, 1, 7), r.kind ORDER BY month DESC`,
    ).bind(ward.wardId).all<RunRow>(),
    db.prepare(
      `SELECT substr(COALESCE(finished_at, updated_at), 1, 7) AS month, status, COUNT(*) AS count
         FROM jobs WHERE ward_id = ? AND status IN ('failed', 'attention')
         GROUP BY substr(COALESCE(finished_at, updated_at), 1, 7), status ORDER BY month DESC`,
    ).bind(ward.wardId).all<StatusRow>(),
    db.prepare("SELECT monthly_limit_cents FROM ops_ward_limits WHERE ward_id = ?")
      .bind(ward.wardId).first<LimitRow>(),
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
    target.actualRunCostCents += row.list_cost_cents;
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

  return {
    ...ward,
    monthlyLimitCents: limit?.monthly_limit_cents ?? 0,
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
