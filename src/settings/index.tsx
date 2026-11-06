import { getDigestSettings, inquiryNotice } from "./digest";
import { Hono } from "hono";
import { AdminPage } from "../core/admin-ui";
import { Hint } from "../core/ui";
import { adminPath, clearDeviceCookie } from "../core/auth";
import type { Bundle } from "../core/bundle";
import type { AdminEnv } from "../env";
import { getProjectState, listOpenProjects } from "../project/api";
import { dateWords } from "../project/followup";
import { countWord } from "../project/model";
import { listInboxItems } from "../line";
import { nearInquiryDates } from "../line/digest";
import { info } from "./info";
import { formatJstDate } from "../core/time";
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
  const places = <><h2>ほかの場所</h2><ul class="links">
    {projects.length ? <><li class="link-line"><a href={adminPath(ward, "/projects/today")}>今やること</a></li><li class="link-line"><a href={adminPath(ward, "/answers")}>答えを見る</a></li></> : null}
    <li class="link-line"><a href={adminPath(ward, "/archive")}>記録を読む</a></li>
    {projects.length ? <><li class="link-line"><a href={adminPath(ward, "/archive/map")}>一年の予定</a></li><li class="link-line"><a href={adminPath(ward, "/answers/roster")}>名簿</a></li></> : null}
    <li class="link-line"><a href={adminPath(ward, "/settings")}>区の設定</a></li>
    {projects.length ? <><li class="link-line"><a href={adminPath(ward, "/requests/city")}>行政の依頼</a></li><li class="link-line"><a href={adminPath(ward, "/inquiries")}>問い合わせと要望</a></li></> : null}
    <li><form method="post" action={adminPath(ward, "/logout")}><button class="quiet">このスマホやパソコンから出る</button></form></li>
  </ul></>;
  return c.html(<AdminPage ward={ward} account={account} title="最初の画面" home>
    {projects.length === 0 ? sent === 0 ? closed ? <>
      <h1>去年の記録から始められます</h1>
      <p class="lead">残っている段取りや報告を読んで、今年の準備を始められます。</p>
      <div class="action-links"><a class="button" href={adminPath(ward, "/archive")}>記録を読む</a></div>
      <div class="action-links"><a class="button secondary" href={adminPath(ward, "/intake")}>手元の紙や資料を送る</a><a class="button secondary" href={adminPath(ward, "/projects")}>新しく始める</a></div>
      {places}
    </> : <>
      <h1>去年の資料を送ってください</h1>
      <p class="lead">案内の紙でも、Wordでも、写真でも、そのまま送れます。整理はいりません。</p>
      <div class="action-links"><a class="button" href={adminPath(ward, "/intake")}>去年の資料を送る</a></div>
      <h2>送ると、こうなります</h2><ul>
        <li>AIが読んで、日時、場所、協賛先などを取り出します。</li><li>資料から、今年の段取りができます。</li><li>案内の下書きができます。直して配るのは役員です。</li>
      </ul>
      <details class="hint"><summary>資料がどこにあるか分からないとき</summary><div><p>見つかったものから一枚だけでも送れます。何もないときは、下のボタンから始められます。</p></div></details>
      <div class="action-links"><a class="button secondary" href={adminPath(ward, "/projects")}>資料がないので、種類を選んで始める</a></div>
    </> : <>
      <h1>送った資料</h1><p class="lead">{sent}件を預かっています。読み終わった分から、段取りを作れます。</p>
      <p class="muted">{read ? `読み終わりました${read}件。` : ""}{reading ? `読んでいます${reading}件。` : ""}{delayed ? `読み取りが遅れています${delayed}件。送り直す必要はありません。` : ""}{failed ? `読めませんでした${failed}件。もう一度読むか、このまま進められます。` : ""}</p>
      <section class="next"><strong>次は</strong><p>読み終わったものを見てください。</p><a class="button" href={adminPath(ward, "/intake/read")}>読み終わったものを見る</a></section>
      <div class="action-links"><a class="button secondary" href={adminPath(ward, "/intake")}>続けて送る</a><a class="button secondary" href={adminPath(ward, "/projects")}>資料がないので、種類を選んで始める</a></div>
      <p class="link-line"><a href={adminPath(ward, "/intake/received")}>送ったものを見る</a></p>{places}
    </> : <>
      <h1>いま進めていること</h1>
      {near.length ? <div class="notice"><strong>{near[0]}</strong><p>{inquiryNotice(digest)}</p><a class="quiet" href={adminPath(ward, "/inquiries")}>問い合わせを見る</a></div> : null}
      <p class="lead">押すと段取りが開きます。手元に紙や資料があれば、先に送ってかまいません。</p>
      <div class="action-links"><a class="button" href={adminPath(ward, "/intake")}>手元の紙や資料を送る</a></div>
      <ul class="rows two">{projects.map((p, index) => {
        const state = states[index];
        const tasks = state?.mapTasks.filter((task) => task.progress !== "done" && (task.periodStart || task.periodEnd) && (!task.periodStart || task.periodStart <= today) && (!task.periodEnd || task.periodEnd >= today)) ?? [];
        const questions = state?.questions.length ?? 0;
        const due = p.deadlines.event_day ?? p.deadlines.submit_due;
        const days = due ? Math.ceil((Date.parse(due) - Date.parse(today)) / 86400_000) : null;
        return <li><a class="row-link" href={adminPath(ward, `/projects/${p.projectId}/map`)}><b>{p.title}</b>
          {due ? <span>{formatJstDate(due)}{p.deadlines.submit_due && !p.deadlines.event_day ? "までに提出" : days !== null && days >= 0 ? `まで、あと${days}日` : ""}</span> : null}
          <span>{tasks.length ? `今の時期の仕事: ${tasks.map((t) => t.name).join("、")}` : state?.mapTasks.length ? "今の時期の仕事はありません" : "仕事はまだありません。段取りから足せます"}</span>
          {questions ? <span>質問 {countWord(questions)}</span> : null}
        </a></li>;
      })}</ul>
      <div class="action-links"><a class="button secondary" href={adminPath(ward, "/projects")}>新しく始める</a></div>
      <h2>届いたもの</h2><ul class="rows"><li><a class="row-link" href={adminPath(ward, "/inbox")}><b>公式LINEに届いた写真と文 {receivedCount}件</b>
        {receivedCount ? <span>{lineInbox.some((i) => i.disposition === "matched") ? "AIが行事に入れました。" : ""}{lineInbox.some((i) => i.disposition === "unmatched") ? `${lineInbox.filter((i) => i.disposition === "unmatched").length}件はどの行事か分かりませんでした` : ""}{inquiryCount ? `問い合わせが${countWord(inquiryCount)}あります。${inquiryWord ? `${countWord(inquiryWords.filter((words) => words.includes(inquiryWord)).length)}に「${inquiryWord}」と書かれています` : ""}` : ""}</span> : <span>まだ届いていません</span>}
      </a></li>{sent ? <li><a class="row-link" href={adminPath(ward, "/intake/read")}><b>送った資料{sent}件</b><span>読み終わったものを見る</span></a></li> : null}</ul>
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
