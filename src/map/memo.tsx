import { Hono } from "hono";
import type { AdminEnv } from "../env";
import { adminPath } from "../core/auth";
import { adminResult } from "../core/admin-ui";
import { Layout, Notice } from "../core/ui";
import { newId, nowIso } from "../core/ids";
import { formatDateText } from "../core/time";
import { getProjectState, listProjects } from "../project/api";
import { cleanRowData, displayFieldValue, normalizeKey, rowMatchKey, TABLES, type RowData } from "../project/model";
import type { MemoRow, ProjectState, RowView } from "../project/types";
import { hashOf, stableStringify } from "../project/util";
import { MEMO_TEMPLATES } from "./memo-template";

export const memoAdmin = new Hono<AdminEnv>();
const rootPath = (id: string) => `/projects/${id}/ledger`;
const rowPath = (id: string, key: string) => `${rootPath(id)}/${encodeURIComponent(key)}`;
const yen = (amount: number) => `${amount.toLocaleString("ja-JP")}円`;
const nameOf = (data: RowData) => String(data.what || data.counterpart || "メモ");
const keyOf = (row: RowView) => String(row.data.memoKey || (row.table === "sponsors" ? `sponsor:${row.matchKey}` : `legacy:${row.matchKey}`));
const customKey = (key: string) => /^custom:[0-9a-f-]{36}$/.test(key);
function findRow(rows: MemoRow[], state: ProjectState, key: string): MemoRow | undefined {
  const original = [...state.tables.sponsors, ...state.tables.ledger].find((row) => row.scope === "current" && row.rowId === key);
  return rows.find((row) => row.key === key || row.current?.rowId === key || (original && row.key === keyOf(original)));
}
const dataOf = (row: RowView): RowData => row.table === "sponsors"
  ? { counterpart: row.data.name ?? "", ...(typeof row.data.amount === "number" ? { amount: row.data.amount } : {}), note: row.data.note ?? "", memoGroup: "sponsors" }
  : { ...row.data };

/** 一般の項目は表示だけ。写真のない項目に額や頼み先を補わない。 */
export async function getMemoRows(db: D1Database, wardId: string, state: ProjectState): Promise<MemoRow[]> {
  const id = state.project.projectId;
  const rows = new Map<string, MemoRow>();
  for (const row of [...state.tables.sponsors, ...state.tables.ledger].filter((r) => r.scope === "current")) {
    const key = keyOf(row); const data = dataOf(row);
    rows.set(key, { key, name: row.table === "sponsors" ? String(data.counterpart || "協賛") : nameOf(data), hint: "", data, current: row, reference: null, removed: false, sponsor: row.table === "sponsors" || data.memoGroup === "sponsors" });
  }
  const hidden = await db.prepare(`SELECT r.row_id, r.project_id, r.data, r.match_key, origin.year,
    r.source_kind, r.source_ref, r.source_locator, r.source_year, r.confidence, r.updated_at FROM projects p
    JOIN project_rows r ON r.ward_id = p.ward_id AND (r.project_id = p.project_id OR r.project_id = p.seed_project_id)
    JOIN projects origin ON origin.ward_id = r.ward_id AND origin.project_id = r.project_id
    WHERE p.ward_id = ? AND p.project_id = ? AND r.table_key = 'ledger' AND r.scope = 'current' AND r.removed_at IS NOT NULL
    ORDER BY r.project_id = p.project_id DESC`)
    .bind(wardId, id).all<{ row_id: string; project_id: string; data: string; match_key: string; year: number; source_kind: RowView["source"]["kind"]; source_ref: string | null; source_locator: string | null; source_year: number | null; confidence: RowView["confidence"]; updated_at: string }>();
  for (const row of hidden.results) {
    const previous = JSON.parse(row.data) as RowData; const key = String(previous.memoKey || `legacy:${row.match_key}`);
    const inherited = row.project_id !== id;
    const data: RowData = inherited ? { memoKey: key, what: previous.what || previous.counterpart || "メモ", ...(previous.memoGroup ? { memoGroup: previous.memoGroup } : {}) } : previous;
    const reference: RowView | null = inherited ? { rowId: row.row_id, table: "ledger", scope: "reference", refYear: row.year, matchKey: row.match_key, data: previous, personFields: Object.keys(previous), source: { kind: row.source_kind, ref: row.source_ref, locator: row.source_locator, year: row.source_year }, confidence: row.confidence, updatedAt: row.updated_at } : null;
    const existing = rows.get(key);
    if (inherited && existing) { existing.reference ??= reference; continue; }
    rows.set(key, { key, name: nameOf(data), hint: "", data, current: null, reference, removed: true, sponsor: data.memoGroup === "sponsors" });
  }
  const references = [...state.tables.ledger, ...state.tables.sponsors].filter((r) => r.scope === "reference").sort((a, b) => (b.refYear ?? 0) - (a.refYear ?? 0));
  for (const reference of references) {
    const key = keyOf(reference); const existing = rows.get(key);
    if (existing) { existing.reference ??= reference; continue; }
    const previous = dataOf(reference);
    // 去年の額や日付を今年の値にしない。
    const data: RowData = { memoKey: key, what: previous.what || (reference.table === "sponsors" ? "協賛" : previous.counterpart) || "メモ" };
    if (reference.table === "sponsors" || previous.memoGroup === "sponsors") data.memoGroup = "sponsors";
    rows.set(key, { key, name: reference.table === "sponsors" ? String(previous.counterpart || "協賛") : nameOf(data), hint: "", data, current: null, reference, removed: false, sponsor: data.memoGroup === "sponsors" });
  }
  for (const template of MEMO_TEMPLATES[state.project.kind]) {
    const key = `template:${template.key}`;
    const existing = rows.get(key) ?? [...rows.values()].find((row) => !row.sponsor && normalizeKey(String(row.data.what ?? "")) === normalizeKey(template.name));
    if (existing) { existing.hint = template.hint; if (!existing.data.what && !existing.data.counterpart) existing.name = template.name; continue; }
    rows.set(key, { key, name: template.name, hint: template.hint, data: { memoKey: key, what: template.name }, current: null, reference: null, removed: false, sponsor: false });
  }
  const order = (row: MemoRow) => {
    const index = MEMO_TEMPLATES[state.project.kind].findIndex((template) => row.key === `template:${template.key}` || normalizeKey(String(row.data.what ?? "")) === normalizeKey(template.name));
    return index < 0 ? 1000 : index;
  };
  return [...rows.values()].sort((a, b) => order(a) - order(b));
}

// 古い入口も運営メモに案内する。予算と決算の入力は置かない。
memoAdmin.get("/ledger", async (c) => {
  const { ward } = c.var;
  const projects = await listProjects(c.env.DB, ward.wardId, { includeClosed: true });
  return c.html(<Layout title="運営メモ" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/")}>最初の画面へ</a><h1>運営メモ</h1><p class="lead">行事の段取りから、費用や来年のためのメモを開けます。</p>
    {projects.length ? <ul class="rows">{projects.map((project) => <li><a class="row-link" href={adminPath(ward, `/projects/${project.projectId}/map`)}><b>{project.title}の段取り</b></a></li>)}</ul> : <p>行事はまだありません。最初の画面から始められます。</p>}
  </Layout>);
});

function PreviousMemo({ row }: { row: MemoRow }) {
  if (!row.reference) return null;
  const data = dataOf(row.reference);
  return <div class="notice"><strong>{row.reference.refYear ? `${row.reference.refYear}年の記録` : "過去の記録"}</strong>
    <p>{data.counterpart}{typeof data.amount === "number" ? `　${yen(data.amount)}` : ""}{data.date ? `　${formatDateText(String(data.date))}` : ""}</p>
    {data.note ? <p>メモ: {data.note}</p> : null}{data.thanks ? <p>お礼の仕方: {data.thanks}</p> : null}
    <dl class="facts">{["contact", "requestedOn", "quantity", "estimate", "payment"].filter((key) => data[key] !== undefined).map((key) => <><dt>{TABLES.ledger.fields[key]?.label}</dt><dd>{displayFieldValue("ledger", key, data[key])}</dd></>)}</dl>
  </div>;
}

memoAdmin.get("/projects/:projectId/ledger/:rowId", async (c) => {
  const { ward } = c.var; const id = c.req.param("projectId"); const key = c.req.param("rowId");
  const state = await getProjectState(c.env.DB, ward.wardId, id);
  if (!state) return c.notFound();
  const rows = await getMemoRows(c.env.DB, ward.wardId, state);
  const row: MemoRow | undefined = findRow(rows, state, key) ?? (key === "new" || customKey(key) ? { key: key === "new" ? `custom:${newId()}` : key, name: "行を足す", hint: "", data: {}, current: null, reference: null, removed: false, sponsor: false } : undefined);
  if (!row || row.removed) return c.notFound();
  const back = adminPath(ward, rootPath(id)); const data = row.data;
  const empty = !data.counterpart && data.amount === undefined && !data.note;
  const adding = key === "new" || (customKey(key) && !row.current);
  const field = (name: string, label: string, type = "text") => <div class="field"><label for={name}>{label}</label><input id={name} name={name} type={type} inputmode={type === "number" ? "numeric" : undefined} min={type === "number" ? "0" : undefined} step={type === "number" ? "1" : undefined} maxlength={type === "text" ? 200 : undefined} value={data[name]} /></div>;
  const fields = row.sponsor ? <>{field("counterpart", "どこから")}{field("amount", "額（円）", "number")}{field("thanks", "お礼の仕方")}</> : <>{field("what", "何に")}{field("counterpart", "どこに")}{field("amount", "額（円）", "number")}{field("date", "日付", "date")}</>;
  const source = row.current ?? row.reference;
  const original = source?.source.kind === "original" ? source.source.ref : data.receiptOriginalId;
  return c.html(<Layout title={row.name} siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={back}>{state.project.title}の運営メモへ</a><h1>{row.name}</h1><p class="lead">{adding ? "来年の担当の方に残したいことを、行にできます。" : empty ? "書けることだけ書いてください。書かなくても進められます。" : "読み違いを直せます。分からない欄は空のままでかまいません。"}元の資料は変わりません。</p>
    {row.hint ? <p>よく残すこと: {row.hint}</p> : null}<PreviousMemo row={row} />
    {state.project.closedAt ? <Notice>この行事は閉じています。開き直すとメモを書けます。<p><a class="quiet" href={adminPath(ward, `/close/${id}`)}>行事を開き直す画面へ</a></p></Notice> : <>
      <form method="post" action={adminPath(ward, rowPath(id, row.key))}>
        {adding ? field("what", "何の行か") : !empty || row.sponsor ? fields : null}
        <div class="field"><label for="note">メモ</label><textarea id="note" name="note" rows={5} maxlength={2000}>{data.note ?? ""}</textarea></div>
        {!adding && !row.sponsor && empty ? <details class="fold"><summary>分かっていれば書く</summary><div>{fields}</div></details> : null}
        {!adding && !row.sponsor ? <details class="fold"><summary>来年のために書いておく</summary><div>{field("contact", "連絡先と、頼んだ人")}{field("requestedOn", "いつ頼んだか")}{field("quantity", "頼んだ内容の量")}{field("estimate", "見積りの額（円）", "number")}{field("payment", "払い方")}{field("thanks", "お礼の仕方")}</div></details> : null}
        <div class="action-bar"><button>保存する</button></div>
      </form>
      {key !== "new" ? <form method="post" action={adminPath(ward, `${rowPath(id, row.key)}/remove`)}><button class="secondary">この行事では使わない行にする</button></form> : null}
    </>}
    {original ? <p><a class="quiet" href={adminPath(ward, `/intake/originals/${encodeURIComponent(String(original))}?back=${encodeURIComponent(back)}`)}>元の資料を見る</a></p> : null}
    <p><a class="quiet" href={back}>運営メモに戻る</a></p>
  </Layout>);
});

/** 原本に触れず、同じ運営メモに保存する。消した行も戻せる。 */
async function writeMemo(db: D1Database, wardId: string, state: ProjectState, row: MemoRow, accountId: string, raw: RowData, removed: boolean): Promise<boolean> {
  if (state.project.closedAt) return false;
  const cleaned = cleanRowData("ledger", { ...raw, memoKey: row.key, ...(row.sponsor ? { memoGroup: "sponsors" } : {}) });
  if (!cleaned.ok) return false;
  const id = state.project.projectId; const now = nowIso(); const changeId = newId(); const nextVersion = state.project.stateVersion + 1;
  const match = rowMatchKey("ledger", cleaned.data);
  const old = await db.prepare("SELECT row_id FROM project_rows WHERE ward_id = ? AND project_id = ? AND table_key = 'ledger' AND scope = 'current' AND (match_key = ? OR row_id = ?) ORDER BY removed_at IS NULL DESC LIMIT 1")
    .bind(wardId, id, match, row.current?.table === "ledger" ? row.current.rowId : "").first<{ row_id: string }>();
  const source = row.current?.source;
  const payload = { kind: "row", table: "ledger", data: cleaned.data, before: row.data, removed };
  const payloadHash = await hashOf(payload);
  const guard = "EXISTS (SELECT 1 FROM project_changes WHERE ward_id = ? AND project_id = ? AND change_id = ?)";
  const statement = old
    ? db.prepare(`UPDATE project_rows SET data = ?, match_key = ?, person_fields = ?, change_id = ?, updated_at = ?, removed_at = ?, removed_by_account_id = ? WHERE ward_id = ? AND project_id = ? AND row_id = ? AND ${guard}`)
      .bind(stableStringify(cleaned.data), match, JSON.stringify(Object.keys(TABLES.ledger.fields)), changeId, now, removed ? now : null, removed ? accountId : null, wardId, id, old.row_id, wardId, id, changeId)
    : db.prepare(`INSERT INTO project_rows (row_id, ward_id, project_id, table_key, scope, match_key, data, person_fields, source_kind, source_ref, source_locator, source_year, confidence, change_id, created_at, updated_at, created_by_account_id, removed_at, removed_by_account_id)
        SELECT ?, ?, ?, 'ledger', 'current', ?, ?, ?, ?, ?, ?, ?, 'high', ?, ?, ?, ?, ?, ? WHERE ${guard}`)
      .bind(newId(), wardId, id, match, stableStringify(cleaned.data), JSON.stringify(Object.keys(TABLES.ledger.fields)), source?.kind ?? "person", source?.ref ?? `person:${accountId}`, source?.locator ?? null, source?.year ?? null, changeId, now, now, accountId, removed ? now : null, removed ? accountId : null, wardId, id, changeId);
  const result = await db.batch([
    db.prepare(`INSERT INTO project_changes (change_id, ward_id, project_id, kind, target, status, dedupe_key, payload_hash, payload, result, pack_version, source_kind, source_ref, confidence, state_version_after, created_at, created_by_account_id)
      SELECT ?, ?, ?, 'row', ?, 'applied', ?, ?, ?, ?, 'memo-edit@1', 'person', ?, 'high', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND state_version = ? AND closed_at IS NULL)`)
      .bind(changeId, wardId, id, `ledger:${nameOf(cleaned.data)}`, `memo:${changeId}`, payloadHash, stableStringify(payload), JSON.stringify({ status: "applied", changeId, staleDocuments: ["report"], questionIds: [] }), `person:${accountId}`, nextVersion, now, accountId, wardId, id, state.project.stateVersion),
    statement,
    db.prepare(`UPDATE projects SET state_version = ? WHERE ward_id = ? AND project_id = ? AND ${guard}`).bind(nextVersion, wardId, id, wardId, id, changeId),
    db.prepare(`UPDATE documents SET stale_since_version = COALESCE(stale_since_version, ?) WHERE ward_id = ? AND project_id = ? AND kind = 'report' AND ${guard}`).bind(nextVersion, wardId, id, wardId, id, changeId),
  ]);
  return result[0]?.meta.changes === 1 && result[1]?.meta.changes === 1;
}

export async function saveLedgerRow(db: D1Database, wardId: string, projectId: string, rowId: string, accountId: string, data: RowData): Promise<boolean> {
  const state = await getProjectState(db, wardId, projectId);
  if (!state) return false;
  const rows = await getMemoRows(db, wardId, state);
  const row = findRow(rows, state, rowId);
  return !!row && !row.removed && writeMemo(db, wardId, state, row, accountId, data, false);
}

memoAdmin.post("/projects/:projectId/ledger/:rowId", async (c) => {
  const { ward, account } = c.var; const id = c.req.param("projectId"); const key = c.req.param("rowId");
  const state = await getProjectState(c.env.DB, ward.wardId, id);
  if (!state) return c.notFound();
  const rows = await getMemoRows(c.env.DB, ward.wardId, state);
  const row = findRow(rows, state, key) ?? (customKey(key) ? { key, name: "メモ", hint: "", data: {}, current: null, reference: null, removed: false, sponsor: false } satisfies MemoRow : undefined);
  if (!row || row.removed) return c.notFound();
  const back = { href: adminPath(ward, rowPath(id, row.key)), label: "メモに戻る" };
  const form = await c.req.formData(); const data: RowData = { ...row.data };
  for (const name of ["what", "counterpart", "date", "note", "contact", "requestedOn", "quantity", "payment", "thanks"]) {
    if (!form.has(name)) continue;
    const value = String(form.get(name) ?? "").trim();
    if (value.length > (name === "note" ? 2000 : 200) || (name === "date" && value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value))) return adminResult(c, "書いた内容を保存できませんでした。", 400, back, "長い文は短くし、日付は日付の欄から選んで、もう一度保存してください。");
    delete data[name]; if (value) data[name] = value;
  }
  for (const name of ["amount", "estimate"]) {
    if (!form.has(name)) continue;
    if (!form.has(name)) continue;
    const value = String(form.get(name) ?? "").trim(); delete data[name];
    if (!value) continue;
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount < 0) return adminResult(c, "額を保存できませんでした。", 400, back, "額は0以上の整数で入れてください。分からなければ空のままで保存できます。");
    data[name] = amount;
  }
  if (!await writeMemo(c.env.DB, ward.wardId, state, row, account.accountId, data, false)) return adminResult(c, "メモを保存できませんでした。", 409, back, "行事が閉じているときは開き直せます。メモを開き、もう一度保存してください。");
  return c.redirect(`${adminPath(ward, rootPath(id))}?notice=saved&changed=${encodeURIComponent(row.key)}`, 303);
});

for (const operation of ["remove", "restore"] as const) memoAdmin.post(`/projects/:projectId/ledger/:rowId/${operation}`, async (c) => {
  const { ward, account } = c.var; const id = c.req.param("projectId"); const key = c.req.param("rowId");
  const state = await getProjectState(c.env.DB, ward.wardId, id);
  if (!state) return c.notFound();
  const row = findRow(await getMemoRows(c.env.DB, ward.wardId, state), state, key);
  if (!row) return c.notFound();
  if (!await writeMemo(c.env.DB, ward.wardId, state, row, account.accountId, row.data, operation === "remove")) return adminResult(c, "メモを変えられませんでした。", 409, { href: adminPath(ward, rootPath(id)), label: "運営メモに戻る" }, "行事が閉じているときは開き直せます。運営メモからもう一度操作できます。");
  return c.redirect(`${adminPath(ward, rootPath(id))}?notice=${operation === "remove" ? "removed" : "restored"}&changed=${encodeURIComponent(row.key)}`, 303);
});

memoAdmin.get("/projects/:projectId/ledger", async (c) => {
  const { ward } = c.var; const id = c.req.param("projectId");
  const state = await getProjectState(c.env.DB, ward.wardId, id);
  if (!state) return c.notFound();
  const rows = await getMemoRows(c.env.DB, ward.wardId, state);
  const active = rows.filter((row) => !row.removed);
  const root = adminPath(ward, rootPath(id));
  const changedRow = rows.find((row) => row.key === c.req.query("changed"));
  const notice = c.req.query("notice");
  const result = notice === "saved" ? "メモを残しました" : notice === "removed" ? "この行事では使わない行にしました" : notice === "restored" ? "行を戻しました" : "";
  const renderRows = (entries: MemoRow[]) => <ul class="rows">{entries.map((row) => <li><a class="row-link" href={adminPath(ward, rowPath(id, row.key))}>
    <b>{row.name}{row.data.counterpart && row.data.what ? `　${row.data.counterpart}` : ""}</b>
    <span>{typeof row.data.amount === "number" ? yen(row.data.amount) : row.data.counterpart || row.data.note ? "額の情報なし" : "情報なし"}{row.data.date ? `　${formatDateText(String(row.data.date))}` : ""}</span>
    {row.data.note ? <span>メモ: {row.data.note}</span> : row.hint ? <span>{row.hint}</span> : null}
    {row.reference ? <span>{row.reference.refYear ? `${row.reference.refYear}年` : "過去"}の額: {typeof row.reference.data.amount === "number" ? yen(row.reference.data.amount) : "情報なし"}{row.reference.data.note ? `　メモ: ${row.reference.data.note}` : ""}</span> : null}
  </a></li>)}</ul>;
  return c.html(<Layout title="運営メモ" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, `/projects/${id}/map`)}>{state.project.title}の段取りへ</a><h1>{state.project.title}の運営メモ</h1>
    <p class="lead">よく要るものを並べました。情報なしの行は、そのままでかまいません。来年の担当の方が見ます。</p>
    <Notice><strong>参考の記録です</strong><p>会計の帳簿や決算の代わりにはなりません。証跡として使わず、税務と法務の判断はしません。領収書の紙は、これまでどおり会計の方で保管してください。</p></Notice>
    {result ? <><div class="notice done" role="status"><strong>{result}</strong><p>元の資料は変わりません。ほかの行は、そのままでかまいません。</p></div><section class="next"><strong>次は</strong><p>思い出したときに書き直せます。</p><a class="button" href={notice === "removed" ? `${root}#unused` : changedRow ? adminPath(ward, rowPath(id, changedRow.key)) : root}>{notice === "removed" ? "使わない行を戻す" : "メモを開く"}</a></section><p><a class="quiet" href={adminPath(ward, `/projects/${id}/map`)}>段取りに戻る</a></p></> : null}
    {!state.project.closedAt ? <div class="action-links"><a class="button" href={adminPath(ward, `/intake?project=${encodeURIComponent(id)}#send-form`)}>写真を送る</a></div> : <Notice>この行事は閉じています。記録を読めます。<p><a class="quiet" href={adminPath(ward, `/close/${id}`)}>行事を開き直す画面へ</a></p></Notice>}
    <h2>よく要るもの</h2>{renderRows(active.filter((row) => !row.sponsor))}
    {!state.project.closedAt ? <p><a class="button secondary" href={adminPath(ward, `${rootPath(id)}/new`)}>行を足す</a></p> : null}
    {active.some((row) => row.sponsor) ? <><h2>協賛</h2>{renderRows(active.filter((row) => row.sponsor))}</> : null}
    {rows.some((row) => row.removed) ? <details class="fold" id="unused" open={notice === "removed"}><summary>この行事では使わない行</summary><div>{rows.filter((row) => row.removed).map((row) => <div><p><b>{row.name}</b></p>{!state.project.closedAt ? <form method="post" action={adminPath(ward, `${rowPath(id, row.key)}/restore`)}><button class="secondary">行を戻す</button></form> : null}</div>)}</div></details> : null}
  </Layout>);
});
