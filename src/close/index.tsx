import { adminResult } from "../core/admin-ui";
import { formatDateText, formatJstDate } from "../core/time";
import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { adminPath } from "../core/auth";
import { ErrorNotice, Notice } from "../core/ui";
import { AdminPage } from "../core/admin-ui";
import { newId, nowIso } from "../core/ids";
import type { AdminEnv } from "../env";
import type { Waitable } from "../intake/types";
import { startTask } from "../ai/api";
import { getProjectSummary } from "../project/api";
import { listAnswers } from "../answers/api";
import { countMeetingAnswers } from "../answers/meeting-store";
import { meetingTotalsText } from "../answers/meeting";
import { getEditableDocument, saveDocument } from "../project/actions";
import { MAP_PROGRESS_LABEL, type MapProgress } from "../project/model";
import { checkPublicDraft } from "../check";
import { getDraftPack } from "../draft/packs";
import { getPublicContact } from "../settings/store";
import { activityFacts } from "../ward/activity";
import { documentText } from "../draft/meeting-materials";
import { meetingDecisionDraft, meetingDecisionStatements } from "./decisions";

interface CloseTask { task_id: string; name: string; period_start: string | null; period_end: string | null; progress: MapProgress; }
interface CloseEntry extends CloseTask { period: string; requested_by: string; difficulty: string; next_year: string; }
interface ActivityTaskEdit { taskId: string; name: string; period: string; }
interface ActivityBody { introduction: string; membershipBurden: string; membershipBenefit: string; tasks: ActivityTaskEdit[]; }
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "activity_input": "活動の紹介、加入で担うこと、得られることを入力してください",
  "activity_private": "公開に出せない情報が含まれる可能性があります。文章と仕事の一覧を見直してください",
  "answers_closed": "この行事は閉じました。答えを直すときは「もう一度開く」を押してください。",
  "map_closed": "この行事は閉じました。段取りを直すときは「もう一度開く」を押してください。",
  "minutes_save": "議事録を保存できませんでした。内容を確かめて、もう一度閉じてください。",
  "decisions_long": "決めたことは全体で12000文字まで、1行2000文字までで書いてください。"
};

const admin = new Hono<AdminEnv>();

function parseActivityBody(raw: string | null | undefined): ActivityBody | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const body = value as Partial<ActivityBody>;
    if (typeof body.introduction !== "string" || typeof body.membershipBurden !== "string" || typeof body.membershipBenefit !== "string" || !Array.isArray(body.tasks)) return null;
    const tasks = body.tasks.filter((task): task is ActivityTaskEdit => typeof task === "object" && task !== null &&
      typeof task.taskId === "string" && typeof task.name === "string" && typeof task.period === "string");
    return { introduction: body.introduction, membershipBurden: body.membershipBurden, membershipBenefit: body.membershipBenefit, tasks };
  } catch { return null; }
}

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
    .bind(wardId, projectId, task.task_id, [task.period_start, task.period_end].filter((date): date is string => !!date).map(formatJstDate).join(" 〜 "), task.name, task.progress, now, accountId));
  for (const scope of ["public", "staff"] as const) stmts.push(db.prepare(`INSERT OR IGNORE INTO project_close_reports (ward_id, project_id, scope, body, updated_at, updated_by_account_id) VALUES (?, ?, ?, '', ?, ?)`)
    .bind(wardId, projectId, scope, now, accountId));
  if (stmts.length) await db.batch(stmts);
  return true;
}

/** 報告の文書の最新の中身（AI の下書きか、役員が保存した物）。閉じる画面の欄と、閉じる時の記録に使う。 */
async function generatedReportText(db: D1Database, wardId: string, projectId: string): Promise<string> {
  const row = await db.prepare(`SELECT v.body FROM documents d JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = 'report' AND d.scope = 'public' AND v.scope = 'public'
    ORDER BY v.version_no DESC LIMIT 1`).bind(wardId, projectId).first<{ body: string }>();
  if (!row?.body) return "";
  try {
    const parsed = JSON.parse(row.body) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch { return ""; }
}

/**
 * 閉じる時の報告の指示。案の部品と同じ包み（下書きの形と based_on_state_version の決め）を使う。
 * 形を書かない指示では、AI の下書きが保存の検査で捨てられ、報告が空のまま残った。
 */
function reportInstruction(contact: string, meetingSummary?: string): string {
  const pack = getDraftPack("report");
  return `${pack.instruction}${meetingSummary === undefined ? "" : `
今回は総会です。行事の人数と回答票についての指示は使いません。答えは世帯ごとの出席・委任・欠席です。参加する人数や当日の出席人数に置き換えず、次の集計をそのまま使ってください。${meetingSummary}。総会が成り立つかは判定しません。委任する相手や答えた人の名前は公開の報告に書きません。`}
閉じるときの実施報告です。住民に向けた公開の報告だけを書きます。役員だけの記録は書かず、役員が自分で書きます。人数や出来事は状態にある今年の事実だけにし、分からないところは空欄のまま役員への質問にします。${contact ? `\n区の公開用の連絡先（問い合わせ先に使う）: ${contact}` : ""}
対象の文書: ${pack.kind}。範囲: ${pack.scope}。dataにpack_versionを${pack.version}、based_on_state_versionを引いた状態の番号として含めてください。`;
}

admin.get("/close/:projectId", async (c) => {
  const { ward } = c.var; const id = c.req.param("projectId");
  const project = await getProjectSummary(c.env.DB, ward.wardId, id);
  if (!project) return c.notFound();
  const minutes = project.kind === "board_meeting" || project.kind === "general_meeting";
  if (!project.closedAt && !(await prepareDrafts(c.env.DB, ward.wardId, id, c.var.account.accountId))) return c.notFound();
  if (!project.closedAt && c.req.query("reopened")) return c.html(<AdminPage ward={ward} account={c.var.account} title="もう一度開きました">
    <h1>もう一度開きました</h1><p class="lead">{minutes ? "議事録と段取りを直せます。" : "報告と段取りを直せます。"}</p>
    <section class="next"><strong>次は</strong><p>{minutes ? "残した議事録を書き直せます。" : "段取りから仕事を続けられます。"}</p><a class="button" href={adminPath(ward, minutes ? `/close/${id}#report-staff` : `/projects/${id}/map`)}>{minutes ? "議事録を直す" : "段取りへ"}</a></section>
    <p>開き間違えたときは、閉じる画面で、もう一度「閉じて記録に残す」を押せます。</p><a class="quiet" href={adminPath(ward, `/close/${id}`)}>閉じる画面に戻る</a>
  </AdminPage>);
  const [tasks, reports, status, generatedReport, activityPage] = await Promise.all([
    c.env.DB.prepare(`SELECT m.task_id, m.name, m.period, m.progress, m.requested_by, m.difficulty, m.next_year FROM project_close_map m
      LEFT JOIN project_map_tasks t ON t.ward_id = m.ward_id AND t.task_id = m.task_id
      WHERE m.ward_id = ? AND m.project_id = ? ORDER BY t.sort_order, m.task_id`)
      .bind(ward.wardId, id).all<CloseEntry>(),
    c.env.DB.prepare("SELECT scope, body FROM project_close_reports WHERE ward_id = ? AND project_id = ? ORDER BY scope")
      .bind(ward.wardId, id).all<{ scope: "public" | "staff"; body: string }>(),
    c.env.DB.prepare("SELECT task, status FROM jobs WHERE ward_id = ? AND project_id = ? AND task IN ('report', 'map_draft') ORDER BY created_at DESC LIMIT 2")
      .bind(ward.wardId, id).all<{ task: string; status: string }>(),
    generatedReportText(c.env.DB, ward.wardId, id),
    c.env.DB.prepare("SELECT draft_body, published_at FROM project_activity_pages WHERE ward_id = ? AND project_id = ?")
      .bind(ward.wardId, id).first<{ draft_body: string; published_at: string | null }>(),
  ]);
  const minutesDocument = minutes ? await getEditableDocument(c.env.DB, ward.wardId, id, "report") : null;
  const decisions = minutes && !project.closedAt ? await meetingDecisionDraft(c.env.DB, ward.wardId, project) : null;
  const report = (scope: "public" | "staff") => reports.results.find((r) => r.scope === scope)?.body ||
    (scope === "public" ? generatedReport : minutesDocument?.scope === "staff" ? documentText(minutesDocument.body) : "");
  const root = adminPath(ward, `/close/${id}`);
  const activityView = c.req.query("view") === "activity";
  if (activityView && (c.req.query("activity") === "saved" || c.req.query("activity") === "published")) {
    const published = c.req.query("activity") === "published";
    const message = published ? "区のページに載せました" : "紹介の下書きを保存しました";
    return c.html(<AdminPage ward={ward} account={c.var.account} title={message} back={{ href: root, label: "← 閉じた画面へ" }}>
      <h1>{message}</h1>{!published ? <p class="lead">直した内容は、まだ区のページに載せていません。</p> : null}<section class="next"><strong>次は</strong><p>{published ? "載せた紹介を読めます。" : "下書きを直して、区のページに載せられます。"}</p><a class="button" href={published ? `/${ward.slug}/work/${encodeURIComponent(id)}` : `${root}?view=activity`}>{published ? "区のページで見る" : "紹介の下書きを直す"}</a></section><a class="quiet" href={`${root}?view=activity`}>紹介を直す</a>
    </AdminPage>);
  }
  const savedActivity = parseActivityBody(activityPage?.draft_body);
  // 前の年に実際に掲載した文だけを引き継ぐ。無いときは作らない。
  const previous = activityView && !savedActivity ? await c.env.DB.prepare(`SELECT a.published_body FROM project_activity_pages a
    JOIN projects p ON p.ward_id = a.ward_id AND p.project_id = a.project_id
    WHERE a.ward_id = ? AND p.year < ? AND p.kind = ? AND a.published_body IS NOT NULL
    ORDER BY CASE WHEN p.project_id = (SELECT seed_project_id FROM projects WHERE ward_id = ? AND project_id = ?) THEN 0 ELSE 1 END, p.year DESC, a.published_at DESC LIMIT 1`)
    .bind(ward.wardId, project.year, project.kind, ward.wardId, id).first<{ published_body: string }>() : null;
  const previousActivity = parseActivityBody(previous?.published_body);
  const activity = savedActivity ?? { introduction: report("public"), membershipBurden: previousActivity?.membershipBurden ?? "", membershipBenefit: previousActivity?.membershipBenefit ?? "", tasks: tasks.results.filter((task) => task.progress === "done").map((task) => ({ taskId: task.task_id, name: task.name, period: task.period })) };
  const recordedActivity = activityView ? await activityFacts(c.env.DB, ward.wardId, id, activity.tasks) : null;
  const warnings = !project.closedAt && !activityView ? await checkPublicDraft(c.env.DB, ward.wardId, id, "report", { text: report("public"), items: [] }) : [];
  const title = activityView ? "役員の仕事を紹介する" : `${project.title}を${project.closedAt ? "閉じました" : "閉じる"}`;
  return c.html(<AdminPage ward={ward} account={c.var.account} title={title}
    back={activityView ? { href: root, label: "← 閉じた画面へ" } : !project.closedAt ? { href: adminPath(ward, `/projects/${id}/map`), label: `← ${project.title}の段取りへ` } : undefined}>
    <h1>{title}</h1><ErrorNotice code={c.req.query("error")} messages={ERROR_MESSAGES} />
    {activityView ? <>
      <p class="lead">報告と段取りから下書きを作りました。直してから区のページに載せてください。</p>
      <form id="activity-form" method="post" action={`${root}/activity`}>
        <div class="field"><label for="activity-intro">この行事で役員がしたこと</label><textarea id="activity-intro" name="introduction" rows={6} maxlength={5000}>{activity.introduction}</textarea></div>
        <div class="field"><label for="activity-burden">加入すると担うこと</label><textarea id="activity-burden" name="membershipBurden" rows={4} maxlength={3000}>{activity.membershipBurden}</textarea><p class="help-text">載せるときに必要です。あとで書いてもかまいません。</p></div>
        <div class="field"><label for="activity-benefit">加入すると得られること</label><textarea id="activity-benefit" name="membershipBenefit" rows={4} maxlength={3000}>{activity.membershipBenefit}</textarea><p class="help-text">載せるときに必要です。あとで書いてもかまいません。</p></div>
        {recordedActivity && (recordedActivity.tasks.length || recordedActivity.facts.length) ? <section>
          <h2>どんな仕事があったか</h2><p>記録から作りました。紹介といっしょに区のページに載ります。</p>
          <ul>{recordedActivity.tasks.map((task) => <li>{task.name}{task.period ? `（${task.period}）` : ""}</li>)}
            {recordedActivity.facts.map((fact) => <li>{fact}</li>)}</ul>
        </section> : null}
        <details class="fold"><summary>載せる仕事を選ぶ</summary><div>{tasks.results.length ? <div class="choice">{tasks.results.map((task) => {
          const saved = activity.tasks.find((entry) => entry.taskId === task.task_id);
          return <label><input type="checkbox" name="taskId" value={task.task_id} checked={!!saved} /> {saved?.name ?? task.name}（{formatDateText(saved?.period ?? task.period) || "時期未定"}）
            <input type="hidden" name={`activityName_${task.task_id}`} value={saved?.name ?? task.name} /><input type="hidden" name={`activityPeriod_${task.task_id}`} value={saved?.period ?? task.period} /></label>;
        })}</div> : <p>残っている仕事はありません。</p>}</div></details>
        <div class="action-bar">{project.closedAt ? <button name="action" value="publish">区のページに載せる</button> : <p>行事を閉じると、区のページに載せられます。</p>}<button class="secondary" name="action" value="save">保存だけする</button></div>
      </form>
    </> : project.closedAt ? <>
      <div class="notice done"><strong>{minutes ? "会議を閉じて、議事録を役員の記録に残しました" : "記録に残しました"}</strong><p>{report("public").trim() ? "報告を区のページに載せました。" : "住民への報告は書かれていません。"}実行委員と班長のページと、答えの受付は終わりました。</p></div>
      <section class="next"><strong>次は</strong><p>{minutes ? "残した議事録を読めます。" : "自治会に入っていない人や、これから役員になるかもしれない人に、どんな仕事だったかを伝えられます。急ぎません。"}</p><a class="button" href={minutes ? `${adminPath(ward, `/archive/${id}`)}#report` : `${root}?view=activity`}>{minutes ? "議事録を読む" : "紹介の下書きを直す"}</a></section>
      {!minutes ? <div class="action-links"><a class="button secondary" href={adminPath(ward, `/archive/${id}`)}>記録を読む</a></div> : null}
      <h2>間違えたときは</h2><p>もう一度開くと、{minutes ? "議事録" : "報告"}と段取りを直せます。答えの受付と、実行委員と班長のページも元に戻ります。</p>
      <form method="post" action={`${root}/reopen`}><div class="action-links"><button class="secondary">もう一度開く</button></div></form>
    </> : <>
      <p class="lead">報告と、来年への一言を残します。閉じたあとももう一度開けます。</p>
      <div class="notice warn"><strong>閉じると消えるものがあります</strong><p>手伝いだけの申し込みの名前と時間帯は消えます。もう一度開いても戻りません。</p></div>
      {status.results.map((job) => <p>{job.task === "report" ? "報告" : "段取り"}: {job.status === "done" ? (job.task === "report" && !report("public") ? "下書きを書けませんでした。下の欄に直接書けます" : "できました") : job.status === "failed" ? "止まりました。下の欄に直接書けます" : "準備中"}</p>)}
      {status.results.some((job) => job.status !== "done" && job.status !== "failed") ? <p class="muted">作っています。画面を閉じても続きます。少しあとに、もう一度開いてください。</p> : null}
      {!report("public") && !status.results.some((job) => job.task === "report" && job.status !== "failed") ? <form method="post" action={`${root}/prepare`}><button class="secondary">報告と段取りの下書きを作る</button><p class="muted">AIが止まっていても、下の欄に直接書けます。</p></form> : null}
      <form method="post" action={`${root}/finalize`}>
        <div class="field"><label for="report-public">住民への報告</label><p class="help-text">{report("public") ? "AIが書いた下書きです。直してかまいません。" : "ここに直接書けます。"}閉じると区のページに載ります。</p><textarea id="report-public" name="body" rows={7} maxlength={12000}>{report("public")}</textarea></div>
        {warnings.length ? <div class="notice warn"><strong>報告の中に見つかったもの</strong><ul>{warnings.map((warning) => <li>{warning}</li>)}</ul><p>書き直せます。このまま閉じることもできます。</p></div> : null}
        <div class="field"><label for="report-staff">{minutes ? "議事録（役員だけ）" : "役員だけの記録（書かなくてかまいません）"}</label><p class="help-text">区のページには載りません。{minutes ? "下書きを直して閉じると、次の会議で読めます。" : ""}</p><textarea id="report-staff" name="body" rows={minutes ? 8 : 4} maxlength={12000}>{report("staff")}</textarea></div>
        {decisions ? <div class="field"><label for="meeting-decisions">決めたこと</label><p class="help-text">{decisions.proposal ? "AIが資料から拾った下書きを含みます。" : ""}1行に一つずつ書けます。違うところは直すか消してください。閉じると、ここに書いたことが次の役員会と総会の資料に残ります。</p>
          <textarea id="meeting-decisions" name="decisions" rows={5} maxlength={12000}>{decisions.text}</textarea>
        </div> : null}
        <h2>来年への一言（書かなくてかまいません）</h2><p class="muted">仕事ごとに、頼んだ人、困ったこと、来年変えることを残せます。来年の段取りに出ます。運営メモに書いたことも、そのまま残ります。ここで書き直さなくてかまいません。</p>
        <a class="quiet" href={adminPath(ward, `/projects/${id}/ledger`)}>運営メモを見る</a>
        {tasks.results.length ? tasks.results.map((task) => <details class="fold" id={`task-${task.task_id}`}><summary>{task.name}</summary><div>
          <input type="hidden" name="taskId" value={task.task_id} />
          <input type="hidden" name="period" value={task.period} /><input type="hidden" name="name" value={task.name} /><input type="hidden" name="progress" value={task.progress} />
          <label for={`requested-${task.task_id}`}>頼んだ人</label><input id={`requested-${task.task_id}`} name="requestedBy" value={task.requested_by} maxlength={160} />
          <label for={`difficulty-${task.task_id}`}>困ったこと</label><textarea id={`difficulty-${task.task_id}`} name="difficulty" rows={2} maxlength={1200}>{task.difficulty}</textarea>
          <label for={`next-${task.task_id}`}>来年変えること</label><textarea id={`next-${task.task_id}`} name="nextYear" rows={2} maxlength={1200}>{task.next_year}</textarea>
        </div></details>) : <p>残っている仕事はありません。報告だけでも閉じられます。</p>}
        <h2>閉じると、こうなります</h2><ul><li>報告が区のページに載ります</li><li>実行委員と班長のページが開けなくなります</li><li>答えの受付が終わります</li></ul>
        <div class="action-bar"><button>閉じて記録に残す</button></div>
      </form>
    </>}
  </AdminPage>);
});

admin.post("/close/:projectId/activity", async (c) => {
  const { ward, account } = c.var; const projectId = c.req.param("projectId"); const form = await c.req.formData();
  const project = await getProjectSummary(c.env.DB, ward.wardId, projectId);
  if (!project) return c.notFound();
  const action = String(form.get("action") ?? "save");
  if (action !== "save" && action !== "publish") return c.notFound();
  if (action === "publish" && !project.closedAt) return adminResult(c, "行事を閉じてから載せられます。", 400, { href: adminPath(c.var.ward, `/close/${encodeURIComponent(c.req.param("projectId"))}`), label: "報告と閉じる画面に戻る" }, "報告と行事の内容を確かめて、もう一度操作してください。");
  const rows = await c.env.DB.prepare(`SELECT m.task_id, m.name, m.period FROM project_close_map m
    LEFT JOIN project_map_tasks t ON t.ward_id = m.ward_id AND t.task_id = m.task_id
    WHERE m.ward_id = ? AND m.project_id = ? ORDER BY t.sort_order, m.task_id`)
    .bind(ward.wardId, projectId).all<{ task_id: string; name: string; period: string }>();
  const selectedIds = new Set(form.getAll("taskId").map(String));
  const selectedTasks = rows.results.filter((row) => selectedIds.has(row.task_id)).map((row) => ({
    taskId: row.task_id,
    name: String(form.get(`activityName_${row.task_id}`) ?? row.name).trim().slice(0, 120),
    period: String(form.get(`activityPeriod_${row.task_id}`) ?? row.period).trim().slice(0, 80),
  }));
  const recordedActivity = await activityFacts(c.env.DB, ward.wardId, projectId, selectedTasks);
  const includedTasks = recordedActivity.tasks;
  const introduction = String(form.get("introduction") ?? "").trim().slice(0, 5000);
  const membershipBurden = String(form.get("membershipBurden") ?? "").trim().slice(0, 3000);
  const membershipBenefit = String(form.get("membershipBenefit") ?? "").trim().slice(0, 3000);
  if (action === "publish" && (!introduction || !membershipBurden || !membershipBenefit)) return c.redirect(`${adminPath(ward, `/close/${projectId}`)}?view=activity&error=activity_input`, 303);
  if (action === "publish") {
    const text = [introduction, membershipBurden, membershipBenefit, ...includedTasks.flatMap((task) => [task.period, task.name])].join("\n");
    const warnings = await checkPublicDraft(c.env.DB, ward.wardId, projectId, "report", { text, items: [] });
    if (warnings.length) return c.redirect(`${adminPath(ward, `/close/${projectId}`)}?view=activity&error=activity_private`, 303);
  }
  // 載せたあとに開き直して記録を直しても、読んで配った紹介は変えない。
  const body = JSON.stringify({ introduction, membershipBurden, membershipBenefit, tasks: includedTasks, facts: recordedActivity.facts });
  const now = nowIso();
  await c.env.DB.prepare(`INSERT INTO project_activity_pages (ward_id, project_id, draft_body, published_body, published_at, updated_at, updated_by_account_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (ward_id, project_id) DO UPDATE SET draft_body = excluded.draft_body,
      published_body = CASE WHEN ? = 1 THEN excluded.published_body ELSE project_activity_pages.published_body END,
      published_at = CASE WHEN ? = 1 THEN excluded.published_at ELSE project_activity_pages.published_at END,
      updated_at = excluded.updated_at, updated_by_account_id = excluded.updated_by_account_id`)
    .bind(ward.wardId, projectId, body, action === "publish" ? body : null, action === "publish" ? now : null, now, account.accountId,
      action === "publish" ? 1 : 0, action === "publish" ? 1 : 0).run();
  return c.redirect(`${adminPath(ward, `/close/${projectId}`)}?view=activity&activity=${action === "publish" ? "published" : "saved"}`, 303);
});

admin.post("/close/:projectId/prepare", async (c) => {
  const { ward, account } = c.var; const id = c.req.param("projectId");
  if (!(await prepareDrafts(c.env.DB, ward.wardId, id, account.accountId))) return c.notFound();
  const contact = await getPublicContact(c.env.DB, ward.wardId);
  const project = await getProjectSummary(c.env.DB, ward.wardId, id);
  const meetingSummary = project?.kind === "general_meeting"
    ? meetingTotalsText(countMeetingAnswers(await listAnswers(c.env.DB, ward.wardId, id))) : undefined;
  try {
    await Promise.all([
      startTask(c.env, waitableContext(c), { wardId: ward.wardId, projectId: id, task: "report", accountId: account.accountId,
        instruction: reportInstruction(contact, meetingSummary) }),
      startTask(c.env, waitableContext(c), { wardId: ward.wardId, projectId: id, task: "map_draft", accountId: account.accountId,
        instruction: "閉じるときの段取りの下書きを状態から作る。元の資料は読まない。状態にある仕事を一つずつ保ち、task_id、period、name、progress（open/started/done）、requested_by、difficulty、next_yearを記録する。時期、進み具合、頼んだ相手、困ったこと、来年変えることは状態にある内容だけを書き、分からない欄は空にして役員への質問にする。仕事を省いたり、過去の参考情報を今年の実績にしたり、内容を補って作らない。write_changeでkind=map_draft、target=map、data={tasks:[...] }を一度書く。" }),
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
  const project = await getProjectSummary(c.env.DB, ward.wardId, id);
  if (!project) return c.notFound();
  if (project.closedAt) return c.redirect(adminPath(ward, `/close/${id}`), 303);
  await prepareDrafts(c.env.DB, ward.wardId, id, account.accountId);
  // 公開の報告を保存していなければ、閉じる画面の欄に出ていた中身（AI の下書き）を記録に残す。閉じる操作のほかに記録のための操作を求めない。
  const form = await c.req.formData();
  const minutes = project.kind === "board_meeting" || project.kind === "general_meeting";
  const decisionText = form.get("decisions");
  if (minutes && typeof decisionText === "string" && (decisionText.length > 12000 || decisionText.split(/\r?\n/).some((line) => line.length > 2000))) {
    return c.redirect(`${adminPath(ward, `/close/${id}`)}?error=decisions_long`, 303);
  }
  const submitted = form.getAll("body");
  const shown = await generatedReportText(c.env.DB, ward.wardId, id);
  const saved = await c.env.DB.prepare("SELECT scope, body FROM project_close_reports WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, id).all<{ scope: string; body: string }>();
  const publicText = submitted.length ? String(submitted[0]).trim().slice(0, 12000) : saved.results.find((row) => row.scope === "public")?.body || shown;
  const staffText = submitted.length > 1 ? String(submitted[1]).trim().slice(0, 12000) : saved.results.find((row) => row.scope === "staff")?.body ?? "";
  const statements: D1PreparedStatement[] = [];
  if (minutes && submitted.length > 1) {
    const ok = await saveDocument(c.env.DB, ward.wardId, id, account.accountId, {
      kind: "report", title: "議事録", scope: "staff", body: JSON.stringify({ text: staffText, items: [] }), basedOn: project.stateVersion,
    });
    const written = ok ? await getEditableDocument(c.env.DB, ward.wardId, id, "report") : null;
    if (!written?.versionId) return c.redirect(`${adminPath(ward, `/close/${id}`)}?error=minutes_save`, 303);
    if (typeof decisionText === "string") statements.push(...await meetingDecisionStatements(c.env.DB, ward.wardId, project, account.accountId, decisionText, written.versionId));
  }
  for (const [scope, text] of [["public", publicText], ["staff", staffText]]) {
    statements.push(c.env.DB.prepare(`UPDATE project_close_reports SET body = ?, updated_at = ?, updated_by_account_id = ?
      WHERE ward_id = ? AND project_id = ? AND scope = ? AND EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL)`)
      .bind(text, now, account.accountId, ward.wardId, id, scope, ward.wardId, id));
  }
  const taskIds = form.getAll("taskId");
  const fields = (key: string, index: number, limit: number) => String(form.getAll(key)[index] ?? "").trim().slice(0, limit);
  taskIds.forEach((taskId, index) => {
    statements.push(c.env.DB.prepare(`UPDATE project_close_map SET requested_by = ?, difficulty = ?, next_year = ?, updated_at = ?, updated_by_account_id = ?
      WHERE ward_id = ? AND project_id = ? AND task_id = ? AND EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL)`)
      .bind(fields("requestedBy", index, 160), fields("difficulty", index, 1200), fields("nextYear", index, 1200), now, account.accountId, ward.wardId, id, String(taskId), ward.wardId, id));
  });
  if (publicText.trim()) {
    const latestReport = async () => c.env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no, v.body FROM documents d
      JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id AND v.project_id = d.project_id
      WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = 'report' AND d.scope = 'public' AND v.scope = 'public'
      ORDER BY v.version_no DESC LIMIT 1`).bind(ward.wardId, id).first<{ document_id: string; version_id: string; version_no: number; body: string }>();
    let report = await latestReport();
    const publicationBody = JSON.stringify({ text: publicText, items: [] });
    // 閉じる画面で見えていた本文だけを載せる。下書きの補助項目を公開へ持ち出さない。
    if (report?.body !== publicationBody) {
      const written = await saveDocument(c.env.DB, ward.wardId, id, account.accountId, {
        kind: "report", title: "実施報告", scope: "public", body: publicationBody, basedOn: project.stateVersion,
      });
      if (!written) return adminResult(c, "報告を保存できませんでした。もう一度お願いします。", 409, { href: adminPath(c.var.ward, `/close/${encodeURIComponent(c.req.param("projectId"))}`), label: "報告と閉じる画面に戻る" }, "報告と行事の内容を確かめて、もう一度操作してください。");
      report = await latestReport();
    }
    if (!report) return adminResult(c, "報告を保存できませんでした。もう一度お願いします。", 409, { href: adminPath(c.var.ward, `/close/${encodeURIComponent(c.req.param("projectId"))}`), label: "報告と閉じる画面に戻る" }, "報告と行事の内容を確かめて、もう一度操作してください。");
    statements.push(
      c.env.DB.prepare(`UPDATE document_versions SET published_at = ?, published_by_account_id = ?
        WHERE ward_id = ? AND project_id = ? AND version_id = ? AND published_at IS NULL
          AND EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL)`)
        .bind(now, account.accountId, ward.wardId, id, report.version_id, ward.wardId, id),
      c.env.DB.prepare(`INSERT INTO publication_records
        (ward_id, publication_id, project_id, document_id, version_id, version_no, line_status, published_at, published_by_account_id)
        SELECT ?, ?, ?, ?, ?, ?, 'not_sent', ?, ?
        WHERE EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM publication_records WHERE ward_id = ? AND project_id = ? AND version_id = ?)`)
        .bind(ward.wardId, newId(), id, report.document_id, report.version_id, report.version_no, now, account.accountId,
          ward.wardId, id, ward.wardId, id, report.version_id),
    );
  }
  await c.env.DB.batch([
    ...statements,
    // 前に閉じた時の人数を保ち、名前を消す前に新しい申し込みの人数を足す。
    c.env.DB.prepare(`UPDATE projects SET help_offer_count_on_close = COALESCE(help_offer_count_on_close, 0) + (
      SELECT COUNT(*) FROM project_help_offers WHERE ward_id = ? AND project_id = ?
    ) WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL`)
      .bind(ward.wardId, id, ward.wardId, id),
    c.env.DB.prepare("UPDATE projects SET closed_at = ?, closed_by_account_id = ? WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL")
      .bind(now, account.accountId, ward.wardId, id),
  ]);
  return c.redirect(adminPath(ward, `/close/${id}`), 303);
});

admin.post("/close/:projectId/reopen", async (c) => {
  const { ward } = c.var; const id = c.req.param("projectId");
  await c.env.DB.prepare("UPDATE projects SET closed_at = NULL, closed_by_account_id = NULL WHERE ward_id = ? AND project_id = ? AND closed_at IS NOT NULL")
    .bind(ward.wardId, id).run();
  return c.redirect(`${adminPath(ward, `/close/${id}`)}?reopened=1`, 303);
});

export { admin as closeAdmin };
export const close: Bundle = { admin };
