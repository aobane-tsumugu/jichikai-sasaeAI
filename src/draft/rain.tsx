import type { Context } from "hono";
import { FlyerPanel, flyerPanelState } from "./notice-flyers";
import { adminPath } from "../core/auth";
import { ErrorNotice, Layout, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { getProjectState } from "../project/api";
import { getTemplates } from "../settings/store";
import { DEFAULT_TEMPLATES, renderTemplate, type Template } from "../settings/keys";

/** 標準の文面は見本に揃え、区が直した文面はそのまま使う。 */
export function rainTemplate(template: Template): Template {
  return template.id === "rain" && template.body === DEFAULT_TEMPLATES.find((item) => item.id === "rain")?.body
    ? { ...template, body: "{行事名}は、雨のため{会場}で行います。日時は{日時}です。くわしくは住民向けのページをご覧ください。" }
    : template;
}

export async function rainDraft(c: Context<AdminEnv>, error?: string) {
  const { ward } = c.var; const id = c.req.param("projectId");
  if (!id) return c.notFound();
  const [state, savedTemplates] = await Promise.all([getProjectState(c.env.DB, ward.wardId, id), getTemplates(c.env.DB, ward.wardId)]);
  if (!state) return c.notFound();
  const templates = savedTemplates.map(rainTemplate);
  const values = (key: string) => { const item = state.items.find((item) => item.key === key); return item?.current?.content ?? item?.references[0]?.content ?? ""; };
  // 標準の雨の文面があればそれを使う。複数ある時だけ選べるようにする。
  const template = templates.find((item) => item.id === "rain") ?? templates[0];
  const place = values("rain_plan"); const dateTime = values("date_time");
  const canSend = !state.project.closedAt && state.documents.some((document) => document.kind === "announcement" && document.publishedVersionNo !== null);
  return c.html(<Layout title="雨の変更を知らせる" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, `/projects/${id}/map`)}>← {state.project.title}のやることへ</a>
    <h1>雨の変更を知らせる</h1><p class="lead">いつもの文面に場所を入れて、すぐ知らせられます。</p>
    <ErrorNotice code={c.req.query("error")} messages={{ rain_input: "変更後の場所と日時を入れてください", rain_template: "いつもの文面を使えません。連絡の下書きから書けます。", notice_save_failed: "連絡を保存できませんでした" }} />
    {error ? <Notice>{error}</Notice> : null}
    {canSend && template ? <form method="post" enctype="multipart/form-data" action={adminPath(ward, `/projects/${id}/draft/rain-notice`)} id="rain-form">
      <input type="hidden" name="eventName" value={state.project.title} />
      {templates.length === 1 ? <input type="hidden" name="templateId" value={template.id} /> : <div class="field"><label for="rain-template">いつもの文面</label><select id="rain-template" name="templateId">{templates.map((item) => <option value={item.id} selected={item.id === template.id}>{item.name}</option>)}</select></div>}
      <div class="field"><label for="place">変更後の場所</label><input id="place" name="place" value={place} maxlength={200} required /></div>
      <div class="field"><label for="date">日時</label><input id="date" name="dateTime" value={dateTime} maxlength={200} required /></div>
      <div class="sheet-preview"><b>知らせる文</b><p id="rain-preview">{renderTemplate(template.body, { 行事名: state.project.title, 会場: place, 日時: dateTime })}</p></div>
      <script type="application/json" id="rain-templates" dangerouslySetInnerHTML={{ __html: JSON.stringify(templates).replace(/</g, "\\u003c") }} />
      <script dangerouslySetInnerHTML={{ __html: `(() => { const form = document.getElementById('rain-form'); const templates = JSON.parse(document.getElementById('rain-templates').textContent); const update = () => { const data = new FormData(form); const template = templates.find(item => item.id === data.get('templateId')); if (!template) return; const values = { '行事名': data.get('eventName'), '会場': data.get('place'), '日時': data.get('dateTime') }; document.getElementById('rain-preview').textContent = template.body.replace(/\\{([^{}]+)\\}/g, (whole, key) => values[key.trim()] ?? whole); }; form.addEventListener('input', update); form.addEventListener('change', update); })();` }} />
      <FlyerPanel c={c} projectId={id} state={await flyerPanelState(c.env, ward.wardId, id, "notice")} />
      <p>「送る」を押すと、保存して、送る前に確かめる画面が開きます。住民向けのページと自治会のLINEを、ほかの連絡と同じ画面で見てから送ります。まだ送りません。</p>
      <div class="action-bar"><button>送る</button></div>
    </form> : state.project.closedAt ? <p>{state.project.title}は終わりにしました。</p>
      : <section class="next"><p>{state.project.title}の案内は、まだ住民に知らせていません。雨の変更は、案内を知らせたあとに、ここからすぐ知らせられます。先に案内を知らせてください。</p><a class="button" href={adminPath(ward, `/projects/${id}/draft/announcement`)}>{state.project.title}の案内の下書きを開く</a><p>雨のほかに急いで知らせることがあるときは、<a href={adminPath(ward, `/projects/${id}/draft/notice?edit=1`)}>連絡の下書きを書く</a>から書けます。</p></section>}
    {!template ? <p class="link-line"><a href={adminPath(ward, `/projects/${id}/draft/notice?edit=1`)}>連絡の下書きを書く</a></p> : null}
    {error && template ? <p class="link-line"><a href={adminPath(ward, `/projects/${id}/draft/notice?edit=1`)}>連絡の下書きに戻る</a></p> : null}
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
    <a class="back" href={adminPath(ward, `/projects/${id}/map`)}>← やることへ</a>
    <h1>住民向けのページに載せました</h1>
    <p class="lead">{record.line_status === "sent" ? "自治会のLINEに送りました。" : record.line_status === "failed" ? "自治会のLINEには送れませんでした。住民向けのページには載っています。" : "自治会のLINEには送っていません。"}</p>
    <section class="next"><strong>次は</strong><p>班長に電話し、掲示の紙を張り替えてください。</p></section>
    <p><a class="quiet" href={adminPath(ward, `/projects/${id}/draft/notice`)}>直して知らせ直す</a></p>
  </Layout>);
}
