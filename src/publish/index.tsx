import { Hono } from "hono";
import { AdminPage } from "../core/admin-ui";
import { adminPath } from "../core/auth";
import type { Bundle } from "../core/bundle";
import { newId, nowIso } from "../core/ids";
import { Layout, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { getLineAllowance, lineAccessToken, sendLineTitleAndUrl } from "../line/api";
import { getPublicContact, getSquads } from "../settings/store";
import { checkPublicDraft } from "./check";

interface DraftRow {
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
  state_version: number;
  closed_at: string | null;
}

interface PublicationRow {
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

async function getProject(db: D1Database, wardId: string, projectId: string): Promise<ProjectRow | null> {
  return db.prepare(`SELECT project_id, title, state_version, closed_at FROM projects
    WHERE ward_id = ? AND project_id = ?`).bind(wardId, projectId).first<ProjectRow>();
}

async function getDrafts(db: D1Database, wardId: string, projectId: string): Promise<DraftRow[]> {
  const result = await db.prepare(`SELECT d.document_id, d.kind, d.title, d.scope, d.stale_since_version,
      v.version_id, v.version_no, v.body, v.based_on_state_version, v.published_at,
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

admin.get("/publish/:projectId", async (c) => {
  const { ward, account } = c.var;
  const projectId = c.req.param("projectId");
  const project = await getProject(c.env.DB, ward.wardId, projectId);
  if (!project) return c.notFound();
  const drafts = await getDrafts(c.env.DB, ward.wardId, projectId);
  const records = await c.env.DB.prepare(`SELECT publication_id, document_id, version_no, published_at, unpublished_at,
      line_status, line_recipients, line_sent_at, line_error, recipient_scope, distribution
    FROM publication_records WHERE ward_id = ? AND project_id = ? ORDER BY published_at DESC`)
    .bind(ward.wardId, projectId).all<PublicationRow>();
  let allowance = null;
  let allowanceError = "";
  try {
    allowance = await getLineAllowance(lineAccessToken(c.env));
  } catch {
    allowanceError = "公式 LINE の通数を読み取れません。配る操作後に送信結果を確認してください。";
  }
  c.header("Cache-Control", "no-store");
  return c.html(
    <AdminPage ward={ward} account={account} title="配る" back={{ href: adminPath(ward, "/projects"), label: "プロジェクト一覧へ" }}>
      <h1>{project.title} を配る</h1>
      {project.closed_at ? <Notice error>このプロジェクトは閉じています。</Notice> : null}
      {allowance ? <p>公式 LINE の友だち {allowance.friends ?? "確認中"} 人、今月の残り {allowance.remaining ?? "制限なし"} 通です。</p> : null}
      {allowanceError ? <Notice error>{allowanceError}</Notice> : null}
      {drafts.length === 0 ? <Notice>配れる案内はありません。案内の下書きを先に用意してください。</Notice> : null}
      {drafts.map((draft) => (
        <section class="panel" key={draft.document_id}>
          <h2>{draft.title}</h2>
          <p>案内 {draft.version_no}。{draft.published_at ? "すでに配っています。差し替える時は下の一覧から新しい案を開いてください。" : ""}</p>
          {draft.stale_since_version !== null || draft.based_on_state_version !== project.state_version
            ? <Notice error>新しい物が入っています。案を直すか、このまま配るか選んでください。</Notice>
            : null}
          <p><a href={adminPath(ward, `/publish/${projectId}/preview/${draft.document_id}/${draft.version_no}`)}>見た内容を確認する</a></p>
          {!project.closed_at ? <form method="post" action={adminPath(ward, `/publish/${projectId}/confirm`)}>
            <input type="hidden" name="documentId" value={draft.document_id} />
            <input type="hidden" name="versionId" value={draft.version_id} />
            <input type="hidden" name="versionNo" value={draft.version_no} />
            <label for={`recipient-${draft.document_id}`}>配布先</label>
            <select id={`recipient-${draft.document_id}`} name="recipientScope"><option value="member_households">加入世帯</option><option value="all_households">全戸</option></select>
            <label for={`copies-${draft.document_id}`}>班ごとの部数（班名と部数を一行ずつ）</label>
            <textarea id={`copies-${draft.document_id}`} name="distribution" rows={4} style="width:100%;font:inherit;padding:0.5rem" placeholder="部数は後から名簿の一覧とつなげられます。" />
            <p><button type="submit">配る内容を確認する</button></p>
          </form> : null}
        </section>
      ))}
      <h2>これまでに配った案内</h2>
      {records.results.length === 0 ? <p>まだ配っていません。</p> : records.results.map((record) => (
        <section class="panel" key={record.publication_id}>
          <p>{new Date(record.published_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}、案内 {record.version_no}</p>
          <p>配布先: {record.recipient_scope === "all_households" ? "全戸" : "加入世帯"}</p>
          <p>公式 LINE: {record.line_status === "sent" ? `${record.line_recipients ?? 0} 人に送信済み` : record.line_status === "failed" ? "送信できませんでした" : record.line_status === "not_configured" ? "接続設定なし" : "送信待ち"}</p>
          {record.line_error ? <p>{record.line_error}</p> : null}
          {record.unpublished_at ? <p>現在は公開を下げています。</p> : <form class="inline" method="post" action={adminPath(ward, `/publish/${projectId}/lower/${record.publication_id}`)}><button class="danger" type="submit">公開を下げる</button></form>}
          <p><a href={adminPath(ward, `/print/${projectId}/${record.document_id}/${record.version_no}`)}>印刷用ページを開く</a></p>
        </section>
      ))}
      <p><a href={`/${ward.slug}/p/${encodeURIComponent(projectId)}`}>区のページを見る</a></p>
    </AdminPage>,
  );
});

admin.get("/publish/:projectId/preview/:documentId/:versionNo", async (c) => {
  const { ward, account } = c.var;
  const row = await c.env.DB.prepare(`SELECT d.title, v.body, v.version_no FROM documents d
    JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    WHERE d.ward_id = ? AND d.project_id = ? AND d.document_id = ? AND v.version_no = ?`)
    .bind(ward.wardId, c.req.param("projectId"), c.req.param("documentId"), Number(c.req.param("versionNo")))
    .first<{ title: string; body: string; version_no: number }>();
  if (!row) return c.notFound();
  return c.html(<AdminPage ward={ward} account={account} title={row.title} back={{ href: adminPath(ward, `/publish/${c.req.param("projectId")}`), label: "配る画面へ戻る" }}>
    <h1>{row.title}</h1><ArticleBody body={row.body} />
    <form method="post" action={adminPath(ward, `/publish/${c.req.param("projectId")}/confirm`)}>
      <input type="hidden" name="documentId" value={c.req.param("documentId")} />
      <input type="hidden" name="versionNo" value={row.version_no} />
      <p>この内容を見た上で、公開と公式 LINE の送信に進みます。</p>
      <button type="submit">配る内容を確認する</button>
    </form>
  </AdminPage>);
});

admin.post("/publish/:projectId/confirm", async (c) => {
  const { ward, account } = c.var;
  const form = await c.req.parseBody();
  const documentId = typeof form.documentId === "string" ? form.documentId : "";
  const requestedVersionId = typeof form.versionId === "string" ? form.versionId : "";
  const requestedVersionNo = Number(form.versionNo);
  const project = await getProject(c.env.DB, ward.wardId, c.req.param("projectId"));
  if (!project || project.closed_at) return c.notFound();
  const draft = await c.env.DB.prepare(`SELECT d.title, d.scope, d.stale_since_version, v.version_id, v.version_no,
      v.body, v.based_on_state_version, v.published_at
    FROM documents d JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    WHERE d.ward_id = ? AND d.project_id = ? AND d.document_id = ? AND v.version_no = ?`)
    .bind(ward.wardId, project.project_id, documentId, requestedVersionNo)
    .first<DraftRow>();
  if (!draft || (requestedVersionId && requestedVersionId !== draft.version_id)) return c.notFound();
  if (draft.scope !== "public") return c.text("公開する案内は公開の範囲にしてください。", 400);
  const warnings = await checkPublicDraft(JSON.parse(draft.body) as unknown);
  if (warnings.length > 0) return c.text(warnings.join("\n"), 400);
  const distribution = typeof form.distribution === "string" ? form.distribution.slice(0, 5000) : "";
  const recipientScope = form.recipientScope === "all_households" ? "all_households" : "member_households";
  const contacts = await getPublicContact(c.env.DB, ward.wardId);
  let allowance = null;
  try { allowance = await getLineAllowance(lineAccessToken(c.env)); } catch { /* 送信結果として記録する */ }
  return c.html(<AdminPage ward={ward} account={account} title="配る内容の確認" back={{ href: adminPath(ward, `/publish/${project.project_id}`), label: "案に戻る" }}>
    <h1>配る内容の確認</h1>
    <ArticleBody body={draft.body} />
    <p>配ります。区のページに載り、{allowance?.friends === null || allowance === null ? "人数確認後" : `${allowance.friends} 人`}に届きます。</p>
    <p>紙の配布先: {recipientScope === "all_households" ? "全戸" : "加入世帯"}</p>
    <p>公開用の連絡先: {contacts || "未設定"}</p>
    <form method="post" action={adminPath(ward, `/publish/${project.project_id}/send`)}>
      <input type="hidden" name="documentId" value={documentId} />
      <input type="hidden" name="versionId" value={draft.version_id} />
      <input type="hidden" name="versionNo" value={draft.version_no} />
      <input type="hidden" name="stateVersion" value={project.state_version} />
      <input type="hidden" name="distribution" value={distribution} />
      <input type="hidden" name="recipientScope" value={typeof form.recipientScope === "string" ? form.recipientScope : "member_households"} />
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
  const row = await c.env.DB.prepare(`SELECT d.title, d.scope, d.stale_since_version, v.body, v.based_on_state_version,
      v.published_at FROM documents d JOIN document_versions v
      ON v.ward_id = d.ward_id AND v.document_id = d.document_id
      WHERE d.ward_id = ? AND d.project_id = ? AND d.document_id = ? AND v.version_id = ? AND v.version_no = ?`)
    .bind(ward.wardId, projectId, documentId, versionId, versionNo).first<DraftRow>();
  if (!row || row.scope !== "public" || row.published_at) return c.notFound();
  if (row.based_on_state_version !== project.state_version || row.stale_since_version !== null || Number(form.stateVersion) !== project.state_version) {
    return c.html(<AdminPage ward={ward} account={account} title="新しい物が入りました" back={{ href: adminPath(ward, `/publish/${projectId}`), label: "案に戻る" }}>
      <h1>新しい物が入りました</h1><p>案を直すか、このまま配るか選び直してください。</p>
    </AdminPage>, 409);
  }
  const warnings = await checkPublicDraft(JSON.parse(row.body) as unknown);
  if (warnings.length > 0) return c.text(warnings.join("\n"), 400);
  const now = nowIso();
  const publicationId = newId();
  const rawDistribution = typeof form.distribution === "string" ? form.distribution : "";
  const squads = await getSquads(c.env.DB, ward.wardId);
  const distribution = parseDistribution(rawDistribution, squads);
  const publication = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE document_versions SET published_at = ?, published_by_account_id = ?
      WHERE ward_id = ? AND project_id = ? AND document_id = ? AND version_id = ? AND version_no = ?
        AND published_at IS NULL AND based_on_state_version = ?
        AND EXISTS (SELECT 1 FROM projects p WHERE p.ward_id = ? AND p.project_id = ? AND p.state_version = ? AND p.closed_at IS NULL)
        AND EXISTS (SELECT 1 FROM documents d WHERE d.ward_id = ? AND d.document_id = ? AND d.stale_since_version IS NULL)`)
      .bind(now, account.accountId, ward.wardId, projectId, documentId, versionId, versionNo, project.state_version,
        ward.wardId, projectId, project.state_version, ward.wardId, documentId),
    c.env.DB.prepare(`INSERT INTO publication_records
      (ward_id, publication_id, project_id, document_id, version_id, version_no, recipient_scope, distribution, line_status, published_at, published_by_account_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ? WHERE EXISTS (
        SELECT 1 FROM document_versions v WHERE v.ward_id = ? AND v.version_id = ? AND v.published_at = ? AND v.published_by_account_id = ?
      )`)
      .bind(ward.wardId, publicationId, projectId, documentId, versionId, versionNo, recipientScope, JSON.stringify(distribution), now, account.accountId,
        ward.wardId, versionId, now, account.accountId),
  ]);
  if (publication[0]?.meta.changes !== 1 || publication[1]?.meta.changes !== 1) {
    return c.html(<AdminPage ward={ward} account={account} title="新しい物が入りました" back={{ href: adminPath(ward, `/publish/${projectId}`), label: "案に戻る" }}>
      <h1>新しい物が入りました</h1><p>案を直すか、もう一度内容を確認してください。</p>
    </AdminPage>, 409);
  }
  const publicUrl = `${(c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin).replace(/\/+$/, "")}/${ward.slug}/p/${encodeURIComponent(projectId)}`;
  let lineStatus: PublicationRow["line_status"] = "not_configured";
  let lineRecipients: number | null = null;
  let lineSentAt: string | null = null;
  let lineError: string | null = null;
  try {
    const allowance = await getLineAllowance(lineAccessToken(c.env));
    lineRecipients = allowance.friends;
    await sendLineTitleAndUrl(c.env.LINE_CHANNEL_ACCESS_TOKEN, row.title, publicUrl);
    lineStatus = "sent";
    lineSentAt = nowIso();
  } catch (error) {
    lineStatus = "failed";
    lineError = error instanceof Error ? error.message : "送信に失敗しました";
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

function parseDistribution(raw: string, squads: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
    const split = line.lastIndexOf(" ");
    const name = line.slice(0, split).trim();
    const count = Number(line.slice(split + 1).trim());
    if (split > 0 && squads.includes(name) && Number.isInteger(count) && count >= 0) counts[name] = count;
  }
  return counts;
}

export function ArticleBody({ body }: { body: string }) {
  let parsed: unknown;
  try { parsed = JSON.parse(body) as unknown; } catch { parsed = body; }
  const strings = collectText(parsed);
  return <div>{strings.map((text, index) => <p key={index}>{text}</p>)}</div>;
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
