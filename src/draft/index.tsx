import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { adminPath } from "../core/auth";
import { Layout, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { startTask } from "../ai/api";
import { getProjectState, getProjectSummary } from "../project/api";
import { getEditableDocument, saveDocument } from "../project/actions";
import { DOCUMENT_KINDS, DOCUMENT_KIND_LABEL, ITEM_LABEL, ITEMS_BY_KIND, SCOPES, SCOPE_LABEL, type DocumentKind, type Scope } from "../project/model";
import { getDraftPack, listDraftPacks } from "./packs";
import type { DraftBody } from "./packs/types";
import { getDutyDraftHelpers } from "../answers/api";

const admin = new Hono<AdminEnv>();
const isKind = (value: string): value is DocumentKind => (DOCUMENT_KINDS as readonly string[]).includes(value);
function parseBody(raw: string): DraftBody {
  try {
    const data = JSON.parse(raw) as Partial<DraftBody>;
    if (typeof data.text !== "string" || !Array.isArray(data.items)) return { text: "", items: [] };
    return { text: data.text, items: data.items.filter((i): i is DraftBody["items"][number] => typeof i === "object" && i !== null && typeof i.key === "string" && typeof i.content === "string") };
  } catch { return { text: "", items: [] }; }
}

admin.get("/projects/:projectId/draft", async (c) => {
  const { ward } = c.var; const id = c.req.param("projectId"); const project = await getProjectSummary(c.env.DB, ward.wardId, id);
  if (!project) return c.notFound();
  return c.html(<Layout title={`案: ${project.title}`} siteName={ward.name} noindex headerRight={<a href={adminPath(ward, `/projects/${id}`)}>プロジェクトへ</a>}>
    <h1>{project.title} の案</h1><p>文書を選び、必要ならAIに案を起こさせます。AIが止まっている時も、ここで書いて保存できます。</p>
    {c.req.query("notice") === "saved" ? <Notice>保存しました。今年の中身にも反映しました。</Notice> : null}
    {c.req.query("notice") === "started" ? <Notice>案を起こす依頼を受けました。画面を閉じても処理は続きます。</Notice> : null}
    {c.req.query("error") ? <Notice error>{c.req.query("error")}</Notice> : null}
    {listDraftPacks().map((pack) => <section class="panel"><h2><a href={adminPath(ward, `/projects/${id}/draft/${pack.kind}`)}>{pack.title}</a></h2><p>範囲: {SCOPE_LABEL[pack.scope]}</p>
      <form method="post" action={adminPath(ward, `/projects/${id}/draft/${pack.kind}/start`)}><button class="secondary">AIに案を起こしてもらう</button></form>
    </section>)}
    <p><a href={adminPath(ward, `/publish/${id}`)}>配る</a></p>
  </Layout>);
});

admin.get("/projects/:projectId/draft/:kind", async (c) => {
  const { ward } = c.var; const id = c.req.param("projectId"); const kindRaw = c.req.param("kind");
  if (!isKind(kindRaw)) return c.notFound();
  const [project, state, document] = await Promise.all([getProjectSummary(c.env.DB, ward.wardId, id), getProjectState(c.env.DB, ward.wardId, id), getEditableDocument(c.env.DB, ward.wardId, id, kindRaw)]);
  if (!project || !state) return c.notFound();
  const pack = getDraftPack(kindRaw); const body = document ? parseBody(document.body) : { text: "", items: state.items.map((item) => ({ key: item.key, content: item.current?.content ?? "" })) };
  const scope = document?.scope ?? pack.scope; const baseVersion = document?.stateVersion ?? project.stateVersion;
  const versions = document ? await c.env.DB.prepare("SELECT version_no, body, created_at, origin FROM document_versions WHERE ward_id = ? AND project_id = ? AND document_id = ? ORDER BY version_no DESC LIMIT 8").bind(ward.wardId, id, document.documentId).all<{ version_no: number; body: string; created_at: string; origin: string }>() : { results: [] };
  return c.html(<Layout title={`${pack.title}を直す`} siteName={ward.name} noindex headerRight={<a href={adminPath(ward, `/projects/${id}/draft`)}>案の一覧</a>}>
    <h1>{pack.title}を直す</h1>
    {document?.stale ? <Notice>新しい物が入りました。<a href={adminPath(ward, `/projects/${id}/draft/${kindRaw}`)}>案を直す</a> / このまま</Notice> : null}
    <form method="post" action={adminPath(ward, `/projects/${id}/draft/${kindRaw}/save`)}>
      <input type="hidden" name="based_on" value={baseVersion} />
      <label for="title">文書の題</label><input id="title" name="title" value={document?.title ?? pack.title} maxlength={100} required />
      <label for="scope">見られる範囲</label><select id="scope" name="scope">{SCOPES.map((v) => <option value={v} selected={v === scope}>{SCOPE_LABEL[v]}</option>)}</select>
      <label for="text">文</label><textarea id="text" name="text" rows={12} maxlength={20000} style="width:100%;font:inherit;padding:.65rem">{body.text}</textarea>
      <h2>今年の中身</h2>
      {ITEMS_BY_KIND[project.kind].map((key) => { const value = body.items.find((x) => x.key === key)?.content ?? ""; const item = state.items.find((x) => x.key === key); return <div>
        <label for={`item-${key}`}>{ITEM_LABEL[key]}</label><input id={`item-${key}`} name={`item_${key}`} value={value} maxlength={2000} />
        {item?.references.map((ref) => <p class="muted">参考（{ref.refYear ?? "年不明"}年）: {ref.content}</p>)}
      </div>; })}
      <p><button type="submit">直した中身を保存</button></p>
    </form>
    {document ? <h2>前の案</h2> : null}
    {versions.results.map((v) => { const old = parseBody(v.body); return <details><summary>{v.version_no} / {v.origin === "ai" ? "AIの案" : "役員が直した案"}</summary><pre style="white-space:pre-wrap">{old.text}</pre></details>; })}
    <form method="post" action={adminPath(ward, `/projects/${id}/draft/${kindRaw}/start`)}><button class="secondary">AIに案を起こしてもらう</button></form>
    <p><a href={adminPath(ward, `/publish/${id}`)}>配る</a></p>
  </Layout>);
});

admin.post("/projects/:projectId/draft/:kind/save", async (c) => {
  const { ward, account } = c.var; const id = c.req.param("projectId"); const kindRaw = c.req.param("kind");
  if (!isKind(kindRaw)) return c.notFound();
  const form = await c.req.formData(); const state = await getProjectState(c.env.DB, ward.wardId, id);
  if (!state) return c.notFound();
  const scopeRaw = String(form.get("scope")); if (!(SCOPES as readonly string[]).includes(scopeRaw)) return c.notFound();
  const body: DraftBody = { text: String(form.get("text") ?? ""), items: ITEMS_BY_KIND[state.project.kind].map((key) => ({ key, content: String(form.get(`item_${key}`) ?? "").trim() })).filter((i) => i.content !== "") };
  const ok = await saveDocument(c.env.DB, ward.wardId, id, account.accountId, { kind: kindRaw, title: String(form.get("title") ?? ""), scope: scopeRaw as Scope, body: JSON.stringify(body), basedOn: Number(form.get("based_on")) });
  return c.redirect(`${adminPath(ward, `/projects/${id}/draft/${kindRaw}`)}?${ok ? "notice=saved" : "error=" + encodeURIComponent("保存できませんでした。入力を確かめてください")}`, 303);
});

admin.post("/projects/:projectId/draft/:kind/start", async (c) => {
  const { ward, account } = c.var; const id = c.req.param("projectId"); const kindRaw = c.req.param("kind");
  if (!isKind(kindRaw)) return c.notFound();
  const project = await getProjectSummary(c.env.DB, ward.wardId, id);
  if (!project || project.closedAt) return c.notFound();
  const pack = getDraftPack(kindRaw);
  try {
    const helpers = pack.kind === "duty_roster" ? await getDutyDraftHelpers(c.env.DB, ward.wardId, id) : [];
    const helperInstruction = helpers.length
      ? `\n回答から集めた手伝いの希望（この一覧を当番表の案に含めてください）: ${JSON.stringify(helpers)}`
      : "\n回答に手伝いの希望はまだありません。";
    await startTask(c.env, c.executionCtx, { wardId: ward.wardId, projectId: id, task: "draft", instruction: `${pack.instruction}\n対象の文書: ${pack.kind}。範囲: ${pack.scope}。data に pack_version を ${pack.version}、based_on_state_version を引いた状態の番号として含めてください。${pack.kind === "duty_roster" ? helperInstruction : ""}`, accountId: account.accountId });
    return c.redirect(`${adminPath(ward, `/projects/${id}/draft/${kindRaw}`)}?notice=started`, 303);
  } catch { return c.redirect(`${adminPath(ward, `/projects/${id}/draft/${kindRaw}`)}?error=${encodeURIComponent("AIに頼めませんでした。ここで手入力して保存できます")}`, 303); }
});

export { admin as draftAdmin };
export const draft: Bundle = { admin };
