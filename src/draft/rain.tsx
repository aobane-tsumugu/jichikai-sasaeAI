import type { Context } from "hono";
import { adminPath } from "../core/auth";
import { ErrorNotice, Layout } from "../core/ui";
import type { AdminEnv } from "../env";
import { getProjectState } from "../project/api";
import { getTemplates } from "../settings/store";
import { DEFAULT_TEMPLATES, renderTemplate, type Template } from "../settings/keys";

/** 標準の文面は見本に揃え、区が直した文面はそのまま使う。 */
export function rainTemplate(template: Template): Template {
  return template.id === "rain" && template.body === DEFAULT_TEMPLATES.find((item) => item.id === "rain")?.body
    ? { ...template, body: "{行事名}は、雨のため{会場}で行います。日ときは{日時}です。くわしくは区のページをご覧ください。" }
    : template;
}

export async function rainDraft(c: Context<AdminEnv>) {
  const { ward } = c.var; const id = c.req.param("projectId");
  if (!id) return c.notFound();
  const [state, savedTemplates] = await Promise.all([getProjectState(c.env.DB, ward.wardId, id), getTemplates(c.env.DB, ward.wardId)]);
  if (!state) return c.notFound();
  const templates = savedTemplates.map(rainTemplate);
  const values = (key: string) => { const item = state.items.find((item) => item.key === key); return item?.current?.content ?? item?.references[0]?.content ?? ""; };
  // 標準の雨の文面があればそれを使う。複数ある時だけ選べるようにする。
  const template = templates.find((item) => item.id === "rain") ?? templates[0];
  const place = values("place"); const dateTime = values("date_time");
  const canSend = !state.project.closedAt && state.documents.some((document) => document.kind === "announcement" && document.publishedVersionNo !== null);
  return c.html(<Layout title="雨の変更を知らせる" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, `/projects/${id}/map`)}>← {state.project.title}の段取りへ</a>
    <h1>雨の変更を知らせる</h1><p class="lead">いつもの文面に場所を入れて、すぐ配れます。</p>
    <ErrorNotice code={c.req.query("error")} messages={{ rain_input: "変更後の場所と日時を入れてください", rain_template: "いつもの文面を使えません。知らせの下書きから書けます。", notice_save_failed: "知らせを保存できませんでした" }} />
    {canSend && template ? <form method="post" action={adminPath(ward, `/projects/${id}/draft/rain-notice`)} id="rain-form">
      <input type="hidden" name="eventName" value={state.project.title} />
      {templates.length === 1 ? <input type="hidden" name="templateId" value={template.id} /> : <div class="field"><label for="rain-template">いつもの文面</label><select id="rain-template" name="templateId">{templates.map((item) => <option value={item.id} selected={item.id === template.id}>{item.name}</option>)}</select></div>}
      <div class="field"><label for="place">変更後の場所</label><input id="place" name="place" value={place} maxlength={200} required /></div>
      <div class="field"><label for="date">日時</label><input id="date" name="dateTime" value={dateTime} maxlength={200} required /></div>
      <div class="sheet-preview"><b>配る文</b><p id="rain-preview">{renderTemplate(template.body, { 行事名: state.project.title, 会場: place, 日時: dateTime })}</p></div>
      <script type="application/json" id="rain-templates" dangerouslySetInnerHTML={{ __html: JSON.stringify(templates).replace(/</g, "\\u003c") }} />
      <script dangerouslySetInnerHTML={{ __html: `(() => { const form = document.getElementById('rain-form'); const templates = JSON.parse(document.getElementById('rain-templates').textContent); const update = () => { const data = new FormData(form); const template = templates.find(item => item.id === data.get('templateId')); if (!template) return; const values = { '行事名': data.get('eventName'), '会場': data.get('place'), '日時': data.get('dateTime') }; document.getElementById('rain-preview').textContent = template.body.replace(/\\{([^{}]+)\\}/g, (whole, key) => values[key.trim()] ?? whole); }; form.addEventListener('input', update); form.addEventListener('change', update); })();` }} />
      <div class="action-bar"><button>配る</button></div>
    </form> : <p>{state.project.closedAt ? "この行事は閉じました。" : "案内を配ったあとに、雨の変更を知らせられます。"}</p>}
    <p class="muted">配ると、区のページと公式LINEに出ます。LINEで送った知らせは取り消せません。</p>
    {!template ? <p class="link-line"><a href={adminPath(ward, `/projects/${id}/draft/notice?edit=1`)}>知らせの下書きを書く</a></p> : null}
  </Layout>);
}

export async function rainSent(c: Context<AdminEnv>) {
  const { ward } = c.var; const id = c.req.param("projectId");
  if (!id) return c.notFound();
  const record = await c.env.DB.prepare(`SELECT r.line_status FROM publication_records r
    JOIN documents d ON d.ward_id = r.ward_id AND d.document_id = r.document_id
    WHERE r.ward_id = ? AND r.project_id = ? AND r.publication_id = ? AND d.kind = 'notice'`)
    .bind(ward.wardId, id, c.req.query("done") ?? "").first<{ line_status: string }>();
  if (!record) return c.notFound();
  return c.html(<Layout title="雨の変更を知らせました" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, `/projects/${id}/map`)}>← 段取りへ</a>
    <h1>区のページに載せました</h1>
    <p class="lead">{record.line_status === "sent" ? "公式LINEに送りました。" : record.line_status === "failed" ? "公式LINEには送れませんでした。区のページには載っています。" : "公式LINEには送っていません。"}</p>
    <section class="next"><strong>次は</strong><p>班長に電話し、掲示の紙を張り替えてください。</p></section>
    <p><a class="quiet" href={adminPath(ward, `/projects/${id}/draft/notice`)}>直して配り直す</a></p>
  </Layout>);
}
