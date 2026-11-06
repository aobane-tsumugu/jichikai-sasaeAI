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
import { documentTitle, paperHeading } from "../project/heading";
import type { DocumentKind, ProjectKind } from "../project/model";
import { PUBLIC_PRIVACY_NOTICE } from "../settings/keys";
import { activityFacts } from "./activity";

interface PublicProject {
  project_id: string;
  kind: DocumentKind;
  project_kind: ProjectKind;
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
interface ActivityBody { introduction: string; membershipBurden: string; membershipBenefit: string; tasks: ActivityTask[]; facts?: string[]; }

function parseActivity(raw: string): ActivityBody | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const body = value as Partial<ActivityBody>;
    if (typeof body.introduction !== "string" || typeof body.membershipBurden !== "string" || typeof body.membershipBenefit !== "string" || !Array.isArray(body.tasks)) return null;
    const tasks = body.tasks.filter((task): task is ActivityTask => typeof task === "object" && task !== null &&
      typeof task.taskId === "string" && typeof task.name === "string" && typeof task.period === "string");
    const facts = Array.isArray(body.facts) && body.facts.every((fact) => typeof fact === "string") ? body.facts : undefined;
    return { introduction: body.introduction, membershipBurden: body.membershipBurden, membershipBenefit: body.membershipBenefit, tasks, facts };
  } catch { return null; }
}

async function listPublic(db: D1Database, wardId: string, projectId?: string, includeLowered = false): Promise<PublicProject[]> {
  const sql = `SELECT p.project_id, p.title, p.kind AS project_kind, p.closed_at, d.kind, v.version_no, d.document_id, COALESCE(v.title, d.title) AS document_title,
      v.body, r.published_at, r.unpublished_at
    FROM publication_records r
    JOIN projects p ON p.ward_id = r.ward_id AND p.project_id = r.project_id
    JOIN documents d ON d.ward_id = r.ward_id AND d.document_id = r.document_id
    JOIN document_versions v ON v.ward_id = r.ward_id AND v.version_id = r.version_id
    WHERE r.ward_id = ? AND v.scope = 'public'${includeLowered ? "" : " AND r.unpublished_at IS NULL AND NOT EXISTS (SELECT 1 FROM publication_records newer WHERE newer.ward_id = r.ward_id AND newer.document_id = r.document_id AND newer.version_no > r.version_no)"}${projectId ? " AND r.project_id = ?" : ""}
    ORDER BY r.published_at DESC, v.version_no DESC`;
  const statement = db.prepare(sql);
  const result = projectId ? await statement.bind(wardId, projectId).all<PublicProject>() : await statement.bind(wardId).all<PublicProject>();
  return result.results;
}

function publicDocumentTitle(item: PublicProject): string {
  return item.project_kind === "event" ? item.document_title : documentTitle(item.project_kind, item.kind);
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
    <a class="back" href={`/${c.var.ward.slug}/`}>← {c.var.ward.name}のお知らせへ</a>
    <h1>新しいお知らせを、LINEで受け取る</h1>
    <p class="lead">区の公式LINEを友だちに追加すると、新しい案内や変更が、スマホのLINEに届きます。追加は、してもしなくてもかまいません。</p>
    {lineUrl ? <><a class="button" href={lineUrl}>LINEで友だちに追加する</a><p>LINEが開きます。</p></> : <p>この区の公式LINEは、まだ用意されていません。</p>}
    <h2>追加しなくても読めます</h2><p>案内は、このページと、紙の回覧、掲示でも読めます。LINEを使わない方は、追加しなくてかまいません。</p>
    <h2>届くもの</h2><p>案内の題と、このページへのリンクが届きます。くわしい内容は、リンクを開いて、このページで読みます。</p>
    <div class="sheet-preview"><p><b>届く知らせの例</b></p><p style="margin-bottom: 0; overflow-wrap: anywhere">秋の収穫祭のご案内<br />{`${new URL(c.req.url).origin}/${c.var.ward.slug}/p/akimatsuri`}</p></div>
    <h2>名前や世帯の登録はいりません</h2><p>友だちに追加すれば、受け取れます。名前、世帯、班を伝える必要はありません。LINEの中で、質問したり答えたりする必要もありません。</p>
    <h2>届かなくしたいとき</h2><p>LINEで、区の公式アカウントをブロックすると、届かなくなります。もう一度追加すれば、また届きます。</p>
    <h2>分からないときは</h2><ResidentContact contact={contact} /><ul class="links"><li><a href={`/${c.var.ward.slug}/privacy`}>個人情報の扱い</a></li></ul>
  </Layout>);
});

pub.get("/privacy", async (c) => {
  const contact = await getPublicContact(c.env.DB, c.var.ward.wardId);
  const purpose = await getSetting(c.env.DB, c.var.ward.wardId, "privacy_notice");
  return c.html(<Layout title="個人情報の扱い" siteName={c.var.ward.name}>
    <a class="back" href={`/${c.var.ward.slug}/`}>← {c.var.ward.name}のお知らせへ</a>
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
  const isCurrent = (item: PublicProject) => !item.closed_at && (item.kind === "announcement" || item.kind === "notice");
  const current = unique.filter(isCurrent);
  const past = unique.filter((item) => !isCurrent(item));
  const row = (item: PublicProject) => <li key={item.document_id}><a class="row-link" href={`/${c.var.ward.slug}/p/${encodeURIComponent(item.project_id)}`}><b>{item.project_kind === "event" && item.kind === "announcement" ? `${item.title}のご案内` : paperHeading(item.title, publicDocumentTitle(item))}</b>{isCurrent(item) && publishedItem(item.body, "date_time") ? <span>{formatDateText(publishedItem(item.body, "date_time"))}</span> : null}{isCurrent(item) && publishedItem(item.body, "place") ? <span>{publishedItem(item.body, "place")}</span> : null}{isCurrent(item) && (publishedItem(item.body, "date_time") || publishedItem(item.body, "place")) ? null : <span>{formatJstDate(item.published_at)}に載せました</span>}</a></li>;
  const [contact, lineUrl] = await Promise.all([getPublicContact(c.env.DB, c.var.ward.wardId), getOfficialLineUrl(c.env.DB, c.var.ward.wardId)]);
  return c.html(<Layout title={`${c.var.ward.name}のお知らせ`} siteName={c.var.ward.name}>
    <h1>{c.var.ward.name}のお知らせ</h1>
    <p class="lead">{c.var.ward.name}は、この地域の自治会です。入っていなくても、登録しなくても読めます。</p>
    {c.env.DEMO_NOTICE ? <p class="muted">{c.env.DEMO_NOTICE}</p> : null}
    {current.length ? <ul class="rows two">{current.map(row)}</ul> : <div class="notice" role="status"><strong>今、出ているお知らせはありません</strong><p>案内が出ると、ここに載ります。</p></div>}
    {opportunities.length ? <><h2>一回だけ手伝う</h2><p>自治会に入っていなくても手伝えます。お名前と手伝える時間帯を教えてください。</p><div class="action-links"><a class="button secondary" href={`/${c.var.ward.slug}/help`}>手伝いを申し込む</a></div></> : null}
    {lineUrl ? <><h2>新しいお知らせを受け取る</h2><p>区の公式LINEを友だちに追加すると、新しいお知らせがスマホに届きます。名前の登録はいりません。追加しなくても、このページと紙で読めます。</p><div class="action-links"><a class="button secondary" href={`/${c.var.ward.slug}/line`}>LINEで受け取る</a></div></> : null}
    {past.length ? <><h2>これまでのお知らせと報告</h2><ul class="rows two">{past.map(row)}</ul></> : null}
    {activities.results.length ? <><h2>自治会の仕事を知る</h2><ul class="rows">{activities.results.map((item) => <li key={item.project_id}><a class="row-link" href={`/${c.var.ward.slug}/work/${encodeURIComponent(item.project_id)}`}><b>{item.title}で役員がしたこと</b><span>加入すると担うことと、得られることも読めます</span></a></li>)}</ul></> : null}
    <h2>分からないときは</h2><ResidentContact contact={contact} />
    <details class="hint"><summary>個人情報の扱いについて</summary><div><p>答えは行事の準備と運営のために使います。消してほしいときは、上の連絡先へお知らせください。</p><p><a class="quiet" href={`/${c.var.ward.slug}/privacy`}>個人情報の扱いを読む</a></p></div></details>
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
  const { tasks: listed, facts } = body.facts ? { tasks: body.tasks, facts: body.facts }
    : await activityFacts(c.env.DB, c.var.ward.wardId, projectId, body.tasks);
  const opportunities = await listHelpOpportunities(c.env.DB, c.var.ward.wardId);
  const lineUrl = await getOfficialLineUrl(c.env.DB, c.var.ward.wardId);
  // 案内を一度も載せていない行事では、案内のページが無いのでリンクを出さない。
  const notices = await listPublic(c.env.DB, c.var.ward.wardId, projectId);
  return c.html(<Layout title={`${activity.title}の活動`} siteName={c.var.ward.name}>
    <p class="link-line"><a href={`/${c.var.ward.slug}/`}>{c.var.ward.name}のページへ</a></p>
    <h1>{activity.title}で役員がしたこと</h1>
    <p class="lead">役員の仕事の記録です。関わり方を考える時にご覧ください。</p>
    {body.introduction ? <p style="white-space:pre-wrap">{body.introduction}</p> : null}
    <h2>どんな仕事があったか</h2>
    <p>仕事の記録から作りました。</p>
    {listed.length ? <ul>{listed.map((task) => <li>{task.name}{task.period ? `（${task.period}）` : ""}</li>)}</ul> : null}
    {facts.length ? <ul>{facts.map((fact) => <li>{fact}</li>)}</ul> : null}
    {!listed.length && !facts.length ? <p>紹介する仕事はありません。</p> : null}
    <h2>加入すると担うこと</h2><p style="white-space:pre-wrap">{body.membershipBurden || "この項目の説明はありません。"}</p>
    <h2>加入すると得られること</h2><p style="white-space:pre-wrap">{body.membershipBenefit || "この項目の説明はありません。"}</p>
    <h2>関わり方は選べます</h2><p>読むだけでも、一回だけ手伝うだけでもかまいません。</p>
    {opportunities.length ? <p class="link-line"><a href={`/${c.var.ward.slug}/help`}>手伝いを申し込む</a></p> : null}
    <h2>来年の案内をご覧ください</h2>
    <p>来年の案内も区のページで読めます。名前や世帯の登録はいりません。</p>
    <p class="link-line"><a href={`/${c.var.ward.slug}/`}>区のページで案内を見る</a></p>
    {lineUrl ? <><p>公式LINEを友だちに追加すると、新しい案内が届きます。追加は、してもしなくてもかまいません。</p>
      <p class="link-line"><a href={`/${c.var.ward.slug}/line`}>公式LINEで案内を受け取る</a></p></> : null}
    {notices[0] ? <p class="link-line"><a href={`/${c.var.ward.slug}/p/${encodeURIComponent(projectId)}`}>{notices[0].project_kind === "event" ? "この行事の案内を見る" : `${publicDocumentTitle(notices[0])}を見る`}</a></p> : null}
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
      const title = publicDocumentTitle(latest);
      const event = latest.project_kind === "event";
      if (latest.unpublished_at) return <article class="panel" key={latest.document_id}>
        <p>{date(latest)} に載せた{event ? "案内" : title}は、区のページから下げました。</p>
      </article>;
      return <article class="panel" key={latest.document_id}>
        <h2>{event && latest.kind === "announcement" ? changes ? `${date(latest)}に配った案内` : "くわしい案内" : title}</h2>
        {latest.kind === "announcement" && changes ? <p>変わったところは、上のお知らせのとおりです。</p> : null}
        <p>載せた日: {date(latest)}</p>
        <ArticleBody body={latest.body} title={{ project: latest.title, document: latest.document_title }} kind={latest.kind} />
        {earlier.map((older) => <details>
          <summary>変更前の{event ? "案内" : publicDocumentTitle(older)}（{date(older)}に載せたもの）</summary>
          <ArticleBody body={older.body} title={{ project: older.title, document: older.document_title }} kind={older.kind} />
        </details>)}
      </article>;
    };
  const heading = items[0]!.project_kind === "event" ? `${items[0]!.title}のご案内` : paperHeading(items[0]!.title, publicDocumentTitle(items[0]!));
  return c.html(<Layout title={items[0]!.project_kind === "event" ? items[0]!.title : heading} siteName={c.var.ward.name}>
    <a class="back" href={`/${c.var.ward.slug}/`}>← お知らせの一覧へ</a>
    <h1>{heading}</h1>
    {ordered.filter(({ latest }) => latest.kind === "notice").map(renderDocument)}
    {activeAnnouncement ? <>
      {!newerNotice ? <EventDetails item={context.item} due={deadline} /> : deadline ? <p>答えの締切 {formatJstDate(deadline)}まで</p> : null}
      {closed ? <ReceptionClosed closed={!!items[0]!.closed_at} due={deadline} /> : <><p><a class="button" href={`/${c.var.ward.slug}/answer/${encodeURIComponent(projectId)}${suffix}`}>出欠を答える</a></p><p>{items[0]!.project_kind === "general_meeting" ? "出席、委任、欠席のどれかを答えてください。" : "参加しないときも、答えてください。答えがないときは、欠席として数えます。"}紙の回答票を班長に渡しても答えられます。</p></>}
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
