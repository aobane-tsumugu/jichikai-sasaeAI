import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { adminPath } from "../core/auth";
import { Layout, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { listUnansweredByDistrict } from "../answers/api";
import { getReadings, listOriginals, listJobs } from "../intake/store";
import { createProject, getProjectState, getProjectSummary, listProjects, ProjectInputError } from "./api";
import { answerQuestion, renameProject } from "./actions";
import { PROJECT_KINDS, PROJECT_KIND_LABEL, DEADLINE_LABEL, ITEM_LABEL, TABLES, displayFieldValue, DOCUMENT_KIND_LABEL, SCOPE_LABEL, CONFIDENCE_LABEL, type RowData } from "./model";
import { setProjectApi } from "../ai/project-binding";
import { agentApi } from "./agent-api";

const admin = new Hono<AdminEnv>();
setProjectApi(agentApi);

admin.get("/projects", async (c) => {
  const { ward } = c.var;
  const projects = await listProjects(c.env.DB, ward.wardId);
  return c.html(<Layout title="プロジェクト" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <h1>プロジェクト</h1>
    <p><a class="button secondary" href={adminPath(ward, "/projects/today")}>今やること</a></p>
    {c.req.query("error") ? <Notice error>{c.req.query("error")}</Notice> : null}
    {projects.map((p) => <section class="panel"><h2><a href={adminPath(ward, `/projects/${p.projectId}`)}>{p.title}</a></h2>
      <p>{PROJECT_KIND_LABEL[p.kind]} / {p.year}年</p>
      {Object.entries(p.deadlines).map(([kind, date]) => <p>{DEADLINE_LABEL[kind as keyof typeof DEADLINE_LABEL]}: {date}</p>)}
    </section>)}
    {projects.length === 0 ? <p>まだプロジェクトはありません。</p> : null}
    <h2>プロジェクトを開く</h2>
    <form method="post" action={adminPath(ward, "/projects")}>
      <label for="kind">種類</label><select id="kind" name="kind" required>{PROJECT_KINDS.map((kind) => <option value={kind}>{PROJECT_KIND_LABEL[kind]}</option>)}</select>
      <input type="hidden" name="year" value={new Date().getFullYear()} />
      <p><button type="submit">開く</button></p>
    </form>
  </Layout>);
});

admin.get("/projects/today", async (c) => {
  const { ward } = c.var;
  const projects = await listProjects(c.env.DB, ward.wardId);
  const entries: Array<{ date: string | null; projectId: string; project: string; label: string; detail: string; href: string }> = [];
  for (const project of projects) {
    for (const [kind, date] of Object.entries(project.deadlines)) {
      entries.push({ date, projectId: project.projectId, project: project.title, label: DEADLINE_LABEL[kind as keyof typeof DEADLINE_LABEL], detail: date, href: `/projects/${project.projectId}/map` });
    }
    const state = await getProjectState(c.env.DB, ward.wardId, project.projectId);
    if (!state) continue;
    if (project.deadlines.answer_due) {
      const groups = await listUnansweredByDistrict(c.env.DB, ward.wardId, project.projectId);
      const unansweredCount = groups.reduce((count, group) => count + group.households.length, 0);
      if (unansweredCount > 0) entries.push({ date: project.deadlines.answer_due, projectId: project.projectId, project: project.title, label: "未回答", detail: `${unansweredCount}世帯`, href: `/answers/${encodeURIComponent(project.projectId)}` });
    }
    for (const question of state.questions) {
      entries.push({ date: null, projectId: project.projectId, project: project.title, label: question.kind === "unreadable" ? "読めなかった所" : "未回答の問い", detail: question.text, href: `/projects/${project.projectId}#question-${question.questionId}` });
    }
    for (const item of state.items) {
      if (!item.current && item.references.length === 0) entries.push({ date: null, projectId: project.projectId, project: project.title, label: "足りない物", detail: ITEM_LABEL[item.key], href: `/projects/${project.projectId}` });
    }
  }
  entries.sort((a, b) => (a.date ?? "9999-99-99").localeCompare(b.date ?? "9999-99-99") || a.project.localeCompare(b.project, "ja"));
  return c.html(<Layout title="今やること" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")} headerRight={<a href={adminPath(ward, "/projects")}>プロジェクト一覧</a>}>
    <h1>今やること</h1>
    <p>期限の近い順に並べています。期限のない問いと足りない物は後ろに表示します。</p>
    {entries.map((entry) => <article class="panel">
      <p>{entry.date ?? "日付なし"}　{entry.label}</p>
      <h2><a href={adminPath(ward, entry.href)}>{entry.project}</a></h2>
      <p>{entry.detail}</p>
    </article>)}
    {entries.length === 0 ? <p>今、確認する項目はありません。</p> : null}
    <p><a href={adminPath(ward, "/")}>役員画面へ</a></p>
  </Layout>);
});

admin.post("/projects", async (c) => {
  const { ward, account } = c.var; const form = await c.req.formData();
  const kind = String(form.get("kind"));
  if (!(PROJECT_KINDS as readonly string[]).includes(kind)) return c.redirect(`${adminPath(ward, "/projects")}?error=${encodeURIComponent("種類を選んでください")}`, 303);
  try {
    const project = await createProject(c.env.DB, ward.wardId, { kind: kind as (typeof PROJECT_KINDS)[number], title: PROJECT_KIND_LABEL[kind as (typeof PROJECT_KINDS)[number]], year: Number(form.get("year")), accountId: account.accountId });
    return c.redirect(adminPath(ward, `/projects/${project.projectId}/map`), 303);
  } catch (e) {
    const msg = e instanceof ProjectInputError ? e.message : "プロジェクトを開けませんでした";
    return c.redirect(`${adminPath(ward, "/projects")}?error=${encodeURIComponent(msg)}`, 303);
  }
});

admin.get("/projects/:projectId", async (c) => {
  const { ward } = c.var; const projectId = c.req.param("projectId");
  const [project, state, jobs, changes] = await Promise.all([getProjectSummary(c.env.DB, ward.wardId, projectId), getProjectState(c.env.DB, ward.wardId, projectId), listJobs(c.env.DB, ward.wardId, { projectId, limit: 40 }), c.env.DB.prepare("SELECT target, status, reason, source_locator FROM project_changes WHERE ward_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 30").bind(ward.wardId, projectId).all<{ target: string; status: string; reason: string | null; source_locator: string | null }>()]);
  if (!project || !state) return c.notFound();
  const ledgerRows: Array<{ data: RowData }> = [
    ...state.tables.sponsors.map((row) => ({ data: { counterpart: row.data.name ?? "", direction: "income", amount: row.data.amount ?? "", date: "", note: row.data.reply ?? "" } })),
    ...state.tables.ledger,
  ];
  return c.html(<Layout title={project.title} siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")} headerRight={<a href={adminPath(ward, "/projects")}>プロジェクト一覧</a>}>
    <h1>{project.title}</h1>
    <nav><a href={adminPath(ward, `/projects/${projectId}/map`)}>地図</a> | <a href={adminPath(ward, `/projects/${projectId}/draft`)}>案</a> | <a href={adminPath(ward, `/projects/${projectId}/check`)}>混入を確かめる</a> | <a href={adminPath(ward, `/publish/${projectId}`)}>配る</a></nav>
    <form method="post" action={adminPath(ward, `/projects/${projectId}/title`)}><label for="title">題を直す</label><input id="title" name="title" value={project.title} maxlength={100} required /><button class="secondary">保存</button></form>
    <p>{PROJECT_KIND_LABEL[project.kind]} / {project.year}年</p>
    <h2>問い</h2>
    {state.questions.map((q) => <section class="panel" id={`question-${q.questionId}`}><strong>{q.text}</strong>{q.options?.length ? <ul>{q.options.map((o) => <li>{o}</li>)}</ul> : null}
      <form method="post" action={adminPath(ward, `/projects/${projectId}/questions/${q.questionId}`)}>
        {q.options?.length ? <><label for={`answer-${q.questionId}`}>一つ選ぶ</label><select id={`answer-${q.questionId}`} name="answer">{q.options.map((o) => <option>{o}</option>)}</select></> : <><label for={`answer-${q.questionId}`}>答え</label><input id={`answer-${q.questionId}`} name="answer" maxlength={2000} /></>}
        <button name="action" value="answer">答える</button> <button class="secondary" name="action" value="unknown">分からない</button> <button class="secondary" name="action" value="later">後で</button>
      </form>
    </section>)}
    {state.questions.length === 0 ? <p>今、問いはありません。</p> : null}
    <h2 id="materials">材料とその影響</h2>
    {await Promise.all(jobs.map(async (job) => {
      const originals = await listOriginals(c.env.DB, ward.wardId, job.job_id);
      const readings = await getReadings(c.env.DB, ward.wardId, job.job_id);
      return <section class="panel" id="materials"><h3>{job.first_filename || "一行の文"}</h3><p>{job.status === "done" ? "反映しました" : job.status === "failed" ? "読めませんでした" : "処理中または確認中"}</p>
        {originals.map((original) => { const target = adminPath(ward, `/intake/originals/${original.original_id}`); const related = readings.filter((r) => "fields" in r.body ? r.body.fields.some((f) => f.original_id === original.original_id) || r.body.text_blocks.some((b) => b.original_id === original.original_id) : r.body.rows.some((row) => row.original_id === original.original_id)); return <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:1rem;align-items:start;margin:1rem 0">
          <div><a href={target} target="_blank">元の物を開く: {original.filename || "一行の文"}</a>{original.media_type.startsWith("image/") ? <a href={target} target="_blank"><img src={target} alt="入った元の写真" loading="lazy" style="display:block;width:100%;height:auto;margin-top:.5rem" /></a> : null}</div>
          <div>{related.map((r) => <details open><summary>読み取った中身</summary><p>{r.body.summary}</p>
            {"fields" in r.body ? <>{r.body.fields.filter((f) => f.original_id === original.original_id).map((f) => <p><a href={target} target="_blank">{f.name}: {f.value}</a>（写真全体・{f.locator} / 確かさ{CONFIDENCE_LABEL[f.confidence]}）</p>)}{r.body.text_blocks.filter((b) => b.original_id === original.original_id).map((b) => <p><a href={target} target="_blank">{b.text}</a>（写真全体・{b.locator}）</p>)}</> : r.body.rows.filter((row) => row.original_id === original.original_id).map((row) => <p><a href={target} target="_blank">{row.household_name} / {row.ward_group}</a>（写真全体・{row.locator}）</p>)}
          </details>)}</div>
        </div>; })}
        <p><a href={adminPath(ward, `/projects/${projectId}/map`)}>地図で影響を見る</a></p>
      </section>;
    }))}
    {jobs.length === 0 ? <p>まだ材料は入っていません。</p> : null}
    <h2>入った物の影響</h2>
    {changes.results.map((change) => <p>{change.target} — {change.status === "applied" ? "中身に入りました" : change.status === "same" ? "同じ物でした" : change.status === "conflict" ? "食い違いとして並びました" : change.status === "kept" ? "今の中身を残しました" : change.status === "held" ? "確認待ちです" : change.status === "dropped" ? `取り込めませんでした${change.reason ? `: ${change.reason}` : ""}` : "記録しました"}{change.source_locator ? `（${change.source_locator}）` : ""}</p>)}
    {changes.results.length === 0 ? <p>まだ変わった所はありません。</p> : null}
    <h2>今年の中身</h2>
    {state.items.map((item) => <section class="panel"><strong>{item.label}</strong><p>{item.current?.content ?? "まだ入っていません"}</p>{item.references.map((v) => <p>参考（{v.refYear ?? "年不明"}年）: {v.content}</p>)}</section>)}
    <h2 id="ledger">収支（記録のみ）</h2>
    <table><thead><tr><th>相手</th><th>収入か支出</th><th>額</th><th>日付</th><th>メモ</th></tr></thead><tbody>{ledgerRows.map((row) => <tr>{Object.keys(TABLES.ledger.fields).map((key) => <td>{displayFieldValue("ledger", key, row.data[key])}</td>)}</tr>)}</tbody></table>
    <h2>入った物と文書</h2>
    {state.documents.map((d) => <p>{DOCUMENT_KIND_LABEL[d.kind]} / {SCOPE_LABEL[d.scope]}{d.stale ? " / 新しい物が入っています" : ""}</p>)}
  </Layout>);
});

admin.post("/projects/:projectId/title", async (c) => { const { ward } = c.var; const f = await c.req.formData(); await renameProject(c.env.DB, ward.wardId, c.req.param("projectId"), String(f.get("title") ?? "")); return c.redirect(adminPath(ward, `/projects/${c.req.param("projectId")}`), 303); });
admin.post("/projects/:projectId/questions/:questionId", async (c) => { const { ward, account } = c.var; const f = await c.req.formData(); const action = String(f.get("action")); if (["answer", "unknown", "later"].includes(action)) await answerQuestion(c.env.DB, ward.wardId, c.req.param("projectId"), c.req.param("questionId"), action as "answer" | "unknown" | "later", String(f.get("answer") ?? ""), account.accountId); return c.redirect(adminPath(ward, `/projects/${c.req.param("projectId")}`), 303); });

export { admin as projectAdmin };
export const project: Bundle = { admin };
