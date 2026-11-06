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
import { getJob, listJobs, listOriginals } from "../intake/store";
import { pendingMaterialGroups } from "../intake/groups";
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
}

export async function listInboxItems(db: D1Database, wardId: string): Promise<InboxRow[]> {
  const result = await db.prepare(`
    SELECT item_id, job_id, original_kind, original_text, received_at, disposition, sender_display_name, sender_label,
      matched_project_name, match_reason
    FROM line_inbox_items
    WHERE ward_id = ?
    ORDER BY received_at DESC, item_id
  `).bind(wardId).all<InboxRow>();
  return result.results;
}

function safeContext(c: { executionCtx: Pick<ExecutionContext, "waitUntil"> }): Pick<ExecutionContext, "waitUntil"> {
  try { return c.executionCtx; } catch { return { waitUntil: () => undefined }; }
}

const openProjects = async (db: D1Database, wardId: string) => (await db.prepare("SELECT project_id, title AS name FROM projects WHERE ward_id = ? AND closed_at IS NULL ORDER BY created_at DESC")
  .bind(wardId).all<{ project_id: string; name: string }>()).results;

/** 届いたものを行事に入れる画面。LINE で届いたものと、この画面から送ったものの両方で使う。 */
function InboxPick({ ward, title, detail, originals, action, projects, current, removable }: {
  ward: AdminEnv["Variables"]["ward"]; title: string; detail: string; originals: { href: string; label: string }[]; action: string;
  projects: { project_id: string; name: string }[]; current: string | null; removable: boolean;
}) {
  const year = new Date(Date.now() + 9 * 3600_000).getUTCFullYear();
  return <Layout title="どの行事に入れますか" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/inbox")}>← 届いたものへ</a>
    <h1>どの行事に入れますか</h1><p class="lead">届いたものを、行事に入れます。分けなくてもかまいません。あとで入れ直せます。</p>
    <section class="panel"><b>{title}</b><p class="muted">{detail}</p>{originals.map((original) => <p class="link-line"><a href={original.href}>{original.label}</a></p>)}</section>
    {projects.length ? <form method="post" action={action}>
      <fieldset><legend>入れる行事</legend><div class="choice">{projects.map((project) => <label><input type="radio" name="projectId" value={project.project_id} checked={project.project_id === current} required /> {project.name}</label>)}</div></fieldset>
      <div class="action-links"><button name="operation" value="assign">この行事に入れる</button></div>
    </form> : <Notice>進めている行事はありません。下から新しく始められます。</Notice>}
    <details class="fold" open={!projects.length}><summary>新しい行事として始めて、入れる</summary><div><form method="post" action={action}>
      <div class="field"><label for="project-name">名前</label><input id="project-name" name="projectName" type="text" maxlength={100} required /><p class="help-text">行事の名前を入れてください。あとで直せます。</p></div>
      <fieldset><legend>種類</legend><div class="choice half">{PROJECT_KINDS.map((kind) => <label><input type="radio" name="kind" value={kind} checked={kind === "event"} /> {PROJECT_KIND_LABEL[kind]}</label>)}</div></fieldset>
      <div class="field"><label for="project-year">年</label><input id="project-year" name="year" type="text" inputmode="numeric" value={String(year)} required /></div>
      <button class="secondary" name="operation" value="new-project">新しく始めて入れる</button>
    </form></div></details>
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
  const [items, jobs, projects, groups, inquiries, clarifications] = await Promise.all([
    listInboxItems(db, ward.wardId), listJobs(db, ward.wardId, { limit: 100 }), openProjects(db, ward.wardId),
    pendingMaterialGroups(db, ward.wardId), openInquiries(db, ward.wardId), listClarifications(db, ward.wardId),
  ]);
  const adminJobs = jobs.filter((j) => j.via === "admin" && !j.withdrawn_at);
  const lineRows = await Promise.all(items.map(async (item) => ({ item, job: item.job_id ? await getJob(db, ward.wardId, item.job_id) : null })));
  const itemPick = (id: string) => adminPath(ward, `/inbox/${id}/pick`);
  const jobPick = (id: string) => adminPath(ward, `/inbox/city/${id}/pick`);
  const readingJobs = adminJobs.filter((j) => !j.project_id && j.status !== "read");
  const unmatched = lineRows.filter(({ item }) => item.disposition === "unmatched" && !groups.some((g) => g.materials.some((m) => m.jobId === item.job_id)));
  const assigned = adminJobs.filter((j) => j.project_id);
  const matched = lineRows.filter(({ item }) => item.disposition === "matched");
  const asked = inquiries.filter(({ group }) => group[0]!.kind === "inquiry");
  const nothing = !groups.length && !readingJobs.length && !unmatched.length && !asked.length && !assigned.length && !matched.length && !clarifications.length;
  return c.html(<Layout title="届いたもの" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/")}>← 最初の画面へ</a>
    {c.req.query("error") === "input" ? <Notice error>入れる行事を選び直してください。</Notice> : null}
    <h1>届いたもの</h1>
    {c.req.query("n") === "assigned" ? <><Notice>行事に入れました。</Notice><section class="next"><strong>次は</strong><p>段取りから続きを進められます。</p><a class="button" href={adminPath(ward, "/")}>最初の画面を見る</a></section><p>違うときは「別の行事に入れる」から直せます。</p></> : null}
    {c.req.query("n") === "removed" ? <Notice>関係のないものとして外しました。数だけが残ります。</Notice> : null}
    {c.req.query("error") === "busy" ? <Notice error>資料を行事に入れているところです。少ししてから、もう一度開いてください。</Notice> : null}
    {nothing ? <><div class="notice" role="status"><strong>届いたものはありません</strong><p>公式LINEや、QRコードのない紙で届いたものが、ここに入ります。</p></div><section class="next"><strong>次は</strong><p>手元の資料を送れます。</p><a class="button" href={adminPath(ward, "/intake")}>資料を送る</a></section></> : <>
    <p class="lead">AIが読んで、行事に入れました。違うときだけ直してください。分けなくてもかまいません。</p>
    {groups.length || readingJobs.length || unmatched.length ? <section class="panel"><h2>どの行事か分からないもの</h2>
      {groups.map((group) => { const jobIds = [...new Set(group.materials.map((m) => m.jobId))]; return <article><p><b>{group.title || group.materials[0]?.original.filename || "届いた資料"}</b></p>
        <p class="muted">{group.title ? `${group.title}の資料のようです。` : "何の資料か分からないものです。そのままでかまいません。"}{group.materials.length > 1 ? `${group.materials.length}件あります。` : ""}</p>
        <form method="post" action={adminPath(ward, "/intake/start")}><input type="hidden" name="group" value={group.key} /><div class="action-links"><button>{group.kind === "city_request" ? "市からの依頼として始める" : group.title ? `${group.title}を始める` : "このまま進める"}</button>
          {jobIds.map((id) => { const item = items.find((i) => i.job_id === id); return <a class="button secondary" href={item ? itemPick(item.item_id) : jobPick(id)}>{jobIds.length > 1 ? `${group.materials.find((m) => m.jobId === id)?.original.filename || "届いた資料"}を進めている行事に入れる` : "進めている行事に入れる"}</a>; })}</div></form>
      </article>; })}
      {readingJobs.map((j) => <p class="link-line"><a href={adminPath(ward, "/intake/received")}>{j.first_filename || "撮った写真"}: {STATUS_LABEL[j.status]}</a></p>)}
      {unmatched.map(({ item, job }) => <article>
        <p><b>{item.original_text ? `「${item.original_text}」` : "届いた写真"}</b></p><p class="muted">{job ? STATUS_LABEL[job.status] : "どの行事か分かりませんでした"}</p>
        <div class="action-links"><a class="button secondary" href={itemPick(item.item_id)}>進めている行事に入れる</a></div>
      </article>)}
    </section> : null}
    {asked.length ? <><h2>役員に届いた問い合わせ</h2>
      <p class="muted">{asked.some(({ group }) => group.some((row) => row.line_replied_at)) ? "AIは答えていません。送った人には「役員に伝えて、内容を確認します」と返しました。" : "AIは答えていません。"}</p>
      <ul class="rows">{asked.slice(0, 2).map(({ group, project }) => { const record = group[0]!; const words = dateWords(record.subject); return <li><a class="row-link" href={adminPath(ward, `/inquiries/${encodeURIComponent(record.inquiry_id)}`)}><b>「{inquirySubject(record.subject)}」</b>
        {record.line_source_type ? <span>送った人: {record.line_sender_label || "名前は分かりません"}（{record.line_source_type === "user" ? "公式への一対一" : "LINEグループ"}）</span> : null}
        <span>{words.map((word) => `「${word}」と書かれています。`).join("")}{group.length > 1 ? `同じ内容が${group.length}件あります` : `${formatJstDate(record.received_at)}に届きました`}</span>
        {project ? <span>{project.title}の話のようです</span> : null}
      </a></li>; })}
      {asked.length > 2 ? <li><a class="row-link" href={adminPath(ward, "/inquiries")}><b>ほかの問い合わせ {asked.length - 2}件</b><span>問い合わせと要望の画面で見られます</span></a></li> : null}</ul></> : null}
    {clarifications.length ? <p class="link-line"><a href={adminPath(ward, "/inbox/questions")}>送った資料についての質問を見る</a></p> : null}
    {assigned.length || matched.length ? <><h2>行事に入れたもの</h2><ul class="rows">
      {assigned.map((j) => <li class="panel"><b>{j.first_filename || "届いた文"}</b><p class="muted">{projects.find((p) => p.project_id === j.project_id)?.name ?? "行事"}に入れました</p><a class="quiet" href={jobPick(j.job_id)}>別の行事に入れる</a></li>)}
      {matched.map(({ item, job }) => <li class="panel"><b>{item.original_text ? `「${item.original_text}」` : "届いた写真"}</b><p class="muted">{item.sender_display_name || "役員"}がLINEで送りました。{(item.matched_project_name ?? projects.find((p) => p.project_id === job?.project_id)?.name) ? `${item.matched_project_name ?? projects.find((p) => p.project_id === job?.project_id)?.name}に入れました` : job ? STATUS_LABEL[job.status] : "どの行事か分かりませんでした"}</p><a class="quiet" href={itemPick(item.item_id)}>別の行事に入れる</a></li>)}
    </ul></> : null}
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
  return c.html(<Layout title="質問" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/inbox")}>← 届いたものへ</a>
    <h1>送った資料についての質問</h1><p class="lead">読めないところなどを残しています。分かるものだけ答えられます。答えがなくても仕事は進められます。</p>
    {questions.map((question) => <section class="panel"><h2>{question.text}</h2>
      <p class="link-line"><a href={adminPath(ward, `/intake/originals/${question.original_id}`)}>元の資料を見る</a></p>
      <p>{question.sent_at ? "写真が届いた場所で聞きました。答えがなくても、そのままでかまいません。" : "まだ公式LINEでは聞いていません。"}</p>
      {question.answer ? <p class="preserve-lines">届いた答え: {question.answer}</p> : null}
      {question.choices.length > 1 && !question.choices.includes(question.answer ?? "") ? <details class="fold"><summary>二つを見比べる</summary><div><p>使う方を選んでください。選ばなければ、今の内容のままです。</p>
        <form method="post" action={adminPath(ward, `/inbox/questions/${question.id}`)}><fieldset><legend>使う内容</legend>{question.choices.map((answer) => <label><input type="radio" name="answer" value={answer} required />{answer}</label>)}</fieldset><button>この答えを残す</button></form>
      </div></details> : null}
      {!question.answer ? <form method="post" action={adminPath(ward, `/inbox/questions/${question.id}`)}>
        {question.options.length > 1 ? <div class="action-links">{question.options.map((option) => <button class="secondary" name="answer" value={option}>{questionOptionLabel(option)}</button>)}</div>
          : <><label for={`answer-${question.id}`}>答え</label><input id={`answer-${question.id}`} name="answer" maxlength={2000} /><button>答えを残す</button></>}
        <button class="quiet" name="answer" value="分からない">分からない</button>
      </form> : null}
      {question.project_id ? <p class="link-line"><a href={adminPath(ward, `/projects/${question.project_id}/questions`)}>行事の質問を見る</a></p> : <p>どの行事か分からないものは、届いたものから入れ直せます。</p>}
    </section>)}
    {!questions.length ? <p>質問はありません。</p> : null}
  </Layout>);
});

admin.post("/inbox/questions/:clarificationId", async (c) => {
  const { ward, account } = c.var;
  const question = (await listClarifications(c.env.DB, ward.wardId)).find((question) => question.id === c.req.param("clarificationId"));
  if (!question) return c.notFound();
  const choices = await c.env.DB.prepare("SELECT DISTINCT answer_text FROM line_clarification_answers WHERE ward_id = ? AND clarification_id = ?")
    .bind(ward.wardId, question.id).all<{ answer_text: string }>();
  if (question.answer && (choices.results.length <= 1 || choices.results.some((row) => row.answer_text === question.answer))) return c.notFound();
  const value = String((await c.req.formData()).get("answer") ?? "").trim();
  const back = { href: adminPath(ward, "/inbox/questions"), label: "質問に戻る" };
  if (!value || value.length > 2000) return adminResult(c, "答えを入れてください。", 400, back, "分かるところを2000文字までで書いてください。");
  if (question.project_id && question.question_id) {
    if (!await answerQuestion(c.env.DB, ward.wardId, question.project_id, question.question_id, value === "分からない" ? "unknown" : "answer", value, account.accountId)) return adminResult(c, "答えを残せませんでした。", 409, back, "質問が閉じられていないか確かめてください。");
  } else await c.env.DB.batch([
    c.env.DB.prepare("UPDATE line_clarifications SET answer = ?, answered_unknown = ? WHERE ward_id = ? AND clarification_id = ? AND (answer IS NULL OR answer = ?)").bind(value, value === "分からない" ? 1 : 0, ward.wardId, question.id, question.answer),
    c.env.DB.prepare("UPDATE line_photo_batches SET screen_answered_at = ?, answer_reply_token = NULL, answer_reply_at = NULL WHERE ward_id = ? AND batch_id = ?").bind(new Date().toISOString(), ward.wardId, question.batch_id),
  ]);
  await completeScreenClarifications(c.env, ward.wardId);
  return adminResult(c, "答えを残しました。", 200, back, "ほかの質問を見られます。答えがそろうと、LINEにも聞き終わったことを知らせます。");
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
  return c.redirect(`/${ward.slug}/admin/inbox?n=assigned`, 303);
});

admin.get("/inbox/city/:jobId/pick", async (c) => {
  const { ward } = c.var;
  const jobId = c.req.param("jobId");
  const [job, originals, projects] = await Promise.all([getJob(c.env.DB, ward.wardId, jobId), listOriginals(c.env.DB, ward.wardId, jobId), openProjects(c.env.DB, ward.wardId)]);
  if (!job || job.via !== "admin" || job.withdrawn_at) return c.notFound();
  return c.html(<InboxPick ward={ward} title={originals[0]?.filename || "届いた資料"} detail={`${formatJst(job.created_at)}に、この画面から送りました。`}
    originals={originals.map((original, index) => ({ href: adminPath(ward, `/intake/originals/${original.original_id}`), label: originals.length > 1 ? `元の資料を見る（${index + 1}枚目）` : "元の資料を見る" }))}
    action={adminPath(ward, `/inbox/city/${jobId}`)} projects={projects} current={job.project_id} removable={false} />);
});

admin.get("/inbox/:itemId/pick", async (c) => {
  const { ward } = c.var;
  const itemId = c.req.param("itemId");
  const [item, projects] = await Promise.all([
    c.env.DB.prepare("SELECT job_id, original_text, received_at, matched_project_id, sender_display_name, sender_label FROM line_inbox_items WHERE ward_id = ? AND item_id = ?")
      .bind(ward.wardId, itemId).first<{ job_id: string | null; original_text: string | null; received_at: string; matched_project_id: string | null; sender_display_name: string | null; sender_label: string | null }>(),
    openProjects(c.env.DB, ward.wardId),
  ]);
  if (!item) return c.notFound();
  const sender = item.sender_display_name || item.sender_label;
  return c.html(<InboxPick ward={ward} title={item.original_text ? `「${item.original_text}」` : "届いた写真"}
    detail={`${formatJst(item.received_at)}に、公式LINEで${sender ? ` ${sender}さんが` : ""}送りました。`}
    originals={item.job_id ? [{ href: adminPath(ward, `/inbox/${itemId}/original`), label: "元の資料を見る" }] : []}
    action={adminPath(ward, `/inbox/${itemId}`)} projects={projects} current={item.matched_project_id} removable={Boolean(item.job_id)} />);
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
      if (!item?.job_id || !(await assignProject(c.env, safeContext(c), wardId, item.job_id, projectId))) return c.redirect(`/${c.var.ward.slug}/admin/inbox?error=busy`, 303);
      await rememberPhotoSource(c.env.DB, wardId, item.job_id, projectId);
      await c.env.DB.prepare(`
        UPDATE line_inbox_items SET disposition = 'matched', matched_project_id = ?,
          matched_project_name = ?, match_reason = NULL WHERE ward_id = ? AND item_id = ?
      `).bind(projectId, project.name, wardId, itemId).run();
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
