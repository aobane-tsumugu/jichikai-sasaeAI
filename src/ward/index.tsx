import { projectTasks, taskFeatures, taskCollectsAttendance, taskDocumentKind } from "../project/task-features";
import { getSquads } from "../settings/store";
import { getAnswerDeadline } from "../answers/api";
import { ReceptionClosed, ResidentContact, EventDetails, residentContext, publishedItem } from "../answers/resident";
import { formatDateText, formatJstDate } from "../core/time";
import { Hono } from "hono";
import { Layout } from "../core/ui";
import type { Bundle } from "../core/bundle";
import type { WardEnv } from "../env";
import { getOfficialLineUrl, getSetting } from "../settings/store";
import { ArticleBody } from "../publish";
import { listHelpOpportunities } from "../answers/help";
import { documentTitle, paperHeading } from "../project/heading";
import { DOCUMENT_KIND_LABEL, type DocumentKind, type ProjectKind } from "../project/model";
import { PUBLIC_PRIVACY_NOTICE } from "../settings/keys";
import { activityFacts } from "./activity";
import { wardContact } from "./contact";
import { WardBucket } from "../core/storage";
import { noticeFlyerPath } from "../publish/notice-flyers";

interface PublicProject {
  project_id: string;
  kind: DocumentKind;
  project_kind: ProjectKind;
  closed_at: string | null;
  title: string;
  version_no: number;
  document_id: string;
  document_title: string;
  display_title?: string;
  body: string;
  published_at: string;
  unpublished_at: string | null;
  version_id: string;
  flyer_id: string | null;
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
      v.body, v.version_id, f.flyer_id, r.published_at, r.unpublished_at
    FROM publication_records r
    JOIN projects p ON p.ward_id = r.ward_id AND p.project_id = r.project_id
    JOIN documents d ON d.ward_id = r.ward_id AND d.document_id = r.document_id
    JOIN document_versions v ON v.ward_id = r.ward_id AND v.version_id = r.version_id
    LEFT JOIN notice_flyers f ON f.ward_id = r.ward_id AND f.version_id = r.version_id
    WHERE r.ward_id = ? AND v.scope = 'public'${includeLowered ? "" : " AND r.unpublished_at IS NULL AND NOT EXISTS (SELECT 1 FROM publication_records newer WHERE newer.ward_id = r.ward_id AND newer.document_id = r.document_id AND newer.version_no > r.version_no)"}${projectId ? " AND r.project_id = ?" : ""}
    ORDER BY r.published_at DESC, v.version_no DESC`;
  const statement = db.prepare(sql);
  const result = projectId ? await statement.bind(wardId, projectId).all<PublicProject>() : await statement.bind(wardId).all<PublicProject>();
  const taskLists = new Map(await Promise.all([...new Set(result.results.map((item) => item.project_id))].map(async (id) =>
    [id, await projectTasks(db, wardId, id)] as const)));
  return result.results.map((item) => ({ ...item, display_title: item.document_title === DOCUMENT_KIND_LABEL[item.kind]
    ? documentTitle(taskDocumentKind(taskLists.get(item.project_id)!, item.kind), item.kind) : item.document_title }));
}

function publicDocumentTitle(item: PublicProject): string {
  return item.display_title ?? item.document_title;
}

async function pageFooter(c: { env: { DB: D1Database }; var: { ward: { wardId: string; slug: string } } }, documentContact = "") {
  const contact = documentContact || await wardContact(c.env.DB, c.var.ward.wardId);
  const lineUrl = await getOfficialLineUrl(c.env.DB, c.var.ward.wardId);
  return <>
    <h2>分からないときは</h2><ResidentContact contact={contact} />
    {lineUrl ? <a class="quiet" href={`/${c.var.ward.slug}/line`}>新しいお知らせを、LINEで受け取る</a> : null}
    <p><a class="quiet" href={`/${c.var.ward.slug}/privacy`}>個人情報の扱い</a></p>
  </>;
}

const pub = new Hono<WardEnv>();

// 原本のパスや下書きの番号から画像を読める入口は置かない。
pub.get("/flyers/:versionId/:flyerId/:file", async (c) => {
  const file = c.req.param("file");
  if (file !== "image.jpg" && file !== "preview.jpg") return c.notFound();
  const flyer = await c.env.DB.prepare(`SELECT f.r2_path, f.preview_r2_path FROM notice_flyers f
    JOIN publication_records r ON r.ward_id = f.ward_id AND r.version_id = f.version_id AND r.project_id = f.project_id
    JOIN document_versions v ON v.ward_id = r.ward_id AND v.version_id = r.version_id
    WHERE f.ward_id = ? AND f.version_id = ? AND f.flyer_id = ?
      AND r.unpublished_at IS NULL AND v.published_at IS NOT NULL AND v.scope = 'public'`)
    .bind(c.var.ward.wardId, c.req.param("versionId"), c.req.param("flyerId")).first<{ r2_path: string; preview_r2_path: string }>();
  c.header("Cache-Control", "no-store");
  if (!flyer) return c.notFound();
  const object = await new WardBucket(c.env.ORIGINALS, c.var.ward.wardId).get(file === "image.jpg" ? flyer.r2_path : flyer.preview_r2_path);
  return object ? new Response(object.body, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }) : c.notFound();
});

pub.get("/line", async (c) => {
  const lineUrl = await getOfficialLineUrl(c.env.DB, c.var.ward.wardId);
  const contact = await wardContact(c.env.DB, c.var.ward.wardId);
  return c.html(<Layout title="自治会のLINEで受け取る" siteName={c.var.ward.name}>
    <a class="back" href={`/${c.var.ward.slug}/`}>← {c.var.ward.name}のお知らせへ</a>
    <h1>新しいお知らせを、LINEで受け取る</h1>
    <p class="lead">自治会のLINEを友だちに追加すると、新しい案内や変更が、スマホのLINEに届きます。追加は、してもしなくてもかまいません。</p>
    {lineUrl ? <><div class="action-links"><a class="button" href={lineUrl}>LINEで友だちに追加する</a></div><p class="muted">LINEが開きます。</p></> : <p>この自治会のLINEは、まだ用意されていません。</p>}
    <h2>追加しなくても読めます</h2><p>案内は、このページと、紙の回覧、掲示でも読めます。LINEを使わない方は、追加しなくてかまいません。</p>
    <h2>届くもの</h2><p>案内の題とリンクが届きます。チラシが付いているときは、画像と日時・場所、返事のページへのリンクが届きます。くわしい内容は、住民向けのページで読めます。</p>
    <div class="sheet-preview"><p><b>届く知らせの例</b></p><p style="margin-bottom: 0; overflow-wrap: anywhere">秋の収穫祭のご案内<br />{`${new URL(c.req.url).origin}/${c.var.ward.slug}/p/akimatsuri`}</p></div>
    <h2>名前や世帯の登録はいりません</h2><p>友だちに追加すれば、受け取れます。名前、世帯、班を伝える必要はありません。LINEの中で、質問したり答えたりする必要もありません。</p>
    <h2>届かなくしたいとき</h2><p>LINEで、自治会のLINEのアカウントをブロックすると、届かなくなります。もう一度追加すれば、また届きます。</p>
    <h2>分からないときは</h2><ResidentContact contact={contact} /><ul class="links"><li><a href={`/${c.var.ward.slug}/privacy`}>個人情報の扱い</a></li></ul>
  </Layout>);
});

pub.get("/privacy", async (c) => {
  const contact = await wardContact(c.env.DB, c.var.ward.wardId);
  const purpose = await getSetting(c.env.DB, c.var.ward.wardId, "privacy_notice");
  return c.html(<Layout title="個人情報の扱い" siteName={c.var.ward.name}>
    <a class="back" href={`/${c.var.ward.slug}/`}>← {c.var.ward.name}のお知らせへ</a>
    <h1>個人情報の扱い</h1><p class="lead">返事や送られた資料を、何に使い、どう預かるかです。</p>
    <h2>何に使うか</h2><p>返事や送られた資料は、自治会の行事や連絡、返事の受付のために使います。</p>
    <h2>だれが預かるか</h2><p>このページを動かしているSasaeAIの運営者が、自治会から頼まれて、返事や資料を預かります。個人情報を守る決まりが守られているかは、SasaeAIの運営者が確かめます。</p>
    <h2>文章の読み取り</h2><p>紙や写真の文章の読み取りは、AI事業者のAnthropicに委託します。</p>
    <p>Anthropic社に送った内容は、通常、受け取ったときか文章を作ったときから30日以内に消されます。利用ポリシーへの対応、法令、契約の条件により、もっと長く残る場合があります。</p>
    <h2>消してほしいとき</h2><p>消してほしいときや、個人情報について聞きたいときは、{contact ? "下の連絡先" : "班長か役員"}へお知らせください。</p><p>役員が対象を確かめて、元の資料、読み取った内容、それらを探すための一覧を、いっしょに消します。</p>
    <h2>SasaeAIをやめるとき</h2><p>自治会がSasaeAIの利用をやめるときは、元の資料、知らせたもの、記録を、自治会にお渡しします。そのあと、預かっているものと、Anthropic社での処理を消します。読み取りの設定を止めて、保管場所も消します。</p>
    {purpose && purpose !== PUBLIC_PRIVACY_NOTICE ? <><h2>この自治会からのお知らせ</h2><p class="preserve-lines">{purpose}</p></> : null}
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
  const noticeProjects = new Set(current.filter((item) => item.kind === "notice").map((item) => item.project_id));
  // 過去の行事は一行にする。報告があれば報告、なければ案内を読む。
  const pastRank = (item: PublicProject) => (item.kind === "report" ? 0 : item.kind === "announcement" ? 1 : 2);
  const pastByProject = new Map<string, PublicProject>();
  for (const item of unique.filter((entry) => !isCurrent(entry))) {
    const kept = pastByProject.get(item.project_id);
    if (!kept || pastRank(item) < pastRank(kept)) pastByProject.set(item.project_id, item);
  }
  const past = [...pastByProject.values()];
  const descriptions = activities.results.flatMap((item) => {
    const body = parseActivity(item.published_body);
    if (!body) return [];
    const topics = [body.introduction.trim() ? "役員の仕事" : "", body.membershipBurden.trim() ? "加入すると担うこと" : "", body.membershipBenefit.trim() ? "加入すると得られること" : ""].filter(Boolean);
    return topics.length ? [{ ...item, topics }] : [];
  });
  const row = (item: PublicProject) => {
    // 知らせは本文を読む。項目や同じ行事の以前の案内から、古い日時・場所を足し戻さない。
    const showDetails = isCurrent(item) && !noticeProjects.has(item.project_id);
    const dateTime = showDetails ? publishedItem(item.body, "date_time") : "";
    const place = showDetails ? publishedItem(item.body, "place") : "";
    return <li key={item.document_id}><a class="row-link" href={`/${c.var.ward.slug}/p/${encodeURIComponent(item.project_id)}`}><b>{item.kind === "announcement" && publicDocumentTitle(item) === "案内" ? `${item.title}のご案内` : item.kind === "report" && publicDocumentTitle(item) === "報告" ? `${item.title}の報告` : paperHeading(item.title, publicDocumentTitle(item))}</b>{dateTime ? <span>{formatDateText(dateTime)}</span> : null}{place ? <span>{place}</span> : null}{dateTime || place ? null : <span>{formatJstDate(item.published_at)}に載せました</span>}</a></li>;
  };
  const [contact, lineUrl] = await Promise.all([wardContact(c.env.DB, c.var.ward.wardId), getOfficialLineUrl(c.env.DB, c.var.ward.wardId)]);
  return c.html(<Layout title={`${c.var.ward.name}のお知らせ`} siteName={c.var.ward.name}>
    <h1>{c.var.ward.name}のお知らせ</h1>
    <p class="lead">{c.var.ward.name}は、この地域の自治会です。加入していなくても、登録しなくても読めます。</p>
    {c.env.DEMO_NOTICE ? <p class="muted">{c.env.DEMO_NOTICE}</p> : null}
    {current.length ? <ul class="rows two">{current.map(row)}</ul> : <div class="notice" role="status"><strong>今、出ているお知らせはありません</strong><p>案内が出ると、ここに載ります。</p></div>}
    {opportunities.length ? <><h2>一回だけ手伝う</h2><p>自治会に加入していなくても手伝えます。お名前と手伝える時間帯を教えてください。</p><div class="action-links"><a class="button secondary" href={`/${c.var.ward.slug}/help`}>手伝いを申し込む</a></div></> : null}
    {lineUrl ? <><h2>新しいお知らせを受け取る</h2><p>自治会のLINEを友だちに追加すると、新しいお知らせがスマホに届きます。名前の登録はいりません。追加しなくても、このページと紙で読めます。</p><div class="action-links"><a class="button secondary" href={`/${c.var.ward.slug}/line`}>LINEで受け取る</a></div></> : null}
    {past.length ? <><h2>これまでのお知らせと報告</h2><ul class="rows two">{past.map(row)}</ul></> : null}
    {descriptions.length ? <><h2>自治会の説明をご覧ください</h2><ul class="rows">{descriptions.map((item) => <li key={item.project_id}><a class="row-link" href={`/${c.var.ward.slug}/work/${encodeURIComponent(item.project_id)}`}><b>{item.title}と自治会の説明を読む</b><span>{item.topics.join("、")}</span></a></li>)}</ul></> : null}
    <h2>分からないときは</h2><ResidentContact contact={contact} />
    <details class="hint"><summary>個人情報の扱いについて</summary><div><p>返事は行事の準備と運営のために使います。消してほしいときは、{contact ? "上の連絡先" : "班長か役員"}へお知らせください。</p><p><a class="quiet" href={`/${c.var.ward.slug}/privacy`}>個人情報の扱いを読む</a></p></div></details>
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
    <h1>{activity.title}と自治会の説明をご覧ください</h1>
    <p class="lead">関わり方を考えるときに、役員が書いた説明をご覧ください。</p>
    {body.introduction.trim() ? <><p style="white-space:pre-wrap">{body.introduction}</p>
    {listed.length || facts.length ? <><h2>役員の仕事をご覧ください</h2>
    <p>仕事の記録から作りました。</p>
    {listed.length ? <ul>{listed.map((task) => <li>{task.name}{task.period ? `（${task.period}）` : ""}</li>)}</ul> : null}
    {facts.length ? <ul>{facts.map((fact) => <li>{fact}</li>)}</ul> : null}
    </> : null}</> : null}
    {body.membershipBurden.trim() ? <><h2>加入すると担うことをご覧ください</h2><p style="white-space:pre-wrap">{body.membershipBurden}</p></> : null}
    {body.membershipBenefit.trim() ? <><h2>加入すると得られることをご覧ください</h2><p style="white-space:pre-wrap">{body.membershipBenefit}</p></> : null}
    <h2>関わり方は選べます</h2><p>読むだけでも、一回だけ手伝うだけでもかまいません。</p>
    {opportunities.length ? <p class="link-line"><a href={`/${c.var.ward.slug}/help`}>手伝いを申し込む</a></p> : null}
    <h2>来年の案内をご覧ください</h2>
    <p>来年の案内も住民向けのページで読めます。名前や世帯の登録はいりません。</p>
    <p class="link-line"><a href={`/${c.var.ward.slug}/`}>住民向けのページで案内を見る</a></p>
    {lineUrl ? <><p>自治会のLINEを友だちに追加すると、新しい案内が届きます。追加は、してもしなくてもかまいません。</p>
      <p class="link-line"><a href={`/${c.var.ward.slug}/line`}>自治会のLINEで案内を受け取る</a></p></> : null}
    {notices[0] ? <p class="link-line"><a href={`/${c.var.ward.slug}/p/${encodeURIComponent(projectId)}`}>{notices[0].kind === "announcement" ? "この行事の案内を見る" : `${publicDocumentTitle(notices[0])}を見る`}</a></p> : null}
  </Layout>);
});

pub.get("/help", async (c) => {
  const opportunities = await listHelpOpportunities(c.env.DB, c.var.ward.wardId);
  if (opportunities.length === 1) return c.redirect(`/${c.var.ward.slug}/help/${encodeURIComponent(opportunities[0]!.projectId)}`, 302);
  return c.html(<Layout title="一回だけ手伝う" siteName={c.var.ward.name}>
    <p class="link-line"><a href={`/${c.var.ward.slug}/`}>{c.var.ward.name}のページへ</a></p>
    <h1>一回だけ手伝う</h1>
    <p>自治会に加入していなくても申し込めます。手伝える行事を選んでください。</p>
    {opportunities.length ? opportunities.map((item) => <section class="panel">
      <h2>{item.title}</h2><p>{publishedItem(item.body, "date_time") ? formatDateText(publishedItem(item.body, "date_time")) : `案内を知らせた日: ${formatJstDate(item.publishedAt)}`}</p>
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
  const context = await residentContext(c.env.DB, c.var.ward.wardId, projectId);
  const details = await pageFooter(c, context.contact);
  const deadline = await getAnswerDeadline(c.env.DB, c.var.ward.wardId, projectId);
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
  const closed = !!items[0]!.closed_at || (deadline !== null && deadline < today);
  const squads = await getSquads(c.env.DB, c.var.ward.wardId);
  const squad = c.req.query("s") ?? "";
  const suffix = squad && squads.includes(squad) ? `?s=${encodeURIComponent(squad)}` : "";
  const ordered = [...documents.values()].sort((a, b) => Number(b.latest.kind === "notice") - Number(a.latest.kind === "notice"));
  // 終わった行事は、あとから来た人（家族、来年の候補）が読みたい報告を先に出す。案内は「前に出した案内」として後ろに残す。
  const reports = ordered.filter(({ latest }) => latest.kind === "report" && !latest.unpublished_at);
  const featureTasks = await projectTasks(c.env.DB, c.var.ward.wardId, projectId);
  const features = taskFeatures(featureTasks);
  const activeAnnouncement = ordered.some(({ latest }) => taskCollectsAttendance(featureTasks, latest.kind) && !latest.unpublished_at);
  const changes = ordered.some(({ latest }) => latest.kind === "notice" && !latest.unpublished_at);
  const newerNotice = ordered.some(({ latest: notice }) => notice.kind === "notice" && !notice.unpublished_at &&
    ordered.some(({ latest: announcement }) => announcement.kind === "announcement" && !announcement.unpublished_at && notice.published_at > announcement.published_at));
  const renderDocument = ({ latest, earlier }: { latest: PublicProject; earlier: PublicProject[] }) => {
      const date = (item: PublicProject) => formatJstDate(item.published_at);
      const title = publicDocumentTitle(latest);
      const event = latest.kind === "announcement";
      if (latest.unpublished_at) return <article class="panel" key={latest.document_id}>
        <p>{date(latest)} に載せた{event ? "案内" : title}は、住民向けのページから取り下げました。</p>
      </article>;
      return <article class="panel" key={latest.document_id}>
        <h2>{latest.kind === "announcement" ? reports.length ? "前に出した案内" : changes ? `${date(latest)}に知らせた案内` : "くわしい案内" : title}</h2>
        {latest.kind === "announcement" && changes ? <p>変わったところは、上のお知らせのとおりです。</p> : null}
        <ArticleBody body={latest.body} title={{ project: latest.title, document: latest.document_title }} kind={latest.kind} hide={latest.kind === "announcement" && !changes ? ["date_time", "place", "rain_plan", "due", "public_contact"] : []} />
        {latest.flyer_id && !(latest.kind === "announcement" && newerNotice) ? <img src={noticeFlyerPath(c.var.ward.slug, latest.version_id, latest.flyer_id)} alt={latest.document_title} style="max-width:100%;height:auto" /> : null}
        <p class="muted">{date(latest)}に載せました</p>
        {earlier.map((older) => <details>
          <summary>変更前の{event ? "案内" : publicDocumentTitle(older)}（{date(older)}に載せたもの）</summary>
          <ArticleBody body={older.body} title={{ project: older.title, document: older.document_title }} kind={older.kind} />
        </details>)}
      </article>;
    };
  const top = reports[0]?.latest ?? items[0]!;
  const heading = top.kind === "announcement" && publicDocumentTitle(top) === "案内" ? `${top.title}のご案内` : top.kind === "report" && publicDocumentTitle(top) === "報告" ? `${top.title}の報告` : paperHeading(top.title, publicDocumentTitle(top));
  return c.html(<Layout title={publicDocumentTitle(items[0]!) === "案内" ? items[0]!.title : heading} siteName={c.var.ward.name}>
    <a class="back" href={`/${c.var.ward.slug}/`}>← お知らせの一覧へ</a>
    <h1>{heading}</h1>
    {reports.map(renderDocument)}
    {ordered.filter(({ latest }) => latest.kind === "notice").map(renderDocument)}
    {activeAnnouncement ? <>
      {!newerNotice ? <EventDetails item={context.item} due={deadline} /> : deadline ? <p>返事の締切 {formatJstDate(deadline)}まで</p> : null}
      {closed ? <ReceptionClosed closed={!!items[0]!.closed_at} due={deadline} /> : <><p><a class="button" href={`/${c.var.ward.slug}/answer/${encodeURIComponent(projectId)}${suffix}`}>出欠を答える</a></p><p>{features.delegation ? "出席、委任、欠席のどれかを答えてください。" : "参加しないときも、返事をもらえると、準備の数が正しく分かります。返事がないときは、欠席として数えます。"}代表者のお名前、班、人数を聞きます。紙の回答票を班長に渡しても答えられます。</p></>}
    </> : null}
    {ordered.filter(({ latest }) => latest.kind !== "notice" && !reports.some((report) => report.latest.document_id === latest.document_id)).map(renderDocument)}
    {context.documents.some((document) => document.kind === "recruitment") && !closed ? <section><h2>手伝える方へ</h2><p>自治会に加入していない方も手伝えます。</p><a href={`/${c.var.ward.slug}/help/${encodeURIComponent(projectId)}`}>手伝いを申し込む</a></section> : null}
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
