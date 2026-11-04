import { newId, nowIso } from "../core/ids";
import { applyChange } from "./apply";
import { DEFAULT_SCOPE, DOCUMENT_KIND_LABEL, isItemKey, isTableKey, type DocumentKind, type Scope, type ItemKey } from "./model";

export async function renameProject(db: D1Database, wardId: string, projectId: string, title: string): Promise<boolean> {
  const value = title.trim();
  if (!value || value.length > 100) return false;
  const r = await db.prepare("UPDATE projects SET title = ?, state_version = state_version + 1 WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL")
    .bind(value, wardId, projectId).run();
  return (r.meta.changes ?? 0) > 0;
}

export async function answerQuestion(db: D1Database, wardId: string, projectId: string, questionId: string, action: "answer" | "unknown" | "later", answer: string, accountId: string): Promise<boolean> {
  const state = action === "answer" ? "answered" : action;
  const value = answer.trim().slice(0, 2000);
  if (action === "answer" && !value) return false;
  if (action === "answer") {
    const question = await db.prepare("SELECT kind, target, detail FROM project_questions WHERE ward_id = ? AND project_id = ? AND question_id = ? AND state IN ('open', 'later')")
      .bind(wardId, projectId, questionId).first<{ kind: string; target: string | null; detail: string | null }>();
    if (question?.kind === "decide" && question.target && isItemKey(question.target)) {
      const result = await applyChange(db, wardId, projectId, { kind: "item", itemKey: question.target, value,
        source: { kind: "person", accountId }, confidence: "high", packVersion: "person-answer@1", requestId: questionId });
      if (result.status === "rejected" || result.status === "dropped") return false;
    }
    if (question?.kind === "conflict" && question.detail) {
      let detail: { itemKey?: string; options?: string[]; table?: string; rowId?: string; field?: string; values?: Array<string | number> };
      try { detail = JSON.parse(question.detail) as typeof detail; } catch { return false; }
      const options = detail.options ?? [];
      const index = options.indexOf(value);
      if (index < 0) return false;
      const source = { kind: "person" as const, accountId };
      if (detail.itemKey && isItemKey(detail.itemKey) && options[index] !== undefined) {
        const result = await applyChange(db, wardId, projectId, { kind: "item", itemKey: detail.itemKey as ItemKey, value,
          source, confidence: "high", packVersion: "person-conflict@1", requestId: questionId });
        if (result.status === "rejected" || result.status === "dropped") return false;
      } else if (detail.table && isTableKey(detail.table) && detail.rowId && detail.field && detail.values?.[index] !== undefined) {
        const row = await db.prepare("SELECT data FROM project_rows WHERE ward_id = ? AND project_id = ? AND row_id = ? AND removed_at IS NULL")
          .bind(wardId, projectId, detail.rowId).first<{ data: string }>();
        if (!row) return false;
        const data = JSON.parse(row.data) as Record<string, string | number>;
        data[detail.field] = detail.values[index] as string | number;
        const result = await applyChange(db, wardId, projectId, { kind: "row", table: detail.table, data,
          source, confidence: "high", packVersion: "person-conflict@1", requestId: questionId });
        if (result.status === "rejected" || result.status === "dropped") return false;
      }
    }
  }
  const r = await db.prepare(`UPDATE project_questions SET state = ?, answer = ?, answered_at = ?, answered_by_account_id = ?
    WHERE ward_id = ? AND project_id = ? AND question_id = ? AND state IN ('open', 'later')`)
    .bind(state, action === "answer" ? value : null, nowIso(), accountId, wardId, projectId, questionId).run();
  return (r.meta.changes ?? 0) > 0;
}

export async function addMapTask(db: D1Database, wardId: string, projectId: string, name: string): Promise<boolean> {
  const value = name.trim();
  if (!value || value.length > 100) return false;
  const project = await db.prepare("SELECT closed_at FROM projects WHERE ward_id = ? AND project_id = ?").bind(wardId, projectId).first<{ closed_at: string | null }>();
  if (!project || project.closed_at) return false;
  const order = await db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM project_map_tasks WHERE ward_id = ? AND project_id = ?")
    .bind(wardId, projectId).first<{ n: number }>();
  await db.prepare("INSERT INTO project_map_tasks (task_id, ward_id, project_id, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(newId(), wardId, projectId, value, order?.n ?? 0, nowIso()).run();
  return true;
}

export async function removeMapTask(db: D1Database, wardId: string, projectId: string, taskId: string): Promise<boolean> {
  const r = await db.prepare("UPDATE project_map_tasks SET removed_at = ? WHERE ward_id = ? AND project_id = ? AND task_id = ? AND removed_at IS NULL")
    .bind(nowIso(), wardId, projectId, taskId).run();
  return (r.meta.changes ?? 0) > 0;
}

export async function setMapTask(db: D1Database, wardId: string, projectId: string, taskId: string, input: { name: string; start: string; end: string; progress: "open" | "started" | "done"; seatId: string | null }): Promise<boolean> {
  const name = input.name.trim();
  if (!name || name.length > 100 || !["open", "started", "done"].includes(input.progress)) return false;
  const date = (s: string) => s === "" || /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!date(input.start) || !date(input.end)) return false;
  if (input.seatId && !(await db.prepare("SELECT 1 AS ok FROM seats WHERE ward_id = ? AND seat_id = ? AND removed_at IS NULL").bind(wardId, input.seatId).first())) return false;
  const r = await db.prepare(`UPDATE project_map_tasks SET name = ?, period_start = ?, period_end = ?, progress = ?, seat_id = ?,
    progress_source_kind = 'person', progress_source_ref = NULL, progress_source_locator = NULL, progress_confidence = 'high'
    WHERE ward_id = ? AND project_id = ? AND task_id = ? AND removed_at IS NULL`)
    .bind(name, input.start || null, input.end || null, input.progress, input.seatId, wardId, projectId, taskId).run();
  return (r.meta.changes ?? 0) > 0;
}

export interface EditableDocument { documentId: string; kind: DocumentKind; title: string; scope: Scope; versionId: string | null; body: string; stateVersion: number; stale: boolean; }
export async function getEditableDocument(db: D1Database, wardId: string, projectId: string, kind: DocumentKind): Promise<EditableDocument | null> {
  const row = await db.prepare(`SELECT d.document_id, d.kind, d.title, d.scope, d.stale_since_version, p.state_version,
      v.version_id, v.body FROM documents d JOIN projects p ON p.ward_id = d.ward_id AND p.project_id = d.project_id
      LEFT JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
      AND v.version_no = (SELECT MAX(v2.version_no) FROM document_versions v2 WHERE v2.ward_id = d.ward_id AND v2.document_id = d.document_id)
      WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = ?`)
    .bind(wardId, projectId, kind).first<{ document_id: string; kind: DocumentKind; title: string; scope: Scope; stale_since_version: number | null; state_version: number; version_id: string | null; body: string | null }>();
  return row ? { documentId: row.document_id, kind: row.kind, title: row.title, scope: row.scope, versionId: row.version_id,
    body: row.body ?? JSON.stringify({ text: "", items: [] }), stateVersion: row.state_version, stale: row.stale_since_version !== null } : null;
}

export async function saveDocument(db: D1Database, wardId: string, projectId: string, accountId: string, input: { kind: DocumentKind; title: string; scope: Scope; body: string; basedOn: number }): Promise<boolean> {
  if (!["announcement", "recruitment", "duty_roster", "procedure", "notice", "report"].includes(input.kind)) return false;
  if (!["public", "space", "staff"].includes(input.scope) || input.title.trim().length < 1 || input.title.length > 100 || input.body.length > 20000) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(input.body); } catch { return false; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed as { text?: unknown; items?: unknown };
  if (typeof record.text !== "string" || !Array.isArray(record.items)) return false;
  const items: { key: ItemKey; content: string }[] = [];
  for (const x of record.items) {
    if (typeof x !== "object" || x === null || typeof (x as { key?: unknown }).key !== "string" || typeof (x as { content?: unknown }).content !== "string") return false;
    const item = x as { key: string; content: string };
    if (!isItemKey(item.key) || item.content.length > 2000) return false;
    items.push({ key: item.key, content: item.content });
  }
  const project = await db.prepare("SELECT state_version, closed_at FROM projects WHERE ward_id = ? AND project_id = ?").bind(wardId, projectId).first<{ state_version: number; closed_at: string | null }>();
  if (!project || project.closed_at || !Number.isInteger(input.basedOn) || input.basedOn < 0 || input.basedOn > project.state_version) return false;
  const wasCurrent = project.state_version === input.basedOn;
  let doc = await db.prepare("SELECT document_id FROM documents WHERE ward_id = ? AND project_id = ? AND kind = ?").bind(wardId, projectId, input.kind).first<{ document_id: string }>();
  const now = nowIso();
  if (!doc) {
    const id = newId();
    await db.prepare("INSERT INTO documents (document_id, ward_id, project_id, kind, title, scope) VALUES (?, ?, ?, ?, ?, ?)").bind(id, wardId, projectId, input.kind, input.title.trim(), input.scope).run();
    doc = { document_id: id };
  } else {
    await db.prepare("UPDATE documents SET title = ?, scope = ? WHERE ward_id = ? AND project_id = ? AND document_id = ?").bind(input.title.trim(), input.scope, wardId, projectId, doc.document_id).run();
  }
  const currentProject = await db.prepare("SELECT state_version FROM projects WHERE ward_id = ? AND project_id = ?").bind(wardId, projectId).first<{ state_version: number }>();
  const latest = await db.prepare("SELECT COALESCE(MAX(version_no), 0) AS n FROM document_versions WHERE ward_id = ? AND project_id = ? AND document_id = ?").bind(wardId, projectId, doc.document_id).first<{ n: number }>();
  const versionId = newId();
  const statements: D1PreparedStatement[] = [db.prepare(`INSERT INTO document_versions
    (version_id, ward_id, project_id, document_id, version_no, scope, body, based_on_state_version, origin, created_at, created_by_account_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'person', ?, ?)`).bind(versionId, wardId, projectId, doc.document_id, (latest?.n ?? 0) + 1, input.scope, JSON.stringify({ text: record.text, items }), wasCurrent ? currentProject?.state_version ?? input.basedOn : input.basedOn, now, accountId)];
  for (const item of items) {
    const change = await applyChange(db, wardId, projectId, { kind: "item", itemKey: item.key, value: item.content,
      source: { kind: "person", accountId }, confidence: "high", packVersion: "person-edit@1", requestId: versionId });
    if (change.status === "rejected") return false;
  }
  await db.batch(statements);
  if (wasCurrent) await db.prepare("UPDATE documents SET stale_since_version = NULL WHERE ward_id = ? AND project_id = ? AND document_id = ?").bind(wardId, projectId, doc.document_id).run();
  return true;
}

export async function getLatestDocumentBody(db: D1Database, wardId: string, documentId: string): Promise<string | null> {
  const row = await db.prepare(`SELECT body FROM document_versions WHERE ward_id = ? AND document_id = ? ORDER BY version_no DESC LIMIT 1`).bind(wardId, documentId).first<{ body: string }>();
  return row?.body ?? null;
}

export async function saveAIDraft(db: D1Database, wardId: string, projectId: string, kind: DocumentKind, packVersion: string, raw: unknown): Promise<boolean> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const data = raw as { text?: unknown; items?: unknown; scope?: unknown; title?: unknown; based_on_state_version?: unknown };
  if (typeof data.text !== "string" || data.text.length > 20000 || (data.items !== undefined && !Array.isArray(data.items))) return false;
  const items: { key: ItemKey; content: string; source?: string }[] = [];
  for (const entry of (data.items ?? []) as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const item = entry as { key?: unknown; content?: unknown; source?: unknown };
    if (typeof item.key !== "string" || !isItemKey(item.key) || typeof item.content !== "string" || item.content.length > 2000) return false;
    items.push({ key: item.key, content: item.content, ...(typeof item.source === "string" ? { source: item.source.slice(0, 500) } : {}) });
  }
  const scope: Scope = data.scope === "public" || data.scope === "space" || data.scope === "staff" ? data.scope : DEFAULT_SCOPE[kind];
  const title = typeof data.title === "string" && data.title.trim() ? data.title.trim().slice(0, 100) : DOCUMENT_KIND_LABEL[kind];
  const project = await db.prepare("SELECT state_version, closed_at FROM projects WHERE ward_id = ? AND project_id = ?").bind(wardId, projectId).first<{ state_version: number; closed_at: string | null }>();
  if (!project || project.closed_at) return false;
  const basedOn = typeof data.based_on_state_version === "number" && Number.isInteger(data.based_on_state_version) && data.based_on_state_version >= 0 && data.based_on_state_version <= project.state_version
    ? data.based_on_state_version
    : project.state_version;
  let document = await db.prepare("SELECT document_id FROM documents WHERE ward_id = ? AND project_id = ? AND kind = ?").bind(wardId, projectId, kind).first<{ document_id: string }>();
  if (!document) {
    const documentId = newId();
    await db.prepare("INSERT INTO documents (document_id, ward_id, project_id, kind, title, scope) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(documentId, wardId, projectId, kind, title, scope).run();
    document = { document_id: documentId };
  } else {
    await db.prepare("UPDATE documents SET title = ?, scope = ?, stale_since_version = CASE WHEN ? < ? THEN COALESCE(stale_since_version, ?) ELSE NULL END WHERE ward_id = ? AND project_id = ? AND document_id = ?")
      .bind(title, scope, basedOn, project.state_version, project.state_version, wardId, projectId, document.document_id).run();
  }
  if (basedOn < project.state_version) await db.prepare("UPDATE documents SET stale_since_version = COALESCE(stale_since_version, ?) WHERE ward_id = ? AND project_id = ? AND document_id = ?")
    .bind(project.state_version, wardId, projectId, document.document_id).run();
  const latest = await db.prepare("SELECT COALESCE(MAX(version_no), 0) AS n FROM document_versions WHERE ward_id = ? AND project_id = ? AND document_id = ?")
    .bind(wardId, projectId, document.document_id).first<{ n: number }>();
  await db.prepare(`INSERT INTO document_versions (version_id, ward_id, project_id, document_id, version_no, scope, body,
    based_on_state_version, origin, pack_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?)`)
    .bind(newId(), wardId, projectId, document.document_id, (latest?.n ?? 0) + 1, scope, JSON.stringify({ text: data.text, items }), basedOn, packVersion, nowIso()).run();
  return true;
}
