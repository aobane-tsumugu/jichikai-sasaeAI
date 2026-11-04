import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { adminPath } from "../core/auth";
import { Layout, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { getProjectState, getProjectSummary } from "../project/api";
import { addMapTask, removeMapTask, setMapTask } from "../project/actions";
import { SOURCE_KIND_LABEL } from "../project/model";
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
  const [project, state, seats] = await Promise.all([
    getProjectSummary(c.env.DB, ward.wardId, id), getProjectState(c.env.DB, ward.wardId, id),
    c.env.DB.prepare("SELECT seat_id, title AS name FROM seats WHERE ward_id = ? AND removed_at IS NULL ORDER BY sort_order, created_at").bind(ward.wardId).all<{ seat_id: string; name: string }>(),
  ]);
  if (!project || !state) return c.notFound();
  const tasks = state.mapTasks;
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const currentTasks = tasks.filter((t) => t.progress !== "done" && (!t.periodStart || t.periodStart <= today) && (!t.periodEnd || t.periodEnd >= today));
  const min = tasks.map((t) => t.periodStart).filter((x): x is string => !!x).sort()[0] ?? `${project.year}-01-01`;
  const max = tasks.map((t) => t.periodEnd).filter((x): x is string => !!x).sort().at(-1) ?? `${project.year}-12-31`;
  const start = Date.parse(`${min}T00:00:00Z`); const span = Math.max(1, Date.parse(`${max}T00:00:00Z`) - start);
  const positions = tasks.map((t, i) => ({ task: t, y: 38 + i * 58, x: (d: string | null) => d ? 120 + (Date.parse(`${d}T00:00:00Z`) - start) / span * 640 : 120 + i * 45 }));
  return c.html(<Layout title={`地図: ${project.title}`} siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")} headerRight={<a href={adminPath(ward, `/projects/${id}`)}>プロジェクトへ</a>}>
    <h1>{project.title} の地図</h1>
    <p>時期、仕事、担当を一枚で見られます。仕事を開くと、材料や案、答え、収支へ進めます。</p>
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
    <div style="overflow-x:auto"><svg viewBox={`0 0 800 ${Math.max(120, tasks.length * 58 + 24)}`} role="img" aria-label="プロジェクトの仕事の時期と進み具合" style="min-width:680px;width:100%;height:auto">
      <line x1="120" y1="18" x2="760" y2="18" stroke="currentColor" />
      <text x="120" y="14" font-size="13">{min}</text><text x="700" y="14" font-size="13">{max}</text>
      {positions.map(({ task, y, x }) => <g>
        <text x="8" y={y + 5} font-size="14">{task.name}</text>
        <line x1={x(task.periodStart)} y1={y} x2={Math.max(x(task.periodStart) + 12, x(task.periodEnd))} y2={y} stroke={task.progress === "done" ? "#287a43" : "#2b6d9a"} stroke-width="10" stroke-linecap="round" />
        <circle cx={x(task.periodStart)} cy={y} r="7" fill="currentColor" />
        <text x="120" y={y + 19} font-size="12">{task.progress === "done" ? "済み" : task.progress === "started" ? "進行中" : "これから"}{task.seatId ? ` / ${seats.results.find((s) => s.seat_id === task.seatId)?.name ?? "担当あり"}` : " / 担当未記入"}</text>
      </g>)}
    </svg></div>
    {tasks.map((task) => <section class="panel" id={`task-${task.taskId}`}><h2>{task.name}</h2><p>{task.periodStart ?? "時期未定"} から {task.periodEnd ?? "時期未定"}</p>
      <p>状態: {task.progress === "done" ? "済み" : task.progress === "started" ? "進行中" : "これから"} / {task.progressSource ? `出どころ: ${SOURCE_KIND_LABEL[task.progressSource.kind]}${task.progressSource.locator ? ` (${task.progressSource.locator})` : ""}` : "人の入力"}</p>
      <nav class="action-links">{opensOf(project.kind, task.taskKey).map((dest) => <a class="button secondary" href={adminPath(ward, targetPath[dest](id, task.taskId))}>{dest === "materials" ? "材料を送る" : dest === "draft" ? "案" : dest === "answers" ? "答え" : "収支"}</a>)}
        <a class="button secondary" href={adminPath(ward, `/publish/${id}`)}>配る</a>
        <a class="button secondary" href={adminPath(ward, `/space/${id}`)}>空間</a>
        <a class="button secondary" href={adminPath(ward, `/close/${id}`)}>報告と閉じる</a>
      </nav>
      <form method="post" action={adminPath(ward, `/projects/${id}/map/${task.taskId}`)}>
        <label for={`name-${task.taskId}`}>仕事</label><input id={`name-${task.taskId}`} name="name" value={task.name} maxlength={100} required />
        <label for={`start-${task.taskId}`}>始める日</label><input id={`start-${task.taskId}`} name="start" type="date" value={task.periodStart ?? ""} />
        <label for={`end-${task.taskId}`}>終わる日</label><input id={`end-${task.taskId}`} name="end" type="date" value={task.periodEnd ?? ""} />
        <label for={`progress-${task.taskId}`}>進み具合</label><select id={`progress-${task.taskId}`} name="progress"><option value="open" selected={task.progress === "open"}>これから</option><option value="started" selected={task.progress === "started"}>進行中</option><option value="done" selected={task.progress === "done"}>済み</option></select>
        <label for={`seat-${task.taskId}`}>担当する人</label><select id={`seat-${task.taskId}`} name="seat_id"><option value="">担当を選ぶ</option>{seats.results.map((seat) => <option value={seat.seat_id} selected={seat.seat_id === task.seatId}>{seat.name}</option>)}</select>
        <button class="secondary">保存</button>
      </form>
      <form method="post" action={adminPath(ward, `/projects/${id}/map/${task.taskId}/remove`)}><button class="danger">この仕事を地図から外す</button></form>
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
