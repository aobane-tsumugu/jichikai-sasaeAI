import { Hono } from "hono";
import { AdminPage } from "../core/admin-ui";
import { adminPath } from "../core/auth";
import { Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { requestJobDeletion } from "../ops/lifecycle";

export const deletion = new Hono<AdminEnv>();

deletion.get("/", async (c) => {
  const { ward, account } = c.var;
  const jobs = await c.env.DB.prepare(`SELECT j.job_id, j.created_at, j.via, o.filename, o.kind, p.title
    FROM jobs j JOIN originals o ON o.ward_id = j.ward_id AND o.job_id = j.job_id
    LEFT JOIN projects p ON p.ward_id = j.ward_id AND p.project_id = j.project_id
    WHERE j.ward_id = ? AND j.withdrawn_at IS NULL AND o.withdrawn_at IS NULL
    GROUP BY j.job_id ORDER BY j.created_at DESC LIMIT 100`).bind(ward.wardId)
    .all<{ job_id: string; created_at: string; via: string; filename: string; kind: string; title: string | null }>();
  const queue = await c.env.DB.prepare(`SELECT state, COUNT(*) AS count FROM ops_deletion_queue
    WHERE ward_id = ? AND target_type = 'job' GROUP BY state`).bind(ward.wardId)
    .all<{ state: string; count: number }>();
  const counts = new Map(queue.results.map((row) => [row.state, row.count]));
  return c.html(<AdminPage ward={ward} account={account} title="消す求め" back={{ href: adminPath(ward, "/settings"), label: "区の設定" }}>
    <h1>消す求め</h1>
    {c.req.query("queued") === "1" ? <Notice>消去を受け付けました。処理は続きから進みます。</Notice> : null}
    <p>住民から希望が届いたら、対象の記録を選んで処理します。原本、読み取った内容、その記録を探す索引を一緒に消します。AI 側で処理中の場合も、終了後に消します。</p>
    <p>受付 {counts.get("pending") ?? 0} 件、処理中 {counts.get("running") ?? 0} 件、要対応 {counts.get("error") ?? 0} 件</p>
    <h2>対象の記録</h2>
    {jobs.results.map((job) => <section class="panel">
      <p>{job.title ? `${job.title} / ` : ""}{job.filename || (job.kind === "text" ? "一行の文" : "名前のない記録")} / {job.created_at}</p>
      <form method="post" action={adminPath(ward, `/settings/deletion/${job.job_id}`)} onsubmit="return confirm('この記録の原本と読み取った内容を消します。続けますか？')">
        <button class="danger">消去を進める</button>
      </form>
    </section>)}
    {jobs.results.length === 0 ? <p>消去できる記録はありません。</p> : null}
    <p><a href={adminPath(ward, "/settings")}>区の設定へ戻る</a></p>
  </AdminPage>);
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
