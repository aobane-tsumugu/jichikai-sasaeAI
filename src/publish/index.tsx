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
import { formatJst } from "../core/time";
import type { AdminEnv } from "../env";
import { getLineAllowance, lineAccessToken, LINE_NOT_CONFIGURED, sendLineTitleAndUrl } from "../line/api";
import { answerDeadlineFromDraft, getRoster, parseDistribution } from "../answers/api";
import { checkPublicDraft } from "./check";
import { DOCUMENT_KINDS, DOCUMENT_KIND_LABEL, ITEM_LABEL, ITEM_SCREEN_LABEL, isItemKey, type DocumentKind } from "../project/model";
import { applyChange } from "../project/apply";
import { recordPublishedItems } from "../project/actions";
import { paperHeading, withoutTitleLine } from "../project/heading";
import { documentBodyCheckMessage, PENDING, withoutPending, writtenInText } from "../project/document-body";
import { MaterialsTable } from "../space/materials";
import { currentPublicationTables, publicationTablesDiffer, publicationTablesSql } from "../space/publication-tables";

interface DraftRow {
  tables_snapshot: string | null;
  document_id: string;
  kind: string;
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
  kind: string;
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

const canSendLine = (kind: string) => ["announcement", "recruitment", "notice"].includes(kind);

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
  const lowered = allRecords.find((record) => record.publication_id === c.req.query("lowered") && record.unpublished_at);
  if (done || lowered) {
    const record = (done ?? lowered)!;
    const draft = drafts.find((row) => row.document_id === record.document_id);
    const rain = draft?.kind === "notice" && draft.title.includes("雨");
    const kind = draft?.kind ?? "announcement";
    const task = await c.env.DB.prepare(`SELECT task_id, name FROM project_map_tasks
      WHERE ward_id = ? AND project_id = ? AND removed_at IS NULL AND progress = 'done' AND progress_source_ref = ?`)
      .bind(ward.wardId, projectId, record.version_id).first<{ task_id: string; name: string }>();
    const mapHref = adminPath(ward, `/projects/${projectId}/map${task ? `?changed=${encodeURIComponent(task.task_id)}` : ""}`);
    const editHref = adminPath(ward, `/projects/${projectId}/draft/${kind}`);
    const printHref = adminPath(ward, `/print/${projectId}/${record.document_id}/${record.version_no}${kind === "announcement" ? "/announcement" : kind === "duty_roster" ? "/duty" : ""}`);
    const failed = record.line_status === "failed" || record.line_status === "not_configured";
    return c.html(<AdminPage ward={ward} account={account} title={lowered ? "区のページから下げました" : rain ? "雨の変更を配りました" : "配りました"} back={{ href: mapHref, label: `${project.title}の段取りへ` }}>
      <h1>{lowered ? "区のページから下げました" : rain ? "雨の変更を配りました" : `${DOCUMENT_KIND_LABEL[kind as DocumentKind]}を配りました`}</h1>
      {lowered ? <Notice>下げました。配った記録は残ります。LINEの知らせは取り消せません。</Notice> :
        <div class={failed ? "notice warn" : "notice done"} role="status"><strong>{failed ? "公式LINEには送れませんでした" : "区のページに載せました"}</strong>
          <p>{failed ? "区のページには載っています。紙も配れます。LINEは送らないままでもかまいません。" : record.line_status === "sent" ? `公式LINE${record.line_recipients === null ? "に" : `の友だち${record.line_recipients}人に`}送りました。` : record.line_status === "pending" ? "公式LINEの送信結果はまだ分かりません。" : "今回は公式LINEに送りませんでした。"}{task ? `段取りの「${task.name}」を済みにしました。` : ""}</p>
        </div>}
      <section class="next"><strong>次は</strong>{lowered ? <><p>内容を直して、配り直せます。</p><a class="button" href={editHref}>直して配り直す</a></> : rain ? <p>班長に電話して伝えてください。掲示も張り替えてください。ここは画面では済みません。</p> : <><p>案内と班長への一枚を印刷して、班長に渡してください。</p><a class="button" href={printHref}>案内を印刷する</a><a class="quiet" href={`${printHref}/leader`}>班長への一枚を印刷する</a></>}</section>
      {!rain && !lowered ? <DistributionFacts raw={record.distribution} /> : null}
      {!lowered ? <div class="action-links"><a class="button secondary" href={`/${ward.slug}/p/${encodeURIComponent(projectId)}`}>区のページで見る</a></div> : null}
      <h2>間違えたときは</h2><p>{rain ? "直して配り直すと、区のページは新しい知らせに変わります。LINEで送った知らせは取り消せません。" : "直して配り直すと、区のページは新しい案内に変わります。"}</p>
      <div class="action-links"><a class="button secondary" href={editHref}>直して配り直す</a>{!rain && !record.unpublished_at ? <form method="post" action={adminPath(ward, `/publish/${projectId}/lower/${record.publication_id}`)}><button class="secondary" type="submit">区のページから下げる</button></form> : null}</div>
      {!rain ? <p class="muted">下げても、配った記録は残ります。LINEで送った知らせは取り消せません。</p> : null}
      <a class="quiet" href={adminPath(ward, `/publish/${projectId}`)}>配る画面へ</a>
    </AdminPage>);
  }
  const currentTables = await currentPublicationTables(c.env.DB, ward.wardId, projectId);
  const orderedDrafts = [...drafts].sort((a, b) => Number(Boolean(a.published_at)) - Number(Boolean(b.published_at)));
  const primary = orderedDrafts.find((draft) => draft.scope === "public" && !draft.published_at);
  const copies = (await getRoster(c.env.DB, ward.wardId)).length;

  return c.html(<AdminPage ward={ward} account={account} title="配る" back={{ href: adminPath(ward, `/projects/${projectId}/map`), label: `${project.title}の段取りへ` }}>
    <h1>{primary ? paperHeading(project.title, primary.title) : project.title}を配る</h1>{primary ? <p class="lead">配ると、同じ内容が区のページと紙に出ます。</p> : null}
    {project.closed_at ? <Notice>この行事は閉じています。</Notice> : null}
    {documentBodyCheckMessage(c.req.query("check_body")) ? <Notice>{documentBodyCheckMessage(c.req.query("check_body"))}</Notice> : null}
    {c.req.query("space") === "sent" ? <><Notice>実行委員と班長のページに配りました。</Notice><section class="next"><strong>次は</strong><p>配られたものを実行委員と班長に伝えてください。</p><a class="button" href={adminPath(ward, `/space/${projectId}`)}>実行委員と班長のページへ</a></section><p>間違えたときは、下書きを直して配り直せます。</p></> : null}
    {!drafts.length ? <><p>配れる下書きはまだありません。</p><a class="button" href={adminPath(ward, `/projects/${projectId}/draft/announcement`)}>案内の下書きを書く</a></> : null}
    {orderedDrafts.map((draft, index) => {
      const previous = allRecords.find((record) => record.document_id === draft.document_id && !record.unpublished_at);
      const tablesChanged = draft.scope === "space" && (draft.kind === "duty_roster" || draft.kind === "procedure") &&
        (!!previous || !!draft.published_at) && publicationTablesDiffer(previous?.tables_snapshot ?? null, currentTables);
      return <>{index === 1 ? <h2>ほかに配れるもの</h2> : null}<section class="panel" key={draft.document_id}>
        <h2>{paperHeading(project.title, draft.title)}</h2>
        <p>{draft.published_at ? "すでに配っています。" : "下書きがあります"}</p>
        {draft === primary ? <dl class="facts"><dt>区のページ</dt><dd>載せます</dd><dt>公式LINE</dt><dd>{canSendLine(draft.kind) ? "題とページを送ります" : "今回は送りません"}</dd><dt>紙</dt><dd>{copies ? `加入世帯に${copies}部` : "印刷して配れます"}</dd></dl> : null}
        {draft.stale_since_version !== null ? <Notice>新しいものが入っています。下書きを直すか、このまま配れます。</Notice> : null}
        {tablesChanged ? <Notice>{previous?.tables_snapshot === null ? "配ったときの表の記録がありません。今の表を配り直せます。" : "配ったときから表が変わっています。今の表を配り直せます。"}</Notice> : null}
        {draft.scope === "space" ? <><p>実行委員と班長に配ります。区のページには載りません</p>{!project.closed_at && (!draft.published_at || tablesChanged) ? <form method="post" action={adminPath(ward, `/publish/${projectId}/confirm`)}>
          <input type="hidden" name="documentId" value={draft.document_id} /><input type="hidden" name="versionId" value={draft.version_id} /><input type="hidden" name="versionNo" value={draft.version_no} />
          <button class={index === 0 ? "" : "secondary"} type="submit">配る内容を見る</button><p class="muted">押しても、まだ配られません。</p></form> : null}</> : null}
        {draft.scope === "public" && !project.closed_at && !draft.published_at ? <form method="post" action={adminPath(ward, `/publish/${projectId}/confirm`)}>
          <input type="hidden" name="documentId" value={draft.document_id} /><input type="hidden" name="versionId" value={draft.version_id} /><input type="hidden" name="versionNo" value={draft.version_no} />
          <button class={index === 0 ? "" : "secondary"} type="submit">配る内容を見る</button><p class="muted">押しても、まだ配られません。</p>{!canSendLine(draft.kind) ? <p>公式LINEには送らず、区のページに載せます。</p> : null}
        </form> : null}
        <a class="quiet" href={adminPath(ward, `/projects/${projectId}/draft/${draft.kind}`)}>下書きを直す</a>
      </section></>;
    })}
    <h2>これまでに配ったもの</h2>{!allRecords.length ? <p>まだありません。</p> : allRecords.map((record) => <section class="panel">
      <p>{formatJst(record.published_at)}に配りました。</p>{record.scope === "space" ? <p>実行委員と班長に配りました。</p> : <>
        <p>紙の配布先: {paperTargetLabel(record.distribution)}</p><p>公式LINE: {record.line_status === "sent" ? `${record.line_recipients ?? ""}人に送りました` : record.line_status === "failed" || record.line_status === "not_configured" ? "送れませんでした。区のページには載っています。紙も配れます。" : record.line_status === "pending" ? "送信結果はまだ分かりません" : "今回は送っていません"}</p>
        {record.unpublished_at ? <p>区のページから下げています。</p> : <form method="post" action={adminPath(ward, `/publish/${projectId}/lower/${record.publication_id}`)}><button class="secondary" type="submit">区のページから下げる</button></form>}
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
  const project = await getProject(c.env.DB, ward.wardId, projectId);
  if (!project || project.closed_at) return c.notFound();
  const row = await c.env.DB.prepare(`SELECT d.kind, d.scope, d.stale_since_version, v.version_id, v.version_no, v.published_at, v.tables_snapshot
    FROM documents d JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    WHERE d.ward_id = ? AND d.project_id = ? AND d.document_id = ? AND v.version_id = ? AND v.version_no = ?`)
    .bind(ward.wardId, projectId, documentId, versionId, versionNo)
    .first<{ kind: string; scope: string; stale_since_version: number | null; version_id: string; version_no: number; published_at: string | null; tables_snapshot: string | null }>();
  if (!row || row.scope !== "space") return c.notFound();
  if (row.published_at) {
    const current = await currentPublicationTables(c.env.DB, ward.wardId, projectId);
    if (!publicationTablesDiffer(row.tables_snapshot, current)) return c.redirect(adminPath(ward, `/publish/${projectId}`), 303);
  }
  const now = nowIso();
  const publishedVersionId = row.published_at ? newId() : versionId;
  const publish = row.published_at
    ? c.env.DB.prepare(`INSERT INTO document_versions (version_id, ward_id, project_id, document_id, version_no,
        scope, body, title, based_on_state_version, origin, created_at, created_by_account_id, published_at, published_by_account_id, tables_snapshot)
      SELECT ?, v.ward_id, v.project_id, v.document_id, v.version_no + 1, v.scope, v.body, COALESCE(v.title, d.title),
        p.state_version, 'person', ?, ?, ?, ?, ${publicationTablesSql}
      FROM document_versions v JOIN projects p ON p.ward_id = v.ward_id AND p.project_id = v.project_id
      JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
      WHERE v.ward_id = ? AND v.project_id = ? AND v.document_id = ? AND v.version_id = ? AND v.version_no = ?
        AND v.version_no = (SELECT MAX(v2.version_no) FROM document_versions v2 WHERE v2.ward_id = v.ward_id AND v2.document_id = v.document_id)
        AND p.closed_at IS NULL AND d.scope = 'space' AND v.scope = 'space'`)
      .bind(publishedVersionId, now, account.accountId, now, account.accountId, ward.wardId, projectId,
        ward.wardId, projectId, documentId, versionId, versionNo)
    : c.env.DB.prepare(`UPDATE document_versions SET published_at = ?, published_by_account_id = ?, tables_snapshot = ${publicationTablesSql}
    WHERE ward_id = ? AND project_id = ? AND document_id = ? AND version_id = ? AND version_no = ? AND published_at IS NULL AND scope = 'space'
      AND version_no = (SELECT MAX(v.version_no) FROM document_versions v WHERE v.ward_id = ? AND v.document_id = ?)
      AND EXISTS (SELECT 1 FROM documents d WHERE d.ward_id = ? AND d.document_id = ? AND d.scope = 'space')
      AND EXISTS (SELECT 1 FROM projects p WHERE p.ward_id = ? AND p.project_id = ? AND p.closed_at IS NULL)`)
    .bind(now, account.accountId, ward.wardId, projectId, ward.wardId, projectId, documentId, versionId, versionNo,
      ward.wardId, documentId, ward.wardId, documentId, ward.wardId, projectId);
  const result = await publish.run();
  if (result.meta.changes !== 1) return adminResult(c, "下書きの内容が変わったか、すでに配っています。配る画面で内容を確かめてください。", 409, { href: adminPath(c.var.ward, `/publish/${encodeURIComponent(c.req.param("projectId"))}`), label: "配る画面に戻る" }, "配る内容と配る相手を確かめて、もう一度操作してください。");
  await recordPublishedItems(c.env.DB, ward.wardId, projectId, publishedVersionId, account.accountId);
  if (row.kind === "duty_roster") await markDistributedTask(c.env.DB, ward.wardId, projectId, account.accountId, "duty_roster", publishedVersionId);
  return c.redirect(adminPath(ward, `/publish/${projectId}?space=sent`), 303);
});

// 前の入口も、下書きの紙へ案内する。
admin.get("/publish/:projectId/preview/:documentId/:versionNo", (c) => c.redirect(adminPath(c.var.ward,
  `/print/${c.req.param("projectId")}/${c.req.param("documentId")}/${c.req.param("versionNo")}/preview`), 303));

async function confirmPublication(c: Context<AdminEnv>) {
  const { ward, account } = c.var;
  const projectId = c.req.param("projectId")!;
  const form = c.req.method === "POST" ? await c.req.formData() : new FormData();
  const project = await getProject(c.env.DB, ward.wardId, projectId);
  if (!project || project.closed_at) return c.notFound();
  const drafts = await getDrafts(c.env.DB, ward.wardId, projectId);
  const documentId = String(form.get("documentId") ?? c.req.query("documentId") ?? "");
  const draft = drafts.find((row) => documentId ? row.document_id === documentId : row.kind === c.req.query("kind"));
  if (!draft || (form.get("versionId") && form.get("versionId") !== draft.version_id) ||
    (form.get("versionNo") && Number(form.get("versionNo")) !== draft.version_no)) return c.notFound();
  if (draft.scope !== "public" && draft.scope !== "space") return c.notFound();
  const publicScope = draft.scope === "public";
  if (publicScope && draft.published_at) return c.notFound();
  // 当番表と進め方は、配ると今の表が一緒に残るので、確認にも表を出す。配り直せるのは表が変わった時だけ。
  const spaceTables = !publicScope && ["duty_roster", "procedure"].includes(draft.kind) ? await currentPublicationTables(c.env.DB, ward.wardId, projectId) : null;
  if (draft.published_at && !(spaceTables && publicationTablesDiffer(draft.tables_snapshot, spaceTables))) return c.redirect(adminPath(ward, `/publish/${projectId}`), 303);
  const roster = await getRoster(c.env.DB, ward.wardId);
  const recipientScope = form.get("recipientScope") === "all_households" ? "all_households" : "member_households";
  const distribution = distributionFromForm(form, roster, recipientScope === "all_households");
  if (!distribution) return c.html(<AdminPage ward={ward} account={account} title="部数を確かめてください"><h1>部数を確かめてください</h1><p>加入世帯に配る部数は名簿の世帯数までです。全戸に配るときは「全戸」を選んでください。</p><a class="button" href={adminPath(ward, `/publish/${projectId}/confirm?documentId=${draft.document_id}`)}>配る内容に戻る</a></AdminPage>, 400);
  const rain = draft.kind === "notice" && draft.title.includes("雨");
  const draftDue = draft.kind === "announcement" ? answerDeadlineFromDraft(draft.body, project.year) : null;
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
    else lineNotice = "公式LINEの準備ができていません。区のページに載せて、紙を配れます。";
  } catch { lineNotice = "公式LINEの人数を読み取れませんでした。配ったあとに結果を知らせます。"; }
  const copies = publicScope ? distribution.targets.reduce((sum, target) => sum + target.copies, 0) : 0;
  const sendLabel = draft.published_at ? "配り直す" : "配る";
  const tablesPreview = spaceTables ? <><h3>当番</h3><MaterialsTable table="duties" items={spaceTables} /><h3>配置図</h3><MaterialsTable table="layout" items={spaceTables} /><h3>実行委員名簿</h3><MaterialsTable table="committee" items={spaceTables} /></> : null;
  const printHref = adminPath(ward, `/print/${projectId}/${draft.document_id}/${draft.version_no}/preview`);
  const editHref = adminPath(ward, `/projects/${projectId}/draft/${draft.kind}`);
  c.header("Cache-Control", "no-store");
  return c.html(<AdminPage ward={ward} account={account} title="配る内容を見る" back={{ href: editHref, label: "下書きへ" }}>
    <div class="publish-confirm"><h1>{draft.published_at ? "次の内容で配り直します" : "次の内容で配ります"}</h1><p class="lead">まだ配っていません。読んで、よければ「{sendLabel}」を押してください。{publicScope ? "LINEで送った知らせは取り消せません。" : ""}</p>
    {pastDue ? <Notice>本文の締切は過ぎているため、このまま配ると答えの受付が続きますが、締切は配ったあとに変えられます。</Notice> : null}
    {documentBodyCheckMessage(c.req.query("check_body")) ? <Notice>{documentBodyCheckMessage(c.req.query("check_body"))}</Notice> : null}
    <dl class="facts"><dt>{publicScope ? "区のページ" : "実行委員と班長のページ"}</dt><dd>載ります</dd>{publicScope ? <><dt>公式LINE</dt><dd>{lineDelivery === "skip" ? "今回は公式LINEに送りません。" : lineNotice || (friends === null ? "題とページを送ります" : `友だち${friends}人に届きます`)}</dd></> : null}{!rain ? <><dt>紙</dt><dd>{copies ? `${copies}部を印刷できます` : "印刷して配れます"}</dd></> : null}</dl>
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
        {canSendLine(draft.kind) ? <fieldset><legend>公式LINE</legend><div class="choice"><label><input type="radio" name="lineDelivery" value="send" checked={lineDelivery === "send"} /> 題とページを送る</label><label><input type="radio" name="lineDelivery" value="skip" checked={lineDelivery === "skip"} /> 今回は送らない</label></div>{remaining !== null ? <p class="muted">送ったあと、今月はあと{Math.max(remaining - (friends ?? 0), 0)}通です。</p> : null}</fieldset> : <input type="hidden" name="lineDelivery" value="skip" />}
      </div></details> : <><input type="hidden" name="distribution" value={JSON.stringify({ mode: "district", targets: [] })} /><input type="hidden" name="lineDelivery" value={lineDelivery} /></>}
      {lineDelivery === "send" && remaining !== null && friends !== null && remaining < friends ? <Notice>今月、公式LINEで送れる通数が足りません。区のページに載せて、紙を配れます。</Notice> : null}
      {draft.published_at ? <Notice>配ったときから表が変わっています。ここに出ている今の表で配り直します。</Notice> : null}
      {draft.stale_since_version !== null ? <Notice>新しいものが入っています。ここに表示した内容で配れます。直すときは下書きに戻ってください。</Notice> : null}
      {warnings.filter((warning) => !warning.startsWith("まだ決まっていないところ")).map((warning) => <PublicWarning finding={warning} />)}
      {draft.body.includes(PENDING) ? <div class="notice warn"><strong>まだ決めていないところがあります</strong><p>「（確認中）」のところは、紙とページから外して配ります。入れるときは下書きを直してください。</p><a class="quiet" href={adminPath(ward, `/projects/${projectId}/draft/${draft.kind}`)}>下書きを直す</a></div> : null}
      <div class="compare"><section class="compare-paper"><b>紙{copies ? `（${recipientScope === "all_households" ? "全戸" : "加入世帯"}に${copies}部）` : ""}</b><div class="sheet-preview"><h2>{paperHeading(project.title, draft.title)}</h2><ArticleBody body={draft.body} title={{ project: project.title, document: draft.title }} kind={draft.kind} />{tablesPreview}{publicScope && draft.kind === "announcement" ? <p class="answer-slip-preview"><b>回答票</b>　切り取って班長か役員に渡します。代表者のお名前、人数、手伝いの欄があります。</p> : null}</div></section>
        <section><b>{publicScope ? "区のページ" : "実行委員と班長のページ"}</b><div class="sheet-preview"><h2>{paperHeading(project.title, draft.title)}</h2><ArticleBody body={draft.body} title={{ project: project.title, document: draft.title }} kind={draft.kind} />{tablesPreview}{publicScope && draft.kind === "announcement" ? <p class="muted">この下に「出欠を答える」のボタンが出ます。</p> : null}</div></section></div>
      <p class="compare-link"><a class="quiet" href={printHref}>紙の見え方を見る</a></p><p class="muted">{publicScope ? "配ったあとも、区のページからは下げられます。" : "実行委員と班長に配ります。区のページには載りません。"}</p>
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
  if (row.kind === "duty_roster") return adminResult(c, "当番表は公開せず、実行委員と班長のページに配ってください。", 400, { href: adminPath(c.var.ward, `/publish/${encodeURIComponent(c.req.param("projectId"))}`), label: "配る画面に戻る" }, "配る内容と配る相手を確かめて、もう一度操作してください。");
  if (!(DOCUMENT_KINDS as readonly string[]).includes(row.kind)) return adminResult(c, "文書の種類を確認できません。", 400, { href: adminPath(c.var.ward, `/publish/${encodeURIComponent(c.req.param("projectId"))}`), label: "配る画面に戻る" }, "配る内容と配る相手を確かめて、もう一度操作してください。");
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
  if (!distribution) return adminResult(c, "紙の配布先が名簿と合いません。配布内容を選び直してください。", 400, { href: adminPath(c.var.ward, `/publish/${encodeURIComponent(c.req.param("projectId"))}`), label: "配る画面に戻る" }, "配る内容と配る相手を確かめて、もう一度操作してください。");
  const draftDue = row.kind === "announcement" ? answerDeadlineFromDraft(row.body, project.year) : null;
  // 過ぎた日を受付の締切に入れると、配った途端に回答が閉じる。去年の中身の案でも起きるので入れない
  const answerDue = draftDue && draftDue >= new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()) ? draftDue : null;
  const answerLabels = await getAnswerLabels(c.env.DB, ward.wardId);
  const generalMeeting = project.kind === "general_meeting" && row.kind === "announcement";
  const note = generalMeeting ? { meetingNote: await meetingNote(c.env.DB, ward.wardId) } : {};
  let publishedBody = row.body;
  let parsed: unknown;
  try { parsed = JSON.parse(row.body); } catch { /* 文だけの古い下書きも配れる。 */ }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) publishedBody = JSON.stringify({ ...parsed, answerLabels, ...note });
  else if (generalMeeting) publishedBody = JSON.stringify({ text: articleParagraphs(row.body).join("\n\n"), items: [], answerLabels, ...note });
  const publication = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE document_versions SET body = ?, published_at = ?, published_by_account_id = ?, tables_snapshot = ${publicationTablesSql}
      WHERE ward_id = ? AND project_id = ? AND document_id = ? AND version_id = ? AND version_no = ?
        AND published_at IS NULL
        AND version_no = (SELECT MAX(v.version_no) FROM document_versions v WHERE v.ward_id = ? AND v.document_id = ?)
        AND EXISTS (SELECT 1 FROM projects p WHERE p.ward_id = ? AND p.project_id = ? AND p.closed_at IS NULL)
        AND EXISTS (SELECT 1 FROM documents d WHERE d.ward_id = ? AND d.document_id = ? AND d.scope = 'public')`)
      .bind(publishedBody, now, account.accountId, ward.wardId, projectId, ward.wardId, projectId, documentId, versionId, versionNo,
        ward.wardId, documentId, ward.wardId, projectId, ward.wardId, documentId),
    c.env.DB.prepare(`INSERT INTO publication_records
      (ward_id, publication_id, project_id, document_id, version_id, version_no, recipient_scope, distribution, line_status, published_at, published_by_account_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ? WHERE EXISTS (
        SELECT 1 FROM document_versions v WHERE v.ward_id = ? AND v.version_id = ? AND v.published_at = ? AND v.published_by_account_id = ?
      )`)
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
  if (publication[0]?.meta.changes !== 1 || publication[1]?.meta.changes !== 1) {
    return c.html(<AdminPage ward={ward} account={account} title="配る内容を確かめてください" back={{ href: adminPath(ward, `/publish/${projectId}`), label: "下書きに戻る" }}>
      <h1>配る内容を確かめてください</h1><p>下書きの内容が変わったか、すでに配っています。配る画面で内容を確かめてください。</p>
    </AdminPage>, 409);
  }
  await recordPublishedItems(c.env.DB, ward.wardId, projectId, versionId, account.accountId);
  if (row.kind === "announcement") await markDistributedTask(c.env.DB, ward.wardId, projectId, account.accountId, "announcement", versionId);
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
          lineError = allowance.friends === null ? "集計の済んだ友だちの人数を取得できないため、公式LINEには送っていません。区のページと紙は使えます。" : "今月、公式LINEで送れる通数が足りないため、送っていません。";
        } else {
          await sendLineTitleAndUrl(token, paperHeading(project.title, row.title), publicUrl);
          lineStatus = "sent";
          lineSentAt = nowIso();
        }
      }
    } catch {
      lineStatus = "failed";
      lineError = "公式LINEに送信できませんでした。接続設定を提供側に確認してください。";
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
export function articleParagraphs(body: string, title?: { project: string; document: string }, kind?: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(body) as unknown; } catch { parsed = body; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return collectText(parsed);
  const { text, items } = parsed as { text?: unknown; items?: unknown };
  if (typeof text !== "string" || !Array.isArray(items)) return collectText(parsed);
  const pending = withoutPending(text);
  const readable = title ? withoutTitleLine(pending, title.project, title.document) : pending;
  const paragraphs = readable.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  // 知らせは本文が正。変更前の場所を項目から足し戻すと、新旧が並ぶ。
  if (kind === "notice" && paragraphs.length) return paragraphs;
  const missing = items.flatMap((item: unknown) => {
    const { key, content } = (item ?? {}) as { key?: unknown; content?: unknown };
    if (typeof key !== "string" || typeof content !== "string" || content.trim() === PENDING || writtenInText(key, content, readable)) return [];
    return [`${isItemKey(key) ? ITEM_SCREEN_LABEL[key] : key}: ${content.trim()}`];
  });
  return [...paragraphs, ...(missing.length ? [missing.join("\n")] : [])];
}

export function ArticleBody({ body, title, kind }: { body: string; title?: { project: string; document: string }; kind?: string }) {
  return <div>{articleParagraphs(body, title, kind).map((text, index) => <p key={index} style="white-space:pre-wrap">{text}</p>)}</div>;
}

interface DistributionTarget { district: string; copies: number; household?: string; }
interface PaperDistribution { mode: "district" | "household"; targets: DistributionTarget[]; }

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
    "名簿の名前": { title: "名簿の名前と同じ文字があります", text: `「${value}」が本文にあります。だれでも読める案内に出てよければ、このまま配れます。` },
    "協賛の額": { title: "協賛の金額と同じ数字があります", text: `「${value}」が本文にあります。だれでも読める案内に出てよければ、このまま配れます。` },
    "個人の連絡先": { title: "個人の連絡先と思われる文字があります", text: `「${value}」が本文にあります。だれでも読める案内に出てよければ、このまま配れます。` },
    "まだ決まっていないところ": { title: "まだ決めていないところがあります", text: `「${value}」が本文にあります。このまま配れます。直すときは下書きに戻ってください。` },
  };
  const message = messages[kind] ?? { title: "本文を読み取れないところがあります", text: "下に出ている内容を読んで、このまま配れます。直すときは下書きに戻ってください。" };
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
