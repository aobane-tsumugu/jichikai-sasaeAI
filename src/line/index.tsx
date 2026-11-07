import { adminResult } from "../core/admin-ui";
import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { WardBucket } from "../core/storage";
import { Layout, Notice } from "../core/ui";
import { CRON } from "../core/cron";
import { sendOfficerDigest } from "./digest";
import { completeScreenClarifications, listClarifications, processPhotoBatches } from "./clarifications";
import type { AdminEnv, AppEnv } from "../env";
import { getLineAllowance, lineAccessToken, sendLineTitleAndUrl } from "./api";
import { markInboxItemUnrelated } from "./intake";
import { acceptLineWebhook } from "./webhook";
import { createProject } from "../project/api";
import { answerQuestion } from "../project/actions";
import { questionOptionLabel } from "../project/question-pages";
import { PROJECT_KINDS, PROJECT_KIND_LABEL, type ProjectKind } from "../project/model";
import { dateWords, openInquiries } from "../project/followup";
import { inquirySubject } from "../project/inquiry-send";
import { assignProject, withdrawJob } from "../intake/api";
import { getJob, getOriginal, jobSummaries, listJobs, listOriginals } from "../intake/store";
import { pendingMaterialGroups } from "../intake/groups";
import { WhichProject } from "../intake/which-project";
import { adminPath } from "../core/auth";
import { formatJst, formatJstDate } from "../core/time";
import { rememberPhotoSource, purgePhotoTexts } from "./photo-context";
import { STATUS_LABEL } from "../intake/pages";

interface InboxRow {
  item_id: string;
  job_id: string | null;
  original_kind: "text" | "image";
  original_text: string | null;
  received_at: string;
  disposition: "unmatched" | "matched";
  matched_project_name: string | null;
  match_reason: string | null;
  sender_display_name: string | null;
  sender_label: string | null;
  job_project_id: string | null;
}

/** 行事に入っているか。受信の記録が古くても、資料の側に行事があれば入っている。 */
export const inboxDecided = (item: Pick<InboxRow, "disposition" | "job_project_id">) => item.disposition === "matched" || Boolean(item.job_project_id);

/** 読み手の要約は長いことがある。一覧には最初の一行だけを出す。 */
const shortLine = (text: string, max = 36) => {
  const line = text.split("\n")[0]!.trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

export async function listInboxItems(db: D1Database, wardId: string): Promise<InboxRow[]> {
  const result = await db.prepare(`
    SELECT i.item_id, i.job_id, i.original_kind, i.original_text, i.received_at, i.disposition, i.sender_display_name, i.sender_label,
      i.matched_project_name, i.match_reason, j.project_id AS job_project_id
    FROM line_inbox_items i LEFT JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id
    WHERE i.ward_id = ?
    ORDER BY i.received_at DESC, i.item_id
  `).bind(wardId).all<InboxRow>();
  return result.results;
}

function safeContext(c: { executionCtx: Pick<ExecutionContext, "waitUntil"> }): Pick<ExecutionContext, "waitUntil"> {
  try { return c.executionCtx; } catch { return { waitUntil: () => undefined }; }
}

const openProjects = async (db: D1Database, wardId: string) => (await db.prepare("SELECT project_id, title AS name FROM projects WHERE ward_id = ? AND closed_at IS NULL ORDER BY created_at DESC")
  .bind(wardId).all<{ project_id: string; name: string }>()).results;

/** 届いたものの一件。写真か文と、だれがいつ送ったかを、一覧と開いた画面で同じに見せる。 */
interface Received { key: string; href: string; action: string; photo: string | null; isText: boolean; title: string; note: string; project: string | null; at: string; state: string }

function ClarificationForm({ ward, question, back }: { ward: AdminEnv["Variables"]["ward"]; question: { id: string; text: string; options: string[] }; back: string }) {
  const action = adminPath(ward, `/inbox/questions/${question.id}`);
  return <form method="post" action={action}><input type="hidden" name="back" value={back} />
    {question.options.length > 1 ? <div class="action-links">{question.options.map((option) => <button class="secondary" name="answer" value={option}>{questionOptionLabel(option)}</button>)}</div>
      : <><div class="field"><label for={`answer-${question.id}`}>答え</label><input id={`answer-${question.id}`} name="answer" maxlength={2000} /></div><div class="action-links"><button class="secondary">この答えを残す</button></div></>}
    <button class="quiet" name="answer" value="分からない">分からない</button>
  </form>;
}

/** 写真を大きく見て、その場で行事を決める画面。LINE で届いたものと、この画面から送ったものの両方で使う。 */
function InboxPick({ ward, title, noun, facts, photos, files, summary, reason, questions, back, action, projects, current, suggested, suggestedName, suggestedKind, removable, answered }: {
  ward: AdminEnv["Variables"]["ward"]; title: string; noun: string; facts: [string, string][]; photos: { src: string; alt: string }[]; files: { href: string; label: string }[];
  summary: string; reason: string | null; questions: { id: string; text: string; options: string[] }[]; back: string; action: string;
  projects: { project_id: string; name: string }[]; current: string | null; suggested: string | null; suggestedName: string; suggestedKind: string; removable: boolean; answered: boolean;
}) {
  const others = projects.filter((project) => project.project_id !== current);
  return <Layout title={title} siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/inbox")}>← 届いたものへ</a>
    {answered ? <Notice>答えを残しました。</Notice> : null}
    <h1>{title}</h1>
    {photos.map((photo) => <a href={photo.src}><img class="photo-full" src={photo.src} alt={photo.alt} /></a>)}
    {photos.length ? <p class="muted">写真を押すと、元の大きさで開きます。</p> : null}
    {files.map((file) => <p class="link-line"><a href={file.href}>{file.label}</a></p>)}
    <dl class="facts">{facts.map(([name, value]) => <><dt>{name}</dt><dd>{value}</dd></>)}</dl>
    {summary ? <><h2>AIが読んだこと</h2><p class="preserve-lines">{summary}</p></> : null}
    {reason ? <p class="muted">行事に入れた理由: {reason}</p> : null}
    {questions.length ? <><h2>読めなかったところ</h2><p class="lead">分かるものだけ答えてください。答えなくてもかまいません。</p>
      {questions.map((question) => <section class="panel"><p>{question.text}</p><ClarificationForm ward={ward} question={question} back={back} /></section>)}</> : null}
    <h2>{current ? "別の行事に入れ直す" : "どの行事に入れますか"}</h2>
    <WhichProject id="pick" question={current ? `この${noun}は、次の行事のものですか？` : `この${noun}は、次の行事のものですか？`} projects={others} suggested={current ? null : suggested} suggestedName={current ? "" : suggestedName} suggestedKind={suggestedKind} action={action} />
    {removable ? <details class="fold"><summary>関係のないものとして外す</summary><div>
      <p>雑談など、行事に関係のないものです。外すと、数だけが残ります。元に戻せません。</p>
      <form method="post" action={action}><button class="danger" name="operation" value="unrelated">関係のないものとして外す</button></form>
      <p class="muted">AIが読み始めたものは外せません。その場合は、区の設定の「消す希望」から消せます。</p>
    </div></details> : null}
  </Layout>;
}

const admin = new Hono<AdminEnv>();

admin.get("/inbox", async (c) => {
  const { ward } = c.var;
  const db = c.env.DB;
  const [items, jobs, projects, groups, inquiries, clarifications, summaries] = await Promise.all([
    listInboxItems(db, ward.wardId), listJobs(db, ward.wardId, { limit: 100 }), openProjects(db, ward.wardId),
    pendingMaterialGroups(db, ward.wardId), openInquiries(db, ward.wardId), listClarifications(db, ward.wardId), jobSummaries(db, ward.wardId),
  ]);
  const adminJobs = jobs.filter((j) => j.via === "admin" && !j.withdrawn_at);
  // 閉じた行事に入れたものも、行事の名前で読む。
  const names = new Map((await db.prepare("SELECT project_id, title FROM projects WHERE ward_id = ?").bind(ward.wardId).all<{ project_id: string; title: string }>()).results.map((row) => [row.project_id, row.title]));
  const lineRows = await Promise.all(items.map(async (item) => ({ item, job: item.job_id ? await getJob(db, ward.wardId, item.job_id) : null })));
  const fromLine = ({ item, job }: (typeof lineRows)[number]): Received => {
    const sender = item.sender_display_name || item.sender_label;
    const reading = job && !job.project_id && ["received", "reading", "attention", "failed"].includes(job.status);
    return { key: item.item_id, href: adminPath(ward, `/inbox/${item.item_id}/pick`), action: adminPath(ward, `/inbox/${item.item_id}`),
      photo: item.original_kind === "image" && item.job_id ? adminPath(ward, `/inbox/${item.item_id}/original`) : null, isText: item.original_kind === "text",
      title: item.original_text ? `「${shortLine(item.original_text, 30)}」` : shortLine(summaries.get(item.job_id ?? "") ?? "") || "届いた写真",
      note: sender ? `${sender}さん` : "公式LINE", project: item.matched_project_name ?? names.get(job?.project_id ?? "") ?? null, at: item.received_at, state: reading ? STATUS_LABEL[job.status] : "" };
  };
  const fromJob = async (j: (typeof adminJobs)[number]): Promise<Received> => {
    const originals = (await listOriginals(db, ward.wardId, j.job_id)).filter((o) => !o.withdrawn_at);
    const image = originals.find((o) => o.media_type.startsWith("image/"));
    return { key: j.job_id, href: adminPath(ward, `/inbox/city/${j.job_id}/pick`), action: adminPath(ward, `/inbox/city/${j.job_id}`),
      photo: image ? `${adminPath(ward, `/intake/originals/${image.original_id}`)}?raw=1` : null, isText: false,
      title: shortLine(summaries.get(j.job_id) ?? "") || j.first_filename || "届いた資料", note: "この画面から", project: names.get(j.project_id ?? "") ?? null, at: j.created_at, state: "" };
  };
  const inGroups = new Set(groups.filter((g) => g.title).flatMap((g) => g.materials.map((m) => m.jobId)));
  const readingJobs = adminJobs.filter((j) => !j.project_id && j.status !== "read");
  const undecided = [...await Promise.all(adminJobs.filter((j) => !j.project_id && j.status === "read" && !inGroups.has(j.job_id)).map(fromJob)),
    ...lineRows.filter(({ item }) => !inboxDecided(item) && !inGroups.has(item.job_id ?? "")).map(fromLine)];
  const decided = [...await Promise.all(adminJobs.filter((j) => j.project_id).map(fromJob)), ...lineRows.filter(({ item }) => inboxDecided(item)).map(fromLine)]
    .sort((a, b) => b.at.localeCompare(a.at));
  const asked = inquiries.filter(({ group }) => group[0]!.kind === "inquiry");
  const open = clarifications.filter((question) => !question.answer);
  const nothing = !groups.length && !readingJobs.length && !undecided.length && !asked.length && !decided.length && !clarifications.length;
  const titled = groups.filter((g) => g.title);
  const toDecide = titled.length + undecided.length;
  const assignedTo = names.get(c.req.query("project") ?? "");
  const sentBy = (jobId: string) => { const item = items.find((i) => i.job_id === jobId); return item ? `${formatJst(item.received_at)}　${item.sender_display_name || item.sender_label || "公式LINE"}` : ""; };
  const detail = (jobId: string) => { const item = items.find((i) => i.job_id === jobId); return adminPath(ward, item ? `/inbox/${item.item_id}/pick` : `/inbox/city/${jobId}/pick`); };
  return c.html(<Layout title="届いたもの" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/")}>← 最初の画面へ</a>
    {c.req.query("error") === "input" ? <Notice error>入れる行事を選び直してください。</Notice> : null}
    <h1>届いたもの</h1>
    {c.req.query("n") === "assigned" ? <Notice>{assignedTo ?? "行事"}に入れました。違うときは、下の写真を押すと入れ直せます。</Notice> : null}
    {c.req.query("n") === "assigned" && assignedTo && !toDecide ? <section class="next"><strong>次は</strong><p>{assignedTo}の段取りから続きを進められます。</p><a class="button" href={adminPath(ward, `/projects/${c.req.query("project")}/map`)}>{assignedTo}の段取りを見る</a></section> : null}
    {c.req.query("n") === "removed" ? <Notice>関係のないものとして外しました。数だけが残ります。</Notice> : null}
    {c.req.query("error") === "busy" ? <Notice error>資料を行事に入れているところです。少ししてから、もう一度開いてください。</Notice> : null}
    {nothing ? <><div class="notice" role="status"><strong>届いたものはありません</strong><p>公式LINEや、QRコードのない紙で届いたものが、ここに入ります。</p></div><section class="next"><strong>次は</strong><p>手元の資料を送れます。</p><a class="button" href={adminPath(ward, "/intake")}>資料を送る</a></section></> : <>
    <p class="lead">公式LINEに届いた写真や文と、この画面から送った資料です。AIが読んで、行事に入れます。</p>
    {toDecide ? <><h2>どの行事か確かめてください（{toDecide}件）</h2><p class="muted">AIだけでは決められなかったものです。あとで決めてもかまいません。</p>
      <ul class="rows">
        {titled.map((group, index) => { const images = group.materials.filter((m) => m.original.media_type.startsWith("image/")).slice(0, 3); const count = group.materials.length; return <li class="panel">
          {images.length ? <div class={images.length > 1 ? "photo-strip" : undefined}>{images.map((m) => <a href={detail(m.jobId)}><img class="photo" src={`${adminPath(ward, `/intake/originals/${m.original.original_id}`)}?raw=1`} alt={`${group.title}の写真`} loading="lazy" /></a>)}</div> : null}
          {sentBy(group.materials[0]!.jobId) ? <p class="muted">{sentBy(group.materials[0]!.jobId)}</p> : null}
          <p class="muted">AIは「{group.title}」の資料と読みました。{count > 1 ? `${count}件あります。` : ""}</p>
          <WhichProject id={`group-${index}`} question={count > 1 ? `この${count}件は、次の行事のものですか？` : `この${images.length ? "写真" : "資料"}は、次の行事のものですか？`} projects={projects} suggested={group.joins?.projectId} suggestedName={group.joins ? "" : group.title} suggestedKind={group.kind} action={adminPath(ward, "/intake/start")} hidden={{ group: group.key }} />
          <p class="link-line"><a href={detail(group.materials[0]!.jobId)}>{count > 1 ? "一件ずつ大きく見る" : "大きく見る"}</a></p>
        </li>; })}
        {undecided.map((row) => <li class="panel">
          {row.photo ? <a href={row.href}><img class="photo" src={row.photo} alt={`${row.title}の写真`} loading="lazy" /></a> : null}
          <p><b>{row.title}</b></p><p class="muted">{formatJst(row.at)}　{row.note}{row.state ? `　${row.state}` : ""}</p>
          <WhichProject id={`row-${row.key}`} question={`この${row.photo ? "写真" : row.isText ? "文" : "資料"}は、次の行事のものですか？`} projects={projects} action={row.action} />
          <p class="link-line"><a href={row.href}>{row.photo ? "大きく見る" : "くわしく見る"}</a></p>
        </li>)}
      </ul></> : null}
    {readingJobs.length ? <><h2>読んでいるもの</h2>{readingJobs.map((j) => <p class="link-line"><a href={adminPath(ward, "/intake/received")}>{j.first_filename || "撮った写真"}: {STATUS_LABEL[j.status]}</a></p>)}</> : null}
    {asked.length ? <><h2>役員に届いた問い合わせ</h2>
      <p class="muted">{asked.some(({ group }) => group.some((row) => row.line_replied_at)) ? "AIは答えていません。送った人には「役員に伝えて、内容を確認します」と返しました。" : "AIは答えていません。"}</p>
      <ul class="rows">{asked.slice(0, 2).map(({ group, project }) => { const record = group[0]!; const words = dateWords(record.subject); return <li><a class="row-link" href={adminPath(ward, `/inquiries/${encodeURIComponent(record.inquiry_id)}`)}><b>「{inquirySubject(record.subject)}」</b>
        {record.line_source_type ? <span>送った人: {record.line_sender_label || "名前は分かりません"}（{record.line_source_type === "user" ? "公式への一対一" : "LINEグループ"}）</span> : null}
        <span>{words.map((word) => `「${word}」と書かれています。`).join("")}{group.length > 1 ? `同じ内容が${group.length}件あります` : `${formatJstDate(record.received_at)}に届きました`}</span>
        {project ? <span>{project.title}の話のようです</span> : null}
      </a></li>; })}
      {asked.length > 2 ? <li><a class="row-link" href={adminPath(ward, "/inquiries")}><b>ほかの問い合わせ {asked.length - 2}件</b><span>問い合わせと要望の画面で見られます</span></a></li> : null}</ul></> : null}
    {decided.length ? <><h2>行事に入れたもの（{decided.length}件）</h2><p class="muted">押すと大きく見られます。入れた行事も、そこから直せます。</p>
      <ul class="photo-grid">{decided.map((row) => <li><a href={row.href}>
        {row.photo ? <img class="photo" src={row.photo} alt={`${row.title}の写真`} loading="lazy" /> : <span class="photo-none">{row.title}</span>}
        <b>{row.photo ? row.title : row.project ?? "行事"}</b><span>{row.photo ? row.project ?? "行事" : ""}</span><span>{formatJst(row.at)}</span><span>{row.note}</span>
      </a></li>)}</ul></> : null}
    {clarifications.length ? <p class="link-line"><a href={adminPath(ward, "/inbox/questions")}>{open.length ? `読めなかったところの質問（${open.length}件）を見る` : "読めなかったところの質問を見る"}</a></p> : null}
    <p class="muted">関係のない雑談は、AIが外しています。</p></>}
  </Layout>);
});

admin.get("/inbox/questions", async (c) => {
  const { ward } = c.var;
  const questions = await Promise.all((await listClarifications(c.env.DB, ward.wardId)).map(async (question) => {
    const answers = await c.env.DB.prepare("SELECT DISTINCT answer_text FROM line_clarification_answers WHERE ward_id = ? AND clarification_id = ?")
      .bind(ward.wardId, question.id).all<{ answer_text: string }>();
    return { ...question, choices: answers.results.map((row) => row.answer_text) };
  }));
  const compare = (question: (typeof questions)[number]) => question.choices.length > 1 && !question.choices.includes(question.answer ?? "");
  const waiting = questions.filter((question) => !question.answer || compare(question));
  const done = questions.filter((question) => !waiting.includes(question));
  const photoIds = [...new Set(waiting.map((question) => question.original_id))];
  const originals = new Map((await Promise.all(photoIds.map((id) => getOriginal(c.env.DB, ward.wardId, id)))).flatMap((row) => row ? [[row.original_id, row] as const] : []));
  const back = adminPath(ward, "/inbox/questions");
  return c.html(<Layout title="読めなかったところ" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/inbox")}>← 届いたものへ</a>
    {c.req.query("n") === "answered" ? <Notice>答えを残しました。</Notice> : null}
    <h1>読めなかったところ</h1><p class="lead">写真を見て、分かるものだけ答えてください。答えなくても仕事は進みます。全部を確かめる必要はありません。</p>
    {photoIds.map((id) => { const original = originals.get(id); const src = `${adminPath(ward, `/intake/originals/${id}`)}`; return <section class="panel">
      {original?.media_type.startsWith("image/") ? <a href={`${src}?raw=1`}><img class="photo-full" src={`${src}?raw=1`} alt="質問のある写真" loading="lazy" /></a> : <p class="link-line"><a href={src}>元の資料を見る</a></p>}
      {waiting.filter((question) => question.original_id === id).map((question) => <div class="question-block"><p>{question.text}</p>
        {question.answer ? <p class="preserve-lines">届いた答え: {question.answer}</p> : null}
        {compare(question) ? <details class="fold"><summary>二つを見比べる</summary><div><p>使う方を選んでください。選ばなければ、今の内容のままです。</p>
          <form method="post" action={adminPath(ward, `/inbox/questions/${question.id}`)}><fieldset><legend>使う内容</legend>{question.choices.map((answer) => <label><input type="radio" name="answer" value={answer} required />{answer}</label>)}</fieldset><button>この答えを残す</button></form>
        </div></details> : <ClarificationForm ward={ward} question={question} back={back} />}
      </div>)}
    </section>; })}
    {!questions.length ? <p>質問はありません。</p> : !waiting.length ? <p>答えを待っている質問はありません。</p> : null}
    {done.length ? <details class="fold"><summary>答えたもの（{done.length}件）</summary><div>{done.map((question) => <p class="preserve-lines">{question.text}\n答え: {question.answer}</p>)}</div></details> : null}
  </Layout>);
});

admin.post("/inbox/questions/:clarificationId", async (c) => {
  const { ward, account } = c.var;
  const question = (await listClarifications(c.env.DB, ward.wardId)).find((question) => question.id === c.req.param("clarificationId"));
  if (!question) return c.notFound();
  const choices = await c.env.DB.prepare("SELECT DISTINCT answer_text FROM line_clarification_answers WHERE ward_id = ? AND clarification_id = ?")
    .bind(ward.wardId, question.id).all<{ answer_text: string }>();
  if (question.answer && (choices.results.length <= 1 || choices.results.some((row) => row.answer_text === question.answer))) return c.notFound();
  const form = await c.req.formData();
  const value = String(form.get("answer") ?? "").trim();
  const asked = String(form.get("back") ?? "");
  const returnTo = asked.startsWith(adminPath(ward, "/inbox/")) && !asked.includes("?") ? asked : adminPath(ward, "/inbox/questions");
  const back = { href: returnTo, label: "質問に戻る" };
  if (!value || value.length > 2000) return adminResult(c, "答えを入れてください。", 400, back, "分かるところを2000文字までで書いてください。");
  if (question.project_id && question.question_id) {
    if (!await answerQuestion(c.env.DB, ward.wardId, question.project_id, question.question_id, value === "分からない" ? "unknown" : "answer", value, account.accountId)) return adminResult(c, "答えを残せませんでした。", 409, back, "質問が閉じられていないか確かめてください。");
  } else await c.env.DB.batch([
    c.env.DB.prepare("UPDATE line_clarifications SET answer = ?, answered_unknown = ? WHERE ward_id = ? AND clarification_id = ? AND (answer IS NULL OR answer = ?)").bind(value, value === "分からない" ? 1 : 0, ward.wardId, question.id, question.answer),
    c.env.DB.prepare("UPDATE line_photo_batches SET screen_answered_at = ?, answer_reply_token = NULL, answer_reply_at = NULL WHERE ward_id = ? AND batch_id = ?").bind(new Date().toISOString(), ward.wardId, question.batch_id),
  ]);
  await completeScreenClarifications(c.env, ward.wardId);
  return c.redirect(`${returnTo}?n=answered`, 303);
});

admin.post("/inbox/city/:jobId", async (c) => {
  const { ward, account } = c.var;
  const jobId = c.req.param("jobId");
  const form = await c.req.formData();
  const operation = String(form.get("operation") ?? "assign");
  const job = await c.env.DB.prepare("SELECT via, project_id, ai_matched_at, withdrawn_at FROM jobs WHERE ward_id = ? AND job_id = ?")
    .bind(ward.wardId, jobId).first<{ via: string; project_id: string | null; ai_matched_at: string | null; withdrawn_at: string | null }>();
  if (!job || job.via !== "admin" || job.withdrawn_at !== null) return c.notFound();
  let projectId = String(form.get("projectId") ?? "");
  if (operation === "new-project") {
    const title = String(form.get("projectName") ?? "").trim();
    const year = Number(form.get("year"));
    const kind = String(form.get("kind") ?? "city_request");
    if (!title || title.length > 100 || !Number.isInteger(year) || year < 2000 || year > 2100 || !PROJECT_KINDS.some((value) => value === kind)) return c.redirect(`/${ward.slug}/admin/inbox?error=input`, 303);
    const created = await createProject(c.env.DB, ward.wardId, { kind: kind as ProjectKind, title, year, accountId: account.accountId });
    projectId = created.projectId;
  }
  if (!projectId || !(await c.env.DB.prepare("SELECT 1 AS ok FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL")
    .bind(ward.wardId, projectId).first())) return adminResult(c, "開いている行事を選んでください。", 400, { href: adminPath(c.var.ward, "/inbox"), label: "届いたものに戻る" }, "開いている行事を選び直してください。");
  if (!(await assignProject(c.env, safeContext(c), ward.wardId, jobId, projectId))) return c.redirect(`/${ward.slug}/admin/inbox?error=busy`, 303);
  return c.redirect(`/${ward.slug}/admin/inbox?n=assigned&project=${projectId}`, 303);
});

admin.get("/inbox/city/:jobId/pick", async (c) => {
  const { ward } = c.var;
  const jobId = c.req.param("jobId");
  const [job, originals, projects, summaries, questions, groups] = await Promise.all([getJob(c.env.DB, ward.wardId, jobId), listOriginals(c.env.DB, ward.wardId, jobId), openProjects(c.env.DB, ward.wardId), jobSummaries(c.env.DB, ward.wardId), listClarifications(c.env.DB, ward.wardId), pendingMaterialGroups(c.env.DB, ward.wardId)]);
  if (!job || job.via !== "admin" || job.withdrawn_at) return c.notFound();
  const summary = summaries.get(jobId) ?? "";
  const original = (id: string) => adminPath(ward, `/intake/originals/${id}`);
  const shown = originals.filter((o) => !o.withdrawn_at);
  const name = projects.find((project) => project.project_id === job.project_id)?.name;
  const group = groups.find((g) => g.title && g.materials.some((m) => m.jobId === jobId));
  return c.html(<InboxPick ward={ward} answered={c.req.query("n") === "answered"} noun={shown.some((o) => o.media_type.startsWith("image/")) ? "写真" : "資料"} suggested={group?.joins?.projectId ?? null} suggestedName={group && !group.joins ? group.title : ""} suggestedKind={group?.kind ?? "event"} title={shortLine(summary) || originals[0]?.filename || "届いた資料"}
    facts={[["届いた日", formatJst(job.created_at)], ["送った所", "この画面から"], ["入れた行事", name ?? "まだ入っていません"]]}
    photos={shown.filter((o) => o.media_type.startsWith("image/")).map((o) => ({ src: `${original(o.original_id)}?raw=1`, alt: o.filename || "届いた資料の写真" }))}
    files={shown.filter((o) => !o.media_type.startsWith("image/")).map((o) => ({ href: original(o.original_id), label: `${o.filename || "届いた資料"}を開く` }))}
    summary={summary} reason={null} questions={questions.filter((q) => q.job_id === jobId && !q.answer)} back={adminPath(ward, `/inbox/city/${jobId}/pick`)}
    action={adminPath(ward, `/inbox/city/${jobId}`)} projects={projects} current={job.project_id} removable={false} />);
});

admin.get("/inbox/:itemId/pick", async (c) => {
  const { ward } = c.var;
  const itemId = c.req.param("itemId");
  const [item, projects, summaries, questions, groups] = await Promise.all([
    c.env.DB.prepare(`SELECT i.job_id, i.original_kind, i.original_text, i.received_at, i.matched_project_id, i.matched_project_name, i.match_reason, i.sender_display_name, i.sender_label, j.project_id AS job_project_id
      FROM line_inbox_items i LEFT JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id WHERE i.ward_id = ? AND i.item_id = ?`)
      .bind(ward.wardId, itemId).first<{ job_id: string | null; original_kind: string; original_text: string | null; received_at: string; matched_project_id: string | null; matched_project_name: string | null; match_reason: string | null; sender_display_name: string | null; sender_label: string | null; job_project_id: string | null }>(),
    openProjects(c.env.DB, ward.wardId), jobSummaries(c.env.DB, ward.wardId), listClarifications(c.env.DB, ward.wardId), pendingMaterialGroups(c.env.DB, ward.wardId),
  ]);
  if (!item) return c.notFound();
  const sender = item.sender_display_name || item.sender_label;
  const summary = summaries.get(item.job_id ?? "") ?? "";
  const current = item.matched_project_id ?? item.job_project_id;
  const name = item.matched_project_name ?? projects.find((project) => project.project_id === current)?.name;
  const image = item.original_kind === "image" && item.job_id;
  const group = groups.find((g) => g.title && g.materials.some((m) => m.jobId === item.job_id));
  return c.html(<InboxPick ward={ward} answered={c.req.query("n") === "answered"} noun={item.original_kind === "text" ? "文" : "写真"} suggested={group?.joins?.projectId ?? null} suggestedName={group && !group.joins ? group.title : ""} suggestedKind={group?.kind ?? "event"} title={item.original_text ? `「${shortLine(item.original_text, 30)}」` : shortLine(summary) || "届いた写真"}
    facts={[["送った人", sender ? `${sender}さん（公式LINE）` : "公式LINE"], ["届いた日", formatJst(item.received_at)], ["入れた行事", name ?? "まだ入っていません"]]}
    photos={image ? [{ src: adminPath(ward, `/inbox/${itemId}/original`), alt: shortLine(summary) || "届いた写真" }] : []} files={[]}
    summary={item.original_text ? "" : summary} reason={current ? item.match_reason : null} questions={questions.filter((q) => q.job_id === item.job_id && !q.answer)} back={adminPath(ward, `/inbox/${itemId}/pick`)}
    action={adminPath(ward, `/inbox/${itemId}`)} projects={projects} current={current} removable={Boolean(item.job_id)} />);
});

admin.get("/inbox/:itemId/original", async (c) => {
  const { wardId } = c.var.ward;
  const row = await c.env.DB.prepare(`
    SELECT job_id, original_kind FROM line_inbox_items
    WHERE ward_id = ? AND item_id = ?
  `).bind(wardId, c.req.param("itemId")).first<{ job_id: string | null; original_kind: string }>();
  if (!row?.job_id) return c.notFound();
  const original = await c.env.DB.prepare("SELECT r2_path, media_type FROM originals WHERE ward_id = ? AND job_id = ? ORDER BY position LIMIT 1")
    .bind(wardId, row.job_id).first<{ r2_path: string | null; media_type: string }>();
  if (!original?.r2_path) return c.notFound();
  const object = await new WardBucket(c.env.ORIGINALS, wardId).get(original.r2_path);
  if (!object) return c.notFound();
  return new Response(object.body, {
    headers: { "content-type": original.media_type, "cache-control": "private, no-store" },
  });
});

admin.post("/inbox/:itemId", async (c) => {
  const { wardId } = c.var.ward;
  const form = await c.req.parseBody();
  const operation = form.operation;
  const itemId = c.req.param("itemId");
  if (operation === "unrelated") {
    const item = await c.env.DB.prepare("SELECT job_id FROM line_inbox_items WHERE ward_id = ? AND item_id = ?").bind(wardId, itemId).first<{ job_id: string | null }>();
    if (!item?.job_id || !(await withdrawJob(c.env, wardId, item.job_id))) return c.redirect(`/${c.var.ward.slug}/admin/inbox?error=busy`, 303);
    await markInboxItemUnrelated(c.env.DB, wardId, itemId);
    return c.redirect(`/${c.var.ward.slug}/admin/inbox?n=removed`, 303);
  } else if (operation === "assign") {
    const projectId = typeof form.projectId === "string" ? form.projectId : "";
    const project = await c.env.DB.prepare(`
      SELECT title AS name FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL
    `).bind(wardId, projectId).first<{ name: string }>();
    if (!project) return c.redirect(`/${c.var.ward.slug}/admin/inbox?error=input`, 303);
    {
      const item = await c.env.DB.prepare("SELECT job_id FROM line_inbox_items WHERE ward_id = ? AND item_id = ?")
        .bind(wardId, itemId).first<{ job_id: string | null }>();
      if (!item) return c.redirect(`/${c.var.ward.slug}/admin/inbox?error=busy`, 303);
      if (item.job_id) {
        if (!(await assignProject(c.env, safeContext(c), wardId, item.job_id, projectId))) return c.redirect(`/${c.var.ward.slug}/admin/inbox?error=busy`, 303);
        await rememberPhotoSource(c.env.DB, wardId, item.job_id, projectId);
      }
      await c.env.DB.prepare(`
        UPDATE line_inbox_items SET disposition = 'matched', matched_project_id = ?,
          matched_project_name = ?, match_reason = NULL WHERE ward_id = ? AND item_id = ?
      `).bind(projectId, project.name, wardId, itemId).run();
      return c.redirect(`/${c.var.ward.slug}/admin/inbox?n=assigned&project=${projectId}`, 303);
    }
  } else if (operation === "new-project") {
    const projectName = typeof form.projectName === "string" ? form.projectName.trim() : "";
    const kind = String(form.kind);
    const year = Number(form.year);
    if (!projectName || projectName.length > 100 || !PROJECT_KINDS.some((value) => value === kind) || !Number.isInteger(year) || year < 2000 || year > 2100) return c.redirect(`/${c.var.ward.slug}/admin/inbox?error=input`, 303);
    {
      const created = await createProject(c.env.DB, wardId, { kind: kind as ProjectKind, title: projectName, year, accountId: c.var.account.accountId });
      const item = await c.env.DB.prepare("SELECT job_id FROM line_inbox_items WHERE ward_id = ? AND item_id = ?")
        .bind(wardId, itemId).first<{ job_id: string | null }>();
      if (item?.job_id) {
        await assignProject(c.env, safeContext(c), wardId, item.job_id, created.projectId);
        await rememberPhotoSource(c.env.DB, wardId, item.job_id, created.projectId);
      }
      await c.env.DB.prepare(`
        UPDATE line_inbox_items SET disposition = 'matched', matched_project_id = ?,
          matched_project_name = ?, match_reason = NULL WHERE ward_id = ? AND item_id = ?
      `).bind(created.projectId, projectName, wardId, itemId).run();
      return c.redirect(`/${c.var.ward.slug}/admin/inbox?n=assigned&project=${created.projectId}`, 303);
    }
  }
  return c.redirect(`/${c.var.ward.slug}/admin/inbox?n=assigned`, 303);
});

export const line: Bundle = {
  admin,
  async scheduled(event, env) {
    if (event.cron !== CRON.EVERY_5_MIN) return;
    // 最初に接続先の台帳から区だけを取り出し、以後の読み書きは全てその区に限定する。
    const wards = await env.DB.prepare(`SELECT DISTINCT l.ward_id, w.slug FROM line_channels l JOIN wards w ON w.ward_id = l.ward_id
      WHERE w.ward_id = l.ward_id AND w.is_active = 1`).all<{ ward_id: string; slug: string }>();
    const now = new Date();
    // 接続を外した区でも、一時的な文の期限を延ばさない。
    const contextWards = await env.DB.prepare("SELECT DISTINCT ward_id FROM line_photo_context_texts WHERE ward_id IS NOT NULL")
      .all<{ ward_id: string }>();
    for (const ward of contextWards.results) await purgePhotoTexts(env.DB, ward.ward_id, now);
    for (const ward of wards.results) {
      try {
        await sendOfficerDigest(env, ward.ward_id, ward.slug, now);
      }
      catch { console.error("役員への知らせを送れませんでした", ward.ward_id); }
      await processPhotoBatches(env, ward.ward_id);
    }
  },
  hooks: new Hono<AppEnv>().post("/line", async (c) =>
    acceptLineWebhook(c.req.raw, c.env, c.env.DB, undefined, new Date(), c.executionCtx),
  ),
};

export { getLineAllowance, sendLineTitleAndUrl, lineAccessToken } from "./api";
