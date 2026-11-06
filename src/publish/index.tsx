import { getAnswerLabels } from "../settings/answer-labels";
import { Hono } from "hono";
import { AdminPage } from "../core/admin-ui";
import { adminPath } from "../core/auth";
import type { Bundle } from "../core/bundle";
import { newId, nowIso } from "../core/ids";
import { Hint, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { getLineAllowance, lineAccessToken, LINE_NOT_CONFIGURED, sendLineTitleAndUrl } from "../line/api";
import { getPublicContact } from "../settings/store";
import { answerDeadlineFromDraft, getDistrictCopies, getRoster, parseDistribution } from "../answers/api";
import { checkPublicDraft } from "./check";
import { DOCUMENT_KINDS, DOCUMENT_KIND_LABEL, ITEM_LABEL, isItemKey, type DocumentKind } from "../project/model";
import { applyChange } from "../project/apply";
import { recordPublishedItems } from "../project/actions";
import { paperHeading } from "../project/heading";
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

interface DraftHistoryRow { document_id: string; version_no: number; body: string; created_at: string; }

function bodyLines(body: string): string[] {
  return articleParagraphs(body).flatMap((paragraph) => paragraph.split("\n")).map((line) => line.trim()).filter(Boolean);
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
          : typeof row.district === "string" && typeof row.copies === "number" ? `${row.district}（${row.copies} 部）` : "";
      }).filter(Boolean);
      // 名簿に同じ名前の世帯がある時は、一つにまとめて部数を添える。
      const counts = new Map<string, number>();
      for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
      return [...counts].map(([label, count]) => count > 1 ? `${label}（${count} 部）` : label).join("、") || "指定なし";
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return Object.entries(value as Record<string, unknown>).map(([district, copies]) => `${district}（${String(copies)} 部）`).join("、") || "指定なし";
    }
  } catch { /* 古い記録の形式は個別表示しない */ }
  return "指定なし";
}

async function getProject(db: D1Database, wardId: string, projectId: string): Promise<ProjectRow | null> {
  return db.prepare(`SELECT project_id, title, year, state_version, closed_at FROM projects
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
  const history = await c.env.DB.prepare(`SELECT document_id, version_no, body, created_at FROM document_versions
    WHERE ward_id = ? AND project_id = ? ORDER BY document_id, version_no`).bind(ward.wardId, projectId).all<DraftHistoryRow>();
  const historyByDocument = new Map<string, DraftHistoryRow[]>();
  for (const row of history.results) historyByDocument.set(row.document_id, [...(historyByDocument.get(row.document_id) ?? []), row]);
  const districtCopies = await getDistrictCopies(c.env.DB, ward.wardId);
  const roster = await getRoster(c.env.DB, ward.wardId);
  const records = await c.env.DB.prepare(`SELECT publication_id, document_id, version_no, published_at, unpublished_at,
      line_status, line_recipients, line_sent_at, line_error, recipient_scope, distribution,
      (SELECT tables_snapshot FROM document_versions v WHERE v.ward_id = publication_records.ward_id AND v.version_id = publication_records.version_id) AS tables_snapshot,
      (SELECT scope FROM document_versions v WHERE v.ward_id = publication_records.ward_id AND v.version_id = publication_records.version_id) AS scope
    FROM publication_records WHERE ward_id = ? AND project_id = ? ORDER BY published_at DESC, rowid DESC`)
    .bind(ward.wardId, projectId).all<PublicationRow>();
  // 空間の配布は公開用の記録に入れない。区のページは公開用の記録だけを読む。
  const spaceRecords = await c.env.DB.prepare(`SELECT v.version_id AS publication_id, v.document_id, v.version_no,
      v.published_at, NULL AS unpublished_at, 'not_sent' AS line_status, NULL AS line_recipients,
      NULL AS line_sent_at, NULL AS line_error, 'member_households' AS recipient_scope, '{}' AS distribution,
      v.tables_snapshot, v.scope
    FROM document_versions v WHERE v.ward_id = ? AND v.project_id = ? AND v.scope = 'space' AND v.published_at IS NOT NULL
    ORDER BY v.published_at DESC, v.rowid DESC`).bind(ward.wardId, projectId).all<PublicationRow>();
  const allRecords = [...records.results, ...spaceRecords.results].sort((a, b) => b.published_at.localeCompare(a.published_at) || b.version_no - a.version_no);
  const currentTables = await currentPublicationTables(c.env.DB, ward.wardId, projectId);
  const firstPublishedId = records.results.find((record) => !record.unpublished_at)?.publication_id;
  let allowance = null;
  let allowanceError = "";
  if (drafts.some((draft) => canSendLine(draft.kind))) try {
    const token = await lineAccessToken(c.env, ward.wardId);
    if (token) allowance = await getLineAllowance(token);
    else allowanceError = LINE_NOT_CONFIGURED;
  } catch {
    allowanceError = "公式 LINE の通数を読み取れません。配る操作後に送信結果を確認してください。";
  }
  c.header("Cache-Control", "no-store");
  return c.html(
    <AdminPage ward={ward} account={account} title="配る" back={{ href: adminPath(ward, "/projects"), label: "プロジェクト一覧へ" }}>
      <h1>{project.title} を配る <Hint text="案を選び、配る内容と相手を確認して区のページに載せます。まだ直す時は案の画面へ戻れます。" /></h1>
      {project.closed_at ? <Notice error>このプロジェクトは閉じています。</Notice> : null}
      {c.req.query("space") === "sent" ? <Notice>プロジェクトの空間に出しました。</Notice> : null}
      {allowance ? <p>公式 LINE の友だち {allowance.friends ?? "確認中"} 人、今月の残り {allowance.remaining ?? "制限なし"} 通です。</p> : null}
      {allowanceError ? <Notice error>{allowanceError}</Notice> : null}
      {drafts.length === 0 ? <Notice>配れる案内はありません。案内の下書きを先に用意してください。</Notice> : null}
      {drafts.map((draft) => {
        const previous = allRecords.find((record) => record.document_id === draft.document_id && !record.unpublished_at);
        const tablesChanged = draft.scope === "space" && (draft.kind === "duty_roster" || draft.kind === "procedure") &&
          (!!previous || !!draft.published_at) && publicationTablesDiffer(previous?.tables_snapshot ?? null, currentTables);
        return (
        <section class="panel" key={draft.document_id}>
          <h2>{draft.title}</h2>
          <p>{draft.published_at ? "すでに出しています。" : "まだ出していません。"}</p>
          {tablesChanged ? <Notice>{previous?.tables_snapshot === null
            ? "配った時の表の記録がありません。今の表を空間に配り直せます。"
            : "配った時から表が変わっています。今の表を空間に配り直せます。"}</Notice> : null}
          {draft.stale_since_version !== null
            ? <Notice error>新しい物が入っています。案を直すか、このまま配るか選んでください。</Notice>
            : null}
          <p><a href={adminPath(ward, `/publish/${projectId}/preview/${draft.document_id}/${draft.version_no}`)}>見た内容を確認する</a></p>
          {(historyByDocument.get(draft.document_id) ?? []).length > 1 ? <details><summary>これまでの案と前の案との違い</summary>{(historyByDocument.get(draft.document_id) ?? []).slice(0, -1).reverse().map((old, index, rows) => {
            const next = rows[index - 1] ?? draft;
            const before = bodyLines(old.body); const after = bodyLines(next.body);
            const removed = before.filter((line) => !after.includes(line)); const added = after.filter((line) => !before.includes(line));
            return <section><h3>作成 {new Date(old.created_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</h3><p>次の案に変わった所</p>{removed.length ? <p>前にあった内容: {removed.join(" / ")}</p> : null}{added.length ? <p>加わった内容: {added.join(" / ")}</p> : null}{!removed.length && !added.length ? <p>文章に違いはありません。</p> : null}</section>;
          })}</details> : null}
          {draft.scope === "space" ? <>
            <p>実行委員と班長に見せる物です。公開ページには出ません。</p>
            {!project.closed_at && (!draft.published_at || tablesChanged) ? <form method="post" action={adminPath(ward, `/publish/${projectId}/space`)}>
              <input type="hidden" name="documentId" value={draft.document_id} />
              <input type="hidden" name="versionId" value={draft.version_id} />
              <input type="hidden" name="versionNo" value={draft.version_no} />
              <button type="submit">{draft.published_at ? "空間に配り直す" : "空間に配る"}</button> <Hint text={`${DOCUMENT_KIND_LABEL[draft.kind as DocumentKind]}と、今の当番・配置・協賛先の表を実行委員と班長に配ります。配った後に表を直しても、次に配るまでは空間と紙は変わりません。`} />
            </form> : null}
          </> : null}
          {draft.scope === "public" && !project.closed_at ? <form method="post" action={adminPath(ward, `/publish/${projectId}/confirm`)}>
            <input type="hidden" name="documentId" value={draft.document_id} />
            <input type="hidden" name="versionId" value={draft.version_id} />
            <input type="hidden" name="versionNo" value={draft.version_no} />
            <input type="hidden" name="targetMode" value="district" />
            <label for={`recipients-${draft.document_id}`}>紙を配る相手</label>
            <select id={`recipients-${draft.document_id}`} name="recipientScope"><option value="member_households">加入世帯</option><option value="all_households">全戸（加入していない世帯も含む）</option></select>
            <Hint text="全戸を選ぶと、名簿にない世帯の分も含めて部数を入れられます。区で全戸に配る時に選んでください。" />
            <fieldset><legend>班ごとの部数</legend>{districtCopies.map((row, index) => <p>
              <label><input type="checkbox" name="district" value={row.district} checked /> {row.district}（名簿 {row.copies} 世帯）</label>
              部数 <input type="number" name={`copies_${index}`} min="1" value={row.copies} style="width:6rem" />
            </p>)}</fieldset>
            {roster.length === 0 ? <p><label>全戸に配る時の部数 <input type="number" name="allCopies" min="1" style="width:6rem" /></label></p> : null}
            <details><summary>世帯を選ぶ</summary><p>加入世帯の一部に配る時は、世帯に印を付けてください。全戸に配る時は、上の班ごとの部数を使います。</p>{householdChoices(roster).map(({ district, household, count }) => <label>
              <input type="checkbox" name="household" value={JSON.stringify([district, household])} /> {district} / {household}{count > 1 ? `（名簿に同じ名前が ${count} 世帯あり、${count} 部）` : ""}
            </label>)}</details>
            <p>紙の部数と配る相手の指定は、公開ページに表示されません。</p>
            {canSendLine(draft.kind) ? <>
              <label for={`line-${draft.document_id}`}>公式 LINE</label>
              <select id={`line-${draft.document_id}`} name="lineDelivery"><option value="send">題と URL を送る</option><option value="skip">今回は送らない</option></select>
            </> : <p>公式 LINE には送らず、区のページに載せます。</p>}
            <p><button type="submit">配る内容を確認する</button> <Hint text={`${DOCUMENT_KIND_LABEL[draft.kind as DocumentKind]}の本文と配る相手を確認する画面を開くだけで、まだ配りません。`} /></p>
          </form> : null}
        </section>
      ); })}
      <h2>これまでに配った物</h2>
      {allRecords.length === 0 ? <p>まだ配っていません。</p> : allRecords.map((record) => (
        <section class="panel" key={record.publication_id}>
          <p>{new Date(record.published_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}に配りました。</p>
          {record.scope === "space" ? <p>実行委員と班長に配りました。</p> : <>
          <p>紙の配布先: {paperTargetLabel(record.distribution)}</p>
          <p>配る相手: {record.recipient_scope === "all_households" ? "全戸" : "加入世帯"}</p>
          <p>公式 LINE: {record.line_status === "sent" ? `${record.line_recipients ?? 0} 人に送信済み` : record.line_status === "failed" ? "送信できませんでした" : record.line_status === "not_sent" ? "今回は送っていません" : record.line_status === "not_configured" ? "接続設定なし" : "送信待ち"}</p>
          {record.line_error ? <p>{record.line_error}</p> : null}
          {record.unpublished_at ? <p>現在は公開を下げています。</p> : <form class="inline" method="post" action={adminPath(ward, `/publish/${projectId}/lower/${record.publication_id}`)}><button class="danger" type="submit">公開を下げる</button> {record.publication_id === firstPublishedId ? <Hint text="配った記録を残したまま、この案内を区のページから下げます。" /> : null}</form>}
          </>}
          <p><a href={adminPath(ward, `/print/${projectId}/${record.document_id}/${record.version_no}`)}>印刷用ページを開く</a></p>
        </section>
      ))}
      <p><a href={`/${ward.slug}/p/${encodeURIComponent(projectId)}`}>区のページを見る</a></p>
    </AdminPage>,
  );
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
  if (!row || row.scope !== "space" || !["duty_roster", "procedure"].includes(row.kind)) return c.notFound();
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
  if (result.meta.changes !== 1) return c.text("案の内容が変わったか、すでに配っています。配る画面で内容を確かめてください。", 409);
  await recordPublishedItems(c.env.DB, ward.wardId, projectId, publishedVersionId, account.accountId);
  if (row.kind === "duty_roster") await markDistributedTask(c.env.DB, ward.wardId, projectId, account.accountId, "duty_roster", publishedVersionId);
  return c.redirect(adminPath(ward, `/publish/${projectId}?space=sent`), 303);
});

admin.get("/publish/:projectId/preview/:documentId/:versionNo", async (c) => {
  const { ward, account } = c.var;
  const row = await c.env.DB.prepare(`SELECT COALESCE(v.title, d.title) AS title, d.scope, v.body, v.version_no FROM documents d
    JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    WHERE d.ward_id = ? AND d.project_id = ? AND d.document_id = ? AND v.version_no = ?`)
    .bind(ward.wardId, c.req.param("projectId"), c.req.param("documentId"), Number(c.req.param("versionNo")))
    .first<{ title: string; scope: string; body: string; version_no: number }>();
  if (!row) return c.notFound();
  return c.html(<AdminPage ward={ward} account={account} title={row.title} back={{ href: adminPath(ward, `/publish/${c.req.param("projectId")}`), label: "配る画面へ戻る" }}>
    <h1>{row.title} <Hint text="配る前の案を読む画面です。ここでは区のページには載りません。" /></h1><ArticleBody body={row.body} />
    <p><a href={adminPath(ward, `/print/${c.req.param("projectId")}/${c.req.param("documentId")}/${row.version_no}/preview`)}>印刷用ページで見る</a></p>
    <p>見せるだけの確認用ページです。配る操作をするまで、出した内容にはなりません。</p>
    {row.scope === "public" ? <p>配る相手と紙の部数は、配る画面から選んでください。</p> : <p>この物は実行委員と班長に配る内容です。</p>}
  </AdminPage>);
});

admin.post("/publish/:projectId/confirm", async (c) => {
  const { ward, account } = c.var;
  const form = await c.req.formData();
  const documentId = String(form.get("documentId") ?? "");
  const requestedVersionId = String(form.get("versionId") ?? "");
  const requestedVersionNo = Number(form.get("versionNo"));
  const project = await getProject(c.env.DB, ward.wardId, c.req.param("projectId"));
  if (!project || project.closed_at) return c.notFound();
  const draft = await c.env.DB.prepare(`SELECT d.kind, COALESCE(v.title, d.title) AS title, d.scope, d.stale_since_version, v.version_id, v.version_no,
      v.body, v.based_on_state_version, v.published_at
    FROM documents d JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    WHERE d.ward_id = ? AND d.project_id = ? AND d.document_id = ? AND v.version_no = ?`)
    .bind(ward.wardId, project.project_id, documentId, requestedVersionNo)
    .first<DraftRow>();
  if (!draft || (requestedVersionId && requestedVersionId !== draft.version_id)) return c.notFound();
  if (draft.scope !== "public") return c.text("公開する案内は公開の範囲にしてください。", 400);
  if (draft.kind === "duty_roster") return c.text("当番表は公開せず、プロジェクトの空間に配ってください。", 400);
  if (!(DOCUMENT_KINDS as readonly string[]).includes(draft.kind)) return c.text("文書の種類を確認できません。", 400);
  const warnings = await checkPublicDraft(c.env.DB, ward.wardId, project.project_id, draft.kind as DocumentKind, draft.body);
  const roster = await getRoster(c.env.DB, ward.wardId);
  const recipientScope = form.get("recipientScope") === "all_households" ? "all_households" : "member_households";
  const targetMode = form.get("targetMode");
  let distribution: PaperDistribution | null;
  if (targetMode === null) {
    const districts = [...new Set(roster.map((entry) => entry.district))];
    const legacy = parseDistribution(String(form.get("distribution") ?? ""), districts);
    distribution = { mode: "district", targets: Object.entries(legacy).map(([district, copies]) => ({ district, copies })) };
  } else {
    const selectedDistricts = new Set(form.getAll("district").map(String));
    const selectedHouseholds = new Set(form.getAll("household").map(String));
    // 世帯に印があれば、選びの欄が班のままでも世帯に配る。印を黙って捨てて全ての班に配らないため。
    distribution = buildDistribution(roster, recipientScope === "all_households" ? "district" : selectedHouseholds.size > 0 ? "household" : String(targetMode), selectedDistricts, selectedHouseholds,
      (index) => Number(form.get(`copies_${index}`)), recipientScope === "all_households");
  }
  // 名簿は入れなくても動く。無い区は部数の割り振りなしで配る。
  if (roster.length === 0) distribution = recipientScope === "all_households" && form.get("allCopies")
    ? allHouseholdCopies(Number(form.get("allCopies"))) : { mode: "district", targets: [] };
  if (!distribution) return c.text("配る班と部数を確かめてください。加入世帯に配る部数は名簿の世帯数までです。全戸に配る時は「全戸」を選んでください。", 400);
  const lineDelivery = !canSendLine(draft.kind) || form.get("lineDelivery") === "skip" ? "skip" : "send";
  const contacts = await getPublicContact(c.env.DB, ward.wardId);
  let allowance = null;
  let lineNotice = "";
  if (lineDelivery === "send") try {
    const token = await lineAccessToken(c.env, ward.wardId);
    if (token) allowance = await getLineAllowance(token);
    else lineNotice = LINE_NOT_CONFIGURED;
  } catch { /* 送信結果として記録する */ }
  return c.html(<AdminPage ward={ward} account={account} title="配る内容の確認" back={{ href: adminPath(ward, `/publish/${project.project_id}`), label: "案に戻る" }}>
    <h1>配る内容の確認 <Hint text="本文と配る相手を読んでから「配る」を押すと、区のページに載ります。公式 LINE に送るかどうかも確認してください。" /></h1>
    <ArticleBody body={draft.body} />
    {draft.stale_since_version !== null ? <Notice>新しい物が入っています。ここに表示した内容で配れます。直す時は案に戻ってください。</Notice> : null}
    {warnings.length > 0 ? <section class="panel"><h2>混入の検査で見つかった所</h2><p>公開する前に内容を確認してください。配る操作は続けられます。</p><ul>{warnings.map((warning) => <li>{warning}</li>)}</ul></section> : null}
    <p>配ります。区のページに載ります。{lineDelivery === "skip" ? "今回は公式 LINE に送りません。" : lineNotice || `公式 LINE は${allowance?.friends === null || allowance === null ? "人数確認後" : `${allowance.friends} 人`}に届きます。`}</p>
    {distribution.targets.length ? <p>紙の配布先: {paperTargetLabel(JSON.stringify(distribution))}</p> : <p>名簿が無いため、紙の配布先と部数は指定していません。</p>}
    <p>配る相手: {recipientScope === "all_households" ? "全戸" : "加入世帯"}</p>
    <p>公開用の連絡先: {contacts || "未設定"}</p>
    <form method="post" action={adminPath(ward, `/publish/${project.project_id}/send`)}>
      <input type="hidden" name="documentId" value={documentId} />
      <input type="hidden" name="versionId" value={draft.version_id} />
      <input type="hidden" name="versionNo" value={draft.version_no} />
      <input type="hidden" name="distribution" value={JSON.stringify(distribution)} />
      <input type="hidden" name="recipientScope" value={recipientScope} />
      <input type="hidden" name="lineDelivery" value={lineDelivery} />
      <button type="submit">配る</button>
    </form>
  </AdminPage>);
});

admin.post("/publish/:projectId/send", async (c) => {
  const { ward, account } = c.var;
  const form = await c.req.parseBody();
  const projectId = c.req.param("projectId");
  const project = await getProject(c.env.DB, ward.wardId, projectId);
  const documentId = typeof form.documentId === "string" ? form.documentId : "";
  const versionId = typeof form.versionId === "string" ? form.versionId : "";
  const versionNo = Number(form.versionNo);
  const recipientScope = form.recipientScope === "all_households" ? "all_households" : "member_households";
  if (!project || project.closed_at) return c.notFound();
  const row = await c.env.DB.prepare(`SELECT d.kind, COALESCE(v.title, d.title) AS title, d.scope, d.stale_since_version, v.body, v.based_on_state_version,
      v.published_at FROM documents d JOIN document_versions v
      ON v.ward_id = d.ward_id AND v.document_id = d.document_id
      WHERE d.ward_id = ? AND d.project_id = ? AND d.document_id = ? AND v.version_id = ? AND v.version_no = ?`)
    .bind(ward.wardId, projectId, documentId, versionId, versionNo).first<DraftRow>();
  if (!row || row.scope !== "public" || row.published_at) return c.notFound();
  if (row.kind === "duty_roster") return c.text("当番表は公開せず、プロジェクトの空間に配ってください。", 400);
  if (!(DOCUMENT_KINDS as readonly string[]).includes(row.kind)) return c.text("文書の種類を確認できません。", 400);
  const now = nowIso();
  const publicationId = newId();
  const roster = await getRoster(c.env.DB, ward.wardId);
  const rawDistribution = typeof form.distribution === "string" ? form.distribution : "";
  let distribution: PaperDistribution | null = roster.length === 0 && recipientScope !== "all_households"
    ? { mode: "district", targets: [] } : validateDistribution(rawDistribution, roster, recipientScope === "all_households");
  if (!distribution && !rawDistribution.trim().startsWith("{")) {
    const districts = [...new Set(roster.map((entry) => entry.district))];
    const legacy = parseDistribution(rawDistribution, districts);
    distribution = { mode: "district", targets: Object.entries(legacy).map(([district, copies]) => ({ district, copies })) };
  }
  if (!distribution) return c.text("紙の配布先が名簿と合いません。配布内容を選び直してください。", 400);
  const draftDue = row.kind === "announcement" ? answerDeadlineFromDraft(row.body, project.year) : null;
  // 過ぎた日を受付の締切に入れると、配った途端に回答が閉じる。去年の中身の案でも起きるので入れない
  const answerDue = draftDue && draftDue >= new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()) ? draftDue : null;
  const answerLabels = await getAnswerLabels(c.env.DB, ward.wardId);
  let publishedBody = row.body;
  try {
    const parsed: unknown = JSON.parse(row.body);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) publishedBody = JSON.stringify({ ...parsed, answerLabels });
  } catch { /* 本文が文だけの古い下書きはそのまま残す。 */ }
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
    return c.html(<AdminPage ward={ward} account={account} title="配る内容を確かめてください" back={{ href: adminPath(ward, `/publish/${projectId}`), label: "案に戻る" }}>
      <h1>配る内容を確かめてください</h1><p>案の内容が変わったか、すでに配っています。配る画面で内容を確かめてください。</p>
    </AdminPage>, 409);
  }
  await recordPublishedItems(c.env.DB, ward.wardId, projectId, versionId, account.accountId);
  if (row.kind === "announcement") await markDistributedTask(c.env.DB, ward.wardId, projectId, account.accountId, "announcement", versionId);
  const publicUrl = `${(c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin).replace(/\/+$/, "")}/${ward.slug}/p/${encodeURIComponent(projectId)}`;
  const sendLine = canSendLine(row.kind) && form.lineDelivery !== "skip";
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
        await sendLineTitleAndUrl(token, paperHeading(project.title, row.title), publicUrl);
        lineStatus = "sent";
        lineSentAt = nowIso();
      }
    } catch {
      lineStatus = "failed";
      lineError = "公式 LINE に送信できませんでした。接続設定を提供側に確認してください。";
    }
  }
  await c.env.DB.prepare(`UPDATE publication_records SET line_status = ?, line_recipients = ?, line_sent_at = ?, line_error = ?
    WHERE ward_id = ? AND publication_id = ?`).bind(lineStatus, lineRecipients, lineSentAt, lineError, ward.wardId, publicationId).run();
  return c.redirect(adminPath(ward, `/publish/${projectId}?done=${publicationId}`), 303);
});

admin.post("/publish/:projectId/lower/:publicationId", async (c) => {
  const { ward } = c.var;
  await c.env.DB.prepare(`UPDATE publication_records SET unpublished_at = ?
    WHERE ward_id = ? AND project_id = ? AND publication_id = ? AND unpublished_at IS NULL`)
    .bind(nowIso(), ward.wardId, c.req.param("projectId"), c.req.param("publicationId")).run();
  return c.redirect(adminPath(ward, `/publish/${c.req.param("projectId")}`), 303);
});

/** 読む人に見せる段落。文を正とし、項目は文に書かれていない物だけ見出しを付けて足す。 */
export function articleParagraphs(body: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(body) as unknown; } catch { parsed = body; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return collectText(parsed);
  const { text, items } = parsed as { text?: unknown; items?: unknown };
  if (typeof text !== "string" || !Array.isArray(items)) return collectText(parsed);
  const paragraphs = text.replace(/\r\n/g, "\n").split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const missing = items.flatMap((item: unknown) => {
    const { key, content } = (item ?? {}) as { key?: unknown; content?: unknown };
    if (typeof key !== "string" || typeof content !== "string" || !content.trim() || text.includes(content.trim().slice(0, 10))) return [];
    return [`${isItemKey(key) ? ITEM_LABEL[key] : key}: ${content.trim()}`];
  });
  return [...paragraphs, ...(missing.length ? [missing.join("\n")] : [])];
}

export function ArticleBody({ body }: { body: string }) {
  return <div>{articleParagraphs(body).map((text, index) => <p key={index} style="white-space:pre-wrap">{text}</p>)}</div>;
}

interface DistributionTarget { district: string; copies: number; household?: string; }
interface PaperDistribution { mode: "district" | "household"; targets: DistributionTarget[]; }

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
