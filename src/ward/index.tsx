import { getSquads } from "../settings/store";
import { getAnswerDeadline } from "../answers/api";
import { ReceptionClosed, ResidentContact, EventDetails, residentContext, publishedItem } from "../answers/resident";
import { formatDateText, formatJstDate } from "../core/time";
import { Hono } from "hono";
import { Layout } from "../core/ui";
import type { Bundle } from "../core/bundle";
import type { WardEnv } from "../env";
import { getOfficialLineUrl, getPublicContact, getSetting } from "../settings/store";
import { ArticleBody } from "../publish";
import { listHelpOpportunities } from "../answers/help";
import { paperHeading } from "../project/heading";
import { PUBLIC_PRIVACY_NOTICE } from "../settings/keys";

interface PublicProject {
  project_id: string;
  kind: string;
  closed_at: string | null;
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
  const sql = `SELECT p.project_id, p.title, p.closed_at, d.kind, v.version_no, d.document_id, COALESCE(v.title, d.title) AS document_title,
      v.body, r.published_at, r.unpublished_at
    FROM publication_records r
    JOIN projects p ON p.ward_id = r.ward_id AND p.project_id = r.project_id
    JOIN documents d ON d.ward_id = r.ward_id AND d.document_id = r.document_id
    JOIN document_versions v ON v.ward_id = r.ward_id AND v.version_id = r.version_id
    WHERE r.ward_id = ?${includeLowered ? "" : " AND r.unpublished_at IS NULL AND NOT EXISTS (SELECT 1 FROM publication_records newer WHERE newer.ward_id = r.ward_id AND newer.document_id = r.document_id AND newer.version_no > r.version_no)"}${projectId ? " AND r.project_id = ?" : ""}
    ORDER BY r.published_at DESC, v.version_no DESC`;
  const statement = db.prepare(sql);
  const result = projectId ? await statement.bind(wardId, projectId).all<PublicProject>() : await statement.bind(wardId).all<PublicProject>();
  return result.results;
}

async function pageFooter(c: { env: { DB: D1Database }; var: { ward: { wardId: string; slug: string } } }) {
  const contact = await getPublicContact(c.env.DB, c.var.ward.wardId);
  const lineUrl = await getOfficialLineUrl(c.env.DB, c.var.ward.wardId);
  return <>
    <h2>分からないときは</h2><ResidentContact contact={contact} />
    {lineUrl ? <a class="quiet" href={`/${c.var.ward.slug}/line`}>新しいお知らせを、LINEで受け取る</a> : null}
    <p><a class="quiet" href={`/${c.var.ward.slug}/privacy`}>個人情報の扱い</a></p>
  </>;
}

const pub = new Hono<WardEnv>();

pub.get("/line", async (c) => {
  const lineUrl = await getOfficialLineUrl(c.env.DB, c.var.ward.wardId);
  const contact = await getPublicContact(c.env.DB, c.var.ward.wardId);
  return c.html(<Layout title="公式LINEで受け取る" siteName={c.var.ward.name}>
    <a class="back" href={`/${c.var.ward.slug}/`}>{c.var.ward.name}のお知らせへ</a>
    <h1>新しいお知らせを、LINEで受け取る</h1>
    <p class="lead">区の公式LINEを友だちに追加すると、新しい案内や変更が、スマホのLINEに届きます。追加は、してもしなくてもかまいません。</p>
    {lineUrl ? <><a class="button" href={lineUrl}>LINEで友だちに追加する</a><p>LINEが開きます。</p></> : <p>この区の公式LINEは、まだ用意されていません。</p>}
    <h2>追加しなくても読めます</h2><p>案内は、このページと、紙の回覧、掲示でも読めます。LINEを使わない方は、追加しなくてかまいません。</p>
    <h2>届くもの</h2><p>案内の題と、このページへのリンクが届きます。くわしい内容は、リンクを開いて、このページで読みます。</p>
    <h2>名前や世帯の登録はいりません</h2><p>友だちに追加すれば、受け取れます。名前、世帯、班を伝える必要はありません。LINEの中で、質問したり答えたりする必要もありません。</p>
    <h2>届かなくしたいとき</h2><p>LINEで、区の公式アカウントをブロックすると、届かなくなります。もう一度追加すれば、また届きます。</p>
    <h2>分からないときは</h2><ResidentContact contact={contact} /><a class="quiet" href={`/${c.var.ward.slug}/privacy`}>個人情報の扱い</a>
  </Layout>);
});

pub.get("/privacy", async (c) => {
  const contact = await getPublicContact(c.env.DB, c.var.ward.wardId);
  const purpose = await getSetting(c.env.DB, c.var.ward.wardId, "privacy_notice");
  return c.html(<Layout title="個人情報の扱い" siteName={c.var.ward.name}>
    <a class="back" href={`/${c.var.ward.slug}/`}>{c.var.ward.name}のお知らせへ</a>
    <h1>個人情報の扱い</h1><p class="lead">答えや送られた資料を、何に使い、どう預かるかです。</p>
    <h2>何に使うか</h2><p>答えや送られた資料は、自治会の行事や連絡、答えの受付のために使います。</p>
    <h2>だれが預かるか</h2><p>この区のページの仕組みを自治会に提供している事業者が、自治会から頼まれて、答えや資料を預かります。個人情報を守る決まりが守られているかは、この事業者が確かめます。</p>
    <h2>文章の読み取り</h2><p>紙や写真の文章の読み取りは、AI事業者のAnthropicに委託します。</p>
    <p>Anthropic社に送った内容は、通常、受け取ったときか文章を作ったときから30日以内に消されます。利用ポリシーへの対応、法令、契約の条件により、もっと長く残る場合があります。</p>
    <h2>消してほしいとき</h2><p>消してほしいときや、個人情報について聞きたいときは、下の連絡先へお知らせください。</p><p>役員が対象を確かめて、元の資料、読み取った内容、それらを探すための一覧を、いっしょに消します。</p>
    <h2>この仕組みをやめるとき</h2><p>自治会がこの仕組みの利用をやめるときは、元の資料、配ったもの、記録を、自治会にお渡しします。そのあと、預かっているものと、Anthropic社での処理を消します。読み取りの設定を止めて、保管場所も消します。</p>
    {purpose && purpose !== PUBLIC_PRIVACY_NOTICE ? <><h2>この区からのお知らせ</h2><p class="preserve-lines">{purpose}</p></> : null}
    <h2>連絡先</h2><ResidentContact contact={contact} />
  </Layout>);
});

pub.get("/", async (c) => {
  const [items, activities, opportunities] = await Promise.all([
    listPublic(c.env.DB, c.var.ward.wardId),
    c.env.DB.prepare(`SELECT a.project_id, p.title, a.published_at, a.published_body
      FROM project_activity_pages a JOIN projects p ON p.ward_id = a.ward_id AND p.project_id = a.project_id
      WHERE a.ward_id = ? AND a.published_at IS NOT NULL AND a.published_body IS NOT NULL ORDER BY a.published_at DESC`)
      .bind(c.var.ward.wardId).all<PublicActivity>(),
    listHelpOpportunities(c.env.DB, c.var.ward.wardId),
  ]);
  const uniqueItems = new Map<string, PublicProject>();
  for (const item of items) if (!uniqueItems.has(item.document_id)) uniqueItems.set(item.document_id, item);
  const unique = [...uniqueItems.values()];
  return c.html(<Layout title={`${c.var.ward.name}のお知らせ`} siteName={c.var.ward.name}>
    <h1>{c.var.ward.name}のお知らせ</h1>
    <p class="lead">{c.var.ward.name}は、この地域の自治会です。入っていなくても、登録しなくても読めます。</p>
    {c.env.DEMO_NOTICE ? <p class="muted">{c.env.DEMO_NOTICE}</p> : null}
    {opportunities.length ? <section class="panel">
      <h2><a href={`/${c.var.ward.slug}/help`}>一回だけ手伝う</a></h2><p class="lead">自治会に加入していない人も、名前と手伝える時間帯だけで申し込めます。</p>
      <p>自治会に入っていなくても手伝えます。お名前と手伝える時間帯を教えてください。</p>
      <p class="link-line"><a href={`/${c.var.ward.slug}/help`}>手伝いを申し込む</a></p>
    </section> : null}
    <h2>これまでのお知らせと報告</h2>
    {unique.length === 0 ? <p>公開中のお知らせはありません。</p> : unique.map((item) => <section class="panel" key={item.document_id}>
      <h2><a href={`/${c.var.ward.slug}/p/${encodeURIComponent(item.project_id)}`}>{item.kind === "announcement" ? `${item.title}のご案内` : paperHeading(item.title, item.document_title)}</a></h2>
      <p>更新: {formatJstDate(item.published_at)}</p>
    </section>)}
    <h2>自治会の仕事を知る</h2>
    {activities.results.length === 0 ? <p>載せている活動紹介はありません。</p> : activities.results.map((item) => <section class="panel" key={item.project_id}>
      <h3><a href={`/${c.var.ward.slug}/work/${encodeURIComponent(item.project_id)}`}>{item.title}で役員がしたこと</a></h3>
      <p>載せた日: {formatJstDate(item.published_at)}</p>
    </section>)}
    {await pageFooter(c)}
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
  const opportunities = await listHelpOpportunities(c.env.DB, c.var.ward.wardId);
  // 案内を一度も載せていない行事では、案内のページが無いのでリンクを出さない。
  const notices = await c.env.DB.prepare("SELECT 1 AS found FROM publication_records WHERE ward_id = ? AND project_id = ? AND unpublished_at IS NULL LIMIT 1")
    .bind(c.var.ward.wardId, projectId).first<{ found: number }>();
  return c.html(<Layout title={`${activity.title}の活動`} siteName={c.var.ward.name}>
    <p class="link-line"><a href={`/${c.var.ward.slug}/`}>{c.var.ward.name}のページへ</a></p>
    <h1>{activity.title}で役員がしたこと</h1>
    <p class="lead">自治会の仕事を知っていただくために、役員が書きました。</p>
    {body.introduction ? <p style="white-space:pre-wrap">{body.introduction}</p> : null}
    <h2>どんな仕事があったか</h2>
    <p>仕事の記録から作りました。</p>
    {listed.length ? <ul>{listed.map((task) => <li>{formatDateText(task.period) || "時期の記録なし"}　{task.name}</li>)}</ul> : <p>紹介する仕事はありません。</p>}
    <h2>加入すると担うこと</h2><p style="white-space:pre-wrap">{body.membershipBurden || "この項目の説明はありません。"}</p>
    <h2>加入すると得られること</h2><p style="white-space:pre-wrap">{body.membershipBenefit || "この項目の説明はありません。"}</p>
    <h2>関わり方は選べます</h2><p>読むだけでも、一回だけ手伝うだけでもかまいません。</p>
    {opportunities.length ? <p class="link-line"><a href={`/${c.var.ward.slug}/help`}>手伝いを申し込む</a></p> : null}
    {notices ? <p class="link-line"><a href={`/${c.var.ward.slug}/p/${encodeURIComponent(projectId)}`}>この行事の案内を見る</a></p> : null}
  </Layout>);
});

pub.get("/help", async (c) => {
  const opportunities = await listHelpOpportunities(c.env.DB, c.var.ward.wardId);
  if (opportunities.length === 1) return c.redirect(`/${c.var.ward.slug}/help/${encodeURIComponent(opportunities[0]!.projectId)}`, 302);
  return c.html(<Layout title="一回だけ手伝う" siteName={c.var.ward.name}>
    <p class="link-line"><a href={`/${c.var.ward.slug}/`}>{c.var.ward.name}のページへ</a></p>
    <h1>一回だけ手伝う</h1>
    <p>自治会に入っていなくても申し込めます。手伝える行事を選んでください。</p>
    {opportunities.length ? opportunities.map((item) => <section class="panel">
      <h2>{item.title}</h2><p>{publishedItem(item.body, "date_time") ? formatDateText(publishedItem(item.body, "date_time")) : `案内を配った日: ${formatJstDate(item.publishedAt)}`}</p>
      <p class="link-line"><a href={`/${c.var.ward.slug}/help/${encodeURIComponent(item.projectId)}`}>この行事に手伝いを申し込む</a></p>
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
  const details = await pageFooter(c);
  const context = await residentContext(c.env.DB, c.var.ward.wardId, projectId);
  const deadline = await getAnswerDeadline(c.env.DB, c.var.ward.wardId, projectId);
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
  const closed = !!items[0]!.closed_at || (deadline !== null && deadline < today);
  const squads = await getSquads(c.env.DB, c.var.ward.wardId);
  const squad = c.req.query("s") ?? "";
  const suffix = squad && squads.includes(squad) ? `?s=${encodeURIComponent(squad)}` : "";
  const ordered = [...documents.values()].sort((a, b) => Number(b.latest.kind === "notice") - Number(a.latest.kind === "notice"));
  const activeAnnouncement = ordered.some(({ latest }) => latest.kind === "announcement" && !latest.unpublished_at);
  const changes = ordered.some(({ latest }) => latest.kind === "notice" && !latest.unpublished_at);
  const newerNotice = ordered.some(({ latest: notice }) => notice.kind === "notice" && !notice.unpublished_at &&
    ordered.some(({ latest: announcement }) => announcement.kind === "announcement" && !announcement.unpublished_at && notice.published_at > announcement.published_at));
  const renderDocument = ({ latest, earlier }: { latest: PublicProject; earlier: PublicProject[] }) => {
      const date = (item: PublicProject) => formatJstDate(item.published_at);
      if (latest.unpublished_at) return <article class="panel" key={latest.document_id}>
        <p>{date(latest)} に載せた案内は、区のページから下げました。</p>
      </article>;
      return <article class="panel" key={latest.document_id}>
        <h2>{latest.kind === "announcement" ? changes ? `${date(latest)}に配った案内` : "くわしい案内" : latest.document_title}</h2>
        {latest.kind === "announcement" && changes ? <p>変わったところは、上のお知らせのとおりです。</p> : null}
        <p>載せた日: {date(latest)}</p>
        <ArticleBody body={latest.body} />
        {earlier.map((older) => <details>
          <summary>変更前の案内（{date(older)}に載せたもの）</summary>
          <ArticleBody body={older.body} />
        </details>)}
      </article>;
    };
  return c.html(<Layout title={items[0]!.title} siteName={c.var.ward.name}>
    <p class="link-line"><a href={`/${c.var.ward.slug}/`}>{c.var.ward.name}のお知らせ</a></p>
    <h1>{items[0]!.title}のご案内</h1>
    {ordered.filter(({ latest }) => latest.kind === "notice").map(renderDocument)}
    {activeAnnouncement ? <>
      {!newerNotice ? <EventDetails item={context.item} /> : null}
      {deadline ? <p>答えの締切{formatJstDate(deadline)}まで</p> : null}
      {closed ? <ReceptionClosed closed={!!items[0]!.closed_at} due={deadline} /> : <><p><a class="button" href={`/${c.var.ward.slug}/answer/${encodeURIComponent(projectId)}${suffix}`}>出欠を答える</a></p><p>参加しないときも、答えてください。答えがないときは、欠席として数えます。紙の回答票を班長に渡しても答えられます。</p></>}
    </> : null}
    {ordered.filter(({ latest }) => latest.kind !== "notice").map(renderDocument)}
    {context.documents.some((document) => document.kind === "recruitment") && !closed ? <section><h2>手伝える方へ</h2><p>自治会に入っていない方も手伝えます。</p><a href={`/${c.var.ward.slug}/help/${encodeURIComponent(projectId)}`}>手伝いを申し込む</a></section> : null}
    {activity ? <p class="link-line"><a href={`/${c.var.ward.slug}/work/${encodeURIComponent(projectId)}`}>役員の仕事と活動を見る</a></p> : null}
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
  const squads = await getSquads(c.env.DB, c.var.ward.wardId);
  const squad = c.req.query("s") ?? "";
  return c.redirect(`/${c.var.ward.slug}/p/${encodeURIComponent(projectId)}${squad && squads.includes(squad) ? `?s=${encodeURIComponent(squad)}` : ""}`, 302);
});

export const wardPages: Bundle = { pub };
