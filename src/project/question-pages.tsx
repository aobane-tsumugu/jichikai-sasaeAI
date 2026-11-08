import { taskFeatures } from "./task-features";
import { Hono } from "hono";
import { adminPath } from "../core/auth";
import { ErrorNotice, Layout, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { getProjectState } from "./api";
import { DOCUMENT_KINDS, ITEM_SCREEN_LABEL, isItemKey, type DocumentKind } from "./model";
import type { QuestionView } from "./types";
import { referenceConflictItems, type ReferenceConflictDetail } from "./questions-original-reference";
import { pairCaptions, savedComparison } from "../ai/compare-originals";
import { answerMaterialExemption, EXEMPTION_TARGET, EXEMPTION_YES, EXEMPTION_NO, EXEMPTION_REASON_MAX, readMaterialExemption } from "../rota/material-exemptions";

/** 保存済みの選択肢の値は保ち、資料の年を聞く言葉だけ揃える。 */
export function questionOptionLabel(option: string): string {
  if (["今年のもの", "今年の資料"].includes(option)) return "今年のもの";
  if (["去年のもの", "去年の資料", "去年かそれより前", "去年か、それより前"].includes(option)) return "去年か、それより前のもの";
  return option;
}

/** 長い質問は、短い見出しと本文に分ける。保存済みの質問の文もこの形で読む。 */
function questionTitle(question: QuestionView): { heading: string; body: string } {
  if (question.options?.some((option) => questionOptionLabel(option) === "今年のもの")) return { heading: "この資料は今年のものですか", body: question.text };
  if (question.kind === "unreadable") return { heading: "読めなかったところがあります", body: question.text };
  if (question.kind === "conflict" && question.text.includes("で、次の項目が違います。")) return {
    heading: "資料によって違うところがあります", body: question.text,
  };
  if (question.kind === "conflict" && isItemKey(question.target)) return {
    heading: `「${ITEM_SCREEN_LABEL[question.target]}」が${question.text.includes("下書きの本文と項目") ? "下書きの本文と項目で" : "資料によって"}違います`,
    body: question.text.replace(/^「[^」]*」が食い違っています。/, "").replace("年の書いていない", "年の書かれていない"),
  };
  return { heading: question.text, body: "" };
}

/** 一覧に出す一行。読めなかった所は何が読めなかったかを、ほかは見出しを出す。 */
export function questionShort(question: QuestionView): string {
  const { heading, body } = questionTitle(question);
  if (question.kind !== "unreadable" || heading !== "読めなかったところがあります") return heading;
  const sentence = body.split("。")[0]!.trim();
  return sentence.length > 40 ? `${sentence.slice(0, 40)}…` : sentence;
}

export const questionPages = new Hono<AdminEnv>();
questionPages.post("/projects/:projectId/questions/:questionId/exemption", async (c) => {
  const form = await c.req.formData();
  const id = c.req.param("projectId");
  const action = String(form.get("action") ?? "");
  const result = await answerMaterialExemption(c.env.DB, c.var.ward.wardId, id, c.req.param("questionId"),
    c.var.account.accountId, action, String(form.get("reason") ?? ""));
  const query = result === "failed" ? "error=exemption_answer_failed" : result === "draft_failed" ? "error=exemption_draft_failed"
    : `notice=${action === EXEMPTION_YES ? "exempted" : action === EXEMPTION_NO ? "kept" : action}`;
  return c.redirect(`${adminPath(c.var.ward, `/projects/${id}/questions`)}?${query}`, 303);
});
questionPages.get("/projects/:projectId/questions/:questionId/compare", async (c) => {
  const { ward } = c.var; const id = c.req.param("projectId");
  const state = await getProjectState(c.env.DB, ward.wardId, id);
  const question = state?.questions.find((question) => question.questionId === c.req.param("questionId") && question.kind === "conflict");
  if (!state || !question) return c.notFound();
  const stored = await c.env.DB.prepare("SELECT detail FROM project_questions WHERE ward_id = ? AND project_id = ? AND question_id = ?")
    .bind(ward.wardId, id, question.questionId).first<{ detail: string | null }>();
  let draftKind: DocumentKind = "announcement";
  let reference = false;
  let referenceDetail: ReferenceConflictDetail = {};
  let comparisonIds: string[] = [];
  let comparisonText = "";
  try {
    const detail = JSON.parse(stored?.detail ?? "{}") as ReferenceConflictDetail & { documentKind?: DocumentKind; comparisonKey?: string; comparisonText?: string };
    referenceDetail = detail;
    try { comparisonIds = detail.comparisonKey ? (JSON.parse(detail.comparisonKey) as unknown[]).filter((id): id is string => typeof id === "string") : []; } catch { comparisonIds = []; }
    comparisonText = typeof detail.comparisonText === "string" ? detail.comparisonText : "";
    reference = detail.scope === "reference";
    if (detail.documentKind && DOCUMENT_KINDS.includes(detail.documentKind)) draftKind = detail.documentKind;
  } catch { /* 古い質問は案内へ戻る。 */ }
  const fromDraft = c.req.query("from") === "draft";
  const back = adminPath(ward, fromDraft ? `/projects/${id}/draft/${draftKind}` : `/projects/${id}/questions`);
  // 二つの資料を比べた結果があれば、違うところと手がかりを並べる（撮影の側の気づき）。問いの文に重ねていた比べの文は、ここでは外す。
  const comparison = await savedComparison(c.env.DB, ward.wardId, id, comparisonIds);
  const captions = comparison ? pairCaptions(comparison) : null;
  const body = comparison && comparisonText ? questionTitle(question).body.replace(comparisonText, "").trim() : questionTitle(question).body;
  return c.html(<Layout title={(question.options?.length ?? 0) > 2 ? "資料を見比べる" : "二つを見比べる"} siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={back}>← {fromDraft ? "下書きへ" : "質問へ"}</a><h1>{questionTitle(question).heading}</h1><p class="lead">{!isItemKey(question.target) ? "当てはまるものを選んでください。" : reference ? "過去の資料の中身に残すものを選んでください。今年の中身は変わりません。" : "今年使う内容を選んでください。答えるまで資料のどれかを今年の中身には入れません。"}</p>
    <p>{body}</p>
    {comparison && captions ? <section class="panel"><h2>二つの資料の違うところ</h2>
      {comparison.result.differences.length ? <ul>{comparison.result.differences.map((difference) => <li>{difference}</li>)}</ul> : <p>違うところは、読み取りからは分かりませんでした。</p>}
      {comparison.result.clues.length ? <><h3>どちらが新しいかの手がかり</h3><ul>{comparison.result.clues.map((clue) => <li>{clue}</li>)}</ul></> : null}
      <p>{comparison.result.assessment}</p>
      <ul class="links">{comparison.originals.map((original, index) => <li><a href={adminPath(ward, `/intake/originals/${encodeURIComponent(original.original_id)}`)}>{captions[index]}を見る</a></li>)}</ul>
    </section> : null}
    {reference ? referenceConflictItems(referenceDetail).map((item) => <section class="panel">
      <h2>{ITEM_SCREEN_LABEL[item.itemKey]}</h2>
      <dl>{item.options.map((value, index) => <><dt>{referenceDetail.originals?.find((original) => original.originalId === item.sources[index]?.ref)?.description ?? `${index + 1}つ目の資料`}</dt><dd class="preserve-lines">{value}</dd></>)}</dl>
    </section>) : null}
    {state.project.closedAt ? <Notice>{state.project.title}は終わりにしました。終わりを取り消すと答えを入れられます。</Notice> : <form method="post" action={adminPath(ward, `/projects/${id}/questions/${question.questionId}`)}>
      {fromDraft && draftKind === "announcement" ? <input type="hidden" name="from" value="draft" /> : null}
      <fieldset><legend>{reference && referenceDetail.items ? "最後の資料" : "使う内容"}</legend>{question.options?.length ? question.options.map((option) => <label><input type="radio" name="answer" value={option} required />{questionOptionLabel(option)}</label>) : <><p class="preserve-lines">{question.answer}</p><label for="answer">確かめた内容</label><input id="answer" name="answer" required maxlength={2000} /></>}</fieldset>
      {question.source?.kind === "original" && question.source.ref ? <p><a class="quiet" href={adminPath(ward, `/intake/originals/${encodeURIComponent(question.source.ref)}`)}>元の資料を見る</a></p> : null}
      <button name="action" value="answer">{reference ? "過去の資料の中身に残す" : question.target && isItemKey(question.target) ? "この内容を下書きに入れる" : "この答えを残す"}</button>
    </form>}
  </Layout>);
});
questionPages.get("/projects/:projectId/questions", async (c) => {
  const { ward } = c.var; const id = c.req.param("projectId");
  const state = await getProjectState(c.env.DB, ward.wardId, id);
  if (!state) return c.notFound();
  const questions = [...state.questions].sort((a, b) => Number(a.state === "later") - Number(b.state === "later"));
  const stored = questions.some((question) => question.target?.startsWith(EXEMPTION_TARGET))
    ? await c.env.DB.prepare(`SELECT question_id, detail FROM project_questions
      WHERE ward_id = ? AND project_id = ? AND target LIKE 'rota_exemption:%' AND state IN ('open', 'later')`)
      .bind(ward.wardId, id).all<{ question_id: string; detail: string | null }>() : null;
  const exemptions = new Map(stored?.results.map((row) => [row.question_id, readMaterialExemption(row.detail)]));
  const photoIds = [...new Set(questions.flatMap((question) => question.source?.kind === "original" && question.source.ref ? [question.source.ref] : []))];
  const photos = new Set((await Promise.all(photoIds.map((photoId) => c.env.DB.prepare("SELECT original_id FROM originals WHERE ward_id = ? AND original_id = ? AND media_type LIKE 'image/%'").bind(ward.wardId, photoId).first<{ original_id: string }>()))).flatMap((row) => row ? [row.original_id] : []));
  let shownPhoto = "";
  const duty = taskFeatures(state.mapTasks).has("assign");
  // 当日が過ぎた行事は、答えが報告に入る。次は案内や当番表でなく、報告をまとめて終わりにすること。
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
  const passed = !state.project.closedAt && Boolean(state.project.deadlines.event_day && state.project.deadlines.event_day < today);
  const draftHref = adminPath(ward, passed ? `/close/${id}` : `/projects/${id}/draft/${duty ? "duty_roster" : "announcement"}`);
  const draftLabel = passed ? "報告をまとめて終わりにする" : duty ? "当番表の下書きを見る" : "案内の下書きを見る";
  const answered = c.req.query("notice") === "answered";
  const next = <section class="next"><strong>{answered ? "答えを残しました" : "次は"}</strong>
    <p>{questions.length ? "残りの質問に答えられます。" : answered ? (passed ? "AIからの質問は、もうありません。答えは報告の下書きに使われます。終わりにする画面で直せます。" : "AIからの質問は、もうありません。答えは下書きに使われます。下書きであとから直せます。") : "AIが資料を読んで分からないところがあると、ここで聞きます。今は聞くことはありません。"}</p>
    <a class="button" href={questions[0] ? `#question-${questions[0].questionId}` : draftHref}>{questions.length ? "残りの質問に答える" : draftLabel}</a>
  </section>;
  return c.html(<Layout title="質問に答える" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, `/projects/${id}/map`)}>← {state.project.title}のやることへ</a>
    <h1>{questions.length ? `${state.project.title}について、AIからの質問が${questions.length}つあります` : `${state.project.title}について、AIからの質問はありません`}</h1>{questions.length ? <p class="lead">分かるものだけ答えてください。{passed ? "答えると、報告と来年への一言の下書きに入ります。答えなくても終わりにできます。" : "答えなくても、案内は住民に知らせられます。"}</p> : null}
    <ErrorNotice code={c.req.query("error")} messages={{ answer_failed: "答えを入れられませんでした。もう一度お試しください。", exemption_answer_failed: "免除の答えを入れられませんでした。理由は200文字までです。すでに答えていないか、下の質問を確かめてください。", exemption_draft_failed: "免除は記録しました。当番表の下書きを開き、「今の名簿と免除を下書きに反映する」を押してください。" }} />
    {c.req.query("notice") === "exempted" ? <Notice>今年の当番の免除を記録しました。役員が直した担当と知らせた内容はそのままです。下書きで担当を確かめられます。<p><a class="button secondary" href={adminPath(ward, "/rota/exemptions")}>免除の記録を見る・取り消す</a></p></Notice> : c.req.query("notice") === "kept" ? <Notice>当番から外さず、答えを残しました。</Notice> : null}
    {c.req.query("notice") === "unknown" ? <Notice>分からないとして残しました。あとから下書きで直せます。</Notice> : c.req.query("notice") === "later" ? <Notice>あとで答えられるように残しました。</Notice> : null}
    {!questions.length ? next : null}
    {state.project.closedAt ? <Notice>{state.project.title}は終わりにしました。終わりを取り消すと答えを入れられます。</Notice> : null}
    {questions.map((question) => {
      const exemption = exemptions.get(question.questionId);
      const photo = question.source?.kind === "original" && question.source.ref && photos.has(question.source.ref) ? question.source.ref : "";
      const showPhoto = photo && photo !== shownPhoto;
      if (photo) shownPhoto = photo;
      return <section class="panel" id={`question-${question.questionId}`}>
      {showPhoto ? <a href={adminPath(ward, `/intake/originals/${encodeURIComponent(photo)}`)}><img class="photo-full" src={`${adminPath(ward, `/intake/originals/${encodeURIComponent(photo)}`)}?raw=1`} alt="質問のある写真" loading="lazy" /></a> : null}
      <h2>{questionTitle(question).heading}</h2>
      {questionTitle(question).body ? <p>{questionTitle(question).body}</p> : null}
      {question.source?.locator && question.source.locator !== "写真の確認" ? <p class="muted">{question.source.locator}</p> : null}
      {question.kind === "conflict" ? <p><a class="button secondary" href={adminPath(ward, `/projects/${id}/questions/${question.questionId}/compare`)}>{(question.options?.length ?? 0) > 2 ? "資料を見比べる" : "二つを見比べる"}</a></p> : null}
      {!state.project.closedAt ? <form method="post" action={adminPath(ward, `/projects/${id}/questions/${question.questionId}${exemption ? "/exemption" : ""}`)}>
        {exemption ? <>
          <p>資料に免除の記述があるようです。{exemption.district}の{exemption.household}さんについて、{exemption.year}年の当番から外すか選べます。選ばないときは今のままです。</p>
          <label for={`reason-${question.questionId}`}>免除の理由（資料の文を直せます）</label>
          <textarea id={`reason-${question.questionId}`} name="reason" maxlength={EXEMPTION_REASON_MAX} rows={3}>{exemption.reason}</textarea>
          <p>理由は役員だけが読みます。外す期間はこの年の1月1日から12月31日までです。</p>
          <div class="action-links"><button name="action" value={EXEMPTION_YES}>{EXEMPTION_YES}</button><button class="secondary" name="action" value={EXEMPTION_NO}>{EXEMPTION_NO}</button></div>
        </> : question.options?.length ? <div class="action-links">{question.options.map((option) => <button class="secondary" name="answer" value={option}>{questionOptionLabel(option)}</button>)}</div> : <>
          <div class="field"><label for={`answer-${question.questionId}`}>{isItemKey(question.target) ? ITEM_SCREEN_LABEL[question.target] : question.text.includes("金額") ? "金額" : "答え"}</label><input id={`answer-${question.questionId}`} name="answer" maxlength={2000} inputmode={question.text.includes("金額") ? "numeric" : undefined} /></div>
          <div class="action-links"><button class="secondary" name="action" value="answer">{question.text.includes("金額") ? "この金額を入れる" : "答える"}</button></div>
        </>}
        <div class="question-actions">{question.source?.kind === "original" && question.source.ref && !photo ? <a class="quiet" href={adminPath(ward, `/intake/originals/${encodeURIComponent(question.source.ref)}`)}>元の資料を見る</a> : null}
          <button class="quiet" name="action" value="unknown">分からない</button><button class="quiet" name="action" value="later">あとで</button>
        </div>
      </form> : null}
    </section>;
    })}
    {questions.length ? <><p class="muted">{exemptions.size ? "免除は免除の記録から取り消せます。" : passed ? "答えは、終わりにする画面に戻ったときに、報告と来年への一言の下書きに入ります。あとから直せます。" : "答えは下書きに入ります。あとから直せます。"}</p>{answered ? next : <div class="action-bar"><a class="button" href={draftHref}>{draftLabel}</a></div>}</> : null}
  </Layout>);
});
