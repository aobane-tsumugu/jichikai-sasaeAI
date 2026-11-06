import { Hono, type Context } from "hono";
import type { AdminEnv, WardEnv } from "../env";
import { AdminPage, adminResult } from "../core/admin-ui";
import { Layout, Notice } from "../core/ui";
import { newId } from "../core/ids";
import { PrintDocument, Sheet } from "../print/a4";
import { getSquads } from "../settings/store";
import { getReadings } from "../intake/api";
import { getAnswer, getAnswerDeadline, getRoster, listAnswers, normalizeHousehold, type AnswerRow, type RosterEntry } from "./api";
import { EventDetails, ReceptionClosed, ResidentContact, residentContext } from "./resident";
import { isMeetingStatus, MEETING_LABELS, MeetingFields, meetingNote, meetingText, parseMeetingAnswer } from "./meeting";
import { saveMeetingAnswer } from "./meeting-store";
import { isAnswerSheetReading } from "../ai/schema";

type Meeting = { title: string; closed_at: string | null; due_on: string | null };
type SheetReading = { original_id: string; filename: string; body: string | null };
const str = (value: unknown) => typeof value === "string" ? value : "";
const rootOf = (slug: string, id: string) => `/${encodeURIComponent(slug)}/admin/answers/${encodeURIComponent(id)}`;

async function getMeeting(db: D1Database, wardId: string, projectId: string): Promise<Meeting | null> {
  return db.prepare(`SELECT p.title, p.closed_at, d.due_on FROM projects p LEFT JOIN project_deadlines d
    ON d.ward_id = p.ward_id AND d.project_id = p.project_id AND d.kind = 'answer_due'
    WHERE p.ward_id = ? AND p.project_id = ? AND p.kind = 'general_meeting'`)
    .bind(wardId, projectId).first<Meeting>();
}

function receptionClosed(project: Meeting) {
  return !!project.closed_at || !!(project.due_on && project.due_on < new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()));
}

export function meetingRemaining(roster: RosterEntry[], answers: AnswerRow[]) {
  const valid = answers.filter((answer) => isMeetingStatus(answer.meetingStatus));
  return roster.filter((entry) => !valid.some((answer) => normalizeHousehold(answer.household) === normalizeHousehold(entry.household) &&
    (answer.district === entry.district || (!answer.district && roster.filter((other) => normalizeHousehold(other.household) === normalizeHousehold(answer.household)).length === 1))));
}

function DistrictFields({ squads, value = "", disabled = false }: { squads: string[]; value?: string; disabled?: boolean }) {
  return <fieldset><legend>班</legend><div class="choice half">
    {[...new Set([...squads, ...(value ? [value] : [])])].map((squad) => <label><input type="radio" name="district" value={squad} checked={squad === value} disabled={disabled} /> {squad}</label>)}
    <label><input type="radio" name="district" value="" checked={!value} disabled={disabled} /> 分からない</label>
  </div></fieldset>;
}

function HouseholdFields({ squads, values = {}, prefix = "answer", disabled = false }: {
  squads: string[]; values?: Record<string, unknown>; prefix?: string; disabled?: boolean;
}) {
  return <>
    <label for={`${prefix}-household`}>世帯の代表のお名前</label><input id={`${prefix}-household`} name="household" value={str(values.household)} required maxlength={120} disabled={disabled} />
    <DistrictFields squads={squads} value={str(values.district)} disabled={disabled} />
    <MeetingFields selected={str(values.meeting_status)} proxyName={str(values.proxy_name)} prefix={prefix} disabled={disabled} />
  </>;
}

function ResidentForm({ c, project, squads, note, values = {}, error }: {
  c: Context<WardEnv>; project: Meeting; squads: string[]; note: string; values?: Record<string, unknown>; error?: string;
}) {
  const path = `/${c.var.ward.slug}/answer/${encodeURIComponent(c.req.param("projectId") ?? "")}`;
  return <Layout title={`${project.title}の答え`} siteName={c.var.ward.name}>
    <h1>{project.title}の出席について教えてください</h1><p class="lead">世帯ごとに、出席・委任・欠席のどれかを選んで送ってください。</p>
    {error ? <Notice error>{error} 入れた内容は残っています。</Notice> : null}
    <form method="post" action={path}>
      <input type="hidden" name="submission_id" value={str(values.submission_id) || newId()} />
      <HouseholdFields squads={squads} values={values} />
      {note ? <p style="white-space:pre-wrap">{note}</p> : null}
      <p>紙の回答票を出した方は、ここで答えなくてかまいません。</p>
      <div class="action-bar"><button type="submit">この内容で送る</button></div>
    </form><a class="quiet" href={`/${c.var.ward.slug}/p/${encodeURIComponent(c.req.param("projectId") ?? "")}`}>案内へ戻る</a>
  </Layout>;
}

async function renderAdmin(c: Context<AdminEnv>, project: Meeting) {
  const { ward } = c.var;
  const id = c.req.param("projectId") ?? "";
  const root = rootOf(ward.slug, id);
  const [answers, roster, squads, deadline] = await Promise.all([listAnswers(c.env.DB, ward.wardId, id), getRoster(c.env.DB, ward.wardId), getSquads(c.env.DB, ward.wardId), getAnswerDeadline(c.env.DB, ward.wardId, id)]);
  const remaining = meetingRemaining(roster, answers);
  const valid = answers.filter((answer) => isMeetingStatus(answer.meetingStatus));
  const view = c.req.query("view") ?? "summary";
  const closed = !!project.closed_at;
  const unanswered = <>{!roster.length ? <p>名簿はまだありません。名簿を入れると、まだ答えていない世帯を見られます。</p> : <>
    <p>まだ答えていない世帯は{remaining.length}世帯です。</p>
    {[...new Set(remaining.map((entry) => entry.district))].map((district) => <section><h2>{district}</h2><ul>{remaining.filter((entry) => entry.district === district).map((entry) => <li>{entry.household}</li>)}</ul></section>)}
  </>}<p>名前の書き方が名簿と違うと、答えていてもここに出ることがあります。</p></>;
  if (view === "unanswered" && c.req.query("print") === "1") return c.html(<PrintDocument title={`${project.title} まだ答えていない世帯`} back={`${root}?view=unanswered`}><Sheet footer={<span>{ward.name}</span>}><h1>{project.title} まだ答えていない世帯</h1>{unanswered}</Sheet></PrintDocument>);
  const sheets = view === "read" || view === "list" ? (await c.env.DB.prepare(`SELECT o.original_id, o.filename, r.body FROM originals o
    JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id
    LEFT JOIN readings r ON r.ward_id = j.ward_id AND r.job_id = j.job_id
    WHERE j.ward_id = ? AND j.project_id = ? AND j.read_kind = 'answer_sheet' AND j.withdrawn_at IS NULL ORDER BY j.created_at DESC`)
    .bind(ward.wardId, id).all<SheetReading>()).results : [];
  const title = ({ hand: "電話や紙の答えを手で入れる", list: "答えの一覧", read: "読み取った答えを直して入れる", send: "回答票を撮って送る", sent: "回答票を受け取りました", unanswered: "まだ答えていない世帯" } as Record<string, string>)[view] ?? `${project.title}の答え`;
  return c.html(<AdminPage ward={ward} account={c.var.account} title={title} back={{ href: view === "summary" ? `/${ward.slug}/admin/projects/${id}/map` : root, label: view === "summary" ? "総会の段取りへ戻る" : "総会の答えへ戻る" }}>
    <h1>{title}</h1><p class="lead">世帯ごとの出席・委任・欠席を、紙・電話・スマホを合わせて数えます。</p>
    {c.req.query("done") ? <Notice>保存しました。答えと数を確かめてください。</Notice> : null}
    {closed ? <Notice>この総会は閉じました。答えを直すときは、総会をもう一度開いてください。<p><a href={`/${ward.slug}/admin/close/${id}`}>閉じた総会の画面へ</a></p></Notice> : null}
    {view === "summary" ? <>
      <div class="counts"><div class="count"><b>{valid.length}<small>世帯</small></b><span>答えた世帯</span></div>
        {Object.entries(MEETING_LABELS).map(([status, label]) => <div class="count"><b>{valid.filter((answer) => answer.meetingStatus === status).length}<small>世帯</small></b><span>{label}</span></div>)}
        <div class="count"><b>{roster.length ? remaining.length : "―"}<small>世帯</small></b><span>まだ答えていない世帯</span></div></div>
      {!roster.length ? <p>名簿はまだありません。まだ答えていない世帯の数は分かりません。</p> : null}
      {answers.length > valid.length ? <Notice>出席・委任・欠席が分からない答えが{answers.length - valid.length}件あります。答えの一覧で確かめてください。</Notice> : null}
      <ul class="rows">
        {!closed ? <><li><a class="row-link" href={`${root}?view=send`}>回答票を撮って送る</a></li><li><a class="row-link" href={`${root}?view=hand`}>電話や紙の答えを手で入れる</a></li></> : null}
        <li><a class="row-link" href={`${root}?view=read`}>読み取った答えを直して入れる</a></li><li><a class="row-link" href={`${root}?view=list`}>答えの一覧</a></li><li><a class="row-link" href={`${root}?view=unanswered`}>まだ答えていない世帯</a></li>
      </ul>
      {!closed ? <details class="fold"><summary>答えの締切を変える</summary><form method="post" action={`${root}/deadline`}><label for="due">答えの締切</label><input id="due" name="due_on" type="date" value={deadline ?? ""} required /><button class="secondary">締切を変える</button></form></details> : null}
    </> : null}
    {view === "hand" && !closed ? <form method="post" action={`${root}/phone`}><HouseholdFields squads={squads} /><div class="action-bar"><button>この答えを入れる</button></div></form> : null}
    {view === "send" && !closed ? <><p>預かった回答票を撮って送ってください。一枚の写真に何枚写っていてもかまいません。</p><form method="post" action={`${root}/sheet`} enctype="multipart/form-data"><label class="file-button">回答票を撮る<input name="part" type="file" accept="image/*,.pdf" capture="environment" required /></label><button>送る</button></form></> : null}
    {view === "sent" ? <><p>読めた答えから数に入れます。読めない答えは、読み取りの直しの画面に残ります。</p><a class="button" href={`${root}?view=read`}>読み取った答えを見る</a></> : null}
    {view === "unanswered" ? <>{unanswered}<a class="button" href={`${root}?view=unanswered&print=1`}>この一覧を印刷する</a></> : null}
    {view === "list" ? <><ul class="rows">{answers.map((answer) => <li><a class="row-link" href={`${root}/${answer.answerId}/edit`}><b>{answer.household}</b><span>{answer.district || "班が分からない"}　{meetingText(answer)}</span></a></li>)}</ul>{!answers.length ? <p>答えはまだありません。</p> : null}</> : null}
    {view === "read" || view === "list" ? <>
      {!sheets.length ? <p>回答票はまだ届いていません。</p> : sheets.filter((sheet) => !c.req.query("original") || c.req.query("original") === sheet.original_id).map((sheet) => <section><h2>{sheet.filename || "回答票の写真"}</h2>
        <a class="quiet" href={`/${ward.slug}/admin/intake/originals/${encodeURIComponent(sheet.original_id)}`}>回答票の写真を見る</a>
        <MeetingSheetRows sheet={sheet} root={root} answers={answers} squads={squads} closed={closed} />
      </section>)}
    </> : null}
  </AdminPage>);
}

function MeetingSheetRows({ sheet, root, answers, squads, closed }: { sheet: SheetReading; root: string; answers: AnswerRow[]; squads: string[]; closed: boolean }) {
  if (!sheet.body) return <p>読み取り中です。少ししてから開き直してください。</p>;
  let body: unknown;
  try { body = JSON.parse(sheet.body); } catch { return <p>読み取りを表示できません。もう一度読み取ってください。</p>; }
  if (!body || typeof body !== "object" || !("rows" in body) || !Array.isArray(body.rows)) return <p>回答票の読み取り結果がありません。</p>;
  // readingsの回答票の型は受け付け時に決まる。
  const reading = body as import("../ai/schema").AnswerSheetReading;
  return <>{reading.rows.map((row, index) => {
    const saved = answers.find((answer) => answer.originalId === sheet.original_id && answer.sheetRowIndex === index);
    const values = { household: saved?.household ?? row.household_name, district: saved?.district ?? row.ward_group,
      meeting_status: saved?.meetingStatus ?? row.meeting_status ?? "", proxy_name: saved?.proxyName ?? row.proxy_name ?? "" };
    return <form class="panel" method="post" action={`${root}/sheet/${encodeURIComponent(sheet.original_id)}/row/${index}`}>
      <h3>{index + 1}枚目（{row.locator}）</h3><p>{saved ? "数に入れました。読み違いがあれば直せます。" : "まだ数に入れていません。写真を見て、分かるところを入れてください。"}</p>
      {row.note ? <p>{row.note}</p> : null}
      <HouseholdFields squads={squads} values={values} prefix={`sheet-${sheet.original_id}-${index}`} disabled={closed} />
      {!closed ? <button class="secondary">{saved ? "直して入れ直す" : "答えに入れる"}</button> : null}
    </form>;
  })}</>;
}

/** 総会だけを先に受け持ち、行事の既存の経路はそのまま通す。 */
export function installMeetingRoutes(admin: Hono<AdminEnv>, pub: Hono<WardEnv>) {
  admin.use("/answers/:projectId", async (c, next) => {
    if (c.req.method !== "GET") return next();
    const meeting = await getMeeting(c.env.DB, c.var.ward.wardId, c.req.param("projectId"));
    return meeting ? renderAdmin(c, meeting) : next();
  });
  admin.use("/answers/:projectId/:answerId/edit", async (c, next) => {
    if (c.req.method !== "GET") return next();
    const { ward } = c.var;
    const id = c.req.param("projectId");
    const meeting = await getMeeting(c.env.DB, ward.wardId, id);
    if (!meeting) return next();
    const answer = await getAnswer(c.env.DB, ward.wardId, id, c.req.param("answerId"));
    if (!answer) return c.notFound();
    const root = rootOf(ward.slug, id);
    return c.html(<AdminPage ward={ward} account={c.var.account} title="答えを直す" back={{ href: `${root}?view=list`, label: "答えの一覧へ戻る" }}>
      <h1>{answer.household}の答えを直す</h1><p class="lead">直したいところを書き換えて、保存してください。</p>
      {meeting.closed_at ? <><p>この総会は閉じています。直すときは先に開き直してください。</p><a href={`/${ward.slug}/admin/close/${id}`}>閉じた総会の画面へ</a></> : <>
        <form method="post" action={`${root}/${answer.answerId}/edit`}><HouseholdFields squads={await getSquads(c.env.DB, ward.wardId)} values={{ household: answer.household, district: answer.district, meeting_status: answer.meetingStatus, proxy_name: answer.proxyName }} /><div class="action-bar"><button>直した答えを保存する</button></div></form>
        <form method="post" action={`${root}/${answer.answerId}/delete`}><button class="secondary">この答えを消す</button></form>
      </>}
    </AdminPage>);
  });
  for (const path of ["/answers/:projectId/phone", "/answers/:projectId/:answerId/edit", "/answers/:projectId/sheet/:originalId/row/:rowIndex"]) {
    admin.use(path, async (c, next) => {
      if (c.req.method !== "POST") return next();
      const { ward } = c.var;
      const id = c.req.param("projectId") ?? "";
      const meeting = await getMeeting(c.env.DB, ward.wardId, id);
      if (!meeting) return next();
      const root = rootOf(ward.slug, id);
      if (meeting.closed_at) return c.redirect(`/${ward.slug}/admin/close/${id}?error=answers_closed`, 303);
      const form = await c.req.parseBody();
      const parsed = parseMeetingAnswer(form);
      if (!parsed || !str(form.household).trim() || str(form.household).trim().length > 120 || str(form.district).length > 80) return c.html(<AdminPage ward={ward} account={c.var.account} title="答えを確認してください" back={{ href: root, label: "総会の答えへ戻る" }}>
        <h1>答えを確認してください</h1><p class="lead">代表のお名前と、出席・委任・欠席のどれかを入れてください。入れた内容は残っています。</p>
        <form method="post" action={new URL(c.req.url).pathname}><HouseholdFields squads={await getSquads(c.env.DB, ward.wardId)} values={form} /><div class="action-bar"><button>この答えを入れる</button></div></form>
      </AdminPage>, 400);
      const originalId = c.req.param("originalId");
      const rowIndex = Number(c.req.param("rowIndex"));
      if (originalId) {
        const link = await c.env.DB.prepare(`SELECT j.job_id FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id
          WHERE o.ward_id = ? AND o.original_id = ? AND j.project_id = ? AND j.read_kind = 'answer_sheet' AND j.withdrawn_at IS NULL`)
          .bind(ward.wardId, originalId, id).first<{ job_id: string }>();
        if (!link || !Number.isInteger(rowIndex) || rowIndex < 0) return c.notFound();
        const reading = (await getReadings(c.env.DB, ward.wardId, link.job_id)).find((entry) => isAnswerSheetReading(entry.body))?.body;
        if (!reading || !isAnswerSheetReading(reading) || reading.rows[rowIndex]?.original_id !== originalId) return c.notFound();
      }
      const saved = await saveMeetingAnswer(c.env.DB, ward.wardId, { projectId: id, household: str(form.household), district: str(form.district), peopleCount: 0,
        ...parsed, source: originalId ? "sheet" : "phone", accountId: c.var.account.accountId,
        ...(originalId ? { originalId, sheetRowIndex: rowIndex } : {}) }, { answerId: c.req.param("answerId") });
      if (!saved) return adminResult(c, "答えを保存できませんでした。", 409, { href: root, label: "総会の答えへ戻る" }, "総会が閉じていないか、答えの一覧で確かめてください。");
      return c.redirect(`${root}?view=list&done=edit`, 303);
    });
  }
  pub.use("/answer/:projectId", async (c, next) => {
    if (c.req.method !== "GET") return next();
    const id = c.req.param("projectId");
    const project = await getMeeting(c.env.DB, c.var.ward.wardId, id);
    if (!project) return next();
    c.header("Cache-Control", "private, no-store");
    if (receptionClosed(project)) {
      const context = await residentContext(c.env.DB, c.var.ward.wardId, id);
      return c.html(<Layout title="答えの受付は終わりました" siteName={c.var.ward.name}><h1>答えの受付は終わりました</h1><ReceptionClosed closed={!!project.closed_at} due={project.due_on} /><ResidentContact contact={context.contact} /><a href={`/${c.var.ward.slug}/p/${id}`}>案内へ戻る</a></Layout>);
    }
    const squads = await getSquads(c.env.DB, c.var.ward.wardId);
    return c.html(<ResidentForm c={c} project={project} squads={squads} note={await meetingNote(c.env.DB, c.var.ward.wardId)} values={{ district: squads.includes(c.req.query("s") ?? "") ? c.req.query("s") : "" }} />);
  });
  pub.use("/answer/:projectId", async (c, next) => {
    if (c.req.method !== "POST") return next();
    const { ward } = c.var;
    const id = c.req.param("projectId");
    const project = await getMeeting(c.env.DB, ward.wardId, id);
    if (!project) return next();
    c.header("Cache-Control", "private, no-store");
    const form = await c.req.parseBody();
    const submissionId = str(form.submission_id);
    const previous = submissionId ? await c.env.DB.prepare("SELECT answer_id FROM project_answer_submissions WHERE ward_id = ? AND project_id = ? AND submission_id = ?").bind(ward.wardId, id, submissionId).first<{ answer_id: string }>() : null;
    const context = await residentContext(c.env.DB, ward.wardId, id);
    const received = async (answerId: string) => {
      const answer = await getAnswer(c.env.DB, ward.wardId, id, answerId);
      return c.html(<Layout title="答えを受け付けました" siteName={ward.name}><h1>答えを受け付けました</h1><p>ありがとうございました。この画面は閉じてかまいません。</p>
        {answer ? <dl><dt>世帯の代表</dt><dd>{answer.household}</dd><dt>班</dt><dd>{answer.district || "班が分からない"}</dd><dt>答え</dt><dd>{meetingText(answer)}</dd></dl> : null}
        {answer?.meetingStatus === "attend" ? <EventDetails item={context.item} /> : null}
        <h2>間違えたときは</h2><p>もう一度送らず、下の連絡先にお知らせください。役員が直します。</p><ResidentContact contact={context.contact} /><a class="quiet" href={`/${ward.slug}/p/${id}`}>案内へ戻る</a></Layout>);
    };
    if (previous) return received(previous.answer_id);
    const closed = () => c.html(<Layout title="答えの受付は終わりました" siteName={ward.name}><h1>答えの受付は終わりました</h1><ResidentContact contact={context.contact} /><a href={`/${ward.slug}/p/${id}`}>案内へ戻る</a></Layout>, 400);
    if (receptionClosed(project)) return closed();
    const parsed = parseMeetingAnswer(form);
    const squads = await getSquads(c.env.DB, ward.wardId);
    if (!parsed || !str(form.household).trim() || str(form.household).trim().length > 120 || str(form.district).length > 80 || (str(form.district) && squads.length && !squads.includes(str(form.district)))) return c.html(<ResidentForm c={c} project={project} squads={squads} note={await meetingNote(c.env.DB, ward.wardId)} values={form} error="代表のお名前と、出席・委任・欠席のどれかを入れてください。班は分からないままでも送れます。" />, 400);
    const saved = await saveMeetingAnswer(c.env.DB, ward.wardId, { projectId: id, household: str(form.household), district: str(form.district), peopleCount: 0, ...parsed, source: "web" }, { submissionId });
    return saved ? received(saved) : closed();
  });
}
