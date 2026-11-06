import { formatJstDate, shortDate } from "../core/time";
import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { adminPath } from "../core/auth";
import { ErrorNotice, Hint, Layout, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { getReadings, listOriginals, listJobs } from "../intake/store";
import { materialChangeText } from "../map/material-change";
import { createProject, getProjectState, getProjectSummary, listProjects, ProjectInputError } from "./api";
import { answerQuestion, renameProject, ROW_REMOVED } from "./actions";
import { PROJECT_KINDS, PROJECT_KIND_LABEL, TABLE_KEYS, type TableKey, isItemKey, DEADLINE_LABEL, ITEM_SCREEN_LABEL, TABLES, countWord, displayFieldValue, DOCUMENT_KIND_LABEL, SCOPE_LABEL, type RowData } from "./model";
import { setProjectApi } from "../ai/project-binding";
import { agentApi } from "./agent-api";
import { MAP_TEMPLATES } from "../map/template";
import { daysRemaining, followupAdmin } from "./followup";
import { questionPages, questionShort } from "./question-pages";
import { markMaterialThisYear, unknownYearContents } from "./material-year";
import { committeePages } from "./committee";

/** 変わった所の対象を、内部の鍵ではなく画面の言葉で示す。 */
function changeTargetLabel(kind: string, target: string): string {
  if (isItemKey(target)) return ITEM_SCREEN_LABEL[target];
  if (kind === "map_task") {
    const task = Object.values(MAP_TEMPLATES).flat().find((entry) => entry.key === target);
    return `段取り　${task?.name ?? target}`;
  }
  const at = target.indexOf(":");
  const table = at > 0 ? target.slice(0, at) : "";
  if ((TABLE_KEYS as readonly string[]).includes(table)) {
    // 行の鍵は列の値を | で繋いだ物。選びの列の値（expense など）は画面の言葉にする。
    const fields = Object.values(TABLES[table as TableKey].fields);
    const words = target.slice(at + 1).split("|").map((part) => {
      for (const field of fields) if (field.def.type === "enum" && field.def.values.includes(part)) return field.def.labels[part] ?? part;
      return /^\d{4}-\d{2}-\d{2}$/.test(part) ? shortDate(part) : part;
    });
    return `${TABLES[table as TableKey].label}　${words.join(" ")}`;
  }
  return target.replaceAll("|", " ");
}

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "choose_kind": "種類を選んでください",
  "open_failed": "行事を開けませんでした",
  "invalid_kind": "行事の種類が合いません",
  "invalid_title": "題は1文字から100文字にしてください",
  "invalid_year": "年が合いません",
  "invalid_day": "行事の日を入れ直してください",
  "seed_missing": "もとにする行事が見つかりません",
  "material_failed": "今年の資料として入れ直せませんでした。資料を確かめて、もう一度お試しください。"
};

const admin = new Hono<AdminEnv>();
setProjectApi(agentApi);
admin.route("/", followupAdmin);
admin.route("/", questionPages);
admin.route("/", committeePages);

admin.get("/projects", async (c) => {
  const { ward } = c.var;
  const allProjects = await listProjects(c.env.DB, ward.wardId, { includeClosed: true });
  const seeds = allProjects.filter((project) => project.closedAt);
  return c.html(<Layout title="新しく始める" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/")}>← 最初の画面へ</a>
    <h1>新しく始める</h1><p class="lead">去年の記録があれば、そこから始められます。ないときは、種類を選ぶと、ふつうの仕事の並びを用意します。</p>
    <ErrorNotice code={c.req.query("error")} messages={ERROR_MESSAGES} />
    {seeds.length ? <><h2>去年の記録から始める</h2><ul class="rows">{seeds.map((project) => <li><a class="row-link" href={adminPath(ward, `/archive/${project.projectId}`)}><b>{project.year}年 {project.title}</b></a></li>)}</ul></> : null}
    <form method="post" action={adminPath(ward, "/projects")}>
      <fieldset><legend>種類</legend><div class="choice">{PROJECT_KINDS.map((kind, index) => <label><input type="radio" name="kind" value={kind} checked={index === 0} required /> {PROJECT_KIND_LABEL[kind]}</label>)}</div></fieldset>
      <div class="field"><label for="title">名前（あとで直せます）</label><input id="title" name="title" maxlength={100} placeholder="秋の収穫祭" /></div>
      <div class="field"><label for="eventDay">行事の日（分かれば）</label><input id="eventDay" name="eventDay" type="date" /><p class="help-text">入れると、仕事の時期を置きます。</p></div>
      <input type="hidden" name="year" value={new Date().getFullYear()} />
      <div class="action-links"><button type="submit">始める</button></div>
    </form>
  </Layout>);
});

admin.get("/projects/today", async (c) => {
  const { ward } = c.var;
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const projects = await listProjects(c.env.DB, ward.wardId);
  const entries: Array<{ date: string | null; until?: boolean; projectId: string; project: string; label: string; detail: string; href: string }> = [];
  for (const project of projects) {
    for (const [kind, date] of Object.entries(project.deadlines)) {
      if (kind === "event_day" && date < today) continue;
      entries.push({ date, projectId: project.projectId, project: project.title, label: DEADLINE_LABEL[kind as keyof typeof DEADLINE_LABEL], detail: "", href: kind === "submit_due" && project.kind === "city_request" ? `/requests/city/${project.projectId}` : kind === "answer_due" ? `/answers/${project.projectId}` : `/projects/${project.projectId}/map` });
    }
    const state = await getProjectState(c.env.DB, ward.wardId, project.projectId);
    if (!state) continue;
    for (const task of state.mapTasks.filter((t) => t.progress !== "done" && t.periodEnd)) {
      entries.push({ date: task.periodEnd, until: true, projectId: project.projectId, project: project.title, label: task.name, detail: "", href: `/projects/${project.projectId}/map/${task.taskId}` });
    }
    for (const question of state.questions.filter((q) => q.state === "open" || q.state === "later")) {
      entries.push({ date: null, projectId: project.projectId, project: project.title, label: "質問", detail: questionShort(question), href: `/projects/${project.projectId}/questions#question-${question.questionId}` });
    }
    for (const item of state.items) {
      if (!item.current && item.references.length === 0) entries.push({ date: null, projectId: project.projectId, project: project.title, label: "まだ入っていないもの", detail: ITEM_SCREEN_LABEL[item.key], href: `/projects/${project.projectId}` });
    }
  }
  entries.sort((a, b) => (a.date ?? "9999-99-99").localeCompare(b.date ?? "9999-99-99") || a.project.localeCompare(b.project, "ja"));
  return c.html(<Layout title="今やること" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/")}>← 最初の画面へ</a><h1>今やること</h1>
    {entries.length === 0 ? <><div class="notice" role="status"><strong>今やることはありません</strong><p>締切が近づくと、ここに並びます。</p></div><section class="next"><strong>次は</strong><p>手元に資料があれば、送っておけます。</p><a class="button" href={adminPath(ward, "/intake")}>資料を送る</a></section></> : <><p class="lead">締切の近い順に並べています。どれから始めてもかまいません。押すと、その仕事の画面が開きます。</p>
    {[true, false].map((dated) => <section><h2>{dated ? "締切のあるもの" : "締切のないもの"}</h2><ul class="rows">{entries.filter((entry) => Boolean(entry.date) === dated).map((entry) => <li><a class="row-link" href={adminPath(ward, entry.href)}><b>{entry.project}　{entry.label}</b><span>{entry.date ? `${entry.until ? `${shortDate(entry.date)}まで` : formatJstDate(entry.date)}　${daysRemaining(entry.date)}` : entry.detail}</span></a></li>)}</ul>{!entries.some((entry) => Boolean(entry.date) === dated) ? <p>{dated ? "締切のあるものはありません。" : "締切のないものはありません。"}</p> : null}</section>)}</>}
  </Layout>);
});

admin.post("/projects", async (c) => {
  const { ward, account } = c.var; const form = await c.req.formData();
  const kind = String(form.get("kind"));
  if (!(PROJECT_KINDS as readonly string[]).includes(kind)) return c.redirect(`${adminPath(ward, "/projects")}?error=choose_kind`, 303);
  try {
    const project = await createProject(c.env.DB, ward.wardId, { kind: kind as (typeof PROJECT_KINDS)[number], title: String(form.get("title") ?? "").trim() || PROJECT_KIND_LABEL[kind as (typeof PROJECT_KINDS)[number]], year: Number(form.get("eventDay") ? String(form.get("eventDay")).slice(0, 4) : form.get("year")), ...(form.get("eventDay") ? { eventDay: String(form.get("eventDay")) } : {}), accountId: account.accountId });
    return c.redirect(adminPath(ward, `/projects/${project.projectId}/map`), 303);
  } catch (e) {
    const code = e instanceof ProjectInputError
      ? Object.entries(ERROR_MESSAGES).find(([, message]) => message === e.message)?.[0] ?? "open_failed"
      : "open_failed";
    return c.redirect(`${adminPath(ward, "/projects")}?error=${code}`, 303);
  }
});

admin.get("/projects/:projectId", async (c) => {
  const { ward } = c.var; const projectId = c.req.param("projectId");
  const [project, state, jobs, changes] = await Promise.all([getProjectSummary(c.env.DB, ward.wardId, projectId), getProjectState(c.env.DB, ward.wardId, projectId), listJobs(c.env.DB, ward.wardId, { projectId, limit: 40 }), c.env.DB.prepare("SELECT kind, target, status, reason, source_locator FROM project_changes WHERE ward_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 30").bind(ward.wardId, projectId).all<{ kind: string; target: string; status: string; reason: string | null; source_locator: string | null }>()]);
  if (!project || !state) return c.notFound();
  const unknown = unknownYearContents(state);
  const unknownOriginalIds = new Set([...unknown.items, ...unknown.rows].map((value) => value.source.ref));
  return c.html(<Layout title="今年の内容" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, `/projects/${projectId}/map`)}>← {project.title}の段取りへ</a>
    <h1>届いた資料を見る</h1><p class="lead">{project.title}に届いた資料と、そこから読み取った今年の内容が見られます。分かる質問があれば答えてください。</p>
    <nav class="action-links">
      <a class="button" href={adminPath(ward, `/projects/${projectId}/questions`)}>質問に答える</a>
      <a class="button secondary" href={adminPath(ward, `/intake?project=${encodeURIComponent(projectId)}`)}>資料を送る</a>
    </nav>
    <p class="muted">{PROJECT_KIND_LABEL[project.kind]}　{project.year}年</p>
    <ErrorNotice code={c.req.query("error")} messages={ERROR_MESSAGES} />
    <details class="fold"><summary>名前を直す</summary><form method="post" action={adminPath(ward, `/projects/${projectId}/title`)}><label for="title">名前</label><input id="title" name="title" value={project.title} maxlength={100} required /> <button class="secondary">名前を保存する</button></form></details>
    <ul class="rows"><li><a class="row-link" href={adminPath(ward, `/projects/${projectId}/questions`)}><b>質問{state.questions.length ? `が${countWord(state.questions.length)}あります` : "はありません"}</b><span>答えなくても配れます。</span></a></li></ul>
    <h2 id="materials">届いた資料</h2>
    {await Promise.all(jobs.map(async (job) => {
      const originals = await listOriginals(c.env.DB, ward.wardId, job.job_id);
      const readings = await getReadings(c.env.DB, ward.wardId, job.job_id);
      return <section class="panel"><b>{job.first_filename || "書いたこと"}</b><p class="muted">{job.status === "done" ? originals.some((original) => materialChangeText(state, original.original_id)) ? "読み終わりました。今年の内容に入れました" : "読み終わりました" : job.status === "failed" ? "読めませんでした" : "読み取りを進めています"}</p>
        <div class="material-links">{originals.map((original, index) => <a class="quiet" href={adminPath(ward, `/intake/originals/${original.original_id}`)}>元の資料を見る{originals.length > 1 ? `（${index + 1}枚目）` : ""}</a>)}</div>
        {originals.filter((original) => original.kind === "text").map((original) => <p style="white-space:pre-wrap">{readings.filter((r) => r.source === "direct").flatMap((r) => "text_blocks" in r.body ? r.body.text_blocks.filter((block) => block.original_id === original.original_id).map((block) => block.text) : []).join("\n")}</p>)}
        {readings.length ? <details class="hint"><summary>読み取った内容</summary><div>{readings.map((r) => <><p>{r.body.summary}</p>
          {"fields" in r.body ? <>{r.body.fields.map((f) => <p>{f.name}: {f.value}（{f.locator}。{f.confidence === "high" ? "はっきり読めました" : f.confidence === "medium" ? "少し読みにくい字でした" : "読みにくい字でした"}）</p>)}{r.body.text_blocks.map((b) => <p>{b.text}（{b.locator}）</p>)}</> : r.body.rows.map((row) => <p>{row.household_name} / {row.ward_group}（{row.locator}）</p>)}
        </>)}</div></details> : null}
        {originals.filter((original) => !project.closedAt && !original.withdrawn_at && unknownOriginalIds.has(original.original_id)).map((original) => <form method="post" action={adminPath(ward, `/projects/${projectId}/materials/${original.original_id}/this-year`)}>
          <p class="muted">年が書かれていません。去年のものなら、そのままで大丈夫です。</p><button type="submit" class="secondary">この資料は今年のもの</button><Hint text={`${project.year}年の資料として内容を入れ直します。今年の内容と違うところは、上書きせず質問に並びます。質問に答えなくても配れます。`} />
        </form>)}
        {job.status === "failed" ? <form method="post" action={adminPath(ward, `/intake/${job.job_id}/retry`)}><button class="secondary">もう一度読む</button></form> : null}
      </section>;
    }))}
    {jobs.length === 0 ? <p>まだ資料は入っていません。</p> : null}
    <a class="quiet" href={adminPath(ward, `/projects/${projectId}/map`)}>段取りで、変わった仕事を見る</a>
    <h2>資料から変わったところ</h2>
    <ul class="rows">{changes.results.map((change) => <li class="panel"><b>{changeTargetLabel(change.kind, change.target)}</b><p>{change.status === "applied" ? change.reason === ROW_REMOVED ? "外しました" : "今年の内容に入れました" : change.status === "same" ? "同じでした" : change.status === "conflict" ? "食い違いとして並びました" : change.status === "kept" ? "今の内容を残しました" : change.status === "held" ? "確認待ちです" : change.status === "dropped" ? `取り込めませんでした${change.reason ? `: ${change.reason}` : ""}` : "記録しました"}{change.source_locator ? `（${change.source_locator}）` : ""}</p></li>)}</ul>
    {changes.results.length === 0 ? <p>まだ変わったところはありません。</p> : null}
    <h2>今年の内容</h2>
    <p class="lead">今年の内容がない項目には、去年までの資料を参考として並べます。</p>
    <dl class="facts">{state.items.map((item) => <><dt>{ITEM_SCREEN_LABEL[item.key]}</dt><dd>{item.current?.content ?? "まだ入っていません"}{item.references.map((v) => <span class="muted block">参考（{v.refYear === null ? "年不明" : `${v.refYear}年`}）: {v.content}</span>)}</dd></>)}</dl>
    <h2 id="ledger">運営メモ</h2>
    <p>何に、どこに、いくらかけたか、来年のためのメモです。領収書や見積りの写真からも入ります。</p>
    <ul class="links"><li><a href={adminPath(ward, `/projects/${projectId}/ledger`)}>運営メモを開く</a></li></ul>

    <h2>実行委員名簿</h2><ul class="links"><li><a href={adminPath(ward, `/projects/${projectId}/committee`)}>実行委員名簿を見て直す</a></li></ul>
    <h2>文書</h2>
    <ul class="rows">{state.documents.map((d) => <li class="panel"><b>{DOCUMENT_KIND_LABEL[d.kind]}</b><p class="muted">{d.scope === "public" ? "だれでも読める" : SCOPE_LABEL[d.scope]}{d.stale ? "　新しい資料が入っています" : ""}</p></li>)}</ul>
    <ul class="links"><li><a href={adminPath(ward, `/projects/${projectId}/draft`)}>下書きの一覧を開く</a></li></ul>
  </Layout>);
});

admin.post("/projects/:projectId/title", async (c) => { const { ward } = c.var; const f = await c.req.formData(); await renameProject(c.env.DB, ward.wardId, c.req.param("projectId"), String(f.get("title") ?? "")); return c.redirect(adminPath(ward, `/projects/${c.req.param("projectId")}`), 303); });
admin.post("/projects/:projectId/materials/:originalId/this-year", async (c) => {
  const { ward, account } = c.var;
  const projectId = c.req.param("projectId");
  const ok = await markMaterialThisYear(c.env.DB, ward.wardId, projectId, c.req.param("originalId"), account.accountId);
  const path = adminPath(ward, `/projects/${projectId}`);
  return c.redirect(ok ? `${path}#materials` : `${path}?error=material_failed`, 303);
});
admin.post("/projects/:projectId/questions/:questionId", async (c) => {
  const { ward, account } = c.var; const id = c.req.param("projectId"); const form = await c.req.formData();
  const action = String(form.get("action") ?? "answer");
  const state = await getProjectState(c.env.DB, ward.wardId, id);
  if (!state || state.project.closedAt) return c.notFound();
  const ok = ["answer", "unknown", "later"].includes(action) && await answerQuestion(c.env.DB, ward.wardId, id, c.req.param("questionId"), action as "answer" | "unknown" | "later", String(form.get("answer") ?? ""), account.accountId);
  if (ok && form.get("from") === "draft") return c.redirect(adminPath(ward, `/projects/${id}/draft/announcement`), 303);
  return c.redirect(`${adminPath(ward, `/projects/${id}/questions`)}?${ok ? `notice=${action === "answer" ? "answered" : action}` : "error=answer_failed"}`, 303);
});

export { admin as projectAdmin };
export const project: Bundle = { admin };
