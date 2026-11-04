import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { WardBucket } from "../core/storage";
import { Layout } from "../core/ui";
import type { AdminEnv, AppEnv } from "../env";
import { getLineAllowance, lineAccessToken, sendLineTitleAndUrl } from "./api";
import { markInboxItemUnrelated } from "./intake";
import { acceptLineWebhook } from "./webhook";
import { createProject } from "../project/api";
import { assignProject, withdrawJob } from "../intake/api";
import { listJobs, listOriginals } from "../intake/store";

interface InboxRow {
  item_id: string;
  original_kind: "text" | "image";
  original_text: string | null;
  received_at: string;
  disposition: "unmatched" | "matched";
  matched_project_name: string | null;
  match_reason: string | null;
}

export async function listInboxItems(db: D1Database, wardId: string): Promise<InboxRow[]> {
  const result = await db.prepare(`
    SELECT item_id, original_kind, original_text, received_at, disposition,
      matched_project_name, match_reason
    FROM line_inbox_items
    WHERE ward_id = ?
    ORDER BY received_at DESC, item_id
  `).bind(wardId).all<InboxRow>();
  return result.results;
}

const admin = new Hono<AdminEnv>();

admin.get("/inbox", async (c) => {
  const { wardId, slug, name } = c.var.ward;
  const db = c.env.DB;
  const items = await listInboxItems(db, wardId);
  const cityJobs = (await listJobs(db, wardId, { limit: 100 })).filter((job) => job.via === "admin" && job.project_id === null && job.withdrawn_at === null);
  const projects = await db.prepare(`
    SELECT project_id, title AS name FROM projects WHERE ward_id = ? AND closed_at IS NULL ORDER BY created_at DESC
  `).bind(wardId).all<{ project_id: string; name: string }>();
  const unrelated = await db.prepare(`
    SELECT day, item_count FROM line_unrelated_daily_counts WHERE ward_id = ? ORDER BY day DESC LIMIT 30
  `).bind(wardId).all<{ day: string; item_count: number }>();
  return c.html(
    <Layout title="受け箱" siteName={name} noindex adminHomeHref={`/${slug}/admin/`}>
      <h1>受け箱</h1>
      <p>公式 LINE に届いた文と写真です。仕分けをしなくてもかまいません。</p>
      {items.length === 0 ? <p>入った物はありません。</p> : null}
      <h2>市の通知など、プロジェクト未定の写真</h2>
      <p><a class="button secondary" href={`/${slug}/admin/intake`}>通知を撮って送る</a></p>
      {cityJobs.length === 0 ? <p>プロジェクト未定の写真はありません。</p> : null}
      {await Promise.all(cityJobs.map(async (job) => {
        const originals = await listOriginals(db, wardId, job.job_id);
        return <section class="panel">
          <strong>{job.first_filename || "撮った写真"}</strong>
          <p>{new Date(job.created_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</p>
          <p>{job.status === "failed" ? "読めませんでした" : job.status === "done" ? "読み取り済み" : "読み取り中または確認中"}</p>
          {originals.map((original) => <p><a href={`/${slug}/admin/intake/originals/${encodeURIComponent(original.original_id)}`}>届いた物を開く: {original.filename || "写真"}</a></p>)}
          <form method="post" action={`/${slug}/admin/inbox/city/${encodeURIComponent(job.job_id)}`}>
            <label for={`city-project-${job.job_id}`}>プロジェクトに当てる</label>
            <select id={`city-project-${job.job_id}`} name="projectId" required>
              <option value="">選んでください</option>
              {projects.results.map((project) => <option value={project.project_id}>{project.name}</option>)}
            </select>
            <button type="submit">このプロジェクトに当てる</button>
          </form>
          <form method="post" action={`/${slug}/admin/inbox/city/${encodeURIComponent(job.job_id)}`}>
            <label for={`city-title-${job.job_id}`}>新しいプロジェクトを開く</label>
            <input id={`city-title-${job.job_id}`} name="projectName" type="text" maxlength={100} required />
            <input type="hidden" name="kind" value="city_request" />
            <input type="hidden" name="year" value={new Date().getFullYear()} />
            <button class="secondary" name="operation" value="new-project">市の依頼として開く</button>
          </form>
        </section>;
      }))}
      {items.map((item) => (
        <section class="panel" key={item.item_id}>
          <p><strong>{item.disposition === "matched" ? "AI が当てました" : "プロジェクト未定"}</strong></p>
          <p>{new Date(item.received_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</p>
          <p><a href={`/${slug}/admin/inbox/${encodeURIComponent(item.item_id)}/original`}>{item.original_kind === "text" ? "届いた文を開く" : "届いた写真を開く"}</a></p>
          {item.matched_project_name ? <p>当て先: {item.matched_project_name}</p> : null}
          {item.match_reason ? <p>{item.match_reason}</p> : null}
          <form method="post" action={`/${slug}/admin/inbox/${encodeURIComponent(item.item_id)}`}>
            <label for={`project-${item.item_id}`}>当て先を選び直す</label>
            <select id={`project-${item.item_id}`} name="projectId">
              <option value="">選んでください</option>
              {projects.results.map((project) => <option value={project.project_id}>{project.name}</option>)}
            </select>
            <button class="secondary" name="operation" value="assign">選んだプロジェクトに当てる</button>
          </form>
          <form method="post" action={`/${slug}/admin/inbox/${encodeURIComponent(item.item_id)}`}>
            <label for={`new-project-${item.item_id}`}>新しいプロジェクトを開く</label>
            <input id={`new-project-${item.item_id}`} name="projectName" type="text" maxLength={100} required />
            <label for={`new-project-kind-${item.item_id}`}>種類</label>
            <select id={`new-project-kind-${item.item_id}`} name="kind"><option value="event">行事</option><option value="general_meeting">総会</option><option value="city_request">市の依頼</option></select>
            <label for={`new-project-year-${item.item_id}`}>年</label><input id={`new-project-year-${item.item_id}`} name="year" type="number" min="2000" max="2100" value={new Date().getFullYear()} required />
            <button name="operation" value="new-project">新しいプロジェクトを開く</button>
          </form>
          <form method="post" action={`/${slug}/admin/inbox/${encodeURIComponent(item.item_id)}`}>
            <button class="danger" name="operation" value="unrelated">関係ない物として消す</button>
          </form>
        </section>
      ))}
      <h2>関係ない物として消した数</h2>
      <ul>{unrelated.results.map((row) => <li>{row.day}: {row.item_count} 件</li>)}</ul>
      <p><a href={`/${slug}/admin/`}>役員画面へ戻る</a></p>
    </Layout>,
  );
});

admin.post("/inbox/city/:jobId", async (c) => {
  const { ward, account } = c.var;
  const jobId = c.req.param("jobId");
  const form = await c.req.formData();
  const operation = String(form.get("operation") ?? "assign");
  const job = await c.env.DB.prepare("SELECT via, project_id, withdrawn_at FROM jobs WHERE ward_id = ? AND job_id = ?")
    .bind(ward.wardId, jobId).first<{ via: string; project_id: string | null; withdrawn_at: string | null }>();
  if (!job || job.via !== "admin" || job.project_id !== null || job.withdrawn_at !== null) return c.notFound();
  let projectId = String(form.get("projectId") ?? "");
  if (operation === "new-project") {
    const title = String(form.get("projectName") ?? "").trim();
    const year = Number(form.get("year"));
    if (!title || title.length > 100 || !Number.isInteger(year) || year < 2000 || year > 2100) return c.text("入力を確かめてください。", 400);
    const created = await createProject(c.env.DB, ward.wardId, { kind: "city_request", title, year, accountId: account.accountId });
    projectId = created.projectId;
  }
  if (!projectId || !(await c.env.DB.prepare("SELECT 1 AS ok FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL")
    .bind(ward.wardId, projectId).first())) return c.text("開いているプロジェクトを選んでください。", 400);
  await assignProject(c.env, c.executionCtx, ward.wardId, jobId, projectId);
  return c.redirect(`/${ward.slug}/admin/projects/${encodeURIComponent(projectId)}/map`, 303);
});

admin.get("/inbox/:itemId/original", async (c) => {
  const { wardId } = c.var.ward;
  const row = await c.env.DB.prepare(`
    SELECT job_id, original_kind FROM line_inbox_items
    WHERE ward_id = ? AND item_id = ?
  `).bind(wardId, c.req.param("itemId")).first<{ job_id: string | null; original_kind: string }>();
  if (!row?.job_id) return c.notFound();
  const original = await c.env.DB.prepare("SELECT r2_path, media_type FROM originals WHERE ward_id = ? AND job_id = ? ORDER BY position LIMIT 1")
    .bind(wardId, row.job_id).first<{ r2_path: string | null; media_type: string }>();
  if (!original?.r2_path) return c.notFound();
  const object = await new WardBucket(c.env.ORIGINALS, wardId).get(original.r2_path);
  if (!object) return c.notFound();
  return new Response(object.body, {
    headers: { "content-type": original.media_type, "cache-control": "private, no-store" },
  });
});

admin.post("/inbox/:itemId", async (c) => {
  const { wardId } = c.var.ward;
  const form = await c.req.parseBody();
  const operation = form.operation;
  const itemId = c.req.param("itemId");
  if (operation === "unrelated") {
    if (!(await withdrawJob(c.env, wardId, itemId))) return c.text("すでに処理が進んでいるため、受け箱から外せません。", 409);
    await markInboxItemUnrelated(c.env.DB, wardId, itemId);
  } else if (operation === "assign") {
    const projectId = typeof form.projectId === "string" ? form.projectId : "";
    const project = await c.env.DB.prepare(`
      SELECT title AS name FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL
    `).bind(wardId, projectId).first<{ name: string }>();
    if (project) {
      const item = await c.env.DB.prepare("SELECT job_id FROM line_inbox_items WHERE ward_id = ? AND item_id = ?")
        .bind(wardId, itemId).first<{ job_id: string | null }>();
      if (item?.job_id) await assignProject(c.env, c.executionCtx, wardId, item.job_id, projectId);
      await c.env.DB.prepare(`
        UPDATE line_inbox_items SET disposition = 'matched', matched_project_id = ?,
          matched_project_name = ?, match_reason = NULL WHERE ward_id = ? AND item_id = ?
      `).bind(projectId, project.name, wardId, itemId).run();
    }
  } else if (operation === "new-project") {
    const projectName = typeof form.projectName === "string" ? form.projectName.trim() : "";
    const kind = String(form.kind);
    const year = Number(form.year);
    if (projectName && projectName.length <= 100 && ["event", "general_meeting", "city_request"].includes(kind) && Number.isInteger(year) && year >= 2000 && year <= 2100) {
      const created = await createProject(c.env.DB, wardId, { kind: kind as "event" | "general_meeting" | "city_request", title: projectName, year, accountId: c.var.account.accountId });
      const item = await c.env.DB.prepare("SELECT job_id FROM line_inbox_items WHERE ward_id = ? AND item_id = ?")
        .bind(wardId, itemId).first<{ job_id: string | null }>();
      if (item?.job_id) await assignProject(c.env, c.executionCtx, wardId, item.job_id, created.projectId);
      await c.env.DB.prepare(`
        UPDATE line_inbox_items SET disposition = 'matched', matched_project_id = ?,
          matched_project_name = ?, match_reason = NULL WHERE ward_id = ? AND item_id = ?
      `).bind(created.projectId, projectName, wardId, itemId).run();
    }
  }
  return c.redirect(`/${c.var.ward.slug}/admin/inbox`, 303);
});

export const line: Bundle = {
  admin,
  hooks: new Hono<AppEnv>().post("/line", async (c) =>
    acceptLineWebhook(c.req.raw, c.env, c.env.DB, undefined, new Date(), c.executionCtx),
  ),
};

export { getLineAllowance, sendLineTitleAndUrl, lineAccessToken } from "./api";
