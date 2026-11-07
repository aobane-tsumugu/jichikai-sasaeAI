import { projectFeatures } from "../project/task-features";
import { Hono, type Context } from "hono";
import { adminPath } from "../core/auth";
import { ErrorNotice, Layout, Notice } from "../core/ui";
import { AdminPage } from "../core/admin-ui";
import type { AdminEnv, WardInfo } from "../env";
import { getRoster } from "../answers/api";
import { addExemption, compareRota, exemptions, householdKey, householdLabel, lastPreparation, prepareRota, rotaDate, type Comparison } from "./store";
import { getProjectSummary } from "../project/api";
import { householdHistory } from "./history";
import { rotaSchedule, WEEKDAYS } from "./schedule";
import { yearRecurringAdmin } from "../know/year";

const admin = new Hono<AdminEnv>();
admin.route("/", yearRecurringAdmin);
admin.use("/rota/*", async (c, next) => { c.header("Cache-Control", "private, no-store"); await next(); });

export async function rotaPanel(db: D1Database, ward: WardInfo, projectId: string) {
  const proposal = await compareRota(db, ward.wardId, projectId);
  const preparation = await lastPreparation(db, ward.wardId, projectId);
  const schedule = await rotaSchedule(db, ward.wardId, projectId);
  const comparison = proposal?.comparison;
  const root = adminPath(ward, `/projects/${projectId}/draft/duty_roster`);
  const weeklyForm = <form method="post" action={adminPath(ward, `/rota/${projectId}/weekly`)}>
    <div class="field"><label for="weekly-weekday">何曜日に当番を回しますか</label><select id="weekly-weekday" name="weekday" required>
      <option value="" selected={!schedule}>曜日を選んでください</option>{WEEKDAYS.map((day, index) => <option value={String(index)} selected={schedule?.weekday === index}>{day}曜日</option>)}</select></div>
    <button class="secondary">一年分の日付を名簿の順に割り当てる</button></form>;
  return <section class="panel"><h2>{schedule ? "一年分の当番表" : comparison?.hasPreviousTable === false ? "名簿から当番の下書きを作る" : "去年の表と今の名簿"}</h2>
    <p>{schedule ? `${comparison?.year ?? ""}年の毎週${WEEKDAYS[schedule.weekday]}曜を名簿の順に割り当てます。その日に免除されている世帯は飛ばします。`
      : comparison?.hasPreviousTable === false ? "去年の表がないため、班と世帯を名簿の順で並べます。名簿の順です。" : "去年の表の日と班と世帯を、今年の日に合わせて並べます。免除の期間に当たる人と今の名簿にない人を担当から外します。班や団体で書かれた担当はそのまま残します。"}</p>
    {schedule ? <details class="fold"><summary>曜日を直す</summary><div>{weeklyForm}</div></details> : <>{weeklyForm}<p>毎週回す当番でなければ、下の操作で去年の表や名簿から作れます。</p></>}
    {comparison ? <>
      {schedule ? <p>名簿に加わった世帯: {comparison.added.join("、") || "ありません。"}<br />名簿から外れた世帯: {comparison.removed.join("、") || "ありません。"}</p> : comparison.hasPreviousTable !== false ? <>
      <p class="muted">{comparison.year}年の{comparison.sourceTitle}と比べています。{!comparison.hasOldRoster ? "去年の名簿は残っていません。当番表にある名前と比べています。" : ""}</p>
      <dl class="facts">
        <dt>{comparison.hasOldRoster ? "名簿に加わった世帯" : "去年の表にない世帯"}</dt><dd>{comparison.added.join("、") || "ありません。"}</dd>
        <dt>{comparison.hasOldRoster ? "名簿から外れた世帯" : "今の名簿にない担当"}</dt><dd>{comparison.removed.join("、") || "ありません。"}</dd>
        <dt>担当を外したところ</dt><dd>{comparison.entries.some((entry) => entry.explanation) ? comparison.entries.filter((entry) => entry.explanation).map((entry) => <div>{entry.data.slot} {entry.data.task}: {entry.explanation}</div>) : "ありません。"}</dd>
        <dt>去年の決めたこと</dt><dd>{comparison.ruleRecords.join(" / ") || "記録はありません。順番のルールは作っていません。"}</dd>
      </dl>
      </> : <p>順番のルールは作っていません。免除の期間に当たる人は担当から外します。</p>}
      <form method="post" action={`${root}/start`}><div class="action-links"><button class="secondary">{preparation ? "今の名簿と免除を下書きに反映する" : comparison.hasPreviousTable === false ? "名簿から下書きを作る" : "去年の表と名簿から下書きを作る"}</button></div></form>
      <p class="muted">役員が直した行はそのまま残します。保存しただけでは、実行委員と班長のページに載りません。</p>
    </> : <section class="next"><strong>次は</strong><p>去年の表も今の名簿もまだありません。手元の当番表を写真やファイルで送れます。</p>
      <a class="button secondary" href={adminPath(ward, `/intake?project=${encodeURIComponent(projectId)}#send-form`)}>当番表を送る</a></section>}
    <ul class="links"><li><a href={adminPath(ward, "/rota/exemptions")}>免除を記録する</a></li>
      <li><a href={adminPath(ward, "/rota/history")}>世帯ごとの当番と役を読む</a></li></ul>
  </section>;
}

admin.post("/rota/:projectId/weekly", async (c) => {
  const { ward, account } = c.var;
  const id = c.req.param("projectId");
  const project = await getProjectSummary(c.env.DB, ward.wardId, id);
  if (!project || project.closedAt || !(await projectFeatures(c.env.DB, ward.wardId, id)).rota) return c.notFound();
  const value = String((await c.req.formData()).get("weekday") ?? "");
  const weekday = /^[0-6]$/.test(value) ? Number(value) : -1;
  const previous = await lastPreparation(c.env.DB, ward.wardId, id);
  const ok = weekday >= 0 && await prepareRota(c.env.DB, ward.wardId, id, account.accountId, weekday);
  if (!ok) return c.html(<AdminPage ward={ward} account={account} title="当番表を作れませんでした" back={{ href: adminPath(ward, `/projects/${id}/draft/duty_roster`), label: "当番の下書きへ戻る" }}>
    <h1>当番表を作れませんでした</h1><p class="lead">曜日を選び、世帯の名簿が入っていることを確かめて、もう一度お試しください。</p>
    <a class="button" href={adminPath(ward, `/projects/${id}/draft/duty_roster`)}>曜日を選び直す</a><a class="quiet" href={adminPath(ward, "/answers/roster")}>名簿を入れる・直す</a>
  </AdminPage>, 400);
  return c.redirect(`${adminPath(ward, `/rota/${id}/result`)}?notice=saved&done=${previous ? "updated" : "created"}`, 303);
});

export async function rotaRowNotes(db: D1Database, wardId: string, projectId: string): Promise<Comparison["entries"]> {
  const preparation = await lastPreparation(db, wardId, projectId);
  return preparation ? (JSON.parse(preparation.comparison_json) as Comparison).entries : [];
}

// 保存は元の経路に任せ、当番の作成と作り直しの成功後だけ案内を出す。
admin.use("/projects/:projectId/draft/duty_roster/start", async (c, next) => {
  if (c.req.method !== "POST") return next();
  const { ward } = c.var;
  const id = c.req.param("projectId");
  const project = await getProjectSummary(c.env.DB, ward.wardId, id);
  if (!project || project.closedAt || !(await projectFeatures(c.env.DB, ward.wardId, id)).rota) return next();
  const previous = await lastPreparation(c.env.DB, ward.wardId, id);
  await next();
  const location = c.res.headers.get("location");
  if (c.res.status === 303 && location && new URL(location, c.req.url).searchParams.get("notice") === "saved") {
    c.res = c.redirect(`${adminPath(ward, `/rota/${id}/result`)}?notice=saved&done=${previous ? "updated" : "created"}`, 303);
  }
});

admin.get("/rota/:projectId/result", async (c) => {
  const { ward } = c.var;
  const id = c.req.param("projectId");
  const project = await getProjectSummary(c.env.DB, ward.wardId, id);
  if (!project || !(await projectFeatures(c.env.DB, ward.wardId, id)).rota) return c.notFound();
  const draft = adminPath(ward, `/projects/${id}/draft/duty_roster`);
  const title = c.req.query("done") === "updated" ? "今の名簿と免除を下書きに反映しました" : "当番の下書きを作りました";
  return c.html(<AdminPage ward={ward} account={c.var.account} title={title}
    back={{ href: draft, label: "当番の下書きへ戻る" }}>
    <h1>{title}</h1><p class="lead">役員が直した行と去年の表は残しています。まだ実行委員と班長のページに載せていません。</p>
    <section class="next"><strong>次は</strong><p>時間帯や担当を、下書きで直せます。</p><a class="button" href={draft}>当番の下書きを直す</a></section>
    <p>担当を戻したいときも、下書きで書き直せます。免除を間違えたときは、免除の画面で取り消せます。</p>
    <a class="quiet" href={adminPath(ward, "/rota/exemptions")}>免除の画面へ戻る</a>
  </AdminPage>);
});

type ExemptionFields = Record<"household" | "reason" | "starts_on" | "ends_on", string>;

async function exemptionPage(c: Context<AdminEnv>, values?: ExemptionFields) {
  const { ward } = c.var;
  const [roster, records] = await Promise.all([getRoster(c.env.DB, ward.wardId), exemptions(c.env.DB, ward.wardId)]);
  const entries = roster.filter((entry) => roster.filter((other) => householdKey(other) === householdKey(entry)).length === 1);
  const root = adminPath(ward, "/rota/exemptions");
  const action = c.req.query("action");
  const result = action === "withdraw" ? "免除を取り消しました。" : action === "restore" ? "取り消した免除を戻しました。" : "免除の記録を保存しました。";
  return c.html(<Layout title="当番の免除" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/rota/history")}>← 世帯ごとの当番と役へ</a>
    <h1>当番の免除</h1><p class="lead">役員が決めた免除の理由と期間を書きます。ここに書いたことは役員だけが読みます。</p>
    {c.req.query("saved") ? <>
      <Notice>{result}</Notice><section class="next"><strong>次は</strong><p>当番表で「今の名簿と免除を下書きに反映する」を押すと、まだ直していない担当に反映できます。</p>
        <a class="button" href={adminPath(ward, "/")}>当番を選ぶ</a></section>
      <p>{action === "withdraw" ? "取り消しを戻すときは、下の記録の「取り消した免除を戻す」を押せます。" : "書き間違えたときは、下の記録の「この免除を取り消す」を押して、書き直せます。"}</p>
      <a class="quiet" href={root}>免除の画面へ戻る</a>
    </> : null}
    <ErrorNotice code={values ? "input" : c.req.query("error")} messages={{ input: "代表者のお名前、理由、始めと終わりの日を確かめて、もう一度保存してください。" }} />
    {entries.length ? <form class="panel" method="post" action={root}>
      <div class="field"><label for="household">世帯の代表者（ふつうは世帯主）のお名前と班</label><select id="household" name="household" required>{entries.map((entry) => <option value={JSON.stringify(entry)} selected={values?.household === JSON.stringify(entry)}>{householdLabel(entry)}</option>)}</select></div>
      <div class="field"><label for="reason">免除の理由</label><input id="reason" name="reason" value={values?.reason} maxlength={200} required /></div>
      <div class="field"><label for="starts">始めの日</label><input id="starts" type="date" name="starts_on" value={values?.starts_on} required /></div>
      <div class="field"><label for="ends">終わりの日</label><input id="ends" type="date" name="ends_on" value={values?.ends_on} required /></div>
      <div class="action-bar"><button>免除を記録する</button></div>
    </form> : <section class={c.req.query("saved") ? "panel" : "next"}><strong>{c.req.query("saved") ? "名簿がまだありません" : "次は"}</strong><p>今の名簿に、班とお名前で区別できる世帯がありません。名簿を入れるか直すと、免除を書けます。</p>
      <a class="button" href={adminPath(ward, "/answers/roster")}>名簿を入れる・直す</a></section>}
    <p class="muted">書き間違えたものは取り消して、書き直せます。理由や期間は当番表や紙には載りません。</p>
    {records.map((record) => <section class="panel"><h2>{householdLabel(record)}</h2><p>{record.reason}</p>
      <p class="muted">{rotaDate(record.starts_on)}から{rotaDate(record.ends_on)}まで{record.withdrawn_at ? "　取り消しました" : ""}</p>
      <form method="post" action={`${root}/${record.exemption_id}/${record.withdrawn_at ? "restore" : "withdraw"}`}>
        <button class="secondary">{record.withdrawn_at ? "取り消した免除を戻す" : "この免除を取り消す"}</button></form>
    </section>)}
  </Layout>, values ? 400 : 200);
}

admin.get("/rota/exemptions", (c) => exemptionPage(c));

admin.post("/rota/exemptions", async (c) => {
  const form = await c.req.formData();
  const values: ExemptionFields = {
    household: String(form.get("household") ?? ""), reason: String(form.get("reason") ?? ""),
    starts_on: String(form.get("starts_on") ?? ""), ends_on: String(form.get("ends_on") ?? ""),
  };
  let selected: unknown;
  try { selected = JSON.parse(values.household); } catch { selected = null; }
  const entry = typeof selected === "object" && selected !== null ? selected as Record<string, unknown> : {};
  const ok = typeof entry.household === "string" && typeof entry.district === "string" && await addExemption(c.env.DB, c.var.ward.wardId, c.var.account.accountId, {
    household: entry.household, district: entry.district, reason: values.reason, startsOn: values.starts_on, endsOn: values.ends_on,
  });
  return ok ? c.redirect(`${adminPath(c.var.ward, "/rota/exemptions")}?saved=1`, 303) : exemptionPage(c, values);
});
admin.post("/rota/exemptions/:id/:action", async (c) => {
  const action = c.req.param("action");
  if (action !== "restore" && action !== "withdraw") return c.notFound();
  const result = await c.env.DB.prepare(`UPDATE rota_exemptions SET withdrawn_at = ?, withdrawn_by_account_id = ? WHERE ward_id = ? AND exemption_id = ?`)
    .bind(action === "withdraw" ? new Date().toISOString() : null, action === "withdraw" ? c.var.account.accountId : null, c.var.ward.wardId, c.req.param("id")).run();
  return c.redirect(`${adminPath(c.var.ward, "/rota/exemptions")}?${result.meta.changes === 1 ? `saved=1&action=${action}` : "error=input"}`, 303);
});

admin.get("/rota/history", async (c) => {
  const { ward } = c.var;
  const households = await householdHistory(c.env.DB, ward.wardId);
  return c.html(<Layout title="世帯ごとの当番と役" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/")}>← 最初の画面へ</a><h1>世帯ごとの当番と役</h1>
    <p class="lead">終わった当番や行事の担当、役員の交代と免除を、今ある記録から読みます。</p>
    <p class="muted">名前だけでは世帯を特定できない記録は分けて表示します。書かれていない出席や過去の交代は推測しません。</p>
    <div class="action-links"><a class="button secondary" href={adminPath(ward, "/rota/exemptions")}>免除を記録する</a></div>
    {!households.length ? <section class="next"><strong>次は</strong><p>当番と役の記録はまだありません。名簿を入れると、世帯ごとに読めます。</p>
      <a class="button" href={adminPath(ward, "/answers/roster")}>名簿を入れる</a></section> : null}
    {households.map((household) => <details class="fold"><summary>{householdLabel(household)}{household.records.length + household.exemptions.length ? `（${household.records.length + household.exemptions.length}件）` : ""}</summary><div>
      {household.records.length === 0 && household.exemptions.length === 0 ? <p>当番と役の記録はまだありません。</p> : null}
      {household.records.map((record) => <article><h3>{record.what}</h3><p class="muted">{record.who} / {record.when}</p><p>{record.detail}</p>
        {record.projectId ? <p><a class="quiet" href={adminPath(ward, `/${record.closed ? "archive" : "projects"}/${record.projectId}`)}>元の記録を読む</a></p> : null}</article>)}
      {household.exemptions.map((record) => <article><h3>当番の免除{record.withdrawn_at ? "（取り消し）" : ""}</h3>
        <p>{rotaDate(record.starts_on)}から{rotaDate(record.ends_on)}まで / {record.reason}</p></article>)}
    </div></details>)}
  </Layout>);
});

export { admin as rotaAdmin };
