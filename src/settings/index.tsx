import { getDigestSettings, inquiryNotice } from "./digest";
import { getPublicContact } from "./store";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { AdminPage } from "../core/admin-ui";
import { Hint } from "../core/ui";
import { adminPath, clearDeviceCookie } from "../core/auth";
import type { Bundle } from "../core/bundle";
import type { AdminEnv } from "../env";
import { getProjectState, listOpenProjects } from "../project/api";
import { dateWords, daysRemaining } from "../project/followup";
import { inquirySubject } from "../project/inquiry-send";
import { countWord } from "../project/model";
import { listInboxItems } from "../line";
import { mapTaskPath, nextMapTask } from "../map/next";
import { listKnowItems } from "../know/store";
import { nearToday, wardYear, YearLegend, YearMap } from "../know/year";
import { pendingMaterialGroups } from "../intake/groups";
import { rosterCandidates } from "../intake/store";
import { nearInquiryDates } from "../line/digest";
import { info } from "./info";
import { formatJstDate, shortDate } from "../core/time";
import { people } from "./people";
import { mySignInPath } from "./sign-in";
import { templates } from "./templates";
import { deletion } from "./deletion";
import { listAccounts } from "./accounts";
import { senderNumbers, senderText } from "../line/sender";

// 束 1: 区の設定（席とアカウント、区の情報、定型文）と役員画面の入口。
// 他の束が設定を読む入口は store.ts（getPublicContact、getSquads、getTemplates）と keys.ts。

const admin = new Hono<AdminEnv>();

admin.get("/", async (c) => {
  const { ward, account } = c.var;
  const [projects, lineInbox, pending, inquiries, closed] = await Promise.all([
    listOpenProjects(c.env.DB, ward.wardId), listInboxItems(c.env.DB, ward.wardId),
    c.env.DB.prepare(`SELECT status, COUNT(*) AS count FROM jobs WHERE ward_id = ? AND project_id IS NULL
      AND via = 'admin' AND withdrawn_at IS NULL GROUP BY status`).bind(ward.wardId).all<{ status: string; count: number }>(),
    c.env.DB.prepare("SELECT subject FROM inquiry_records WHERE ward_id = ? AND kind = 'inquiry' AND line_source_type IS NOT NULL")
      .bind(ward.wardId).all<{ subject: string }>(),
    c.env.DB.prepare(`SELECT p.project_id, p.title, p.year, EXISTS (SELECT 1 FROM projects n WHERE n.ward_id = p.ward_id AND n.seed_project_id = p.project_id) AS continued
      FROM projects p WHERE p.ward_id = ? AND p.is_ward_notices = 0 AND p.closed_at IS NOT NULL ORDER BY p.closed_at DESC LIMIT 3`)
      .bind(ward.wardId).all<{ project_id: string; title: string; year: number; continued: number }>(),
  ]);
  const records = closed.results;
  // 開いた人が初めてかは、この端末で最初の画面を開いたかで見る。説明は二回目から畳む。
  const firstVisit = !getCookie(c, "seen_home");
  if (firstVisit) setCookie(c, "seen_home", "1", { path: adminPath(ward, "/"), maxAge: 365 * 86400, httpOnly: true, sameSite: "Lax", secure: true });
  const inquiryCount = inquiries.results.length;
  const inquiryWords = inquiries.results.map((row) => dateWords(row.subject));
  const inquiryWord = inquiryWords.flat()[0];
  const receivedCount = lineInbox.length + inquiryCount;
  const sent = pending.results.reduce((sum, row) => sum + row.count, 0);
  const read = pending.results.filter((row) => row.status === "read").reduce((sum, row) => sum + row.count, 0);
  const reading = pending.results.filter((row) => row.status === "received" || row.status === "reading").reduce((sum, row) => sum + row.count, 0);
  const delayed = pending.results.filter((row) => row.status === "attention").reduce((sum, row) => sum + row.count, 0);
  const failed = pending.results.filter((row) => row.status === "failed").reduce((sum, row) => sum + row.count, 0);
  const states = await Promise.all(projects.map((p) => getProjectState(c.env.DB, ward.wardId, p.projectId)));
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const digest = await getDigestSettings(c.env.DB, ward.wardId);
  const near = nearInquiryDates(projects, today, digest);
  const [materialGroups, rosterAsk] = await Promise.all([pendingMaterialGroups(c.env.DB, ward.wardId), rosterCandidates(c.env.DB, ward.wardId)]);
  // 読み終わって、どの準備の資料かの見当が付いたもの。AI が決められなかった物とは呼ばない。
  const readyTitles = [...new Set(materialGroups.filter((group) => group.title).map((group) => group.joins?.title ?? group.title))];
  // まだ準備を始めていない予定の資料と、進めている準備に足せそうな資料は、することが違うので分けて書く。
  const newTitles = [...new Set(materialGroups.filter((group) => group.title && !group.joins).map((group) => `「${group.title}」`))];
  const joinTitles = [...new Set(materialGroups.filter((group) => group.title && group.joins).map((group) => `「${group.joins!.title}」`))];
  const lastYearDay = new Date(Date.now() + 9 * 3600_000 - 365 * 86400_000).toISOString().slice(0, 10);
  const lastYearSoon = new Date(Date.now() + 9 * 3600_000 - 351 * 86400_000).toISOString().slice(0, 10);
  const lastYearTasks = records.length ? (await c.env.DB.prepare(`SELECT t.task_id, t.name, t.period_start, t.period_end, p.project_id, p.title
    FROM project_map_tasks t JOIN projects p ON p.ward_id = t.ward_id AND p.project_id = t.project_id
    WHERE t.ward_id = ? AND t.removed_at IS NULL AND p.closed_at IS NOT NULL AND t.period_start IS NOT NULL
      AND t.period_start <= ? AND COALESCE(t.period_end, t.period_start) >= ? ORDER BY t.period_start LIMIT 3`)
    .bind(ward.wardId, lastYearSoon, lastYearDay).all<{ task_id: string; name: string; period_start: string; period_end: string | null; project_id: string; title: string }>()).results : [];
  const know = await listKnowItems(c.env.DB, ward.wardId);
  const stale = know.items.filter((item) => item.state === "old");
  const asking = know.items.filter((item) => item.state === "checking");
  // 当日（終わる日）が過ぎた準備は、当日の前の仕事を今の仕事と書かない。二週間以内は、記憶が新しいうちに閉じるので先の準備と同じ並びに置き、
  // 二週間を過ぎて終わりにしていない準備は、ほかに準備が無い時だけ一番上に出し、それ以外は「役員が見ないと進まないこと」に出す。
  const endOf = (project: (typeof projects)[number]) => project.deadlines.event_end ?? project.deadlines.event_day;
  const graceStart = new Date(Date.parse(`${today}T00:00:00Z`) - 14 * 86400_000).toISOString().slice(0, 10);
  const passed = (project: (typeof projects)[number]) => { const end = endOf(project); return Boolean(end && end < today); };
  const longPast = (project: (typeof projects)[number]) => { const end = endOf(project); return Boolean(end && end < graceStart); };
  const lively = projects.some((project) => !longPast(project));
  const candidates = (project: (typeof projects)[number]) => !lively || !longPast(project);
  const nearest = projects.flatMap((project, index) => {
    const task = states[index] && candidates(project) ? nextMapTask(states[index]!.mapTasks, today) : undefined;
    return task ? [{ project, task }] : [];
  }).sort((a, b) => (a.task.periodEnd ?? "9999").localeCompare(b.task.periodEnd ?? "9999"))[0];
  const mine = account.seatId ? projects.flatMap((project, index) => candidates(project) ? (states[index]?.mapTasks ?? []).filter((task) => task.seatId === account.seatId && task.progress !== "done").map((task) => ({ project, task })) : [])
    .sort((a, b) => (a.task.periodEnd ?? "9999").localeCompare(b.task.periodEnd ?? "9999"))[0] : undefined;
  const chosen = mine ?? nearest;
  const leftOpen = projects.filter((project) => longPast(project) && project.projectId !== chosen?.project.projectId);
  const unseeded = records.find((record) => !record.continued);
  const year = await wardYear(c.env.DB, ward, projects, states, today);
  const yearRows = nearToday(year.rows, year.today);
  // 年間の予定などを読んだあとは、仮の一年とは書かない。分かった予定を、今日から近い順に名前で書く。
  const ahead = (row: { from: number }) => (row.from / 100 - year.today + 1) % 1;
  const known = year.rows.filter((row) => row.state !== "example").sort((a, b) => ahead(a) - ahead(b)).map((row) => `「${row.title}」`);
  const yearLead = known.length
    ? `届いた資料から、${known.slice(0, 4).join("、")}${known.length > 4 ? "など" : ""}が、この自治会の予定だと分かりました。ほかの予定は、よくある自治会の例を仮に置いています。`
    : "今は、よくある自治会の一年を仮に置いています。資料が届くと、この自治会の予定に変わります。";
  const yearMap = <><YearLegend /><YearMap rows={yearRows} today={year.today} />{yearRows.length < year.rows.length ? <p class="link-line"><a href={adminPath(ward, "/year")}>一年を全部見る（{year.rows.length}行）</a></p> : null}</>;
  const sheets = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM originals WHERE ward_id = ? AND withdrawn_at IS NULL").bind(ward.wardId).first<{ n: number }>())?.n ?? 0;
  const GOAL = 10;
  // 進めている行事は作った順に新しい物から出す。年の順にすると、来年の行事に今年作った行事が押し出される。
  const order = (await c.env.DB.prepare("SELECT project_id FROM projects WHERE ward_id = ? AND is_ward_notices = 0 AND closed_at IS NULL ORDER BY created_at DESC, project_id LIMIT 5").bind(ward.wardId).all<{ project_id: string }>()).results.map((row) => row.project_id);
  const recent = order.flatMap((id) => projects.filter((project) => project.projectId === id));
  // ここから下は、見出しや札や件数に縮めず、その時の中身を名前と日付の入った文で書く（管理の決定ログ L-300）。
  const openInquiries = (await c.env.DB.prepare(`SELECT inquiry_id, subject, line_sender_label, line_source_type, line_source_id, line_user_id, received_at FROM inquiry_records
    WHERE ward_id = ? AND kind = 'inquiry' AND answer = '' ORDER BY received_at DESC LIMIT 4`).bind(ward.wardId)
    .all<{ inquiry_id: string; subject: string; line_sender_label: string | null; line_source_type: string | null;
      line_source_id: string | null; line_user_id: string | null; received_at: string }>()).results;
  const answerCount = async (projectId: string) => (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM project_answers WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, projectId).first<{ n: number }>())?.n ?? 0;
  const whenText = (project: (typeof projects)[number]) => {
    const day = project.deadlines.event_day;
    if (day && passed(project)) return `${project.title}は${formatJstDate(day)}に行いました（${daysRemaining(endOf(project)!)}）。`;
    return day ? `${project.title}は${formatJstDate(day)}、${daysRemaining(day)}です。` : `${project.title}は、当日がまだ決まっていません。`;
  };
  const tasksOf = (project: (typeof projects)[number]) => states[projects.indexOf(project)]?.mapTasks.filter((task) => task.progress !== "done") ?? [];
  // 「その次」は、今の仕事より後に締めくくる仕事。過ぎた仕事を次とは呼ばない。
  const afterOf = (project: (typeof projects)[number], taskId: string, from: string) => tasksOf(project).filter((task) => task.taskId !== taskId && task.periodEnd && task.periodEnd >= from)
    .sort((a, b) => (a.periodEnd ?? "").localeCompare(b.periodEnd ?? ""))[0];
  const main = chosen ? await (async () => {
    const { project, task } = chosen;
    const answers = task.taskKey === "answers" ? await answerCount(project.projectId) : null;
    const then = afterOf(project, task.taskId, task.periodEnd ?? today);
    // 当日が過ぎた準備は、残った仕事ではなく、報告をまとめて終わりにすることを主にする。
    if (passed(project)) return <section class="next">
      <p class="lead">{whenText(project)}まだ終わりにしていません。{longPast(project) ? "" : "記憶が新しいうちに、"}報告をまとめて終わりにすると、来年の担当の方がこの記録から始められます。</p>
      <a class="button" href={adminPath(ward, `/close/${project.projectId}`)}>{project.title}の報告をまとめて終わりにする</a>
      <p>押すと、報告を書いて終わりにする画面が開きます。</p>
    </section>;
    return <section class="next">
      <p class="lead">{mine ? "あなたの担当の仕事があります。" : ""}{whenText(project)}今は「{task.name}」の時期です。{task.periodEnd ? `${shortDate(task.periodEnd)}までです（${daysRemaining(task.periodEnd)}）。` : "この仕事の時期はまだ決まっていません。"}{answers !== null ? `今、${answers}世帯から返事が届いています。` : ""}</p>
      <a class="button" href={adminPath(ward, mapTaskPath(project.projectId, project.kind, task))}>{task.taskKey === "answers" ? `${project.title}の出欠の返事を見る` : task.name}</a>
      {then ? <p>その次は、{shortDate(then.periodEnd!)}までに「{then.name}」です。</p> : null}
    </section>;
  })() : projects.length ? <section class="next">
      <p class="lead">{whenText(recent[0] ?? projects[0]!)}当日を入れると、準備を始める時期と、いつ何をするかが決まります。</p>
      <a class="button" href={adminPath(ward, `/projects/${(recent[0] ?? projects[0]!).projectId}/map`)}>{(recent[0] ?? projects[0]!).title}のやることを開く</a>
    </section> : unseeded ? <section class="next">
      <p class="lead">去年（{unseeded.year}年）は{unseeded.title}をしました。今年も行うなら、去年のやることをもとに、新しい日に合わせて始められます。</p>
      <a class="button" href={adminPath(ward, `/archive/${unseeded.project_id}?view=seed`)}>今年の{unseeded.title}の準備を始める</a>
      <p><a href={adminPath(ward, `/archive/${unseeded.project_id}`)}>去年の{unseeded.title}のやることと報告を見る</a></p>
    </section> : null;
  const numbers = await senderNumbers(c.env.DB, ward.wardId);
  // 住民向けのページに出す連絡先が無いと、加入していない人は自治会に連絡のしようがない。役員が気づけるようにトップで言う。
  const publicContact = await getPublicContact(c.env.DB, ward.wardId);
  const waiting = [
    ...(publicContact.trim() ? [] : [<li><p>住民向けのページに出す自治会の連絡先が、まだ入っていません。今は「班長か役員にお知らせください」とだけ出ていて、加入していない人や班長を知らない人は、自治会に連絡ができません。</p><a class="quiet" href={adminPath(ward, "/settings/info")}>連絡先を入れる</a></li>]),
    ...openInquiries.slice(0, 3).map((row) => <li><p>{senderText(row.line_sender_label, row.line_source_type,
      numbers.get(row.line_user_id || (row.line_source_type === "user" ? row.line_source_id : "") || ""))}から、{formatJstDate(row.received_at)}に「{inquirySubject(row.subject)}」と届いています。まだ返事をしていません。</p>
      <a class="quiet" href={adminPath(ward, `/inquiries/${encodeURIComponent(row.inquiry_id)}`)}>返事を書く</a></li>),
    ...(openInquiries.length > 3 ? [<li><p>ほかにも、まだ返事をしていない問い合わせがあります。</p><a class="quiet" href={adminPath(ward, "/inquiries")}>問い合わせを全部見る</a></li>] : []),
    ...(near.length ? [<li><p>{near[0]}。{inquiryNotice(digest)}</p><a class="quiet" href={adminPath(ward, "/inquiries")}>問い合わせを見る</a></li>] : []),
    ...leftOpen.slice(0, 3).map((project) => <li><p>{whenText(project)}まだ終わりにしていません。</p><a class="quiet" href={adminPath(ward, `/close/${project.projectId}`)}>{project.title}の報告をまとめて終わりにする</a></li>),
    ...(newTitles.length && (projects.length || records.length) ? [<li><p>{newTitles.join("、")}の資料を、AIが読み終わりました。まだ準備を始めていません。準備を始めると、その資料から、いつ何をするかと案内の下書きを用意します。</p><a class="quiet" href={adminPath(ward, "/intake/read")}>読み終わった資料を見て、準備を始める</a></li>] : []),
    ...(joinTitles.length ? [<li><p>{joinTitles.join("、")}の準備に入れられそうな資料が、新しく届いています。入れるかを決めると、やることと下書きに使えます。</p><a class="quiet" href={adminPath(ward, "/intake/read")}>読み終わった資料を見て決める</a></li>] : []),
    ...(rosterAsk.length ? [<li><p>世帯の名簿のような資料が届いています。名簿に入れ直すかを決めてください。</p><a class="quiet" href={adminPath(ward, "/inbox")}>届いたものを見て決める</a></li>] : []),
    ...asking.slice(0, 1).map((item) => <li><p>自治会の基本情報の「{item.title}」について、届いた資料に違うことが書かれていました。どちらが今の内容か教えてください。</p><a class="quiet" href={adminPath(ward, `/know/${item.id}`)}>見て答える</a></li>),
    ...stale.slice(0, 1).map((item) => <li><p>自治会の基本情報の「{item.title}」は、入れてから時間がたっています。今も合っているか見てください。</p><a class="quiet" href={adminPath(ward, `/know/${item.id}`)}>見て直す</a></li>),
  ];
  // 二週間を過ぎて終わりにしていない準備は「役員が見ないと進まないこと」に出すので、ここには並べない。
  const others = recent.filter((project) => project.projectId !== chosen?.project.projectId && !leftOpen.includes(project)).slice(0, 4);
  // 一年を全部見る道は、ほかに並べる準備が無い時も、準備が多ければ出す。
  const othersBlock = others.length || projects.length > 1 ? <>{others.length ? <><h2>ほかに準備中のもの</h2><ul class="rows">{others.map((project) => { const task = nextMapTask(tasksOf(project), today); return <li><a class="row-link" href={adminPath(ward, `/projects/${project.projectId}/map`)}><b>{project.title}</b>
      <span>{whenText(project)}{task ? `次は「${task.name}」です${task.periodEnd ? `（${shortDate(task.periodEnd)}まで）` : ""}。` : ""}</span></a></li>; })}</ul></> : null}
    {projects.length > others.length + 1 ? <p class="link-line"><a href={adminPath(ward, "/year")}>この自治会の一年を全部見る</a></p> : null}</> : null;
  const lastYearTitles = [...new Set(lastYearTasks.map((task) => task.title))];
  const lastYear = lastYearTasks.length ? <p>去年の今ごろは、{lastYearTitles.map((title) => `${title}の${lastYearTasks.filter((task) => task.title === title).map((task) => `「${task.name}」`).join("と")}`).join("、")}をしていました。<a href={adminPath(ward, `/archive/${lastYearTasks[0]!.project_id}`)}>去年の{lastYearTasks[0]!.title}を見る</a></p> : null;
  const links = <><h2>ほかにすること</h2><ul class="links">
    <li><a href={adminPath(ward, "/intake")}>写真やファイルを送る</a></li>
    <li><a href={adminPath(ward, "/projects")}>新しく準備を始める</a></li>
    {projects.length ? <li><a href={adminPath(ward, "/projects/today")}>締切の近い仕事を全部見る</a></li> : null}
    {projects.length ? <li><a href={adminPath(ward, "/answers")}>出欠の返事を見る</a></li> : null}
    <li><a href={adminPath(ward, "/inquiries")}>問い合わせに返事をする</a></li>
    <li><a href={adminPath(ward, "/year")}>この自治会の一年を見る</a></li>
    <li><a href={adminPath(ward, "/know")}>自治会の基本情報を見る</a></li>
    <li><a href={adminPath(ward, "/files")}>届いた写真やファイルを全部見る</a></li>
    <li><a href={adminPath(ward, "/archive")}>終わったものを見る</a></li>
    <li><a href={adminPath(ward, "/answers/roster")}>世帯の名簿を入れる</a></li>
    <li><a href={adminPath(ward, "/requests/city")}>市からの依頼を見る</a></li>
    <li><a href={adminPath(ward, "/settings")}>自治会の設定を直す</a></li>
    <li><a href={`/${ward.slug}/`}>住民向けのページを見る</a></li>
  </ul><form method="post" action={adminPath(ward, "/logout")}><button class="quiet">ログアウトする</button></form></>;
  const intro = firstVisit ? <p class="lead">この画面で、{ward.name}の自治会の行事や総会の準備を、役員みんなで進めます。手元の資料を送ると、AIが読んで、いつ何をするかと、住民に知らせる案内の下書きを用意します。</p> : null;
  const readingLine = reading || delayed ? <p class="muted">{reading ? `送った資料のうち${reading}件を、今AIが読んでいます。` : ""}{delayed ? `${delayed}件は読み取りが遅れています。送り直さなくてかまいません。` : ""}</p> : null;
  return c.html(<AdminPage ward={ward} account={account} title="最初の画面" home>
    {!projects.length && !records.length ? <>
      <h1>{ward.name}の自治会</h1>
      <p class="lead">この画面で、この自治会の行事や総会の準備を、役員みんなで進めます。</p>
      {/* 読み終わって準備の見当が付いた資料があれば、そこから準備を始めることを主な操作にする。 */}
      {readyTitles.length ? <><section class="next">
        <p class="lead">送った資料のうち、{readyTitles.map((title) => `「${title}」`).join("、")}の資料のようなものを、AIが読み終わりました。準備を始めると、その資料から、いつ何をするかと案内の下書きを用意します。</p>
        <a class="button" href={adminPath(ward, "/intake/read")}>読み終わった資料を見て、準備を始める</a>
        <p>押すと、読み終わった資料が、準備ごとにまとまった画面が開きます。</p>
      </section>
      <p>資料は今{sheets}件届いています。ほかにもあれば、続けて送れます。<a href={adminPath(ward, "/intake")}>写真やファイルを送る</a></p></> : <section class="next">
        <p class="lead">{sheets >= GOAL ? `資料が${sheets}件届きました。下の一年の表が、少しずつこの自治会の予定に変わっていきます。` : `まず、手元にある自治会の資料を送ってください。紙は撮って、WordやPDFはそのまま送れます。十件ほど届くと、この自治会の一年が見えてきます。今は${sheets}件です。`}</p>
        <div class="start-bar" aria-hidden="true">{Array.from({ length: GOAL }, (_, index) => <i class={index < sheets ? "in" : undefined} />)}</div>
        <a class="button" href={adminPath(ward, "/intake")}>写真やファイルを送る</a>
        <p>自治会のLINEに写真を送っても届きます。分けたり、名前を付けたりしなくてかまいません。</p>
      </section>}
      {readingLine}
      {read && !readyTitles.length ? <p class="link-line"><a href={adminPath(ward, "/intake/read")}>AIが読み終わった資料を見て、準備を始める</a></p> : null}
      <h2>送るとよい資料</h2><p>あるものだけでかまいません。上のものほど役に立ちます。</p>
      <ul><li>規約や会則</li><li>去年の総会の資料</li><li>年間の予定が分かるもの</li><li>世帯の名簿（班が分かるもの）</li><li>役員の一覧</li><li>去年の案内や回覧（二、三枚）</li><li>当番表や配置図</li><li>市から来た依頼</li><li>会費や会計の報告</li></ul>
      <details class="hint"><summary>手元に資料がないとき</summary><div><p>前の役員の家や、公民館の棚にあることが多いです。見つからないときは、名前を入れると、よくあるやることの一覧から始められます。</p><p><a class="quiet" href={adminPath(ward, "/projects")}>資料なしで準備を始める</a></p></div></details>
      {waiting.length ? <><h2>役員が見ないと進まないこと</h2><ul class="rows">{waiting}</ul></> : null}
      <h2>{ward.name}の一年</h2>
      <p>{yearLead}</p>
      {yearMap}
      {links}
    </> : <>
      <h1>{ward.name}の自治会の今</h1>
      {intro}
      {main}
      {projects.length ? <div class="action-links"><a class="button secondary" href={adminPath(ward, "/messages/new")}>住民へのメッセージを作る</a></div> : null}
      {readingLine}
      {waiting.length ? <><h2>役員が見ないと進まないこと</h2><ul class="rows">{waiting}</ul></> : null}
      {othersBlock}
      {lastYear}
      <h2>{ward.name}の一年</h2>
      {yearMap}
      {links}
    </>}
  </AdminPage>);
});

admin.get("/settings", async (c) => {
  const { ward, account } = c.var;
  const [accounts, contact] = await Promise.all([listAccounts(c.env.DB, ward.wardId), getPublicContact(c.env.DB, ward.wardId)]);
  // 要約の付いたリンクの一覧にせず、今どうなっているかを文で書き、することの言葉だけのリンクを下に置く（トップと同じ決まり）。
  const alone = accounts.every((a) => a.accountId === account.accountId);
  const names = accounts.map((a) => `${a.name}さん${a.accountId === account.accountId ? "（あなた）" : ""}`);
  const contactLine = contact.split("\n").map((line) => line.trim()).filter(Boolean).join("　").slice(0, 80);
  return c.html(
    <AdminPage ward={ward} account={account} title="自治会の設定" back={{ href: adminPath(ward, "/"), label: "最初の画面へ" }}>
      <h1>自治会の設定</h1>
      {alone ? <section class="next"><p>この画面を使えるのは、今は{account.name}さん（あなた）だけです。ほかの役員にも使ってもらうと、それぞれの手元の資料を送ってもらえます。</p>
        <a class="button" href={adminPath(ward, "/settings/people#add")}>ほかの役員を足す</a>
        <p>押すと、名前を入れる欄に移ります。足すと、その人に渡すログインのリンクが出ます。</p></section>
        : <p class="lead">この画面を使えるのは、{names.join("、")}の{accounts.length}人です。</p>}
      {contact ? <p>住民向けのページには、自治会の連絡先として「{contactLine}」が出ています。</p>
        : <p>住民向けのページに出す自治会の連絡先が、まだ入っていません。今は住民向けのページに「班長か役員へお知らせください」とだけ出ていて、班長や役員を知らない方は連絡できません。<a href={adminPath(ward, "/settings/info")}>連絡先を入れる</a></p>}
      <ul class="links">
        <li><a href={adminPath(ward, "/settings/people")}>ほかの役員を足す、外す</a></li>
        <li><a href={adminPath(ward, "/settings/people")}>ログインできない役員にリンクを出す</a></li>
        <li><a href={mySignInPath(ward)}>自分のログインの方法を見る</a></li>
        <li><a href={adminPath(ward, "/settings/info")}>連絡先と班の名前を直す</a></li>
        <li><a href={adminPath(ward, "/close/activity")}>住民向けのページに自治会の説明を書く</a></li>
        <li><a href={adminPath(ward, "/settings/templates")}>雨の変更の連絡の文を直す</a></li>
        <li><a href={adminPath(ward, "/settings/deletion")}>住民から頼まれたものを消す</a></li>
        <li><a href="/contact">SasaeAIに問い合わせる</a></li>
        <li><form method="post" action={adminPath(ward, "/logout")}><button class="quiet">ログアウトする</button></form></li>
      </ul>
    </AdminPage>,
  );
});

admin.route("/settings/people", people);
admin.route("/settings/info", info);
admin.route("/settings/deletion", deletion);
admin.route("/settings/templates", templates);

// この端末の記憶を消してログアウトする。ほかの端末には影響しない。
admin.post("/logout", async (c) => {
  const ward = c.var.ward;
  await c.env.DB.prepare("DELETE FROM devices WHERE ward_id = ? AND device_id = ?")
    .bind(ward.wardId, c.var.deviceId)
    .run();
  clearDeviceCookie(c, ward);
  return c.redirect(adminPath(ward, "/login"), 303);
});

export const settings: Bundle = { admin };
