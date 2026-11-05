import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { adminPath } from "../core/auth";
import { Hint, Layout, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { startTask } from "../ai/api";
import { getProjectState, getProjectSummary } from "../project/api";
import { getEditableDocument, saveDocument } from "../project/actions";
import { DOCUMENT_KINDS, DOCUMENT_KIND_LABEL, ITEM_LABEL, ITEMS_BY_KIND, SCOPES, SCOPE_LABEL, type DocumentKind, type Scope } from "../project/model";
import { getDraftPack, listDraftPacks } from "./packs";
import type { DraftBody } from "./packs/types";
import { getDutyDraftHelpers } from "../answers/api";
import { getPublicContact, getTemplates } from "../settings/store";
import { renderTemplate } from "../settings/keys";
import { saveDutyRow } from "../project/actions";

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
  return c.html(<Layout title={`案: ${project.title}`} siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")} headerRight={<a href={adminPath(ward, `/projects/${id}`)}>プロジェクトへ</a>}>
    <h1>{project.title} の案 <Hint text="作りたい文書を選んでください。今ある資料から AI に案を頼むか、自分で書き始められます。" /></h1><p>文書を選び、必要ならAIに案を起こさせます。AIが止まっている時も、ここで書いて保存できます。</p>
    {c.req.query("notice") === "saved" ? <Notice>保存しました。今年の中身にも反映しました。</Notice> : null}
    {c.req.query("notice") === "started" ? <Notice>案を起こす依頼を受けました。画面を閉じても処理は続きます。</Notice> : null}
    {c.req.query("notice") === "restored" ? <Notice>前の案を戻して、新しい案として保存しました。</Notice> : null}
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
  const task = await c.env.DB.prepare(`SELECT status FROM jobs WHERE ward_id = ? AND project_id = ? AND task = 'draft'
    AND instruction LIKE ? ORDER BY created_at DESC LIMIT 1`).bind(ward.wardId, id, `%対象の文書: ${kindRaw}。%`).first<{ status: string }>();
  const taskLabel: Record<string, string> = {
    read: "順番を待っています",
    connecting: "案を作っています",
    done: "AIの依頼が終わりました。案の内容を確かめてください",
    attention: "AIの作業が止まりました。内容を確かめてください",
    failed: "AIの作業が止まりました。ここで書いて保存できます",
  };
  const taskNotice = task ? {
    status: task.status,
    message: taskLabel[task.status] ?? "AIの作業状態を確認できません。ここで書いて保存できます",
  } : null;
  const templates = kindRaw === "notice" ? await getTemplates(c.env.DB, ward.wardId) : [];
  const versions = document ? await c.env.DB.prepare("SELECT version_no, body, created_at, origin FROM document_versions WHERE ward_id = ? AND project_id = ? AND document_id = ? ORDER BY version_no DESC LIMIT 8").bind(ward.wardId, id, document.documentId).all<{ version_no: number; body: string; created_at: string; origin: string }>() : { results: [] };
  return c.html(<Layout title={`${pack.title}を直す`} siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")} headerRight={<a href={adminPath(ward, `/projects/${id}/draft`)}>案の一覧</a>}>
    <h1>{pack.title}を直す <Hint text="本文や今年の中身を直し、「直した中身を保存」を押してください。保存しただけでは配られません。" /></h1>
    {taskNotice ? <Notice><span data-ai-status={taskNotice.status}>{taskNotice.message}</span> 画面を閉じても処理は続きます。ここで書いて保存することもできます。</Notice> : null}
    {document?.stale ? <Notice>新しい物が入りました。<a href={adminPath(ward, `/projects/${id}/draft/${kindRaw}`)}>案を直す</a> / このまま</Notice> : null}
    <form method="post" action={adminPath(ward, `/projects/${id}/draft/${kindRaw}/save`)}>
      <input type="hidden" name="based_on" value={baseVersion} />
      <label for="title">文書の題</label><input id="title" name="title" value={document?.title ?? pack.title} maxlength={100} required />
      {kindRaw === "duty_roster" ? <><input type="hidden" name="scope" value="space" /><p>当番表は実行委員と班長にだけ見えます。</p></> : <><label for="scope">見られる範囲</label><select id="scope" name="scope">{SCOPES.map((v) => <option value={v} selected={v === scope}>{SCOPE_LABEL[v]}</option>)}</select></>}
      <label for="text">文</label><textarea id="text" name="text" rows={12} maxlength={20000} style="width:100%;font:inherit;padding:.65rem">{body.text}</textarea>
      <h2>今年の中身</h2>
      {ITEMS_BY_KIND[project.kind].map((key) => { const value = body.items.find((x) => x.key === key)?.content ?? ""; const item = state.items.find((x) => x.key === key); return <div>
        <label for={`item-${key}`}>{ITEM_LABEL[key]}</label><input id={`item-${key}`} name={`item_${key}`} value={value} maxlength={2000} />
        {item?.references.map((ref) => <p class="muted">参考（{ref.refYear ?? "年不明"}年）: {ref.content}</p>)}
      </div>; })}
      <p><button type="submit">直した中身を保存</button></p>
    </form>
    {kindRaw === "duty_roster" ? <section>
      <h2>当番の担当を直す</h2>
      {state.tables.duties.filter((row) => row.scope === "current").map((row) => <form class="panel" method="post" action={adminPath(ward, `/projects/${id}/draft/duty-row/${row.rowId}`)}>
        <label for={`slot-${row.rowId}`}>時間帯</label><input id={`slot-${row.rowId}`} name="slot" value={String(row.data.slot ?? "")} maxlength={120} required />
        <label for={`task-${row.rowId}`}>持ち場</label><input id={`task-${row.rowId}`} name="task" value={String(row.data.task ?? "")} maxlength={200} />
        <label for={`assignee-${row.rowId}`}>担当</label><input id={`assignee-${row.rowId}`} name="assignee" value={String(row.data.assignee ?? "")} maxlength={160} />
        <label for={`attendance-${row.rowId}`}>出席</label><select id={`attendance-${row.rowId}`} name="attendance"><option value="no_change" selected={!row.data.attendance}>まだ記録しない</option><option value="present" selected={row.data.attendance === "present"}>出席</option><option value="absent" selected={row.data.attendance === "absent"}>欠席</option></select>
        <p><button type="submit">この行を保存</button></p>
      </form>)}
      {state.tables.duties.filter((row) => row.scope === "current").length === 0 ? <p>当番表の行はまだありません。下の紙の欄に書き込めます。</p> : null}
      <p>印刷用ページから紙の当番表を開き、手で書き込むこともできます。</p>
    </section> : null}
    {kindRaw === "notice" && !project.closedAt ? <section class="panel">
      <h2>雨天の知らせをすぐ用意</h2>
      <p>定型文に会場と日時を入れて、配る画面へ進みます。AIは使いません。</p>
      <form method="post" action={adminPath(ward, `/projects/${id}/draft/rain-notice`)}>
        <label for="rain-template">定型文</label><select id="rain-template" name="templateId" required>{templates.map((template) => <option value={template.id}>{template.name}</option>)}</select>
        <label for="rain-event">行事名</label><input id="rain-event" name="eventName" value={project.title} maxlength={100} required />
        <label for="rain-place">変更後の会場</label><input id="rain-place" name="place" value={state.items.find((item) => item.key === "place")?.current?.content ?? ""} maxlength={200} required />
        <label for="rain-date">日時</label><input id="rain-date" name="dateTime" value={state.items.find((item) => item.key === "date_time")?.current?.content ?? ""} maxlength={200} required />
        <p><button type="submit">定型文で知らせを作る</button></p>
      </form>
    </section> : null}
    {document ? <h2>前の案</h2> : null}
    {versions.results.map((v) => { const old = parseBody(v.body); return <details><summary>{v.origin === "ai" ? "AIの案" : "役員が直した案"}</summary><pre style="white-space:pre-wrap">{old.text}</pre>
      {!project.closedAt ? <form method="post" action={adminPath(ward, `/projects/${id}/draft/${kindRaw}/restore/${v.version_no}`)}><button class="secondary">この案に戻す</button></form> : null}
    </details>; })}
    <form method="post" action={adminPath(ward, `/projects/${id}/draft/${kindRaw}/start`)}>
      <label for="instruction">AIに一行で頼む</label><input id="instruction" name="instruction" type="text" maxlength={800} placeholder="例: 雨天時の会場変更を反映してください" />
      <p><button class="secondary">AIに案を起こしてもらう</button></p>
    </form>
    <p><a href={adminPath(ward, `/publish/${id}`)}>配る</a></p>
  </Layout>);
});

admin.post("/projects/:projectId/draft/:kind/restore/:versionNo", async (c) => {
  const { ward, account } = c.var; const id = c.req.param("projectId"); const kindRaw = c.req.param("kind");
  if (!isKind(kindRaw)) return c.notFound();
  const versionNo = Number(c.req.param("versionNo"));
  if (!Number.isInteger(versionNo) || versionNo < 1) return c.notFound();
  const [project, current, prior] = await Promise.all([
    getProjectSummary(c.env.DB, ward.wardId, id),
    getProjectState(c.env.DB, ward.wardId, id),
    c.env.DB.prepare(`SELECT v.body, v.scope FROM documents d JOIN document_versions v
      ON v.ward_id = d.ward_id AND v.document_id = d.document_id
      WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = ? AND v.version_no = ?`)
      .bind(ward.wardId, id, kindRaw, versionNo).first<{ body: string; scope: Scope }>(),
  ]);
  if (!project || !current || project.closedAt || !prior) return c.notFound();
  const restored = parseBody(prior.body);
  const ok = await saveDocument(c.env.DB, ward.wardId, id, account.accountId, {
    kind: kindRaw,
    title: DOCUMENT_KIND_LABEL[kindRaw],
    scope: kindRaw === "duty_roster" ? "space" : prior.scope,
    body: JSON.stringify(restored),
    basedOn: project.stateVersion,
  });
  return c.redirect(`${adminPath(ward, `/projects/${id}/draft/${kindRaw}`)}?${ok ? "notice=restored" : "error=" + encodeURIComponent("前の案を戻せませんでした")}`, 303);
});

admin.post("/projects/:projectId/draft/rain-notice", async (c) => {
  const { ward, account } = c.var; const id = c.req.param("projectId"); const form = await c.req.formData();
  const [project, templates] = await Promise.all([
    getProjectSummary(c.env.DB, ward.wardId, id),
    getTemplates(c.env.DB, ward.wardId),
  ]);
  if (!project || project.closedAt) return c.notFound();
  const template = templates.find((item) => item.id === String(form.get("templateId") ?? ""));
  const eventName = String(form.get("eventName") ?? "").trim();
  const place = String(form.get("place") ?? "").trim();
  const dateTime = String(form.get("dateTime") ?? "").trim();
  if (!template || !eventName || !place || !dateTime) return c.redirect(`${adminPath(ward, `/projects/${id}/draft/notice`)}?error=${encodeURIComponent("定型文と会場、日時を入力してください")}`, 303);
  const text = renderTemplate(template.body, { 行事名: eventName, 会場: place, 日時: dateTime });
  if (/\{[^{}]+\}/.test(text)) return c.redirect(`${adminPath(ward, `/projects/${id}/draft/notice`)}?error=${encodeURIComponent("定型文に置き換えられない項目があります")}`, 303);
  const state = await getProjectState(c.env.DB, ward.wardId, id);
  if (!state) return c.notFound();
  const ok = await saveDocument(c.env.DB, ward.wardId, id, account.accountId, {
    kind: "notice", title: "雨天の変更のお知らせ", scope: "public",
    body: JSON.stringify({ text, items: [] }), basedOn: state.project.stateVersion,
  });
  if (!ok) return c.redirect(`${adminPath(ward, `/projects/${id}/draft/notice`)}?error=${encodeURIComponent("知らせを保存できませんでした")}`, 303);
  return c.redirect(`${adminPath(ward, `/publish/${id}`)}`, 303);
});

admin.post("/projects/:projectId/draft/:kind/save", async (c) => {
  const { ward, account } = c.var; const id = c.req.param("projectId"); const kindRaw = c.req.param("kind");
  if (!isKind(kindRaw)) return c.notFound();
  const form = await c.req.formData(); const state = await getProjectState(c.env.DB, ward.wardId, id);
  if (!state) return c.notFound();
  const scopeRaw = String(form.get("scope")); if (!(SCOPES as readonly string[]).includes(scopeRaw) || (kindRaw === "duty_roster" && scopeRaw !== "space")) return c.notFound();
  const body: DraftBody = { text: String(form.get("text") ?? ""), items: ITEMS_BY_KIND[state.project.kind].map((key) => ({ key, content: String(form.get(`item_${key}`) ?? "").trim() })).filter((i) => i.content !== "") };
  const ok = await saveDocument(c.env.DB, ward.wardId, id, account.accountId, { kind: kindRaw, title: String(form.get("title") ?? ""), scope: scopeRaw as Scope, body: JSON.stringify(body), basedOn: Number(form.get("based_on")) });
  return c.redirect(`${adminPath(ward, `/projects/${id}/draft/${kindRaw}`)}?${ok ? "notice=saved" : "error=" + encodeURIComponent("保存できませんでした。入力を確かめてください")}`, 303);
});

admin.post("/projects/:projectId/draft/duty-row/:rowId", async (c) => {
  const { ward, account } = c.var; const id = c.req.param("projectId"); const rowId = c.req.param("rowId");
  const form = await c.req.formData();
  const rawAttendance = String(form.get("attendance") ?? "no_change");
  if (rawAttendance !== "no_change" && rawAttendance !== "present" && rawAttendance !== "absent") return c.notFound();
  const data: Record<string, string> = { slot: String(form.get("slot") ?? "").trim(), task: String(form.get("task") ?? "").trim(), assignee: String(form.get("assignee") ?? "").trim() };
  if (rawAttendance !== "no_change") data.attendance = rawAttendance;
  const ok = await saveDutyRow(c.env.DB, ward.wardId, id, rowId, account.accountId, data);
  return c.redirect(`${adminPath(ward, `/projects/${id}/draft/duty_roster`)}?${ok ? "notice=saved" : "error=" + encodeURIComponent("当番の行を保存できませんでした")}`, 303);
});

admin.post("/projects/:projectId/draft/:kind/start", async (c) => {
  const { ward, account } = c.var; const id = c.req.param("projectId"); const kindRaw = c.req.param("kind");
  if (!isKind(kindRaw)) return c.notFound();
  const project = await getProjectSummary(c.env.DB, ward.wardId, id);
  if (!project || project.closedAt) return c.notFound();
  const pack = getDraftPack(kindRaw);
  const form = await c.req.formData();
  const instruction = String(form.get("instruction") ?? "").trim().slice(0, 800);
  try {
    const contact = await getPublicContact(c.env.DB, ward.wardId);
    const helpers = pack.kind === "duty_roster" ? await getDutyDraftHelpers(c.env.DB, ward.wardId, id) : [];
    const helperInstruction = helpers.length
      ? `\n回答から集めた手伝いの希望（この一覧を当番表の案に含めてください）: ${JSON.stringify(helpers)}`
      : "\n回答に手伝いの希望はまだありません。";
    await startTask(c.env, c.executionCtx, { wardId: ward.wardId, projectId: id, task: "draft", instruction: `${pack.instruction}${contact ? `\n区の公開用の連絡先（問い合わせ先に使う）: ${contact}` : ""}${instruction ? `\n役員からの頼み: ${instruction}` : ""}\n対象の文書: ${pack.kind}。範囲: ${pack.scope}。data に pack_version を ${pack.version}、based_on_state_version を引いた状態の番号として含めてください。${pack.kind === "duty_roster" ? helperInstruction : ""}`, accountId: account.accountId });
    return c.redirect(`${adminPath(ward, `/projects/${id}/draft/${kindRaw}`)}?notice=started`, 303);
  } catch { return c.redirect(`${adminPath(ward, `/projects/${id}/draft/${kindRaw}`)}?error=${encodeURIComponent("AIに頼めませんでした。ここで手入力して保存できます")}`, 303); }
});

export { admin as draftAdmin };
export const draft: Bundle = { admin };
