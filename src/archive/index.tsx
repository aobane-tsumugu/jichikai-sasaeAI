import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { adminPath } from "../core/auth";
import { newId, nowIso } from "../core/ids";
import { Layout } from "../core/ui";
import type { AdminEnv } from "../env";
import { createProject, getProjectSummary, listProjects, ProjectInputError } from "../project/api";
import { PROJECT_KIND_LABEL, type ProjectKind } from "../project/model";
import { addDays } from "../map/template";

interface SeedTask { task_key: string | null; name: string; period_start: string | null; period_end: string | null; offset_start_days: number | null; offset_end_days: number | null; sort_order: number; }
const admin = new Hono<AdminEnv>();
const DATE = /^\d{4}-\d{2}-\d{2}$/;

admin.get("/archive", async (c) => {
  const { ward } = c.var;
  const projects = (await listProjects(c.env.DB, ward.wardId, { includeClosed: true })).filter((project) => project.closedAt);
  const byMonth = new Map<string, typeof projects>();
  for (const project of projects) {
    const month = project.closedAt?.slice(0, 7) ?? "日付不明";
    byMonth.set(month, [...(byMonth.get(month) ?? []), project]);
  }
  return c.html(<Layout title="記録" siteName={ward.name} noindex headerRight={<a href={adminPath(ward, "/projects")}>プロジェクト一覧</a>}>
    <h1>記録</h1>
    {[...byMonth.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([month, entries]) => <section><h2>{month}</h2>{entries.map((p) => <article class="panel">
      <h3><a href={adminPath(ward, `/archive/${p.projectId}`)}>{p.title}</a></h3><p>{p.year}年 / {PROJECT_KIND_LABEL[p.kind]}</p>
      <p><a href={adminPath(ward, `/archive/${p.projectId}`)}>地図と報告を開く</a></p>
    </article>)}</section>)}
    {projects.length === 0 ? <p>閉じたプロジェクトはまだありません。</p> : null}
  </Layout>);
});

admin.get("/archive/:projectId", async (c) => {
  const { ward } = c.var; const id = c.req.param("projectId");
  const project = await getProjectSummary(c.env.DB, ward.wardId, id);
  if (!project?.closedAt) return c.notFound();
  const [reports, map, originals] = await Promise.all([
    c.env.DB.prepare("SELECT scope, body FROM project_close_reports WHERE ward_id = ? AND project_id = ? ORDER BY scope").bind(ward.wardId, id).all<{ scope: string; body: string }>(),
    c.env.DB.prepare("SELECT task_id, name, period, progress, requested_by, difficulty, next_year FROM project_close_map WHERE ward_id = ? AND project_id = ?").bind(ward.wardId, id).all<{ task_id: string; name: string; period: string; progress: string; requested_by: string; difficulty: string; next_year: string }>(),
    c.env.DB.prepare(`SELECT o.original_id, o.filename, o.kind FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id
      WHERE o.ward_id = ? AND j.project_id = ? AND o.withdrawn_at IS NULL ORDER BY o.received_at`).bind(ward.wardId, id).all<{ original_id: string; filename: string; kind: string }>(),
  ]);
  return c.html(<Layout title={`記録: ${project.title}`} siteName={ward.name} noindex>
    <h1>{project.title}</h1><p>{project.year}年に閉じたプロジェクト</p>
    <h2>地図</h2>{map.results?.map((task) => <section class="panel"><h3>{task.name}</h3><p>{task.period} / {task.progress === "done" ? "済み" : task.progress === "started" ? "進行中" : "これから"}</p>
      {task.requested_by ? <p>頼んだ人: {task.requested_by}</p> : null}{task.difficulty ? <p>困ったこと: {task.difficulty}</p> : null}{task.next_year ? <p>来年変えること: {task.next_year}</p> : null}</section>)}
    <h2>報告</h2>{reports.results?.map((report) => <section class="panel"><h3>{report.scope === "public" ? "公開する部分" : "役員だけの部分"}</h3><p style="white-space:pre-wrap">{report.body || "まだ記入されていません"}</p></section>)}
    <h2>原本へ戻る</h2>{originals.results?.map((o) => <p><a href={adminPath(ward, `/intake/originals/${o.original_id}`)}>{o.filename || "一行の文"}（{o.kind}）</a></p>)}
    {originals.results?.length === 0 ? <p>原本はありません。</p> : null}
    <h2>来年の種</h2><p>去年の地図と状態を参考に、新しい年のプロジェクトを開きます。仕事を全部点検する必要はありません。</p>
    <form method="post" action={adminPath(ward, `/archive/${id}/seed`)}>
      <label for="title">新しいプロジェクトの題</label><input id="title" name="title" type="text" value={project.title} maxlength={100} required />
      <label for="year">年</label><input id="year" name="year" type="number" value={project.year + 1} min="1900" max="2200" required />
      <label for="eventDay">行事の日</label><input id="eventDay" name="eventDay" type="text" inputmode="numeric" placeholder="YYYY-MM-DD" required={project.kind === "event"} />
      <p><button>この地図を種に開く</button></p>
    </form>
    <p><a href={adminPath(ward, "/archive")}>記録の一覧へ</a></p>
  </Layout>);
});

admin.post("/archive/:projectId/seed", async (c) => {
  const { ward, account } = c.var; const sourceId = c.req.param("projectId"); const form = await c.req.formData();
  const source = await getProjectSummary(c.env.DB, ward.wardId, sourceId);
  if (!source?.closedAt) return c.notFound();
  const eventDay = String(form.get("eventDay") ?? "").trim();
  const year = Number(form.get("year"));
  if ((eventDay && !DATE.test(eventDay)) || (source.kind === "event" && !eventDay)) return c.redirect(adminPath(ward, `/archive/${sourceId}`), 303);
  try {
    const next = await createProject(c.env.DB, ward.wardId, {
      kind: source.kind, title: String(form.get("title") ?? source.title), year,
      ...(eventDay ? { eventDay } : {}), seedProjectId: sourceId, accountId: account.accountId,
    });
    await copySeed(c.env.DB, ward.wardId, sourceId, next.projectId, source.year, eventDay || null);
    return c.redirect(adminPath(ward, `/projects/${next.projectId}/map`), 303);
  } catch (error) {
    if (!(error instanceof ProjectInputError)) console.error("去年の地図から開けませんでした", error instanceof Error ? error.name : "");
    return c.redirect(adminPath(ward, `/archive/${sourceId}`), 303);
  }
});

export async function copySeed(db: D1Database, wardId: string, sourceId: string, targetId: string, sourceYear: number, eventDay: string | null) {
  const [tasks, oldDeadline] = await Promise.all([
    db.prepare(`SELECT t.task_id, t.task_key, t.name, t.period_start, t.period_end, t.offset_start_days, t.offset_end_days, t.sort_order,
      m.name AS saved_name FROM project_map_tasks t LEFT JOIN project_close_map m ON m.ward_id = t.ward_id AND m.project_id = t.project_id AND m.task_id = t.task_id
      WHERE t.ward_id = ? AND t.project_id = ? AND t.removed_at IS NULL ORDER BY t.sort_order`).bind(wardId, sourceId).all<SeedTask & { saved_name: string | null }>(),
    db.prepare("SELECT due_on FROM project_deadlines WHERE ward_id = ? AND project_id = ? AND kind = 'event_day'").bind(wardId, sourceId).first<{ due_on: string }>(),
  ]);
  const now = nowIso();
  const removeTemplates = db.prepare("DELETE FROM project_map_tasks WHERE ward_id = ? AND project_id = ?").bind(wardId, targetId);
  const addTasks = (tasks.results ?? []).map((task) => {
    const startOffset = task.offset_start_days ?? (task.period_start && oldDeadline ? Math.round((Date.parse(`${task.period_start}T00:00:00Z`) - Date.parse(`${oldDeadline.due_on}T00:00:00Z`)) / 86400000) : null);
    const endOffset = task.offset_end_days ?? (task.period_end && oldDeadline ? Math.round((Date.parse(`${task.period_end}T00:00:00Z`) - Date.parse(`${oldDeadline.due_on}T00:00:00Z`)) / 86400000) : null);
    return db.prepare(`INSERT INTO project_map_tasks (task_id, ward_id, project_id, task_key, name, period_start, period_end, offset_start_days, offset_end_days, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(newId(), wardId, targetId, task.task_key, task.saved_name ?? task.name,
        eventDay && startOffset !== null ? addDays(eventDay, startOffset) : null,
        eventDay && endOffset !== null ? addDays(eventDay, endOffset) : null,
        startOffset, endOffset, task.sort_order, now);
  });
  const copyItems = db.prepare(`INSERT INTO project_item_values (value_id, ward_id, project_id, item_key, scope, ref_year, content, source_kind, source_ref, source_locator, source_year, confidence, created_at)
    SELECT lower(hex(randomblob(16))), ward_id, ?, item_key, 'reference', ?, content, source_kind, source_ref, source_locator, source_year, confidence, ?
    FROM project_item_values WHERE ward_id = ? AND project_id = ? AND scope = 'current' AND superseded_at IS NULL`).bind(targetId, sourceYear, now, wardId, sourceId);
  const copyRows = db.prepare(`INSERT INTO project_rows (row_id, ward_id, project_id, table_key, scope, ref_year, match_key, data, person_fields, source_kind, source_ref, source_locator, source_year, confidence, created_at, updated_at)
    SELECT lower(hex(randomblob(16))), ward_id, ?, table_key, 'reference', ?, match_key, data, person_fields, source_kind, source_ref, source_locator, source_year, confidence, ?, ?
    FROM project_rows WHERE ward_id = ? AND project_id = ? AND scope = 'current' AND removed_at IS NULL`).bind(targetId, sourceYear, now, now, wardId, sourceId);
  await db.batch([removeTemplates, ...addTasks, copyItems, copyRows]);
}

export { admin as archiveAdmin };
export const archive: Bundle = { admin };
