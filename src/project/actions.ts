import { newId, nowIso } from "../core/ids";
import { applyChange } from "./apply";
import { DEFAULT_SCOPE, DOCUMENT_KIND_LABEL, TABLES, cleanRowData, isItemKey, isTableKey, rowMatchKey, type DocumentKind, type Scope, type ItemKey, type RowData } from "./model";
import { hashOf, stableStringify } from "./util";
import { getProjectState } from "./state";
import { reconcileDocumentBody, type DocumentBody } from "./document-body";
import { addDays, MAP_TEMPLATES } from "../map/template";

/** 当番表の行を役員が画面で直す。行の鍵を変えても同じ行を保ち、変更履歴と古い案の印を残す。 */
export async function saveDutyRow(
  db: D1Database, wardId: string, projectId: string, rowId: string, accountId: string, raw: unknown,
): Promise<boolean> {
  const cleaned = cleanRowData("duties", raw);
  if (!cleaned.ok) return false;
  const [project, existing, freshDocuments] = await Promise.all([
    db.prepare("SELECT state_version, closed_at FROM projects WHERE ward_id = ? AND project_id = ?")
      .bind(wardId, projectId).first<{ state_version: number; closed_at: string | null }>(),
    db.prepare("SELECT data FROM project_rows WHERE ward_id = ? AND project_id = ? AND row_id = ? AND table_key = 'duties' AND scope = 'current' AND removed_at IS NULL")
      .bind(wardId, projectId, rowId).first<{ data: string }>(),
    db.prepare(`SELECT kind FROM documents WHERE ward_id = ? AND project_id = ?
      AND kind IN ('duty_roster', 'procedure', 'report') AND stale_since_version IS NULL`)
      .bind(wardId, projectId).all<{ kind: string }>(),
  ]);
  if (!project || project.closed_at || !existing) return false;
  let before: RowData;
  try { before = JSON.parse(existing.data) as RowData; } catch { return false; }
  if (stableStringify(before) === stableStringify(cleaned.data)) return true;
  const matchKey = rowMatchKey("duties", cleaned.data);
  const duplicate = await db.prepare(`SELECT 1 AS found FROM project_rows
    WHERE ward_id = ? AND project_id = ? AND table_key = 'duties' AND scope = 'current' AND match_key = ? AND row_id <> ? AND removed_at IS NULL`)
    .bind(wardId, projectId, matchKey, rowId).first();
  if (duplicate) return false;

  const changeId = newId();
  const requestId = newId();
  const source = { kind: "person", accountId };
  const change = { kind: "row", table: "duties", data: cleaned.data, source, confidence: "high", packVersion: "duty-roster-edit@1", requestId };
  const payload = stableStringify(change);
  const payloadHash = await hashOf(change);
  const now = nowIso();
  const nextStateVersion = project.state_version + 1;
  const dedupeKey = `manual-duty:${changeId}`;
  const staleKinds = freshDocuments.results.map((row) => row.kind);
  const result = JSON.stringify({ status: "applied", changeId, staleDocuments: staleKinds, questionIds: [] });
  const statements = [
    db.prepare(`INSERT INTO project_changes (change_id, ward_id, project_id, kind, target, status, dedupe_key, payload_hash,
      payload, result, pack_version, source_kind, source_ref, confidence, state_version_after, created_at, created_by_account_id)
      SELECT ?, ?, ?, 'row', ?, 'applied', ?, ?, ?, ?, 'duty-roster-edit@1', 'person', ?, 'high', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND state_version = ? AND closed_at IS NULL)`)
      .bind(changeId, wardId, projectId, `duties:${matchKey}`, dedupeKey, payloadHash, payload, result, `person:${requestId}`,
        nextStateVersion, now, accountId, wardId, projectId, project.state_version),
    db.prepare(`UPDATE project_rows SET match_key = ?, data = ?, person_fields = ?, source_kind = 'person', source_ref = ?,
      source_locator = NULL, source_year = NULL, confidence = 'high', change_id = ?, updated_at = ?
      WHERE ward_id = ? AND project_id = ? AND row_id = ? AND table_key = 'duties' AND scope = 'current' AND removed_at IS NULL
        AND EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND state_version = ? AND closed_at IS NULL)`)
      .bind(matchKey, stableStringify(cleaned.data), stableStringify(Object.keys(cleaned.data).sort()), `person:${requestId}`, changeId, now,
        wardId, projectId, rowId, wardId, projectId, project.state_version),
    db.prepare(`UPDATE projects SET state_version = ? WHERE ward_id = ? AND project_id = ? AND state_version = ? AND closed_at IS NULL`)
      .bind(nextStateVersion, wardId, projectId, project.state_version),
  ];
  if (staleKinds.length) {
    const marks = staleKinds.map(() => "?").join(",");
    statements.push(db.prepare(`UPDATE documents SET stale_since_version = ?
      WHERE ward_id = ? AND project_id = ? AND kind IN (${marks}) AND stale_since_version IS NULL
        AND EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND state_version = ?)`)
      .bind(nextStateVersion, wardId, projectId, ...staleKinds, wardId, projectId, nextStateVersion));
  }
  try {
    const results = await db.batch(statements);
    return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1 && results[2]?.meta.changes === 1;
  } catch { return false; }
}

export async function renameProject(db: D1Database, wardId: string, projectId: string, title: string): Promise<boolean> {
  const value = title.trim();
  if (!value || value.length > 100) return false;
  const r = await db.prepare("UPDATE projects SET title = ?, state_version = state_version + 1 WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL")
    .bind(value, wardId, projectId).run();
  return (r.meta.changes ?? 0) > 0;
}

export async function answerQuestion(db: D1Database, wardId: string, projectId: string, questionId: string, action: "answer" | "unknown" | "later", answer: string, accountId: string): Promise<boolean> {
  const project = await db.prepare("SELECT closed_at FROM projects WHERE ward_id = ? AND project_id = ?").bind(wardId, projectId).first<{ closed_at: string | null }>();
  if (!project || project.closed_at) return false;
  const state = action === "answer" ? "answered" : action;
  const value = answer.trim().slice(0, 2000);
  if (action === "answer" && !value) return false;
  const linked = await db.prepare(`SELECT c.clarification_id, c.batch_id FROM line_clarifications c JOIN jobs j ON j.ward_id = c.ward_id AND j.job_id = c.job_id
    WHERE c.ward_id = ? AND j.project_id = ? AND c.question_id = ? AND j.withdrawn_at IS NULL`).bind(wardId, projectId, questionId)
    .first<{ clarification_id: string; batch_id: string }>();
  if (linked) {
    const result = await db.prepare(`UPDATE project_questions SET state = ?, answer = ?, answered_at = ?, answered_by_account_id = ?
      WHERE ward_id = ? AND project_id = ? AND question_id = ? AND state IN ('open', 'later')`)
      .bind(state, action === "answer" ? value : null, nowIso(), accountId, wardId, projectId, questionId).run();
    if (!result.meta.changes) return false;
    if (action !== "later") await db.batch([
      db.prepare("UPDATE line_clarifications SET answer = ?, answered_unknown = ? WHERE ward_id = ? AND clarification_id = ?")
        .bind(action === "unknown" ? "分からない" : value, action === "unknown" ? 1 : 0, wardId, linked.clarification_id),
      db.prepare("UPDATE line_photo_batches SET screen_answered_at = ?, answer_reply_token = NULL, answer_reply_at = NULL WHERE ward_id = ? AND batch_id = ?")
        .bind(nowIso(), wardId, linked.batch_id),
    ]);
    return true;
  }
  if (action === "answer") {
    const question = await db.prepare("SELECT kind, text, target, detail FROM project_questions WHERE ward_id = ? AND project_id = ? AND question_id = ? AND state IN ('open', 'later')")
      .bind(wardId, projectId, questionId).first<{ kind: string; text: string; target: string | null; detail: string | null }>();
    let applied = false;
    if (question?.kind === "decide" && question.target && isItemKey(question.target)) {
      const result = await applyChange(db, wardId, projectId, { kind: "item", itemKey: question.target, value,
        source: { kind: "person", accountId }, confidence: "high", packVersion: "person-answer@1", requestId: questionId });
      if (result.status === "rejected" || result.status === "dropped") return false;
      applied = true;
    }
    if (question?.kind === "conflict" && question.detail) {
      let detail: { itemKey?: string; options?: string[]; table?: string; rowId?: string; field?: string; values?: Array<string | number>; candidateRowIds?: string[]; changeId?: string };
      try { detail = JSON.parse(question.detail) as typeof detail; } catch { return false; }
      const options = detail.options ?? [];
      const index = options.indexOf(value);
      if (index < 0) return false;
      const source = { kind: "person" as const, accountId };
      if (detail.changeId && detail.candidateRowIds && detail.table && isTableKey(detail.table)) {
        // 照合が曖昧で保留した行を、答えのとおりに入れる。同じ相手なら相手の鍵に揃えて更新し、別の相手なら足す
        const held = await db.prepare("SELECT payload FROM project_changes WHERE ward_id = ? AND project_id = ? AND change_id = ?")
          .bind(wardId, projectId, detail.changeId).first<{ payload: string }>();
        const heldData = held ? (JSON.parse(held.payload) as { data?: Record<string, string | number> }).data : undefined;
        if (!heldData) return false;
        const sameRowId = detail.candidateRowIds[index];
        const sameRow = sameRowId ? await db.prepare("SELECT data FROM project_rows WHERE ward_id = ? AND project_id = ? AND row_id = ? AND removed_at IS NULL")
          .bind(wardId, projectId, sameRowId).first<{ data: string }>() : null;
        const def = TABLES[detail.table];
        const keys = sameRow ? Object.fromEntries(Object.entries(JSON.parse(sameRow.data) as Record<string, string | number>)
          .filter(([name]) => [...def.keyFields, ...(def.optionalKeyFields ?? [])].includes(name))) : {};
        const result = await applyChange(db, wardId, projectId, { kind: "row", table: detail.table, data: { ...heldData, ...keys },
          source, confidence: "high", packVersion: "person-conflict@1", requestId: questionId });
        if (result.status === "rejected" || result.status === "dropped") return false;
        applied = true;
      } else if (detail.itemKey && isItemKey(detail.itemKey) && options[index] !== undefined) {
        const result = await applyChange(db, wardId, projectId, { kind: "item", itemKey: detail.itemKey as ItemKey, value,
          source, confidence: "high", packVersion: "person-conflict@1", requestId: questionId });
        if (result.status === "rejected" || result.status === "dropped") return false;
        applied = true;
      } else if (detail.table && isTableKey(detail.table) && detail.rowId && detail.field && detail.values?.[index] !== undefined) {
        const row = await db.prepare("SELECT data FROM project_rows WHERE ward_id = ? AND project_id = ? AND row_id = ? AND removed_at IS NULL")
          .bind(wardId, projectId, detail.rowId).first<{ data: string }>();
        if (!row) return false;
        const data = JSON.parse(row.data) as Record<string, string | number>;
        data[detail.field] = detail.values[index] as string | number;
        const result = await applyChange(db, wardId, projectId, { kind: "row", table: detail.table, data,
          source, confidence: "high", packVersion: "person-conflict@1", requestId: questionId });
        if (result.status === "rejected" || result.status === "dropped") return false;
        applied = true;
      }
    }
    if (question && !applied) {
      // どの中身にも当たらない答えも、決めたこととして記録に残す（前提 4、12）
      const result = await applyChange(db, wardId, projectId, { kind: "row", table: "decisions",
        data: { what: `${question.text.slice(0, 160)} → ${value.slice(0, 200)}`, decidedOn: nowIso().slice(0, 10) },
        source: { kind: "person", accountId }, confidence: "high", packVersion: "person-answer@1", requestId: questionId });
      if (result.status === "rejected") return false;
    }
    // 質問の答えは、すでにある案内の下書きにも入れる。配った内容は残し、新しい下書きとして保存する。
    if (applied && isItemKey(question?.target)) {
      const [current, draft] = await Promise.all([
        getProjectState(db, wardId, projectId), getEditableDocument(db, wardId, projectId, "announcement"),
      ]);
      const itemKey = question.target;
      const content = current?.items.find((item) => item.key === itemKey)?.current?.content;
      if (current && draft && content !== undefined) {
        const before = JSON.parse(draft.body) as DocumentBody;
        const next = reconcileDocumentBody(before, { text: before.text,
          items: [...before.items.filter((item) => item.key !== itemKey), { key: itemKey, content }],
        });
        if (stableStringify(before) !== stableStringify(next) && !(await saveDocument(db, wardId, projectId, accountId, {
          kind: "announcement", title: draft.title, scope: draft.scope, body: JSON.stringify(next), basedOn: current.project.stateVersion,
        }))) return false;
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

/** 行事の日を直し、済んでいない仕事だけ時期を置き直す。文書には触れない。 */
export async function setEventDay(db: D1Database, wardId: string, projectId: string, day: string, accountId: string): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) return false;
  const state = await getProjectState(db, wardId, projectId);
  if (!state || state.project.closedAt) return false;
  const oldDay = state.project.deadlines.event_day;
  if (oldDay === day) return true;
  const shift = oldDay ? Math.round((Date.parse(day) - Date.parse(oldDay)) / 86400000) : 0;
  const template = MAP_TEMPLATES[state.project.kind] ?? [];
  const statements = [db.prepare(`INSERT INTO project_deadlines (ward_id, project_id, kind, due_on, updated_at, updated_by_account_id)
    VALUES (?, ?, 'event_day', ?, ?, ?)
    ON CONFLICT (ward_id, project_id, kind) DO UPDATE SET due_on = excluded.due_on,
      updated_at = excluded.updated_at, updated_by_account_id = excluded.updated_by_account_id`)
    .bind(wardId, projectId, day, nowIso(), accountId)];
  for (const task of state.mapTasks) {
    if (task.progress === "done") continue;
    const offsets = template.find((entry) => entry.key === task.taskKey);
    const start = oldDay ? task.periodStart ? addDays(task.periodStart, shift) : null : offsets ? addDays(day, offsets.start) : task.periodStart;
    const end = oldDay ? task.periodEnd ? addDays(task.periodEnd, shift) : null : offsets ? addDays(day, offsets.end) : task.periodEnd;
    statements.push(db.prepare(`UPDATE project_map_tasks SET period_start = ?, period_end = ?
      WHERE ward_id = ? AND project_id = ? AND task_id = ? AND progress <> 'done' AND removed_at IS NULL`)
      .bind(start, end, wardId, projectId, task.taskId));
  }
  await db.batch(statements);
  return true;
}

export async function removeMapTask(db: D1Database, wardId: string, projectId: string, taskId: string): Promise<boolean> {
  const r = await db.prepare("UPDATE project_map_tasks SET removed_at = ? WHERE ward_id = ? AND project_id = ? AND task_id = ? AND removed_at IS NULL")
    .bind(nowIso(), wardId, projectId, taskId).run();
  return (r.meta.changes ?? 0) > 0;
}

export async function restoreMapTask(db: D1Database, wardId: string, projectId: string, taskId: string): Promise<boolean> {
  const result = await db.prepare(`UPDATE project_map_tasks SET removed_at = NULL
    WHERE ward_id = ? AND project_id = ? AND task_id = ? AND removed_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL)`)
    .bind(wardId, projectId, taskId, wardId, projectId).run();
  return result.meta.changes === 1;
}

export async function setMapTask(db: D1Database, wardId: string, projectId: string, taskId: string, input: { name: string; start: string; end: string; progress: "open" | "started" | "done"; seatId: string | null }): Promise<boolean> {
  const name = input.name.trim();
  if (!name || name.length > 100 || !["open", "started", "done"].includes(input.progress)) return false;
  const date = (s: string) => s === "" || /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!date(input.start) || !date(input.end)) return false;
  if (input.seatId && !(await db.prepare("SELECT 1 AS ok FROM seats WHERE ward_id = ? AND seat_id = ? AND removed_at IS NULL").bind(wardId, input.seatId).first())) return false;
  const r = await db.prepare(`UPDATE project_map_tasks SET name = ?, period_start = ?, period_end = ?, progress = ?, seat_id = ?,
    progress_source_kind = 'person', progress_source_ref = NULL, progress_source_locator = NULL, progress_confidence = 'high', progress_change_id = NULL
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

export async function saveDocument(db: D1Database, wardId: string, projectId: string, accountId: string, input: { kind: DocumentKind; title: string; scope: Scope; body: string; basedOn: number }, bodyChecks?: ItemKey[]): Promise<boolean> {
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
  const previous = await getEditableDocument(db, wardId, projectId, input.kind);
  const state = previous ? null : await getProjectState(db, wardId, projectId);
  const before: DocumentBody = previous ? JSON.parse(previous.body) as DocumentBody : {
    text: "", items: (state?.items ?? []).map((item) => ({ key: item.key, content: item.current?.content ?? item.references[0]?.content ?? "" })),
  };
  const body = reconcileDocumentBody(before, { text: record.text, items }, bodyChecks);
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
    (version_id, ward_id, project_id, document_id, version_no, scope, body, title, based_on_state_version, origin, created_at, created_by_account_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'person', ?, ?)`).bind(versionId, wardId, projectId, doc.document_id, (latest?.n ?? 0) + 1, input.scope, JSON.stringify(body), input.title.trim(), wasCurrent ? currentProject?.state_version ?? input.basedOn : input.basedOn, now, accountId)];
  for (const item of body.items) {
    if (!item.content.trim() || before.items.find((entry) => entry.key === item.key)?.content === item.content) continue;
    const change = await applyChange(db, wardId, projectId, { kind: "item", itemKey: item.key, value: item.content,
      source: { kind: "person", accountId }, confidence: "high", packVersion: "person-edit@1", requestId: versionId });
    if (change.status === "rejected") return false;
  }
  await db.batch(statements);
  if (wasCurrent) await db.prepare("UPDATE documents SET stale_since_version = NULL WHERE ward_id = ? AND project_id = ? AND document_id = ?").bind(wardId, projectId, doc.document_id).run();
  return true;
}

/** 配った操作に記録を付ける。既に今年の中身があれば変えず、記録の失敗で配布を止めない。 */
export async function recordPublishedItems(db: D1Database, wardId: string, projectId: string, versionId: string, accountId: string): Promise<void> {
  try {
    const version = await db.prepare(`SELECT document_id, body FROM document_versions
      WHERE ward_id = ? AND project_id = ? AND version_id = ? AND published_at IS NOT NULL`)
      .bind(wardId, projectId, versionId).first<{ document_id: string; body: string }>();
    if (!version) return;
    const body = JSON.parse(version.body) as DocumentBody;
    for (const item of body.items) {
      if (!isItemKey(item.key) || !item.content.trim()) continue;
      const current = await db.prepare(`SELECT 1 AS found FROM project_item_values
        WHERE ward_id = ? AND project_id = ? AND item_key = ? AND scope = 'current' AND superseded_at IS NULL`)
        .bind(wardId, projectId, item.key).first();
      if (current) continue;
      await applyChange(db, wardId, projectId, {
        kind: "item", itemKey: item.key, value: item.content,
        source: { kind: "person", accountId, ref: versionId, locator: "配る操作" },
        confidence: "high", packVersion: "publish-items@1", requestId: versionId,
      }, { publishedDocumentId: version.document_id });
    }
  } catch {
    console.error("配った中身を今年の記録に残せませんでした");
  }
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
  await db.prepare(`INSERT INTO document_versions (version_id, ward_id, project_id, document_id, version_no, scope, body, title,
    based_on_state_version, origin, pack_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?)`)
    .bind(newId(), wardId, projectId, document.document_id, (latest?.n ?? 0) + 1, scope, JSON.stringify({ text: data.text, items }), title, basedOn, packVersion, nowIso()).run();
  return true;
}
