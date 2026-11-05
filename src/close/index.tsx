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
import { checkPublicDraft } from "../check";
import { getDraftPack } from "../draft/packs";
import { getPublicContact } from "../settings/store";

interface CloseTask { task_id: string; name: string; period_start: string | null; period_end: string | null; progress: MapProgress; }
interface CloseEntry extends CloseTask { period: string; requested_by: string; difficulty: string; next_year: string; }
interface ActivityTaskEdit { taskId: string; name: string; period: string; }
interface ActivityBody { introduction: string; membershipBurden: string; membershipBenefit: string; tasks: ActivityTaskEdit[]; }
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
    .bind(wardId, projectId, task.task_id, [task.period_start, task.period_end].filter(Boolean).join(" 〜 "), task.name, task.progress, now, accountId));
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
function reportInstruction(contact: string): string {
  const pack = getDraftPack("report");
  return `${pack.instruction}
閉じる時の実施報告です。住民に向けた公開の報告だけを書きます。役員だけの記録は書かず、役員が自分で書きます。人数や出来事は状態にある今年の事実だけにし、分からない所は空欄のまま役員への問いにします。${contact ? `\n区の公開用の連絡先（問い合わせ先に使う）: ${contact}` : ""}
対象の文書: ${pack.kind}。範囲: ${pack.scope}。data に pack_version を ${pack.version}、based_on_state_version を引いた状態の番号として含めてください。`;
}

admin.get("/close/:projectId", async (c) => {
  const { ward } = c.var; const id = c.req.param("projectId");
  const project = await getProjectSummary(c.env.DB, ward.wardId, id);
  if (!project) return c.notFound();
  if (!project.closedAt && !(await prepareDrafts(c.env.DB, ward.wardId, id, c.var.account.accountId))) return c.notFound();
  const [tasks, reports, status, generatedReport, activityPage] = await Promise.all([
    c.env.DB.prepare("SELECT task_id, name, period, progress, requested_by, difficulty, next_year FROM project_close_map WHERE ward_id = ? AND project_id = ? ORDER BY period, task_id")
      .bind(ward.wardId, id).all<CloseEntry>(),
    c.env.DB.prepare("SELECT scope, body FROM project_close_reports WHERE ward_id = ? AND project_id = ? ORDER BY scope")
      .bind(ward.wardId, id).all<{ scope: "public" | "staff"; body: string }>(),
    c.env.DB.prepare("SELECT task, status FROM jobs WHERE ward_id = ? AND project_id = ? AND task IN ('report', 'map_draft') ORDER BY created_at DESC LIMIT 2")
      .bind(ward.wardId, id).all<{ task: string; status: string }>(),
    generatedReportText(c.env.DB, ward.wardId, id),
    c.env.DB.prepare("SELECT draft_body, published_at FROM project_activity_pages WHERE ward_id = ? AND project_id = ?")
      .bind(ward.wardId, id).first<{ draft_body: string; published_at: string | null }>(),
  ]);
  const generatedText = generatedReport;
  const report = (scope: "public" | "staff") => reports.results?.find((r) => r.scope === scope)?.body || (scope === "public" ? generatedText : "");
  const savedActivity = parseActivityBody(activityPage?.draft_body);
  const activity = savedActivity ?? { introduction: generatedText, membershipBurden: "", membershipBenefit: "", tasks: tasks.results.map((task) => ({ taskId: task.task_id, name: task.name, period: task.period })) };
  const root = adminPath(ward, `/close/${id}`);
  return c.html(<Layout title={`報告と閉じる: ${project.title}`} siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <h1>{project.title} の報告と閉じる</h1>
    {project.closedAt ? <Notice>このプロジェクトは閉じました。記録として読めます。</Notice> : <form method="post" action={`${root}/prepare`}><button class="secondary">報告と地図の下書きを起こす</button></form>}
    {c.req.query("error") ? <Notice error>{c.req.query("error")}</Notice> : null}
    {c.req.query("activity") === "saved" ? <Notice>仕事紹介の下書きを保存しました。</Notice> : null}
    {c.req.query("activity") === "published" ? <Notice>仕事紹介を区のページに載せました。</Notice> : null}
    {status.results?.map((job) => <p>{job.task === "report" ? "報告" : "地図"}: {job.status === "done"
      ? (job.task === "report" && !report("public") ? "下書きを書けませんでした。下の欄に直接書けます" : "できました")
      : job.status === "failed" ? "止まりました。下の欄に直接書けます" : "準備中"}</p>)}
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
    <h2>役員の仕事と活動を紹介する</h2>
    <p>AIが起こした報告と地図をもとに、役員が直してから区のページに載せます。記録に残った仕事の件数を示します。時間数や効果は測っていないため、書きません。</p>
    {activityPage?.published_at ? <Notice>区のページに掲載中です。直した内容を反映するには、もう一度掲載してください。</Notice> : null}
    <form class="panel" method="post" action={`${root}/activity`}>
      <label for="activity-intro">この活動で役員がしたこと</label><textarea id="activity-intro" name="introduction" rows={6} maxlength={5000} style="width:100%;font:inherit">{activity.introduction}</textarea>
      <label for="activity-burden">加入すると担うこと</label><textarea id="activity-burden" name="membershipBurden" rows={4} maxlength={3000} style="width:100%;font:inherit">{activity.membershipBurden}</textarea>
      <label for="activity-benefit">加入すると得られること</label><textarea id="activity-benefit" name="membershipBenefit" rows={4} maxlength={3000} style="width:100%;font:inherit">{activity.membershipBenefit}</textarea>
      <fieldset><legend>活動の一覧に載せる仕事</legend>{tasks.results.map((task) => { const saved = activity.tasks.find((entry) => entry.taskId === task.task_id); return <div class="panel">
        <label><input type="checkbox" name="taskId" value={task.task_id} checked={!!saved} /> 活動の一覧に載せる</label>
        <label for={`activity-name-${task.task_id}`}>仕事の名前</label><input id={`activity-name-${task.task_id}`} name={`activityName_${task.task_id}`} value={saved?.name ?? task.name} maxlength={120} />
        <label for={`activity-period-${task.task_id}`}>時期</label><input id={`activity-period-${task.task_id}`} name={`activityPeriod_${task.task_id}`} value={saved?.period ?? task.period} maxlength={80} />
      </div>; })}</fieldset>
      <p><button name="action" value="save">下書きを保存</button></p>
      {project.closedAt ? <p><button name="action" value="publish">区のページに載せる</button></p> : null}
    </form>
    {activityPage?.published_at ? <p><a href={`/${ward.slug}/work/${encodeURIComponent(id)}`}>区のページで確認する</a></p> : null}
    {!project.closedAt ? <form method="post" action={`${root}/finalize`}><p><button class="danger">閉じて記録に残す</button></p></form>
      : <form method="post" action={`${root}/reopen`}><p><button>開き直す</button></p></form>}
    <p><a href={adminPath(ward, "/archive")}>記録を開く</a></p>
  </Layout>);
});

admin.post("/close/:projectId/activity", async (c) => {
  const { ward, account } = c.var; const projectId = c.req.param("projectId"); const form = await c.req.formData();
  const project = await getProjectSummary(c.env.DB, ward.wardId, projectId);
  if (!project) return c.notFound();
  const action = String(form.get("action") ?? "save");
  if (action !== "save" && action !== "publish") return c.notFound();
  if (action === "publish" && !project.closedAt) return c.text("プロジェクトを閉じてから掲載できます。", 400);
  const rows = await c.env.DB.prepare("SELECT task_id, name, period FROM project_close_map WHERE ward_id = ? AND project_id = ? ORDER BY period, task_id")
    .bind(ward.wardId, projectId).all<{ task_id: string; name: string; period: string }>();
  const selectedIds = new Set(form.getAll("taskId").map(String));
  const includedTasks = rows.results.filter((row) => selectedIds.has(row.task_id)).map((row) => ({
    taskId: row.task_id,
    name: String(form.get(`activityName_${row.task_id}`) ?? row.name).trim().slice(0, 120),
    period: String(form.get(`activityPeriod_${row.task_id}`) ?? row.period).trim().slice(0, 80),
  }));
  const introduction = String(form.get("introduction") ?? "").trim().slice(0, 5000);
  const membershipBurden = String(form.get("membershipBurden") ?? "").trim().slice(0, 3000);
  const membershipBenefit = String(form.get("membershipBenefit") ?? "").trim().slice(0, 3000);
  if (action === "publish" && (!introduction || !membershipBurden || !membershipBenefit)) return c.redirect(`${adminPath(ward, `/close/${projectId}`)}?error=${encodeURIComponent("活動の紹介、加入で担うこと、得られることを入力してください")}`, 303);
  if (action === "publish") {
    const text = [introduction, membershipBurden, membershipBenefit, ...includedTasks.flatMap((task) => [task.period, task.name])].join("\n");
    const warnings = await checkPublicDraft(c.env.DB, ward.wardId, projectId, "report", { text, items: [] });
    if (warnings.length) return c.redirect(`${adminPath(ward, `/close/${projectId}`)}?error=${encodeURIComponent("公開に出せない情報が含まれる可能性があります。文章と仕事の一覧を見直してください")}`, 303);
  }
  const body = JSON.stringify({ introduction, membershipBurden, membershipBenefit, tasks: includedTasks });
  const now = nowIso();
  await c.env.DB.prepare(`INSERT INTO project_activity_pages (ward_id, project_id, draft_body, published_body, published_at, updated_at, updated_by_account_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (ward_id, project_id) DO UPDATE SET draft_body = excluded.draft_body,
      published_body = CASE WHEN ? = 1 THEN excluded.published_body ELSE project_activity_pages.published_body END,
      published_at = CASE WHEN ? = 1 THEN excluded.published_at ELSE project_activity_pages.published_at END,
      updated_at = excluded.updated_at, updated_by_account_id = excluded.updated_by_account_id`)
    .bind(ward.wardId, projectId, body, action === "publish" ? body : null, action === "publish" ? now : null, now, account.accountId,
      action === "publish" ? 1 : 0, action === "publish" ? 1 : 0).run();
  return c.redirect(`${adminPath(ward, `/close/${projectId}`)}?activity=${action === "publish" ? "published" : "saved"}`, 303);
});

admin.post("/close/:projectId/prepare", async (c) => {
  const { ward, account } = c.var; const id = c.req.param("projectId");
  if (!(await prepareDrafts(c.env.DB, ward.wardId, id, account.accountId))) return c.notFound();
  const contact = await getPublicContact(c.env.DB, ward.wardId);
  try {
    await Promise.all([
      startTask(c.env, waitableContext(c), { wardId: ward.wardId, projectId: id, task: "report", accountId: account.accountId,
        instruction: reportInstruction(contact) }),
      startTask(c.env, waitableContext(c), { wardId: ward.wardId, projectId: id, task: "map_draft", accountId: account.accountId,
        instruction: "閉じる時の地図の下書きを状態から作る。原本は読まない。状態にある仕事を一つずつ保ち、task_id、period、name、progress（open/started/done）、requested_by、difficulty、next_year を記録する。時期、進み具合、頼んだ相手、困ったこと、来年変えることは状態にある内容だけを書き、分からない欄は空にして役員への問いにする。仕事を省いたり、過去の参考情報を今年の実績にしたり、内容を補って作らない。write_change で kind=map_draft、target=map、data={tasks:[...] } を一度書く。" }),
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
  // 公開の報告を保存していなければ、閉じる画面の欄に出ていた中身（AI の下書き）を記録に残す。閉じる操作のほかに記録のための操作を求めない。
  const shown = await generatedReportText(c.env.DB, ward.wardId, id);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE project_close_reports SET body = ?, updated_at = ?, updated_by_account_id = ?
      WHERE ward_id = ? AND project_id = ? AND scope = 'public' AND body = '' AND EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL)`)
      .bind(shown, now, account.accountId, ward.wardId, id, ward.wardId, id),
    c.env.DB.prepare("UPDATE projects SET closed_at = ?, closed_by_account_id = ? WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL")
      .bind(now, account.accountId, ward.wardId, id),
  ]);
  return c.redirect(adminPath(ward, `/close/${id}`), 303);
});

admin.post("/close/:projectId/reopen", async (c) => {
  const { ward } = c.var; const id = c.req.param("projectId");
  await c.env.DB.prepare("UPDATE projects SET closed_at = NULL, closed_by_account_id = NULL WHERE ward_id = ? AND project_id = ? AND closed_at IS NOT NULL")
    .bind(ward.wardId, id).run();
  return c.redirect(adminPath(ward, `/close/${id}`), 303);
});

export { admin as closeAdmin };
export const close: Bundle = { admin };
