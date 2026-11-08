import { projectTasks, taskFeatures, taskCollectsAttendance, distributedTaskKeys } from "../project/task-features";
import { getAnswerLabels } from "../settings/answer-labels";
import { meetingNote } from "../answers/meeting";
import { deliveryAlert } from "../line/delivery-alert";
import { Hono } from "hono";
import { adminResult, AdminPage } from "../core/admin-ui";
import { adminPath } from "../core/auth";
import type { Bundle } from "../core/bundle";
import { newId, nowIso } from "../core/ids";
import { Notice } from "../core/ui";
import type { Context } from "hono";
import { formatDateText, formatJst, parseEventDay } from "../core/time";
import type { AdminEnv } from "../env";
import { broadcastLineText, getLineAllowance, lineAccessToken, LINE_NOT_CONFIGURED, sendLineTitleAndUrl } from "../line/api";
import { getNoticeFlyer, noticeFlyerPath, noticeLineText } from "./notice-flyers";
import { Choices } from "../core/choice";
import { previousFlyer } from "../draft/notice-flyers";
import { answerDeadlineFromDraft, getRoster, parseDistribution } from "../answers/api";
import { checkPublicDraft } from "./check";
import { DOCUMENT_KINDS, DOCUMENT_KIND_LABEL, ITEM_LABEL, ITEM_SCREEN_LABEL, isItemKey, type DocumentKind, type ProjectKind } from "../project/model";
import { applyChange } from "../project/apply";
import { recordPublishedItems, setEventDay } from "../project/actions";
import { paperHeading, withoutTitleLine } from "../project/heading";
import { documentBodyCheckMessage, PENDING, plainText, withoutPending, writtenInText } from "../project/document-body";
import { MaterialsTable } from "../space/materials";
import { currentPublicationTables, publicationTablesDiffer, publicationTablesSql } from "../space/publication-tables";

interface DraftRow {
  tables_snapshot: string | null;
  document_id: string;
  kind: DocumentKind;
  title: string;
  scope: string;
  stale_since_version: number | null;
  version_id: string;
  version_no: number;
  body: string;
  based_on_state_version: number;
  published_at: string | null;
  latest_state: number;
}

interface ProjectRow {
  project_id: string;
  kind: ProjectKind;
  title: string;
  year: number;
  state_version: number;
  closed_at: string | null;
}

interface PublicationRow {
  scope: string;
  tables_snapshot: string | null;
  publication_id: string;
  document_id: string;
  version_id: string;
  version_no: number;
  published_at: string;
  unpublished_at: string | null;
  line_status: string;
  line_recipients: number | null;
  line_sent_at: string | null;
  line_error: string | null;
  recipient_scope: string;
  distribution: string;
}

function paperTargetLabel(raw: string): string {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null && !Array.isArray(value) && Array.isArray((value as { targets?: unknown }).targets)) {
      const targets = (value as { targets: unknown[] }).targets;
      const labels = targets.map((entry) => {
        if (typeof entry !== "object" || entry === null) return "";
        const row = entry as { district?: unknown; household?: unknown; copies?: unknown };
        return typeof row.household === "string" && typeof row.district === "string"
          ? `${row.district} / ${row.household}`
          : typeof row.district === "string" && typeof row.copies === "number" ? `${row.district}（${row.copies}部）` : "";
      }).filter(Boolean);
      // 名簿に同じ名前の世帯がある時は、一つにまとめて部数を添える。
      const counts = new Map<string, number>();
      for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
      return [...counts].map(([label, count]) => count > 1 ? `${label}（${count}部）` : label).join("、") || "指定なし";
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return Object.entries(value as Record<string, unknown>).map(([district, copies]) => `${district}（${String(copies)}部）`).join("、") || "指定なし";
    }
  } catch { /* 古い記録の形式は個別表示しない */ }
  return "指定なし";
}

/**
 * 住民に知らせた案内の「いつ」から当日と終わる日が読め、準備の当日がまだ空なら、その日を当日に入れる。
 * 役員が案内に書いた日を、やることの画面でもう一度入れなくて済むようにする（前提 3）。
 * 役員が入れた当日は書き換えない。過ぎた日（去年の日が残った案内など）は入れない。
 */
async function fillEventDay(db: D1Database, wardId: string, projectId: string, year: number, body: string, accountId: string): Promise<void> {
  const current = await db.prepare("SELECT due_on FROM project_deadlines WHERE ward_id = ? AND project_id = ? AND kind = 'event_day'").bind(wardId, projectId).first<{ due_on: string }>();
  if (current?.due_on) return;
  let text = "";
  try {
    const parsed = JSON.parse(body) as { items?: { key?: string; content?: string }[] };
    text = parsed.items?.find((item) => item.key === "date_time")?.content ?? "";
  } catch { return; }
  if (!text) return;
  const start = parseEventDay(text, year, "start");
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
  if (!start || start < today) return;
  await setEventDay(db, wardId, projectId, start, accountId, parseEventDay(text, year, "end") ?? start);
}

async function getProject(db: D1Database, wardId: string, projectId: string): Promise<ProjectRow | null> {
  return db.prepare(`SELECT project_id, kind, title, year, state_version, closed_at FROM projects
    WHERE ward_id = ? AND project_id = ?`).bind(wardId, projectId).first<ProjectRow>();
}

async function getDrafts(db: D1Database, wardId: string, projectId: string): Promise<DraftRow[]> {
  const result = await db.prepare(`SELECT d.document_id, d.kind, d.title, d.scope, d.stale_since_version,
      v.version_id, v.version_no, v.body, v.based_on_state_version, v.published_at, v.tables_snapshot,
      p.state_version AS latest_state
    FROM documents d JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    JOIN projects p ON p.ward_id = d.ward_id AND p.project_id = d.project_id
    WHERE d.ward_id = ? AND d.project_id = ?
      AND v.version_no = (SELECT MAX(v2.version_no) FROM document_versions v2
        WHERE v2.ward_id = d.ward_id AND v2.document_id = d.document_id)
    ORDER BY d.created_at`).bind(wardId, projectId).all<DraftRow>();
  return result.results;
}

const admin = new Hono<AdminEnv>();

/** 自治会のLINEで送る種類。報告は住民向けのページと紙だけに出す。 */
/** 住民へのメッセージの四つは、どれも自治会のLINEで送るかを役員が選べる。送らない時は送るたびに選ぶ。 */
export const canSendLine = (kind: string) => ["announcement", "recruitment", "notice", "report"].includes(kind);

async function markDistributedTask(db: D1Database, wardId: string, projectId: string, accountId: string, taskKey: string, versionId: string) {
  const task = await db.prepare(`SELECT progress_source_kind FROM project_map_tasks
    WHERE ward_id = ? AND project_id = ? AND task_key = ? AND removed_at IS NULL`)
    .bind(wardId, projectId, taskKey).first<{ progress_source_kind: string | null }>();
  // 人が直した進み具合は、そのまま残す。
  if (!task || task.progress_source_kind === "person") return;
  await applyChange(db, wardId, projectId, {
    kind: "map_task", taskKey, progress: "done", packVersion: "publish-map@1", requestId: versionId,
    source: { kind: "person", accountId, ref: versionId, locator: "配る操作" }, confidence: "high",
  }, { actorAccountId: accountId });
}

admin.get("/publish/:projectId", async (c) => {
  const { ward, account } = c.var;
  const projectId = c.req.param("projectId");
  const tasks = await projectTasks(c.env.DB, ward.wardId, projectId);
  const features = taskFeatures(tasks);
  const project = await getProject(c.env.DB, ward.wardId, projectId);
  if (!project) return c.notFound();
  const drafts = await getDrafts(c.env.DB, ward.wardId, projectId);
  const records = await c.env.DB.prepare(`SELECT publication_id, document_id, version_id, version_no, published_at, unpublished_at,
      line_status, line_recipients, line_sent_at, line_error, recipient_scope, distribution,
      (SELECT tables_snapshot FROM document_versions v WHERE v.ward_id = publication_records.ward_id AND v.version_id = publication_records.version_id) AS tables_snapshot,
      (SELECT scope FROM document_versions v WHERE v.ward_id = publication_records.ward_id AND v.version_id = publication_records.version_id) AS scope
    FROM publication_records WHERE ward_id = ? AND project_id = ? ORDER BY published_at DESC, rowid DESC`)
    .bind(ward.wardId, projectId).all<PublicationRow>();
  // 空間の配布は公開用の記録に入れない。区のページは公開用の記録だけを読む。
  const spaceRecords = await c.env.DB.prepare(`SELECT v.version_id AS publication_id, v.version_id, v.document_id, v.version_no,
      v.published_at, NULL AS unpublished_at, 'not_sent' AS line_status, NULL AS line_recipients,
      NULL AS line_sent_at, NULL AS line_error, 'member_households' AS recipient_scope, '{}' AS distribution,
      v.tables_snapshot, v.scope
    FROM document_versions v WHERE v.ward_id = ? AND v.project_id = ? AND v.scope = 'space' AND v.published_at IS NOT NULL
    ORDER BY v.published_at DESC, v.rowid DESC`).bind(ward.wardId, projectId).all<PublicationRow>();
  const allRecords = [...records.results, ...spaceRecords.results].sort((a, b) => b.published_at.localeCompare(a.published_at) || b.version_no - a.version_no);
  c.header("Cache-Control", "no-store");
  const done = records.results.find((record) => record.publication_id === c.req.query("done"));
  const spaceDone = c.req.query("space") === "sent" ? spaceRecords.results[0] : undefined;
  const lowered = allRecords.find((record) => record.publication_id === c.req.query("lowered") && record.unpublished_at);
  const completedRecord = done ?? lowered ?? spaceDone;
  const task = completedRecord ? await c.env.DB.prepare(`SELECT task_id, name FROM project_map_tasks
    WHERE ward_id = ? AND project_id = ? AND removed_at IS NULL AND progress = 'done' AND progress_source_ref = ?`)
    .bind(ward.wardId, projectId, completedRecord.version_id).first<{ task_id: string; name: string }>() : null;
  const mapHref = adminPath(ward, `/projects/${projectId}/map${task ? `?changed=${encodeURIComponent(task.task_id)}` : ""}`);
  if (done || lowered) {
    const record = (done ?? lowered)!;
    const draft = drafts.find((row) => row.document_id === record.document_id);
    const rain = draft?.kind === "notice" && draft.title.includes("雨");
    const kind = draft?.kind ?? "announcement";
    const editHref = adminPath(ward, `/projects/${projectId}/draft/${kind}`);
    const printBase = adminPath(ward, `/print/${projectId}/${record.document_id}/${record.version_no}`);
    const printHref = `${printBase}/${kind === "duty_roster" ? "duty" : "announcement"}`;
    const withAnswer = taskCollectsAttendance(tasks, kind);
    const paperLabel = withAnswer ? "案内と回答票" : DOCUMENT_KIND_LABEL[kind];
    const failed = record.line_status === "failed" || record.line_status === "not_configured";
    return c.html(<AdminPage ward={ward} account={account} title={lowered ? "住民向けのページから取り下げました" : rain ? "雨の変更を知らせました" : "知らせました"} back={{ href: mapHref, label: `${project.title}のやることへ` }}>
      <h1>{lowered ? "住民向けのページから取り下げました" : rain ? "雨の変更を知らせました" : `${DOCUMENT_KIND_LABEL[kind as DocumentKind]}を知らせました`}</h1>
      {lowered ? <Notice>取り下げました。知らせた記録は残ります。LINEで送った知らせは取り消せません。</Notice> :
        <div class={failed ? "notice warn" : "notice done"} role="status"><strong>{failed ? "自治会のLINEには送れませんでした" : "住民向けのページに載せました"}</strong>
          <p>{failed ? "住民向けのページには載っています。紙も配れます。LINEは送らないままでもかまいません。" : record.line_status === "sent" ? `自治会のLINE${record.line_recipients === null ? "に" : `の友だち${record.line_recipients}人に`}送りました。` : record.line_status === "pending" ? "自治会のLINEの送信結果はまだ分かりません。" : "今回は自治会のLINEに送りませんでした。"}{task ? `やることの「${task.name}」を済みにしました。` : ""}</p>
        </div>}
      <section class="next"><strong>次は</strong>{lowered ? <><p>内容を直して、知らせ直せます。知らせ直す時に、下書きの画面で「今回はLINEで送らない」を選ぶと、自治会のLINEに同じ知らせが二度届きません。</p><a class="button" href={editHref}>直して知らせ直す</a></> : rain ? <p>班長に電話して伝えてください。掲示も張り替えてください。ここは画面では済みません。</p> : <><p>{paperLabel}{withAnswer ? "、班長への一枚" : ""}を印刷して、{withAnswer ? "班長に渡してください。" : "配ってください。"}</p><a class="button" href={printHref}>{paperLabel}を印刷する</a>{withAnswer ? <a class="quiet" href={`${printBase}/leader`}>班長への一枚を印刷する</a> : null}</>}</section>
      {!rain && !lowered ? <DistributionFacts raw={record.distribution} /> : null}
      {!lowered ? <div class="action-links"><a class="button secondary" href={`/${ward.slug}/p/${encodeURIComponent(projectId)}`}>住民向けのページで見る</a></div> : null}
      <h2>間違えたときは</h2><p>{rain ? "直して知らせ直すと、住民向けのページは新しい内容に変わります。LINEで送った知らせは取り消せません。" : `直して知らせ直すと、住民向けのページは新しい${DOCUMENT_KIND_LABEL[kind]}に変わります。`}</p>
      <div class="action-links"><a class="button secondary" href={editHref}>直して知らせ直す</a></div>
      {!rain && !record.unpublished_at ? <LowerFold action={adminPath(ward, `/publish/${projectId}/lower/${record.publication_id}`)} label={DOCUMENT_KIND_LABEL[kind as DocumentKind]} /> : null}
      <a class="quiet" href={adminPath(ward, `/publish/${projectId}`)}>知らせる画面へ</a>
    </AdminPage>);
  }
  const currentTables = await currentPublicationTables(c.env.DB, ward.wardId, projectId);
  const orderedDrafts = [...drafts].sort((a, b) => Number(Boolean(a.published_at)) - Number(Boolean(b.published_at)));
  const primary = orderedDrafts.find((draft) => draft.scope === "public" && !draft.published_at);
  const copies = (await getRoster(c.env.DB, ward.wardId)).length;

  return c.html(<AdminPage ward={ward} account={account} title="住民に知らせる" back={{ href: adminPath(ward, `/projects/${projectId}/map`), label: `${project.title}のやることへ` }}>
    <h1>{primary ? paperHeading(project.title, primary.title) : project.title}を住民に知らせる</h1>{primary ? <p class="lead">住民向けのページに載せ、LINEで送り、紙を印刷できるようにします。</p> : null}
    {project.closed_at ? <Notice>{project.title}は終わりにしました。</Notice> : null}
    {documentBodyCheckMessage(c.req.query("check_body")) ? <Notice>{documentBodyCheckMessage(c.req.query("check_body"))}</Notice> : null}
    {c.req.query("space") === "sent" ? <><Notice>実行委員と班長のページに載せました。{spaceDone && task ? `やることの「${task.name}」を済みにしました。` : ""}</Notice><section class="next"><strong>次は</strong><p>載せたことを実行委員と班長に伝えてください。</p><a class="button" href={adminPath(ward, `/space/${projectId}`)}>実行委員と班長のページへ</a></section>{spaceDone && task ? <a class="quiet" href={mapHref}>やることを見る</a> : null}<p>間違えたときは、下書きを直して知らせ直せます。</p></> : null}
    {!drafts.length ? <><p>知らせられる下書きはまだありません。</p><a class="button" href={adminPath(ward, `/projects/${projectId}/draft/announcement`)}>案内の下書きを書く</a></> : null}
    {orderedDrafts.map((draft, index) => {
      const previous = allRecords.find((record) => record.document_id === draft.document_id && !record.unpublished_at);
      const tablesChanged = draft.scope === "space" && (draft.kind === "duty_roster" || draft.kind === "procedure") &&
        (!!previous || !!draft.published_at) && publicationTablesDiffer(previous?.tables_snapshot ?? null, currentTables);
      return <>{index === 1 ? <h2>{project.closed_at || orderedDrafts.slice(1).every((row) => row.published_at) ? "ほかの文書" : "ほかに知らせられるもの"}</h2> : null}<section class="panel" key={draft.document_id}>
        <h2>{paperHeading(project.title, draft.title)}</h2>
        <p>{draft.published_at ? "すでに知らせています。" : "下書きがあります"}</p>
        {draft === primary ? <dl class="facts"><dt>住民向けのページ</dt><dd>載せます</dd><dt>自治会のLINE</dt><dd>{canSendLine(draft.kind) ? "友だちに知らせます" : "今回は送りません"}</dd><dt>紙</dt><dd>{copies ? `加入世帯に${copies}部` : "印刷して配れます"}</dd></dl> : null}
        {draft.stale_since_version !== null ? <Notice>新しいものが入っています。下書きを直すか、このまま知らせられます。</Notice> : null}
        {tablesChanged ? <Notice>{previous?.tables_snapshot === null ? "載せたときの表の記録がありません。今の表を載せ直せます。" : "載せたときから表が変わっています。今の表を載せ直せます。"}</Notice> : null}
        {draft.scope === "space" ? <><p>{draft.published_at ? "実行委員と班長のページに載せました。" : "実行委員と班長のページに載せます。"}住民向けのページには載りません</p>{!project.closed_at && (!draft.published_at || tablesChanged) ? <form method="post" action={adminPath(ward, `/publish/${projectId}/confirm`)}>
          <input type="hidden" name="documentId" value={draft.document_id} /><input type="hidden" name="versionId" value={draft.version_id} /><input type="hidden" name="versionNo" value={draft.version_no} />
          <button class={index === 0 ? "" : "secondary"} type="submit">知らせる内容を見る</button><p class="muted">押しても、まだ知らせません。</p></form> : null}</> : null}
        {draft.scope === "public" && !project.closed_at && !draft.published_at ? <form method="post" action={adminPath(ward, `/publish/${projectId}/confirm`)}>
          <input type="hidden" name="documentId" value={draft.document_id} /><input type="hidden" name="versionId" value={draft.version_id} /><input type="hidden" name="versionNo" value={draft.version_no} />
          <button class={index === 0 ? "" : "secondary"} type="submit">知らせる内容を見る</button><p class="muted">押しても、まだ知らせません。</p>{!canSendLine(draft.kind) ? <p>自治会のLINEには送らず、住民向けのページに載せます。</p> : null}
        </form> : null}
        <a class="quiet" href={adminPath(ward, `/projects/${projectId}/draft/${draft.kind}`)}>下書きを直す</a>
      </section></>;
    })}
    <h2>これまでに知らせたもの</h2>{!allRecords.length ? <p>まだありません。</p> : allRecords.map((record) => <section class="panel">
      {drafts.some((row) => row.document_id === record.document_id) ? <b>{paperHeading(project.title, drafts.find((row) => row.document_id === record.document_id)!.title)}</b> : null}
      <p>{formatJst(record.published_at)}に知らせました。</p>{record.scope === "space" ? <p>実行委員と班長のページに載せました。</p> : <>
        <p>紙の配布先: {paperTargetLabel(record.distribution)}</p><p>自治会のLINE: {record.line_status === "sent" ? `${record.line_recipients ?? ""}人に送りました` : record.line_status === "failed" || record.line_status === "not_configured" ? "送れませんでした。住民向けのページには載っています。紙も配れます。" : record.line_status === "pending" ? "送信結果はまだ分かりません" : "今回は送っていません"}</p>
        {record.unpublished_at ? <p>住民向けのページから取り下げています。</p> : <LowerFold action={adminPath(ward, `/publish/${projectId}/lower/${record.publication_id}`)} label={DOCUMENT_KIND_LABEL[(drafts.find((row) => row.document_id === record.document_id)?.kind ?? "announcement") as DocumentKind]} />}
      </>}<a class="quiet" href={adminPath(ward, `/print/${projectId}/${record.document_id}/${record.version_no}`)}>印刷用ページを開く</a>
    </section>)}
  </AdminPage>);
});

admin.post("/publish/:projectId/space", async (c) => {
  const { ward, account } = c.var;
  const projectId = c.req.param("projectId");
  const form = await c.req.formData();
  const documentId = String(form.get("documentId") ?? "");
  const versionId = String(form.get("versionId") ?? "");
  const versionNo = Number(form.get("versionNo"));
  const tasks = await projectTasks(c.env.DB, ward.wardId, projectId);
  const features = taskFeatures(tasks);
  const project = await getProject(c.env.DB, ward.wardId, projectId);
  if (!project || project.closed_at) return c.notFound();
  const row = await c.env.DB.prepare(`SELECT d.kind, d.scope, d.stale_since_version, v.version_id, v.version_no, v.published_at, v.tables_snapshot
    FROM documents d JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    WHERE d.ward_id = ? AND d.project_id = ? AND d.document_id = ? AND v.version_id = ? AND v.version_no = ?`)
    .bind(ward.wardId, projectId, documentId, versionId, versionNo)
    .first<{ kind: DocumentKind; scope: string; stale_since_version: number | null; version_id: string; version_no: number; published_at: string | null; tables_snapshot: string | null }>();
  if (!row || row.scope !== "space") return c.notFound();
  if (row.published_at) {
    const current = await currentPublicationTables(c.env.DB, ward.wardId, projectId);
    if (!publicationTablesDiffer(row.tables_snapshot, current)) return c.redirect(adminPath(ward, `/publish/${projectId}`), 303);
  }
  const now = nowIso();
  const publishedVersionId = row.published_at ? newId() : versionId;
  const publish = row.published_at
    ? c.env.DB.prepare(`INSERT INTO document_versions (version_id, ward_id, project_id, document_id, version_no,
        scope, body, title, project_title, based_on_state_version, origin, created_at, created_by_account_id, published_at, published_by_account_id, tables_snapshot)
      SELECT ?, v.ward_id, v.project_id, v.document_id, v.version_no + 1, v.scope, v.body, COALESCE(v.title, d.title), p.title,
        p.state_version, 'person', ?, ?, ?, ?, ${publicationTablesSql}
      FROM document_versions v JOIN projects p ON p.ward_id = v.ward_id AND p.project_id = v.project_id
      JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
      WHERE v.ward_id = ? AND v.project_id = ? AND v.document_id = ? AND v.version_id = ? AND v.version_no = ?
        AND v.version_no = (SELECT MAX(v2.version_no) FROM document_versions v2 WHERE v2.ward_id = v.ward_id AND v2.document_id = v.document_id)
        AND p.closed_at IS NULL AND d.scope = 'space' AND v.scope = 'space'`)
      .bind(publishedVersionId, now, account.accountId, now, account.accountId, ward.wardId, projectId,
        ward.wardId, projectId, documentId, versionId, versionNo)
    : c.env.DB.prepare(`UPDATE document_versions SET published_at = ?, published_by_account_id = ?, project_title = ?, tables_snapshot = ${publicationTablesSql}
    WHERE ward_id = ? AND project_id = ? AND document_id = ? AND version_id = ? AND version_no = ? AND published_at IS NULL AND scope = 'space'
      AND version_no = (SELECT MAX(v.version_no) FROM document_versions v WHERE v.ward_id = ? AND v.document_id = ?)
      AND EXISTS (SELECT 1 FROM documents d WHERE d.ward_id = ? AND d.document_id = ? AND d.scope = 'space')
      AND EXISTS (SELECT 1 FROM projects p WHERE p.ward_id = ? AND p.project_id = ? AND p.closed_at IS NULL)`)
    .bind(now, account.accountId, project.title, ward.wardId, projectId, ward.wardId, projectId, documentId, versionId, versionNo,
      ward.wardId, documentId, ward.wardId, documentId, ward.wardId, projectId);
  const result = await publish.run();
  if (result.meta.changes !== 1) return adminResult(c, "下書きの内容が変わったか、すでに知らせています。知らせる画面で内容を確かめてください。", 409, { href: adminPath(c.var.ward, `/publish/${encodeURIComponent(c.req.param("projectId"))}`), label: "知らせる画面に戻る" }, "知らせる内容と相手を確かめて、もう一度操作してください。");
  await recordPublishedItems(c.env.DB, ward.wardId, projectId, publishedVersionId, account.accountId);
  for (const taskKey of distributedTaskKeys(tasks, row.kind)) {
    await markDistributedTask(c.env.DB, ward.wardId, projectId, account.accountId, taskKey, publishedVersionId);
  }
  return c.redirect(adminPath(ward, `/publish/${projectId}?space=sent`), 303);
});

// 前の入口も、下書きの紙へ案内する。
admin.get("/publish/:projectId/preview/:documentId/:versionNo", (c) => c.redirect(adminPath(c.var.ward,
  `/print/${c.req.param("projectId")}/${c.req.param("documentId")}/${c.req.param("versionNo")}/preview`), 303));

async function confirmPublication(c: Context<AdminEnv>) {
  const { ward, account } = c.var;
  const projectId = c.req.param("projectId")!;
  const form = c.req.method === "POST" ? await c.req.formData() : new FormData();
  const tasks = await projectTasks(c.env.DB, ward.wardId, projectId);
  const features = taskFeatures(tasks);
  const project = await getProject(c.env.DB, ward.wardId, projectId);
  if (!project || project.closed_at) return c.notFound();
  const drafts = await getDrafts(c.env.DB, ward.wardId, projectId);
  const documentId = String(form.get("documentId") ?? c.req.query("documentId") ?? "");
  const draft = drafts.find((row) => documentId ? row.document_id === documentId : row.kind === c.req.query("kind"));
  if (!draft || (form.get("versionId") && form.get("versionId") !== draft.version_id) ||
    (form.get("versionNo") && Number(form.get("versionNo")) !== draft.version_no)) return c.notFound();
  if (draft.scope !== "public" && draft.scope !== "space") return c.notFound();
  const publicScope = draft.scope === "public";
  const flyer = publicScope ? await getNoticeFlyer(c.env.DB, ward.wardId, draft.version_id) : null;
  if (publicScope && draft.published_at) return c.notFound();
  // 当番表と進め方は、配ると今の表が一緒に残るので、確認にも表を出す。配り直せるのは表が変わった時だけ。
  const spaceTables = !publicScope && ["duty_roster", "procedure"].includes(draft.kind) ? await currentPublicationTables(c.env.DB, ward.wardId, projectId) : null;
  if (draft.published_at && !(spaceTables && publicationTablesDiffer(draft.tables_snapshot, spaceTables))) return c.redirect(adminPath(ward, `/publish/${projectId}`), 303);
  const roster = await getRoster(c.env.DB, ward.wardId);
  const recipientScope = form.get("recipientScope") === "all_households" ? "all_households" : "member_households";
  const distribution = distributionFromForm(form, roster, recipientScope === "all_households");
  if (!distribution) return c.html(<AdminPage ward={ward} account={account} title="部数を確かめてください"><h1>部数を確かめてください</h1><p>加入世帯に配る部数は名簿の世帯数までです。全戸に配るときは「全戸」を選んでください。</p><a class="button" href={adminPath(ward, `/publish/${projectId}/confirm?documentId=${draft.document_id}`)}>知らせる内容に戻る</a></AdminPage>, 400);
  const rain = draft.kind === "notice" && draft.title.includes("雨");
  const withAnswer = publicScope && taskCollectsAttendance(tasks, draft.kind);
  const draftDue = withAnswer ? answerDeadlineFromDraft(draft.body, project.year) : null;
  const pastDue = draftDue && draftDue < new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
  const lineDelivery = !publicScope || !canSendLine(draft.kind) || form.get("lineDelivery") === "skip" ? "skip" : "send";
  const warnings = publicScope ? await checkPublicDraft(c.env.DB, ward.wardId, projectId, draft.kind as DocumentKind, draft.body) : [];
  let friends: number | null = null;
  let remaining: number | null = null;
  let lineNotice = "";
  if (lineDelivery === "send") try {
    const token = await lineAccessToken(c.env, ward.wardId);
    if (token) {
      const allowance = await getLineAllowance(token);
      friends = allowance.friends;
      remaining = allowance.remaining;
    }
    else lineNotice = "自治会のLINEの準備ができていません。住民向けのページに載せて、紙を配れます。";
  } catch { lineNotice = "自治会のLINEの人数を読み取れませんでした。知らせたあとに、結果をこの画面に出します。"; }
  const copies = publicScope ? distribution.targets.reduce((sum, target) => sum + target.copies, 0) : 0;
  const sendLabel = publicScope ? draft.published_at ? "知らせ直す" : "住民に知らせる" : draft.published_at ? "載せ直す" : "実行委員と班長のページに載せる";
  const tablesPreview = spaceTables ? <><h3>当番</h3><MaterialsTable table="duties" items={spaceTables} /><h3>配置図</h3><MaterialsTable table="layout" items={spaceTables} /><h3>実行委員名簿</h3><MaterialsTable table="committee" items={spaceTables} /></> : null;
  const printHref = adminPath(ward, `/print/${projectId}/${draft.document_id}/${draft.version_no}/preview`);
  const editHref = adminPath(ward, `/projects/${projectId}/draft/${draft.kind}`);
  c.header("Cache-Control", "no-store");
  return c.html(<AdminPage ward={ward} account={account} title="知らせる内容を見る" back={{ href: editHref, label: "下書きへ" }}>
    <div class="publish-confirm"><h1>{publicScope ? draft.published_at ? "次の内容で知らせ直します" : "次の内容で住民に知らせます" : draft.published_at ? "次の内容で載せ直します" : "次の内容で実行委員と班長のページに載せます"}</h1><p class="lead">{publicScope ? "まだ知らせていません。" : "まだ載せていません。"}読んで、よければ「{sendLabel}」を押してください。{publicScope ? "LINEで送った知らせは取り消せません。" : ""}</p>
    {pastDue ? <Notice>本文の締切は過ぎているため、このまま知らせると返事の受付が続きますが、締切は知らせたあとに変えられます。</Notice> : null}
    {documentBodyCheckMessage(c.req.query("check_body")) ? <Notice>{documentBodyCheckMessage(c.req.query("check_body"))}</Notice> : null}
    <dl class="facts"><dt>{publicScope ? "住民向けのページ" : "実行委員と班長のページ"}</dt><dd>載ります</dd>{publicScope ? <><dt>自治会のLINE</dt><dd>{lineDelivery === "skip" ? "今回は自治会のLINEに送りません。" : lineNotice || (friends === null ? "友だちに知らせます" : `友だち${friends}人に届きます`)}</dd></> : null}{!rain ? <><dt>紙</dt><dd>{copies ? `${copies}部を印刷できます` : "印刷して配れます"}</dd></> : null}</dl>
    <form method="post" action={adminPath(ward, `/publish/${projectId}/${publicScope ? "send" : "space"}`)}>
      <input type="hidden" name="documentId" value={draft.document_id} /><input type="hidden" name="versionId" value={draft.version_id} /><input type="hidden" name="versionNo" value={draft.version_no} />
      {publicScope && !rain ? <details class="fold"><summary>配る相手や部数を変える</summary><div>
        <input type="hidden" name="targetMode" value="district" />
        <fieldset><legend>紙を配る相手</legend><div class="choice"><label><input type="radio" name="recipientScope" value="member_households" checked={recipientScope === "member_households"} /> 加入世帯</label><label><input type="radio" name="recipientScope" value="all_households" checked={recipientScope === "all_households"} /> 全戸（加入していない世帯も）</label></div></fieldset>
        <fieldset><legend>班ごとの部数</legend><div class="qty">{[...new Set(roster.map((row) => row.district))].map((district, index) => {
          const target = distribution.targets.find((row) => row.district === district);
          return <label><input type="checkbox" name="district" value={district} checked={Boolean(target)} />{district}<input type="number" name={`copies_${index}`} min="1" value={target?.copies ?? roster.filter((row) => row.district === district).length} /><span>部</span></label>;
        })}</div>{!roster.length ? <label>全戸に配るときの部数<input type="number" name="allCopies" min="1" value={distribution.targets[0]?.copies} /></label> : null}</fieldset>
        {roster.length ? <details class="fold"><summary>世帯を選ぶ</summary><p>加入世帯の一部に配るときは、世帯に印を付けてください。</p>{householdChoices(roster).map(({ district, household, count }) => <label><input type="checkbox" name="household" value={JSON.stringify([district, household])} checked={distribution.mode === "household" && distribution.targets.some((target) => target.district === district && target.household === household)} />{district} / {household}{count > 1 ? `（${count}部）` : ""}</label>)}</details> : null}
        {canSendLine(draft.kind) ? <><Choices name="lineDelivery" legend="自治会のLINE" required={false} items={[
          { value: "send", title: "LINEで友だちに知らせる", note: "自治会のLINEを友だちに追加している人みんなに、文と画像を送ります。LINEで送ったものは取り消せません。", checked: lineDelivery === "send" },
          { value: "skip", title: "今回は知らせない", note: "住民向けのページに載せ、紙を印刷できるようにします。", checked: lineDelivery === "skip" },
        ]} />{remaining !== null ? <p class="muted">送ったあと、今月はあと{Math.max(remaining - (friends ?? 0), 0)}通です。</p> : null}</> : <input type="hidden" name="lineDelivery" value="skip" />}
      </div></details> : <><input type="hidden" name="distribution" value={JSON.stringify({ mode: "district", targets: [] })} /><input type="hidden" name="lineDelivery" value={lineDelivery} /></>}
      {lineDelivery === "send" && remaining !== null && friends !== null && remaining < friends ? <Notice>今月、自治会のLINEで送れる通数が足りません。住民向けのページに載せて、紙を配れます。</Notice> : null}
      {draft.published_at ? <Notice>載せたときから表が変わっています。ここに出ている今の表で載せ直します。</Notice> : null}
      {draft.stale_since_version !== null ? <Notice>新しいものが入っています。ここに表示した内容で知らせられます。直すときは下書きに戻ってください。</Notice> : null}
      {warnings.filter((warning) => !warning.startsWith("まだ決まっていないところ")).map((warning) => <PublicWarning finding={warning} />)}
      {draft.body.includes(PENDING) ? <div class="notice warn"><strong>まだ決めていないところがあります</strong><p>「（確認中）」のところは、紙とページから外して知らせます。入れるときは下書きに戻ってください。欄の下に、どこで決めるか（質問に答える、資料を今年のものにする、欄に書く）を書いてあります。</p><a class="quiet" href={adminPath(ward, `/projects/${projectId}/draft/${draft.kind}`)}>下書きを直す</a></div> : null}
      <div class="compare"><section class="compare-paper"><b>紙{copies ? `（${recipientScope === "all_households" ? "全戸" : "加入世帯"}に${copies}部）` : ""}</b><div class="sheet-preview"><h2>{paperHeading(project.title, draft.title)}</h2><ArticleBody body={draft.body} title={{ project: project.title, document: draft.title }} kind={draft.kind} />{tablesPreview}{withAnswer ? <p class="answer-slip-preview"><b>回答票</b>　切り取って班長か役員に渡します。{features.delegation ? "出席、委任、欠席の欄があります。" : "世帯の代表者（ふつうは世帯主）のお名前、人数、手伝いの欄があります。"}</p> : null}</div></section>
        <section><b>{publicScope ? "住民向けのページ" : "実行委員と班長のページ"}</b><div class="sheet-preview"><h2>{paperHeading(project.title, draft.title)}</h2><ArticleBody body={draft.body} title={{ project: project.title, document: draft.title }} kind={draft.kind} />{flyer?.flyer_id ? <img src={adminPath(ward, `/projects/${projectId}/flyer/${draft.version_id}`)} alt={draft.title} style="max-width:100%;height:auto" /> : null}{tablesPreview}{withAnswer ? <p class="muted">この下に「出欠を答える」のボタンが出ます。</p> : null}</div></section></div>
      <p class="compare-link"><a class="quiet" href={printHref}>紙の見え方を見る</a></p><p class="muted">{publicScope ? "知らせたあとも、住民向けのページからは取り下げられます。" : "実行委員と班長のページに載せます。住民向けのページには載りません。"}</p>
      <div class="action-bar"><button type="submit">{sendLabel}</button><a class="button secondary" href={editHref}>下書きに戻る</a></div>
    </form></div>
  </AdminPage>);
}
admin.get("/publish/:projectId/confirm", confirmPublication);
admin.post("/publish/:projectId/confirm", confirmPublication);

admin.post("/publish/:projectId/send", async (c) => {
  const { ward, account } = c.var;
  const form = await c.req.formData();
  const projectId = c.req.param("projectId");
  const tasks = await projectTasks(c.env.DB, ward.wardId, projectId);
  const features = taskFeatures(tasks);
  const project = await getProject(c.env.DB, ward.wardId, projectId);
  const documentId = String(form.get("documentId") ?? "");
  const versionId = String(form.get("versionId") ?? "");
  const versionNo = Number(form.get("versionNo"));
  const recipientScope = form.get("recipientScope") === "all_households" ? "all_households" : "member_households";
  if (!project || project.closed_at) return c.notFound();
  const row = await c.env.DB.prepare(`SELECT d.kind, COALESCE(v.title, d.title) AS title, d.scope, d.stale_since_version, v.body, v.based_on_state_version,
      v.published_at FROM documents d JOIN document_versions v
      ON v.ward_id = d.ward_id AND v.document_id = d.document_id
      WHERE d.ward_id = ? AND d.project_id = ? AND d.document_id = ? AND v.version_id = ? AND v.version_no = ?`)
    .bind(ward.wardId, projectId, documentId, versionId, versionNo).first<DraftRow>();
  if (!row || row.scope !== "public" || row.published_at) return c.notFound();
  const flyer = await getNoticeFlyer(c.env.DB, ward.wardId, versionId);
  if (["announcement", "notice"].includes(row.kind) && !flyer && await previousFlyer(c.env.DB, ward.wardId, projectId, row.kind)) {
    return adminResult(c, "前の知らせにはチラシの画像が付いていました。下書きで付け直すか、付けないかを選んでください。", 409,
      { href: adminPath(ward, `/projects/${projectId}/draft/${row.kind}`), label: "下書きに戻る" }, "画像を選んでから、もう一度知らせてください。");
  }
  if (row.kind === "duty_roster") return adminResult(c, "当番表は公開せず、実行委員と班長のページに載せてください。", 400, { href: adminPath(c.var.ward, `/publish/${encodeURIComponent(c.req.param("projectId"))}`), label: "知らせる画面に戻る" }, "知らせる内容と相手を確かめて、もう一度操作してください。");
  if (!(DOCUMENT_KINDS as readonly string[]).includes(row.kind)) return adminResult(c, "文書の種類を確認できません。", 400, { href: adminPath(c.var.ward, `/publish/${encodeURIComponent(c.req.param("projectId"))}`), label: "知らせる画面に戻る" }, "知らせる内容と相手を確かめて、もう一度操作してください。");
  const now = nowIso();
  const publicationId = newId();
  const roster = await getRoster(c.env.DB, ward.wardId);
  const rawDistribution = String(form.get("distribution") ?? "");
  let distribution: PaperDistribution | null = roster.length === 0 && recipientScope !== "all_households"
    ? { mode: "district", targets: [] } : validateDistribution(rawDistribution, roster, recipientScope === "all_households");
  if (!distribution && !rawDistribution.trim().startsWith("{")) {
    const districts = [...new Set(roster.map((entry) => entry.district))];
    const legacy = parseDistribution(rawDistribution, districts);
    distribution = { mode: "district", targets: Object.entries(legacy).map(([district, copies]) => ({ district, copies })) };
  }
  if (form.has("targetMode")) distribution = distributionFromForm(form, roster, recipientScope === "all_households");
  if (!distribution) return adminResult(c, "紙の配布先が名簿と合いません。配布内容を選び直してください。", 400, { href: adminPath(c.var.ward, `/publish/${encodeURIComponent(c.req.param("projectId"))}`), label: "知らせる画面に戻る" }, "知らせる内容と相手を確かめて、もう一度操作してください。");
  const draftDue = taskCollectsAttendance(tasks, row.kind) ? answerDeadlineFromDraft(row.body, project.year) : null;
  // 過ぎた日を受付の締切に入れると、配った途端に回答が閉じる。去年の中身の案でも起きるので入れない
  const answerDue = draftDue && draftDue >= new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()) ? draftDue : null;
  const answerLabels = await getAnswerLabels(c.env.DB, ward.wardId);
  const generalMeeting = features.delegation && row.kind === "announcement";
  const note = generalMeeting ? { meetingNote: await meetingNote(c.env.DB, ward.wardId) } : {};
  let publishedBody = row.body;
  let parsed: unknown;
  try { parsed = JSON.parse(row.body); } catch { /* 文だけの古い下書きも配れる。 */ }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) publishedBody = JSON.stringify({ ...parsed, answerLabels, ...note });
  else if (generalMeeting) publishedBody = JSON.stringify({ text: articleParagraphs(row.body).join("\n\n"), items: [], answerLabels, ...note });
  const publication = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE document_versions SET body = ?, published_at = ?, published_by_account_id = ?, project_title = ?, tables_snapshot = ${publicationTablesSql}
      WHERE ward_id = ? AND project_id = ? AND document_id = ? AND version_id = ? AND version_no = ?
        AND published_at IS NULL
        AND version_no = (SELECT MAX(v.version_no) FROM document_versions v WHERE v.ward_id = ? AND v.document_id = ?)
        AND EXISTS (SELECT 1 FROM projects p WHERE p.ward_id = ? AND p.project_id = ? AND p.closed_at IS NULL)
        AND EXISTS (SELECT 1 FROM documents d WHERE d.ward_id = ? AND d.document_id = ? AND d.scope = 'public')
      RETURNING version_id`)
      .bind(publishedBody, now, account.accountId, project.title, ward.wardId, projectId, ward.wardId, projectId, documentId, versionId, versionNo,
        ward.wardId, documentId, ward.wardId, projectId, ward.wardId, documentId),
    c.env.DB.prepare(`INSERT INTO publication_records
      (ward_id, publication_id, project_id, document_id, version_id, version_no, recipient_scope, distribution, line_status, published_at, published_by_account_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ? WHERE EXISTS (
        SELECT 1 FROM document_versions v WHERE v.ward_id = ? AND v.version_id = ? AND v.published_at = ? AND v.published_by_account_id = ?
      ) RETURNING publication_id`)
      .bind(ward.wardId, publicationId, projectId, documentId, versionId, versionNo, recipientScope, JSON.stringify(distribution), now, account.accountId,
        ward.wardId, versionId, now, account.accountId),
    // 配った内容と同時に締切を保存する。回答画面で保存した日付は上書きしない。
    ...(answerDue ? [c.env.DB.prepare(`INSERT INTO project_deadlines
      (ward_id, project_id, kind, due_on, updated_at, updated_by_account_id)
      SELECT ward_id, project_id, 'answer_due', ?, ?, NULL FROM publication_records
      WHERE ward_id = ? AND project_id = ? AND publication_id = ?
      ON CONFLICT (ward_id, project_id, kind) DO UPDATE SET due_on = excluded.due_on, updated_at = excluded.updated_at
      WHERE project_deadlines.updated_by_account_id IS NULL`)
      .bind(answerDue, now, ward.wardId, projectId, publicationId)] : []),
  ]);
  // 変更件数には検索索引のトリガーも含まれるため、文書の更新と配布記録の作成はそれぞれ返された行で確かめる。
  if (publication[0]?.results.length !== 1 || publication[1]?.results.length !== 1) {
    return c.html(<AdminPage ward={ward} account={account} title="知らせる内容を確かめてください" back={{ href: adminPath(ward, `/publish/${projectId}`), label: "下書きに戻る" }}>
      <h1>知らせる内容を確かめてください</h1><p>下書きの内容が変わったか、すでに知らせています。知らせる画面で内容を確かめてください。</p>
    </AdminPage>, 409);
  }
  await recordPublishedItems(c.env.DB, ward.wardId, projectId, versionId, account.accountId);
  await fillEventDay(c.env.DB, ward.wardId, projectId, project.year, publishedBody, account.accountId);
  for (const taskKey of distributedTaskKeys(tasks, row.kind)) {
    await markDistributedTask(c.env.DB, ward.wardId, projectId, account.accountId, taskKey, versionId);
  }
  const publicUrl = `${(c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin).replace(/\/+$/, "")}/${ward.slug}/p/${encodeURIComponent(projectId)}`;
  const sendLine = canSendLine(row.kind) && form.get("lineDelivery") !== "skip";
  let lineStatus: PublicationRow["line_status"] = sendLine ? "not_configured" : "not_sent";
  let lineRecipients: number | null = null;
  let lineSentAt: string | null = null;
  let lineError: string | null = null;
  if (sendLine) {
    try {
      const token = await lineAccessToken(c.env, ward.wardId);
      if (!token) lineError = LINE_NOT_CONFIGURED;
      else {
        const allowance = await getLineAllowance(token);
        lineRecipients = allowance.friends;
        if (allowance.friends === null || (allowance.remaining !== null && allowance.remaining < allowance.friends)) {
          lineStatus = "failed";
          lineError = allowance.friends === null ? "集計の済んだ友だちの人数を取得できないため、自治会のLINEには送っていません。住民向けのページと紙は使えます。" : "今月、自治会のLINEで送れる通数が足りないため、送っていません。";
        } else {
          if (flyer?.flyer_id) {
            const root = new URL(publicUrl).origin;
            const answerUrl = `${root}/${ward.slug}/answer/${encodeURIComponent(projectId)}`;
            await broadcastLineText(token, noticeLineText(paperHeading(project.title, row.title), publishedBody, answerUrl), fetch, {
              originalContentUrl: root + noticeFlyerPath(ward.slug, versionId, flyer.flyer_id),
              previewImageUrl: root + noticeFlyerPath(ward.slug, versionId, flyer.flyer_id, true),
            });
          } else await sendLineTitleAndUrl(token, paperHeading(project.title, row.title), publicUrl);
          lineStatus = "sent";
          lineSentAt = nowIso();
        }
      }
    } catch {
      lineStatus = "failed";
      lineError = "自治会のLINEに送信できませんでした。接続の設定を、SasaeAIの運営者に確かめてもらってください。";
    }
  }
  await c.env.DB.prepare(`UPDATE publication_records SET line_status = ?, line_recipients = ?, line_sent_at = ?, line_error = ?
    WHERE ward_id = ? AND publication_id = ?`).bind(lineStatus, lineRecipients, lineSentAt, lineError, ward.wardId, publicationId).run();
  if (sendLine) await deliveryAlert(c.env.DB, ward.wardId, "publish", lineError);
  return c.redirect(adminPath(ward, `/publish/${projectId}?done=${publicationId}`), 303);
});

admin.post("/publish/:projectId/lower/:publicationId", async (c) => {
  const { ward } = c.var;
  await c.env.DB.prepare(`UPDATE publication_records SET unpublished_at = ?
    WHERE ward_id = ? AND project_id = ? AND publication_id = ? AND unpublished_at IS NULL`)
    .bind(nowIso(), ward.wardId, c.req.param("projectId"), c.req.param("publicationId")).run();
  return c.redirect(adminPath(ward, `/publish/${c.req.param("projectId")}?lowered=${encodeURIComponent(c.req.param("publicationId"))}`), 303);
});

/** 読む人に見せる段落。文を正とし、項目は文に書かれていない物だけ見出しを付けて足す。 */
export function articleParagraphs(body: string, title?: { project: string; document: string }, kind?: string, hide: readonly string[] = []): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(body) as unknown; } catch { parsed = body; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return collectText(parsed);
  const { text, items } = parsed as { text?: unknown; items?: unknown };
  if (typeof text !== "string" || !Array.isArray(items)) return collectText(parsed);
  const pending = withoutPending(plainText(text));
  const readable = title ? withoutTitleLine(pending, title.project, title.document) : pending;
  const paragraphs = readable.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  // 知らせは本文が正。変更前の場所を項目から足し戻すと、新旧が並ぶ。
  if (kind === "notice" && paragraphs.length) return paragraphs;
  const missing = items.flatMap((item: unknown) => {
    const { key, content } = (item ?? {}) as { key?: unknown; content?: unknown };
    if (typeof key !== "string" || typeof content !== "string" || content.trim() === PENDING || hide.includes(key) || writtenInText(key, content, readable)) return [];
    return [`${isItemKey(key) ? ITEM_SCREEN_LABEL[key] : key}: ${formatDateText(content.trim())}`];
  });
  return [...paragraphs, ...(missing.length ? [missing.join("\n")] : [])];
}

export function ArticleBody({ body, title, kind, hide }: { body: string; title?: { project: string; document: string }; kind?: string; hide?: readonly string[] }) {
  return <div>{articleParagraphs(body, title, kind, hide).map((text, index) => <p key={index} style="white-space:pre-wrap">{text}</p>)}</div>;
}

interface DistributionTarget { district: string; copies: number; household?: string; }
interface PaperDistribution { mode: "district" | "household"; targets: DistributionTarget[]; }

/** 取り下げは、押すとすぐ住民向けのページから消える。何が起きるかを書いた畳みに入れ、確かめの窓を出す。 */
function LowerFold({ action, label }: { action: string; label: string }) {
  return <details class="fold"><summary>住民向けのページから取り下げる</summary><div>
    <p>取り下げると、住民向けのページからこの{label}が見えなくなります。知らせた記録は残ります。自治会のLINEで送ったものと、配った紙は取り消せません。もう一度載せる時は、直して知らせ直します。</p>
    <form method="post" action={action} onsubmit={`return confirm(${JSON.stringify(`住民向けのページからこの${label}を取り下げます。LINEで送ったものは取り消せません。続けますか？`)})`}><button class="secondary danger" type="submit">取り下げる</button></form>
  </div></details>;
}

function distributionFromForm(form: FormData, roster: Array<{ district: string; household: string }>, allHouseholds: boolean): PaperDistribution | null {
  if (!roster.length) return allHouseholds && form.get("allCopies")
    ? allHouseholdCopies(Number(form.get("allCopies"))) : { mode: "district", targets: [] };
  if (!form.has("targetMode")) {
    if (form.get("distribution")) {
      const raw = String(form.get("distribution"));
      if (raw.trim().startsWith("{")) return validateDistribution(raw, roster, allHouseholds);
      const legacy = parseDistribution(raw, [...new Set(roster.map((row) => row.district))]);
      return { mode: "district", targets: Object.entries(legacy).map(([district, copies]) => ({ district, copies })) };
    }
    const names = [...new Set(roster.map((row) => row.district))];
    return { mode: "district", targets: names.map((district) => ({ district, copies: roster.filter((row) => row.district === district).length })) };
  }
  const households = new Set(form.getAll("household").map(String));
  return buildDistribution(roster, allHouseholds ? "district" : households.size ? "household" : String(form.get("targetMode")),
    new Set(form.getAll("district").map(String)), households, (index) => Number(form.get(`copies_${index}`)), allHouseholds);
}

function DistributionFacts({ raw }: { raw: string }) {
  const parsed: unknown = JSON.parse(raw);
  const targets = typeof parsed === "object" && parsed !== null && "targets" in parsed && Array.isArray(parsed.targets) ? parsed.targets : null;
  if (!targets) return <p>紙の配布先: {paperTargetLabel(raw)}</p>;
  return <dl class="facts">{targets.map((target: { district: string; household?: string; copies: number }) => <><dt>{target.district}{target.household ? ` / ${target.household}` : ""}</dt><dd>{target.copies}部</dd></>)}</dl>;
}

/** 検査の結果だけを、配る人が読める文にする。警告で操作を止めない。 */
function PublicWarning({ finding }: { finding: string }) {
  const separator = finding.indexOf(": ");
  const kind = separator < 0 ? finding : finding.slice(0, separator);
  const value = separator < 0 ? "" : finding.slice(separator + 2);
  const messages: Record<string, { title: string; text: string }> = {
    "名簿の名前": { title: "名簿の名前と同じ文字があります", text: `「${value}」が本文にあります。だれでも読める案内に出てよければ、このまま知らせられます。` },
    "協賛の額": { title: "協賛の金額と同じ数字があります", text: `「${value}」が本文にあります。だれでも読める案内に出てよければ、このまま知らせられます。` },
    "個人の連絡先": { title: "個人の連絡先と思われる文字があります", text: `「${value}」が本文にあります。だれでも読める案内に出てよければ、このまま知らせられます。` },
    "まだ決まっていないところ": { title: "まだ決めていないところがあります", text: `「${value}」が本文にあります。このまま知らせられます。直すときは下書きに戻ってください。` },
    "去年の日付のようです": { title: "去年の日付のようです", text: `「${value}」が本文にあります。今年の日でなければ、下書きに戻って直してください。` },
  };
  const message = messages[kind] ?? { title: "本文を読み取れないところがあります", text: "下に出ている内容を読んで、このまま知らせられます。直すときは下書きに戻ってください。" };
  return <div class="notice warn"><strong>{message.title}</strong><p>{message.text}</p></div>;
}

function allHouseholdCopies(copies: number): PaperDistribution | null {
  return Number.isInteger(copies) && copies > 0 ? { mode: "district", targets: [{ district: "全戸", copies }] } : null;
}

/** 世帯を選ぶ欄。名簿に同じ班と名前の世帯が複数あると見分けられないので、一つの欄にまとめて数を示す。 */
function householdChoices(roster: Array<{ district: string; household: string }>) {
  const choices = new Map<string, { district: string; household: string; count: number }>();
  for (const entry of roster) {
    const key = JSON.stringify([entry.district, entry.household]);
    const found = choices.get(key);
    if (found) found.count += 1;
    else choices.set(key, { district: entry.district, household: entry.household, count: 1 });
  }
  return [...choices.values()];
}

function buildDistribution(
  roster: Array<{ district: string; household: string }>, mode: string, districts: Set<string>, households: Set<string>, copyCount: (index: number) => number, allHouseholds = false,
): PaperDistribution | null {
  if (mode === "household") {
    const targets = roster.filter((entry) => households.has(JSON.stringify([entry.district, entry.household])))
      .map((entry) => ({ district: entry.district, household: entry.household, copies: 1 }));
    return targets.length ? { mode, targets } : null;
  }
  if (mode !== "district") return null;
  const names = [...new Set(roster.map((entry) => entry.district))];
  const targets: DistributionTarget[] = [];
  for (const [index, district] of names.entries()) {
    if (!districts.has(district)) continue;
    const copies = copyCount(index);
    const available = roster.filter((entry) => entry.district === district).length;
    if (!Number.isInteger(copies) || copies < 1 || (!allHouseholds && copies > available)) return null;
    targets.push({ district, copies });
  }
  return targets.length ? { mode, targets } : null;
}

function validateDistribution(raw: string, roster: Array<{ district: string; household: string }>, allHouseholds = false): PaperDistribution | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const input = value as { mode?: unknown; targets?: unknown };
    if (!Array.isArray(input.targets)) return null;
    const households = new Set(roster.map((entry) => JSON.stringify([entry.district, entry.household])));
    const districts = new Set(roster.map((entry) => entry.district));
    if (allHouseholds && roster.length === 0) districts.add("全戸");
    const targets: DistributionTarget[] = [];
    for (const item of input.targets) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
      const target = item as { district?: unknown; household?: unknown; copies?: unknown };
      if (typeof target.district !== "string" || !districts.has(target.district) || !Number.isInteger(target.copies) || (target.copies as number) < 1) return null;
      if (input.mode === "household") {
        if (typeof target.household !== "string" || !households.has(JSON.stringify([target.district, target.household])) || target.copies !== 1) return null;
        targets.push({ district: target.district, household: target.household, copies: 1 });
      } else if (input.mode === "district") {
        const available = roster.filter((entry) => entry.district === target.district).length;
        if (target.household !== undefined || (!allHouseholds && (target.copies as number) > available)) return null;
        targets.push({ district: target.district, copies: target.copies as number });
      } else return null;
    }
    return (input.mode === "district" || input.mode === "household") && (targets.length > 0 || input.mode === "district")
      ? { mode: input.mode, targets }
      : null;
  } catch { return null; }
}

function collectText(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(collectText);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !["format", "kind", "scope", "source", "version"].includes(key))
    .flatMap(([, child]) => collectText(child));
}

export const publish: Bundle = { admin };
