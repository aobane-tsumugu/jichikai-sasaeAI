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
  return c.html(<AdminPage ward={ward} account={account} title={`${state.project.title}の実行委員名簿`} back={{ href: adminPath(ward, `/projects/${id}/map`), label: `${state.project.title}のやることへ` }}>
    <h1>{state.project.title}の実行委員名簿</h1>
    {failed ? <Notice error>保存できませんでした。名前を入れ、同じ名前と役の人がいないか確かめてください。書いた内容は下に残っています。</Notice> : null}
    {removeFailed ? <Notice error>名簿から外せませんでした。終わりにしていないか確かめてください。</Notice> : null}
    {saved || removed ? <><Notice>{saved ? "保存しました。" : "名簿から外しました。間違えたときは、もう一度足せます。"}載せ直すまで、実行委員と班長のページの名簿は変わりません。</Notice><section class="next"><strong>次は</strong><p>届けるときは、実行委員と班長のページに載せてください。</p><a class="button" href={adminPath(ward, `/publish/${id}`)}>知らせる画面へ</a></section></> : null}
    {/* まだ空の時は、決まった人を打って足すのが次にすること。書いた紙がある時だけ撮って送る。 */}
    {!rows.length ? <><p class="lead">{state.project.title}の実行委員は、まだ入っていません。決まった人の名前と連絡先を入れておくと、当番表や、実行委員と班長のページに使えます。</p>
      {!closed ? <><section class="next"><form method="post" action={base}><Fields id={NEW_ROW} data={failed?.rowId === NEW_ROW ? failed.data : {}} /><button>名簿に足す</button></form></section>
        <p>決まった人を書いた紙があれば、撮って送ってもかまいません。AIが読んで、ここに入れます。<a href={adminPath(ward, `/intake?project=${encodeURIComponent(id)}`)}>書いた紙を撮って送る</a></p></> : null}</> : <>
    <p class="lead">実行委員の名前、役、連絡先です。押すと直せます。当番表や進め方と一緒に、実行委員と班長のページに載せます。</p>
    {closed ? <MaterialsTable table="committee" items={rows.map((row) => ({ kind: "committee", data: row.data }))} /> : rows.map((row) => <details class="fold" open={failed?.rowId === row.rowId}><summary>{row.data.name}{row.data.role ? `　${row.data.role}` : ""}</summary><div>
      <form method="post" action={`${base}/${row.rowId}`}><Fields id={row.rowId} data={failed?.rowId === row.rowId ? failed.data : row.data} /><button class="secondary">この人の名簿を保存する</button></form>
      <form method="post" action={`${base}/${row.rowId}/remove`}><button class="danger">この人を名簿から外す</button></form>
    </div></details>)}
    </>}
    {!closed && rows.length ? <details class="fold" open={failed?.rowId === NEW_ROW}><summary>人を足す</summary><div><form method="post" action={base}><Fields id={NEW_ROW} data={failed?.rowId === NEW_ROW ? failed.data : {}} /><button class="secondary">名簿に足す</button></form></div></details> : null}
    {rows.length && !saved && !removed ? <><p class="muted">住民向けのページには出しません。載せ直すまで、実行委員と班長のページの名簿は変わりません。</p>
    {!closed ? <a class="quiet" href={adminPath(ward, `/publish/${id}`)}>知らせる画面へ</a> : null}</> : null}
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
