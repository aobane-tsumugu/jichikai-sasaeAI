import { Hono, type Context } from "hono";
import { AdminPage } from "../core/admin-ui";
import { adminPath } from "../core/auth";
import { Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { saveCommitteeRow } from "./actions";
import { TABLES, type RowData } from "./model";
import { getProjectState } from "./state";

export const committeePages = new Hono<AdminEnv>();

async function show(c: Context<AdminEnv>, failed?: { rowId: string; data: RowData }) {
  const { ward, account } = c.var;
  const id = c.req.param("projectId")!;
  const state = await getProjectState(c.env.DB, ward.wardId, id);
  if (!state) return c.notFound();
  const base = adminPath(ward, `/projects/${id}/committee`);
  const rows = state.tables.committee.filter((row) => row.scope === "current");
  return c.html(<AdminPage ward={ward} account={account} title="実行委員名簿" back={{ href: adminPath(ward, `/projects/${id}`), label: "届いた資料へ" }}>
    <h1>実行委員名簿</h1><p class="lead">名前、役、連絡先を直せます。当番表や進め方と一緒に、実行委員と班長に配ります。</p>
    <p>区のページには出しません。配り直すまで、配った名簿は変わりません。</p>
    {failed ? <Notice error>保存できませんでした。名前を入れ、同じ名前と役の人がいないか確かめてください。書いた内容は下に残っています。</Notice> : null}
    {c.req.query("saved") === "1" ? <Notice>保存しました。届けるときは、配る画面で実行委員と班長に配ってください。</Notice> : null}
    {rows.map((row) => {
      const data = failed?.rowId === row.rowId ? failed.data : row.data;
      return <form class="panel" method="post" action={`${base}/${row.rowId}`}>
        {Object.entries(TABLES.committee.fields).map(([key, field]) => <div class="field">
          <label for={`${row.rowId}-${key}`}>{field.label}</label>
          <input id={`${row.rowId}-${key}`} name={key} value={data[key] ?? ""} required={key === "name"} disabled={!!state.project.closedAt} />
        </div>)}
        {!state.project.closedAt ? <button class="secondary">この人の名簿を保存する</button> : null}
      </form>;
    })}
    {!rows.length ? <><p>今年の実行委員名簿はまだありません。名簿の資料を送ってください。去年の名簿は、そのままでは今年の名簿にしません。</p><a class="button" href={adminPath(ward, `/intake?project=${encodeURIComponent(id)}`)}>名簿の資料を送る</a></> : null}
    {!state.project.closedAt && rows.length ? <a class="button" href={adminPath(ward, `/publish/${id}`)}>配る画面へ</a> : null}
  </AdminPage>, failed ? 400 : 200);
}

committeePages.get("/projects/:projectId/committee", (c) => show(c));
committeePages.post("/projects/:projectId/committee/:rowId", async (c) => {
  const form = await c.req.parseBody();
  const data = Object.fromEntries(Object.keys(TABLES.committee.fields).map((key) => [key, typeof form[key] === "string" ? form[key] : ""])) as RowData;
  const saved = await saveCommitteeRow(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), c.req.param("rowId"), c.var.account.accountId, data);
  return saved ? c.redirect(adminPath(c.var.ward, `/projects/${c.req.param("projectId")}/committee?saved=1`), 303) : show(c, { rowId: c.req.param("rowId"), data });
});
