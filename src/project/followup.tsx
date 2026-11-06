import { adminResult } from "../core/admin-ui";
import { formatDateText, formatJstDate } from "../core/time";
import { Hono } from "hono";
import { adminPath } from "../core/auth";
import { newId, nowIso } from "../core/ids";
import { Layout, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { getReadings, listJobs } from "../intake/store";
import { getClient } from "../ai/deps";
import { MODEL } from "../ai/anthropic";
import { applyChange, getProjectState, getProjectSummary, listProjects } from "./api";
import { saveDocument } from "./actions";
import { cleanRowData, displayFieldValue, rowMatchKey, type RowData } from "./model";
import { hashOf, stableStringify } from "./util";

export const followupAdmin = new Hono<AdminEnv>();

/** 公式 LINE の問い合わせは原文で残す。AI も架空の入力者アカウントも使わない。 */
export async function recordLineInquiry(db: D1Database, wardId: string, input: {
  eventId: string; receivedAt: string; text: string; sourceType: string; sourceId: string; senderLabel: string | null;
}): Promise<void> {
  await db.prepare(`INSERT OR IGNORE INTO inquiry_records
    (inquiry_id, ward_id, received_at, kind, subject, answer, submitted_to_city, created_by_account_id, created_at,
      line_event_id, line_source_type, line_source_id, line_sender_label)
    VALUES (?, ?, ?, 'inquiry', ?, '', 0, NULL, ?, ?, ?, ?, ?)`)
    .bind(newId(), wardId, input.receivedAt, input.text, nowIso(), input.eventId, input.sourceType, input.sourceId, input.senderLabel).run();
}

interface InquiryRow {
  inquiry_id: string; received_at: string; kind: "inquiry" | "request"; subject: string;
  answer: string; submitted_to_city: number; line_source_type: string | null;
  line_sender_label: string | null; line_replied_at: string | null; answer_history: string;
}

const INQUIRY_NOTICE = "問い合わせが来た日に一度、役員グループへLINEで知らせます。行事や締切が近いときは、知らせを待たずに、ときどき見てください。";
const inquiryPath = (id: string) => `/inquiries/${encodeURIComponent(id)}`;
const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

export function daysRemaining(date: string): string {
  const days = Math.round((Date.parse(date.slice(0, 10)) - Date.parse(today())) / 86400_000);
  if (!Number.isFinite(days)) return "";
  return days > 0 ? `あと${days}日` : days === 0 ? "今日です" : `${-days}日前です`;
}

function dateWords(subject: string): string[] {
  return [...new Set(subject.match(/今日|明日|あさって|明後日|今週|来週|今月|来月|[0-9０-９]{1,2}月[0-9０-９]{1,2}日/g) ?? [])];
}

async function inquiryRecords(db: D1Database, wardId: string): Promise<InquiryRow[]> {
  const rows = await db.prepare(`SELECT inquiry_id, received_at, kind, subject, answer, submitted_to_city,
    line_source_type, line_sender_label, line_replied_at, answer_history FROM inquiry_records WHERE ward_id = ?
    ORDER BY received_at DESC, created_at DESC`).bind(wardId).all<InquiryRow>();
  return rows.results;
}

function inquiryGroups(records: InquiryRow[]): InquiryRow[][] {
  const groups = new Map<string, InquiryRow[]>();
  for (const row of records) {
    // 意味の推測で束ねず、書かれた文が同じものだけをまとめる。
    const key = JSON.stringify([row.subject.trim(), row.answer]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()];
}

function inquiryFacts(projects: Awaited<ReturnType<typeof listProjects>>, subject: string) {
  // 題が本文にそのまま書かれ、一つに決まるときだけ関係する行事を示す。
  const matches = projects.filter((p) => subject.includes(p.title));
  return matches.length === 1 ? matches[0] : null;
}

followupAdmin.get("/inquiries", async (c) => {
  const { ward } = c.var;
  const records = await inquiryRecords(c.env.DB, ward.wardId);
  const groups = inquiryGroups(records);
  const projects = await listProjects(c.env.DB, ward.wardId);
  const open = groups.filter((g) => !g[0]!.answer).map((group) => ({
    group, project: inquiryFacts(projects, group[0]!.subject),
  }));
  // 点数は付けない。日付の手がかりのあるものを先にし、その中は届いた日の順。
  open.sort((a, b) => Number(Boolean(dateWords(b.group[0]!.subject).length || b.project || b.group.length > 1))
    - Number(Boolean(dateWords(a.group[0]!.subject).length || a.project || a.group.length > 1))
    || b.group[0]!.received_at.localeCompare(a.group[0]!.received_at));
  const answered = groups.filter((g) => g[0]!.answer).map((g) => g[0]!);
  const requests = records.filter((r) => r.kind === "request");
  return c.html(<Layout title="問い合わせと要望" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/")}>最初の画面へ</a>
    <h1>問い合わせと要望</h1><p class="lead">公式LINEなどで届いた問い合わせです。AIは答えていません。どう答えたかを、一行で残せます。</p>
    <div class="action-links"><a class="button secondary" href={adminPath(ward, "/inquiries/write")}>電話や立ち話で受けたことを書く</a></div>
    {records.some((r) => r.line_replied_at) ? <Notice><strong>送った人には返事をしてあります</strong><p>「役員に伝えて、内容を確認します」と返しました。</p></Notice> : null}
    <p class="muted">{INQUIRY_NOTICE}</p>
    <h2>届いた問い合わせ（{open.length}件）</h2>
    <p class="muted">「明日」などの日付の言葉、行事までの日数、締切、同じ内容の件数が分かるものを上に並べています。ほかのものも同じ一覧にあります。</p>
    <ul class="rows">{open.map(({ group, project }) => { const record = group[0]!; return <li>
      <a class="row-link" href={adminPath(ward, inquiryPath(record.inquiry_id))}><b>「{record.subject}」</b>
        <span>送った人: {record.line_sender_label || "名前は分かりません"}{record.line_source_type ? `（${record.line_source_type === "user" ? "公式への一対一" : "LINEグループ"}）` : ""}</span>
        {dateWords(record.subject).map((word) => <span>「{word}」と書かれています</span>)}
        <span>{group.length > 1 ? `同じ内容が${group.length}件あります　` : ""}{formatJstDate(group[group.length - 1]!.received_at)}に届きました</span>
        {project ? <span>{project.title}の話のようです{project.deadlines.event_day ? `　行事まで${daysRemaining(project.deadlines.event_day)}` : ""}{project.deadlines.answer_due ? `　答えの締切は${formatJstDate(project.deadlines.answer_due)}　${daysRemaining(project.deadlines.answer_due)}` : ""}{project.deadlines.submit_due ? `　提出の締切は${formatJstDate(project.deadlines.submit_due)}　${daysRemaining(project.deadlines.submit_due)}` : ""}</span> : null}
      </a></li>; })}</ul>
    {open.length === 0 ? <p>届いている問い合わせはありません。電話や立ち話で受けたことも、上のボタンから書けます。</p> : null}
    <h2>答えを残したもの</h2><ul class="rows">{answered.map((r) => <li><a class="row-link" href={adminPath(ward, inquiryPath(r.inquiry_id))}><b>{r.kind === "request" ? "要望" : "問い合わせ"}　{r.subject}</b><span>{formatJstDate(r.received_at)}に受けました</span><span>答え: {r.answer}</span><span>{r.submitted_to_city ? "行政に出しました" : "行政には出していません"}</span></a></li>)}</ul>
    {answered.length === 0 ? <p>答えを残したものは、まだありません。</p> : null}
    <details class="fold"><summary>要望だけを見る（{requests.length}件）</summary><div><ul class="rows">{requests.map((r) => <li><a class="row-link" href={adminPath(ward, inquiryPath(r.inquiry_id))}><b>{r.subject}</b><span>{formatJstDate(r.received_at)}に受けました　{r.submitted_to_city ? "行政に出しました" : "行政には出していません"}</span></a></li>)}</ul>{requests.length === 0 ? <p>要望はまだありません。</p> : null}</div></details>
  </Layout>);
});

followupAdmin.get("/inquiries/write", (c) => {
  const { ward } = c.var;
  return c.html(<Layout title="受けたことを書く" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/inquiries")}>問い合わせと要望へ</a>
    <h1>受けたことを書く</h1><p class="lead">電話や立ち話で受けた問い合わせや要望を、一行で書いてください。</p>
    <form method="post" action={adminPath(ward, "/inquiries")}>
      <label for="receivedAt">受けた日</label><input id="receivedAt" name="receivedAt" type="date" value={today()} required />
      <details class="fold"><summary>要望として残すとき</summary><div><label for="kind">種類</label><select id="kind" name="kind"><option value="inquiry">問い合わせ</option><option value="request">要望</option></select></div></details>
      <label for="subject">何を受けたか</label><textarea id="subject" name="subject" maxlength={2000} required />
      <label for="answer">どう答えたか</label><textarea id="answer" name="answer" maxlength={2000} />
      <label><input type="checkbox" name="submittedToCity" value="yes" />行政に出した</label>
      <div class="action-bar"><button>記録する</button><a class="button secondary" href={adminPath(ward, "/inquiries")}>やめて一覧に戻る</a></div>
    </form>
  </Layout>);
});

followupAdmin.get("/inquiries/:inquiryId/original", async (c) => {
  const records = await inquiryRecords(c.env.DB, c.var.ward.wardId);
  const row = records.find((r) => r.inquiry_id === c.req.param("inquiryId"));
  if (!row) return c.notFound();
  const group = records.filter((r) => r.subject === row.subject);
  return c.html(<Layout title="元の文" siteName={c.var.ward.name} noindex adminHomeHref={adminPath(c.var.ward, "/")}>
    <a class="back" href={adminPath(c.var.ward, inquiryPath(row.inquiry_id))}>前の画面へ</a><h1>元の文</h1>
    <p class="lead">{row.line_source_type ? "公式LINEに届いたときのままの文です。" : "受けたこととして残した文です。"}この画面では直せません。</p>
    <dl class="facts"><dt>件数</dt><dd>{group.length}件</dd></dl>
    {group.map((r) => <div class="panel"><p class="muted">{formatJstDate(r.received_at)}　送った人: {r.line_sender_label || "名前は分かりません"}</p><p class="preserve-lines">{r.subject}</p></div>)}
    <p class="muted">この画面では直せません。どう答えたかは、問い合わせの画面で残します。</p>
  </Layout>);
});

followupAdmin.get("/inquiries/:inquiryId", async (c) => {
  const { ward } = c.var;
  const records = await inquiryRecords(c.env.DB, ward.wardId);
  const record = records.find((r) => r.inquiry_id === c.req.param("inquiryId"));
  if (!record) return c.notFound();
  const group = records.filter((r) => r.answer === record.answer && r.subject.trim() === record.subject.trim());
  const project = inquiryFacts(await listProjects(c.env.DB, ward.wardId), record.subject);
  const path = adminPath(ward, inquiryPath(record.inquiry_id));
  if (c.req.query("saved")) return c.html(<Layout title="答えを記録しました" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/inquiries")}>問い合わせと要望へ</a><h1>記録しました</h1>
    <div class="notice done"><strong>「{record.subject}」の{record.answer ? "答え" : "内容"}を残しました</strong><p>{record.answer ? "一覧の「答えを残したもの」に移しました。" : "一覧の「届いた問い合わせ」に入れました。"}書き間違えたときは、もう一度書いて記録してください。新しい記録が足されます。</p></div>
    <section class="next"><strong>次は</strong><p>ほかに届いている問い合わせは{inquiryGroups(records.filter((r) => !r.answer && r.subject.trim() !== record.subject.trim())).length}件です。</p><a class="button" href={adminPath(ward, "/inquiries")}>問い合わせの一覧を開く</a></section>
    <a class="quiet" href={path}>記録を直す</a>
  </Layout>);
  const notes = (JSON.parse(record.answer_history) as Array<{ answer: string; submitted_to_city: number; created_at: string }>).reverse();
  return c.html(<Layout title="問い合わせに答えを残す" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/inquiries")}>問い合わせと要望へ</a><h1>「{record.subject}」</h1>
    <p class="lead">AIは答えていません。どう答えたかを、一行で残してください。電話や直接答えたことも書けます。</p>
    <p class="muted">返事は、公式LINEの管理アプリか電話で送ってください。</p><p class="muted">{INQUIRY_NOTICE}</p>
    <a class="quiet" href={`${path}/original`}>元の文を見る</a>
    <dl class="facts"><dt>送った人</dt><dd>{record.line_sender_label || "名前は分かりません"}{record.line_source_type ? `（${record.line_source_type === "user" ? "公式への一対一" : "LINEグループ"}）` : ""}</dd><dt>届いた日</dt><dd>{group.map((r) => formatJstDate(r.received_at)).join("、")}</dd><dt>同じ内容</dt><dd>{group.length}件</dd>
      {project ? <><dt>関係する行事</dt><dd>{project.title}のようです。{project.deadlines.event_day ? `行事まで${daysRemaining(project.deadlines.event_day)}` : ""}</dd>{project.deadlines.answer_due ? <><dt>答えの締切</dt><dd>{formatJstDate(project.deadlines.answer_due)}　{daysRemaining(project.deadlines.answer_due)}</dd></> : null}</> : null}</dl>
    <form method="post" action={path}>
      {!record.line_source_type ? <><label for="receivedAt">受けた日</label><input id="receivedAt" name="receivedAt" type="date" value={record.received_at.slice(0, 10)} required /><label for="subject">何を受けたか</label><textarea id="subject" name="subject" maxlength={2000} required>{record.subject}</textarea></> : null}
      <label for="answer">どう答えたか</label><textarea id="answer" name="answer" maxlength={2000} required={Boolean(record.line_source_type)}>{record.answer}</textarea>
      <label><input type="checkbox" name="submittedToCity" value="yes" checked={Boolean(record.submitted_to_city)} />行政に出した</label>
      <details class="fold"><summary>要望として残すとき</summary><div><label for="kind">種類</label><select id="kind" name="kind"><option value="inquiry" selected={record.kind === "inquiry"}>問い合わせ</option><option value="request" selected={record.kind === "request"}>要望</option></select></div></details>
      <div class="action-bar"><button>どう答えたかを残す</button><a class="button secondary" href={adminPath(ward, "/inquiries")}>今は記録しない</a></div>
    </form>
    {notes.length ? <details class="fold"><summary>これまでに残した答え</summary><div>{notes.map((n) => <article><p>{formatJstDate(n.created_at)}</p><p class="preserve-lines">{n.answer}</p><p>{n.submitted_to_city ? "行政に出しました" : "行政には出していません"}</p></article>)}</div></details> : null}
    <details class="fold"><summary>この記録を消す</summary><div><p>間違えて残したときに、この記録と答えを消せます。消すと戻せません。</p><form method="post" action={`${path}/remove`}><button class="danger">この記録を消す</button></form></div></details>
  </Layout>);
});

followupAdmin.post("/inquiries", async (c) => {
  const { ward, account } = c.var;
  const form = await c.req.formData();
  const receivedAt = String(form.get("receivedAt") ?? "");
  const kind = String(form.get("kind") ?? "inquiry");
  const subject = String(form.get("subject") ?? "").trim();
  const answer = String(form.get("answer") ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedAt) || !["inquiry", "request"].includes(kind) || !subject || subject.length > 2000 || answer.length > 2000) {
    return adminResult(c, "入力を確かめてください。", 400, { href: adminPath(ward, "/inquiries/write"), label: "受けたことを書く画面に戻る" }, "受けた日と内容を入れて、もう一度記録してください。");
  }
  const id = newId();
  await c.env.DB.prepare(`INSERT INTO inquiry_records
    (inquiry_id, ward_id, received_at, kind, subject, answer, submitted_to_city, created_by_account_id, created_at, answer_history)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, ward.wardId, receivedAt, kind, subject, answer, form.get("submittedToCity") === "yes" ? 1 : 0, account.accountId, nowIso(), JSON.stringify(answer ? [{ answer, submitted_to_city: form.get("submittedToCity") === "yes" ? 1 : 0, created_at: nowIso(), created_by_account_id: account.accountId }] : [])).run();
  return c.redirect(`${adminPath(ward, inquiryPath(id))}?saved=1`, 303);
});

followupAdmin.post("/inquiries/:inquiryId", async (c) => {
  const { ward, account } = c.var;
  const records = await inquiryRecords(c.env.DB, ward.wardId);
  const record = records.find((r) => r.inquiry_id === c.req.param("inquiryId"));
  if (!record) return c.notFound();
  const form = await c.req.formData();
  const answer = String(form.get("answer") ?? "").trim();
  const kind = String(form.get("kind") ?? record.kind);
  const submitted = form.get("submittedToCity") === "yes" ? 1 : 0;
  if ((!answer && record.line_source_type) || answer.length > 2000 || !["inquiry", "request"].includes(kind)) return adminResult(c, "どう答えたかを入れてください。", 400, { href: adminPath(ward, inquiryPath(record.inquiry_id)), label: "問い合わせに戻る" }, "どう答えたかを2000文字までで書き、もう一度記録してください。");
  const subject = record.line_source_type ? record.subject : String(form.get("subject") ?? record.subject).trim();
  const receivedAt = record.line_source_type ? record.received_at : String(form.get("receivedAt") ?? record.received_at);
  if (!subject || subject.length > 2000 || !/^\d{4}-\d{2}-\d{2}/.test(receivedAt)) return adminResult(c, "受けた内容と日付を確かめてください。", 400, { href: adminPath(ward, inquiryPath(record.inquiry_id)), label: "問い合わせに戻る" }, "受けた日と内容を入れて、もう一度記録してください。");
  const group = record.line_source_type ? records.filter((r) => r.answer === record.answer && r.subject.trim() === record.subject.trim()) : [record];
  const now = nowIso();
  await c.env.DB.batch(group.map((r) => {
    const history = JSON.parse(r.answer_history) as Array<{ answer: string; submitted_to_city: number; created_at: string; created_by_account_id?: string }>;
    if (r.answer && history.length === 0) history.push({ answer: r.answer, submitted_to_city: r.submitted_to_city, created_at: r.received_at });
    history.push({ answer, submitted_to_city: submitted, created_at: now, created_by_account_id: account.accountId });
    return c.env.DB.prepare(`UPDATE inquiry_records SET answer = ?, kind = ?, submitted_to_city = ?, answer_history = ?, subject = ?, received_at = ? WHERE ward_id = ? AND inquiry_id = ?`)
      .bind(answer, kind, submitted, JSON.stringify(history), record.line_source_type ? r.subject : subject, record.line_source_type ? r.received_at : receivedAt, ward.wardId, r.inquiry_id);
  }));
  return c.redirect(`${adminPath(ward, inquiryPath(record.inquiry_id))}?saved=1`, 303);
});

followupAdmin.post("/inquiries/:inquiryId/remove", async (c) => {
  await c.env.DB.prepare("DELETE FROM inquiry_records WHERE ward_id = ? AND inquiry_id = ?").bind(c.var.ward.wardId, c.req.param("inquiryId")).run();
  return adminResult(c, "問い合わせの記録を消しました。", 200, { href: adminPath(c.var.ward, "/inquiries"), label: "問い合わせの一覧を開く" }, "ほかに届いている問い合わせを見られます。間違えて消したときは、受けたことを書く画面からもう一度残してください。");
});

interface CityRequestRow {
  project_id: string;
  title: string;
  year: number;
  due_on: string | null;
  submitted_on: string | null;
}

followupAdmin.get("/requests/city", async (c) => {
  const { ward } = c.var;
  const projects = await c.env.DB.prepare(`SELECT p.project_id, p.title, p.year, d.due_on, d.submitted_on
    FROM projects p LEFT JOIN city_request_details d ON d.ward_id = p.ward_id AND d.project_id = p.project_id
    WHERE p.ward_id = ? AND p.kind = 'city_request' ORDER BY COALESCE(d.due_on, '9999-12-31'), p.year DESC, p.created_at DESC`)
    .bind(ward.wardId).all<CityRequestRow>();
  const rows = await Promise.all(projects.results.map(async (project) => {
    const state = await getProjectState(c.env.DB, ward.wardId, project.project_id);
    return { ...project, dueOn: project.due_on ?? state?.items.find((item) => item.key === "due")?.current?.content ?? null };
  }));
  rows.sort((a, b) => (a.dueOn ?? "9999-12-31").localeCompare(b.dueOn ?? "9999-12-31") || b.year - a.year);
  return c.html(<Layout title="行政の依頼" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/")}>最初の画面へ</a><h1>行政の依頼</h1><p class="lead">行政から届いた依頼と、締切です。押すと、答えの下書きや、出したことを残せます。</p>
    <div class="action-links"><a class="button secondary" href={adminPath(ward, `/intake?back=${encodeURIComponent(adminPath(ward, "/requests/city"))}`)}>通知を撮って送る</a></div>
    {[false, true].map((submitted) => <section><h2>{submitted ? "出したもの" : "まだ出していないもの"}</h2><ul class="rows">{rows.filter((p) => Boolean(p.submitted_on) === submitted).map((project) => <li><a class="row-link" href={adminPath(ward, `/requests/city/${encodeURIComponent(project.project_id)}`)}><b>{project.title}</b><span>{project.year}年　締切は{project.dueOn ? formatDateText(project.dueOn) : "まだ分かりません"}</span><span>{project.submitted_on ? `${formatJstDate(project.submitted_on)}に出しました` : "出したことの記録はありません"}</span></a></li>)}</ul>{rows.filter((p) => Boolean(p.submitted_on) === submitted).length === 0 ? <p>{submitted ? "出したものはまだありません。行政に出したら、依頼の画面から残せます。" : "まだ出していない依頼はありません。届いた通知は、上のボタンから撮って送れます。"}</p> : null}</section>)}
    <p class="link-line"><a href={adminPath(ward, "/")}>役員画面へ</a></p>
  </Layout>);
});

followupAdmin.get("/requests/city/:projectId", async (c) => {
  const { ward } = c.var;
  const projectId = c.req.param("projectId");
  const project = await getProjectSummary(c.env.DB, ward.wardId, projectId);
  if (!project || project.kind !== "city_request") return c.notFound();
  const state = await getProjectState(c.env.DB, ward.wardId, projectId);
  const readDue = state?.items.find((item) => item.key === "due")?.current?.content ?? "";
  const details = await c.env.DB.prepare(`SELECT due_on, answer_draft, submitted_what, submitted_to, submitted_on, notice_body
    FROM city_request_details WHERE ward_id = ? AND project_id = ?`).bind(ward.wardId, projectId)
    .first<{ due_on: string | null; answer_draft: string; submitted_what: string; submitted_to: string; submitted_on: string | null; notice_body: string }>();
  const jobs = await listJobs(c.env.DB, ward.wardId, { projectId, limit: 20 });
  const readings = await Promise.all(jobs.map((job) => getReadings(c.env.DB, ward.wardId, job.job_id)));
  const sourceText = readings.flatMap((rows) => rows.map((row) => row.body.summary)).filter(Boolean).join("\n").slice(0, 6000);
  const back = adminPath(ward, `/requests/city/${encodeURIComponent(projectId)}`);
  if (c.req.query("saved")) return c.html(<Layout title="行政の依頼を記録しました" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={back}>{project.title}へ</a><h1>記録しました</h1>
    <div class="notice done"><strong>{project.title}の内容を保存しました</strong><p>間違えたときは、前の画面で直して、もう一度「記録する」を押してください。</p></div>
    <section class="next"><strong>次は</strong><p>{details?.submitted_on ? "出したことの記録も残りました。ほかの行政の依頼を見られます。" : "出した日がまだ空です。行政に出したら、出したものと出した日を入れてください。"}</p><a class="button" href={details?.submitted_on ? adminPath(ward, "/requests/city") : back}>{details?.submitted_on ? "行政の依頼の一覧を開く" : "出したことを入れる"}</a></section>
    <a class="quiet" href={adminPath(ward, "/requests/city")}>行政の依頼の一覧に戻る</a>
  </Layout>);
  const originals = await c.env.DB.prepare(`SELECT o.original_id, o.filename FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id WHERE o.ward_id = ? AND j.project_id = ? AND o.withdrawn_at IS NULL`).bind(ward.wardId, projectId).all<{ original_id: string; filename: string }>();
  return c.html(<Layout title={project.title} siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <h1>{project.title}</h1><p class="lead">届いた通知を読み、締切や提出先、答えの下書きを残す画面です。まず通知の内容と締切を確認してください。</p><p class="link-line"><a href={adminPath(ward, "/requests/city")}>行政の依頼一覧</a></p>
    {originals.results.map((o) => <p><a class="quiet" href={adminPath(ward, `/intake/originals/${encodeURIComponent(o.original_id)}?back=${encodeURIComponent(back)}`)}>元の通知を見る: {o.filename || "撮った写真"}</a></p>)}
    {sourceText ? <details class="panel"><summary>通知から読んだ要点</summary><p>{sourceText}</p></details> : null}
    <form method="post" action={adminPath(ward, `/requests/city/${encodeURIComponent(projectId)}`)} class="panel">
      {readDue ? <p>通知から読んだ期限: {readDue}</p> : null}
      <label for="dueOn">期限</label><input id="dueOn" name="dueOn" type="date" value={details?.due_on ?? (/^\d{4}-\d{2}-\d{2}$/.test(readDue) ? readDue : "")} />
      <label for="answerDraft">答えの下書き</label><textarea id="answerDraft" name="answerDraft" maxlength={6000} rows={10}>{details?.answer_draft ?? ""}</textarea>
      <button class="secondary" name="operation" value="draft">通知をもとに答えの下書きを作る</button>
      <label for="submittedWhat">出したもの</label><input id="submittedWhat" name="submittedWhat" maxlength={1000} value={details?.submitted_what ?? ""} />
      <label for="submittedTo">提出先</label><input id="submittedTo" name="submittedTo" maxlength={300} value={details?.submitted_to ?? ""} />
      <input type="hidden" name="submissionId" value={newId()} />
      <label for="submittedOn">提出した日</label><input id="submittedOn" name="submittedOn" type="date" value={details?.submitted_on ?? ""} />
      <label for="noticeBody">住民に配る文</label><textarea id="noticeBody" name="noticeBody" maxlength={4000} rows={6}>{details?.notice_body ?? ""}</textarea>
      <button class="secondary" name="operation" value="send">配る画面へ進む</button><p class="help-text">住民に配る文を「知らせ」として保存します。次の画面で内容と配る相手を確認できます。ここではまだ配りません。</p>
      <div class="action-bar"><button name="operation" value="save">記録する</button></div>
    </form>
  </Layout>);
});

followupAdmin.post("/requests/city/:projectId", async (c) => {
  const { ward, account } = c.var;
  const projectId = c.req.param("projectId");
  const project = await getProjectSummary(c.env.DB, ward.wardId, projectId);
  if (!project || project.kind !== "city_request") return c.notFound();
  const form = await c.req.formData();
  const operation = String(form.get("operation") ?? "save");
  const dueOn = String(form.get("dueOn") ?? "");
  const answerDraft = String(form.get("answerDraft") ?? "").trim();
  const submittedWhat = String(form.get("submittedWhat") ?? "").trim();
  const submittedTo = String(form.get("submittedTo") ?? "").trim();
  const submissionId = String(form.get("submissionId") ?? "");
  const submittedOn = String(form.get("submittedOn") ?? "");
  const noticeBody = String(form.get("noticeBody") ?? "").trim();
  if ((dueOn && !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) || (submittedOn && !/^\d{4}-\d{2}-\d{2}$/.test(submittedOn))) return adminResult(c, "日付を確かめてください。", 400, { href: adminPath(c.var.ward, `/requests/city/${encodeURIComponent(c.req.param("projectId"))}`), label: "依頼の画面に戻る" }, "日付や配る文を確かめて、もう一度操作してください。");

  let nextAnswer = answerDraft;
  if (operation === "draft") {
    const jobs = await listJobs(c.env.DB, ward.wardId, { projectId, limit: 20 });
    const readings = await Promise.all(jobs.map((job) => getReadings(c.env.DB, ward.wardId, job.job_id)));
    const text = readings.flatMap((rows) => rows.map((row) => row.body.summary)).filter(Boolean).join("\n").slice(0, 6000);
    const response = await getClient(c.env).messages.create({
      model: MODEL.main,
      max_tokens: 1800,
      system: "自治会の役員が行政へ提出する答えの下書きを作ります。通知と行事の情報に書かれている事実だけを使い、不明点は確認事項として示してください。提出や決定は行わず、日本語で下書きの本文だけを書いてください。",
      messages: [{ role: "user", content: `依頼: ${project.title}\n年度: ${project.year}\n期限: ${dueOn || "未記入"}\n通知の読み取り:\n${text || "通知の読み取りはありません。"}\n現在の下書き:\n${answerDraft || "ありません。"}` }],
    });
    nextAnswer = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").slice(0, 6000);
  }
  if (operation === "send" && (!noticeBody || noticeBody.length > 4000)) return adminResult(c, "配る文を入力してください。", 400, { href: adminPath(c.var.ward, `/requests/city/${encodeURIComponent(c.req.param("projectId"))}`), label: "依頼の画面に戻る" }, "日付や配る文を確かめて、もう一度操作してください。");
  const now = nowIso();
  await saveCityRequestDetails(c.env.DB, ward.wardId, projectId, dueOn || null, nextAnswer, submittedWhat, submittedTo, submittedOn || null, noticeBody, null, account.accountId, now);
  await recordSubmittedItem(c.env.DB, ward.wardId, projectId, submittedWhat, submittedTo, submittedOn, submissionId, account.accountId);
  if (operation === "send") {
    const current = await getProjectSummary(c.env.DB, ward.wardId, projectId);
    if (!current) return c.notFound();
    const saved = await saveDocument(c.env.DB, ward.wardId, projectId, account.accountId, {
      kind: "notice", title: project.title, scope: "public",
      body: JSON.stringify({ text: noticeBody, items: [] }), basedOn: current.stateVersion,
    });
    if (!saved) return adminResult(c, "知らせを保存できませんでした。行事が開いているか確かめてください。", 400, { href: adminPath(c.var.ward, `/requests/city/${encodeURIComponent(c.req.param("projectId"))}`), label: "依頼の画面に戻る" }, "日付や配る文を確かめて、もう一度操作してください。");
    return c.redirect(adminPath(ward, `/publish/${encodeURIComponent(projectId)}`), 303);
  }
  return c.redirect(`${adminPath(ward, `/requests/city/${encodeURIComponent(projectId)}`)}?saved=1`, 303);
});

async function recordSubmittedItem(
  db: D1Database,
  wardId: string,
  projectId: string,
  what: string,
  to: string,
  submittedOn: string,
  requestId: string,
  accountId: string,
): Promise<void> {
  if (!what || !submittedOn) return;
  await applyChange(db, wardId, projectId, {
    kind: "row",
    table: "submissions",
    data: { what, ...(to ? { to } : {}), submittedOn },
    source: { kind: "person", accountId },
    confidence: "high",
    packVersion: "person-submission@1",
    requestId: requestId || newId(),
  }, { actorAccountId: accountId });
}

async function saveCityRequestDetails(
  db: D1Database,
  wardId: string,
  projectId: string,
  dueOn: string | null,
  answerDraft: string,
  submittedWhat: string,
  submittedTo: string,
  submittedOn: string | null,
  noticeBody: string,
  noticeSentAt: string | null,
  accountId: string,
  now: string,
): Promise<void> {
  await db.prepare(`INSERT INTO city_request_details
    (ward_id, project_id, due_on, answer_draft, submitted_what, submitted_to, submitted_on, notice_body, notice_sent_at, updated_at, updated_by_account_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (ward_id, project_id) DO UPDATE SET due_on = excluded.due_on, answer_draft = excluded.answer_draft,
      submitted_what = excluded.submitted_what, submitted_to = excluded.submitted_to, submitted_on = excluded.submitted_on, notice_body = excluded.notice_body,
      notice_sent_at = CASE WHEN excluded.notice_sent_at IS NOT NULL THEN excluded.notice_sent_at ELSE city_request_details.notice_sent_at END,
      updated_at = excluded.updated_at, updated_by_account_id = excluded.updated_by_account_id`)
    .bind(wardId, projectId, dueOn, answerDraft, submittedWhat, submittedTo, submittedOn, noticeBody, noticeSentAt, now, accountId).run();
}

interface LedgerTotals { year: number; income: number; expense: number; sponsors: number; }
const yen = (amount: number) => `${amount.toLocaleString("ja-JP")}円`;
const budgetDifference = (actual: number, budget: number) => actual === budget ? "予算と同じ" : `予算より${yen(Math.abs(actual - budget))}${actual < budget ? "少ない" : "多い"}`;

followupAdmin.get("/ledger", async (c) => {
  const { ward } = c.var;
  const rows = await c.env.DB.prepare(`SELECT p.year, p.project_id, p.title, r.table_key, r.data FROM project_rows r JOIN projects p
    ON p.ward_id = r.ward_id AND p.project_id = r.project_id
    WHERE r.ward_id = ? AND r.table_key IN ('ledger', 'sponsors') AND r.scope = 'current' AND r.removed_at IS NULL`)
    .bind(ward.wardId).all<{ year: number; project_id: string; title: string; table_key: string; data: string }>();
  const totals = new Map<number, LedgerTotals>();
  for (const row of rows.results) {
    const data = JSON.parse(row.data) as RowData;
    const total = totals.get(row.year) ?? { year: row.year, income: 0, expense: 0, sponsors: 0 };
    if (typeof data.amount === "number" && Number.isInteger(data.amount)) {
      if (row.table_key === "sponsors") { total.sponsors += data.amount; total.income += data.amount; }
      else if (data.direction === "income") total.income += data.amount;
      else if (data.direction === "expense") total.expense += data.amount;
    }
    totals.set(row.year, total);
  }
  const currentYear = Number(today().slice(0, 4));
  const budgets = await c.env.DB.prepare("SELECT year, budget_income, budget_expense, settlement_draft FROM ward_annual_budgets WHERE ward_id = ? ORDER BY year DESC")
    .bind(ward.wardId).all<{ year: number; budget_income: number; budget_expense: number; settlement_draft: string }>();
  const budgetByYear = new Map(budgets.results.map((b) => [b.year, b]));
  const years = [...new Set([currentYear, ...totals.keys(), ...budgetByYear.keys()])].sort((a, b) => b - a);
  const renderYear = (year: number, main: boolean) => {
    const total = totals.get(year) ?? { year, income: 0, expense: 0, sponsors: 0 };
    const budget = budgetByYear.get(year);
    const draft = `収入合計: ${yen(total.income)}（うち協賛${yen(total.sponsors)}）\n支出合計: ${yen(total.expense)}\n差引: ${yen(total.income - total.expense)}`;
    return <form method="post" action={adminPath(ward, "/ledger")}>
      <h2>{year}年</h2>{rows.results.some((r) => r.year === year && typeof (JSON.parse(r.data) as RowData).amount !== "number") ? <p>金額が分からないものは、合計に含めていません。行事ごとの収支から直せます。</p> : null}<dl class="facts"><dt>収入</dt><dd>{yen(total.income)}{budget ? `（予算${yen(budget.budget_income)}）` : ""}<span class="muted block">協賛{yen(total.sponsors)}、ほかの収入{yen(total.income - total.sponsors)}</span></dd>
        <dt>支出</dt><dd>{yen(total.expense)}{budget ? `（予算${yen(budget.budget_expense)}）` : ""}</dd><dt>差引</dt><dd>{yen(total.income - total.expense)}</dd>
        <dt>予算との差</dt><dd>{budget ? `収入は${budgetDifference(total.income, budget.budget_income)}、支出は${budgetDifference(total.expense, budget.budget_expense)}` : "予算はまだ入っていません。下の欄に入れて保存できます。"}</dd></dl>
      <input type="hidden" name="year" value={year} />
      <label for={`income-${year}`}>収入の予算（円）</label><input id={`income-${year}`} name="budgetIncome" type="number" min="0" step="1" value={budget?.budget_income ?? 0} required />
      <label for={`expense-${year}`}>支出の予算（円）</label><input id={`expense-${year}`} name="budgetExpense" type="number" min="0" step="1" value={budget?.budget_expense ?? 0} required />
      <label for={`settlement-${year}`}>決算の下書き</label><textarea id={`settlement-${year}`} name="settlementDraft" rows={5} maxlength={4000}>{budget?.settlement_draft || draft}</textarea><p class="help-text">集計から作った文面です。直して使えます。</p>
      <div class={main ? "action-bar" : "action-links"}><button class={main ? undefined : "secondary"}>{main ? "予算と下書きを保存する" : `${year}年の予算と下書きを保存する`}</button></div>
    </form>;
  };
  if (c.req.query("saved")) return c.html(<Layout title="帳簿を保存しました" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/ledger")}>帳簿へ</a><h1>保存しました</h1>
    <div class="notice done"><strong>{c.req.query("year")}年の予算と決算の下書きを保存しました</strong><p>直したいときは、帳簿の画面で書き換えて、もう一度保存してください。前の内容は新しい内容に置き換わります。</p></div>
    <section class="next"><strong>次は</strong><p>決算の下書きは、総会の前に監査の方に見せてください。</p></section>
    <a class="quiet" href={adminPath(ward, "/ledger")}>帳簿の画面に戻る</a>
  </Layout>);
  const projects = await listProjects(c.env.DB, ward.wardId, { includeClosed: true });
  return c.html(<Layout title="帳簿" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/")}>最初の画面へ</a><h1>帳簿</h1>
    <p class="lead">収入と支出を年ごとに集めています。行事で残した収支も、ここに入ります。監査の判断は、役員と監査の方が行います。</p>
    {renderYear(currentYear, true)}
    <h2>行事ごとの収支</h2><ul class="rows">{projects.map((p) => <li><a class="row-link" href={adminPath(ward, `/projects/${p.projectId}/ledger`)}><b>{p.title}の収支</b><span>{p.year}年　領収書の写真から読み取った収入と支出を見られます</span></a></li>)}</ul>
    {projects.length === 0 ? <p>行事の収支はまだありません。行事を始め、領収書の写真を送ると、ここに入ります。</p> : null}
    {years.length > 1 ? <h2>ほかの年</h2> : null}{years.filter((y) => y !== currentYear).map((year) => <details class="fold"><summary>{year}年の帳簿を開く</summary><div>{renderYear(year, false)}</div></details>)}
  </Layout>);
});

followupAdmin.post("/ledger", async (c) => {
  const { ward, account } = c.var;
  const form = await c.req.formData();
  const year = Number(form.get("year"));
  const budgetIncome = Number(form.get("budgetIncome"));
  const budgetExpense = Number(form.get("budgetExpense"));
  const settlementDraft = String(form.get("settlementDraft") ?? "").trim();
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isSafeInteger(budgetIncome) || budgetIncome < 0 || !Number.isSafeInteger(budgetExpense) || budgetExpense < 0 || settlementDraft.length > 4000) return adminResult(c, "入力を確かめてください。", 400, { href: adminPath(ward, "/ledger"), label: "帳簿に戻る" }, "年と予算の金額、下書きの内容を確かめて、もう一度保存してください。");
  await c.env.DB.prepare(`INSERT INTO ward_annual_budgets
    (ward_id, year, budget_income, budget_expense, settlement_draft, updated_at, updated_by_account_id)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (ward_id, year) DO UPDATE SET budget_income = excluded.budget_income,
      budget_expense = excluded.budget_expense, settlement_draft = excluded.settlement_draft,
      updated_at = excluded.updated_at, updated_by_account_id = excluded.updated_by_account_id`)
    .bind(ward.wardId, year, budgetIncome, budgetExpense, settlementDraft, nowIso(), account.accountId).run();
  return c.redirect(`${adminPath(ward, "/ledger")}?saved=1&year=${year}`, 303);
});

followupAdmin.get("/projects/:projectId/ledger", async (c) => {
  const { ward } = c.var;
  const id = c.req.param("projectId");
  const state = await getProjectState(c.env.DB, ward.wardId, id);
  if (!state) return c.notFound();
  const rows = [...state.tables.sponsors, ...state.tables.ledger].filter((r) => r.scope === "current");
  const dataFor = (row: typeof rows[number]): RowData => row.table === "sponsors" ? { counterpart: row.data.name ?? "", direction: "income", ...row.data } : row.data;
  const income = rows.reduce((sum, row) => { const d = dataFor(row); return sum + (d.direction === "income" && typeof d.amount === "number" ? d.amount : 0); }, 0);
  const expense = rows.reduce((sum, row) => { const d = dataFor(row); return sum + (d.direction === "expense" && typeof d.amount === "number" ? d.amount : 0); }, 0);
  return c.html(<Layout title={`${state.project.title}の収支`} siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, `/projects/${id}/map`)}>{state.project.title}の段取りへ</a><h1>{state.project.title}の収支</h1>
    <p class="lead">領収書の写真を送ると、読み取った内容がここに入ります。協賛の返事も、収入として並びます。</p>
    {c.req.query("saved") ? <><Notice>収支の行を保存しました。元の資料は変わりません。</Notice><section class="next"><strong>次は</strong><p>年の集計と予算を見られます。</p><a class="button" href={adminPath(ward, "/ledger")}>年の集計と予算を見る</a></section><p>間違えたときは、同じ相手の名前を押して、もう一度直してください。</p></> : null}
    <p>収入は{yen(income)}、支出は{yen(expense)}です。{rows.some((r) => r.data.amount === undefined) ? "金額が分からないものは、合計に含めていません。" : ""}</p>
    <div class="action-links">{!state.project.closedAt ? <a class="button" href={adminPath(ward, `/intake?project=${encodeURIComponent(id)}`)}>領収書の写真を送る</a> : null}<a class="button secondary" href={adminPath(ward, "/ledger")}>年の集計と予算を見る</a></div>
    {rows.length ? <table class="stack"><thead><tr><th>相手</th><th>収入か支出</th><th>額</th><th>日付</th><th>領収書とメモ</th></tr></thead><tbody>{rows.map((row) => {
      const data = dataFor(row); const originalId = row.source.kind === "original" ? row.source.ref : String(data.receiptOriginalId || "");
      return <tr><td data-label="相手">{state.project.closedAt ? data.counterpart : <a href={adminPath(ward, `/projects/${id}/ledger/${row.rowId}`)}>{data.counterpart}</a>}</td><td data-label="収入か支出">{displayFieldValue("ledger", "direction", data.direction)}</td><td data-label="額" class="num">{data.amount === undefined ? "確かめ中" : displayFieldValue("ledger", "amount", data.amount)}</td><td data-label="日付">{displayFieldValue("ledger", "date", data.date)}</td><td data-label="領収書とメモ">{originalId ? <a class="quiet" href={adminPath(ward, `/intake/originals/${encodeURIComponent(originalId)}?back=${encodeURIComponent(adminPath(ward, `/projects/${id}/ledger`))}`)}>元の資料を開く</a> : null}<p>{row.table === "sponsors" ? `協賛の返事: ${displayFieldValue("sponsors", "reply", data.reply) || "まだありません"}` : ""}{data.note}</p></td></tr>;
    })}</tbody></table> : <p>収支の記録はまだありません。領収書の写真を送ると、読み取った内容がここに入ります。</p>}
    <p class="muted">読み違いがあるときは、相手の名前を押すと直せます。領収書の写真から入った行には、元の資料を開くリンクが付きます。</p>
  </Layout>);
});

followupAdmin.get("/projects/:projectId/ledger/:rowId", async (c) => {
  const { ward } = c.var;
  const id = c.req.param("projectId");
  const state = await getProjectState(c.env.DB, ward.wardId, id);
  const row = [...(state?.tables.ledger ?? []), ...(state?.tables.sponsors ?? [])].find((r) => r.rowId === c.req.param("rowId") && r.scope === "current");
  if (!state || !row) return c.notFound();
  const originalId = row.source.kind === "original" ? row.source.ref : String(row.data.receiptOriginalId || "");
  const back = adminPath(ward, `/projects/${id}/ledger`);
  return c.html(<Layout title="収支の行を直す" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={back}>{state.project.title}の収支へ</a><h1>収支の行を直す</h1><p class="lead">読み違いを直せます。元の資料は変わりません。</p>
    {state.project.closedAt ? <Notice>この行事は閉じています。開き直すと収支を直せます。</Notice> : <form method="post" action={adminPath(ward, `/projects/${id}/ledger/${row.rowId}`)}>
      <label for="counterpart">相手</label><input id="counterpart" name="counterpart" value={String(row.data.counterpart ?? row.data.name ?? "")} maxlength={200} required />
      <fieldset><legend>収入か支出か</legend>{row.table === "sponsors" ? <><p>協賛の収入</p><input type="hidden" name="direction" value="income" /></> : <div class="choice half"><label><input type="radio" name="direction" value="income" checked={row.data.direction === "income"} required />収入</label><label><input type="radio" name="direction" value="expense" checked={row.data.direction === "expense"} required />支出</label></div>}</fieldset>
      <label for="amount">額（円）</label><input id="amount" name="amount" type="number" inputmode="numeric" min="0" step="1" value={row.data.amount} required />{row.data.amount === undefined ? <p class="help-text">紙の金額が読めませんでした。</p> : null}
      {row.table === "ledger" ? <><label for="date">日付（分かれば）</label><input id="date" name="date" type="date" value={String(row.data.date ?? "")} /></> : null}
      <label for="note">メモ（書かなくてかまいません）</label><input id="note" name="note" value={String(row.data.note ?? "")} maxlength={2000} />
      {originalId ? <a class="quiet" href={adminPath(ward, `/intake/originals/${encodeURIComponent(originalId)}?back=${encodeURIComponent(adminPath(ward, `/projects/${id}/ledger/${row.rowId}`))}`)}>元の資料を見る</a> : null}
      <div class="action-bar"><button>保存する</button></div>
    </form>}
  </Layout>);
});

/** 元の資料と出どころを保ったまま、同じ行の読み違いを直す。 */
export async function saveLedgerRow(db: D1Database, wardId: string, projectId: string, rowId: string, accountId: string, data: RowData): Promise<boolean> {
  const state = await getProjectState(db, wardId, projectId);
  const row = [...(state?.tables.ledger ?? []), ...(state?.tables.sponsors ?? [])].find((r) => r.rowId === rowId && r.scope === "current");
  if (!state || state.project.closedAt || !row || (row.table !== "ledger" && row.table !== "sponsors")) return false;
  const cleaned = cleanRowData(row.table, data);
  if (!cleaned.ok) return false;
  if (stableStringify(cleaned.data) === stableStringify(row.data)) return true;
  const changedFields = [...new Set([...Object.keys(row.data), ...Object.keys(cleaned.data)])].filter((key) => row.data[key] !== cleaned.data[key]);
  const match = rowMatchKey(row.table, cleaned.data);
  if (state.tables[row.table].some((r) => r.scope === "current" && r.rowId !== rowId && r.matchKey === match)) return false;
  const now = nowIso(); const changeId = newId(); const nextVersion = state.project.stateVersion + 1;
  const payload = { kind: "row", table: row.table, data: cleaned.data, source: { kind: "person", accountId }, before: row.data };
  const payloadHash = await hashOf(payload);
  const result = await db.batch([
    db.prepare(`INSERT INTO project_changes (change_id, ward_id, project_id, kind, target, status, dedupe_key, payload_hash, payload, result, pack_version, source_kind, source_ref, confidence, state_version_after, created_at, created_by_account_id)
      SELECT ?, ?, ?, 'row', ?, 'applied', ?, ?, ?, ?, 'ledger-row-edit@1', 'person', ?, 'high', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND state_version = ? AND closed_at IS NULL)`)
      .bind(changeId, wardId, projectId, `${row.table}:${match}`, `ledger:${changeId}`, payloadHash, stableStringify(payload), JSON.stringify({ status: "applied", changeId, staleDocuments: ["report"], questionIds: [] }), `person:${accountId}`, nextVersion, now, accountId, wardId, projectId, state.project.stateVersion),
    db.prepare(`UPDATE project_rows SET data = ?, match_key = ?, person_fields = ?, change_id = ?, updated_at = ? WHERE ward_id = ? AND project_id = ? AND row_id = ? AND scope = 'current' AND removed_at IS NULL
      AND EXISTS (SELECT 1 FROM project_changes WHERE ward_id = ? AND project_id = ? AND change_id = ?)`)
      .bind(stableStringify(cleaned.data), match, JSON.stringify([...new Set([...row.personFields, ...changedFields])]), changeId, now, wardId, projectId, rowId, wardId, projectId, changeId),
    db.prepare(`UPDATE projects SET state_version = ? WHERE ward_id = ? AND project_id = ? AND state_version = ? AND closed_at IS NULL`)
      .bind(nextVersion, wardId, projectId, state.project.stateVersion),
    db.prepare(`UPDATE documents SET stale_since_version = COALESCE(stale_since_version, ?) WHERE ward_id = ? AND project_id = ? AND kind = 'report'
      AND EXISTS (SELECT 1 FROM project_changes WHERE ward_id = ? AND project_id = ? AND change_id = ?)`)
      .bind(nextVersion, wardId, projectId, wardId, projectId, changeId),
  ]);
  return result[0]?.meta.changes === 1 && result[1]?.meta.changes === 1 && result[2]?.meta.changes === 1;
}

followupAdmin.post("/projects/:projectId/ledger/:rowId", async (c) => {
  const { ward, account } = c.var;
  const id = c.req.param("projectId"); const rowId = c.req.param("rowId");
  const state = await getProjectState(c.env.DB, ward.wardId, id);
  const row = [...(state?.tables.ledger ?? []), ...(state?.tables.sponsors ?? [])].find((r) => r.rowId === rowId && r.scope === "current");
  if (!row) return c.notFound();
  const form = await c.req.formData();
  const name = String(form.get("counterpart") ?? "").trim(); const amount = Number(form.get("amount"));
  const note = String(form.get("note") ?? "").trim(); const date = String(form.get("date") ?? "");
  const direction = String(form.get("direction") ?? "");
  const back = { href: adminPath(ward, `/projects/${id}/ledger/${rowId}`), label: "収支の行に戻る" };
  if (!name || name.length > 200 || !String(form.get("amount") ?? "").trim() || !Number.isSafeInteger(amount) || amount < 0 || note.length > 2000 || (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) || (row.table === "sponsors" && direction !== "income")) return adminResult(c, "相手と金額、日付を確かめてください。", 400, back, "金額は0以上の整数で入れて、もう一度保存してください。");
  const data: RowData = { ...row.data, [row.table === "sponsors" ? "name" : "counterpart"]: name, amount, note };
  if (row.table === "ledger") { data.direction = direction; data.date = date; }
  if (!await saveLedgerRow(c.env.DB, ward.wardId, id, rowId, account.accountId, data)) return adminResult(c, "収支の行を保存できませんでした。", 409, back, "行事が開いているか、同じ相手と日付の行がないかを確かめて、もう一度直してください。");
  return c.redirect(`${adminPath(ward, `/projects/${id}/ledger`)}?saved=1`, 303);
});
