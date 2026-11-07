import { getDigestSettings, inquiryNotice } from "./digest";
import { Hono } from "hono";
import { AdminPage } from "../core/admin-ui";
import { Hint } from "../core/ui";
import { adminPath, clearDeviceCookie } from "../core/auth";
import type { Bundle } from "../core/bundle";
import type { AdminEnv } from "../env";
import { getProjectState, listOpenProjects } from "../project/api";
import { dateWords, daysRemaining } from "../project/followup";
import { countWord } from "../project/model";
import { inboxDecided, listInboxItems } from "../line";
import { mapTaskPath, nextMapTask } from "../map/next";
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
    c.env.DB.prepare("SELECT project_id FROM projects WHERE ward_id = ? AND closed_at IS NOT NULL LIMIT 1")
      .bind(ward.wardId).first<{ project_id: string }>(),
  ]);
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
  const undecided = lineInbox.filter((item) => !inboxDecided(item)).length;
  const photos = lineInbox.filter((item) => item.original_kind === "image" && item.job_id).slice(0, 3);
  const received = receivedCount ? <><h2>届いたもの</h2>
    {photos.length ? <div class="photo-strip">{photos.map((item) => <a href={adminPath(ward, `/inbox/${item.item_id}/pick`)}><img class="photo" src={adminPath(ward, `/inbox/${item.item_id}/original`)} alt="届いた写真" loading="lazy" /></a>)}</div> : null}
    <p>{lineInbox.length ? `公式LINEに${lineInbox.length}件届いています。` : ""}{undecided ? `${undecided}件は、どの行事か確かめてください。` : lineInbox.length ? "AIが行事に入れました。" : ""}{inquiryCount ? `問い合わせが${countWord(inquiryCount)}あります。${inquiryWord ? `${countWord(inquiryWords.filter((words) => words.includes(inquiryWord)).length)}に「${inquiryWord}」と書かれています。` : ""}` : ""}</p>
    {undecided && projects.length ? null : <div class="action-links"><a class="button secondary" href={adminPath(ward, "/inbox")}>届いたものを見る</a></div>}</> : null;
  const about = <><h1>{ward.name}の自治会の仕事を進める画面です</h1>
    <p class="lead">SasaeAIは、自治会の役員の仕事を支えるサービスです。手元の紙や写真を送ると、AIが読んで、段取りと案内の下書きを用意します。案内を配り、答えを集め、記録を残すまで、ここで進められます。役員だけが見られる画面です。</p></>;
  const place = (path: string, name: string, note: string) => <li><a class="row-link" href={adminPath(ward, path)}><b>{name}</b><span>{note}</span></a></li>;
  const places = <><h2>ほかにできること</h2><ul class="rows two">
    {projects.length ? <>{place("/projects/today", "今やること", "締切のある仕事を近い順に見ます")}{place("/answers", "答えを見る", "住民から届いた出欠と手伝いを見ます")}</> : null}
    {place("/archive", "記録を読む", "閉じた行事の段取り、配ったもの、報告を読みます")}
    {projects.length ? <>{place("/archive/map", "一年の予定", "区の仕事を月ごとに見ます")}{place("/answers/roster", "名簿", "代表者の名前と班を入れます")}</> : null}
    {projects.length ? <>{place("/requests/city", "行政の依頼", "市から届いた依頼と締切を見ます")}{place("/inquiries", "問い合わせと要望", "住民からの問い合わせに返事をします")}</> : null}
    {place("/settings", "区の設定", "役員、連絡先、知らせの文を直します")}
    <li><a class="row-link" href={`/${ward.slug}/`}><b>区のページ</b><span>住民が読むページを見ます</span></a></li>
  </ul><form method="post" action={adminPath(ward, "/logout")}><button class="quiet">このスマホやパソコンから出る</button></form></>;
  const nearest = projects.flatMap((project, index) => {
    const task = states[index] ? nextMapTask(states[index]!.mapTasks, today) : undefined;
    return task ? [{ project, task }] : [];
  }).sort((a, b) => (a.task.periodEnd ?? "9999").localeCompare(b.task.periodEnd ?? "9999"))[0];
  const next = undecided ? { title: `届いたもの${undecided}件の行事を決める`, body: "どの行事のものか、AIが決められなかったものです。中身を見て、入れる行事を選べます。", href: "/inbox", label: "届いたものを見る" }
    : nearest ? { title: `${nearest.project.title}　${nearest.task.name}`, body: `${nearest.task.periodEnd ? `${shortDate(nearest.task.periodEnd)}まで。${daysRemaining(nearest.task.periodEnd)}。` : ""}押すと、この仕事の画面が開きます。`, href: mapTaskPath(nearest.project.projectId, nearest.project.kind, nearest.task), label: "この仕事を開く" }
    : { title: "手元の紙や資料を送る", body: "案内の紙も、Wordも、写真も、そのまま送れます。AIが読んで、行事に入れます。", href: "/intake", label: "紙や資料を送る" };
  return c.html(<AdminPage ward={ward} account={account} title="最初の画面" home>
    {projects.length === 0 ? sent === 0 ? closed ? <>
      {about}<h2>去年の記録から始められます</h2>
      <p>残っている段取りや報告を読んで、今年の準備を始められます。</p>
      <div class="action-links"><a class="button" href={adminPath(ward, "/archive")}>記録を読む</a></div>
      <div class="action-links"><a class="button secondary" href={adminPath(ward, "/intake")}>手元の紙や資料を送る</a><a class="button secondary" href={adminPath(ward, "/projects")}>新しく始める</a></div>
      {received}{places}
    </> : <>
      {about}<h2>まず、去年の資料を送ってください</h2>
      <p>案内の紙でも、Wordでも、写真でも、そのまま送れます。整理はいりません。</p>
      <div class="action-links"><a class="button" href={adminPath(ward, "/intake")}>去年の資料を送る</a></div>
      <h2>送ると、こうなります</h2><ul>
        <li>AIが読んで、日時、場所、協賛先などを取り出します。</li><li>資料から、今年の段取りができます。</li><li>案内の下書きができます。直して配るのは役員です。</li>
      </ul>
      <details class="hint"><summary>資料がどこにあるか分からないとき</summary><div><p>見つかったものから一枚だけでも送れます。何もないときは、下のボタンから始められます。</p></div></details>
      <div class="action-links"><a class="button secondary" href={adminPath(ward, "/projects")}>資料がないので、種類を選んで始める</a></div>
      {received}
    </> : <>
      {about}<h2>送った資料</h2><p>{sent}回分を預かっています。読み終わった分から、段取りを作れます。</p>
      <p class="muted">{read ? `読み終わりました${read}件。` : ""}{reading ? `読んでいます${reading}件。` : ""}{delayed ? `読み取りが遅れています${delayed}件。送り直す必要はありません。` : ""}{failed ? `読めませんでした${failed}件。もう一度読むか、このまま進められます。` : ""}</p>
      <section class="next"><strong>次は</strong><p>読み終わったものを見てください。</p><a class="button" href={adminPath(ward, "/intake/read")}>読み終わったものを見る</a></section>
      <div class="action-links"><a class="button secondary" href={adminPath(ward, "/intake")}>続けて送る</a><a class="button secondary" href={adminPath(ward, "/projects")}>資料がないので、種類を選んで始める</a></div>
      <p class="link-line"><a href={adminPath(ward, "/intake/received")}>送ったものを見る</a></p>{received}{places}
    </> : <>
      {about}<h2>次にすること</h2>
      <section class="next"><strong>{next.title}</strong><p>{next.body}</p><a class="button" href={adminPath(ward, next.href)}>{next.label}</a></section>
      {near.length ? <div class="notice"><strong>{near[0]}</strong><p>{inquiryNotice(digest)}</p><a class="quiet" href={adminPath(ward, "/inquiries")}>問い合わせを見る</a></div> : null}
      {received}
      <h2>進めている行事</h2><p class="muted">押すと、その行事の段取りが開きます。</p>
      <ul class="rows two">{projects.map((p, index) => {
        const state = states[index];
        const task = state ? nextMapTask(state.mapTasks, today) : undefined;
        const due = p.deadlines.event_day ?? p.deadlines.submit_due;
        const days = due ? Math.ceil((Date.parse(due) - Date.parse(today)) / 86400_000) : null;
        return <li><a class="row-link" href={adminPath(ward, `/projects/${p.projectId}/map`)}><b>{p.title}</b>
          {due ? <span>{formatJstDate(due)}{p.deadlines.submit_due && !p.deadlines.event_day ? "までに提出" : days !== null && days >= 0 ? `まで、あと${days}日` : ""}</span> : null}
          <span>{task ? `次は ${task.name}` : state?.mapTasks.length ? "段取りの仕事は全部済みました" : "仕事はまだありません。段取りから足せます"}</span>
        </a></li>;
      })}</ul>
      <div class="action-links"><a class="button secondary" href={adminPath(ward, "/intake")}>手元の紙や資料を送る</a><a class="button secondary" href={adminPath(ward, "/projects")}>新しい行事を始める</a></div>
      {sent ? <p class="link-line"><a href={adminPath(ward, "/intake/read")}>送った資料{sent}件を見る</a></p> : null}
      {places}
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
