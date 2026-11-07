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
    WHERE j.ward_id = ? AND ((j.withdrawn_at IS NULL AND o.withdrawn_at IS NULL)
      OR EXISTS (SELECT 1 FROM ops_deletion_queue q WHERE q.ward_id = j.ward_id AND q.target_type = 'job' AND q.target_id = j.job_id))
    GROUP BY j.job_id ORDER BY j.created_at DESC LIMIT 100`).bind(ward.wardId)
    .all<{ job_id: string; created_at: string; via: string; filename: string; kind: string; title: string | null }>();
  const queue = await c.env.DB.prepare(`SELECT state, COUNT(*) AS count FROM ops_deletion_queue
    WHERE ward_id = ? AND target_type IN ('job', 'answer', 'project', 'inquiry', 'help_offer') GROUP BY state`).bind(ward.wardId)
    .all<{ state: string; count: number }>();
  const counts = new Map(queue.results.map((row) => [row.state, row.count]));
  const projects = await c.env.DB.prepare("SELECT project_id, title FROM projects WHERE ward_id = ? ORDER BY created_at DESC")
    .bind(ward.wardId).all<{ project_id: string; title: string }>();
  // Web と電話で受けた回答は原本を持たないので、記録の消去とは別に一件ずつ消す。
  const answers = await c.env.DB.prepare(`SELECT a.answer_id, a.household, a.district, a.source, a.created_at, p.title
    FROM project_answers a JOIN projects p ON p.ward_id = a.ward_id AND p.project_id = a.project_id
    WHERE a.ward_id = ? AND a.original_id IS NULL ORDER BY a.created_at DESC LIMIT 200`).bind(ward.wardId)
    .all<{ answer_id: string; household: string; district: string; source: string; created_at: string; title: string }>();
  return c.html(<AdminPage ward={ward} account={account} title="消す希望" back={{ href: adminPath(ward, "/settings"), label: "自治会の設定" }}>
    <h1>消す希望</h1><p class="lead">住民から消してほしいと頼まれたものを、ここで選んで消します。消すと元に戻せません。</p>
    {c.req.query("queued") === "1" ? <><Notice>消去を受け付けました。処理は続きから進みます。</Notice><section class="next"><strong>次は</strong><p>下の件数で、消している途中か、対応が必要かを見られます。画面を閉じても処理は続きます。</p><a class="button" href={adminPath(ward, "/settings/deletion")}>進み具合を見る</a></section><p>消したものは元に戻せません。</p></> : null}
    <p>元の資料、読み取った内容、それらを探すための一覧を、一緒に消します。AIが読んでいる途中のものは、終わったあとに消します。</p>
    <p>受け付けた{counts.get("pending") ?? 0}件、消している途中{counts.get("running") ?? 0}件、対応が必要{counts.get("error") ?? 0}件</p>
    <h2>まとめて消す</h2><p>名前ごとに、元の資料、出欠の返事、知らせた案内などを、まとめて消します。</p>
    {projects.results.map((project, index) => <section class="panel">
      <p>{project.title}</p>
      <form method="post" action={adminPath(ward, `/settings/deletion/projects/${project.project_id}`)} onsubmit={`return confirm(${JSON.stringify(`「${project.title}」の元の資料、出欠の返事、知らせた案内などを消します。続けますか？`)})`}>
        <button class="secondary danger">「{project.title}」を消す</button> {index === 0 ? <Hint text="元の資料、出欠の返事、知らせた案内などをまとめて消し、元には戻せません。" /> : null}
      </form>
    </section>)}
    <h2>資料を消す</h2><p>届いた写真やファイルを、読み取った内容と一緒に消します。毎日の控えに残る分も消します。</p>
    {jobs.results.map((job, index) => <section class="panel">
      <p>{job.title ? `${job.title} / ` : ""}{job.filename || (job.kind === "text" ? "一行の文" : "名前のない記録")} / {shownAt(job.created_at)}</p>
      <form method="post" action={adminPath(ward, `/settings/deletion/${job.job_id}`)} onsubmit="return confirm('この記録の元の資料と読み取った内容を消します。続けますか？')">
        <button class="secondary danger">この資料を消す</button> {index === 0 ? <Hint text="この記録の元の資料と読み取った内容、毎日の写しに残る分を消します。" /> : null}
      </form>
    </section>)}
    {jobs.results.length === 0 ? <p>消せる資料はありません。</p> : null}
    {c.req.query("answer") === "1" ? <><Notice>返事を消しました。毎日の写しからも、続けて消します。</Notice><section class="next"><strong>次は</strong><p>ほかに頼まれたものがなければ、自治会の設定へ戻ってください。</p><a class="button" href={adminPath(ward, "/settings")}>自治会の設定へ戻る</a></section><p>消した返事は元に戻せません。</p></> : null}
    <h2>返事を一件消す</h2><p>電話やスマホで受けた返事は、元の資料を持たないので、ここで一件ずつ消します。</p>
    <p>回答票の写真から入った返事は、上の「資料を消す」で一緒に消えます。</p>
    {answers.results.map((answer, index) => <section class="panel">
      <p>{answer.title} / {answer.district} / {answer.household} / {answer.source === "phone" ? "電話" : answer.source === "line" ? "LINE" : "Web"} / {shownAt(answer.created_at)}</p>
      <form method="post" action={adminPath(ward, `/settings/deletion/answers/${answer.answer_id}`)} onsubmit="return confirm('この返事を消します。続けますか？')">
        <button class="secondary danger">この返事を消す</button> {index === 0 ? <Hint text="この返事を一覧と集計から消し、毎日の写しからも消します。" /> : null}
      </form>
    </section>)}
    {answers.results.length === 0 ? <p>消せる返事はありません。</p> : null}
    <p class="link-line"><a href={adminPath(ward, "/settings")}>自治会の設定へ戻る</a></p>
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
