import { officerGroupId } from "../line/api";
import { inquirySubject, inquiryTarget, sameInquiry, sendInquiry, type InquiryRow } from "./inquiry-send";
import { getDigestSettings, inquiryNotice } from "../settings/digest";
import { memoAdmin } from "../map/memo";
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

export const followupAdmin = new Hono<AdminEnv>();

/** 公式 LINE の問い合わせは原文で残す。AI も架空の入力者アカウントも使わない。 */
export async function recordLineInquiry(db: D1Database, wardId: string, input: {
  eventId: string; receivedAt: string; text: string; sourceType: string; sourceId: string; userId?: string | null; senderLabel: string | null;
}): Promise<void> {
  await db.prepare(`INSERT OR IGNORE INTO inquiry_records
    (inquiry_id, ward_id, received_at, kind, subject, answer, submitted_to_city, created_by_account_id, created_at,
      line_event_id, line_source_type, line_source_id, line_sender_label, line_user_id)
    VALUES (?, ?, ?, 'inquiry', ?, '', 0, NULL, ?, ?, ?, ?, ?, ?)`)
    .bind(newId(), wardId, input.receivedAt, input.text, nowIso(), input.eventId, input.sourceType, input.sourceId, input.senderLabel, input.userId ?? (input.sourceType === "user" ? input.sourceId : null)).run();
}


const inquiryPath = (id: string) => `/inquiries/${encodeURIComponent(id)}`;
const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

const daysUntil = (date: string) => Math.round((Date.parse(date.slice(0, 10)) - Date.parse(today())) / 86400_000);

export function daysRemaining(date: string): string {
  const days = daysUntil(date);
  if (!Number.isFinite(days)) return "";
  return days > 0 ? `あと${days}日` : days === 0 ? "今日です" : `${-days}日過ぎました`;
}

/** 「行事まであと44日」。過ぎたあとも文が崩れないようにする。 */
function untilText(name: string, date: string): string {
  const days = daysUntil(date);
  if (!Number.isFinite(days)) return "";
  return days > 0 ? `${name}まであと${days}日` : days === 0 ? `${name}は今日です` : `${name}は${-days}日前でした`;
}

export function dateWords(subject: string): string[] {
  return [...new Set(subject.match(/今日|明日|あさって|明後日|今週|来週|今月|来月|[0-9０-９]{1,2}月[0-9０-９]{1,2}日/g) ?? [])];
}

async function inquiryRecords(db: D1Database, wardId: string): Promise<InquiryRow[]> {
  const rows = await db.prepare(`SELECT inquiry_id, received_at, kind, subject, answer, submitted_to_city,
    line_source_type, line_source_id, line_user_id, line_pending_answer, line_answer_sent_at, line_send_claimed_at, line_send_error, line_reply_batch, line_retry_key, line_retry_started_at, line_sender_label, line_replied_at, answer_history FROM inquiry_records WHERE ward_id = ?
    ORDER BY received_at DESC, created_at DESC, inquiry_id`).bind(wardId).all<InquiryRow>();
  return rows.results;
}

function inquiryGroups(records: InquiryRow[]): InquiryRow[][] {
  const groups = new Map<string, InquiryRow[]>();
  for (const row of records) {
    // 意味の推測で束ねず、書かれた文が同じものだけをまとめる。
    const key = JSON.stringify([inquirySubject(row.subject), row.answer]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()];
}

function inquiryFacts(projects: Awaited<ReturnType<typeof listProjects>>, subject: string) {
  // 題が本文にそのまま書かれ、一つに決まるときだけ関係する行事を示す。
  const matches = projects.filter((p) => subject.includes(p.title));
  return matches.length === 1 ? matches[0] : null;
}

// 点数は付けない。日付の手がかりのあるものを先にし、その中は届いた日の順。
function sortOpen(groups: InquiryRow[][], projects: Awaited<ReturnType<typeof listProjects>>) {
  return groups.filter((g) => !g[0]!.answer).map((group) => ({ group, project: inquiryFacts(projects, group[0]!.subject) }))
    .sort((a, b) => Number(Boolean(dateWords(b.group[0]!.subject).length || b.project || b.group.length > 1))
      - Number(Boolean(dateWords(a.group[0]!.subject).length || a.project || a.group.length > 1))
      || b.group[0]!.received_at.localeCompare(a.group[0]!.received_at));
}

/** 答えていない問い合わせを、問い合わせの画面と同じ順で返す。 */
export async function openInquiries(db: D1Database, wardId: string) {
  return sortOpen(inquiryGroups(await inquiryRecords(db, wardId)), await listProjects(db, wardId));
}

followupAdmin.get("/inquiries", async (c) => {
  const { ward } = c.var;
  const records = await inquiryRecords(c.env.DB, ward.wardId);
  const notice = inquiryNotice(await getDigestSettings(c.env.DB, ward.wardId), Boolean(await officerGroupId(c.env, ward.wardId)));
  const groups = inquiryGroups(records);
  const open = sortOpen(groups, await listProjects(c.env.DB, ward.wardId));
  const answered = groups.filter((g) => g[0]!.answer).map((g) => g[0]!);
  const requests = records.filter((r) => r.kind === "request");
  return c.html(<Layout title="問い合わせと要望" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/")}>← 最初の画面へ</a>
    <h1>問い合わせと要望</h1>
    {!groups.length ? <><div class="notice" role="status"><strong>届いている問い合わせはありません</strong><p>{notice}</p></div><section class="next"><strong>次は</strong><p>電話や立ち話で受けたことは、書いて残せます。</p><a class="button" href={adminPath(ward, "/inquiries/write")}>受けたことを書く</a></section></> : <><p class="lead">公式LINEなどで届いた問い合わせです。AIは答えていません。返事を書いて送れます。</p>
    <div class="action-links"><a class="button secondary" href={adminPath(ward, "/inquiries/write")}>電話や立ち話で受けたことを書く</a></div>
    {records.some((r) => r.line_replied_at) ? <Notice><strong>送った人には返事をしてあります</strong><p>「役員に伝えて、内容を確認します」と返しました。</p></Notice> : null}
    <p class="muted">{notice}</p>
    <h2>届いた問い合わせ（{open.length}件）</h2>
    <p class="muted">「明日」などの日付の言葉、行事までの日数、締切、同じ内容の件数が分かるものを上に並べています。ほかのものも同じ一覧にあります。</p>
    <ul class="rows">{open.map(({ group, project }) => { const record = group[0]!; return <li>
      <a class="row-link" href={adminPath(ward, inquiryPath(record.inquiry_id))}><b>「{inquirySubject(record.subject)}」</b>
        <span>送った人: {record.line_sender_label || "名前は分かりません"}{record.line_source_type ? `（${record.line_source_type === "user" ? "公式への一対一" : "LINEグループ"}）` : ""}</span>
        <span>{dateWords(record.subject).map((word) => `「${word}」と書かれています　`).join("")}{group.length > 1 ? `同じ内容が${group.length}件あります　最初は` : ""}{formatJstDate(group[group.length - 1]!.received_at)}に届きました</span>
        {project ? <span>{project.title}の話のようです{project.deadlines.event_day ? `　${untilText("行事", project.deadlines.event_day)}` : ""}{project.deadlines.answer_due ? `　${untilText("答えの締切", project.deadlines.answer_due)}` : ""}{project.deadlines.submit_due ? `　${untilText("提出の締切", project.deadlines.submit_due)}` : ""}</span> : null}
      </a></li>; })}</ul>
    {open.length === 0 ? <p>届いている問い合わせはありません。</p> : null}
    <h2>答えを残したもの</h2><ul class="rows">{answered.map((r) => <li><a class="row-link" href={adminPath(ward, inquiryPath(r.inquiry_id))}><b>{r.kind === "request" ? "要望" : "問い合わせ"}　{inquirySubject(r.subject)}</b><span>{formatJstDate(r.received_at)}に受けました</span><span>答え: {r.answer}</span><span>{r.submitted_to_city ? "行政に出しました" : "行政には出していません"}</span></a></li>)}</ul>
    {answered.length === 0 ? <p>答えを残したものは、まだありません。</p> : null}
    <details class="fold"><summary>要望だけを見る（{requests.length}件）</summary><div><ul class="rows">{requests.map((r) => <li><a class="row-link" href={adminPath(ward, inquiryPath(r.inquiry_id))}><b>{inquirySubject(r.subject)}</b><span>{formatJstDate(r.received_at)}に受けました　{r.submitted_to_city ? "行政に出しました" : "行政には出していません"}</span></a></li>)}</ul>{requests.length === 0 ? <p>要望はまだありません。</p> : null}</div></details></>}
  </Layout>);
});

followupAdmin.get("/inquiries/write", (c) => {
  const { ward } = c.var;
  return c.html(<Layout title="受けたことを書く" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/inquiries")}>← 問い合わせと要望へ</a>
    <h1>受けたことを書く</h1><p class="lead">電話や立ち話で受けた問い合わせや要望を、一行で書いてください。</p>
    <form method="post" action={adminPath(ward, "/inquiries")}>
      <label for="receivedAt">受けた日</label><input id="receivedAt" name="receivedAt" type="date" value={today()} required />
      <details class="fold"><summary>要望として残すとき</summary><div><label for="kind">種類</label><select id="kind" name="kind"><option value="inquiry">問い合わせ</option><option value="request">要望</option></select></div></details>
      <label for="subject">何を受けたか</label><textarea id="subject" name="subject" maxlength={2000} required />
      <label for="answer">返事の文、または電話や直接答えたこと</label><textarea id="answer" name="answer" maxlength={2000} />
      <label><input type="checkbox" name="submittedToCity" value="yes" />行政に出した</label>
      <div class="action-bar"><button>記録する</button><a class="button secondary" href={adminPath(ward, "/inquiries")}>やめて一覧に戻る</a></div>
    </form>
  </Layout>);
});

followupAdmin.get("/inquiries/:inquiryId/original", async (c) => {
  const records = await inquiryRecords(c.env.DB, c.var.ward.wardId);
  const row = records.find((r) => r.inquiry_id === c.req.param("inquiryId"));
  if (!row) return c.notFound();
  const group = records.filter((r) => inquirySubject(r.subject) === inquirySubject(row.subject));
  return c.html(<Layout title="元の文" siteName={c.var.ward.name} noindex adminHomeHref={adminPath(c.var.ward, "/")}>
    <a class="back" href={adminPath(c.var.ward, inquiryPath(row.inquiry_id))}>← 前の画面へ</a><h1>元の文</h1>
    <p class="lead">{row.line_source_type ? "公式LINEに届いたときのままの文です。" : "受けたこととして残した文です。"}この画面では直せません。</p>
    <dl class="facts"><dt>件数</dt><dd>{group.length}件</dd></dl>
    {group.map((r) => <div class="panel"><p class="muted">{formatJstDate(r.received_at)}　送った人: {r.line_sender_label || "名前は分かりません"}</p><p class="preserve-lines">{r.subject}</p></div>)}
    <p class="muted">この画面では直せません。どう答えたかは、問い合わせの画面で残します。</p>
  </Layout>);
});

followupAdmin.get("/inquiries/:inquiryId", async (c) => {
  const { ward } = c.var;
  const records = await inquiryRecords(c.env.DB, ward.wardId);
  const notice = inquiryNotice(await getDigestSettings(c.env.DB, ward.wardId), Boolean(await officerGroupId(c.env, ward.wardId)));
  const record = records.find((r) => r.inquiry_id === c.req.param("inquiryId"));
  if (!record) return c.notFound();
  const group = records.filter((r) => sameInquiry(r, record));
  const project = inquiryFacts(await listProjects(c.env.DB, ward.wardId), record.subject);
  const path = adminPath(ward, inquiryPath(record.inquiry_id));
  if (c.req.query("wish") === "1") return adminResult(c, "要望として残しました。", 200,
    { href: adminPath(ward, "/inquiries"), label: "問い合わせと要望へ" }, "要望の一覧に入りました。返事が要るときは、この問い合わせの画面から送れます。");
  if (c.req.query("saved")) return c.html(<Layout title="答えを記録しました" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/inquiries")}>← 問い合わせと要望へ</a><h1>記録しました</h1>
    <div class="notice done"><strong>「{inquirySubject(record.subject)}」の{record.answer ? "答え" : "内容"}を残しました</strong><p>{record.answer ? "一覧の「答えを残したもの」に移しました。" : "一覧の「届いた問い合わせ」に入れました。"}書き間違えたときは、もう一度書いて記録してください。新しい記録が足されます。</p></div>
    <section class="next"><strong>次は</strong><p>ほかに届いている問い合わせは{inquiryGroups(records.filter((r) => !r.answer && r.subject.trim() !== record.subject.trim())).length}件です。</p><a class="button" href={adminPath(ward, "/inquiries")}>問い合わせの一覧を開く</a></section>
    <a class="quiet" href={path}>記録を直す</a>
  </Layout>);
  const sentResult = c.req.query("sent") === "1";
  if (sentResult) return c.html(<Layout title="公式LINEに送りました" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/inquiries")}>← 問い合わせの一覧へ</a><h1>公式LINEに送りました</h1>
    <div class="notice done"><strong>送った文を記録に残しました</strong><p>送った返事は取り消せません。書き間違えたときは、この問い合わせを開いて直した返事を送れます。</p></div>
    <section class="next"><strong>次は</strong><p>ほかに届いている問い合わせを見られます。</p><a class="button" href={adminPath(ward, "/inquiries")}>問い合わせの一覧を開く</a></section><a class="quiet" href={path}>この問い合わせに戻る</a>
  </Layout>);
  const canPush = group.some((r) => r.line_source_type);
  const destinationCount = new Set(group.map(inquiryTarget).filter(Boolean)).size;
  const recipients = group.some((r) => r.line_source_type && r.line_source_type !== "user")
    ? `問い合わせが届いたグループや一対一のトーク${destinationCount}か所` : `公式へ一対一で送った${destinationCount}人`;
  const notes = (JSON.parse(record.answer_history) as Array<{ answer: string; submitted_to_city: number; created_at: string }>).reverse();
  return c.html(<Layout title="問い合わせに答えを残す" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/inquiries")}>← 問い合わせと要望へ</a><h1>「{inquirySubject(record.subject)}」</h1>
    <p class="lead">{canPush ? "AIは答えていません。返事を書いて送ると、来たところへ届き、そのまま記録に残ります。" : "AIは答えていません。LINEでは返せません。だれか分かるときは、電話や直接答えてください。"}</p>
    {group.some((r) => r.line_source_type && !r.line_user_id) ? <div class="notice warn"><strong>公式LINEで返事を送れない人がいます</strong><p>送り先が分からないため送れません。書いた返事を残し、電話や直接答えたときは、その内容を記録してください。</p></div> : null}<p class="muted">{notice}</p>
    <a class="quiet" href={`${path}/original`}>元の文を見る</a>
    <dl class="facts"><dt>送った人</dt><dd>{record.line_sender_label || "名前は分かりません"}{record.line_source_type ? `（${record.line_source_type === "user" ? "公式への一対一" : "LINEグループ"}）` : ""}</dd><dt>届いた日</dt><dd>{group.map((r) => formatJstDate(r.received_at)).join("、")}</dd><dt>同じ内容</dt><dd>{group.length}件</dd>{canPush ? <><dt>返事の送り先</dt><dd>{recipients}</dd></> : null}
      {project ? <><dt>関係する行事</dt><dd>{project.title}のようです。{project.deadlines.event_day ? `行事まで${daysRemaining(project.deadlines.event_day)}` : ""}</dd>{project.deadlines.answer_due ? <><dt>答えの締切</dt><dd>{formatJstDate(project.deadlines.answer_due)}　{daysRemaining(project.deadlines.answer_due)}</dd></> : null}</> : null}</dl>
    <form method="post" action={path}>
      <label for="answer">{canPush ? "返事" : "どう答えたか"}</label>
      <textarea id="answer" name="answer" maxlength={2000}>{record.line_pending_answer ?? record.answer}</textarea>
      {canPush ? <details class="fold"><summary>電話や直接答えたとき</summary><div>
        <label for="phoneAnswer">どう答えたか</label><textarea id="phoneAnswer" name="phoneAnswer" maxlength={2000} />
        <label><input type="checkbox" name="submittedToCity" value="yes" checked={Boolean(record.submitted_to_city)} />行政に出した</label>
        <button class="secondary" name="operation" value="record">どう答えたかを残す</button>
      </div></details> : <label><input type="checkbox" name="submittedToCity" value="yes" checked={Boolean(record.submitted_to_city)} />行政に出した</label>}
      <details class="fold"><summary>要望として残すとき</summary><div><p>要望の一覧に入ります。</p><button class="secondary" name="operation" value="wish">要望として残す</button></div></details>
      {!record.line_source_type ? <><label for="receivedAt">受けた日</label><input id="receivedAt" name="receivedAt" type="date" value={record.received_at.slice(0, 10)} required /><label for="subject">何を受けたか</label><textarea id="subject" name="subject" maxlength={2000} required>{inquirySubject(record.subject)}</textarea></> : null}
      {canPush ? <p>問い合わせが届いたグループや、一対一のトークへ送ります。同じ内容が届いたときは、それぞれの送り先へ送ります。送った返事は取り消せません。</p> : null}
      <div class="action-bar">{canPush ? <button name="operation" value="send">{!destinationCount ? "返事を送る" : group.some((r) => r.line_source_type && r.line_source_type !== "user") ? `${destinationCount}か所に送る` : `${destinationCount}人に送る`}</button> : <button name="operation" value="record">どう答えたかを残す</button>}<a class="button secondary" href={adminPath(ward, "/inquiries")}>今は返事をしないで戻る</a></div>
    </form>
    {notes.length ? <details class="fold"><summary>これまでに残した答え</summary><div>{notes.map((n) => <article><p>{formatJstDate(n.created_at)}</p><p class="preserve-lines">{n.answer}</p><p>{n.submitted_to_city ? "行政に出しました" : "行政には出していません"}</p></article>)}</div></details> : null}
    <details class="fold"><summary>この問い合わせを消す</summary><div><p>間違えて残したときに、この記録と答えを消せます。消すと戻せません。</p><form method="post" action={`${path}/remove`}><button class="danger">この記録を消す</button></form></div></details>
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
  const operation = String(form.get("operation") ?? "record");
  const answer = String(operation === "record" ? form.get("phoneAnswer") || form.get("answer") || "" : form.get("answer") ?? "").trim();
  const kind = record.kind;
  if (operation === "wish") {
    await c.env.DB.prepare("UPDATE inquiry_records SET kind = 'request' WHERE ward_id = ? AND inquiry_id = ?").bind(ward.wardId, record.inquiry_id).run();
    return c.redirect(`${adminPath(ward, inquiryPath(record.inquiry_id))}?wish=1`, 303);
  }
  const submitted = form.get("submittedToCity") === "yes" ? 1 : 0;
  if ((!answer && record.line_source_type) || answer.length > 2000 || !["inquiry", "request"].includes(kind)) return adminResult(c, "どう答えたかを入れてください。", 400, { href: adminPath(ward, inquiryPath(record.inquiry_id)), label: "問い合わせに戻る" }, "どう答えたかを2000文字までで書き、もう一度記録してください。");
  const subject = record.line_source_type ? record.subject : String(form.get("subject") ?? record.subject).trim();
  const receivedAt = record.line_source_type ? record.received_at : String(form.get("receivedAt") ?? record.received_at);
  if (!subject || subject.length > 2000 || !/^\d{4}-\d{2}-\d{2}/.test(receivedAt)) return adminResult(c, "受けた内容と日付を確かめてください。", 400, { href: adminPath(ward, inquiryPath(record.inquiry_id)), label: "問い合わせに戻る" }, "受けた日と内容を入れて、もう一度記録してください。");
  const group = record.line_source_type ? records.filter((r) => sameInquiry(r, record)) : [record];
  const now = nowIso();
  if (operation === "send" || operation === "retry") {
    if (operation === "retry" && !group.some((row) => row.line_pending_answer === answer)) return adminResult(c, "返事の文が変わりました。", 409, { href: adminPath(ward, inquiryPath(record.inquiry_id)), label: "問い合わせに戻る" }, "保存してある返事を確かめてください。");
    return sendInquiry(c, record, group, answer, submitted);
  }
  await c.env.DB.batch(group.map((r) => {
    const history = JSON.parse(r.answer_history) as Array<{ answer: string; submitted_to_city: number; created_at: string; created_by_account_id?: string }>;
    if (r.answer && history.length === 0) history.push({ answer: r.answer, submitted_to_city: r.submitted_to_city, created_at: r.received_at });
    history.push({ answer, submitted_to_city: submitted, created_at: now, created_by_account_id: account.accountId });
    return c.env.DB.prepare(`UPDATE inquiry_records SET answer = ?, kind = ?, submitted_to_city = ?, answer_history = ?, subject = ?, received_at = ?, line_pending_answer = NULL, line_answer_sent_at = NULL WHERE ward_id = ? AND inquiry_id = ?`)
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
    <a class="back" href={adminPath(ward, "/")}>← 最初の画面へ</a><h1>行政の依頼</h1><p class="lead">行政から届いた依頼と、締切です。押すと、答えの下書きや、出したことを残せます。</p>
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
    <a class="back" href={back}>← {project.title}へ</a><h1>記録しました</h1>
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

// 運営メモの入口。帳簿と決算は今回の範囲に含めない。
followupAdmin.route("/", memoAdmin);
export { saveLedgerRow } from "../map/memo";
