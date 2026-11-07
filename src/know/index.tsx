import { Hono } from "hono";
import { AdminPage } from "../core/admin-ui";
import { adminPath } from "../core/auth";
import type { Bundle } from "../core/bundle";
import { cleanName } from "../core/password";
import { formatJst } from "../core/time";
import { Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { jobSummaries } from "../intake/store";
import { getProjectState, listOpenProjects } from "../project/api";
import { YEAR_BASE, YearLegend, YearMap, addYearItem, removeYearBase, wardYear } from "./year";
import { senderText } from "../line/sender";
import {
  KNOW_BASE, KNOW_LIMITS, WARD_FILES_PAGE, addKnowItem, answerKnowProposal, getKnowItem, knowLinksByOriginal, linkKnowSource, listKnowItems, listKnowSources, listWardFiles,
  markKnowReviewed, renameKnowItem, saveKnowItem, setKnowRemoved, unlinkKnowSource, type KnowItem, type WardFile,
} from "./store";

const admin = new Hono<AdminEnv>();

const STATE_CLASS = { empty: "example", fact: "fact", old: "old", checking: "checking" } as const;
const NOTICE: Record<string, string> = {
  saved: "保存しました。", answered: "答えを残しました。", reviewed: "見直した日を残しました。", renamed: "名前を変えました。", linked: "資料をつなげました。", unlinked: "資料のつながりを外しました。",
};

const knownItem = async (db: D1Database, wardId: string, id: string) => {
  const item = await getKnowItem(db, wardId, id);
  return item && (item.added || KNOW_BASE.some((base) => base.key === id)) ? item : null;
};
const firstLine = (text: string) => text.split("\n")[0]!.trim();
const isImage = (mediaType: string) => mediaType.startsWith("image/");

function Row({ ward, item }: { ward: AdminEnv["Variables"]["ward"]; item: KnowItem }) {
  const value = firstLine(item.body) || item.auto;
  return <li><a class={`year-row ${STATE_CLASS[item.state]}`} href={adminPath(ward, `/know/${encodeURIComponent(item.id)}`)}>
    <b>{item.title}</b>{value ? <span class="value">{value}</span> : null}{item.note ? <span class="note">{item.note}</span> : null}
  </a></li>;
}

admin.get("/know", async (c) => {
  const { ward, account } = c.var;
  const { items, removed } = await listKnowItems(c.env.DB, ward.wardId);
  const old = items.filter((item) => item.state === "old");
  const filled = items.filter((item) => item.state !== "empty").length;
  return c.html(<AdminPage ward={ward} account={account} title="自治会の基本情報" back={{ href: adminPath(ward, "/"), label: "最初の画面へ" }}>
    <h1>自治会の基本情報</h1>
    <p class="lead">自治会を動かすのに知っておきたいことの一覧です。写真やファイルを送ると、AIが読み取って入れます。違うところは直せます。書かれていなくても、仕事は止まりません。</p>
    {c.req.query("n") === "added" ? <Notice>項目を足しました。</Notice> : c.req.query("n") === "removed" ? <Notice>項目を外しました。下の「外した項目」から戻せます。</Notice> : c.req.query("n") === "restored" ? <Notice>項目を戻しました。</Notice> : null}
    <p>{items.length}項目のうち{filled}項目が書かれています。{old.length ? `${old.length}項目は見直す時期です。` : ""}</p>
    <div class="state-legend"><strong class="legend-title">色の見方</strong><ul>
      <li><span class="state example">まだ書かれていません</span>資料を送るか、押して書くと入ります</li>
      <li><span class="state checking">AIからの質問があります</span>新しく届いた資料に、違う内容が書かれていました</li>
      <li><span class="state fact">この自治会の内容</span>資料から読み取ったか、役員が書いた内容です</li>
      <li><span class="state old">見直す時期です</span>書いてから時間がたちました</li>
    </ul></div>
    <ul class="year-list">{items.map((item) => <Row ward={ward} item={item} />)}</ul>
    <details class="fold"><summary>項目を足す</summary><div><form method="post" action={adminPath(ward, "/know")}>
      <div class="field"><label for="know-title">項目の名前</label><input id="know-title" name="title" type="text" required maxlength={KNOW_LIMITS.title} /><p class="help-text">この自治会で知っておきたいことを足せます。</p></div>
      <button class="secondary">この項目を足す</button>
    </form></div></details>
    {removed.length ? <details class="fold"><summary>外した項目（{removed.length}つ）</summary><div>{removed.map((item) => <form method="post" action={adminPath(ward, `/know/${encodeURIComponent(item.id)}/restore`)}><p>{item.title}</p><button class="secondary">この項目を戻す</button></form>)}</div></details> : null}
    <p class="link-line"><a href={adminPath(ward, "/files")}>自治会の資料を見る</a></p>
  </AdminPage>);
});

admin.post("/know", async (c) => {
  const { ward } = c.var;
  const title = cleanName(String((await c.req.formData()).get("title") ?? ""));
  if (!title || title.length > KNOW_LIMITS.title) return c.redirect(adminPath(ward, "/know"), 303);
  const id = await addKnowItem(c.env.DB, ward.wardId, title);
  return c.redirect(adminPath(ward, `/know/${encodeURIComponent(id)}`), 303);
});

admin.get("/know/:itemId", async (c) => {
  const { ward, account } = c.var;
  const id = c.req.param("itemId");
  const item = await knownItem(c.env.DB, ward.wardId, id);
  if (!item) return c.notFound();
  const [sources, recent, summaries] = await Promise.all([listKnowSources(c.env.DB, ward.wardId, id), listWardFiles(c.env.DB, ward.wardId, 0), jobSummaries(c.env.DB, ward.wardId)]);
  const linked = new Set(sources.map((source) => source.original_id));
  const base = adminPath(ward, `/know/${encodeURIComponent(id)}`);
  const candidates = recent.files.filter((file) => !linked.has(file.original_id)).slice(0, 12);
  const n = c.req.query("n");
  return c.html(<AdminPage ward={ward} account={account} title={item.title} back={{ href: adminPath(ward, "/know"), label: "自治会の基本情報へ" }}>
    {n && NOTICE[n] ? <Notice>{NOTICE[n]}</Notice> : null}
    <h1>{item.title}</h1>
    {item.hint ? <p class="lead">例: {item.hint}</p> : null}
    {item.keepOut ? <div class="notice" role="status"><strong>このサービスでは{item.keepOut}を預かりません</strong><p>だれが持っているかだけ書いてください。</p></div> : null}
    {item.note && item.state === "old" ? <p><span class="state old">見直す時期です</span> {item.note}</p> : null}
    {item.auto ? <p>{item.auto}</p> : null}
    {item.proposed ? <section class="panel"><p><span class="state checking">AIからの質問があります</span></p><p>新しく届いた資料には、こう書かれていました。この内容にしますか？</p><p class="preserve-lines"><b>{item.proposed}</b></p>
      {item.proposedOriginalId ? <p class="link-line"><a href={adminPath(ward, `/intake/originals/${item.proposedOriginalId}`)}>元の資料を見る</a></p> : null}
      <form method="post" action={`${base}/proposal`}><div class="action-links"><button class="secondary" name="use" value="yes">この内容にする</button><button class="secondary" name="use" value="no">今のままでよい</button></div></form></section> : null}
    <form method="post" action={base}>
      <div class="field"><label for="know-body">この自治会の内容</label><textarea id="know-body" name="body" rows={6} maxlength={KNOW_LIMITS.body}>{item.body}</textarea></div>
      <div class="action-links"><button>保存する</button></div>
    </form>
    {item.state === "old" ? <form method="post" action={`${base}/reviewed`}><p class="muted">内容が今も合っていれば押してください。</p><button class="secondary">今の内容のままでよい</button></form> : null}
    <h2>元の資料</h2>
    {sources.length ? <ul class="rows">{sources.map((source) => <li class="panel">
      {isImage(source.media_type) ? <a href={adminPath(ward, `/intake/originals/${source.original_id}`)}><img class="photo" src={`${adminPath(ward, `/intake/originals/${source.original_id}`)}?raw=1`} alt={source.filename || "資料の写真"} loading="lazy" /></a> : <p class="link-line"><a href={adminPath(ward, `/intake/originals/${source.original_id}`)}>{source.filename || "資料"}を開く</a></p>}
      <form method="post" action={`${base}/links/${source.link_id}/remove`}><button class="quiet">つながりを外す</button></form>
    </li>)}</ul> : <p>つながっている資料はありません。</p>}
    {candidates.length ? <details class="fold"><summary>自治会の資料からつなげる</summary><div><ul class="rows">{candidates.map((file) => <li>
      <form method="post" action={`${base}/links`}><input type="hidden" name="originalId" value={file.original_id} />
        <p><b>{firstLine(summaries.get(file.job_id) ?? "").slice(0, 36) || file.filename || "届いた資料"}</b></p>
        <p class="muted">{formatJst(file.received_at)}</p>
        <button class="secondary">この資料をつなげる</button></form></li>)}</ul></div></details> : null}
    <p class="link-line"><a href={adminPath(ward, "/intake")}>写真やファイルを送る</a></p>
    <details class="fold"><summary>名前を変える</summary><div><form method="post" action={`${base}/title`}>
      <div class="field"><label for="know-rename">項目の名前</label><input id="know-rename" name="title" type="text" value={item.title} required maxlength={KNOW_LIMITS.title} /></div>
      <button class="secondary">名前を保存する</button></form></div></details>
    <details class="fold"><summary>この自治会にない項目として外す</summary><div><p>外しても、書いた内容は残ります。一覧の「外した項目」から戻せます。</p>
      <form method="post" action={`${base}/remove`}><button class="secondary">外す</button></form></div></details>
  </AdminPage>);
});

admin.post("/know/:itemId", async (c) => {
  const { ward } = c.var; const id = c.req.param("itemId");
  if (!await knownItem(c.env.DB, ward.wardId, id)) return c.notFound();
  const body = String((await c.req.formData()).get("body") ?? "").trim().slice(0, KNOW_LIMITS.body);
  await saveKnowItem(c.env.DB, ward.wardId, id, { body });
  return c.redirect(`${adminPath(ward, `/know/${encodeURIComponent(id)}`)}?n=saved`, 303);
});

admin.post("/know/:itemId/proposal", async (c) => {
  const { ward } = c.var; const id = c.req.param("itemId");
  if (!await knownItem(c.env.DB, ward.wardId, id)) return c.notFound();
  await answerKnowProposal(c.env.DB, ward.wardId, id, (await c.req.formData()).get("use") === "yes");
  return c.redirect(`${adminPath(ward, `/know/${encodeURIComponent(id)}`)}?n=answered`, 303);
});

admin.post("/know/:itemId/title", async (c) => {
  const { ward } = c.var; const id = c.req.param("itemId");
  if (!await knownItem(c.env.DB, ward.wardId, id)) return c.notFound();
  const title = cleanName(String((await c.req.formData()).get("title") ?? ""));
  if (title && title.length <= KNOW_LIMITS.title) await renameKnowItem(c.env.DB, ward.wardId, id, title);
  return c.redirect(`${adminPath(ward, `/know/${encodeURIComponent(id)}`)}?n=renamed`, 303);
});

admin.post("/know/:itemId/reviewed", async (c) => {
  const { ward } = c.var; const id = c.req.param("itemId");
  if (!await knownItem(c.env.DB, ward.wardId, id)) return c.notFound();
  await markKnowReviewed(c.env.DB, ward.wardId, id);
  return c.redirect(`${adminPath(ward, `/know/${encodeURIComponent(id)}`)}?n=reviewed`, 303);
});

for (const [operation, removed] of [["remove", true], ["restore", false]] as const) admin.post(`/know/:itemId/${operation}`, async (c) => {
  const { ward } = c.var; const id = c.req.param("itemId");
  if (!await knownItem(c.env.DB, ward.wardId, id)) return c.notFound();
  await setKnowRemoved(c.env.DB, ward.wardId, id, removed);
  return c.redirect(`${adminPath(ward, "/know")}?n=${removed ? "removed" : "restored"}`, 303);
});

admin.post("/know/:itemId/links", async (c) => {
  const { ward } = c.var; const id = c.req.param("itemId");
  if (!await knownItem(c.env.DB, ward.wardId, id)) return c.notFound();
  const ok = await linkKnowSource(c.env.DB, ward.wardId, id, String((await c.req.formData()).get("originalId") ?? ""));
  if (!ok) return c.notFound();
  return c.redirect(`${adminPath(ward, `/know/${encodeURIComponent(id)}`)}?n=linked`, 303);
});

admin.post("/know/:itemId/links/:linkId/remove", async (c) => {
  const { ward } = c.var; const id = c.req.param("itemId");
  await unlinkKnowSource(c.env.DB, ward.wardId, id, c.req.param("linkId"));
  return c.redirect(`${adminPath(ward, `/know/${encodeURIComponent(id)}`)}?n=unlinked`, 303);
});

const fromWhom = (file: WardFile) => file.via === "line_direct" || file.via === "line_group" ? `送った人: ${senderText(file.sender, file.via === "line_group" ? "LINEグループ" : "LINE個別")}`
  : file.sender ? `送った人: ${senderText(file.sender)}` : file.via === "admin" ? "この画面から送りました" : file.via === "space" ? "実行委員と班長のページから届きました" : "自治会のLINEに届きました";

admin.get("/files", async (c) => {
  const { ward, account } = c.var;
  const page = Math.max(0, Number(c.req.query("page") ?? 0) || 0);
  const [{ files, more }, summaries, links, { items, removed }] = await Promise.all([listWardFiles(c.env.DB, ward.wardId, page), jobSummaries(c.env.DB, ward.wardId), knowLinksByOriginal(c.env.DB, ward.wardId), listKnowItems(c.env.DB, ward.wardId)]);
  const titles = new Map([...items, ...removed].map((item) => [item.id, item.title]));
  return c.html(<AdminPage ward={ward} account={account} title="自治会の資料" back={{ href: adminPath(ward, "/"), label: "最初の画面へ" }}>
    <h1>自治会の資料</h1>
    <p class="lead">届いた写真やファイルは、全部ここに入ります。分けなくてもかまいません。押すと大きく見られ、どれの資料にするかや、自治会の基本情報につなげるかを決められます。決めなくても、ここに残ります。</p>
    <div class="action-links"><a class="button" href={adminPath(ward, "/intake")}>写真やファイルを送る</a></div>
    {files.length ? <ul class="photo-grid">{files.map((file) => {
      // 押した先で、どれの資料にするかを決められるようにする。元の資料の画面は見るだけで、決める所が無かった。
      const original = adminPath(ward, `/intake/originals/${file.original_id}`);
      const href = file.item_id ? adminPath(ward, `/inbox/${file.item_id}/pick`) : file.via === "admin" ? adminPath(ward, `/inbox/city/${file.job_id}/pick`) : original;
      const title = firstLine(summaries.get(file.job_id) ?? "").slice(0, 36) || file.filename || "届いた資料";
      const places = [file.project_title, ...(links.get(file.original_id) ?? []).map((id) => titles.get(id))].filter(Boolean);
      return <li><a href={href}>{isImage(file.media_type) ? <img class="photo" src={`${original}?raw=1`} alt={title} loading="lazy" /> : <span class="photo-none">{file.filename || "届いた文"}</span>}
        <b>{title}</b><span>{places.length ? `${places.join("、")}の資料にしています` : "まだどれの資料にもしていません"}</span><span>{`${formatJst(file.received_at)}に届きました`}</span><span>{fromWhom(file)}</span></a></li>;
    })}</ul> : <div class="notice" role="status"><strong>まだ資料はありません</strong><p>紙の写真、Word、PDFを送ると、ここに入ります。</p></div>}
    {more || page ? <div class="action-links">{page ? <a class="button secondary" href={`${adminPath(ward, "/files")}?page=${page - 1}`}>前の{WARD_FILES_PAGE}件を見る</a> : null}{more ? <a class="button secondary" href={`${adminPath(ward, "/files")}?page=${page + 1}`}>次の{WARD_FILES_PAGE}件を見る</a> : null}</div> : null}
  </AdminPage>);
});

const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

admin.get("/year", async (c) => {
  const { ward, account } = c.var;
  const projects = await listOpenProjects(c.env.DB, ward.wardId);
  const states = await Promise.all(projects.map((project) => getProjectState(c.env.DB, ward.wardId, project.projectId)));
  const year = await wardYear(c.env.DB, ward, projects, states, today());
  const removed = await c.env.DB.prepare("SELECT item_id, title, added FROM ward_year_items WHERE ward_id = ? AND removed_at IS NOT NULL ORDER BY created_at").bind(ward.wardId).all<{ item_id: string; title: string; added: number }>();
  const taken = removed.results.map((row) => ({ key: row.item_id, title: row.added ? row.title : YEAR_BASE.find((base) => base.key === row.item_id)?.title ?? "" })).filter((row) => row.title);
  return c.html(<AdminPage ward={ward} account={account} title="この自治会の一年" back={{ href: adminPath(ward, "/"), label: "最初の画面へ" }}>
    <h1>この自治会の一年</h1>
    <p class="lead">一般の自治会の一年を仮に置いています。準備中のものや届いた資料で、この自治会の内容に変わっていきます。予定を押すと開きます。</p>
    <YearLegend /><YearMap rows={year.rows} today={year.today} />
    <details class="fold"><summary>予定を足す</summary><div><form method="post" action={adminPath(ward, "/year")}>
      <div class="field"><label for="year-title">名前</label><input id="year-title" name="title" type="text" required maxlength={KNOW_LIMITS.title} /></div>
      <div class="field"><label for="year-month">月</label><select id="year-month" name="month">{[4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3].map((month) => <option value={String(month)}>{month}月</option>)}</select></div>
      <button class="secondary">この予定を足す</button>
    </form></div></details>
    {taken.length ? <details class="fold"><summary>外した予定（{taken.length}つ）</summary><div>{taken.map((base) => <form method="post" action={adminPath(ward, `/year/${base.key}/restore`)}><p>{base.title}</p><button class="secondary">この予定を戻す</button></form>)}</div></details> : null}
  </AdminPage>);
});

admin.post("/year", async (c) => {
  const { ward } = c.var; const form = await c.req.formData();
  const title = cleanName(String(form.get("title") ?? "")); const month = Number(form.get("month"));
  if (title && title.length <= KNOW_LIMITS.title && Number.isInteger(month) && month >= 1 && month <= 12) await addYearItem(c.env.DB, ward.wardId, { title, month, dateText: "", originalId: null });
  return c.redirect(adminPath(ward, "/year"), 303);
});

admin.get("/year/:key", async (c) => {
  const { ward, account } = c.var;
  const added = await c.env.DB.prepare("SELECT item_id, title, month, date_text, source_original_id, removed_at FROM ward_year_items WHERE ward_id = ? AND item_id = ? AND added = 1")
    .bind(ward.wardId, c.req.param("key")).first<{ item_id: string; title: string; month: number | null; date_text: string; source_original_id: string | null; removed_at: string | null }>();
  if (added) return c.html(<AdminPage ward={ward} account={account} title={added.title} back={{ href: adminPath(ward, "/year"), label: "この自治会の一年へ" }}>
    <h1>{added.title}</h1>
    <p class="lead">{added.month ? `${added.month}月` : ""}{added.date_text ? `　${added.date_text}` : ""}</p>
    {added.source_original_id ? <p class="link-line"><a href={adminPath(ward, `/intake/originals/${added.source_original_id}`)}>読み取った元の資料を見る</a></p> : null}
    <div class="action-links"><a class="button secondary" href={`${adminPath(ward, "/projects")}?title=${encodeURIComponent(added.title)}`}>今年の{added.title}の準備を始める</a></div>
    {added.removed_at ? <form method="post" action={adminPath(ward, `/year/${added.item_id}/restore`)}><button class="secondary">一年に戻す</button></form>
      : <details class="fold"><summary>この予定を外す</summary><div><p>違う予定や、この自治会にない予定は外せます。外しても、一年の画面の「外した予定」から戻せます。</p><form method="post" action={adminPath(ward, `/year/${added.item_id}/remove`)}><button class="secondary">外す</button></form></div></details>}
  </AdminPage>);
  const base = YEAR_BASE.find((entry) => entry.key === c.req.param("key"));
  if (!base) return c.notFound();
  return c.html(<AdminPage ward={ward} account={account} title={base.title} back={{ href: adminPath(ward, "/year"), label: "この自治会の一年へ" }}>
    <h1>{base.title}</h1>
    <p class="lead">一般の自治会の例を仮に置いています。この自治会のことはまだ書かれていません。</p>
    <div class="action-links"><a class="button" href={adminPath(ward, "/intake")}>この予定の写真やファイルを送る</a><a class="button secondary" href={`${adminPath(ward, "/projects")}?${base.kind ? `kind=${base.kind}&` : ""}title=${encodeURIComponent(base.title)}`}>今年の{base.title}の準備を始める</a></div>
    <details class="fold"><summary>この自治会にないので外す</summary><div><p>外しても、一年の画面の「外した予定」から戻せます。</p><form method="post" action={adminPath(ward, `/year/${base.key}/remove`)}><button class="secondary">外す</button></form></div></details>
  </AdminPage>);
});

for (const [operation, removed] of [["remove", true], ["restore", false]] as const) admin.post(`/year/:key/${operation}`, async (c) => {
  const { ward } = c.var; const key = c.req.param("key");
  const added = await c.env.DB.prepare("SELECT 1 AS ok FROM ward_year_items WHERE ward_id = ? AND item_id = ? AND added = 1").bind(ward.wardId, key).first();
  if (!added && !YEAR_BASE.some((entry) => entry.key === key)) return c.notFound();
  await removeYearBase(c.env.DB, ward.wardId, key, removed);
  return c.redirect(adminPath(ward, "/year"), 303);
});

export const know: Bundle = { admin };
