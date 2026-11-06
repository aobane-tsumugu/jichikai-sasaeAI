import { Hono } from "hono";
import { Hint, Layout } from "../core/ui";
import type { Bundle } from "../core/bundle";
import type { WardEnv } from "../env";
import { getOfficialLineUrl, getPublicContact, getSetting } from "../settings/store";
import { ArticleBody } from "../publish";
import { listHelpOpportunities } from "../answers/help";

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

interface PublicActivity { project_id: string; title: string; published_at: string; published_body: string; }
interface ActivityTask { taskId: string; name: string; period: string; }
interface ActivityBody { introduction: string; membershipBurden: string; membershipBenefit: string; tasks: ActivityTask[]; }

function parseActivity(raw: string): ActivityBody | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const body = value as Partial<ActivityBody>;
    if (typeof body.introduction !== "string" || typeof body.membershipBurden !== "string" || typeof body.membershipBenefit !== "string" || !Array.isArray(body.tasks)) return null;
    const tasks = body.tasks.filter((task): task is ActivityTask => typeof task === "object" && task !== null &&
      typeof task.taskId === "string" && typeof task.name === "string" && typeof task.period === "string");
    return { introduction: body.introduction, membershipBurden: body.membershipBurden, membershipBenefit: body.membershipBenefit, tasks };
  } catch { return null; }
}

async function listPublic(db: D1Database, wardId: string, projectId?: string, includeLowered = false): Promise<PublicProject[]> {
  const sql = `SELECT p.project_id, p.title, v.version_no, d.document_id, COALESCE(v.title, d.title) AS document_title,
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
    getOfficialLineUrl(c.env.DB, c.var.ward.wardId),
  ]);
  return <>
    <h2>回答する</h2>
    <p>Webから回答できます。世帯名、班、人数を入力してください。名簿に登録されているかは表示しません。</p>
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
  const [items, activities, opportunities, lineUrl] = await Promise.all([
    listPublic(c.env.DB, c.var.ward.wardId),
    c.env.DB.prepare(`SELECT a.project_id, p.title, a.published_at, a.published_body
      FROM project_activity_pages a JOIN projects p ON p.ward_id = a.ward_id AND p.project_id = a.project_id
      WHERE a.ward_id = ? AND a.published_at IS NOT NULL AND a.published_body IS NOT NULL ORDER BY a.published_at DESC`)
      .bind(c.var.ward.wardId).all<PublicActivity>(),
    listHelpOpportunities(c.env.DB, c.var.ward.wardId),
    getOfficialLineUrl(c.env.DB, c.var.ward.wardId),
  ]);
  const uniqueItems = new Map<string, PublicProject>();
  for (const item of items) if (!uniqueItems.has(item.project_id)) uniqueItems.set(item.project_id, item);
  const unique = [...uniqueItems.values()];
  return c.html(<Layout title={`${c.var.ward.name}のお知らせ`} siteName={c.var.ward.name}>
    <h1>{c.var.ward.name}のお知らせ</h1>
    {c.env.DEMO_NOTICE ? <p class="muted">{c.env.DEMO_NOTICE}</p> : null}
    {opportunities.length ? <section class="panel">
      <h2><a href={`/${c.var.ward.slug}/help`}>一回だけ手伝える募集</a> <Hint text="自治会に加入していない人も、名前と手伝える時間帯だけで申し込めます。" /></h2>
      <p>加入せずに、一回だけ手伝えます。募集中の行事を見て、関わり方を選べます。</p>
    </section> : null}
    {lineUrl ? <section class="panel">
      <h2>新しい案内や変更を受け取る</h2>
      <p><a href={lineUrl}>区の公式 LINE を友だちに追加する（任意）</a></p>
      <p>友だち追加は任意です。名前や世帯を登録する必要はありません。</p>
    </section> : null}
    {unique.length === 0 ? <p>公開中のお知らせはありません。</p> : unique.map((item) => <section class="panel" key={item.project_id}>
      <h2><a href={`/${c.var.ward.slug}/p/${encodeURIComponent(item.project_id)}`}>{item.title}</a></h2>
      <p>更新: {new Date(item.published_at).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}</p>
    </section>)}
    <h2>役員の仕事と活動</h2>
    {activities.results.length === 0 ? <p>掲載中の活動紹介はありません。</p> : activities.results.map((item) => <section class="panel" key={item.project_id}>
      <h3><a href={`/${c.var.ward.slug}/work/${encodeURIComponent(item.project_id)}`}>{item.title}の活動</a></h3>
      <p>掲載: {new Date(item.published_at).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}</p>
    </section>)}
  </Layout>);
});

pub.get("/work/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const activity = await c.env.DB.prepare(`SELECT a.project_id, p.title, a.published_at, a.published_body
    FROM project_activity_pages a JOIN projects p ON p.ward_id = a.ward_id AND p.project_id = a.project_id
    WHERE a.ward_id = ? AND a.project_id = ? AND a.published_at IS NOT NULL AND a.published_body IS NOT NULL`)
    .bind(c.var.ward.wardId, projectId).first<PublicActivity>();
  if (!activity) return c.notFound();
  const body = parseActivity(activity.published_body);
  if (!body) return c.notFound();
  const listed = body.tasks;
  // 案内を一度も載せていない行事では、案内のページが無いのでリンクを出さない。
  const notices = await c.env.DB.prepare("SELECT 1 AS found FROM publication_records WHERE ward_id = ? AND project_id = ? AND unpublished_at IS NULL LIMIT 1")
    .bind(c.var.ward.wardId, projectId).first<{ found: number }>();
  return c.html(<Layout title={`${activity.title}の活動`} siteName={c.var.ward.name}>
    <p><a href={`/${c.var.ward.slug}/`}>{c.var.ward.name}のページへ</a></p>
    <h1>{activity.title}で役員がしたこと</h1>
    <p>この紹介は、役員が直して掲載したものです。掲載: {new Date(activity.published_at).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}</p>
    {body.introduction ? <p style="white-space:pre-wrap">{body.introduction}</p> : null}
    <h2>活動の一覧</h2>
    <p>記録にある仕事 {listed.length} 件です。この件数は仕事の記録数で、作業時間や効果を測った数ではありません。</p>
    {listed.length ? <ul>{listed.map((task) => <li>{task.period || "時期の記録なし"}　{task.name}</li>)}</ul> : <p>紹介する仕事はありません。</p>}
    <h2>加入すると担うこと</h2><p style="white-space:pre-wrap">{body.membershipBurden || "この項目の説明はありません。"}</p>
    <h2>加入すると得られること</h2><p style="white-space:pre-wrap">{body.membershipBenefit || "この項目の説明はありません。"}</p>
    <h2>一回だけ手伝う</h2>
    <p>加入せずに手伝える募集を見て、一回だけ申し込めます。</p>
    <p><a href={`/${c.var.ward.slug}/help`}>一回だけ手伝える募集を見る</a></p>
    {notices ? <p><a href={`/${c.var.ward.slug}/p/${encodeURIComponent(projectId)}`}>この行事の案内を見る</a></p> : null}
  </Layout>);
});

pub.get("/help", async (c) => {
  const opportunities = await listHelpOpportunities(c.env.DB, c.var.ward.wardId);
  return c.html(<Layout title="一回だけ手伝える募集" siteName={c.var.ward.name}>
    <p><a href={`/${c.var.ward.slug}/`}>{c.var.ward.name}のページへ</a></p>
    <h1>一回だけ手伝える募集</h1>
    <p>自治会への加入は必要ありません。手伝える行事を選んでください。</p>
    {opportunities.length ? opportunities.map((item) => <section class="panel">
      <h2>{item.title}</h2>
      <p><a href={`/${c.var.ward.slug}/help/${encodeURIComponent(item.projectId)}`}>この行事に手伝いを申し込む</a></p>
    </section>) : <p>現在、手伝いを募集中の行事はありません。</p>}
  </Layout>);
});

pub.get("/p/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const [items, activity] = await Promise.all([
    listPublic(c.env.DB, c.var.ward.wardId, projectId, true),
    c.env.DB.prepare("SELECT published_at FROM project_activity_pages WHERE ward_id = ? AND project_id = ? AND published_at IS NOT NULL")
      .bind(c.var.ward.wardId, projectId).first<{ published_at: string }>(),
  ]);
  if (items.length === 0) return c.notFound();
  // items は掲載日の新しい順。文書ごとに最新の掲載が今の案内で、それを下げていれば文書ごと掲載を終えた扱いにする。
  // 古い掲載は今の案内と取り違えないよう畳んで後ろに置き、下げた古い掲載は出さない。
  const documents = new Map<string, { latest: PublicProject; earlier: PublicProject[] }>();
  for (const item of items) {
    const entry = documents.get(item.document_id);
    if (!entry) documents.set(item.document_id, { latest: item, earlier: [] });
    else if (!entry.latest.unpublished_at && !item.unpublished_at) entry.earlier.push(item);
  }
  const details = await pageFooter(c, projectId);
  return c.html(<Layout title={items[0]!.title} siteName={c.var.ward.name}>
    <p><a href={`/${c.var.ward.slug}/`}>{c.var.ward.name}のお知らせ</a></p>
    <h1>{items[0]!.title}</h1>
    {[...documents.values()].map(({ latest, earlier }) => {
      const date = (item: PublicProject) => new Date(item.published_at).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
      if (latest.unpublished_at) return <article class="panel" key={latest.document_id}>
        <p>{date(latest)} に載せた案内は、掲載を終えました。</p>
      </article>;
      return <article class="panel" key={latest.document_id}>
        <h2>{latest.document_title}</h2>
        <p>掲載日: {date(latest)}</p>
        <ArticleBody body={latest.body} />
        {earlier.map((older) => <details>
          <summary>変更前の案内（{date(older)} 掲載）</summary>
          <ArticleBody body={older.body} />
        </details>)}
      </article>;
    })}
    {activity ? <p><a href={`/${c.var.ward.slug}/work/${encodeURIComponent(projectId)}`}>役員の仕事と活動を見る</a></p> : null}
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
