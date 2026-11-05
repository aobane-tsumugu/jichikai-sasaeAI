import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { adminPath } from "../core/auth";
import { Layout, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { getProjectState, getProjectSummary } from "../project/api";
import { addMapTask, removeMapTask, setMapTask } from "../project/actions";
import { MAP_PROGRESS_LABEL, SOURCE_KIND_LABEL } from "../project/model";
import { opensOf, type MapOpens } from "./template";

const admin = new Hono<AdminEnv>();
const targetPath: Record<MapOpens, (projectId: string, taskId: string) => string> = {
  materials: (projectId) => `/projects/${projectId}#materials`,
  draft: (projectId) => `/projects/${projectId}/draft`,
  answers: (projectId) => `/answers?project=${encodeURIComponent(projectId)}`,
  ledger: (projectId) => `/projects/${projectId}#ledger`,
};

admin.get("/projects/:projectId/map", async (c) => {
  const { ward } = c.var; const id = c.req.param("projectId");
  const [project, state, seats, history, material] = await Promise.all([
    getProjectSummary(c.env.DB, ward.wardId, id), getProjectState(c.env.DB, ward.wardId, id),
    c.env.DB.prepare("SELECT seat_id, title AS name FROM seats WHERE ward_id = ? AND removed_at IS NULL ORDER BY sort_order, created_at").bind(ward.wardId).all<{ seat_id: string; name: string }>(),
    c.env.DB.prepare(`SELECT t.task_key, m.requested_by, m.difficulty, m.next_year
      FROM projects p JOIN projects seed ON seed.ward_id = p.ward_id AND seed.project_id = p.seed_project_id AND seed.closed_at IS NOT NULL
      JOIN project_map_tasks t ON t.ward_id = seed.ward_id AND t.project_id = seed.project_id
      JOIN project_close_map m ON m.ward_id = t.ward_id AND m.project_id = t.project_id AND m.task_id = t.task_id
      WHERE p.ward_id = ? AND p.project_id = ? AND t.task_key IS NOT NULL`)
      .bind(ward.wardId, id).all<{ task_key: string; requested_by: string; difficulty: string; next_year: string }>(),
    c.env.DB.prepare(`SELECT 1 AS found FROM jobs j JOIN originals o ON o.ward_id = j.ward_id AND o.job_id = j.job_id
      WHERE j.ward_id = ? AND j.project_id = ? AND o.withdrawn_at IS NULL LIMIT 1`)
      .bind(ward.wardId, id).first<{ found: number }>(),
  ]);
  if (!project || !state) return c.notFound();
  const tasks = state.mapTasks;
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const currentTasks = tasks.filter((t) => t.progress !== "done" && (!t.periodStart || t.periodStart <= today) && (!t.periodEnd || t.periodEnd >= today));
  const min = tasks.map((t) => t.periodStart).filter((x): x is string => !!x).sort()[0] ?? `${project.year}-01-01`;
  const max = tasks.map((t) => t.periodEnd).filter((x): x is string => !!x).sort().at(-1) ?? `${project.year}-12-31`;
  const start = Date.parse(`${min}T00:00:00Z`); const span = Math.max(1, Date.parse(`${max}T00:00:00Z`) - start);
  // 広い画面は名前の右に帯、狭い画面（スマホ）は名前の下に帯を置く。狭い画面で帯が右に切れて見えなくなるため。
  const layouts = [
    { className: "map-wide", width: 720, gutter: 270, barWidth: 440, rowHeight: 62, barOffset: 0 },
    { className: "map-narrow", width: 360, gutter: 10, barWidth: 340, rowHeight: 78, barOffset: 40 },
  ] as const;
  const dayX = (layout: (typeof layouts)[number], d: string) => layout.gutter + (Date.parse(`${d}T00:00:00Z`) - start) / span * layout.barWidth;
  const monthDay = (d: string) => `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;
  return c.html(<Layout title={`地図: ${project.title}`} siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")} headerRight={<a href={adminPath(ward, `/projects/${id}`)}>プロジェクトへ</a>}>
    <h1>{project.title} の地図</h1>
    <p>時期、仕事、担当を一枚で見られます。仕事を開くと、材料や案、答え、収支へ進めます。</p>
    {!material ? <p>去年の案内や記録の紙、Word や Excel を、見つかった物から送ってください。全部そろえなくてかまいません。</p> : null}
    <nav class="action-links">
      <a class="button secondary" href={adminPath(ward, `/intake?project=${encodeURIComponent(id)}`)}>材料を送る</a>
      <a class="button secondary" href={adminPath(ward, `/projects/${id}/draft`)}>案を直す</a>
      <a class="button secondary" href={adminPath(ward, `/answers/${encodeURIComponent(id)}`)}>答えを見る</a>
      <a class="button secondary" href={adminPath(ward, `/projects/${id}#ledger`)}>収支を見る</a>
      <a class="button" href={adminPath(ward, `/publish/${id}`)}>配る</a>
      <a class="button secondary" href={adminPath(ward, `/space/${id}`)}>空間</a>
      <a class="button secondary" href={adminPath(ward, `/close/${id}`)}>報告と閉じる</a>
    </nav>
    {c.req.query("error") ? <Notice error>{c.req.query("error")}</Notice> : null}
    <h2>今の時期に開いている仕事</h2>
    {currentTasks.length ? currentTasks.map((task) => <p><a href={`#task-${task.taskId}`}>{task.name}</a></p>) : <p>今の時期に開いている仕事はありません。</p>}
    <style>{".map-narrow{display:none}@media (max-width:40rem){.map-wide{display:none}.map-narrow{display:block}}"}</style>
    {layouts.map((layout) => {
      const top = layout.barOffset ? 64 : 56;
      const height = Math.max(120, tasks.length * layout.rowHeight + top);
      const todayX = today >= min && today <= max ? dayX(layout, today) : null;
      return <div class={layout.className}><svg viewBox={`0 0 ${layout.width} ${height}`} role="img" aria-label="プロジェクトの仕事の時期と進み具合" style="width:100%;height:auto">
        <line x1={layout.gutter} y1="24" x2={layout.gutter + layout.barWidth} y2="24" stroke="currentColor" />
        <text x={layout.gutter} y="16" font-size="16">{monthDay(min)}</text><text x={layout.gutter + layout.barWidth} y="16" font-size="16" text-anchor="end">{monthDay(max)}</text>
        {todayX === null ? null : <g><line x1={todayX} y1="24" x2={todayX} y2={height - 20} stroke="#b3452c" stroke-dasharray="4 4" /><text x={todayX} y={height - 4} font-size="16" text-anchor="middle" fill="#b3452c">今日</text></g>}
        {tasks.map((task, i) => {
          const y = top + i * layout.rowHeight;
          const x = (d: string | null) => d ? dayX(layout, d) : layout.gutter + i * 45;
          return <a href={`#task-${task.taskId}`}>
            <text x={layout.barOffset ? layout.gutter : 0} y={y} font-size="17" font-weight="500">{task.name}</text>
            <text x={layout.barOffset ? layout.gutter : 0} y={y + 22} font-size="15" opacity="0.75">{MAP_PROGRESS_LABEL[task.progress]}{task.seatId ? ` / ${seats.results.find((s) => s.seat_id === task.seatId)?.name ?? "担当あり"}` : ""}</text>
            <line x1={x(task.periodStart)} y1={y + layout.barOffset} x2={Math.max(x(task.periodStart) + 12, x(task.periodEnd))} y2={y + layout.barOffset} stroke={task.progress === "done" ? "#287a43" : task.progress === "started" ? "#2b6d9a" : "#9db4c4"} stroke-width="14" stroke-linecap="round" />
          </a>;
        })}
      </svg></div>;
    })}
    {tasks.map((task) => <section class="panel" id={`task-${task.taskId}`}><h2>{task.name}</h2><p>{task.periodStart ?? "時期未定"} から {task.periodEnd ?? "時期未定"}</p>
      <p>状態: {MAP_PROGRESS_LABEL[task.progress]} / {task.progressSource ? `出どころ: ${SOURCE_KIND_LABEL[task.progressSource.kind]}${task.progressSource.locator ? ` (${task.progressSource.locator})` : ""}` : "人の入力"}</p>
      {history.results.filter((row) => row.task_key === task.taskKey && [row.requested_by, row.difficulty, row.next_year].some((value) => value.trim())).map((row) => <div>
        <h3>去年の記録</h3>
        {row.requested_by.trim() ? <p>頼んだ人: {row.requested_by}</p> : null}
        {row.difficulty.trim() ? <p>困ったこと: {row.difficulty}</p> : null}
        {row.next_year.trim() ? <p>来年変えること: {row.next_year}</p> : null}
      </div>)}
      <nav class="action-links">{opensOf(project.kind, task.taskKey).map((dest) => <a class="button secondary" href={adminPath(ward, targetPath[dest](id, task.taskId))}>{dest === "materials" ? "材料を送る" : dest === "draft" ? "案" : dest === "answers" ? "答え" : "収支"}</a>)}
        <a class="button secondary" href={adminPath(ward, `/publish/${id}`)}>配る</a>
        <a class="button secondary" href={adminPath(ward, `/space/${id}`)}>空間</a>
        <a class="button secondary" href={adminPath(ward, `/close/${id}`)}>報告と閉じる</a>
      </nav>
      <details><summary>時期や担当を直す</summary><form method="post" action={adminPath(ward, `/projects/${id}/map/${task.taskId}`)}>
        <label for={`name-${task.taskId}`}>仕事</label><input id={`name-${task.taskId}`} name="name" value={task.name} maxlength={100} required />
        <label for={`start-${task.taskId}`}>始める日</label><input id={`start-${task.taskId}`} name="start" type="date" value={task.periodStart ?? ""} />
        <label for={`end-${task.taskId}`}>終わる日</label><input id={`end-${task.taskId}`} name="end" type="date" value={task.periodEnd ?? ""} />
        <label for={`progress-${task.taskId}`}>進み具合</label><select id={`progress-${task.taskId}`} name="progress"><option value="open" selected={task.progress === "open"}>これから</option><option value="started" selected={task.progress === "started"}>進行中</option><option value="done" selected={task.progress === "done"}>済み</option></select>
        <label for={`seat-${task.taskId}`}>担当する人</label><select id={`seat-${task.taskId}`} name="seat_id"><option value="">担当を選ぶ</option>{seats.results.map((seat) => <option value={seat.seat_id} selected={seat.seat_id === task.seatId}>{seat.name}</option>)}</select>
        <button class="secondary">保存</button>
      </form>
      <form method="post" action={adminPath(ward, `/projects/${id}/map/${task.taskId}/remove`)}><button class="danger">この仕事を地図から外す</button></form></details>
    </section>)}
    <h2>仕事を足す</h2><form method="post" action={adminPath(ward, `/projects/${id}/map/add`)}>
      <label for="new-task">仕事の名前</label><input id="new-task" name="name" maxlength={100} required /><button>足す</button>
    </form>
    <h2>地図から開く場所</h2><p><a href={adminPath(ward, `/projects/${id}`)}>材料、問い、今年の中身</a> / <a href={adminPath(ward, `/projects/${id}/check`)}>公開の下書きを確かめる</a></p>
  </Layout>);
});

admin.post("/projects/:projectId/map/add", async (c) => { const { ward } = c.var; const f = await c.req.formData(); const ok = await addMapTask(c.env.DB, ward.wardId, c.req.param("projectId"), String(f.get("name") ?? "")); return c.redirect(`${adminPath(ward, `/projects/${c.req.param("projectId")}/map`)}${ok ? "" : "?error=入力を確認してください"}`, 303); });
admin.post("/projects/:projectId/map/:taskId", async (c) => { const { ward } = c.var; const f = await c.req.formData(); const progress = String(f.get("progress")); const ok = ["open", "started", "done"].includes(progress) && await setMapTask(c.env.DB, ward.wardId, c.req.param("projectId"), c.req.param("taskId"), { name: String(f.get("name") ?? ""), start: String(f.get("start") ?? ""), end: String(f.get("end") ?? ""), progress: progress as "open" | "started" | "done", seatId: String(f.get("seat_id") ?? "") || null }); return c.redirect(`${adminPath(ward, `/projects/${c.req.param("projectId")}/map`)}${ok ? "" : "?error=入力を確認してください"}`, 303); });
admin.post("/projects/:projectId/map/:taskId/remove", async (c) => { const { ward } = c.var; await removeMapTask(c.env.DB, ward.wardId, c.req.param("projectId"), c.req.param("taskId")); return c.redirect(adminPath(ward, `/projects/${c.req.param("projectId")}/map`), 303); });

export { admin as mapAdmin };
export const map: Bundle = { admin };
