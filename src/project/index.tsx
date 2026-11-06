import { formatJstDate } from "../core/time";
import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { adminPath } from "../core/auth";
import { ErrorNotice, Hint, Layout, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { getReadings, listOriginals, listJobs } from "../intake/store";
import { createProject, getProjectState, getProjectSummary, listProjects, ProjectInputError } from "./api";
import { answerQuestion, renameProject } from "./actions";
import { PROJECT_KINDS, PROJECT_KIND_LABEL, TABLE_KEYS, type TableKey, isItemKey, DEADLINE_LABEL, ITEM_LABEL, TABLES, displayFieldValue, DOCUMENT_KIND_LABEL, SCOPE_LABEL, CONFIDENCE_LABEL, type RowData } from "./model";
import { setProjectApi } from "../ai/project-binding";
import { agentApi } from "./agent-api";
import { MAP_TEMPLATES } from "../map/template";
import { daysRemaining, followupAdmin } from "./followup";
import { questionPages } from "./question-pages";
import { markMaterialThisYear, unknownYearContents } from "./material-year";

/** 変わった所の対象を、内部の鍵ではなく画面の言葉で示す。 */
function changeTargetLabel(kind: string, target: string): string {
  if (isItemKey(target)) return ITEM_LABEL[target];
  if (kind === "map_task") {
    const task = Object.values(MAP_TEMPLATES).flat().find((entry) => entry.key === target);
    return `段取り: ${task?.name ?? target}`;
  }
  const at = target.indexOf(":");
  const table = at > 0 ? target.slice(0, at) : "";
  if ((TABLE_KEYS as readonly string[]).includes(table)) {
    // 行の鍵は列の値を | で繋いだ物。選びの列の値（expense など）は画面の言葉にする。
    const fields = Object.values(TABLES[table as TableKey].fields);
    const words = target.slice(at + 1).split("|").map((part) => {
      for (const field of fields) if (field.def.type === "enum" && field.def.values.includes(part)) return field.def.labels[part] ?? part;
      return part;
    });
    return `${TABLES[table as TableKey].label}: ${words.join(" ")}`;
  }
  return target.replaceAll("|", " ");
}

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "choose_kind": "種類を選んでください",
  "open_failed": "行事を開けませんでした",
  "invalid_kind": "行事の種類が合いません",
  "invalid_title": "題は1文字から100文字にしてください",
  "invalid_year": "年が合いません",
  "invalid_day": "行事の日はYYYY-MM-DDで入れてください",
  "seed_missing": "種にする行事が見つかりません",
  "material_failed": "今年の資料として入れ直せませんでした。資料を確かめて、もう一度お試しください。"
};

const admin = new Hono<AdminEnv>();
setProjectApi(agentApi);
admin.route("/", followupAdmin);
admin.route("/", questionPages);

admin.get("/projects", async (c) => {
  const { ward } = c.var;
  const allProjects = await listProjects(c.env.DB, ward.wardId, { includeClosed: true });
  const projects = allProjects.filter((project) => !project.closedAt);
  const seeds = allProjects.filter((project) => project.closedAt);
  return c.html(<Layout title="行事" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <h1>行事</h1><p class="lead">行事や総会、市からの依頼を始める画面です。去年の段取りがあればそこから、なければ下の欄から開いてください。</p>
    <p><a class="button secondary" href={adminPath(ward, "/projects/today")}>今やること</a></p>
    <p><a class="button secondary" href={adminPath(ward, "/requests/city")}>行政の依頼</a> <a class="button secondary" href={adminPath(ward, "/inquiries")}>問い合わせと要望</a> <a class="button secondary" href={adminPath(ward, "/ledger")}>帳簿</a></p>
    <ErrorNotice code={c.req.query("error")} messages={ERROR_MESSAGES} />
    {projects.map((p) => <section class="panel"><h2><a href={adminPath(ward, `/projects/${p.projectId}`)}>{p.title}</a></h2>
      <p>{PROJECT_KIND_LABEL[p.kind]} / {p.year}年</p>
      {Object.entries(p.deadlines).map(([kind, date]) => <p>{DEADLINE_LABEL[kind as keyof typeof DEADLINE_LABEL]}: {formatJstDate(date)}</p>)}
    </section>)}
    {projects.length === 0 ? <p>まだ行事はありません。</p> : null}
    {seeds.length ? <section class="panel">
      <h2>去年の段取りから開く</h2>
      <ul>{seeds.map((project) => <li class="link-line"><a href={adminPath(ward, `/archive/${project.projectId}`)}>{project.year}年{project.title} の段取りから開く</a></li>)}</ul>
    </section> : null}
    <h2>行事を開く</h2>
    <form method="post" action={adminPath(ward, "/projects")}>
      <label for="kind">種類</label><select id="kind" name="kind" required>{PROJECT_KINDS.map((kind) => <option value={kind}>{PROJECT_KIND_LABEL[kind]}</option>)}</select>
      <label for="title">題（あとで直せます）</label><input id="title" name="title" maxlength={100} placeholder="秋の収穫祭" />
      <label for="eventDay">行事の日（分かれば。段取りの時期に使います）</label><input id="eventDay" name="eventDay" type="date" />
      <input type="hidden" name="year" value={new Date().getFullYear()} />
      <p class="action-bar page-action"><button type="submit">開く</button></p><p class="help-text">選んだ仕事の段取りを用意します。</p>
    </form>
  </Layout>);
});

admin.get("/projects/today", async (c) => {
  const { ward } = c.var;
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const projects = await listProjects(c.env.DB, ward.wardId);
  const entries: Array<{ date: string | null; projectId: string; project: string; label: string; detail: string; href: string }> = [];
  for (const project of projects) {
    for (const [kind, date] of Object.entries(project.deadlines)) {
      if (kind === "event_day" && date < today) continue;
      entries.push({ date, projectId: project.projectId, project: project.title, label: DEADLINE_LABEL[kind as keyof typeof DEADLINE_LABEL], detail: "", href: kind === "submit_due" && project.kind === "city_request" ? `/requests/city/${project.projectId}` : kind === "answer_due" ? `/answers/${project.projectId}` : `/projects/${project.projectId}/map` });
    }
    const state = await getProjectState(c.env.DB, ward.wardId, project.projectId);
    if (!state) continue;
    for (const task of state.mapTasks.filter((t) => t.progress !== "done" && t.periodEnd)) {
      entries.push({ date: task.periodEnd, projectId: project.projectId, project: project.title, label: task.name, detail: "", href: `/projects/${project.projectId}/map/${task.taskId}` });
    }
    for (const question of state.questions.filter((q) => q.state === "open" || q.state === "later")) {
      entries.push({ date: null, projectId: project.projectId, project: project.title, label: question.kind === "unreadable" ? "読めなかったところ" : "まだ答えていない質問", detail: question.text, href: `/projects/${project.projectId}/questions#question-${question.questionId}` });
    }
    for (const item of state.items) {
      if (!item.current && item.references.length === 0) entries.push({ date: null, projectId: project.projectId, project: project.title, label: "足りないもの", detail: ITEM_LABEL[item.key], href: `/projects/${project.projectId}` });
    }
  }
  entries.sort((a, b) => (a.date ?? "9999-99-99").localeCompare(b.date ?? "9999-99-99") || a.project.localeCompare(b.project, "ja"));
  return c.html(<Layout title="今やること" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")} headerRight={<a href={adminPath(ward, "/projects")}>行事一覧</a>}>
    <a class="back" href={adminPath(ward, "/")}>最初の画面へ</a><h1>今やること</h1><p class="lead">締切の近い順に並べています。どれから始めてもかまいません。押すと、その仕事の画面が開きます。</p>
    {[true, false].map((dated) => <section><h2>{dated ? "締切のあるもの" : "締切のないもの"}</h2><ul class="rows">{entries.filter((entry) => Boolean(entry.date) === dated).map((entry) => <li><a class="row-link" href={adminPath(ward, entry.href)}><b>{entry.project}　{entry.label}</b><span>{entry.date ? `${formatJstDate(entry.date)}　${daysRemaining(entry.date)}` : entry.detail}</span></a></li>)}</ul>{!entries.some((entry) => Boolean(entry.date) === dated) ? <p>{dated ? "締切のあるものはありません。" : "締切のないものはありません。"}</p> : null}</section>)}
    {entries.length === 0 ? <p>今、確認する項目はありません。</p> : null}
    <p class="link-line"><a href={adminPath(ward, "/")}>役員画面へ</a></p>
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
  const ledgerRows: Array<{ rowId: string; data: RowData }> = [
    ...state.tables.sponsors.filter((row) => row.scope === "current").map((row) => ({ rowId: row.rowId, data: { counterpart: row.data.name ?? "", direction: "income", amount: row.data.amount ?? "", date: "", note: row.data.reply ? `協賛の返事: ${displayFieldValue("sponsors", "reply", row.data.reply)}` : "" } })),
    ...state.tables.ledger.filter((row) => row.scope === "current"),
  ];
  return c.html(<Layout title="今年の中身" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")} headerRight={<a href={adminPath(ward, "/projects")}>行事一覧</a>}>
    <a class="back" href={adminPath(ward, `/projects/${projectId}/map`)}>← {project.title}の段取りへ</a>
    <h1>届いた資料を見る</h1><p class="lead">{project.title}に届いた資料と、そこから読み取った今年の中身が見られます。分かる質問があれば答えてください。</p>
    <nav class="action-links">
      <a class="button" href={adminPath(ward, `/projects/${projectId}/questions`)}>質問に答える</a>
      <a class="button secondary" href={adminPath(ward, `/intake?project=${encodeURIComponent(projectId)}`)}>資料を送る</a>
    </nav>
    <p>{PROJECT_KIND_LABEL[project.kind]} / {project.year}年</p>
    <ErrorNotice code={c.req.query("error")} messages={ERROR_MESSAGES} />
    <details><summary>名前を直す</summary><form method="post" action={adminPath(ward, `/projects/${projectId}/title`)}><label for="title">名前</label><input id="title" name="title" value={project.title} maxlength={100} required /> <button class="secondary">名前を保存する</button></form></details>
    <p class="link-line"><a href={adminPath(ward, `/projects/${projectId}/questions`)}>質問{state.questions.length ? `が${state.questions.length}つあります` : "はありません"}</a></p>
    <p>答えなくても配れます。</p>
    <h2 id="materials">届いた資料</h2>
    {await Promise.all(jobs.map(async (job) => {
      const originals = await listOriginals(c.env.DB, ward.wardId, job.job_id);
      const readings = await getReadings(c.env.DB, ward.wardId, job.job_id);
      return <section class="panel"><h3>{job.first_filename || "一行の文"}</h3><p>{job.status === "done" ? "読み終わりました" : job.status === "failed" ? "読めませんでした" : "読み取りを進めています"}</p>
        {originals.map((original) => { const target = adminPath(ward, `/intake/originals/${original.original_id}`); const related = readings.filter((r) => "fields" in r.body ? r.body.fields.some((f) => f.original_id === original.original_id) || r.body.text_blocks.some((b) => b.original_id === original.original_id) : r.body.rows.some((row) => row.original_id === original.original_id)); return <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:1rem;align-items:start;margin:1rem 0">
          <div class="material-links"><a href={target} target="_blank">元の資料を開く: {original.filename || "一行の文"}</a>{original.kind === "text" ? <p style="white-space:pre-wrap">{readings.filter((r) => r.source === "direct").flatMap((r) => "text_blocks" in r.body ? r.body.text_blocks.filter((block) => block.original_id === original.original_id).map((block) => block.text) : []).join("\n")}</p> : null}{original.media_type.startsWith("image/") ? <a href={target} target="_blank"><img src={target} alt="入った元の写真" loading="lazy" style="display:block;width:100%;height:auto;margin-top:.5rem" /></a> : null}
            {!project.closedAt && !original.withdrawn_at && unknownOriginalIds.has(original.original_id) ? <form method="post" action={adminPath(ward, `/projects/${projectId}/materials/${original.original_id}/this-year`)}>
              <p><button type="submit" class="secondary">この資料は今年のもの</button> <Hint text={`${project.year}年の資料として中身を入れ直します。今年の中身と違うところは、上書きせず質問に並びます。質問に答えなくても配れます。`} /></p>
            </form> : null}
          </div>
          <div>{related.map((r) => <details><summary>読み取った内容</summary><p>{r.body.summary}</p>
            {"fields" in r.body ? <>{r.body.fields.filter((f) => f.original_id === original.original_id).map((f) => <p><a href={target} target="_blank">{f.name}: {f.value}</a>（写真全体・{f.locator} / 確かさ{CONFIDENCE_LABEL[f.confidence]}）</p>)}{r.body.text_blocks.filter((b) => b.original_id === original.original_id).map((b) => <p><a href={target} target="_blank">{b.text}</a>（写真全体・{b.locator}）</p>)}</> : r.body.rows.filter((row) => row.original_id === original.original_id).map((row) => <p><a href={target} target="_blank">{row.household_name} / {row.ward_group}</a>（写真全体・{row.locator}）</p>)}
          </details>)}</div>
        </div>; })}
        <p class="link-line"><a href={adminPath(ward, `/projects/${projectId}/map`)}>段取りで、変わった仕事を見る</a></p>
      </section>;
    }))}
    {jobs.length === 0 ? <p>まだ資料は入っていません。</p> : null}
    <h2>資料から変わったところ</h2>
    {changes.results.map((change) => <p>{changeTargetLabel(change.kind, change.target)} — {change.status === "applied" ? "中身に入りました" : change.status === "same" ? "同じものでした" : change.status === "conflict" ? "食い違いとして並びました" : change.status === "kept" ? "今の中身を残しました" : change.status === "held" ? "確認待ちです" : change.status === "dropped" ? `取り込めませんでした${change.reason ? `: ${change.reason}` : ""}` : "記録しました"}{change.source_locator ? `（${change.source_locator}）` : ""}</p>)}
    {changes.results.length === 0 ? <p>まだ変わったところはありません。</p> : null}
    <h2>今年の中身</h2>
    <p>今年の中身がない項目には、去年までの資料を参考として並べます。</p>
    {state.items.map((item) => <section class="panel"><strong>{item.label}</strong><p>{item.current?.content ?? "まだ入っていません"}</p>{item.references.map((v) => <p>参考（{v.refYear === null ? "年不明" : `${v.refYear}年`}）: {v.content}</p>)}</section>)}
    <h2 id="ledger">運営メモ</h2>
    <p>何に、どこに、いくらかけたか、来年のためのメモです。領収書や見積りの写真からも入ります。</p>
    <div class="action-links"><a class="button secondary" href={adminPath(ward, `/projects/${projectId}/ledger`)}>運営メモを開く</a></div>
    {ledgerRows.length === 0 ? <p>収支の記録はまだありません。領収書の写真を送ると、ここに入ります。</p> : <table class="stack"><thead><tr><th>相手</th><th>収入か支出</th><th>額</th><th>日付</th><th>メモ</th></tr></thead><tbody>{ledgerRows.map((row) => <tr><td class="link-line" data-label="相手"><a href={adminPath(ward, `/projects/${projectId}/ledger/${row.rowId}`)}>{row.data.counterpart}</a></td><td data-label="収入か支出">{displayFieldValue("ledger", "direction", row.data.direction)}</td><td data-label="額">{typeof row.data.amount === "number" ? displayFieldValue("ledger", "amount", row.data.amount) : "確かめ中"}</td><td data-label="日付">{displayFieldValue("ledger", "date", row.data.date)}</td><td data-label="メモ">{row.data.note}</td></tr>)}</tbody></table>}
    <h2>文書</h2>
    {state.documents.map((d) => <p>{DOCUMENT_KIND_LABEL[d.kind]} / {SCOPE_LABEL[d.scope]}{d.stale ? " / 新しい資料が入っています" : ""}</p>)}
    <a class="quiet" href={adminPath(ward, `/projects/${projectId}/draft`)}>下書きの一覧を開く</a>
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
  return c.redirect(`${adminPath(ward, `/projects/${id}/questions`)}?${ok ? `notice=${action === "answer" ? "answered" : action}` : "error=answer_failed"}`, 303);
});

export { admin as projectAdmin };
export const project: Bundle = { admin };
