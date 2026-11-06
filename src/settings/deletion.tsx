import { Hono } from "hono";
import { AdminPage } from "../core/admin-ui";
import { adminPath } from "../core/auth";
import { Hint, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { requestAnswerDeletion, requestJobDeletion, requestProjectDeletion } from "../ops/lifecycle";

export const deletion = new Hono<AdminEnv>();

/** 受けた日時を日本時間で出す。 */
function shownAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

deletion.get("/", async (c) => {
  const { ward, account } = c.var;
  const jobs = await c.env.DB.prepare(`SELECT j.job_id, j.created_at, j.via, o.filename, o.kind, p.title
    FROM jobs j JOIN originals o ON o.ward_id = j.ward_id AND o.job_id = j.job_id
    LEFT JOIN projects p ON p.ward_id = j.ward_id AND p.project_id = j.project_id
    WHERE j.ward_id = ? AND j.withdrawn_at IS NULL AND o.withdrawn_at IS NULL
    GROUP BY j.job_id ORDER BY j.created_at DESC LIMIT 100`).bind(ward.wardId)
    .all<{ job_id: string; created_at: string; via: string; filename: string; kind: string; title: string | null }>();
  const queue = await c.env.DB.prepare(`SELECT state, COUNT(*) AS count FROM ops_deletion_queue
    WHERE ward_id = ? AND target_type IN ('job', 'answer', 'project') GROUP BY state`).bind(ward.wardId)
    .all<{ state: string; count: number }>();
  const counts = new Map(queue.results.map((row) => [row.state, row.count]));
  const projects = await c.env.DB.prepare("SELECT project_id, title FROM projects WHERE ward_id = ? ORDER BY created_at DESC")
    .bind(ward.wardId).all<{ project_id: string; title: string }>();
  // Web と電話で受けた回答は原本を持たないので、記録の消去とは別に一件ずつ消す。
  const answers = await c.env.DB.prepare(`SELECT a.answer_id, a.household, a.district, a.source, a.created_at, p.title
    FROM project_answers a JOIN projects p ON p.ward_id = a.ward_id AND p.project_id = a.project_id
    WHERE a.ward_id = ? AND a.original_id IS NULL ORDER BY a.created_at DESC LIMIT 200`).bind(ward.wardId)
    .all<{ answer_id: string; household: string; district: string; source: string; created_at: string; title: string }>();
  return c.html(<AdminPage ward={ward} account={account} title="消す求め" back={{ href: adminPath(ward, "/settings"), label: "区の設定" }}>
    <h1>消す求め</h1><p class="lead">消してほしいと頼まれた記録や、不要な行事を消す画面です。題や日時で対象を選んでください。</p>
    {c.req.query("queued") === "1" ? <Notice>消去を受け付けました。処理は続きから進みます。</Notice> : null}
    <p>住民から希望が届いたら、対象の記録を選んで処理します。元の資料、読み取った内容、その記録を探す索引を一緒に消します。AI側で処理中の場合も、処理が終わったあとに消します。</p>
    <p>受付{counts.get("pending") ?? 0} 件、処理中{counts.get("running") ?? 0} 件、要対応{counts.get("error") ?? 0} 件</p>
    <h2>行事</h2>
    {projects.results.map((project, index) => <section class="panel">
      <p>{project.title}</p>
      <form method="post" action={adminPath(ward, `/settings/deletion/projects/${project.project_id}`)} onsubmit={`return confirm(${JSON.stringify(`「${project.title}」の元の資料、答え、配った案内などを消します。続けますか？`)})`}>
        <button class="danger">この行事を消す</button> {index === 0 ? <Hint text="元の資料、答え、配った案内などを行事ごと消し、元には戻せません。" /> : null}
      </form>
    </section>)}
    <h2>対象の記録</h2>
    {jobs.results.map((job, index) => <section class="panel">
      <p>{job.title ? `${job.title} / ` : ""}{job.filename || (job.kind === "text" ? "一行の文" : "名前のない記録")} / {shownAt(job.created_at)}</p>
      <form method="post" action={adminPath(ward, `/settings/deletion/${job.job_id}`)} onsubmit="return confirm('この記録の元の資料と読み取った内容を消します。続けますか？')">
        <button class="danger">消去を進める</button> {index === 0 ? <Hint text="この記録の元の資料と読み取った内容、毎日の写しに残る分を消します。" /> : null}
      </form>
    </section>)}
    {jobs.results.length === 0 ? <p>消去できる記録はありません。</p> : null}
    {c.req.query("answer") === "1" ? <Notice>答えを消しました。毎日の写しからも、続けて消します。</Notice> : null}
    <h2>Webと電話で受けた答え</h2>
    <p>回答票の写真から入った答えは、上の記録を消すと一緒に消えます。</p>
    {answers.results.map((answer, index) => <section class="panel">
      <p>{answer.title} / {answer.district} / {answer.household} / {answer.source === "phone" ? "電話" : answer.source === "line" ? "LINE" : "Web"} / {shownAt(answer.created_at)}</p>
      <form method="post" action={adminPath(ward, `/settings/deletion/answers/${answer.answer_id}`)} onsubmit="return confirm('この答えを消します。続けますか？')">
        <button class="danger">この答えを消す</button> {index === 0 ? <Hint text="この答えを一覧と集計から消し、毎日の写しからも消します。" /> : null}
      </form>
    </section>)}
    {answers.results.length === 0 ? <p>消去できる答えはありません。</p> : null}
    <p><a href={adminPath(ward, "/settings")}>区の設定へ戻る</a></p>
  </AdminPage>);
});

deletion.post("/answers/:answerId", async (c) => {
  const { ward } = c.var;
  if (!(await requestAnswerDeletion(c.env.DB, ward.wardId, c.req.param("answerId")))) return c.notFound();
  return c.redirect(adminPath(ward, "/settings/deletion?answer=1"), 303);
});

deletion.post("/projects/:projectId", async (c) => {
  const { ward } = c.var;
  if (!(await requestProjectDeletion(c.env.DB, ward.wardId, c.req.param("projectId")))) return c.notFound();
  return c.redirect(adminPath(ward, "/settings/deletion?queued=1"), 303);
});

deletion.post("/:jobId", async (c) => {
  const { ward } = c.var;
  try {
    await requestJobDeletion(c.env.DB, ward.wardId, c.req.param("jobId"));
    return c.redirect(adminPath(ward, "/settings/deletion?queued=1"), 303);
  } catch {
    return c.notFound();
  }
});
