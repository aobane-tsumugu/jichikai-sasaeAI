import { getDigestSettings, inquiryNotice } from "./digest";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { AdminPage } from "../core/admin-ui";
import { Hint } from "../core/ui";
import { adminPath, clearDeviceCookie } from "../core/auth";
import type { Bundle } from "../core/bundle";
import type { AdminEnv } from "../env";
import { getProjectState, listOpenProjects } from "../project/api";
import { dateWords, daysRemaining } from "../project/followup";
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
      FROM projects p WHERE p.ward_id = ? AND p.closed_at IS NOT NULL ORDER BY p.closed_at DESC LIMIT 3`)
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
  const undecided = materialGroups.filter((group) => group.title).length + rosterAsk.length;
  const photos = lineInbox.filter((item) => item.original_kind === "image" && item.job_id).slice(0, 3);
  const received = receivedCount ? <><h2>届いたもの</h2>
    {photos.length ? <div class="photo-strip">{photos.map((item) => <a href={adminPath(ward, `/inbox/${item.item_id}/pick`)}><img class="photo" src={adminPath(ward, `/inbox/${item.item_id}/original`)} alt="届いた写真" loading="lazy" /></a>)}</div> : null}
    <p>{lineInbox.length ? `公式LINEに${lineInbox.length}件届いています。` : ""}{undecided ? `${undecided}件に質問があります。` : ""}{inquiryCount ? `問い合わせが${countWord(inquiryCount)}あります。${inquiryWord ? `${countWord(inquiryWords.filter((words) => words.includes(inquiryWord)).length)}に「${inquiryWord}」と書かれています。` : ""}` : ""}</p>
    {undecided && projects.length ? null : <div class="action-links"><a class="button secondary" href={adminPath(ward, "/inbox")}>届いたものを見る</a></div>}</> : null;
  const explain = "SasaeAIは、自治会の役員の仕事を支えるサービスです。手元の資料を撮って送るか、ファイルのまま送ると、AIが読んで、段取りと案内の下書きを用意します。案内を配り、答えを集め、記録を残すまで、ここで進められます。役員だけが見られる画面です。";
  const about = firstVisit ? <><h1>{ward.name}の自治会の仕事を進める画面です</h1><p class="lead">{explain}</p></> : null;
  const aboutFold = firstVisit ? null : <details class="hint"><summary>この画面について</summary><div><p>{explain}</p></div></details>;
  const heading = (text: string) => firstVisit ? <h2>{text}</h2> : <h1>{text}</h1>;
  const lastYearDay = new Date(Date.now() + 9 * 3600_000 - 365 * 86400_000).toISOString().slice(0, 10);
  const lastYearSoon = new Date(Date.now() + 9 * 3600_000 - 351 * 86400_000).toISOString().slice(0, 10);
  const lastYearTasks = records.length ? (await c.env.DB.prepare(`SELECT t.task_id, t.name, t.period_start, t.period_end, p.project_id, p.title
    FROM project_map_tasks t JOIN projects p ON p.ward_id = t.ward_id AND p.project_id = t.project_id
    WHERE t.ward_id = ? AND t.removed_at IS NULL AND p.closed_at IS NOT NULL AND t.period_start IS NOT NULL
      AND t.period_start <= ? AND COALESCE(t.period_end, t.period_start) >= ? ORDER BY t.period_start LIMIT 3`)
    .bind(ward.wardId, lastYearSoon, lastYearDay).all<{ task_id: string; name: string; period_start: string; period_end: string | null; project_id: string; title: string }>()).results : [];
  const memory = records.length ? <>
    {lastYearTasks.length ? <><h2>去年の今ごろ</h2><ul class="rows">{lastYearTasks.map((task) => <li><a class="row-link" href={adminPath(ward, `/archive/${task.project_id}`)}><b>{task.title}　{task.name}</b><span>{shortDate(task.period_start)}{task.period_end ? `から${shortDate(task.period_end)}まで` : ""}</span></a></li>)}</ul></> : null}
    <h2>記録</h2><p class="muted">閉じた行事の段取り、配ったもの、報告です。次の役員もここを読みます。</p>
    <ul class="rows">{records.map((record) => <li><a class="row-link" href={adminPath(ward, `/archive/${record.project_id}`)}><b>{record.year}年 {record.title}</b><span>押すと、記録を読めます</span></a>
      {record.continued ? null : <p class="link-line"><a href={`${adminPath(ward, `/archive/${record.project_id}`)}?view=seed`}>これをもとに今年を始める</a></p>}</li>)}</ul></> : null;
  const know = await listKnowItems(c.env.DB, ward.wardId);
  const stale = know.items.filter((item) => item.state === "old");
  const asking = know.items.filter((item) => item.state === "checking");
  const knowRow = stale.length || asking.length ? <ul class="year-list"><li><a class={`year-row ${asking.length ? "checking" : "old"}`} href={adminPath(ward, "/know")}><b>役員が知っておくこと: {asking.length ? `質問が${asking.length}項目あります。` : ""}{stale.length ? `見直す時期が${stale.length}項目あります。` : ""}</b><span class="note">{[...asking, ...stale].slice(0, 3).map((item) => item.title).join("、")}</span></a></li></ul> : null;
  const place = (path: string, name: string, note: string) => <li><a class="row-link" href={adminPath(ward, path)}><b>{name}</b><span>{note}</span></a></li>;
  const places = <><h2>ほかにできること</h2><ul class="rows two">
    {projects.length ? <>{place("/projects/today", "今やること", "締切のある仕事を近い順に見ます")}{place("/answers", "答えを見る", "住民から届いた出欠と手伝いを見ます")}</> : null}
    {place("/year", "この区の一年", "一年の行を足す、外す")}
    {place("/know", "役員が知っておくこと", "自治会を動かすのに知っておきたいことを見ます")}
    {place("/files", "区の資料", "届いた写真やファイルを全部見ます")}
    {place("/archive", "記録を読む", "閉じた行事の段取り、配ったもの、報告を読みます")}
    {projects.length ? place("/answers/roster", "名簿", "代表者の名前と班を入れます") : null}
    {projects.length ? <>{place("/requests/city", "行政の依頼", "市から届いた依頼と締切を見ます")}{place("/inquiries", "問い合わせと要望", "住民からの問い合わせに返事をします")}</> : null}
    {place("/settings", "区の設定", "役員、連絡先、知らせの文を直します")}
    <li><a class="row-link" href={`/${ward.slug}/`}><b>区のページ</b><span>住民が読むページを見ます</span></a></li>
  </ul><form method="post" action={adminPath(ward, "/logout")}><button class="quiet">このスマホやパソコンから出る</button></form></>;
  const nearest = projects.flatMap((project, index) => {
    const task = states[index] ? nextMapTask(states[index]!.mapTasks, today) : undefined;
    return task ? [{ project, task }] : [];
  }).sort((a, b) => (a.task.periodEnd ?? "9999").localeCompare(b.task.periodEnd ?? "9999"))[0];
  const mine = account.seatId ? projects.flatMap((project, index) => (states[index]?.mapTasks ?? []).filter((task) => task.seatId === account.seatId && task.progress !== "done").map((task) => ({ project, task })))
    .sort((a, b) => (a.task.periodEnd ?? "9999").localeCompare(b.task.periodEnd ?? "9999"))[0] : undefined;
  const chosen = mine ?? nearest;
  const unseeded = records.find((record) => !record.continued);
  const next = undecided ? { title: `届いた写真やファイルのうち、${undecided}件に質問があります`, body: "答えると、行事や名簿に入ります。答えなくても、「区の資料」に残ります。", href: "/inbox", label: "質問を見る" }
    : chosen ? { title: `${chosen.project.title}　${chosen.task.name}`, body: `${mine ? "あなたの担当の仕事です。" : ""}${chosen.task.periodEnd ? `${shortDate(chosen.task.periodEnd)}まで。${daysRemaining(chosen.task.periodEnd)}。` : ""}押すと、この仕事の画面が開きます。`, href: mapTaskPath(chosen.project.projectId, chosen.project.kind, chosen.task), label: "この仕事を開く" }
    : unseeded ? { title: `${unseeded.year}年の${unseeded.title}をもとに今年を始める`, body: "去年の段取りを、新しい日に合わせて置き直します。全部を見直す必要はありません。", href: `/archive/${unseeded.project_id}?view=seed`, label: "今年を始める" }
    : { title: "写真やファイルを送る", body: "紙の案内は撮って、WordやPDFはそのまま送れます。AIが読んで、行事に入れます。", href: "/intake", label: "写真やファイルを送る" };
  const year = await wardYear(c.env.DB, ward, projects, states, today);
  const yearRows = nearToday(year.rows, year.today);
  const yearMap = <><YearLegend /><YearMap rows={yearRows} today={year.today} />{yearRows.length < year.rows.length ? <p class="link-line"><a href={adminPath(ward, "/year")}>一年を全部見る（{year.rows.length}行）</a></p> : null}</>;
  const sheets = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM originals WHERE ward_id = ? AND withdrawn_at IS NULL").bind(ward.wardId).first<{ n: number }>())?.n ?? 0;
  const GOAL = 10;
  const questionCard = undecided ? <section class="next"><strong>{next.title}</strong><p>{next.body}</p><a class="button" href={adminPath(ward, next.href)}>{next.label}</a></section> : null;
  const running = projects.flatMap((project, index) => (states[index]?.mapTasks ?? [])
    .filter((task) => task.progress !== "done" && (task.periodStart || task.periodEnd) && (!task.periodStart || task.periodStart <= today) && (!task.periodEnd || task.periodEnd >= today))
    .map((task) => ({ project, task })))
    .sort((a, b) => Number(b.task.seatId === account.seatId && Boolean(account.seatId)) - Number(a.task.seatId === account.seatId && Boolean(account.seatId)) || (a.task.periodEnd ?? "9999").localeCompare(b.task.periodEnd ?? "9999")).slice(0, 5);
  const nowRows = running.length ? running : chosen ? [chosen] : [];
  // 進めている行事は作った順に新しい物から出す。年の順にすると、来年の行事に今年作った行事が押し出される。
  const order = (await c.env.DB.prepare("SELECT project_id FROM projects WHERE ward_id = ? AND closed_at IS NULL ORDER BY created_at DESC, project_id LIMIT 5").bind(ward.wardId).all<{ project_id: string }>()).results.map((row) => row.project_id);
  const recent = order.flatMap((id) => projects.filter((project) => project.projectId === id));
  return c.html(<AdminPage ward={ward} account={account} title="最初の画面" home>
    {!projects.length && !records.length ? <>
      {about}{questionCard}
      <section class="next"><strong>{sheets >= GOAL ? "十件届きました" : "まず、手元の資料を十件送ってください"}</strong>
        <p class="start-count">{sheets ? `${sheets}件届きました。${sheets < GOAL ? `あと${GOAL - sheets}件です。` : ""}` : "紙は撮って、WordやPDFはそのまま送れます。"}</p>
        <div class="start-bar" aria-hidden="true">{Array.from({ length: GOAL }, (_, index) => <i class={index < sheets ? "in" : undefined} />)}</div>
        <a class="button" href={adminPath(ward, "/intake")}>写真やファイルを送る</a>
        <p style="margin: .5rem 0 0">公式LINEに写真を送っても入ります。分けたり名前を付けたりしなくてかまいません。</p></section>
      {read ? <p class="link-line"><a href={adminPath(ward, "/intake/read")}>読み終わった資料を見て、行事を始める</a></p> : null}
      {reading || delayed ? <p class="muted">{reading ? `${reading}件を読んでいます。` : ""}{delayed ? `${delayed}件は読み取りが遅れています。送り直す必要はありません。` : ""}</p> : null}
      <h2>この区の一年</h2><p class="muted">今は一般の自治会の例を仮に置いています。行事が入ると、この区の内容に変わります。</p>
      {yearMap}
      <h2>どんな資料がよいか</h2><p class="muted">あるものだけでかまいません。上のものほど役立ちます。</p>
      <ul><li>規約や会則</li><li>去年の総会の資料</li><li>年間の予定が分かるもの</li><li>世帯の名簿（班が分かるもの）</li><li>役員の一覧</li><li>去年の案内や回覧（二、三枚）</li><li>当番表や配置図</li><li>市から来た依頼</li><li>会費や会計の報告</li></ul>
      <details class="hint"><summary>手元に資料がないとき</summary><div><p>前の役員や、公民館の棚にあることが多いです。見つからないときは、何の準備かを選ぶと、ふつうの段取りから始められます。</p><p><a class="quiet" href={adminPath(ward, "/projects")}>資料がないので、何の準備かを選ぶ</a></p></div></details>
      {received}{places}{aboutFold}
    </> : <>
      {about}{questionCard}
      {near.length ? <div class="notice"><strong>{near[0]}</strong><p>{inquiryNotice(digest)}</p><a class="quiet" href={adminPath(ward, "/inquiries")}>問い合わせを見る</a></div> : null}
      {heading(`${ward.name}の一年`)}
      {yearMap}
      {nowRows.length ? <><h2>今の時期の仕事</h2><ul class="year-list">{nowRows.map(({ project, task }) => <li><a class="year-row fact" href={adminPath(ward, mapTaskPath(project.projectId, project.kind, task))}><b>{project.title}　{task.name}</b><span class="note">{task.seatId && task.seatId === account.seatId ? "あなたの担当です。" : ""}{task.periodEnd ? `${shortDate(task.periodEnd)}まで。${daysRemaining(task.periodEnd)}` : ""}</span></a></li>)}</ul></> : !undecided ? <section class="next"><strong>{next.title}</strong><p>{next.body}</p><a class="button" href={adminPath(ward, next.href)}>{next.label}</a></section> : null}
      {knowRow}
      <h2>進めている行事</h2>
      <ul class="year-list">{recent.map((project) => { const index = projects.indexOf(project); const task = states[index] ? nextMapTask(states[index]!.mapTasks, today) : undefined; return <li><a class="year-row fact" href={adminPath(ward, `/projects/${project.projectId}/map`)}><b>{project.title}</b><span class="note">{task ? `次は ${task.name}` : "段取りを開く"}</span></a></li>; })}</ul>
      {projects.length > 5 ? <p class="link-line"><a href={adminPath(ward, "/year")}>ほかの行事（{projects.length - 5}件）は一年の画面で見る</a></p> : null}
      {memory}
      {received}
      <div class="action-links"><a class="button secondary" href={adminPath(ward, "/intake")}>写真やファイルを送る</a><a class="button secondary" href={adminPath(ward, "/projects")}>新しい行事を始める</a></div>
      {sent ? <p class="link-line"><a href={adminPath(ward, "/intake/read")}>送った資料{sent}件を見る</a></p> : null}
      {places}{aboutFold}
    </>}
  </AdminPage>);
});

admin.get("/settings", (c) => {
  const { ward, account } = c.var;
  return c.html(
    <AdminPage ward={ward} account={account} title="区の設定" back={{ href: adminPath(ward, "/"), label: "最初の画面へ" }}>
      <h1>区の設定</h1><p class="lead">直したいものを選んでください。ふだんは直さなくてかまいません。</p>
      <ul class="rows">
        <li><a class="row-link" href={adminPath(ward, "/settings/people")}><b>役員の一覧</b><span>役員を足す、外す。入るためのリンクを出す。なくしたスマホやパソコンで入れないようにする。</span></a></li>
        <li><a class="row-link" href={mySignInPath(ward)}><b>自分の入り方</b><span>LINEやメールをつなぎます。</span></a></li>
        <li><a class="row-link" href={adminPath(ward, "/settings/info")}><b>区の情報</b><span>連絡先、班の名前、知らせの時刻。</span></a></li>
        <li><a class="row-link" href={adminPath(ward, "/close/activity")}><b>区の説明</b><span>役員の仕事、加入すると担うことや得られることを、書けるところから区のページに載せます。</span></a></li>
        <li><a class="row-link" href={adminPath(ward, "/settings/templates")}><b>決まった知らせの文</b><span>雨の変更の知らせなど、くり返し出す文です。</span></a></li>
        <li><a class="row-link" href={adminPath(ward, "/settings/deletion")}><b>消す希望</b><span>住民から消してほしいと頼まれたものを消します。</span></a></li>
      </ul>
      <ul class="links">
        <li><a href="/contact">SasaeAIに問い合わせる</a></li>
        <li><form method="post" action={adminPath(ward, "/logout")}><button class="quiet">このスマホやパソコンから出る</button></form></li>
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
