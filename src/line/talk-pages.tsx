import { Hono, type Context } from "hono";
import type { AdminEnv } from "../env";
import { adminPath } from "../core/auth";
import { Layout, Notice, Hint } from "../core/ui";
import { Choices } from "../core/choice";
import { adminResult } from "../core/admin-ui";
import { formatJst, formatJstDate } from "../core/time";
import { getOriginal, jobSummaries, rosterCandidates } from "../intake/store";
import { WardBucket } from "../core/storage";
import { listKnowItems } from "../know/store";
import { questionOptionLabel } from "../project/question-pages";
import { listClarifications, type ClarificationRow } from "./clarifications";
import { listTalks, conversationFor, conversationPath, talkPage, talkPath, type Talk, type TalkTopic } from "./talks";
import { PURPOSE_QUESTION } from "./bundle-decisions";
import { changeBoundary, checkEditable, editTopic, saveUndo, undoTalk } from "./talk-edits";
import { senderText } from "./sender";

export const talkAdmin = new Hono<AdminEnv>();
const waitable = (c: Context<AdminEnv>) => { try { return c.executionCtx; } catch { return { waitUntil: () => undefined }; } };
const clock = (at: string) => formatJst(at).match(/\d{1,2}:\d{2}/)?.[0] ?? formatJst(at);
const withNotice = (path: string, notice: string) => {
  const [page, anchor] = path.split("#");
  return `${page}${page?.includes("?") ? "&" : "?"}n=${notice}${anchor ? `&at=${anchor.slice(6)}#${anchor}` : ""}`;
};

function actionText(topic: TalkTopic, names: Map<string, string>) {
  const decision = topic.decision;
  const name = names.get(decision?.project_id ?? topic.posts[0]?.projectId ?? "");
  switch (decision?.action ?? (topic.inquiry ? "inquiry" : "material")) {
    case "reference": return `→ ${name ? `${name}の参考にしました。` : "参考にしました。"}`;
    case "inquiry": return `→ 問い合わせにしました。${topic.inquiry?.answer ? "返事を残しました。" : "返事はまだです。"}`;
    case "know": return "→ 自治会の基本情報にしました。";
    case "unrelated": return "→ 関係ないものにしました。直すと戻せます。";
    case "confirm_share": return `→ ${name ? `${name}の参考にしました。` : "参考にしました。"}`;
    case "confirm_purpose": return "→ どの準備で使うか、見本として残すかを、役員に聞いています。";
    default: return `→ ${name ? `${name}の資料にしました。` : "自治会の資料にしました。"}`;
  }
}

const dayOf = (at: string) => formatJstDate(at).replace(/（.）$/, "");

/** 届いた先の行き先を、AIが入れた先の言葉にする。決めていないものと関係ないものは出さない。 */
function placeText(topic: TalkTopic, names: Map<string, string>): string {
  const name = names.get(topic.decision?.project_id ?? topic.posts[0]?.projectId ?? "");
  switch (topic.decision?.action ?? (topic.inquiry ? "inquiry" : "material")) {
    case "material": return name ? `${name}の資料` : "自治会の資料";
    case "reference": return name ? `${name}の参考` : "参考";
    case "inquiry": return "問い合わせ";
    case "know": return "自治会の基本情報";
    default: return "";
  }
}

/**
 * 一覧とトークの画面の一番上に出す文。仕組みの説明や数の札にせず、
 * どこに何が届き、どこに入れ、役員の答えを待っているものが何かを書く（トップと同じ決まり）。
 */
function talkFacts(talk: Talk, questions: ClarificationRow[], names: Map<string, string>) {
  const source = talk.posts[0]?.sourceType ?? "";
  const originals = talk.posts.flatMap((post) => post.originals);
  const photos = originals.filter((o) => o.media_type.startsWith("image/")).length;
  const files = originals.filter((o) => !o.media_type.startsWith("image/") && o.kind !== "text").length;
  const words = talk.posts.filter((post) => post.text.trim() || post.originals.some((o) => o.kind === "text")).length;
  const things = [photos ? `写真${photos}枚` : "", words ? `言葉${words}つ` : "", files ? `ファイル${files}つ` : ""].filter(Boolean).join("と") || "写真や言葉";
  const start = dayOf(talk.posts[0]?.at ?? talk.at), end = dayOf(talk.at);
  const range = start === end ? `${end}に` : `${start}から${end}までに`;
  const arrived = source === "admin" ? `役員の画面から、${range}${things}を送っています。`
    : `${talk.name}${source === "user" ? "から自治会のLINE" : ""}に、${range}${things}が届いています。`;
  const places = [...new Set(talk.topics.map((topic) => placeText(topic, names)).filter(Boolean))];
  const shownPlaces = `${places.slice(0, 4).join("、")}${places.length > 4 ? "など" : ""}`;
  const placed = !places.length ? "" : `${source === "admin" ? "" : "AIが読んで、"}${shownPlaces}${places.length > 1 ? "に分けて" : "に"}入れています。`;
  const jobs = new Set(talk.posts.map((post) => post.jobId).filter(Boolean));
  const open = questions.filter((q) => jobs.has(q.job_id) && !q.answer);
  const asking = (topic: TalkTopic) => open.some((q) => topic.posts.some((post) => post.jobId === q.job_id));
  const replying = (topic: TalkTopic) => !!topic.inquiry && !topic.inquiry.answer && (!topic.decision || topic.decision.action === "inquiry");
  const undecided = (topic: TalkTopic) => !asking(topic) && topic.decision?.action === "confirm_purpose";
  const replies = talk.topics.filter(replying).length;
  const choices = talk.topics.filter(undecided).length;
  const parts = [
    open.length ? `AIから役員への質問が${open.length}つあり、まだ答えがありません` : "",
    replies ? `問い合わせ${replies}つに、まだ返事をしていません` : "",
    choices ? `写真と言葉${choices}つは、どう使うかをまだ決めていません` : "",
  ].filter(Boolean);
  const first = talk.topics.find((topic) => asking(topic) || replying(topic) || undecided(topic)) ?? null;
  const kind = !first ? null : asking(first) ? "asking" : replying(first) ? "replying" : "undecided";
  const firstAt = first ? formatJst(first.posts[0]!.at) : "";
  const where = source === "admin" ? `役員の画面から${firstAt}に送った` : `${talk.name}${source === "user" ? "から自治会のLINE" : ""}に${firstAt}に届いた`;
  const firstPhoto = first?.posts.some((post) => post.originals.some((o) => o.media_type.startsWith("image/")));
  return {
    arrived, placed, first,
    todo: parts.length ? `${parts.join("。")}。` : "役員の答えを待っているものはありません。",
    firstText: kind === "asking" ? `${where}${firstPhoto ? "写真" : "もの"}について、AIが役員に質問しています。`
      : kind === "replying" ? `${where}問い合わせに、まだ返事をしていません。`
      : kind === "undecided" ? `${where}写真と言葉を、どう使うかまだ決めていません。` : "",
    openLabel: kind === "asking" ? "開いて質問に答える" : kind === "replying" ? "開いて問い合わせを読む" : "開いて使い方を決める",
    jumpLabel: kind === "asking" ? "AIからの質問のところへ移る" : kind === "replying" ? "返事をしていない問い合わせのところへ移る" : "使い方を決めていないところへ移る",
  };
}

/** 使い道の二つの質問は、保存した文と答えの値を変えずに、画面では何の写真の何を聞くのかと、押すと何が起きるかを書く。 */
function questionView(question: ClarificationRow, project: string | undefined) {
  if (question.text === PURPOSE_QUESTION) {
    const use = `${project ?? "自治会の資料"}で使う`;
    return {
      text: `この写真は、${project ? `${project}の準備で` : ""}自治会が使うもの（自分たちのチラシや当番表など）ですか。それとも、よその催しのチラシのように、作るときの参考にするものですか。`,
      label: (option: string) => option === "この準備の資料" ? use : option === "参考資料" || option === "参考" ? "参考にする" : questionOptionLabel(option),
      after: `「${use}」を選ぶと、写真から読んだことを${project ? `${project}の中身` : "自治会の資料"}に入れます。「参考にする」を選ぶと、写真に書かれた日時や場所を${project ?? "今年の予定"}には入れず、参考として残します。`,
    };
  }
  return { text: question.text, label: questionOptionLabel, after: "" };
}

function Question({ question, ward, back, choices, project }: { question: ClarificationRow; ward: AdminEnv["Variables"]["ward"]; back: string; choices: string[]; project?: string }) {
  const conflict = choices.length > 1 && !choices.includes(question.answer ?? "");
  const view = questionView(question, project);
  return <div class="question-block"><p><strong>AIからの質問</strong>　{view.text}</p>
    {question.answer ? <p class="preserve-lines">答え: {question.answer}</p> : null}
    {!question.answer || conflict ? <form method="post" action={adminPath(ward, `/inbox/questions/${encodeURIComponent(question.id)}`)}>
      <input type="hidden" name="back" value={back} />
      {conflict ? <fieldset><legend>違う答えが届いています。使う内容を選べます。</legend>{choices.map((answer) => <label><input type="radio" name="answer" value={answer} required />{view.label(answer)}</label>)}</fieldset>
        : question.options.length > 1 ? <div class="action-links">{question.options.map((option) => <button class="secondary" name="answer" value={option}>{view.label(option)}</button>)}</div>
        : <><label for={`answer-${question.id}`}>分かるところを書いてください</label><input id={`answer-${question.id}`} name="answer" maxlength={2000} /></>}
      {conflict || question.options.length <= 1 ? <button class="secondary">この答えを残す</button> : null}
      {!conflict ? <button class="quiet" name="unknown" value="1">分からない</button> : null}
      {view.after && !conflict ? <p class="help-text">{view.after}</p> : null}
    </form> : null}
  </div>;
}

talkAdmin.get("/inbox", async (c) => {
  const { ward } = c.var;
  const [talks, questions, projects] = await Promise.all([
    listTalks(c.env.DB, ward.wardId, { withText: false }), listClarifications(c.env.DB, ward.wardId),
    c.env.DB.prepare("SELECT project_id, title FROM projects WHERE ward_id = ?").bind(ward.wardId).all<{ project_id: string; title: string }>(),
  ]);
  const names = new Map(projects.results.map((p) => [p.project_id, p.title]));
  const views = talks.map((talk) => ({ talk, facts: talkFacts(talk, questions, names) }));
  const main = views.find((view) => view.facts.first);
  const otherNames = views.filter((view) => view !== main && view.facts.first).map((view) => view.talk.name);
  return c.html(<Layout title="届いたもの" siteName={ward.name} adminHomeHref={adminPath(ward, "/")} noindex>
    <a class="back" href={adminPath(ward, "/")}>← 最初の画面へ</a><h1>届いたもの</h1>
    {c.req.query("error") ? <Notice error>直せませんでした。下の一覧から開き直して、もう一度直してください。</Notice> : null}
    {main?.facts.first ? <section class="next"><p>{main.facts.firstText}</p>
      <a class="button" href={adminPath(ward, conversationPath(main.talk, main.facts.first))}>{main.facts.openLabel}</a>
      <p>開くと、届いた順に並んだ写真と言葉の、そのところに移ります。{otherNames.length ? `ほかに、${otherNames.join("、")}にも、役員の答えを待っているものがあります。` : ""}</p></section>
      : talks.length ? <p class="lead">役員の答えを待っている質問や、まだ返事をしていない問い合わせはありません。</p> : null}
    {talks.length ? <ul class="rows">{views.map(({ talk, facts }) => <li><a class="row-link" href={adminPath(ward, talkPath(talk.id))}>
      <b>{talk.name}</b><span>{facts.arrived}{facts.placed}{facts.first ? facts.todo : ""}</span>
    </a></li>)}</ul> : <p class="lead">まだ何も届いていません。役員のLINEグループや自治会のLINEに写真や言葉が届くと、ここに届いた先ごとに並びます。役員の画面から送った写真やファイルも、ここに並びます。</p>}
    <a class="button secondary" href={adminPath(ward, "/intake")}>写真やファイルを送る</a>
  </Layout>);
});

talkAdmin.get("/inbox/talks/:talkId", async (c) => {
  const { ward } = c.var;
  const talk = (await listTalks(c.env.DB, ward.wardId)).find((t) => t.id === c.req.param("talkId"));
  if (!talk) return c.notFound();
  const page = talkPage(talk, c.req.query("before"));
  if (!page) return c.notFound();
  const [projects, questions, summaries, know, roster, undo] = await Promise.all([
    c.env.DB.prepare("SELECT project_id, title, closed_at FROM projects WHERE ward_id = ? AND is_ward_notices = 0 ORDER BY created_at DESC")
      .bind(ward.wardId).all<{ project_id: string; title: string; closed_at: string | null }>(),
    listClarifications(c.env.DB, ward.wardId), jobSummaries(c.env.DB, ward.wardId), listKnowItems(c.env.DB, ward.wardId),
    rosterCandidates(c.env.DB, ward.wardId), c.env.DB.prepare("SELECT undo_id FROM line_talk_undo WHERE ward_id = ? AND talk_id = ?")
      .bind(ward.wardId, talk.id).first<{ undo_id: string }>(),
  ]);
  const answers = await c.env.DB.prepare("SELECT clarification_id, answer_text FROM line_clarification_answers WHERE ward_id = ?")
    .bind(ward.wardId).all<{ clarification_id: string; answer_text: string }>();
  const names = new Map(projects.results.map((p) => [p.project_id, p.title]));
  const activeProjects = projects.results.filter((p) => !p.closed_at);
  const path = adminPath(ward, talkPath(talk.id));
  const facts = talkFacts(talk, questions, names);
  return c.html(<Layout title={talk.name} siteName={ward.name} adminHomeHref={adminPath(ward, "/")} noindex>
    <a class="back" href={adminPath(ward, "/inbox")}>← 届いたものへ</a><h1>{talk.name}</h1>
    <p class="lead">{facts.arrived}{facts.placed}</p>
    {facts.first ? <section class="next"><p>{facts.todo}</p><a class="button" href={adminPath(ward, conversationPath(talk, facts.first))}>{facts.jumpLabel}</a></section> : <p>{facts.todo}</p>}
    <p>AIが入れた先が違うと気づいたときは、そのまとまりの下の「直す」で変えられます。写真や資料に関係のない会話は残していません。</p>
    {c.req.query("n") === "undone" ? <div id="result"><Notice>元に戻しました。続けて会話を読めます。</Notice></div> : null}
    {undo ? <form method="post" action={`${path}/undo`}><input type="hidden" name="undoId" value={undo.undo_id} /><button class="secondary">直す前に戻す</button></form> : null}
    <style>{`.talk-topic{border:2px solid #82988c;border-radius:12px;padding:16px;margin:24px 0;overflow-wrap:anywhere}.talk-post{padding:16px 0;border-bottom:1px solid #d4ded7}.talk-photo{display:block;width:min(100%,220px);max-height:220px;object-fit:contain}.talk-topic input,.talk-topic select,.talk-topic textarea{max-width:100%;box-sizing:border-box}.talk-topic p,.talk-topic label,.talk-topic summary,.talk-topic button,.talk-topic time{font-size:18px}.talk-decision{font-size:20px;line-height:1.8}.talk-topic fieldset{min-width:0}`}</style>
    {page.older ? <p><a class="button secondary" href={`${path}?before=${page.older}`}>それより前の話題を見る</a></p> : null}
    {c.req.query("before") !== undefined ? <p><a class="button secondary" href={path}>新しい話題を見る</a></p> : null}
    {page.topics.map((topic) => {
      const photos = topic.posts.reduce((sum, p) => sum + p.originals.filter((o) => o.media_type.startsWith("image/")).length, 0);
      const words = topic.posts.some((p) => p.text);
      const first = topic.posts[0]!;
      const last = topic.posts[topic.posts.length - 1]!;
      const summary = topic.decision?.summary || (topic.inquiry ? `住民からの質問（${first.text}）です。` : summaries.get(first.jobId ?? "")?.split("\n")[0]) || "届いた写真と言葉です。";
      const back = adminPath(ward, conversationPath(talk, topic));
      const current = topic.decision?.project_id ?? first.projectId;
      const currentName = current ? names.get(current) : undefined;
      const action = topic.decision?.action ?? (topic.inquiry ? "inquiry" : "material");
      const edit = `${path}/topics/${topic.anchor.slice(6)}`;
      return <section class="talk-topic" id={topic.anchor}>
        {c.req.query("at") === topic.anchor.slice(6) ? <><Notice>{c.req.query("n") === "answered" ? "答えを残しました。続けて会話を読めます。" : `${actionText(topic, names).replace("→ ", "")}続けて会話を読めます。`}</Notice>
          {undo ? <form method="post" action={`${path}/undo`}><input type="hidden" name="undoId" value={undo.undo_id} /><button class="secondary">直す前に戻す</button></form> : null}</> : null}
        {topic.posts.map((post) => <article class="talk-post" id={`post-${post.id}`}>
          <p><strong>{post.sourceType === "admin" ? post.sender : senderText(post.sender, post.sourceType, post.senderNumber)}</strong>　<time datetime={post.at}>{formatJst(post.at)}</time></p>
          {post.text ? <p class="preserve-lines">{post.text}</p> : null}
          {post.originals.map((original) => {
            const source = adminPath(ward, `/intake/originals/${encodeURIComponent(original.original_id)}`);
            const photo = original.media_type.startsWith("image/");
            return <div>{photo ? <a href={source}><img class="talk-photo" src={`${source}?raw=1`} alt="届いた写真。押すと大きく見られます" loading="lazy" /></a>
              : original.kind !== "text" ? <p><a class="button secondary" href={source}>{original.filename || "届いた資料"}を開く</a></p> : null}
              {questions.filter((q) => q.original_id === original.original_id).map((question) => <Question question={question} ward={ward} back={back} project={names.get(current ?? "")}
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
            {/* 名前だけの選択肢を並べず、今の判断を先に書き、選ぶ物ごとに、何のための物かと選ぶと何が起きるかを添える。 */}
            <p>今は、{topic.decision?.decided_by === "officer" ? "役員が" : "AIが"}{actionText(topic, names).replace("→ ", "")}違うときだけ、下から選び直してください。</p>
            <label for={`summary-${topic.anchor}`}>何の話か</label><input id={`summary-${topic.anchor}`} name="summary" value={summary} maxlength={500} required />
            <Choices name="choice" legend="どうするか" items={[
              ...(currentName ? [
                { value: `material:${current}`, title: `${currentName}の資料にする`, note: `日時や場所などを${currentName}の今年の中身に入れ、案内の下書きにも使います。`, checked: action === "material" },
                { value: `reference:${current}`, title: `${currentName}の見本として残す`, note: `今年の中身には入れず、${currentName}を作る時に見られるように残します。よその催しのチラシや、去年の物の時に選びます。`, checked: action === "reference" },
              ] : []),
              { value: "material:other", title: currentName ? "別の準備の資料にする" : "準備の資料にする", note: "下で選んだ準備の今年の中身に入れます。まだ無い準備なら、名前を入れると新しく始めます。",
                extra: <div class="field"><label for={`project-${topic.anchor}`}>どの準備か</label><select id={`project-${topic.anchor}`} name="otherProjectId">
                  {activeProjects.filter((project) => project.project_id !== current).map((project) => <option value={project.project_id}>{project.title}</option>)}
                  <option value="new">新しく準備を始める</option></select>
                  <label for={`name-${topic.anchor}`}>新しく始める時の名前</label><input id={`name-${topic.anchor}`} name="projectName" maxlength={100} /></div> },
              { value: "material:", title: "自治会全体の資料にする", note: "一つの準備に限らない資料として、AIが読んで、自治会の基本情報や一年の予定に入れます。規約、名簿、年間の予定表などの時に選びます。", checked: action === "material" && !currentName },
              { value: "know:", title: "自治会の決まりの元の資料にする", note: "下で選んだ決まり（会費、役員の割り振りなど）の、元の資料としてつなぎます。",
                checked: action === "know",
                extra: <div class="field"><label for={`know-${topic.anchor}`}>どの決まりか</label><select id={`know-${topic.anchor}`} name="knowId">{know.items.map((item) => <option value={item.id}>{item.title}</option>)}</select></div> },
              { value: "inquiry:", title: "住民からの問い合わせにする", note: "返事を書く画面に並べます。資料にはしません。", checked: action === "inquiry" },
              { value: "unrelated:", title: "取っておかない", note: "資料にも問い合わせにもせず、使いません。このトークには残り、あとから直せます。", checked: action === "unrelated" },
            ]} />
            <Hint text="すでに下書きに入った内容は残ることがあります。別の資料や見本に直したときは、住民に送る前に下書きを見て直してください。" />
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
    return c.redirect(withNotice(adminPath(ward, conversationPath(talk, topic)), "changed"), 303);
  } catch { return c.redirect(`${adminPath(ward, "/inbox")}?error=input`, 303); }
}

async function edit(c: Context<AdminEnv>, boundary: boolean) {
  const { ward, account } = c.var;
  const talk = (await listTalks(c.env.DB, ward.wardId)).find((t) => t.id === c.req.param("talkId"));
  const topic = talk?.topics.find((t) => t.anchor === `topic-${c.req.param("topicMark")}`);
  if (!talk || !topic) return c.notFound();
  const back = { href: adminPath(ward, conversationPath(talk, topic)), label: "元の会話に戻る" };
  const form = await c.req.formData();
  const choice = String(form.get("choice") ?? "");
  if (choice) {
    const [chosen, target = ""] = choice.split(":");
    form.set("action", chosen ?? "");
    form.set("projectId", target === "other" ? String(form.get("otherProjectId") ?? "") : target);
  }
  try {
    const postIndex = talk.posts.findIndex((p) => p.id === String(form.get("postId") ?? ""));
    const previous = postIndex > 0 ? talk.posts[postIndex - 1] : null;
    const affected = boundary && form.get("operation") === "join" && previous ? [topic.id, previous.bundleId] : [topic.id];
    const beforeChange = () => saveUndo(c.env.DB, ward.wardId, talk, affected);
    const target = boundary ? await changeBoundary(c.env, waitable(c), ward.wardId, talk, topic, String(form.get("postId") ?? ""), String(form.get("operation") ?? ""), beforeChange)
      : (await editTopic(c.env, waitable(c), ward.wardId, account.accountId, topic, form, beforeChange), topic.id);
    const targetPath = await conversationFor(c.env.DB, ward.wardId, { bundleId: target });
    return c.redirect(withNotice(adminPath(ward, targetPath ?? talkPath(talk.id)), "changed"), 303);
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
