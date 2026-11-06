import { Hono, type Context } from "hono";
import { AdminPage } from "../core/admin-ui";
import { adminPath } from "../core/auth";
import { Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { addCommitteeRow, removeCommitteeRow, saveCommitteeRow } from "./actions";
import { TABLES, type RowData } from "./model";
import { MaterialsTable } from "../space/materials";
import { getProjectState } from "./state";

export const committeePages = new Hono<AdminEnv>();

const NEW_ROW = "new";
const Fields = ({ id, data }: { id: string; data: RowData }) => <>{Object.entries(TABLES.committee.fields).map(([key, field]) => <div class="field">
  <label for={`${id}-${key}`}>{field.label}</label>
  <input id={`${id}-${key}`} name={key} value={data[key] ?? ""} required={key === "name"} />
</div>)}</>;

async function show(c: Context<AdminEnv>, failed?: { rowId: string; data: RowData }, removeFailed = false) {
  const { ward, account } = c.var;
  const id = c.req.param("projectId")!;
  const state = await getProjectState(c.env.DB, ward.wardId, id);
  if (!state) return c.notFound();
  const base = adminPath(ward, `/projects/${id}/committee`);
  const rows = state.tables.committee.filter((row) => row.scope === "current");
  const closed = !!state.project.closedAt;
  const saved = c.req.query("saved") === "1";
  const removed = c.req.query("removed") === "1";
  return c.html(<AdminPage ward={ward} account={account} title="実行委員名簿" back={{ href: adminPath(ward, `/projects/${id}`), label: "届いた資料へ" }}>
    <h1>実行委員名簿</h1>
    {failed ? <Notice error>保存できませんでした。名前を入れ、同じ名前と役の人がいないか確かめてください。書いた内容は下に残っています。</Notice> : null}
    {removeFailed ? <Notice error>名簿から外せませんでした。行事が閉じていないか確かめてください。</Notice> : null}
    {saved || removed ? <><Notice>{saved ? "保存しました。" : "名簿から外しました。間違えたときは、下の「人を足す」からもう一度足せます。"}配り直すまで、配った名簿は変わりません。</Notice><section class="next"><strong>次は</strong><p>届けるときは、実行委員と班長に配ってください。</p><a class="button" href={adminPath(ward, `/publish/${id}`)}>配る画面へ</a></section></> : null}
    {!rows.length ? <><div class="notice" role="status"><strong>今年の実行委員名簿はまだありません</strong><p>去年の名簿は、そのままでは今年の名簿にしません。</p></div>
      {!closed ? <section class="next"><strong>次は</strong><p>名簿の資料を送ると、ここに入ります。下の「人を足す」から一人ずつ足すこともできます。</p><a class="button" href={adminPath(ward, `/intake?project=${encodeURIComponent(id)}`)}>名簿の資料を送る</a></section> : null}</> : <>
    <p class="lead">実行委員の名前、役、連絡先です。押すと直せます。当番表や進め方と一緒に、実行委員と班長に配ります。</p>
    {closed ? <MaterialsTable table="committee" items={rows.map((row) => ({ kind: "committee", data: row.data }))} /> : rows.map((row) => <details class="fold" open={failed?.rowId === row.rowId}><summary>{row.data.name}{row.data.role ? `　${row.data.role}` : ""}</summary><div>
      <form method="post" action={`${base}/${row.rowId}`}><Fields id={row.rowId} data={failed?.rowId === row.rowId ? failed.data : row.data} /><button class="secondary">この人の名簿を保存する</button></form>
      <form method="post" action={`${base}/${row.rowId}/remove`}><button class="danger">この人を名簿から外す</button></form>
    </div></details>)}
    </>}
    {!closed ? <details class="fold" open={failed?.rowId === NEW_ROW}><summary>人を足す</summary><div><form method="post" action={base}><Fields id={NEW_ROW} data={failed?.rowId === NEW_ROW ? failed.data : {}} /><button class="secondary">名簿に足す</button></form></div></details> : null}
    {rows.length ? <><p class="muted">区のページには出しません。配り直すまで、配った名簿は変わりません。</p>
    {!closed && !saved && !removed ? <a class="quiet" href={adminPath(ward, `/publish/${id}`)}>配る画面へ</a> : null}</> : null}
  </AdminPage>, failed ? 400 : removeFailed ? 409 : 200);
}

const rowFrom = (form: Record<string, unknown>) => Object.fromEntries(Object.keys(TABLES.committee.fields).map((key) => [key, typeof form[key] === "string" ? form[key] : ""])) as RowData;
const listPath = (c: Context<AdminEnv>, notice: string) => adminPath(c.var.ward, `/projects/${c.req.param("projectId")}/committee?${notice}=1`);

committeePages.get("/projects/:projectId/committee", (c) => show(c));
committeePages.post("/projects/:projectId/committee", async (c) => {
  const data = rowFrom(await c.req.parseBody());
  return await addCommitteeRow(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), c.var.account.accountId, data)
    ? c.redirect(listPath(c, "saved"), 303) : show(c, { rowId: NEW_ROW, data });
});
committeePages.post("/projects/:projectId/committee/:rowId/remove", async (c) => (
  await removeCommitteeRow(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), c.req.param("rowId"), c.var.account.accountId)
    ? c.redirect(listPath(c, "removed"), 303) : show(c, undefined, true)
));
committeePages.post("/projects/:projectId/committee/:rowId", async (c) => {
  const data = rowFrom(await c.req.parseBody());
  const saved = await saveCommitteeRow(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), c.req.param("rowId"), c.var.account.accountId, data);
  return saved ? c.redirect(listPath(c, "saved"), 303) : show(c, { rowId: c.req.param("rowId"), data });
});
