import { Hono } from "hono";
import { adminPath } from "../core/auth";
import { ErrorNotice, Layout, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { getProjectState } from "./api";
import { ITEM_LABEL, isItemKey } from "./model";

/** 保存済みの選択肢の値は保ち、資料の年を聞く言葉だけ揃える。 */
export function questionOptionLabel(option: string): string {
  if (["今年のもの", "今年の資料"].includes(option)) return "今年のもの";
  if (["去年のもの", "去年の資料", "去年かそれより前", "去年か、それより前"].includes(option)) return "去年か、それより前のもの";
  return option;
}

export const questionPages = new Hono<AdminEnv>();
questionPages.get("/projects/:projectId/questions/:questionId/compare", async (c) => {
  const { ward } = c.var; const id = c.req.param("projectId");
  const state = await getProjectState(c.env.DB, ward.wardId, id);
  const question = state?.questions.find((question) => question.questionId === c.req.param("questionId") && question.kind === "conflict");
  if (!state || !question) return c.notFound();
  const fromDraft = c.req.query("from") === "draft";
  const back = adminPath(ward, fromDraft ? `/projects/${id}/draft/announcement` : `/projects/${id}/questions`);
  const currentValue = question.target && isItemKey(question.target) ? state.items.find((item) => item.key === question.target)?.current?.content : "";
  return c.html(<Layout title="二つを見比べる" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={back}>← {fromDraft ? "下書きへ" : "質問へ"}</a><h1>{question.text}</h1><p class="lead">使う方を選んでください。選ばないときは、{currentValue ? `今の下書きの${currentValue}` : "今の内容"}のままです。</p>
    {state.project.closedAt ? <Notice>この行事は閉じました。もう一度開くと答えを入れられます。</Notice> : <form method="post" action={adminPath(ward, `/projects/${id}/questions/${question.questionId}`)}>
      {fromDraft ? <input type="hidden" name="from" value="draft" /> : null}
      <fieldset><legend>使う内容</legend>{question.options?.length ? question.options.map((option) => <label><input type="radio" name="answer" value={option} required />{questionOptionLabel(option)}</label>) : <><p class="preserve-lines">{question.answer}</p><label for="answer">確かめた内容</label><input id="answer" name="answer" required maxlength={2000} /></>}</fieldset>
      {question.source?.kind === "original" && question.source.ref ? <p><a class="quiet" href={adminPath(ward, `/intake/originals/${encodeURIComponent(question.source.ref)}`)}>元の資料を見る</a></p> : null}
      <button name="action" value="answer">{question.target && isItemKey(question.target) ? "この内容を下書きに入れる" : "この答えを残す"}</button>
    </form>}
  </Layout>);
});
questionPages.get("/projects/:projectId/questions", async (c) => {
  const { ward } = c.var; const id = c.req.param("projectId");
  const state = await getProjectState(c.env.DB, ward.wardId, id);
  if (!state) return c.notFound();
  const questions = [...state.questions].sort((a, b) => Number(a.state === "later") - Number(b.state === "later"));
  const answered = c.req.query("notice") === "answered";
  const next = <section class="next"><strong>{answered ? "答えを残しました" : "次は"}</strong>
    <p>{questions.length ? "残りの質問に答えられます。答えなくても配れます。" : "質問はありません。あとから下書きで直せます。"}</p>
    <a class="button" href={questions[0] ? `#question-${questions[0].questionId}` : adminPath(ward, `/projects/${id}/draft/announcement`)}>{questions.length ? "残りの質問に答える" : "案内の下書きを見る"}</a>
  </section>;
  return c.html(<Layout title="質問に答える" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, `/projects/${id}/map`)}>← {state.project.title}の段取りへ</a>
    <h1>分かるものだけ答えてください</h1><p class="lead">答えなくても配れます。</p>
    <ErrorNotice code={c.req.query("error")} messages={{ answer_failed: "答えを入れられませんでした。もう一度お試しください。" }} />
    {c.req.query("notice") === "unknown" ? <Notice>分からないとして残しました。あとから下書きで直せます。</Notice> : c.req.query("notice") === "later" ? <Notice>あとで答えられるように残しました。</Notice> : null}
    {!questions.length || answered ? next : null}
    {state.project.closedAt ? <Notice>この行事は閉じました。もう一度開くと答えを入れられます。</Notice> : null}
    {questions.map((question) => <section class="panel" id={`question-${question.questionId}`}>
      <h2>{question.kind === "unreadable" ? "読めなかったところがあります" : question.text}</h2>
      {question.kind === "unreadable" ? <p>{question.text}</p> : null}
      {question.source?.locator ? <p class="muted">{question.source.locator}</p> : null}
      {question.kind === "conflict" ? <p><a class="button secondary" href={adminPath(ward, `/projects/${id}/questions/${question.questionId}/compare`)}>二つを見比べる</a></p> : null}
      {!state.project.closedAt ? <form method="post" action={adminPath(ward, `/projects/${id}/questions/${question.questionId}`)}>
        {question.options?.length ? <div class="action-links">{question.options.map((option) => <button class="secondary" name="answer" value={option}>{questionOptionLabel(option)}</button>)}</div> : <>
          <div class="field"><label for={`answer-${question.questionId}`}>{isItemKey(question.target) ? ITEM_LABEL[question.target] : question.text.includes("金額") ? "金額" : "答え"}</label><input id={`answer-${question.questionId}`} name="answer" maxlength={2000} inputmode={question.text.includes("金額") ? "numeric" : undefined} /></div>
          <div class="action-links"><button class="secondary" name="action" value="answer">{question.text.includes("金額") ? "この金額を入れる" : "答える"}</button></div>
        </>}
        <div class="question-actions">{question.source?.kind === "original" && question.source.ref ? <a class="quiet" href={adminPath(ward, `/intake/originals/${encodeURIComponent(question.source.ref)}`)}>元の資料を見る</a> : null}
          <button class="quiet" name="action" value="unknown">分からない</button><button class="quiet" name="action" value="later">あとで</button>
        </div>
      </form> : null}
    </section>)}
    {questions.length ? <><p class="muted">答えは下書きに入ります。あとから直せます。</p>{answered ? null : <div class="action-bar"><a class="button" href={adminPath(ward, `/projects/${id}/draft/announcement`)}>案内の下書きを見る</a></div>}</> : null}
  </Layout>);
});
