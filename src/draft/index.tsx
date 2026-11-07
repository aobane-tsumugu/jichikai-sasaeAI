import { photosAvailable } from "../photos/policy";
import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { adminPath } from "../core/auth";
import { ErrorNotice, Layout, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { startTask } from "../ai/api";
import { getProjectState, getProjectSummary } from "../project/api";
import { getEditableDocument, saveDocument, DOCUMENT_TEXT_LIMIT } from "../project/actions";
import { DOCUMENT_KINDS, DOCUMENT_KIND_LABEL, ITEM_LABEL, ITEMS_BY_KIND, PROJECT_KIND_LABEL, SCOPES, SCOPE_LABEL, type DocumentKind, type Scope, type ItemKey } from "../project/model";
import { documentBodyCheckMessage } from "../project/document-body";
import { getDraftPack, listDraftPacks } from "./packs";
import type { DraftBody } from "./packs/types";
import { getDistrictCopies, getDutyDraftHelpers } from "../answers/api";
import { getPublicContact, getTemplates } from "../settings/store";
import { renderTemplate } from "../settings/keys";
import { saveDutyRow } from "../project/actions";
import { formatJstDate } from "../core/time";
import { openPublish } from "./publish-flow";
import { rainDraft, rainSent, rainTemplate } from "./rain";
import { checkPublicDraft } from "../publish/check";
import { paperHeading } from "../project/heading";
import { opensOf, taskDraftKind } from "../map/template";
import { draftMaterials } from "./materials";
import { startMaterialDraft } from "./start";
import { getMeetingMaterials, meetingMaterialInstruction, MeetingMaterialsView } from "./meeting-materials";
import { rotaPanel, rotaRowNotes } from "../rota";
import { prepareRota } from "../rota/store";

const SEE_LABEL: Record<Scope, string> = { public: "だれでも読める", space: "実行委員と班長だけ", staff: "役員だけ" };
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "restore_failed": "前の下書きに戻せませんでした",
  "rain_input": "決まった知らせの文と会場、日時を入力してください",
  "rain_template": "決まった知らせの文に置き換えられない項目があります",
  "notice_save_failed": "知らせを保存できませんでした",
  "save_failed": "保存できませんでした。入力を確かめてください",
  "duty_save_failed": "当番の行を保存できませんでした",
  "rota_missing": "下書きを作れませんでした。名簿か去年の当番表を送って、もう一度お試しください",
  "ai_failed": "AIに頼めませんでした。ここで手入力して保存できます"
};

const admin = new Hono<AdminEnv>();
admin.get("/projects/:projectId/draft/rain-sent", rainSent);
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
  const written = await c.env.DB.prepare("SELECT DISTINCT kind FROM documents WHERE ward_id = ? AND project_id = ?").bind(ward.wardId, id).all<{ kind: string }>();
  const dutyWritten = project.kind === "duty" && await c.env.DB.prepare(`SELECT 1 AS found FROM project_rows
    WHERE ward_id = ? AND project_id = ? AND table_key = 'duties' AND scope = 'current' AND removed_at IS NULL LIMIT 1`).bind(ward.wardId, id).first();
  return c.html(<Layout title={`下書き: ${project.title}`} siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, `/projects/${id}/map`)}>← {project.title}の段取りへ</a>
    <h1>{project.title}の下書き</h1><p class="lead">作りたい文書を選んでください。今ある資料からAIに下書きを頼むか、自分で書き始められます。</p><p>文書を選び、必要ならAIに下書きを起こさせます。AIが止まっているときも、ここで書いて保存できます。</p>
    {c.req.query("notice") === "saved" ? <Notice>保存しました。今年の内容にも入れました。</Notice> : null}
    {c.req.query("notice") === "started" ? <Notice>AIに下書きを頼みました。画面を閉じても続きます。</Notice> : null}
    {c.req.query("notice") === "restored" ? <Notice>前の下書きを戻して、新しい下書きとして保存しました。</Notice> : null}
    <ErrorNotice code={c.req.query("error")} messages={ERROR_MESSAGES} />
    {listDraftPacks(project.kind).map((pack) => <section class="panel"><h2><a href={adminPath(ward, `/projects/${id}/draft/${pack.kind}`)}>{pack.title}</a></h2><p>{written.results.some((row) => row.kind === pack.kind) || (pack.kind === "duty_roster" && dutyWritten) ? "下書きがあります。" : "まだありません。"}{SEE_LABEL[pack.scope]}</p>
      <form method="post" action={adminPath(ward, `/projects/${id}/draft/${pack.kind}/start`)}><button class="secondary">{project.kind === "duty" && pack.kind === "duty_roster" ? "当番の下書きを作る" : "AIに下書きを頼む"}</button></form>
    </section>)}
    <div class="action-links"><a class="button secondary" href={adminPath(ward, `/publish/${id}`)}>配る画面へ</a></div>
  </Layout>);
});

type DraftRetry = { body: DraftBody; title: string; scope: Scope; basedOn: string; message: string; status: 400 | 503 };
async function renderDraft(c: import("hono").Context<AdminEnv>, retry?: DraftRetry): Promise<Response> {
  const { ward } = c.var; const id = c.req.param("projectId"); const kindRaw = c.req.param("kind");
  if (!id || !kindRaw || !isKind(kindRaw)) return c.notFound();
  const [project, state, document] = await Promise.all([getProjectSummary(c.env.DB, ward.wardId, id), getProjectState(c.env.DB, ward.wardId, id), getEditableDocument(c.env.DB, ward.wardId, id, kindRaw)]);
  if (!project || !state) return c.notFound();
  // 保存済みの知らせは通常の下書きとして開き、保存結果や前の下書きも読めるようにする。
  if (!retry && project.kind === "event" && kindRaw === "notice" && !document && c.req.query("edit") !== "1") return rainDraft(c);
  const pack = getDraftPack(kindRaw, project.kind);
  const meetingMaterials = kindRaw === "procedure" ? await getMeetingMaterials(c.env.DB, ward.wardId, project) : null;
  const reportPhotos = kindRaw === "report" && project.kind === "event" && await photosAvailable(c.env, ward.wardId);
  const minutes = kindRaw === "report" && ["general_meeting", "board_meeting"].includes(project.kind);
  const body: DraftBody = retry?.body ?? (document ? parseBody(document.body) : { text: "", items: (minutes ? [] : state.items).map((item) => {
    if (item.current?.content.trim()) return { key: item.key, content: item.current.content };
    const reference = item.references.find((ref) => ref.content.trim());
    return { key: item.key, content: reference?.content ?? "", ...(reference ? { source: reference.refYear === null ? "年の分からない資料" : reference.refYear === project.year - 1 ? "去年の資料" : `${reference.refYear}年の資料` } : {}) };
  }) });
  const scope = retry?.scope ?? document?.scope ?? pack.scope; const baseVersion = retry?.basedOn ?? document?.stateVersion ?? project.stateVersion;
  const title = retry?.title ?? (kindRaw === "announcement" && project.kind === "event" && (document?.title ?? pack.title) === pack.title ? `${project.title}のご案内` : document?.title ?? pack.title);
  const paperFirst = project.kind !== "event" && scope !== "public" && !(scope === "space" && ["duty_roster", "procedure"].includes(kindRaw));
  const task = await c.env.DB.prepare(`SELECT status FROM jobs WHERE ward_id = ? AND project_id = ? AND task = 'draft'
    AND instruction LIKE ? ORDER BY created_at DESC LIMIT 1`).bind(ward.wardId, id, `%対象の文書: ${kindRaw}。%`).first<{ status: string }>();
  const taskLabel: Record<string, string> = {
    read: "AIが下書きを作り始めるところです。閉じてもかまいません",
    connecting: "AIが下書きを作っています。閉じてもかまいません",
    done: "AIの下書きができました。内容を見てください",
    attention: "AIの下書きを作れませんでした。ここで書いて保存するか、下の「AIに言葉で頼む」からもう一度頼めます。",
    failed: "AIの下書きを作れませんでした。ここで書いて保存するか、下の「AIに言葉で頼む」からもう一度頼めます。",
  };
  const taskNotice = task ? {
    status: task.status,
    message: taskLabel[task.status] ?? "AIの様子が分かりません。ここで書いて保存できます",
  } : null;
  const versions = document ? await c.env.DB.prepare("SELECT version_no, body, created_at, origin, published_at FROM document_versions WHERE ward_id = ? AND project_id = ? AND document_id = ? ORDER BY version_no DESC LIMIT 8").bind(ward.wardId, id, document.documentId).all<{ version_no: number; body: string; created_at: string; origin: string; published_at: string | null }>() : { results: [] };
  if (!retry && !body.text && !minutes) body.text = body.items.find((item) => item.key === "content")?.content ?? "";
  const originals = await c.env.DB.prepare(`SELECT o.original_id, o.filename FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id
    WHERE o.ward_id = ? AND j.project_id = ? AND o.withdrawn_at IS NULL`).bind(ward.wardId, id).all<{ original_id: string; filename: string }>();
  const labels: Record<string, string> = { date_time: "いつ", place: "どこで", rain_plan: "雨のとき", helper_slots: "手伝いの時間帯", belongings: "持ち物", due: ["city_request", "request"].includes(project.kind) ? "提出の締切" : kindRaw === "recruitment" ? "申し込みの締切" : "答えの締切", public_contact: "連絡先" };
  const relatedTask = state.mapTasks.find((task) => project.kind === "event"
    ? task.taskKey === (kindRaw === "duty_roster" ? "duty_roster" : kindRaw === "report" ? "report" : "announcement")
    : opensOf(project.kind, task.taskKey).includes("draft") && taskDraftKind(task.taskKey, project.kind) === kindRaw);
  const field = (key: (typeof ITEMS_BY_KIND)[keyof typeof ITEMS_BY_KIND][number]) => {
    const draftItem = body.items.find((item) => item.key === key); const value = draftItem?.content ?? "";
    const item = state.items.find((item) => item.key === key);
    const sourceValue = item?.current?.content === value ? item.current : item?.references.find((ref) => ref.content === value);
    const source = sourceValue?.source;
    const original = source?.ref ? originals.results.find((entry) => entry.original_id === source.ref) : undefined;
    const previous = item?.references.find((ref) => ref.refYear === project.year - 1 && ref.content !== value);
    const conflict = state.questions.find((question) => question.kind === "conflict" && question.target === key && (question.state === "open" || question.state === "later"));
    return <div class="field"><label for={`item-${key}`}>{labels[key] ?? ITEM_LABEL[key]}</label>
      {key === "helper_slots" ? <textarea id={`item-${key}`} name={`item_${key}`} rows={3} maxlength={2000}>{value}</textarea> : <input id={`item-${key}`} name={`item_${key}`} value={value} maxlength={2000} />}
      {original ? <p class="help-text">{original.filename || "送った資料"}{source?.locator ? `（${source.locator}）` : ""}から入れました。{previous ? `去年は${previous.content}でした。` : ""}</p> : draftItem?.source ? <p class="help-text">{draftItem.source}から入れました。{draftItem.source.startsWith("今年") ? "" : "今年も同じか見てください。"}</p> : previous ? <p class="help-text">去年は{previous.content}でした。</p> : null}
      {original ? <a class="quiet" href={adminPath(ward, `/intake/originals/${original.original_id}`)}>元の資料を見る</a> : null}
      {conflict ? <p><a class="quiet" href={adminPath(ward, `/projects/${id}/questions/${conflict.questionId}/compare?from=draft`)}>資料によって違います。見比べる</a></p> : null}
      {key === "public_contact" ? <p class="help-text">だれでも読める案内に出ます。</p> : null}
    </div>;
  };
  const dateValue = body.items.find((item) => item.key === "date_time")?.content ?? "";
  const oldDates = [...new Set(state.items.find((item) => item.key === "date_time")?.references.flatMap((ref) => ref.content.match(/\d{1,2}月\d{1,2}日/g) ?? []) ?? [])].filter((date) => body.text.includes(date) && !dateValue.includes(date));
  const bodyCheck = c.req.query("notice") === "saved" ? documentBodyCheckMessage(c.req.query("check_body")) : null;
  const rota = project.kind === "duty" && kindRaw === "duty_roster" ? await rotaPanel(c.env.DB, ward, id) : null;
  const rotaNotes = project.kind === "duty" && kindRaw === "duty_roster" ? await rotaRowNotes(c.env.DB, ward.wardId, id) : [];
  return c.html(<Layout title={`${pack.title}の下書きを直す`} siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, kindRaw === "duty_roster" ? `/projects/${id}/draft` : relatedTask ? `/projects/${id}/map/${relatedTask.taskId}` : `/projects/${id}/map`)}>← {kindRaw === "duty_roster" ? "下書きの一覧" : relatedTask ? relatedTask.name : `${project.title}の段取り`}へ</a>
    <h1>{pack.title}の下書きを直す</h1>
    <p class="lead">{kindRaw === "announcement" && scope === "public" ? `直して保存しても、まだ配られません。だれでも読める${project.kind === "event" ? "案内" : pack.title}です。` : <>{kindRaw === "duty_roster" ? "実行委員と班長に見せる当番表です。" : kindRaw === "recruitment" && scope === "public" ? "区のページの「一回だけ手伝う」に出る募集です。" : scope === "public" ? `だれでも読める${project.kind === "event" ? "案内" : pack.title}です。` : scope === "space" ? "実行委員と班長だけが読めます。" : "役員だけが読めます。"}直して保存しても、まだ配られません。</>}</p>
    {minutes ? <p>決めたことを書いた紙を撮るか、文を送ってから、AIに下書きを頼めます。書かれていることだけをまとめます。<a class="button secondary" href={adminPath(ward, `/intake?project=${encodeURIComponent(id)}#send-form`)}>紙や文を送る</a></p> : null}
    {retry ? <Notice error>{retry.message} 書いた内容は下に残っています。</Notice> : <ErrorNotice code={c.req.query("error")} messages={ERROR_MESSAGES} />}
    {c.req.query("notice") === "saved" ? <section class="next"><strong>保存しました。まだ配っていません</strong><p>前の下書きにも戻せます。</p>{scope !== "staff" ? <a class="button secondary" href={adminPath(ward, `/publish/${id}/confirm?kind=${kindRaw}`)}>配る画面へ</a> : null}<a class="quiet" href="#previous-drafts">前の下書きに戻す</a></section> : null}
    {bodyCheck ? <Notice>{bodyCheck}</Notice> : null}
    {c.req.query("notice") === "restored" ? <section class="next"><strong>前の下書きに戻しました</strong><p>今の下書きも残ります。直して保存できます。</p></section> : null}
    {taskNotice && !(taskNotice.status === "done" && (project.closedAt || versions.results[0]?.published_at)) ? <Notice><span data-ai-status={taskNotice.status}>{taskNotice.message}</span>{["received", "reading", "read", "connecting"].includes(taskNotice.status) ? " 画面を閉じても続きます。ここで書いて保存することもできます。" : ""}</Notice> : null}
    {document?.stale ? <div class="notice warn"><strong>新しい資料が届きました</strong><p>このまま直して配れます。</p><a class="quiet" href="#redo">新しい資料を入れて作り直す</a></div> : null}
    {project.closedAt ? <Notice>この行事は閉じました。もう一度開くと下書きを直せます。</Notice> : null}
    <MeetingMaterialsView ward={ward} materials={meetingMaterials} />
    {reportPhotos ? <p><a class="button secondary" href={adminPath(ward, `/photos/${id}`)}>報告の写真を選ぶ・直す</a></p> : null}
    {minutes ? <a class="button secondary" href={adminPath(ward, `/close/${id}`)}>議事録を閉じて記録に残す</a> : null}
    {rota}
    <form id="draft-form" method="post" action={adminPath(ward, `/projects/${id}/draft/${kindRaw}/save`)}>
      <input type="hidden" name="based_on" value={baseVersion} />
      <div class="field"><label for="title">題</label><input id="title" name="title" value={title} maxlength={100} required /></div>
      {project.kind !== "event" ? <p>紙の見出し: {paperHeading(project.title, document?.title ?? pack.title)}</p> : null}
      {kindRaw === "duty_roster" ? <><input type="hidden" name="scope" value="space" /><p>当番表は、実行委員と班長にだけ見えます。</p></> : null}
      {kindRaw !== "duty_roster" ? ITEMS_BY_KIND[project.kind].filter((key) => ["date_time", "place", "rain_plan"].includes(key)).map(field) : null}
      <div class="field"><label for="text">{kindRaw === "announcement" && project.kind === "event" ? "案内の文" : kindRaw === "duty_roster" ? "当番表の説明" : kindRaw === "recruitment" ? "募集の文" : `${pack.title}の文`}</label><textarea id="text" name="text" rows={10} maxlength={DOCUMENT_TEXT_LIMIT}>{body.text}</textarea>{oldDates.map((date) => <p class="warn-text">文の中に前の日付「{date}」が残っています。このままでも配れます。</p>)}</div>
      {kindRaw === "duty_roster" ? (["date_time", "place", "helper_slots", "rain_plan"] as const).map(field) : null}
      <input type="hidden" name="item_content" value={body.items.find((item) => item.key === "content")?.content ?? ""} />
      {kindRaw === "duty_roster" ? body.items.filter((item) => !["date_time", "place", "helper_slots", "rain_plan", "content"].includes(item.key)).map((item) => <input type="hidden" name={`item_${item.key}`} value={item.content} />) : [...ITEMS_BY_KIND[project.kind]].filter((key) => !["date_time", "place", "rain_plan", "content"].includes(key)).sort((a, b) => Number(b === "helper_slots") - Number(a === "helper_slots")).map(field)}
      <p><button class="secondary" name="after" value="paper">保存して紙の見え方を見る</button></p><p class="muted">撮って役員のグループへ送ると、見てもらえます。まだ配っていません。</p>
      {kindRaw === "duty_roster" ? null : <details class="fold"><summary>誰に見せるかを変える</summary><div class="choice">{SCOPES.map((value) => <label><input type="radio" name="scope" value={value} checked={value === scope} /> {value === "public" ? "だれでも読める" : value === "space" ? "実行委員と班長だけ" : "役員だけ"}</label>)}</div></details>}
    </form>
    {kindRaw === "duty_roster" ? <section>
      <h2>当番の担当を直す</h2>
      <p>{project.kind === "duty" ? "去年の表があればその順で、なければ名簿の順で下書きを入れます。時間帯や担当を直せます。" : "手伝いの申し込みと、世帯の答えにある手伝いから、AIが担当の下書きを入れます。"}直した行は、AIが上書きしません。</p>
      <div class="duty-rows">{state.tables.duties.filter((row) => row.scope === "current").map((row) => <form class="panel" method="post" action={adminPath(ward, `/projects/${id}/draft/duty-row/${row.rowId}`)}>
        <label for={`slot-${row.rowId}`}>時間帯</label><input id={`slot-${row.rowId}`} name="slot" value={String(row.data.slot ?? "")} maxlength={120} required />
        <label for={`task-${row.rowId}`}>持ち場</label><input id={`task-${row.rowId}`} name="task" value={String(row.data.task ?? "")} maxlength={200} />
        <label for={`assignee-${row.rowId}`}>担当</label><input id={`assignee-${row.rowId}`} name="assignee" value={String(row.data.assignee ?? "")} maxlength={160} />
        {rotaNotes.find((entry) => entry.rowId === row.rowId)?.explanation ? <p class="help-text">{rotaNotes.find((entry) => entry.rowId === row.rowId)?.explanation}</p> : null}
        {row.data.note ? <p class="help-text">{String(row.data.note)}</p> : null}
        <fieldset><legend>出席</legend><div class="choice half">{([ ["no_change", "まだ記録しない"], ["present", "出席"], ["absent", "欠席"] ] as const).map(([value, label]) => <label><input type="radio" name="attendance" value={value} checked={value === (row.data.attendance || "no_change")} />{label}</label>)}</div></fieldset>
        <p><button type="submit" class="secondary">この行を保存する</button></p>
      </form>)}</div>
      {state.tables.duties.filter((row) => row.scope === "current").length === 0 ? <p>当番表の行はまだありません。下の紙の欄に書き込めます。</p> : null}
      <p>印刷した紙の当番表に、手で書き込むこともできます。</p>
    </section> : null}
    <details class="fold" id="previous-drafts"><summary>前の下書きに戻す</summary><div>
      {versions.results.length ? versions.results.map((version) => <section><p>{formatJstDate(version.created_at)}の{version.origin === "ai" ? "AIの下書き" : "下書き"}</p><pre>{parseBody(version.body).text}</pre>
        {!project.closedAt ? <form method="post" action={adminPath(ward, `/projects/${id}/draft/${kindRaw}/restore/${version.version_no}`)}><button class="secondary">この下書きに戻す</button></form> : null}
      </section>) : <p>前の下書きはまだありません。</p>}<p class="muted">今の下書きも残ります。</p>
    </div></details>
    {!project.closedAt ? <>
      {project.kind === "duty" && kindRaw === "duty_roster" ? null : <details class="fold" id="redo"><summary>AIに言葉で頼む</summary><div><form method="post" action={adminPath(ward, `/projects/${id}/draft/${kindRaw}/start`)}>
        <div class="field"><label for="instruction">頼むこと</label><input id="instruction" name="instruction" type="text" maxlength={800} /><p class="help-text">{project.kind === "event" ? "例: 雨のときの場所の変更を入れてください" : minutes ? "例: 送った紙から決めたことをまとめてください" : "例: 送った資料の内容を入れてください"}</p></div><button class="secondary">AIに頼む</button>
      </form></div></details>}
      <p class="muted">下のボタンを押しても、まだ配られません。次の画面で内容を確かめてから配ります。</p>
      <div class="action-bar page-action"><button type="submit" form="draft-form" name="after" value={paperFirst ? "paper" : "confirm"}>{paperFirst ? "保存して紙の見え方を見る" : "保存して配る内容を見る"}</button><button class="secondary" type="submit" form="draft-form">保存だけする</button></div>
    </> : null}
  </Layout>, retry?.status ?? 200);
}
admin.get("/projects/:projectId/draft/:kind", (c) => renderDraft(c));

async function latestFields(c: import("hono").Context<AdminEnv>, kind: DocumentKind): Promise<URLSearchParams | null> {
  const row = await c.env.DB.prepare(`SELECT d.document_id, d.scope, v.version_id, v.version_no FROM documents d
    JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = ? ORDER BY v.version_no DESC LIMIT 1`)
    .bind(c.var.ward.wardId, c.req.param("projectId"), kind).first<{ document_id: string; scope: string; version_id: string; version_no: number }>();
  if (!row) return null;
  return new URLSearchParams({ documentId: row.document_id, versionId: row.version_id, versionNo: String(row.version_no), scope: row.scope });
}
async function confirmDraft(c: import("hono").Context<AdminEnv>, kind: DocumentKind, bodyChecks: ItemKey[]): Promise<Response> {
  const fields = await latestFields(c, kind); const id = c.req.param("projectId");
  if (!fields) return c.notFound();
  const query = new URLSearchParams({ check_body: bodyChecks.join(",") });
  if (fields.get("scope") === "staff") return c.redirect(adminPath(c.var.ward, `/publish/${id}?${query}`), 303);
  if (fields.get("scope") === "public") {
    const copies = await getDistrictCopies(c.env.DB, c.var.ward.wardId);
    fields.set("distribution", copies.map((row) => `${row.district} ${row.copies}`).join("\n"));
  }
  return openPublish(c, `/publish/${id}/confirm?${query}`, fields);
}

admin.post("/projects/:projectId/draft/:kind/restore/:versionNo", async (c) => {
  const { ward, account } = c.var; const id = c.req.param("projectId"); const kindRaw = c.req.param("kind");
  if (!isKind(kindRaw)) return c.notFound();
  const versionNo = Number(c.req.param("versionNo"));
  if (!Number.isInteger(versionNo) || versionNo < 1) return c.notFound();
  const [project, current, prior] = await Promise.all([
    getProjectSummary(c.env.DB, ward.wardId, id),
    getProjectState(c.env.DB, ward.wardId, id),
    c.env.DB.prepare(`SELECT v.body, v.scope, COALESCE(v.title, d.title) AS title FROM documents d JOIN document_versions v
      ON v.ward_id = d.ward_id AND v.document_id = d.document_id
      WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = ? AND v.version_no = ?`)
      .bind(ward.wardId, id, kindRaw, versionNo).first<{ body: string; scope: Scope; title: string }>(),
  ]);
  if (!project || !current || project.closedAt || !prior) return c.notFound();
  const restored = parseBody(prior.body);
  const ok = await saveDocument(c.env.DB, ward.wardId, id, account.accountId, {
    kind: kindRaw,
    title: prior.title,
    scope: kindRaw === "duty_roster" ? "space" : prior.scope,
    body: JSON.stringify(restored),
    basedOn: project.stateVersion,
  });
  return c.redirect(`${adminPath(ward, `/projects/${id}/draft/${kindRaw}`)}?${ok ? "notice=restored" : "error=restore_failed"}`, 303);
});

admin.post("/projects/:projectId/draft/rain-notice", async (c) => {
  const { ward, account } = c.var; const id = c.req.param("projectId"); const form = await c.req.formData();
  const [project, templates] = await Promise.all([
    getProjectSummary(c.env.DB, ward.wardId, id),
    getTemplates(c.env.DB, ward.wardId),
  ]);
  if (!project || project.closedAt) return c.notFound();
  const selectedTemplate = templates.find((item) => item.id === String(form.get("templateId") ?? ""));
  const template = selectedTemplate ? rainTemplate(selectedTemplate) : undefined;
  const eventName = String(form.get("eventName") ?? "").trim();
  const place = String(form.get("place") ?? "").trim();
  const dateTime = String(form.get("dateTime") ?? "").trim();
  if (!template || !eventName || !place || !dateTime) return c.redirect(`${adminPath(ward, `/projects/${id}/draft/notice`)}?error=rain_input`, 303);
  const text = renderTemplate(template.body, { 行事名: eventName, 会場: place, 日時: dateTime });
  if (/\{[^{}]+\}/.test(text)) return c.redirect(`${adminPath(ward, `/projects/${id}/draft/notice`)}?error=rain_template`, 303);
  const state = await getProjectState(c.env.DB, ward.wardId, id);
  if (!state || !state.documents.some((document) => document.kind === "announcement" && document.publishedVersionNo !== null)) return c.notFound();
  const body = JSON.stringify({ text, items: [{ key: "place", content: place }, { key: "date_time", content: dateTime }] });
  const ok = await saveDocument(c.env.DB, ward.wardId, id, account.accountId, {
    kind: "notice", title: "雨の変更のお知らせ", scope: "public",
    body, basedOn: state.project.stateVersion,
  });
  if (!ok) return c.redirect(`${adminPath(ward, `/projects/${id}/draft/notice`)}?error=notice_save_failed`, 303);
  const saved = await latestFields(c, "notice");
  if (!saved) return c.notFound();
  saved.set("lineDelivery", form.get("lineDelivery") === "skip" ? "skip" : "send");
  const warnings = await checkPublicDraft(c.env.DB, ward.wardId, id, "notice", body);
  // 混入が見つかった時は既存の確認に出す。見つからなければ、見本の「配る」でそのまま配る。
  if (warnings.length) return openPublish(c, `/publish/${id}/confirm`, saved);
  saved.set("distribution", JSON.stringify({ mode: "district", targets: [] }));
  const response = await openPublish(c, `/publish/${id}/send`, saved);
  const destination = response.headers.get("location");
  const done = destination ? new URL(destination, c.req.url).searchParams.get("done") : null;
  if (response.status === 303 && done) return c.redirect(`${adminPath(ward, `/projects/${id}/draft/rain-sent`)}?done=${encodeURIComponent(done)}`, 303);
  return response;
});

admin.post("/projects/:projectId/draft/:kind/save", async (c) => {
  const { ward, account } = c.var; const id = c.req.param("projectId"); const kindRaw = c.req.param("kind");
  if (!isKind(kindRaw)) return c.notFound();
  const form = await c.req.formData(); const state = await getProjectState(c.env.DB, ward.wardId, id);
  if (!state) return c.notFound();
  const scopeRaw = String(form.get("scope")); if (!(SCOPES as readonly string[]).includes(scopeRaw) || (kindRaw === "duty_roster" && scopeRaw !== "space")) return c.notFound();
  const body: DraftBody = { text: String(form.get("text") ?? ""), items: ITEMS_BY_KIND[state.project.kind].map((key) => ({ key, content: String(form.get(`item_${key}`) ?? "").trim() })).filter((i) => i.content !== "") };
  const bodyChecks: ItemKey[] = [];
  const title = String(form.get("title") ?? "");
  const basedOn = String(form.get("based_on") ?? "");
  const retry = (message: string, status: 400 | 503) => renderDraft(c, { body, title, scope: scopeRaw as Scope, basedOn, message, status });
  // ブラウザの改行は1文字として数え、保存する本文の改行形式は保つ。
  if (body.text.replace(/\r\n/g, "\n").length > DOCUMENT_TEXT_LIMIT) return retry(`本文が長いため保存できませんでした。${DOCUMENT_TEXT_LIMIT}文字以内にして、もう一度保存してください。`, 400);
  if (!title.trim() || title.length > 100) return retry("題を1文字以上100文字以内で書いて、もう一度保存してください。", 400);
  if (body.items.some((item) => item.content.length > 2000)) return retry("本文以外の欄は、それぞれ2000文字以内にして、もう一度保存してください。", 400);
  let ok: boolean;
  try {
    ok = await saveDocument(c.env.DB, ward.wardId, id, account.accountId, { kind: kindRaw, title, scope: scopeRaw as Scope, body: JSON.stringify(body), basedOn: Number(basedOn) }, bodyChecks);
  } catch {
    return retry("保存を最後まで終えられませんでした。時間をおいて、もう一度保存してください。", 503);
  }
  if (!ok) return retry(state.project.closedAt ? "この行事は閉じています。段取りに戻ってもう一度開くと保存できます。" : "保存できませんでした。入力した内容を確かめて、もう一度保存してください。", 400);
  if (ok && form.get("after") === "paper") {
    const saved = await latestFields(c, kindRaw);
    if (saved) return c.redirect(adminPath(ward, `/print/${id}/${saved.get("documentId")}/${saved.get("versionNo")}/preview`), 303);
  }
  if (ok && form.get("after") === "confirm") return confirmDraft(c, kindRaw, bodyChecks);
  const query = new URLSearchParams(ok ? { notice: "saved", check_body: bodyChecks.join(",") } : { error: "save_failed" });
  return c.redirect(`${adminPath(ward, `/projects/${id}/draft/${kindRaw}`)}?${query}`, 303);
});

admin.post("/projects/:projectId/draft/duty-row/:rowId", async (c) => {
  const { ward, account } = c.var; const id = c.req.param("projectId"); const rowId = c.req.param("rowId");
  const form = await c.req.formData();
  const rawAttendance = String(form.get("attendance") ?? "no_change");
  if (rawAttendance !== "no_change" && rawAttendance !== "present" && rawAttendance !== "absent") return c.notFound();
  const data: Record<string, string> = { slot: String(form.get("slot") ?? "").trim(), task: String(form.get("task") ?? "").trim(), assignee: String(form.get("assignee") ?? "").trim() };
  if (rawAttendance !== "no_change") data.attendance = rawAttendance;
  const ok = await saveDutyRow(c.env.DB, ward.wardId, id, rowId, account.accountId, data);
  return c.redirect(`${adminPath(ward, `/projects/${id}/draft/duty_roster`)}?${ok ? "notice=saved" : "error=duty_save_failed"}`, 303);
});

admin.post("/projects/:projectId/draft/:kind/start", async (c) => {
  const { ward, account } = c.var; const id = c.req.param("projectId"); const kindRaw = c.req.param("kind");
  if (!isKind(kindRaw)) return c.notFound();
  const project = await getProjectSummary(c.env.DB, ward.wardId, id);
  if (!project || project.closedAt) return c.notFound();
  if (project.kind === "duty" && kindRaw === "duty_roster") {
    const ok = await prepareRota(c.env.DB, ward.wardId, id, account.accountId);
    return c.redirect(`${adminPath(ward, `/projects/${id}/draft/duty_roster`)}?${ok ? "notice=saved" : "error=rota_missing"}`, 303);
  }
  const pack = getDraftPack(kindRaw, project.kind);
  const form = await c.req.formData();
  const instruction = String(form.get("instruction") ?? "").trim().slice(0, 800);
  try {
    const contact = await getPublicContact(c.env.DB, ward.wardId);
    const helpers = pack.kind === "duty_roster" ? await getDutyDraftHelpers(c.env.DB, ward.wardId, id) : [];
    const helperInstruction = helpers.length
      ? `\n答えから集めた手伝いの希望（この一覧を当番表の下書きに含めてください）: ${JSON.stringify(helpers)}`
      : "\n答えに手伝いの希望はまだありません。";
    const start = project.kind === "event" ? startTask : startMaterialDraft;
    const materials = project.kind === "event" ? "" : await draftMaterials(c.env.DB, ward.wardId, id);
    const meetingMaterials = pack.kind === "procedure" ? meetingMaterialInstruction(await getMeetingMaterials(c.env.DB, ward.wardId, project)) : "";
    await start(c.env, c.executionCtx, { wardId: ward.wardId, projectId: id, task: "draft", instruction: `${pack.instruction}${contact ? `\n区の公開用の連絡先（問い合わせ先に使う）: ${contact}` : ""}${instruction ? `\n役員からの頼み: ${instruction}` : ""}\n対象の文書: ${pack.kind}。範囲: ${pack.scope}。dataにpack_versionを${pack.version}、based_on_state_versionを引いた状態の番号として含めてください。${pack.kind === "duty_roster" ? helperInstruction : ""}${materials}${meetingMaterials}`, accountId: account.accountId });
    return c.redirect(`${adminPath(ward, `/projects/${id}/draft/${kindRaw}`)}?notice=started`, 303);
  } catch { return c.redirect(`${adminPath(ward, `/projects/${id}/draft/${kindRaw}`)}?error=ai_failed`, 303); }
});

export { admin as draftAdmin };
export const draft: Bundle = { admin };
