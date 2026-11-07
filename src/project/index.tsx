import { taskFeatures, taskItemKeys } from "./task-features";
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
import { PROJECT_KINDS, PROJECT_KIND_LABEL, TABLE_KEYS, type TableKey, isItemKey, DEADLINE_LABEL, ITEM_SCREEN_LABEL, TABLES, countWord, rowDisplayName, displayFieldValue, DOCUMENT_KIND_LABEL, SCOPE_LABEL, type RowData } from "./model";
import { setProjectApi } from "../ai/project-binding";
import { agentApi } from "./agent-api";
import { MAP_TEMPLATES } from "../map/template";
import { daysRemaining, followupAdmin, dateWords, openInquiries } from "./followup";
import { inquirySubject } from "./inquiry-send";
import { questionPages, questionShort } from "./question-pages";
import type { ProjectState } from "./types";
import { markMaterialThisYear, unknownYearContents } from "./material-year";
import { committeePages } from "./committee";
import { startTemplate, startTemplateText, type StartTemplate } from "./start-template";
import { addYearItem } from "../know/year";
import { copySeed } from "../archive";

/** 変わった所の対象を、内部の鍵ではなく画面の言葉で示す。 */
function changeTargetLabel(kind: string, target: string, state: ProjectState): string {
  if (isItemKey(target)) return ITEM_SCREEN_LABEL[target];
  if (kind === "map_task") {
    const task = Object.values(MAP_TEMPLATES).flat().find((entry) => entry.key === target);
    return `やること　${task?.name ?? target}`;
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
    const row = state.tables[table as TableKey].find((entry) => entry.matchKey === target.slice(at + 1));
    return `${TABLES[table as TableKey].label}　${row ? rowDisplayName(table as TableKey, row.data) : words.join(" ")}`;
  }
  return target.replaceAll("|", " ");
}

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "choose_kind": "名前を入れてください",
  "need_title": "名前を入れてください",
  "open_failed": "始められませんでした",
  "invalid_kind": "種類が合いません",
  "invalid_title": "題は1文字から100文字にしてください",
  "invalid_year": "年が合いません",
  "invalid_day": "始まる日を入れ直してください",
  "invalid_end": "終わる日は始まる日以降にしてください",
  "seed_missing": "もとにするものが見つかりません",
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
  // 何の準備かは聞かない（決定ログ L-312、L-313）。一年の表の予定から来た時は名前が決まっているので、何を置くかを一文で書き、ボタンを一つにする。
  const presetTitle = c.req.query("title")?.slice(0, 100) ?? "";
  const template = presetTitle ? startTemplate(presetTitle, allProjects) : null;
  return c.html(<Layout title="新しく準備を始める" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, presetTitle ? "/year" : "/")}>← {presetTitle ? "この自治会の一年へ" : "最初の画面へ"}</a>
    <h1>{presetTitle ? `今年の${presetTitle}を始める` : "新しく準備を始める"}</h1>
    <p class="lead">{template ? startTemplateText(presetTitle, template) : "去年の同じものが「終わったもの」にあれば、そこから始められます。一年の予定にないものは、名前とだいたいの時期を入れると、一年の予定に足して、知らせる、当日、まとめるの三つだけのやることで始めます。あとで足したり外したりできます。"}</p>
    <ErrorNotice code={c.req.query("error")} messages={ERROR_MESSAGES} />
    {!presetTitle && seeds.length ? <><h2>去年の終わったものから始める</h2><ul class="rows">{[...seeds].sort((a, b) => b.year - a.year).slice(0, 3).map((project) => <li><a class="row-link" href={adminPath(ward, `/archive/${project.projectId}`)}><b>{project.year}年 {project.title}</b></a></li>)}</ul>{seeds.length > 3 ? <p><a class="quiet" href={adminPath(ward, "/archive")}>ほかの終わったものから始める</a></p> : null}</> : null}
    <form method="post" action={adminPath(ward, "/projects")}>
      {presetTitle ? <><input type="hidden" name="title" value={presetTitle} />
        <div class="field"><label for="eventDay">今年の当日（分かれば）</label><input id="eventDay" name="eventDay" type="date" /><p class="help-text">入れると、準備を始める頃と報告をまとめ終える頃を置きます。あとで直せます。</p></div>
        <div class="field"><label for="eventEnd">終わる日（一日だけなら空のまま）</label><input id="eventEnd" name="eventEnd" type="date" /></div></>
        : <><h2>一年の予定に足す</h2>
        <div class="field"><label for="title">名前（あとで直せます）</label><input id="title" name="title" maxlength={100} placeholder="秋の収穫祭" required /><p class="help-text">「秋の収穫祭」「定期総会」「ごみ当番」のように、ふだん呼んでいる名前で入れてください。</p></div>
        <div class="field"><label for="month">だいたいの時期</label><select id="month" name="month"><option value="">まだ分からない</option>{[4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3].map((month) => <option value={String(month)}>{month}月</option>)}</select><p class="help-text">一年の表のその月に置きます。日が決まったら、やることの画面で入れられます。</p></div></>}
      <input type="hidden" name="year" value={new Date().getFullYear()} />
      <div class="action-bar page-action"><button type="submit">{presetTitle ? `今年の${presetTitle}を始める` : "一年の予定に足して始める"}</button></div>
    </form>
  </Layout>);
});

admin.get("/projects/today", async (c) => {
  const { ward } = c.var;
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const projects = await listProjects(c.env.DB, ward.wardId);
  // 今やることに使う行だけを区の分まとめて読む。各準備の全状態は読まない。
  const [tasks, openQuestions] = await Promise.all([
    c.env.DB.prepare(`SELECT t.project_id, t.task_id, t.name, t.period_end FROM project_map_tasks t
      JOIN projects p ON p.ward_id = t.ward_id AND p.project_id = t.project_id
      WHERE t.ward_id = ? AND p.closed_at IS NULL AND t.removed_at IS NULL AND t.progress <> 'done'
        AND t.period_end IS NOT NULL AND t.period_end <> '' AND (t.task_key IS NULL OR t.task_key <> 'day')
      ORDER BY t.sort_order, t.created_at`).bind(ward.wardId)
      .all<{ project_id: string; task_id: string; name: string; period_end: string }>(),
    c.env.DB.prepare(`SELECT q.project_id, q.question_id FROM project_questions q
      JOIN projects p ON p.ward_id = q.ward_id AND p.project_id = q.project_id
      WHERE q.ward_id = ? AND p.closed_at IS NULL AND q.state IN ('open', 'later')
      ORDER BY q.created_at, q.question_id`).bind(ward.wardId)
      .all<{ project_id: string; question_id: string }>(),
  ]);
  const tasksByProject = new Map<string, typeof tasks.results>();
  for (const task of tasks.results) {
    const list = tasksByProject.get(task.project_id) ?? [];
    list.push(task);
    tasksByProject.set(task.project_id, list);
  }
  const questionsByProject = new Map<string, typeof openQuestions.results>();
  for (const question of openQuestions.results) {
    const list = questionsByProject.get(question.project_id) ?? [];
    list.push(question);
    questionsByProject.set(question.project_id, list);
  }
  const entries: Array<{ date: string | null; until?: boolean; taskId?: string; projectId: string; project: string; label: string; detail: string; href: string }> = [];
  for (const project of projects) {
    for (const [kind, date] of Object.entries(project.deadlines)) {
      if (kind === "event_day" && date < today) continue;
      entries.push({ date, projectId: project.projectId, project: project.title, label: DEADLINE_LABEL[kind as keyof typeof DEADLINE_LABEL], detail: "", href: kind === "submit_due" ? `/requests/city/${project.projectId}` : kind === "answer_due" ? `/answers/${project.projectId}` : `/projects/${project.projectId}/map` });
    }
    for (const task of tasksByProject.get(project.projectId) ?? []) {
      entries.push({ date: task.period_end, until: true, taskId: task.task_id, projectId: project.projectId, project: project.title, label: task.name, detail: "", href: `/projects/${project.projectId}/map/${task.task_id}` });
    }
    for (const question of questionsByProject.get(project.projectId) ?? []) {
      entries.push({ date: null, projectId: project.projectId, project: project.title, label: "質問", detail: "", href: `/projects/${project.projectId}/questions#question-${question.question_id}` });
    }
  }
  entries.sort((a, b) => (a.date ?? "9999-99-99").localeCompare(b.date ?? "9999-99-99") || a.project.localeCompare(b.project, "ja"));
  const undecided = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM line_inbox_items i LEFT JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id WHERE i.ward_id = ? AND i.disposition = 'unmatched' AND j.project_id IS NULL").bind(ward.wardId).first<{ n: number }>())?.n ?? 0;
  const inquiries = (await openInquiries(c.env.DB, ward.wardId)).filter(({ group }) => group[0]!.kind === "inquiry");
  const dated = entries.filter((entry) => entry.date);
  const late = dated.filter((entry) => entry.date! < today && entry.taskId);
  const coming = dated.filter((entry) => !late.includes(entry));
  const questions = entries.filter((entry) => !entry.date);
  const row = (entry: (typeof entries)[number]) => <li><a class="row-link" href={adminPath(ward, entry.href)}><b>{entry.project}　{entry.label}</b><span>{`${entry.until ? `${shortDate(entry.date!)}まで` : formatJstDate(entry.date!)}　${daysRemaining(entry.date!)}`}</span></a>
    {entry.taskId ? <form method="post" action={adminPath(ward, `/projects/${entry.projectId}/map/${entry.taskId}/done`)}><input type="hidden" name="back" value="today" /><button class="quiet">済みにする</button></form> : null}</li>;
  return c.html(<Layout title="今やること" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/")}>← 最初の画面へ</a><h1>今やること</h1>
    {c.req.query("notice") === "done" ? <Notice>済みにしました。戻すときは、やることでその仕事を開きます。</Notice> : null}
    {undecided ? <section class="next"><strong>届いたもの{undecided}件が、どれの資料か決める</strong><p>どれの資料か、AIが決められなかったものです。</p><a class="button" href={adminPath(ward, "/inbox")}>届いたものを見る</a></section> : null}
    {inquiries.length ? <ul class="rows">{inquiries.slice(0, 3).map(({ group }) => <li><a class="row-link" href={adminPath(ward, `/inquiries/${encodeURIComponent(group[0]!.inquiry_id)}`)}><b>問い合わせ「{inquirySubject(group[0]!.subject)}」</b><span>送った人: {group[0]!.sender}</span><span>{(dateWords(group[0]!.subject).length ? `急ぎかもしれません（${dateWords(group[0]!.subject).map((word) => `「${word}」`).join("")}とあります）。` : "") || `${formatJstDate(group[0]!.received_at)}に届きました`}</span></a></li>)}</ul> : null}
    {entries.length === 0 ? <><div class="notice" role="status"><strong>今やることはありません</strong><p>締切が近づくと、ここに並びます。</p></div><section class="next"><strong>次は</strong><p>手元に資料があれば、送っておけます。</p><a class="button" href={adminPath(ward, "/intake")}>資料を送る</a></section></> : <><p class="lead">締切の近い順に並べています。どれから始めてもかまいません。押すと、その仕事の画面が開きます。</p>
    {coming.length ? <><h2>これからの仕事</h2><ul class="rows">{coming.map(row)}</ul></> : null}
    {late.length ? <><h2>時期を過ぎた仕事</h2><p class="muted">終わっているものは「済みにする」を押してください。まだのものは、開くと時期を直せます。</p><ul class="rows">{late.map(row)}</ul></> : null}
    {questions.length ? <p class="link-line"><a href={adminPath(ward, questions[0]!.href.split("#")[0]!)}>AIからの質問（{questions.length}件）を見る</a></p> : null}
    {questions.length ? <p class="muted">質問は、分かるものだけ答えてください。答えなくても進められます。</p> : null}</>}
  </Layout>);
});

admin.post("/projects", async (c) => {
  const { ward, account } = c.var; const form = await c.req.formData();
  // 画面では名前を必ず聞く。種類を渡す中の道（通しの道具など）は、名前が無い時は種類の名前を仮の名前にする。
  const passedKind = PROJECT_KINDS.find((kind) => kind === form.get("kind"));
  const title = String(form.get("title") ?? "").trim() || (passedKind ? PROJECT_KIND_LABEL[passedKind] : "");
  if (!title) return c.redirect(`${adminPath(ward, "/projects")}?error=need_title`, 303);
  // 種類は聞かない（決定ログ L-312）。去年の同じ予定の並び、一年の予定ごとの型、短い一般の型の順で置く。
  const formKind = PROJECT_KINDS.find((kind) => kind === form.get("kind"));
  const past = await listProjects(c.env.DB, ward.wardId, { includeClosed: true });
  const template: StartTemplate = formKind ? { kind: formKind, from: "year_plan" } : startTemplate(title, past);
  try {
    const project = await createProject(c.env.DB, ward.wardId, { kind: template.kind, title, ...(template.taskKeys ? { taskKeys: template.taskKeys } : {}), ...(template.seedProjectId ? { seedProjectId: template.seedProjectId } : {}), year: Number(form.get("eventDay") ? String(form.get("eventDay")).slice(0, 4) : form.get("year")), ...(form.get("eventDay") ? { eventDay: String(form.get("eventDay")) } : {}), ...(form.get("eventEnd") ? { eventEnd: String(form.get("eventEnd")) } : {}), accountId: account.accountId });
    // 去年の同じ予定の準備があれば、そのやることの並びを写す（終わったものから始める時と同じ写し方）。
    const seed = template.seedProjectId ? past.find((entry) => entry.projectId === template.seedProjectId) : undefined;
    if (seed) await copySeed(c.env.DB, ward.wardId, seed.projectId, project.projectId, seed.year, form.get("eventDay") ? String(form.get("eventDay")) : null);
    // 一年の予定に無い物は、名前とだいたいの時期で一年の予定に足す。来年は去年の並びから始まる（L-313）。
    if (template.from === "short") {
      const chosen = Number(form.get("month"));
      const month = chosen >= 1 && chosen <= 12 ? chosen : form.get("eventDay") ? Number(String(form.get("eventDay")).slice(5, 7)) : null;
      const already = await c.env.DB.prepare("SELECT 1 FROM ward_year_items WHERE ward_id = ? AND title = ? AND removed_at IS NULL").bind(ward.wardId, title).first();
      if (!already) await addYearItem(c.env.DB, ward.wardId, { title, month, dateText: "", originalId: null });
    }
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
  const [project, state, jobs, changes] = await Promise.all([getProjectSummary(c.env.DB, ward.wardId, projectId), getProjectState(c.env.DB, ward.wardId, projectId), listJobs(c.env.DB, ward.wardId, { projectId, limit: 40 }), c.env.DB.prepare("SELECT kind, target, status, reason, source_locator, source_kind FROM project_changes WHERE ward_id = ? AND project_id = ? AND pack_version <> 'close-map-edit@1' ORDER BY created_at DESC LIMIT 30").bind(ward.wardId, projectId).all<{ kind: string; target: string; status: string; reason: string | null; source_locator: string | null; source_kind: string | null }>()]);
  if (!project || !state) return c.notFound();
  const features = taskFeatures(state.mapTasks);
  const visibleItems = new Set(taskItemKeys(state.mapTasks));
  const unknown = unknownYearContents(state);
  const unknownOriginalIds = new Set([...unknown.items, ...unknown.rows].map((value) => value.source.ref));
  return c.html(<Layout title="今年の内容" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, `/projects/${projectId}/map`)}>← {project.title}のやることへ</a>
    <h1>{project.title}の届いた資料と今年の内容</h1><p class="lead">届いた資料と、そこから読み取った今年の内容が見られます。</p>
    <nav class="action-links">
      {state?.questions.length ? <a class="button" href={adminPath(ward, `/projects/${projectId}/questions`)}>AIからの質問に答える</a> : null}
      <a class={state?.questions.length ? "button secondary" : "button"} href={adminPath(ward, `/intake?project=${encodeURIComponent(projectId)}`)}>資料を送る</a>
    </nav>
    <p class="muted">{project.title}　{project.year}年</p>
    <ErrorNotice code={c.req.query("error")} messages={ERROR_MESSAGES} />
    <details class="fold"><summary>名前を直す</summary><form method="post" action={adminPath(ward, `/projects/${projectId}/title`)}><label for="title">名前</label><input id="title" name="title" value={project.title} maxlength={100} required /> <button class="secondary">名前を保存する</button></form></details>
    <ul class="rows"><li><a class="row-link" href={adminPath(ward, `/projects/${projectId}/questions`)}><b>質問{state.questions.length ? `が${countWord(state.questions.length)}あります` : "はありません"}</b><span>答えなくても知らせられます。</span></a></li></ul>
    <h2 id="materials">届いた資料</h2>
    {await Promise.all(jobs.map(async (job) => {
      const originals = await listOriginals(c.env.DB, ward.wardId, job.job_id);
      const readings = await getReadings(c.env.DB, ward.wardId, job.job_id);
      const yearOriginals = originals.filter((original) => !project.closedAt && !original.withdrawn_at && unknownOriginalIds.has(original.original_id));
      return <section class="panel"><b>{job.first_filename || "書いたこと"}</b><p class="muted">{job.status === "done" ? originals.some((original) => materialChangeText(state, original.original_id)) ? "読み終わりました。今年の内容に入れました" : "読み終わりました" : job.status === "failed" ? "読めませんでした" : "読み取りを進めています"}</p>
        <div class="material-links">{originals.map((original, index) => <a class="quiet" href={adminPath(ward, `/intake/originals/${original.original_id}`)}>元の資料を見る{originals.length > 1 ? `（${index + 1}枚目）` : ""}</a>)}</div>
        {readings.length ? <details class="hint"><summary>読み取った内容</summary><div>{readings.map((r) => <><p>{r.body.summary}</p>
          {"fields" in r.body ? <>{r.body.fields.map((f) => <p>{f.name}: {f.value}（{f.locator}。{f.confidence === "high" ? "はっきり読めました" : f.confidence === "medium" ? "少し読みにくい字でした" : "読みにくい字でした"}）</p>)}{r.body.text_blocks.map((b) => <p>{b.text}（{b.locator}）</p>)}
            {/* 表の中にある日時や担当も、文と同じく読めるように出す。Word の表や Excel は、ここに中身の大事な所がある。 */}
            {r.body.tables.map((table) => <div class="read-table"><table><caption>{table.name}</caption>{table.columns.length ? <thead><tr>{table.columns.map((column) => <th>{column}</th>)}</tr></thead> : null}<tbody>{table.rows.map((row) => <tr>{row.cells.map((cell) => <td>{cell}</td>)}</tr>)}</tbody></table></div>)}</> : r.body.rows.map((row) => <p>{row.household_name} / {row.ward_group}（{row.locator}）</p>)}
        </>)}</div></details> : null}
        {yearOriginals.length ? <form method="post" action={adminPath(ward, `/projects/${projectId}/materials/${yearOriginals[0]!.original_id}/this-year`)}>
          {yearOriginals.slice(1).map((original) => <input type="hidden" name="also" value={original.original_id} />)}
          <p class="muted">年が書かれていません。去年のものなら、そのままで大丈夫です。</p><button type="submit" class="secondary">この資料は今年のもの</button><Hint text={`${project.year}年の資料として内容を入れ直します。今年の内容と違うところは、上書きせず質問に並びます。質問に答えなくても知らせられます。`} />
        </form> : null}
        {job.status === "failed" ? <form method="post" action={adminPath(ward, `/intake/${job.job_id}/retry`)}><button class="secondary">もう一度読む</button></form> : null}
      </section>;
    }))}
    {jobs.length === 0 ? <p>まだ資料は入っていません。</p> : null}
    <a class="quiet" href={adminPath(ward, `/projects/${projectId}/map`)}>やることで、変わった仕事を見る</a>
    <h2>資料から変わったところ</h2>
    <ul class="rows">{changes.results.map((change) => <li class="panel"><b>{changeTargetLabel(change.kind, change.target, state)}</b><p>{change.status === "applied" ? change.reason === ROW_REMOVED ? "外しました" : change.kind === "map_task" ? "済みにしました" : "今年の内容に入れました" : change.status === "same" ? "同じでした" : change.status === "conflict" ? "食い違いとして並びました" : change.status === "kept" ? "今の内容を残しました" : change.status === "held" ? "確認待ちです" : change.status === "dropped" ? `取り込めませんでした${change.reason ? `: ${change.reason}` : ""}` : "記録しました"}{change.source_locator && change.source_kind === "original" ? `（${change.source_locator}）` : ""}</p></li>)}</ul>
    {changes.results.length === 0 ? <p>まだ変わったところはありません。</p> : null}
    <h2>今年の内容</h2>
    <p class="lead">今年の内容がない項目には、去年までの資料を参考として並べます。</p>
    <dl class="facts">{state.items.filter((item) => visibleItems.has(item.key) || item.current || item.references.length).map((item) => <><dt>{ITEM_SCREEN_LABEL[item.key]}</dt><dd>{item.current?.content ?? "まだ書かれていません"}{item.references.map((v) => <span class="muted block">参考（{v.refYear === null ? "年不明" : `${v.refYear}年`}）: {v.content}</span>)}</dd></>)}</dl>
    {features.committee ? <><h2>実行委員名簿</h2><ul class="links"><li><a href={adminPath(ward, `/projects/${projectId}/committee`)}>実行委員名簿を見て直す</a></li></ul></> : null}
    <h2 id="ledger">運営メモ</h2>
    <p>何に、どこに、いくらかけたか、来年のためのメモです。領収書や見積りの写真からも入ります。</p>
    <ul class="links"><li><a href={adminPath(ward, `/projects/${projectId}/ledger`)}>運営メモを開く</a></li></ul>

    <h2>文書</h2>
    <ul class="rows">{state.documents.map((d) => <li class="panel"><b>{DOCUMENT_KIND_LABEL[d.kind]}</b><p class="muted">{d.scope === "public" ? "だれでも読める" : SCOPE_LABEL[d.scope]}{d.stale ? "　新しい資料が入っています" : ""}</p></li>)}</ul>
    <ul class="links"><li><a href={adminPath(ward, `/projects/${projectId}/draft`)}>下書きの一覧を開く</a></li></ul>
  </Layout>);
});

admin.post("/projects/:projectId/title", async (c) => { const { ward } = c.var; const f = await c.req.formData(); await renameProject(c.env.DB, ward.wardId, c.req.param("projectId"), String(f.get("title") ?? "")); return c.redirect(adminPath(ward, `/projects/${c.req.param("projectId")}`), 303); });
admin.post("/projects/:projectId/materials/:originalId/this-year", async (c) => {
  const { ward, account } = c.var;
  const projectId = c.req.param("projectId");
  // 一件の資料に写真が何枚あっても、押すのは一度で済むようにする。
  const form = await c.req.formData();
  let ok = true;
  for (const originalId of [c.req.param("originalId"), ...form.getAll("also").map(String)]) {
    ok = await markMaterialThisYear(c.env.DB, ward.wardId, projectId, originalId, account.accountId) && ok;
  }
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
