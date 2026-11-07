// 役員画面の「送る」。カメラ、ファイル、一行の文を一つの画面から送る。送ったら受けたことをすぐ返し、読みは裏で続く。
// 画面に出す言葉は CLAUDE.md の表に従う（札、列、セッション、包み、版、差分は出さない）。
import { Hono, type Context } from "hono";
import { adminPath } from "../core/auth";
import { ErrorNotice, Layout, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { receiveOriginal, ReceiveError, retryJob, withdrawJob } from "./api";
import { SEND_SCRIPT } from "./browser-script";
import { photoSourceHash } from "./photo";
import { projectDirectory } from "./project-port";
import { getJob, getOriginal, getReadings, listJobs, type JobListItem, jobSummaries } from "./store";
import type { JobStatus, OriginalKind } from "./types";
import { WardBucket } from "../core/storage";
import type { ReceivePart } from "./receive";
import type { Waitable } from "./types";
import { lookupPrintQr } from "../print/qr";
import { getProjectState } from "../project/api";
import { formatDateText } from "../core/time";
import { WhichProject } from "./which-project";
import { PROJECT_KINDS } from "../project/model";
import { pendingMaterialGroups, startMaterialGroup } from "./groups";
import { initialDraftKind } from "../map/template";
import { documentTitle } from "../project/heading";
import { PhotoCheckNotice, photoChecks } from "./photo-check";
import { talkMark, talkPath } from "../line/talks";

/** Hono のテスト用 request には ExecutionContext が無い場合がある。 */
function waitableContext(context: { executionCtx: Waitable }): Waitable {
  try {
    return context.executionCtx;
  } catch {
    // Hono の単体リクエストには背景処理の実行枠がない。そこで promise を
    // fire-and-forget すると、試験側で明示的に処理する前に同じジョブを競合させる。
    return { waitUntil: () => undefined };
  }
}

/** 受けた直後に出す文（設計書 5.3）。 */
export const RECEIVED_MESSAGE = "受け取りました。画面を閉じてもかまいません。AIが読み続けます。";

export const STATUS_LABEL: Record<JobStatus, string> = {
  received: "読んでいます", reading: "読んでいます", read: "読み終わりました",
  connecting: "どれの資料か分けています", done: "どれの資料か分けました",
  attention: "読み取りが遅れています。送り直す必要はありません。",
  failed: "読めませんでした。もう一度読むか、このまま進められます。",
  withdrawn: "資料を消しました",
};

const ERROR_MESSAGE: Record<ReceiveError["code"], (filename: string) => string> = {
  empty: () => "送るものを選ぶか、書いたことを入れてください。",
  too_many: () => "一度に送れるのは30までです。分けて送ってください。",
  too_large: (f) => `${f ? `「${f}」` : "送ったもの"}が大きすぎます。小さくして送ってください。`,
  unsupported: (f) =>
    `${f ? `「${f}」` : "送ったもの"}は読めない形式です。写真、PDF、Word（.docx）、Excel（.xlsx）、文字のファイルを送ってください。`,
  needs_expansion: (f) =>
    `${f ? `「${f}」` : "WordやExcel"}は、この画面をもう一度開いてから、ブラウザで送ってください（ブラウザが中身を開いて送ります）。`,
  bad_text: () => "書いたことが長すぎます。2万文字までです。",
  no_project: () => "そこには送れません。送り先を選び直してください。",
};

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(ERROR_MESSAGE).map(([code, message]) => [code, message("")])),
  withdraw_failed: "取り下げられませんでした。資料は残っています。消すときは、自治会の設定の「住民から頼まれたものを消す」の「名前で見つからないとき」から選んでください。",
  retry_failed: "今は読み直せません。送ったものを見て、このまま進めることもできます。",
};

function isKind(value: string): value is OriginalKind {
  return value === "photo" || value === "file" || value === "text";
}

async function jobTitle(db: D1Database, wardId: string, job: JobListItem): Promise<string> {
  if (job.first_kind === "text") {
    const readings = await getReadings(db, wardId, job.job_id);
    const text = readings.filter((r) => r.source === "direct")
      .flatMap((r) => "text_blocks" in r.body ? r.body.text_blocks.map((block) => block.text) : [])
      .join(" ").trim();
    return text ? `${text.slice(0, 40)}${text.length > 40 ? "…" : ""}` : "書いたこと";
  }
  const name = job.first_filename || (job.first_kind === "photo" ? "撮った写真" : "ファイル");
  return job.original_count > 1 ? `${name}ほか${job.original_count - 1}件` : name;
}

export const intakeAdmin = new Hono<AdminEnv>();

/** 戻り先は、いまの区の役員画面の中だけを受ける。 */
function returnPath(c: Context<AdminEnv>, value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  try {
    const url = new URL(value, c.req.url);
    const root = adminPath(c.var.ward, "/");
    if (url.origin === new URL(c.req.url).origin && !url.username && !url.password && url.pathname.startsWith(root)) return `${url.pathname}${url.search}${url.hash}`;
  } catch { /* 戻り先が読めなければ、行事か最初の画面に戻す。 */ }
  return fallback;
}

intakeAdmin.get("/intake", async (c) => {
  const { ward } = c.var;
  const projectId = c.req.query("project") ?? "";
  const choices = await projectDirectory().listOpen(c.env.DB, ward.wardId);
  const project = choices.find((p) => p.projectId === projectId);
  const title = project ? `${project.title}に資料を送る` : "写真やファイルを送る";
  const back = returnPath(c, c.req.query("back") ?? c.req.header("referer"), adminPath(ward, project ? `/projects/${project.projectId}/map` : "/"));
  const query = new URLSearchParams({ back, ...(project ? { project: project.projectId } : {}) }).toString();
  return c.html(<Layout title={title} siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={back}>← {project && back === adminPath(ward, `/projects/${project.projectId}/map`) ? `${project.title}のやることへ` : back === adminPath(ward, "/") ? "最初の画面へ" : "前の画面へ"}</a>
    <h1>{title}</h1>
    <p class="lead">{project ? "" : "去年の資料も、今年のものも送れます。"}いくつでも一度に送れます。分類も名前付けもいりません。</p>
    {c.req.query("n") === "withdrawn" ? <Notice>資料を消しました。</Notice> : null}
    {c.req.query("n") === "retry" ? <Notice>もう一度読みます。</Notice> : null}
    <ErrorNotice code={c.req.query("error")} messages={ERROR_MESSAGES} />
    <form id="send-form" method="post" action={`${adminPath(ward, "/intake")}?${query}`} enctype="multipart/form-data">
      <div class="field"><label class="file-button">カメラで紙を撮る<input id="cam" type="file" name="part" accept="image/*" capture="environment" multiple /></label><p id="cam-count" class="help-text" aria-live="polite" /></div>
      <div class="field"><label class="file-button">ファイルを選ぶ<input id="files" type="file" name="part" accept="image/*,application/pdf,.pdf,.docx,.xlsx,.txt,.csv" multiple /></label><p id="files-count" class="help-text" aria-live="polite" /><p class="help-text">写真、PDF、Word、Excelを送れます。写真は紙の文字や行事の様子が分かる大きさに整えて保存します。</p></div>
      <details class="fold"><summary>電話や立ち話で決まったことを書く</summary><div><div class="field"><label for="text">決まったこと</label><textarea id="text" name="text" maxlength={2000} rows={3} /></div></div></details>
      <input type="hidden" name="project_id" value={project?.projectId ?? ""} />
      <div class="action-links"><button id="send-button" type="submit">送る</button></div>
      <p id="send-status" role="status" aria-live="polite" />
    </form>
    <p class="muted">送ったあとは、画面を閉じてもかまいません。</p>
    <script dangerouslySetInnerHTML={{ __html: SEND_SCRIPT }} />
  </Layout>);
});

intakeAdmin.get("/intake/received", async (c) => {
  const { ward } = c.var;
  const projectId = c.req.query("project");
  const project = projectId ? (await getProjectState(c.env.DB, ward.wardId, projectId))?.project : null;
  const back = returnPath(c, c.req.query("back"), adminPath(ward, project ? `/projects/${project.projectId}/map` : "/"));
  const sendHref = `${adminPath(ward, "/intake")}?${new URLSearchParams({ back, ...(project ? { project: project.projectId } : {}) })}`;
  const sentSince = Date.now() - 3_600_000;
  const jobs = (await listJobs(c.env.DB, ward.wardId, { projectId, limit: 100 })).filter((job) => !job.withdrawn_at && (projectId || Date.parse(job.created_at) > sentSince));
  const slow = jobs.find((job) => job.status === "attention" || ((job.status === "received" || job.status === "reading") && Date.now() - Date.parse(job.created_at) > 90_000));
  const readHref = adminPath(ward, "/intake/read");
  const backLabel = project && back === adminPath(ward, `/projects/${project.projectId}/map`) ? `← ${project.title}のやることへ` : back === adminPath(ward, "/") ? "← 最初の画面へ" : "← 前の画面へ";
  if (c.req.query("n") === "withdrawn") return c.html(<Layout title="資料を消しました" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={back}>{backLabel}</a><h1>資料を消しました</h1>
    <div class="notice done" role="status"><strong>資料は入っていません</strong><p>やることと下書きは変わりません。</p></div>
    <section class="next"><strong>次は</strong><p>送り直すときは、もう一度送ってください。</p><a class="button" href={sendHref}>資料を送る</a></section>
  </Layout>);
  if (c.req.query("n") === "same") return c.html(<Layout title="同じ資料でした" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={back}>{backLabel}</a><h1>同じ資料でした</h1>
    <div class="notice" role="status"><strong>前に送ったものと同じでした</strong><p>二度は入れていません。</p></div>
    <section class="next"><strong>次は</strong><p>このまま進められます。</p><a class="button" href={back}>{backLabel.replace("← ", "")}</a></section>
    <h2>違う資料のときは</h2><p>もう一度送ってください。</p><a class="quiet" href={sendHref}>資料を送る</a>
  </Layout>);
  // 送った物ごとに、今どこまで読んで、どこに入れたかを文で書く。札の一語にしない。
  const names = new Map((await c.env.DB.prepare("SELECT project_id, title FROM projects WHERE ward_id = ?").bind(ward.wardId).all<{ project_id: string; title: string }>()).results.map((row) => [row.project_id, row.title]));
  const whereText = (job: (typeof jobs)[number]) => {
    const name = job.project_id ? names.get(job.project_id) : undefined;
    if (job.status === "received" || job.status === "reading") return "AIが読んでいます。";
    if (job.status === "read" || job.status === "connecting") return `読み終わりました。${name ? `${name}の中身に入れています。` : "どの準備の資料かを分けています。"}`;
    // 通しの道具は「どれの資料か分けました」を見て読み終わりを待つので、この言葉は残す。
    if (job.status === "done") return name ? `読み終わり、どれの資料か分けました。${name}の資料に入れています。` : "読み終わりました。どの準備の資料かは、まだ決まっていません。";
    if (job.status === "attention") return "読み取りが遅れています。送ったものは預かっているので、送り直さなくてかまいません。";
    if (job.status === "failed") return "読めませんでした。もう一度読むか、このまま進められます。";
    return STATUS_LABEL[job.status];
  };
  return c.html(<Layout title="受け取りました" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <h1>送った資料を受け取りました</h1>
    {c.req.query("n") === "retry" ? <div class="notice done" role="status"><strong>もう一度読みます</strong><p>読み終わると、やることと下書きに入ります。</p></div> : null}
    {project ? <><div class="notice done"><strong>{project.title}に資料を預かりました</strong><p>画面を閉じてもかまいません。AIが読み続けます。読み終わると、やることと下書きに入ります。</p></div>{slow ? <div class="notice warn"><strong>読み取りが遅れています</strong><p>送った資料は預かっています。こちらで対応しているので、送り直す必要はありません。下書きを自分で書いて住民に知らせることもできます。</p><a class="quiet" href={adminPath(ward, `/projects/${project.projectId}/draft/announcement`)}>案内の下書きを書く</a></div> : null}<section class="next"><strong>次は</strong><p>読み終わるのを待たずに、やることを見られます。</p><a class="button" href={adminPath(ward, `/projects/${project.projectId}/map`)}>やることへ</a></section></> : slow ? <>
      <div class="notice warn"><strong>読み取りが遅れています</strong><p>送った資料は預かっています。こちらで対応しているので、送り直す必要はありません。下書きを自分で書いて住民に知らせることもできます。</p></div>
      <section class="next"><strong>次は</strong><p>読み終わるのを待たずに、案内の下書きを書けます。</p>
        {slow.project_id ? <a class="button" href={adminPath(ward, `/projects/${slow.project_id}/draft/announcement`)}>案内の下書きを書く</a>
          : <form method="post" action={adminPath(ward, `/intake/${slow.job_id}/continue`)}><button>案内の下書きを書く</button></form>}
      </section>
    </> : <><p class="lead">画面を閉じてもかまいません。AIが読んで、どの準備の資料かを分けて入れます。</p>
      <section class="next"><strong>次は</strong><p>どの準備の資料か決まらなかったものは、「読み終わったもの」から、今の準備に入れるか、新しく準備を始められます。</p><a class="button" href={readHref}>読み終わったものを見る</a></section></>}
    <ErrorNotice code={c.req.query("error")} messages={ERROR_MESSAGES} />
    <h2>送ったもの</h2><ul class="rows">{await Promise.all(jobs.map(async (job) => <li class="panel">
      <p>「<b>{await jobTitle(c.env.DB, ward.wardId, job)}</b>」は、{whereText(job)}</p>
      <PhotoCheckNotice checks={await photoChecks(c.env.DB, ward.wardId, job.job_id)} retakeHref={sendHref} continueHref={readHref} />
      {job.project_id ? <a href={adminPath(ward, `/projects/${job.project_id}/map`)}>{names.get(job.project_id) ?? ""}のやることを見る</a> : null}
      {job.status === "failed" ? <><form method="post" action={adminPath(ward, `/intake/${job.job_id}/retry`)}><button class="quiet">もう一度読む</button></form>
        <form method="post" action={adminPath(ward, `/intake/${job.job_id}/continue`)}><button class="quiet">このまま進める</button></form></> : null}
      {["received", "reading", "read", "failed"].includes(job.status) ? <details class="fold"><summary>間違えて送ったときは</summary><div><form method="post" action={adminPath(ward, `/intake/${job.job_id}/withdraw`)} onsubmit="return confirm('送った資料と、読み取った内容を消します。元に戻せません。続けますか？')"><p>送った資料と読み取った内容を消します。元に戻せないので、送り直すには手元の写真やファイルが必要です。</p><button class="secondary danger">この資料を消す</button></form></div></details> : null}
    </li>))}</ul>
    {jobs.length === 0 ? <p>{projectId ? "送ったものはありません。" : "この1時間に送ったものはありません。"}</p> : null}
    <div class="action-links"><a class="button secondary" href={sendHref}>続けて送る</a></div>
    <p><a class="quiet" href={adminPath(ward, talkPath(await talkMark(ward.wardId, "", "admin", "")))}>役員の画面から送ったものを、送った順に見て直す</a></p>
  </Layout>);
});

intakeAdmin.get("/intake/read", async (c) => {
  const { ward } = c.var;
  const groups = await pendingMaterialGroups(c.env.DB, ward.wardId);
  const projects = await projectDirectory().listOpen(c.env.DB, ward.wardId);
  const open = projects.map((project) => ({ project_id: project.projectId, name: project.title }));
  return c.html(<Layout title="読み終わったもの" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/intake/received")}>← 送ったものへ</a>
    <h1>{groups.length ? "読み終わりました" : "読み終わったものはまだありません"}</h1><p class="lead">{groups.length > 1 ? "どれの資料か分けました。違っていても、あとで直せます。" : groups.length ? "資料をまとめました。違っていても、あとで直せます。" : "読み終わると、ここに出ます。画面を閉じてもかまいません。"}</p>
    <ErrorNotice code={c.req.query("error")} messages={{ day: "今年の行事の日を入れ直してください。分からないときは空欄で進められます。" }} />
    {groups.map((group, index) => {
      if (!group.title) return <ul class="rows"><li><a class="row-link" href={adminPath(ward, "/files")}><b>まだどれの資料にもしていないもの</b><span>{group.materials.length}件。自治会の資料に入っています</span></a></li></ul>;
      const ids = new Set(group.materials.map((m) => m.original.original_id));
      const fields = group.materials.flatMap((m) => m.readings.flatMap((r) => "fields" in r.body ? r.body.fields.filter((f) => ids.has(f.original_id)) : []));
      const suggestions = group.materials.flatMap((m) => m.readings.flatMap((r) => "fields" in r.body ? (r.body.project_suggestions ?? []).filter((s) => ids.has(s.original_id)) : []));
      // 年の違う資料が混ざると日付も場所も一つに決まらない。決まらない時は出さない。
      const oneValue = (values: (string | undefined)[]) => { const distinct = [...new Set(values.filter(Boolean))]; return distinct.length === 1 ? distinct[0] : undefined; };
      const date = oneValue([...fields.filter((f) => f.name === "日時").map((f) => f.value), ...suggestions.map((s) => s.date_text)]);
      const place = oneValue([...fields.filter((f) => f.name === "場所").map((f) => f.value), ...suggestions.map((s) => s.place)]);
      return <section class="panel"><h2>{group.joins?.title ?? group.title}の資料のようです</h2>
        <dl class="facts"><dt>資料</dt><dd>{group.materials.length}件</dd>{date ? <><dt>資料の日付</dt><dd>{formatDateText(date)}</dd></> : null}{place ? <><dt>場所</dt><dd>{place}</dd></> : null}</dl>
        <WhichProject id={`group-${index}`} question="この資料は、次の行事のものですか？" projects={open} suggested={group.joins?.projectId} suggestedName={group.joins ? "" : group.title} suggestedKind={group.kind} action={adminPath(ward, "/intake/start")} hidden={{ group: group.key }} withDay />
      </section>;
    })}
    {groups.length === 0 ? <><p>まだ読み終わっていない資料は、送ったものから見られます。</p>
      {projects.map((p) => <p class="link-line"><a href={adminPath(ward, `/projects/${p.projectId}/map`)}>{p.title}のやることを見る</a></p>)}
      <a class="button secondary" href={adminPath(ward, "/projects")}>資料がないので、種類を選んで始める</a></> : null}
    {groups.length ? <p class="muted">読めなかったところは、あとで質問します。年が書かれていない資料は、参考として残します。</p> : null}
    <a class="quiet" href={adminPath(ward, "/")}>最初の画面へ</a>
  </Layout>);
});

intakeAdmin.post("/intake/start", async (c) => {
  const { ward, account } = c.var;
  const form = await c.req.formData();
  const eventDay = String(form.get("eventDay") ?? "");
  if (eventDay && (!/^\d{4}-\d{2}-\d{2}$/.test(eventDay) || Number(eventDay.slice(0, 4)) < 1900 || Number(eventDay.slice(0, 4)) > 2200 || !Number.isFinite(Date.parse(eventDay)) || new Date(eventDay).toISOString().slice(0, 10) !== eventDay)) return c.redirect(`${adminPath(ward, "/intake/read")}?error=day`, 303);
  const kind = String(form.get("kind") ?? "");
  const projectName = String(form.get("projectName") ?? "").trim();
  if (projectName.length > 100) return c.redirect(`${adminPath(ward, "/inbox")}?error=input`, 303);
  const project = await startMaterialGroup(c.env, waitableContext(c), ward.wardId, account.accountId, String(form.get("group") ?? ""), eventDay, {
    projectId: String(form.get("projectId") ?? "") || undefined, projectName: form.get("operation") === "new-project" ? projectName : undefined,
    kind: PROJECT_KINDS.find((value) => value === kind),
  });
  if (project?.joined) return c.redirect(`${adminPath(ward, "/inbox")}?n=assigned&project=${project.projectId}`, 303);
  return c.redirect(adminPath(ward, project ? `/intake/started/${project.projectId}` : "/intake/read"), 303);
});

intakeAdmin.get("/intake/started/:projectId", async (c) => {
  const { ward } = c.var;
  const id = c.req.param("projectId");
  const state = await getProjectState(c.env.DB, ward.wardId, id);
  if (!state) return c.notFound();
  const count = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id WHERE o.ward_id = ? AND j.project_id = ? AND j.read_at IS NOT NULL AND o.withdrawn_at IS NULL`)
    .bind(ward.wardId, id).first<{ n: number }>();
  const questions = state.questions.filter((q) => q.state === "open" || q.state === "later").length;
  const tasks = state.mapTasks.length;
  const draftKind = initialDraftKind(state.project.kind);
  const draftTitle = documentTitle(state.project.kind, draftKind);
  const people = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM accounts WHERE ward_id = ? AND removed_at IS NULL").bind(ward.wardId).first<{ n: number }>();
  return c.html(<Layout title={state.project.title} siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <h1>{state.project.title}</h1><p class="lead">{count?.n ? `${count.n}件の資料を読んで、${tasks}${tasks > 0 && tasks < 10 ? "つ" : "件"}のやることを用意しました` : `ふつうの${tasks}${tasks > 0 && tasks < 10 ? "つ" : "件"}のやることを用意しました`}</p>
    <section class="next"><strong>次は</strong><p>{questions ? "分かるものから答えてください。あとでもかまいません。" : `${draftTitle}の下書きを見て、直せます。`}</p>
      <a class="button" href={adminPath(ward, questions ? `/projects/${id}/questions` : `/projects/${id}/draft/${draftKind}`)}>{questions ? "質問に答える" : `${draftTitle}の下書きを見る`}</a></section>
    <p>仕事を押して直せます。</p><a class="button secondary" href={adminPath(ward, `/projects/${id}/map`)}>やることを見る</a>
    {(people?.n ?? 0) < 2 ? <p class="link-line"><a href={adminPath(ward, "/settings/people#add")}>ほかの役員にもこの画面を使ってもらい、手元の資料を送ってもらう</a></p> : null}<p class="link-line"><a href={adminPath(ward, "/inbox")}>届いたものを見る</a></p><a class="quiet" href={adminPath(ward, "/")}>最初の画面へ</a>
  </Layout>);
});

intakeAdmin.post("/intake/:jobId/continue", async (c) => {
  const { ward, account } = c.var;
  const job = await getJob(c.env.DB, ward.wardId, c.req.param("jobId"));
  if (!job || job.withdrawn_at) return c.notFound();
  if (!job.project_id) return c.redirect(adminPath(ward, "/projects"), 303);
  const state = await getProjectState(c.env.DB, ward.wardId, job.project_id);
  if (!state) return c.notFound();
  return c.redirect(adminPath(ward, `/projects/${job.project_id}/draft/${initialDraftKind(state.project.kind)}`), 303);
});

intakeAdmin.post("/intake", async (c) => {
  const { ward, account } = c.var;
  const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
  const reply = (ok: boolean, message: string, extra: Record<string, unknown> = {}, status: 200 | 400 = 200, code?: ReceiveError["code"]) => {
    if (wantsJson) return c.json({ ok, message, ...extra }, status);
    const params = new URLSearchParams(c.req.query());
    if (!ok) params.set("error", code ?? "empty");
    return c.redirect(`${adminPath(ward, "/intake")}?${params}`, 303);
  };

  const form = await c.req.formData();
  const projectIdRaw = String(form.get("project_id") ?? "").trim();
  const suppliedQr = form.getAll("paper_qr").map(String).filter(Boolean);
  const qrMatches = (await Promise.all(suppliedQr.map((value) => lookupPrintQr(c.env.DB, ward.wardId, ward.slug, value))))
    .filter((value): value is NonNullable<typeof value> => value !== null);
  const qrProjects = [...new Set(qrMatches.map((value) => value.projectId))];
  const projectId = qrProjects.length === 1 ? qrProjects[0] as string : qrProjects.length > 1 ? null : projectIdRaw === "" ? null : projectIdRaw;
  if (projectId && !(await projectDirectory().isOpen(c.env.DB, ward.wardId, projectId))) {
    return reply(false, ERROR_MESSAGE.no_project(""), {}, 400, "no_project");
  }

  const files = form.getAll("part").filter((v): v is File => typeof v !== "string" && v.size > 0);
  const kinds = form.getAll("part_kind").map(String);
  const extracted = form.getAll("part_extracted").map(String);
  const sourceHashes = form.getAll("part_source_hash");
  const lastModified = form.getAll("part_last_modified");
  const parts: ReceivePart[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i] as File;
    const kindRaw = kinds[i] ?? "file";
    const json = extracted[i] ?? "";
    let parsed: unknown;
    if (json !== "") {
      try {
        parsed = JSON.parse(json);
      } catch {
        return reply(false, ERROR_MESSAGE.needs_expansion(file.name), {}, 400, "needs_expansion");
      }
    }
    parts.push({
      kind: isKind(kindRaw) && kindRaw !== "text" ? kindRaw : "file",
      filename: file.name,
      mediaType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
      sourceHash: photoSourceHash(sourceHashes[i]),
      lastModified: String(lastModified[i] ?? ""),
      extracted: parsed,
    });
  }
  const text = String(form.get("text") ?? "").trim();
  if (text !== "") parts.push({ kind: "text", filename: "", mediaType: "text/plain", bytes: new TextEncoder().encode(text) });

  try {
    const outcome = await receiveOriginal(c.env, waitableContext(c), {
      wardId: ward.wardId,
      projectId,
      via: "admin",
      accountId: account.accountId,
      parts,
    });
    const params = new URLSearchParams();
    if (projectId) params.set("project", projectId);
    const back = returnPath(c, c.req.query("back"), adminPath(ward, projectId ? `/projects/${projectId}/map` : "/"));
    params.set("back", back);
    const receivedPath = `${adminPath(ward, "/intake/received")}?${params}`;
    params.set("n", "same");
    const samePath = `${adminPath(ward, "/intake/received")}?${params}`;
    if (!wantsJson) return c.redirect(outcome.jobId ? receivedPath : samePath, 303);
    const nextPage = { redirectTo: outcome.jobId ? receivedPath : samePath };
    if (!outcome.jobId) {
      return reply(true, "同じものでした。", { jobId: null, duplicates: outcome.duplicates.length, ...nextPage });
    }
    const dup = outcome.duplicates.length > 0 ? `（${outcome.duplicates.length}件は同じものでした）` : "";
    return reply(true, `${RECEIVED_MESSAGE}${dup}`, { jobId: outcome.jobId, duplicates: outcome.duplicates.length, ...nextPage });
  } catch (err) {
    if (err instanceof ReceiveError) return reply(false, ERROR_MESSAGE[err.code](err.filename), {}, 400, err.code);
    throw err;
  }
});

intakeAdmin.post("/intake/:jobId/withdraw", async (c) => {
  const { ward } = c.var;
  if (!(await withdrawJob(c.env, ward.wardId, c.req.param("jobId")))) {
    return c.redirect(`${adminPath(ward, "/intake/received")}?error=withdraw_failed`, 303);
  }
  const job = await getJob(c.env.DB, ward.wardId, c.req.param("jobId"));
  const params = new URLSearchParams({ n: "withdrawn", ...(job?.project_id ? { project: job.project_id } : {}) });
  return c.redirect(`${adminPath(ward, "/intake/received")}?${params}`, 303);
});

intakeAdmin.post("/intake/:jobId/retry", async (c) => {
  const { ward } = c.var;
  if (!(await retryJob(c.env, waitableContext(c), ward.wardId, c.req.param("jobId")))) return c.redirect(`${adminPath(ward, "/intake/received")}?error=retry_failed`, 303);
  const job = await getJob(c.env.DB, ward.wardId, c.req.param("jobId"));
  const params = new URLSearchParams({ n: "retry", ...(job?.project_id ? { project: job.project_id } : {}) });
  return c.redirect(`${adminPath(ward, "/intake/received")}?${params}`, 303);
});

// 元の資料は枠の中で読む。実体も同じ区の認証を通して返す。
intakeAdmin.get("/intake/originals/:originalId", async (c) => {
  const { ward } = c.var;
  const original = await getOriginal(c.env.DB, ward.wardId, c.req.param("originalId"));
  if (!original || !original.r2_path) return c.notFound();
  const object = await new WardBucket(c.env.ORIGINALS, ward.wardId).get(original.r2_path);
  if (!object) return c.notFound();
  c.header("Cache-Control", "private, no-store");
  if (c.req.query("raw") === "1") {
    const inline = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf", "text/plain"].includes(original.media_type);
    return new Response(object.body, { headers: {
      "content-type": original.media_type === "text/plain" ? "text/plain; charset=utf-8" : original.media_type,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(original.filename || "original")}`,
      "cache-control": "private, no-store", "x-content-type-options": "nosniff",
    } });
  }
  const job = await getJob(c.env.DB, ward.wardId, original.job_id);
  const project = job?.project_id ? (await getProjectState(c.env.DB, ward.wardId, job.project_id))?.project : null;
  const fallback = adminPath(ward, project ? `/projects/${project.projectId}/map` : "/intake/received");
  let back = returnPath(c, c.req.query("back") ?? c.req.header("referer"), fallback);
  if (back.startsWith(adminPath(ward, `/intake/originals/${original.original_id}`))) back = fallback;
  const title = original.media_type === "text/plain" ? "元の文" : project?.kind === "city_request" ? "元の通知" : "元の資料";
  const raw = `${adminPath(ward, `/intake/originals/${original.original_id}`)}?raw=1`;
  const summary = (await jobSummaries(c.env.DB, ward.wardId)).get(original.job_id);
  const line = await c.env.DB.prepare("SELECT sender_display_name FROM line_inbox_items WHERE ward_id = ? AND job_id = ? LIMIT 1").bind(ward.wardId, original.job_id).first<{ sender_display_name: string | null }>();
  const sender = line?.sender_display_name || job?.sender_label;
  return c.html(<Layout title={title} siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={back}>← 前の画面へ</a><h1>{summary?.split("\n")[0]?.slice(0, 36) || title}</h1>
    <p class="lead">{original.media_type.startsWith("image/") ? object.customMetadata?.photoResizeFailed === "1" ? "写真の大きさを整えられなかったため、届いたまま保管しています。" : "紙の文字や行事の様子が分かる大きさで保管した写真です。" : original.media_type === "text/plain" && job?.via.startsWith("line") ? "自治会のLINEに届いたときのままの文です。" : "送ったときのままの資料です。"}この画面では直せません。</p>
    <dl class="facts">{summary ? null : <><dt>名前</dt><dd>{original.filename || (original.kind === "text" ? "届いた文" : "撮った写真")}</dd></>}<dt>届いた日</dt><dd>{formatDateText(original.received_at.slice(0, 10))}</dd>{job?.via.startsWith("line") ? <><dt>届き方</dt><dd>自治会のLINE（{job.via === "line_direct" ? "一対一" : "グループ"}）</dd><dt>送った人</dt><dd>{sender || "名前は分かりません"}</dd></> : null}{project ? <><dt>{project.kind === "city_request" ? "依頼" : "どれの資料か"}</dt><dd>{project.title}</dd></> : null}</dl>
    {original.media_type === "text/plain" ? <div class="panel preserve-lines">{await object.text()}</div>
      : ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(original.media_type) ? <div class="sheet-preview"><img class="original-image" src={raw} alt={original.filename || "届いた資料の写真"} /></div>
      : original.media_type === "application/pdf" ? <iframe class="original-document" src={raw} title="元の資料のPDF" /> : <p>このファイルは、下のボタンから開いて読めます。</p>}
    <a class="button secondary" href={raw}>元のファイルを開く</a><p class="muted">この画面では直せません。読み取った内容は、前の画面で直せます。</p>
    <a class="quiet" href={back}>前の画面へ戻る</a>
  </Layout>);
});
