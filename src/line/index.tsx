import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { newId, nowIso } from "../core/ids";
import { WardBucket } from "../core/storage";
import { Layout } from "../core/ui";
import type { AdminEnv, AppEnv } from "../env";
import { getLineAllowance, lineAccessToken, sendLineTitleAndUrl } from "./api";
import { markInboxItemUnrelated } from "./intake";
import { acceptLineWebhook } from "./webhook";

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
  const projects = await db.prepare(`
    SELECT project_id, name FROM line_inbox_projects WHERE ward_id = ? ORDER BY created_at DESC
  `).bind(wardId).all<{ project_id: string; name: string }>();
  const unrelated = await db.prepare(`
    SELECT day, item_count FROM line_unrelated_daily_counts WHERE ward_id = ? ORDER BY day DESC LIMIT 30
  `).bind(wardId).all<{ day: string; item_count: number }>();
  return c.html(
    <Layout title="受け箱" siteName={name} noindex>
      <h1>受け箱</h1>
      <p>公式 LINE に届いた文と写真です。仕分けをしなくてもかまいません。</p>
      {items.length === 0 ? <p>入った物はありません。</p> : null}
      {items.map((item) => (
        <section class="panel" key={item.item_id}>
          <p><strong>{item.disposition === "matched" ? "AI が当てました" : "プロジェクト未定"}</strong></p>
          <p>{new Date(item.received_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</p>
          {item.original_kind === "text" ? <p>{item.original_text}</p> : <p><a href={`/${slug}/admin/inbox/${encodeURIComponent(item.item_id)}/original`}>写真を見る</a></p>}
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
            <button name="operation" value="new-project">新しいプロジェクトに当てる</button>
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

admin.get("/inbox/:itemId/original", async (c) => {
  const { wardId } = c.var.ward;
  const row = await c.env.DB.prepare(`
    SELECT original_object_key, original_kind FROM line_inbox_items
    WHERE ward_id = ? AND item_id = ?
  `).bind(wardId, c.req.param("itemId")).first<{ original_object_key: string | null; original_kind: string }>();
  if (!row?.original_object_key) return c.notFound();
  const object = await new WardBucket(c.env.ORIGINALS, wardId).get(row.original_object_key);
  if (!object) return c.notFound();
  return new Response(object.body, {
    headers: { "content-type": object.httpMetadata?.contentType ?? "application/octet-stream", "cache-control": "private, no-store" },
  });
});

admin.post("/inbox/:itemId", async (c) => {
  const { wardId } = c.var.ward;
  const form = await c.req.parseBody();
  const operation = form.operation;
  const itemId = c.req.param("itemId");
  if (operation === "unrelated") {
    await markInboxItemUnrelated(c.env.DB, c.env.ORIGINALS, wardId, itemId);
  } else if (operation === "assign") {
    const projectId = typeof form.projectId === "string" ? form.projectId : "";
    const project = await c.env.DB.prepare(`
      SELECT name FROM line_inbox_projects WHERE ward_id = ? AND project_id = ?
    `).bind(wardId, projectId).first<{ name: string }>();
    if (project) {
      await c.env.DB.prepare(`
        UPDATE line_inbox_items SET disposition = 'matched', matched_project_id = ?,
          matched_project_name = ?, match_reason = NULL WHERE ward_id = ? AND item_id = ?
      `).bind(projectId, project.name, wardId, itemId).run();
    }
  } else if (operation === "new-project") {
    const projectName = typeof form.projectName === "string" ? form.projectName.trim() : "";
    if (projectName && projectName.length <= 100) {
      const projectId = newId();
      const createdAt = nowIso();
      await c.env.DB.batch([
        c.env.DB.prepare(`
          INSERT INTO line_inbox_projects (ward_id, project_id, name, created_at) VALUES (?, ?, ?, ?)
        `).bind(wardId, projectId, projectName, createdAt),
        c.env.DB.prepare(`
          UPDATE line_inbox_items SET disposition = 'matched', matched_project_id = ?,
            matched_project_name = ?, match_reason = NULL WHERE ward_id = ? AND item_id = ?
        `).bind(projectId, projectName, wardId, itemId),
      ]);
    }
  }
  return c.redirect(`/${c.var.ward.slug}/admin/inbox`, 303);
});

export const line: Bundle = {
  admin,
  hooks: new Hono<AppEnv>().post("/line", async (c) =>
    acceptLineWebhook(c.req.raw, c.env, c.env.DB),
  ),
};

export { getLineAllowance, sendLineTitleAndUrl, lineAccessToken } from "./api";
