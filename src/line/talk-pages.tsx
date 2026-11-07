import { Hono, type Context } from "hono";
import type { AdminEnv } from "../env";
import { adminPath } from "../core/auth";
import { Layout, Notice, Hint } from "../core/ui";
import { adminResult } from "../core/admin-ui";
import { formatJst } from "../core/time";
import { getOriginal, jobSummaries, rosterCandidates } from "../intake/store";
import { WardBucket } from "../core/storage";
import { listKnowItems } from "../know/store";
import { PROJECT_KINDS, PROJECT_KIND_LABEL } from "../project/model";
import { questionOptionLabel } from "../project/question-pages";
import { listClarifications, type ClarificationRow } from "./clarifications";
import { listTalks, conversationFor, talkPath, topicAnchor, type TalkTopic } from "./talks";
import { changeBoundary, checkEditable, editTopic, saveUndo, undoTalk } from "./talk-edits";

export const talkAdmin = new Hono<AdminEnv>();
const waitable = (c: Context<AdminEnv>) => { try { return c.executionCtx; } catch { return { waitUntil: () => undefined }; } };
const clock = (at: string) => formatJst(at).match(/\d{1,2}:\d{2}/)?.[0] ?? formatJst(at);

function actionText(topic: TalkTopic, names: Map<string, string>) {
  const decision = topic.decision;
  const name = names.get(decision?.project_id ?? topic.posts[0]?.projectId ?? "");
  switch (decision?.action ?? (topic.inquiry ? "inquiry" : "material")) {
    case "reference": return `→ ${name ? `${name}の参考にしました。` : "参考にしました。"}`;
    case "inquiry": return `→ 問い合わせにしました。${topic.inquiry?.answer ? "返事を残しました。" : "返事はまだです。"}`;
    case "know": return "→ 自治会の基本情報にしました。";
    case "unrelated": return "→ 関係ないものにしました。直すと戻せます。";
    case "confirm_share": return "→ 住民に知らせるか、まだ決めていません。";
    case "confirm_purpose": return "→ 写真と言葉を確認しています。";
    default: return `→ ${name ? `${name}の資料にしました。` : "自治会の資料にしました。"}`;
  }
}

function Question({ question, ward, back, choices }: { question: ClarificationRow; ward: AdminEnv["Variables"]["ward"]; back: string; choices: string[] }) {
  const conflict = choices.length > 1 && !choices.includes(question.answer ?? "");
  return <div class="question-block"><p><strong>AIからの質問</strong>　{question.text}</p>
    {question.answer ? <p class="preserve-lines">答え: {question.answer}</p> : null}
    {!question.answer || conflict ? <form method="post" action={adminPath(ward, `/inbox/questions/${encodeURIComponent(question.id)}`)}>
      <input type="hidden" name="back" value={back} />
      {conflict ? <fieldset><legend>違う答えが届いています。使う内容を選べます。</legend>{choices.map((answer) => <label><input type="radio" name="answer" value={answer} required />{answer}</label>)}</fieldset>
        : question.options.length > 1 ? <div class="action-links">{question.options.map((option) => <button class="secondary" name="answer" value={option}>{questionOptionLabel(option)}</button>)}</div>
        : <><label for={`answer-${question.id}`}>分かるところを書いてください</label><input id={`answer-${question.id}`} name="answer" maxlength={2000} /></>}
      {conflict || question.options.length <= 1 ? <button class="secondary">この答えを残す</button> : null}
      {!conflict ? <button class="quiet" name="unknown" value="1">分からない</button> : null}
    </form> : null}
  </div>;
}

talkAdmin.get("/inbox", async (c) => {
  const { ward } = c.var;
  const talks = await listTalks(c.env.DB, ward.wardId, { withText: false });
  return c.html(<Layout title="届いたもの" siteName={ward.name} adminHomeHref={adminPath(ward, "/")} noindex>
    <a class="back" href={adminPath(ward, "/")}>← 最初の画面へ</a><h1>届いたもの</h1>
    <p class="lead">トークを開くと、届いた写真と言葉を送られた順に見て、その場で直せます。</p>
    {c.req.query("error") ? <Notice error>直せませんでした。トークを開いて、もう一度直してください。</Notice> : null}
    {talks.length ? <ul class="rows">{talks.map((talk) => <li><a class="row-link" href={adminPath(ward, talkPath(talk.id))}>
      <b>{talk.name}</b><span>最後に届いたとき: {formatJst(talk.at)}</span><span>答えを待っている質問: {talk.waiting}</span>
    </a></li>)}</ul> : <Notice>届いたものはありません。</Notice>}
    <a class="button secondary" href={adminPath(ward, "/intake")}>資料を送る</a>
  </Layout>);
});

talkAdmin.get("/inbox/talks/:talkId", async (c) => {
  const { ward } = c.var;
  const talk = (await listTalks(c.env.DB, ward.wardId)).find((t) => t.id === c.req.param("talkId"));
  if (!talk) return c.notFound();
  const [projects, questions, summaries, know, roster, undo] = await Promise.all([
    c.env.DB.prepare("SELECT project_id, title, closed_at FROM projects WHERE ward_id = ? ORDER BY created_at DESC")
      .bind(ward.wardId).all<{ project_id: string; title: string; closed_at: string | null }>(),
    listClarifications(c.env.DB, ward.wardId), jobSummaries(c.env.DB, ward.wardId), listKnowItems(c.env.DB, ward.wardId),
    rosterCandidates(c.env.DB, ward.wardId), c.env.DB.prepare("SELECT undo_id FROM line_talk_undo WHERE ward_id = ? AND talk_id = ?")
      .bind(ward.wardId, talk.id).first<{ undo_id: string }>(),
  ]);
  const answers = await c.env.DB.prepare("SELECT clarification_id, answer_text FROM line_clarification_answers WHERE ward_id = ?")
    .bind(ward.wardId).all<{ clarification_id: string; answer_text: string }>();
  const names = new Map(projects.results.map((p) => [p.project_id, p.title]));
  const path = adminPath(ward, talkPath(talk.id));
  return c.html(<Layout title={talk.name} siteName={ward.name} adminHomeHref={adminPath(ward, "/")} noindex>
    <a class="back" href={adminPath(ward, "/inbox")}>← 届いたものへ</a><h1>{talk.name}</h1>
    <p class="lead">届いた順に読めます。違うところは「直す」から書き直せます。</p>
    <p>関係のない会話は残していません</p>
    {c.req.query("n") === "undone" ? <div id="result"><Notice>元に戻しました。続けて会話を読めます。</Notice></div> : null}
    {undo ? <form method="post" action={`${path}/undo`}><input type="hidden" name="undoId" value={undo.undo_id} /><button class="secondary">直す前に戻す</button></form> : null}
    <style>{`.talk-topic{border:2px solid #82988c;border-radius:12px;padding:16px;margin:24px 0;overflow-wrap:anywhere}.talk-post{padding:16px 0;border-bottom:1px solid #d4ded7}.talk-photo{display:block;width:min(100%,220px);max-height:220px;object-fit:contain}.talk-topic input,.talk-topic select,.talk-topic textarea{max-width:100%;box-sizing:border-box}.talk-topic p,.talk-topic label,.talk-topic summary,.talk-topic button,.talk-topic time{font-size:18px}.talk-decision{font-size:20px;line-height:1.8}.talk-topic fieldset{min-width:0}`}</style>
    {talk.topics.map((topic) => {
      const photos = topic.posts.reduce((sum, p) => sum + p.originals.filter((o) => o.media_type.startsWith("image/")).length, 0);
      const words = topic.posts.some((p) => p.text);
      const first = topic.posts[0]!;
      const last = topic.posts[topic.posts.length - 1]!;
      const summary = topic.decision?.summary || (topic.inquiry ? `住民からの質問（${first.text}）です。` : summaries.get(first.jobId ?? "")?.split("\n")[0]) || "届いた写真と言葉です。";
      const back = `${path}#${topic.anchor}`;
      const current = topic.decision?.project_id ?? first.projectId;
      const action = topic.decision?.action ?? (topic.inquiry ? "inquiry" : "material");
      const edit = `${path}/topics/${topic.anchor.slice(6)}`;
      return <section class="talk-topic" id={topic.anchor}>
        {c.req.query("at") === topic.anchor.slice(6) ? <><Notice>{c.req.query("n") === "answered" ? "答えを残しました。続けて会話を読めます。" : `${actionText(topic, names).replace("→ ", "")}続けて会話を読めます。`}</Notice>
          {undo ? <form method="post" action={`${path}/undo`}><input type="hidden" name="undoId" value={undo.undo_id} /><button class="secondary">直す前に戻す</button></form> : null}</> : null}
        {topic.posts.map((post) => <article class="talk-post" id={`post-${post.id}`}>
          <p><strong>{post.sender}</strong>　<time datetime={post.at}>{formatJst(post.at)}</time></p>
          {post.text ? <p class="preserve-lines">{post.text}</p> : null}
          {post.originals.map((original) => {
            const source = adminPath(ward, `/intake/originals/${encodeURIComponent(original.original_id)}`);
            const photo = original.media_type.startsWith("image/");
            return <div>{photo ? <a href={source}><img class="talk-photo" src={`${source}?raw=1`} alt="届いた写真。押すと大きく見られます" loading="lazy" /></a>
              : original.kind !== "text" ? <p><a class="button secondary" href={source}>{original.filename || "届いた資料"}を開く</a></p> : null}
              {questions.filter((q) => q.original_id === original.original_id).map((question) => <Question question={question} ward={ward} back={back}
                choices={[...new Set(answers.results.filter((a) => a.clarification_id === question.id).map((a) => a.answer_text))]} />)}
            </div>;
          })}
          {post.jobId && roster.includes(post.jobId) ? <div><p>この資料で、世帯の名簿を入れ直しますか？</p><a class="button secondary" href={`${adminPath(ward, "/answers/roster")}?job=${encodeURIComponent(post.jobId)}`}>入れ直す</a>
            <form method="post" action={adminPath(ward, `/inbox/roster/${post.jobId}/skip`)}><button class="quiet">入れ直さない</button></form></div> : null}
        </article>)}
        <p class="talk-decision">{clock(first.at)}{first.at !== last.at ? `〜${clock(last.at)}` : ""}の{photos ? `写真${photos}枚${words ? "と言葉" : ""}` : "言葉"}: {summary} {actionText(topic, names)}</p>
        {topic.inquiry && action === "inquiry" ? <p><a class="button secondary" href={adminPath(ward, `/inquiries/${topic.inquiry.inquiry_id}`)}>返事を書く</a></p> : null}
        <details class="fold"><summary>直す</summary><div>
          <form method="post" action={edit}>
            <label for={`summary-${topic.anchor}`}>何の話か</label><input id={`summary-${topic.anchor}`} name="summary" value={summary} maxlength={500} required />
            <label for={`action-${topic.anchor}`}>どうするか</label><select id={`action-${topic.anchor}`} name="action">
              <option value="material" selected={action === "material" || action === "confirm_purpose" || action === "confirm_share"}>資料にする</option>
              <option value="reference" selected={action === "reference"}>参考にする</option><option value="inquiry" selected={action === "inquiry"}>問い合わせ</option>
              <option value="know" selected={action === "know"}>自治会の基本情報</option><option value="unrelated" selected={action === "unrelated"}>関係ない</option>
            </select>
            <label for={`project-${topic.anchor}`}>どれの資料・参考にするか</label><select id={`project-${topic.anchor}`} name="projectId">
              <option value="">自治会の資料</option>{projects.results.filter((p) => !p.closed_at || p.project_id === current).map((project) => <option value={project.project_id} selected={project.project_id === current}>{project.title}</option>)}
              <option value="new">新しく準備を始める</option></select>
            <details class="fold"><summary>新しく準備を始めるとき</summary><div><label for={`name-${topic.anchor}`}>名前</label><input id={`name-${topic.anchor}`} name="projectName" maxlength={100} />
              <label for={`kind-${topic.anchor}`}>何の準備ですか</label><select id={`kind-${topic.anchor}`} name="kind">{PROJECT_KINDS.map((kind) => <option value={kind}>{PROJECT_KIND_LABEL[kind]}</option>)}</select></div></details>
            <details class="fold"><summary>自治会の基本情報にするとき</summary><div><label for={`know-${topic.anchor}`}>どの内容か</label><select id={`know-${topic.anchor}`} name="knowId">{know.items.map((item) => <option value={item.id}>{item.title}</option>)}</select></div></details>
            <Hint text="すでに下書きに入った内容は残ることがあります。別の資料や参考に直したときは、住民に知らせる前に下書きを見て直してください。" />
            <button>この内容に直す</button>
          </form>
          <h2>どこからどこまでか</h2>
          {topic.posts.map((post, index) => { const previous = talk.posts[talk.posts.indexOf(post) - 1]; return <form method="post" action={`${edit}/boundary`}>
            <input type="hidden" name="postId" value={post.id} /><p>{clock(post.at)}　{post.text.slice(0, 50) || "届いた写真や資料"}</p>
            {previous && previous.bundleId !== topic.id ? <button class="secondary" name="operation" value="join">前の話題に入れる</button> : null}
            {index > 0 ? <button class="secondary" name="operation" value="split">ここで分ける</button> : null}
          </form>; })}
        </div></details>
      </section>;
    })}
    <div id="latest"><a class="quiet" href={adminPath(ward, "/inbox")}>届いたものに戻る</a></div>
    <script dangerouslySetInnerHTML={{ __html: "if(!location.hash){document.getElementById('latest').scrollIntoView();}" }} />
  </Layout>);
});

talkAdmin.post("/inbox/talks/:talkId/topics/:topicMark", async (c) => edit(c, false));
talkAdmin.post("/inbox/talks/:talkId/topics/:topicMark/boundary", async (c) => edit(c, true));

// 前の画面を開いたままの人の送信も、同じ直し方へつなぐ。
talkAdmin.post("/inbox/city/:jobId", async (c) => legacyEdit(c, true));
talkAdmin.post("/inbox/:itemId", async (c) => legacyEdit(c, false));

async function legacyEdit(c: Context<AdminEnv>, fromAdmin: boolean) {
  const { ward, account } = c.var;
  const talks = await listTalks(c.env.DB, ward.wardId, { withText: false });
  const talk = talks.find((t) => t.posts.some((p) => fromAdmin ? p.sourceType === "admin" && p.jobId === c.req.param("jobId") : p.itemId === c.req.param("itemId")));
  const post = talk?.posts.find((p) => fromAdmin ? p.jobId === c.req.param("jobId") : p.itemId === c.req.param("itemId"));
  const topic = talk?.topics.find((t) => t.id === post?.bundleId);
  if (!talk || !topic) return c.notFound();
  const form = await c.req.formData();
  const operation = String(form.get("operation") ?? "assign");
  if (!["assign", "detach", "new-project", "unrelated"].includes(operation) || operation === "assign" && !form.get("projectId")
    || operation === "new-project" && !String(form.get("projectName") ?? "").trim()) return c.redirect(`${adminPath(ward, "/inbox")}?error=input`, 303);
  form.set("action", operation === "unrelated" ? "unrelated" : "material");
  if (operation === "detach") form.set("projectId", "");
  if (operation === "new-project") form.set("projectId", "new");
  try {
    await checkEditable(c.env.DB, ward.wardId, topic.posts);
    await editTopic(c.env, waitable(c), ward.wardId, account.accountId, topic, form, () => saveUndo(c.env.DB, ward.wardId, talk, [topic.id]));
    return c.redirect(`${adminPath(ward, talkPath(talk.id))}?n=changed&at=${topic.anchor.slice(6)}#${topic.anchor}`, 303);
  } catch { return c.redirect(`${adminPath(ward, "/inbox")}?error=input`, 303); }
}

async function edit(c: Context<AdminEnv>, boundary: boolean) {
  const { ward, account } = c.var;
  const talk = (await listTalks(c.env.DB, ward.wardId)).find((t) => t.id === c.req.param("talkId"));
  const topic = talk?.topics.find((t) => t.anchor === `topic-${c.req.param("topicMark")}`);
  if (!talk || !topic) return c.notFound();
  const back = { href: `${adminPath(ward, talkPath(talk.id))}#${topic.anchor}`, label: "元の会話に戻る" };
  const form = await c.req.formData();
  try {
    const postIndex = talk.posts.findIndex((p) => p.id === String(form.get("postId") ?? ""));
    const previous = postIndex > 0 ? talk.posts[postIndex - 1] : null;
    const affected = boundary && form.get("operation") === "join" && previous ? [topic.id, previous.bundleId] : [topic.id];
    const beforeChange = () => saveUndo(c.env.DB, ward.wardId, talk, affected);
    const target = boundary ? await changeBoundary(c.env, waitable(c), ward.wardId, talk, topic, String(form.get("postId") ?? ""), String(form.get("operation") ?? ""), beforeChange)
      : (await editTopic(c.env, waitable(c), ward.wardId, account.accountId, topic, form, beforeChange), topic.id);
    const anchor = await topicAnchor(target);
    return c.redirect(`${adminPath(ward, talkPath(talk.id))}?n=changed&at=${anchor.slice(6)}#${anchor}`, 303);
  } catch (error) {
    const busy = error instanceof Error && error.message === "busy";
    return adminResult(c, busy ? "今は資料を読んでつないでいます。" : "直せませんでした。", busy ? 409 : 400, back,
      busy ? "少ししてから、元の会話でもう一度直してください。" : "何の話かと、どうするかを見て、もう一度直してください。");
  }
}

talkAdmin.post("/inbox/talks/:talkId/undo", async (c) => {
  const { ward } = c.var;
  const talk = (await listTalks(c.env.DB, ward.wardId)).find((t) => t.id === c.req.param("talkId"));
  if (!talk) return c.notFound();
  try {
    const form = await c.req.formData();
    await undoTalk(c.env, waitable(c), ward.wardId, talk, String(form.get("undoId") ?? ""));
    return c.redirect(`${adminPath(ward, talkPath(talk.id))}?n=undone#result`, 303);
  } catch { return adminResult(c, "今は元に戻せません。", 409, { href: adminPath(ward, talkPath(talk.id)), label: "元の会話に戻る" }, "元の会話を開き、直すところを選び直してください。"); }
});

/** 古い通知や朝のまとめに残ったURLも、写真のある枠へ送る。 */
talkAdmin.get("/inbox/questions", async (c) => {
  const questions = await listClarifications(c.env.DB, c.var.ward.wardId);
  const question = questions.find((q) => !q.answer) ?? questions[0];
  const path = question ? await conversationFor(c.env.DB, c.var.ward.wardId, { jobId: question.job_id }) : null;
  return c.redirect(adminPath(c.var.ward, path ?? "/inbox"), 303);
});
talkAdmin.get("/inbox/:itemId/pick", async (c) => {
  const path = await conversationFor(c.env.DB, c.var.ward.wardId, { itemId: c.req.param("itemId") });
  return path ? c.redirect(adminPath(c.var.ward, path), 303) : c.notFound();
});
talkAdmin.get("/inbox/city/:jobId/pick", async (c) => {
  const path = await conversationFor(c.env.DB, c.var.ward.wardId, { jobId: c.req.param("jobId") });
  return path ? c.redirect(adminPath(c.var.ward, path), 303) : c.notFound();
});

talkAdmin.get("/inbox/:itemId/original", async (c) => {
  const wardId = c.var.ward.wardId;
  const row = await c.env.DB.prepare("SELECT job_id FROM line_inbox_items WHERE ward_id = ? AND item_id = ?")
    .bind(wardId, c.req.param("itemId")).first<{ job_id: string | null }>();
  if (!row?.job_id) return c.notFound();
  const original = await c.env.DB.prepare("SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ? AND withdrawn_at IS NULL ORDER BY position LIMIT 1")
    .bind(wardId, row.job_id).first<{ original_id: string }>();
  const file = original ? await getOriginal(c.env.DB, wardId, original.original_id) : null;
  if (!file?.r2_path) return c.notFound();
  const object = await new WardBucket(c.env.ORIGINALS, wardId).get(file.r2_path);
  if (!object) return c.notFound();
  return new Response(object.body, { headers: { "content-type": file.media_type, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
});
