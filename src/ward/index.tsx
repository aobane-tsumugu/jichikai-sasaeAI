import { Hono } from "hono";
import { Layout } from "../core/ui";
import type { Bundle } from "../core/bundle";
import type { WardEnv } from "../env";
import { getPublicContact, getSetting } from "../settings/store";
import { ArticleBody } from "../publish";

interface PublicProject {
  project_id: string;
  title: string;
  version_no: number;
  document_id: string;
  document_title: string;
  body: string;
  published_at: string;
  unpublished_at: string | null;
}

async function listPublic(db: D1Database, wardId: string, projectId?: string, includeLowered = false): Promise<PublicProject[]> {
  const sql = `SELECT p.project_id, p.title, v.version_no, d.document_id, d.title AS document_title,
      v.body, r.published_at, r.unpublished_at
    FROM publication_records r
    JOIN projects p ON p.ward_id = r.ward_id AND p.project_id = r.project_id
    JOIN documents d ON d.ward_id = r.ward_id AND d.document_id = r.document_id
    JOIN document_versions v ON v.ward_id = r.ward_id AND v.version_id = r.version_id
    WHERE r.ward_id = ?${includeLowered ? "" : " AND r.unpublished_at IS NULL"}${projectId ? " AND r.project_id = ?" : ""}
    ORDER BY r.published_at DESC`;
  const statement = db.prepare(sql);
  const result = projectId ? await statement.bind(wardId, projectId).all<PublicProject>() : await statement.bind(wardId).all<PublicProject>();
  return result.results;
}

async function pageFooter(c: { env: { DB: D1Database }; var: { ward: { wardId: string; slug: string } } }, projectId: string) {
  const contact = await getPublicContact(c.env.DB, c.var.ward.wardId);
  const [purpose, lineUrl] = await Promise.all([
    getSetting(c.env.DB, c.var.ward.wardId, "privacy_notice"),
    getSetting(c.env.DB, c.var.ward.wardId, "official_line_url"),
  ]);
  return <>
    <h2>回答する</h2>
    <p>回答の入口は準備中です。お知らせに記載の連絡先へお知らせください。</p>
    <p><a href={`/${c.var.ward.slug}/answer/${encodeURIComponent(projectId)}`}>回答の入口を開く</a></p>
    <h2>お知らせを受け取る</h2>
    {lineUrl ? <p><a href={lineUrl}>区の公式 LINE を友だちに追加する（任意）</a></p> : <p>区の公式 LINE を友だちに追加すると、新しい案内や変更を受け取れます。友だち追加は任意です。</p>}
    <h2>個人情報の扱い</h2>
    <p>{purpose ?? "回答は行事の準備と運営のために使います。運営支援サービス提供者が保管し、文章の読み取りを Anthropic に委託する場合があります。削除の希望や個人情報の問い合わせは、公開用の連絡先へご連絡ください。"}</p>
    <h2>連絡先</h2><p>{contact || "公開用の連絡先はまだ登録されていません。"}</p>
  </>;
}

const pub = new Hono<WardEnv>();

pub.get("/", async (c) => {
  const items = await listPublic(c.env.DB, c.var.ward.wardId);
  const uniqueItems = new Map<string, PublicProject>();
  for (const item of items) if (!uniqueItems.has(item.project_id)) uniqueItems.set(item.project_id, item);
  const unique = [...uniqueItems.values()];
  return c.html(<Layout title={`${c.var.ward.name}のお知らせ`} siteName={c.var.ward.name}>
    <h1>{c.var.ward.name}のお知らせ</h1>
    {unique.length === 0 ? <p>公開中のお知らせはありません。</p> : unique.map((item) => <section class="panel" key={item.project_id}>
      <h2><a href={`/${c.var.ward.slug}/p/${encodeURIComponent(item.project_id)}`}>{item.title}</a></h2>
      <p>更新: {new Date(item.published_at).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}</p>
    </section>)}
  </Layout>);
});

pub.get("/p/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const items = await listPublic(c.env.DB, c.var.ward.wardId, projectId, true);
  if (items.length === 0) return c.notFound();
  const details = await pageFooter(c, projectId);
  return c.html(<Layout title={items[0]!.title} siteName={c.var.ward.name}>
    <p><a href={`/${c.var.ward.slug}/`}>{c.var.ward.name}のお知らせ</a></p>
    <h1>{items[0]!.title}</h1>
    {items.map((item) => <article class="panel" key={`${item.document_id}-${item.version_no}`}>
      <h2>{item.document_title}</h2>
      <p>掲載日: {new Date(item.published_at).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}{item.unpublished_at ? "（掲載終了）" : ""}</p>
      <ArticleBody body={item.body} />
    </article>)}
    {details}
  </Layout>);
});

pub.get("/q/:projectId/:documentId/:versionNo", async (c) => {
  const projectId = c.req.param("projectId");
  const row = await c.env.DB.prepare(`SELECT p.title, v.version_no FROM publication_records r
    JOIN projects p ON p.ward_id = r.ward_id AND p.project_id = r.project_id
    JOIN document_versions v ON v.ward_id = r.ward_id AND v.version_id = r.version_id
    WHERE r.ward_id = ? AND r.project_id = ? AND r.document_id = ? AND v.version_no = ?`)
    .bind(c.var.ward.wardId, projectId, c.req.param("documentId"), Number(c.req.param("versionNo")))
    .first<{ title: string; version_no: number }>();
  if (!row) return c.notFound();
  return c.redirect(`/${c.var.ward.slug}/p/${encodeURIComponent(projectId)}`, 302);
});

export const wardPages: Bundle = { pub };
