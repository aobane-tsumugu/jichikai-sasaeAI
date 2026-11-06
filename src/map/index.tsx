import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { adminPath } from "../core/auth";
import { ErrorNotice, Layout, Notice } from "../core/ui";
import { formatJstDate } from "../core/time";
import type { AdminEnv } from "../env";
import { getProjectState } from "../project/api";
import { addMapTask, removeMapTask, restoreMapTask, setEventDay, setMapTask } from "../project/actions";
import { MAP_PROGRESS_LABEL, type DocumentKind } from "../project/model";
import { nextMapTask, mapCalendar } from "./next";
import { opensOf, type MapOpens } from "./template";

const ERROR_MESSAGES = { invalid_input: "入力を確認してください" };
const admin = new Hono<AdminEnv>();
const shortDate = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
export function taskDraftKind(taskKey: string | null): DocumentKind {
  return taskKey === "duty_roster" ? "duty_roster" : taskKey === "report" ? "report" : taskKey === "minutes" ? "procedure" : "announcement";
}
const targetPath: Record<MapOpens, (id: string, taskKey: string | null) => string> = {
  materials: (id) => `/intake?project=${encodeURIComponent(id)}#send-form`,
  draft: (id, key) => `/projects/${id}/draft/${taskDraftKind(key)}`,
  answers: (id) => `/answers/${encodeURIComponent(id)}`,
  ledger: (id) => `/projects/${id}/ledger`,
};

admin.get("/projects/:projectId/map", async (c) => {
  const { ward } = c.var; const id = c.req.param("projectId");
  const [state, seats, removed, materials] = await Promise.all([
    getProjectState(c.env.DB, ward.wardId, id),
    c.env.DB.prepare("SELECT seat_id, title FROM seats WHERE ward_id = ? AND removed_at IS NULL ORDER BY sort_order, created_at").bind(ward.wardId).all<{ seat_id: string; title: string }>(),
    c.env.DB.prepare("SELECT task_id, name FROM project_map_tasks WHERE ward_id = ? AND project_id = ? AND removed_at IS NOT NULL ORDER BY sort_order").bind(ward.wardId, id).all<{ task_id: string; name: string }>(),
    c.env.DB.prepare(`SELECT o.original_id, o.filename, o.received_at AS created_at, j.status FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id
      WHERE o.ward_id = ? AND j.project_id = ? AND o.withdrawn_at IS NULL ORDER BY o.received_at DESC`).bind(ward.wardId, id).all<{ original_id: string; filename: string; created_at: string; status: string }>(),
  ]);
  if (!state) return c.notFound();
  const { project, mapTasks: tasks, questions } = state;
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const first = !tasks.some((task) => task.progress !== "open") && !state.documents.some((document) => document.publishedVersionNo !== null);
  const calendar = mapCalendar(tasks, project.year);
  const next = nextMapTask(tasks, today);
  const taskUrl = (task: (typeof tasks)[number]) => task.taskKey === "answers" ? targetPath.answers(id, task.taskKey) : task.taskKey === "report" ? `/close/${id}` : `/projects/${id}/map/${task.taskId}`;
  const day = project.deadlines.event_day;
  const daysLeft = day ? Math.ceil((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000) : null;
  const readCount = materials.results.filter((material) => material.status === "done").length;
  const canRain = state.documents.some((document) => document.kind === "announcement" && document.publishedVersionNo !== null);
  const notice = c.req.query("notice");
  return c.html(<Layout title={`${project.title}の段取り`} siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <div class="map-page">
      <h1>{project.title}の段取り</h1>
      <p class="lead">{first ? materials.results.length ? `${readCount}件の資料を読んで、${tasks.length}つの仕事の段取りを用意しました。違うところは、仕事を押して直せます。` : `ふつうの${tasks.length}つの仕事の段取りを用意しました。違うところは、仕事を押して直せます。` : `${day && daysLeft !== null && daysLeft >= 0 ? `${formatJstDate(day)}まで、あと${daysLeft}日です。` : ""}仕事を押すと開きます。`}</p>
      <ErrorNotice code={c.req.query("error")} messages={ERROR_MESSAGES} />
      {notice === "event_day" ? <Notice><p>行事の日を変えました。済んでいない仕事の時期を置き直しました。案内の文は変わりません。</p><p>段取りの仕事を押して、時期を確かめてください。戻すときは、下の「行事の日を直す」からもう一度入れ直せます。</p><a class="quiet" href="#event-day">行事の日を直す</a></Notice> : null}
      {notice === "removed" ? <Notice>仕事を外しました。下の「外した仕事」から戻せます。</Notice> : notice === "restored" ? <Notice>仕事を戻しました。仕事を押すと直せます。</Notice> : notice === "added" ? <Notice>仕事を足しました。仕事を押すと直せます。</Notice> : null}
      {project.closedAt ? <Notice>この行事は閉じました。直すときは「報告と閉じる」から「開き直す」を押してください。</Notice> : <>
        <section class="next"><strong>次は</strong>
          <p>{first && questions.length ? `質問が${questions.length}つあります。答えると、案内の下書きが整います。答えなくても進められます。` : next ? next.periodEnd ? `${shortDate(next.periodEnd)}までの仕事です。` : "時期はあとから直せます。" : "段取りの仕事は全部済みました。"}</p>
          <a class="button" href={adminPath(ward, first && questions.length ? `/projects/${id}/questions` : next ? taskUrl(next) : `/close/${id}`)}>{first && questions.length ? "質問に答える" : next?.name ?? "報告を書いて閉じる"}</a>
          {tasks.some((task) => task.taskId === c.req.query("changed") && task.taskKey === "announcement" && task.progress === "done") ? <a class="quiet" href={adminPath(ward, `/print/${id}`)}>案内の紙を印刷する</a> : null}
        </section>
        <div class="action-links">
          <a class="button secondary" href={adminPath(ward, `/intake?project=${encodeURIComponent(id)}#send-form`)}>資料を送る</a>
        </div>
      </>}
      <div class="split"><section>
        {tasks.length ? <div class="map" style={`--today: ${calendar.position(today)}`}>
          <div class="map-months"><span style={`grid-template-columns:${calendar.months.map((month) => `${month.days}fr`).join(" ")}`}>{calendar.months.map((month) => <i>{month.label}</i>)}</span></div>
          <ol class="map-list">{tasks.map((task) => {
            const current = task.progress !== "done" && (!task.periodStart || task.periodStart <= today) && (!task.periodEnd || task.periodEnd >= today);
            const just = task.taskId === c.req.query("changed") && task.progress === "done";
            const owner = seats.results.find((seat) => seat.seat_id === task.seatId)?.title;
            return <li><a class={`map-row${task.progress === "done" ? " done" : current ? " now" : ""}${just ? " just" : ""}`} href={adminPath(ward, taskUrl(task))}>
              <span class="map-name"><b>{task.name}</b><small>{task.progress === "done" ? "済み" : task.periodStart && task.periodStart === task.periodEnd ? formatJstDate(task.periodStart) : current ? task.periodEnd ? `${shortDate(task.periodEnd)}まで` : MAP_PROGRESS_LABEL[task.progress] : task.periodStart ? `${shortDate(task.periodStart)}から${task.periodEnd ? shortDate(task.periodEnd) : ""}` : "時期はまだ決まっていません"}{owner ? `　${owner}` : ""}</small>{just ? <small class="map-just">いま済みにしました</small> : null}</span>
              <span class="map-track">{task.periodStart || task.periodEnd ? <i style={`--from:${calendar.position(task.periodStart ?? task.periodEnd ?? calendar.first) * 100}%;--to:${calendar.position(task.periodEnd ?? task.periodStart ?? calendar.last) * 100}%`} /> : null}</span>
            </a></li>;
          })}</ol>
          {today >= calendar.first && today <= calendar.last ? <div class="map-today"><span>今日</span></div> : null}
        </div> : <p>仕事はまだありません。下の「仕事を足す、外した仕事を戻す」から足せます。</p>}
      </section><aside>
        <ul class="rows"><li><a class="row-link" href={adminPath(ward, `/projects/${id}/questions`)}><b>{questions.length ? `質問が${questions.length}つあります` : "質問はありません"}</b><span>答えなくても配れます。</span></a></li></ul>
        <h2>最近届いた資料</h2>
        {materials.results.length ? <ul class="rows">{materials.results.slice(0, 3).map((material) => <li><a class="row-link" href={adminPath(ward, `/intake/originals/${material.original_id}`)}><b>{material.filename || "一行の文"}</b><span>{tasks.filter((task) => task.progressSource?.kind === "original" && task.progressSource.ref === material.original_id).map((task) => `「${task.name}」を${task.progress === "done" ? "済み" : "進行中"}にしました`).join("。") || (material.status === "done" ? "読み終わりました。届いた資料で中身を見られます" : material.status === "failed" ? "読めませんでした。届いた資料から読み直せます" : "読み取りを進めています")}</span></a></li>)}</ul> : <p>資料はまだ届いていません。</p>}
        {!project.closedAt ? <details class="fold" id="event-day" open={c.req.query("error") === "invalid_input"}><summary>行事の日を直す</summary><div><form method="post" action={adminPath(ward, `/projects/${id}/map/event-day`)}>
          <div class="field"><label for="event-day-input">行事の日</label><input id="event-day-input" name="event_day" type="date" value={day ?? ""} required /></div>
          <p>済んでいない仕事の時期も動きます。案内の文は変わりません。もう一度入れ直せば戻せます。</p><button class="secondary">行事の日を保存する</button>
        </form></div></details> : null}
        {!project.closedAt ? <details class="fold"><summary>仕事を足す、外した仕事を戻す</summary><div>
          <form method="post" action={adminPath(ward, `/projects/${id}/map/add`)}><div class="field"><label for="new-task">足す仕事の名前</label><input id="new-task" name="name" maxlength={100} required /></div><button class="secondary">足す</button></form>
          {removed.results.length ? <><p><b>外した仕事</b></p>{removed.results.map((task) => <form method="post" action={adminPath(ward, `/projects/${id}/map/${task.task_id}/restore`)}><p>{task.name}</p><button class="secondary">この仕事を戻す</button></form>)}</> : null}
        </div></details> : null}
        <p><a class="quiet" href={adminPath(ward, `/projects/${id}`)}>届いた資料と今年の中身</a></p>
        <p><a class="quiet" href={adminPath(ward, `/print/${id}`)}>紙を印刷する</a></p>
        <p><a class="quiet" href={adminPath(ward, `/answers/${id}`)}>答えを見る</a></p>
        <p><a class="quiet" href={adminPath(ward, `/space/${id}`)}>実行委員と班長のページ</a></p>
        {canRain && !project.closedAt ? <p><a class="quiet" href={adminPath(ward, `/projects/${id}/draft/notice`)}>雨の変更を知らせる</a></p> : null}
        <p><a class="quiet" href={adminPath(ward, `/projects/${id}/ledger`)}>運営メモ</a></p>
        <p><a class="quiet" href={adminPath(ward, `/close/${id}`)}>報告を書いて閉じる</a></p>
      </aside></div>
    </div>
  </Layout>);
});

admin.get("/projects/:projectId/map/:taskId", async (c) => {
  const { ward } = c.var; const id = c.req.param("projectId");
  const [state, seats, history] = await Promise.all([
    getProjectState(c.env.DB, ward.wardId, id),
    c.env.DB.prepare("SELECT seat_id, title FROM seats WHERE ward_id = ? AND removed_at IS NULL ORDER BY sort_order, created_at").bind(ward.wardId).all<{ seat_id: string; title: string }>(),
    c.env.DB.prepare(`SELECT COALESCE(t.task_key, t.task_id) AS task_key, m.requested_by, m.difficulty, m.next_year
      FROM projects p JOIN projects seed ON seed.ward_id = p.ward_id AND seed.project_id = p.seed_project_id AND seed.closed_at IS NOT NULL
      JOIN project_map_tasks t ON t.ward_id = seed.ward_id AND t.project_id = seed.project_id
      JOIN project_close_map m ON m.ward_id = t.ward_id AND m.project_id = t.project_id AND m.task_id = t.task_id
      WHERE p.ward_id = ? AND p.project_id = ?`).bind(ward.wardId, id).all<{ task_key: string; requested_by: string; difficulty: string; next_year: string }>(),
  ]);
  const task = state?.mapTasks.find((entry) => entry.taskId === c.req.param("taskId"));
  if (!state || !task) return c.notFound();
  const { project } = state;
  const owner = seats.results.find((seat) => seat.seat_id === task.seatId)?.title;
  const destinations = opensOf(project.kind, task.taskKey);
  const draft = state.documents.find((document) => document.kind === taskDraftKind(task.taskKey));
  const labels: Record<MapOpens, string> = { materials: "資料を送る", draft: `${task.taskKey === "duty_roster" ? "当番表" : task.taskKey === "report" ? "報告" : "案内"}の下書きを直す`, answers: "答えを見る", ledger: "運営メモを見る" };
  return c.html(<Layout title={task.name} siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, `/projects/${id}/map`)}>← {project.title}の段取りへ</a>
    <h1>{task.name}</h1><p class="lead">{task.periodEnd ? `${formatJstDate(task.periodEnd)}まで。` : "時期はまだ決まっていません。"}{owner ? `担当は${owner}です。` : "担当はあとから直せます。"}</p>
    <ErrorNotice code={c.req.query("error")} messages={ERROR_MESSAGES} />
    {c.req.query("notice") === "saved" ? <section class="next"><strong>直した内容を保存しました</strong><p>段取りに入りました。時期や担当はあとから直せます。</p><a class="button" href={adminPath(ward, `/projects/${id}/map`)}>段取りへ</a></section> : null}
    {draft && destinations[0] === "draft" ? <div class="notice" role="status"><strong>下書きができています</strong><p>{state.questions.length ? `質問が${state.questions.length}つ残っていますが、このまま配れます。` : "直して保存しても、まだ配られません。"}</p></div> : null}
    <div class="action-links">{destinations.map((destination, index) => <a class={index ? "button secondary" : "button"} href={adminPath(ward, targetPath[destination](id, task.taskKey))}>{labels[destination]}</a>)}</div>
    <h2>この仕事に届いた資料</h2><p><a class="quiet" href={adminPath(ward, `/projects/${id}#materials`)}>この行事に届いた資料を見る</a></p>
    {history.results.filter((entry) => entry.task_key === task.taskKey && [entry.requested_by, entry.difficulty, entry.next_year].some((value) => value.trim())).map((entry) => <><h2>去年の記録</h2><dl class="facts">
      {entry.requested_by ? <><dt>頼んだ人</dt><dd>{entry.requested_by}</dd></> : null}{entry.difficulty ? <><dt>困ったこと</dt><dd>{entry.difficulty}</dd></> : null}{entry.next_year ? <><dt>来年は</dt><dd>{entry.next_year}</dd></> : null}
    </dl></>)}
    {!project.closedAt ? <>
      <details class="fold"><summary>時期や担当を直す</summary><div><form method="post" action={adminPath(ward, `/projects/${id}/map/${task.taskId}`)}>
        <div class="field"><label for="name">仕事</label><input id="name" name="name" value={task.name} maxlength={100} required /></div>
        <div class="field"><label for="seat">担当</label><select id="seat" name="seat_id"><option value="">まだ決まっていません</option>{seats.results.map((seat) => <option value={seat.seat_id} selected={seat.seat_id === task.seatId}>{seat.title}</option>)}</select></div>
        <div class="field"><label for="start">始める日</label><input id="start" name="start" type="date" value={task.periodStart ?? ""} /></div>
        <div class="field"><label for="end">終わる日</label><input id="end" name="end" type="date" value={task.periodEnd ?? ""} /></div>
        <div class="field"><label for="progress">進み具合</label><select id="progress" name="progress"><option value="open" selected={task.progress === "open"}>これから</option><option value="started" selected={task.progress === "started"}>進行中</option><option value="done" selected={task.progress === "done"}>済み</option></select></div>
        <button class="secondary">直した内容を保存する</button>
      </form></div></details>
      <details class="fold"><summary>この仕事を段取りから外す</summary><div><p>外しても、段取りの「外した仕事を戻す」から戻せます。</p><form method="post" action={adminPath(ward, `/projects/${id}/map/${task.taskId}/remove`)}><button class="secondary">外す</button></form></div></details>
    </> : <Notice>この行事は閉じました。開き直すと時期や担当を直せます。</Notice>}
  </Layout>);
});

admin.use("/projects/:projectId/map/*", async (c, next) => {
  if (c.req.method === "POST") {
    const state = await getProjectState(c.env.DB, c.var.ward.wardId, c.req.param("projectId"));
    if (!state) return c.notFound();
    if (state.project.closedAt) return c.redirect(`${adminPath(c.var.ward, `/close/${c.req.param("projectId")}`)}?error=map_closed`, 303);
  }
  await next();
});
admin.post("/projects/:projectId/map/add", async (c) => {
  const form = await c.req.formData(); const id = c.req.param("projectId");
  const ok = await addMapTask(c.env.DB, c.var.ward.wardId, id, String(form.get("name") ?? ""));
  return c.redirect(`${adminPath(c.var.ward, `/projects/${id}/map`)}?${ok ? "notice=added" : "error=invalid_input"}`, 303);
});
admin.post("/projects/:projectId/map/event-day", async (c) => {
  const form = await c.req.formData(); const id = c.req.param("projectId");
  const ok = await setEventDay(c.env.DB, c.var.ward.wardId, id, String(form.get("event_day") ?? ""), c.var.account.accountId);
  return c.redirect(`${adminPath(c.var.ward, `/projects/${id}/map`)}?${ok ? "notice=event_day" : "error=invalid_input"}`, 303);
});
admin.post("/projects/:projectId/map/:taskId", async (c) => {
  const form = await c.req.formData(); const id = c.req.param("projectId"); const taskId = c.req.param("taskId"); const progress = String(form.get("progress"));
  const ok = ["open", "started", "done"].includes(progress) && await setMapTask(c.env.DB, c.var.ward.wardId, id, taskId, { name: String(form.get("name") ?? ""), start: String(form.get("start") ?? ""), end: String(form.get("end") ?? ""), progress: progress as "open" | "started" | "done", seatId: String(form.get("seat_id") ?? "") || null });
  return c.redirect(`${adminPath(c.var.ward, `/projects/${id}/map/${taskId}`)}?${ok ? "notice=saved" : "error=invalid_input"}`, 303);
});
for (const operation of ["remove", "restore"] as const) admin.post(`/projects/:projectId/map/:taskId/${operation}`, async (c) => {
  const id = c.req.param("projectId");
  const action = operation === "remove" ? removeMapTask : restoreMapTask;
  const ok = await action(c.env.DB, c.var.ward.wardId, id, c.req.param("taskId"));
  return c.redirect(`${adminPath(c.var.ward, `/projects/${id}/map`)}?${ok ? `notice=${operation === "remove" ? "removed" : "restored"}` : "error=invalid_input"}`, 303);
});

export { admin as mapAdmin };
export const map: Bundle = { admin };
