import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { adminPath } from "../core/auth";
import { Layout, Notice } from "../core/ui";
import { nowIso } from "../core/ids";
import type { AdminEnv } from "../env";
import type { Waitable } from "../intake/types";
import { startTask } from "../ai/api";
import { getProjectSummary } from "../project/api";
import { saveDocument } from "../project/actions";
import { MAP_PROGRESS_LABEL, type MapProgress } from "../project/model";

interface CloseTask { task_id: string; name: string; period_start: string | null; period_end: string | null; progress: MapProgress; }
interface CloseEntry extends CloseTask { period: string; requested_by: string; difficulty: string; next_year: string; }
const admin = new Hono<AdminEnv>();

/** Hono のテスト用 request には ExecutionContext が無い場合がある。 */
function waitableContext(context: { executionCtx: Waitable }): Waitable {
  try {
    return context.executionCtx;
  } catch {
    return { waitUntil: (promise) => void promise };
  }
}

async function prepareDrafts(db: D1Database, wardId: string, projectId: string, accountId: string) {
  const project = await getProjectSummary(db, wardId, projectId);
  if (!project || project.closedAt) return false;
  const tasks = await db.prepare("SELECT task_id, name, period_start, period_end, progress FROM project_map_tasks WHERE ward_id = ? AND project_id = ? AND removed_at IS NULL ORDER BY sort_order")
    .bind(wardId, projectId).all<CloseTask>();
  const now = nowIso();
  const stmts = (tasks.results ?? []).map((task) => db.prepare(`INSERT OR IGNORE INTO project_close_map
    (ward_id, project_id, task_id, period, name, progress, requested_by, difficulty, next_year, updated_at, updated_by_account_id)
    VALUES (?, ?, ?, ?, ?, ?, '', '', '', ?, ?)`)
    .bind(wardId, projectId, task.task_id, [task.period_start, task.period_end].filter(Boolean).join(" 〜 "), task.name, task.progress, now, accountId));
  for (const scope of ["public", "staff"] as const) stmts.push(db.prepare(`INSERT OR IGNORE INTO project_close_reports (ward_id, project_id, scope, body, updated_at, updated_by_account_id) VALUES (?, ?, ?, '', ?, ?)`)
    .bind(wardId, projectId, scope, now, accountId));
  if (stmts.length) await db.batch(stmts);
  return true;
}

admin.get("/close/:projectId", async (c) => {
  const { ward } = c.var; const id = c.req.param("projectId");
  const project = await getProjectSummary(c.env.DB, ward.wardId, id);
  if (!project) return c.notFound();
  if (!project.closedAt && !(await prepareDrafts(c.env.DB, ward.wardId, id, c.var.account.accountId))) return c.notFound();
  const [tasks, reports, status, generatedReport] = await Promise.all([
    c.env.DB.prepare("SELECT task_id, name, period, progress, requested_by, difficulty, next_year FROM project_close_map WHERE ward_id = ? AND project_id = ?")
      .bind(ward.wardId, id).all<CloseEntry>(),
    c.env.DB.prepare("SELECT scope, body FROM project_close_reports WHERE ward_id = ? AND project_id = ? ORDER BY scope")
      .bind(ward.wardId, id).all<{ scope: "public" | "staff"; body: string }>(),
    c.env.DB.prepare("SELECT task, status FROM jobs WHERE ward_id = ? AND project_id = ? AND task IN ('report', 'map_draft') ORDER BY created_at DESC LIMIT 2")
      .bind(ward.wardId, id).all<{ task: string; status: string }>(),
    c.env.DB.prepare(`SELECT v.body FROM documents d JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
      WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = 'report' AND d.scope = 'public' AND v.scope = 'public'
      ORDER BY v.version_no DESC LIMIT 1`).bind(ward.wardId, id).first<{ body: string }>(),
  ]);
  let generatedText = "";
  if (generatedReport?.body) {
    try {
      const parsed = JSON.parse(generatedReport.body) as { text?: unknown };
      if (typeof parsed.text === "string") generatedText = parsed.text;
    } catch { generatedText = ""; }
  }
  const report = (scope: "public" | "staff") => reports.results?.find((r) => r.scope === scope)?.body || (scope === "public" ? generatedText : "");
  const root = adminPath(ward, `/close/${id}`);
  return c.html(<Layout title={`報告と閉じる: ${project.title}`} siteName={ward.name} noindex>
    <h1>{project.title} の報告と閉じる</h1>
    {project.closedAt ? <Notice>このプロジェクトは凍結しています。読むことはできます。</Notice> : <form method="post" action={`${root}/prepare`}><button class="secondary">報告と地図の下書きを起こす</button></form>}
    {status.results?.map((job) => <p>{job.task === "report" ? "報告" : "地図"}: {job.status === "done" ? "できました" : job.status === "failed" ? "止まりました" : "準備中"}</p>)}
    <h2>報告の下書き</h2>
    {(["public", "staff"] as const).map((scope) => <form class="panel" method="post" action={`${root}/report/${scope}`}>
      <h3>{scope === "public" ? "公開する部分" : "役員だけの部分"}</h3>
      <label for={`report-${scope}`}>報告</label><textarea id={`report-${scope}`} name="body" rows={7} maxlength={12000} style="width:100%;font:inherit" disabled={!!project.closedAt}>{report(scope)}</textarea>
      {!project.closedAt ? <p><button>保存</button></p> : null}
    </form>)}
    <h2>地図の下書き</h2>
    {tasks.results?.length ? <svg viewBox={`0 0 640 ${Math.max(110, tasks.results.length * 78 + 20)}`} role="img" aria-label="仕事の時期と進み具合">
      {tasks.results.map((task, i) => <a href={`#task-${task.task_id}`}><g><rect x="8" y={8 + i * 78} width="624" height="66" rx="8" fill="var(--panel)" stroke="var(--line)"/><text x="24" y={35 + i * 78} fill="var(--fg)" font-size="18">{task.period || "時期未設定"}　{task.name}</text><text x="24" y={60 + i * 78} fill="var(--muted)" font-size="15">{MAP_PROGRESS_LABEL[task.progress]}　編集する</text></g></a>)}
    </svg> : <p>地図に仕事はありません。</p>}
    {tasks.results?.map((task) => <form class="panel" id={`task-${task.task_id}`} method="post" action={`${root}/map/${task.task_id}`}>
      <h3>{task.name}</h3>
      <label for={`period-${task.task_id}`}>仕事の時期</label><input id={`period-${task.task_id}`} name="period" type="text" value={task.period} maxlength={80} disabled={!!project.closedAt} />
      <label for={`name-${task.task_id}`}>仕事の名前</label><input id={`name-${task.task_id}`} name="name" type="text" value={task.name} maxlength={120} required disabled={!!project.closedAt} />
      <label for={`progress-${task.task_id}`}>進み具合</label><select id={`progress-${task.task_id}`} name="progress" disabled={!!project.closedAt}>{(["open", "started", "done"] as const).map((value) => <option value={value} selected={task.progress === value}>{MAP_PROGRESS_LABEL[value]}</option>)}</select>
      <label for={`requested-${task.task_id}`}>頼んだ人</label><input id={`requested-${task.task_id}`} name="requestedBy" value={task.requested_by} maxlength={160} disabled={!!project.closedAt} />
      <label for={`difficulty-${task.task_id}`}>困ったこと</label><textarea id={`difficulty-${task.task_id}`} name="difficulty" rows={2} maxlength={1200} disabled={!!project.closedAt} style="width:100%;font:inherit">{task.difficulty}</textarea>
      <label for={`next-${task.task_id}`}>来年変えること</label><textarea id={`next-${task.task_id}`} name="nextYear" rows={2} maxlength={1200} disabled={!!project.closedAt} style="width:100%;font:inherit">{task.next_year}</textarea>
      {!project.closedAt ? <p><button>この仕事を保存</button></p> : null}
    </form>)}
    {!project.closedAt ? <form method="post" action={`${root}/finalize`}><p><button class="danger">閉じて記録に残す</button></p></form> : null}
    <p><a href={adminPath(ward, "/archive")}>記録を開く</a></p>
  </Layout>);
});

admin.post("/close/:projectId/prepare", async (c) => {
  const { ward, account } = c.var; const id = c.req.param("projectId");
  if (!(await prepareDrafts(c.env.DB, ward.wardId, id, account.accountId))) return c.notFound();
  try {
    await Promise.all([
      startTask(c.env, waitableContext(c), { wardId: ward.wardId, projectId: id, task: "report", accountId: account.accountId,
        instruction: "報告の下書きを起こす。公開する部分と役員だけの部分を分け、状態に無い事実は作らない。公開部分は人数や出来事のうち確認できる内容だけにする。配る操作はしない。文書: report。" }),
      startTask(c.env, waitableContext(c), { wardId: ward.wardId, projectId: id, task: "map_draft", accountId: account.accountId,
        instruction: "閉じる時の地図の下書きを状態から作る。原本は読まない。地図の仕事ごとに、状態の taskId を task_id として、period、name、progress（open/started/done）、requested_by、difficulty、next_year をまとめる。write_change で kind=map_draft、target=map、data={tasks:[...] } を一度書く。" }),
    ]);
  } catch (error) { console.error("閉じる下書きを起こせませんでした", error instanceof Error ? error.name : ""); }
  return c.redirect(adminPath(ward, `/close/${id}`), 303);
});

admin.post("/close/:projectId/report/:scope", async (c) => {
  const { ward, account } = c.var; const id = c.req.param("projectId"); const scope = c.req.param("scope");
  if (scope !== "public" && scope !== "staff") return c.notFound();
  const body = String((await c.req.formData()).get("body") ?? "").trim().slice(0, 12000);
  const now = nowIso();
  if (scope === "public") {
    const project = await getProjectSummary(c.env.DB, ward.wardId, id);
    if (!project || project.closedAt) return c.notFound();
    const saved = await saveDocument(c.env.DB, ward.wardId, id, account.accountId, {
      kind: "report", title: "実施報告", scope: "public", body: JSON.stringify({ text: body, items: [] }), basedOn: project.stateVersion,
    });
    if (!saved) return c.redirect(adminPath(ward, `/close/${id}`), 303);
  }
  await c.env.DB.prepare(`UPDATE project_close_reports SET body = ?, updated_at = ?, updated_by_account_id = ?
    WHERE ward_id = ? AND project_id = ? AND scope = ? AND EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL)`)
    .bind(body, now, account.accountId, ward.wardId, id, scope, ward.wardId, id).run();
  return c.redirect(adminPath(ward, `/close/${id}`), 303);
});

admin.post("/close/:projectId/map/:taskId", async (c) => {
  const { ward, account } = c.var; const id = c.req.param("projectId"); const taskId = c.req.param("taskId"); const f = await c.req.formData();
  const name = String(f.get("name") ?? "").trim().slice(0, 120); const progress = String(f.get("progress"));
  if (!name || !(["open", "started", "done"] as string[]).includes(progress)) return c.redirect(adminPath(ward, `/close/${id}`), 303);
  await c.env.DB.prepare(`UPDATE project_close_map SET period = ?, name = ?, progress = ?, requested_by = ?, difficulty = ?, next_year = ?, updated_at = ?, updated_by_account_id = ?
    WHERE ward_id = ? AND project_id = ? AND task_id = ? AND EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL)`)
    .bind(String(f.get("period") ?? "").trim().slice(0, 80), name, progress, String(f.get("requestedBy") ?? "").trim().slice(0, 160),
      String(f.get("difficulty") ?? "").trim().slice(0, 1200), String(f.get("nextYear") ?? "").trim().slice(0, 1200), nowIso(), account.accountId,
      ward.wardId, id, taskId, ward.wardId, id).run();
  return c.redirect(adminPath(ward, `/close/${id}#task-${taskId}`), 303);
});

admin.post("/close/:projectId/finalize", async (c) => {
  const { ward, account } = c.var; const id = c.req.param("projectId"); const now = nowIso();
  await c.env.DB.prepare("UPDATE projects SET closed_at = ?, closed_by_account_id = ? WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL")
    .bind(now, account.accountId, ward.wardId, id).run();
  return c.redirect(adminPath(ward, `/close/${id}`), 303);
});

export { admin as closeAdmin };
export const close: Bundle = { admin };
