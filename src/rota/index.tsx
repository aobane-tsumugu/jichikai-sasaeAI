import { Hono } from "hono";
import { adminPath } from "../core/auth";
import { ErrorNotice, Layout, Notice } from "../core/ui";
import type { AdminEnv, WardInfo } from "../env";
import { getRoster } from "../answers/api";
import { addExemption, compareRota, exemptions, householdKey, householdLabel, lastPreparation, rotaDate, type Comparison } from "./store";
import { householdHistory } from "./history";

const admin = new Hono<AdminEnv>();
admin.use("/rota/*", async (c, next) => { c.header("Cache-Control", "private, no-store"); await next(); });

export async function rotaPanel(db: D1Database, ward: WardInfo, projectId: string) {
  const proposal = await compareRota(db, ward.wardId, projectId);
  const preparation = await lastPreparation(db, ward.wardId, projectId);
  const comparison = proposal?.comparison;
  const root = adminPath(ward, `/projects/${projectId}/draft/duty_roster`);
  return <section class="panel"><h2>{comparison?.hasPreviousTable === false ? "名簿から当番の下書きを作る" : "去年の表と今の名簿"}</h2>
    <p>{comparison?.hasPreviousTable === false ? "去年の表がないため、班と世帯を名簿の順で並べます。名簿の順です。時間帯や担当は下の当番表で直せます。" : "去年の順番を保ち、免除の期間に当たる人と今の名簿にない人を担当から外します。班や団体で書かれた担当はそのまま残します。"}</p>
    {comparison ? <>
      {comparison.hasPreviousTable !== false ? <>
      <p class="muted">{comparison.year}年の{comparison.sourceTitle}と比べています。{!comparison.hasOldRoster ? "去年の名簿は残っていません。当番表にある名前と比べています。" : ""}</p>
      <dl class="facts">
        <dt>{comparison.hasOldRoster ? "名簿に加わった世帯" : "去年の表にない世帯"}</dt><dd>{comparison.added.join("、") || "ありません。"}</dd>
        <dt>{comparison.hasOldRoster ? "名簿から外れた世帯" : "今の名簿にない担当"}</dt><dd>{comparison.removed.join("、") || "ありません。"}</dd>
        <dt>担当を外したところ</dt><dd>{comparison.entries.some((entry) => entry.explanation) ? comparison.entries.filter((entry) => entry.explanation).map((entry) => <div>{entry.data.slot} {entry.data.task}: {entry.explanation}</div>) : "ありません。"}</dd>
        <dt>去年の決めたこと</dt><dd>{comparison.ruleRecords.join(" / ") || "記録はありません。順番のルールは作っていません。"}</dd>
      </dl>
      </> : <p>順番のルールは作っていません。免除の期間に当たる人は担当から外します。</p>}
      <form method="post" action={`${root}/start`}><div class="action-links"><button class="secondary">{preparation ? "今の名簿と免除を下書きに反映する" : comparison.hasPreviousTable === false ? "名簿から下書きを作る" : "去年の表と名簿から下書きを作る"}</button></div></form>
      <p class="muted">役員が直した行はそのまま残します。保存しただけでは配られません。</p>
    </> : <p>去年の表も今の名簿もまだありません。名簿か去年の当番表を送ると、下書きを作れます。</p>}
    <ul class="links"><li><a href={adminPath(ward, "/rota/exemptions")}>免除を記録する</a></li>
      <li><a href={adminPath(ward, "/rota/history")}>世帯ごとの当番と役を読む</a></li></ul>
  </section>;
}

export async function rotaRowNotes(db: D1Database, wardId: string, projectId: string): Promise<Comparison["entries"]> {
  const preparation = await lastPreparation(db, wardId, projectId);
  return preparation ? (JSON.parse(preparation.comparison_json) as Comparison).entries : [];
}

admin.get("/rota/exemptions", async (c) => {
  const { ward } = c.var;
  const [roster, records] = await Promise.all([getRoster(c.env.DB, ward.wardId), exemptions(c.env.DB, ward.wardId)]);
  const entries = roster.filter((entry) => roster.filter((other) => householdKey(other) === householdKey(entry)).length === 1);
  const root = adminPath(ward, "/rota/exemptions");
  return c.html(<Layout title="当番の免除" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/rota/history")}>← 世帯ごとの当番と役へ</a>
    <h1>当番の免除</h1><p class="lead">役員が決めた免除の理由と期間を書きます。ここに書いたことは役員だけが読みます。</p>
    {c.req.query("saved") ? <Notice>免除の記録を保存しました。当番表で「今の名簿と免除を下書きに反映する」を押すと、まだ直していない担当に反映します。</Notice> : null}
    <ErrorNotice code={c.req.query("error")} messages={{ input: "代表者のお名前、理由、始めと終わりの日を確かめて、もう一度保存してください。" }} />
    {entries.length ? <form class="panel" method="post" action={root}>
      <div class="field"><label for="household">代表者のお名前と班</label><select id="household" name="household" required>{entries.map((entry) => <option value={JSON.stringify(entry)}>{householdLabel(entry)}</option>)}</select></div>
      <div class="field"><label for="reason">免除の理由</label><input id="reason" name="reason" maxlength={200} required /></div>
      <div class="field"><label for="starts">始めの日</label><input id="starts" type="date" name="starts_on" required /></div>
      <div class="field"><label for="ends">終わりの日</label><input id="ends" type="date" name="ends_on" required /></div>
      <div class="action-links"><button>免除を記録する</button></div>
    </form> : <p>今の名簿に、班とお名前で区別できる世帯がありません。名簿を確かめてから書けます。</p>}
    <p class="muted">書き間違えたものは取り消して、書き直せます。理由や期間は当番表や紙には載りません。</p>
    {records.map((record) => <section class="panel"><h2>{householdLabel(record)}</h2><p>{record.reason}</p>
      <p class="muted">{rotaDate(record.starts_on)}から{rotaDate(record.ends_on)}まで{record.withdrawn_at ? "　取り消しました" : ""}</p>
      <form method="post" action={`${root}/${record.exemption_id}/${record.withdrawn_at ? "restore" : "withdraw"}`}>
        <button class="secondary">{record.withdrawn_at ? "取り消した免除を戻す" : "この免除を取り消す"}</button></form>
    </section>)}
  </Layout>);
});

admin.post("/rota/exemptions", async (c) => {
  const form = await c.req.formData();
  let selected: unknown;
  try { selected = JSON.parse(String(form.get("household") ?? "")); } catch { selected = null; }
  const entry = typeof selected === "object" && selected !== null ? selected as Record<string, unknown> : {};
  const ok = typeof entry.household === "string" && typeof entry.district === "string" && await addExemption(c.env.DB, c.var.ward.wardId, c.var.account.accountId, {
    household: entry.household, district: entry.district, reason: String(form.get("reason") ?? ""), startsOn: String(form.get("starts_on") ?? ""), endsOn: String(form.get("ends_on") ?? ""),
  });
  return c.redirect(`${adminPath(c.var.ward, "/rota/exemptions")}?${ok ? "saved=1" : "error=input"}`, 303);
});
admin.post("/rota/exemptions/:id/:action", async (c) => {
  const action = c.req.param("action");
  if (action !== "restore" && action !== "withdraw") return c.notFound();
  const result = await c.env.DB.prepare(`UPDATE rota_exemptions SET withdrawn_at = ?, withdrawn_by_account_id = ? WHERE ward_id = ? AND exemption_id = ?`)
    .bind(action === "withdraw" ? new Date().toISOString() : null, action === "withdraw" ? c.var.account.accountId : null, c.var.ward.wardId, c.req.param("id")).run();
  return c.redirect(`${adminPath(c.var.ward, "/rota/exemptions")}?${result.meta.changes === 1 ? "saved=1" : "error=input"}`, 303);
});

admin.get("/rota/history", async (c) => {
  const { ward } = c.var;
  const households = await householdHistory(c.env.DB, ward.wardId);
  return c.html(<Layout title="世帯ごとの当番と役" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/")}>← 最初の画面へ</a><h1>世帯ごとの当番と役</h1>
    <p class="lead">閉じた当番や行事の担当、役員の交代と免除を、今ある記録から読みます。</p>
    <p class="muted">名前だけでは世帯を特定できない記録は分けて表示します。書かれていない出席や過去の交代は推測しません。</p>
    <div class="action-links"><a class="button secondary" href={adminPath(ward, "/rota/exemptions")}>免除を記録する</a></div>
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
