import { newId, nowIso } from "../core/ids";
import { answerOriginalReference, applyChange } from "./apply";
import { reconcileAnsweredFact } from "../know/apply";
import { DOCUMENT_KINDS, DOCUMENT_KIND_LABEL, ITEM_LABEL, ITEM_SCREEN_LABEL, TABLES, cleanRowData, isItemKey, isTableKey, rowMatchKey, type DocumentKind, type ProjectKind, type Scope, type ItemKey, type RowData } from "./model";
import { hashOf, stableStringify } from "./util";
import { eventDayStatements, getProjectState } from "./state";
import { isCalendarDay, parseEventDay } from "../core/time";
import { reconcileDocumentBody, type DocumentBody } from "./document-body";
import { getDraftPack } from "../draft/packs";

type MaterialTable = "duties" | "committee";
const materialPack = (table: MaterialTable) => (table === "duties" ? "duty-roster-edit@1" : "committee-edit@1");
/** 変更の記録の reason に入れる印。資料から変わったところの言葉を分ける。 */
export const ROW_REMOVED = "removed";

async function loadMaterialRow(db: D1Database, wardId: string, projectId: string, rowId: string, table: MaterialTable) {
  const [project, existing, freshDocuments] = await Promise.all([
    db.prepare("SELECT state_version, closed_at FROM projects WHERE ward_id = ? AND project_id = ?")
      .bind(wardId, projectId).first<{ state_version: number; closed_at: string | null }>(),
    db.prepare(`SELECT data, match_key FROM project_rows WHERE ward_id = ? AND project_id = ? AND row_id = ? AND table_key = '${table}' AND scope = 'current' AND removed_at IS NULL`)
      .bind(wardId, projectId, rowId).first<{ data: string; match_key: string }>(),
    db.prepare(`SELECT kind FROM documents WHERE ward_id = ? AND project_id = ?
      AND kind IN ('duty_roster', 'procedure', 'report') AND stale_since_version IS NULL`)
      .bind(wardId, projectId).all<{ kind: string }>(),
  ]);
  if (!project || project.closed_at || !existing) return null;
  let before: RowData;
  try { before = JSON.parse(existing.data) as RowData; } catch { return null; }
  return { project, before, matchKey: existing.match_key, staleKinds: freshDocuments.results.map((row) => row.kind) };
}

/** 行の変更と、変更履歴と、古い案の印を一度に書く。行の鍵を変えても同じ行を保つ。 */
async function commitMaterialRow(db: D1Database, wardId: string, projectId: string, accountId: string, input: {
  table: MaterialTable; data: RowData; matchKey: string; reason: string | null; stateVersion: number; staleKinds: string[];
  writeRow: (ids: { changeId: string; requestId: string; now: string }) => D1PreparedStatement;
}): Promise<boolean> {
  const { table, data, matchKey, reason, stateVersion, staleKinds } = input;
  const packVersion = materialPack(table);
  const changeId = newId();
  const requestId = newId();
  const source = { kind: "person", accountId };
  const change = { kind: "row", table, data, source, confidence: "high", packVersion, requestId, ...(reason ? { reason } : {}) };
  const payload = stableStringify(change);
  const payloadHash = await hashOf(change);
  const now = nowIso();
  const nextStateVersion = stateVersion + 1;
  const dedupeKey = `manual-${table}:${changeId}`;
  const result = JSON.stringify({ status: "applied", changeId, staleDocuments: staleKinds, questionIds: [] });
  const statements = [
    db.prepare(`INSERT INTO project_changes (change_id, ward_id, project_id, kind, target, status, reason, dedupe_key, payload_hash,
      payload, result, pack_version, source_kind, source_ref, confidence, state_version_after, created_at, created_by_account_id)
      SELECT ?, ?, ?, 'row', ?, 'applied', ?, ?, ?, ?, ?, '${packVersion}', 'person', ?, 'high', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND state_version = ? AND closed_at IS NULL)`)
      .bind(changeId, wardId, projectId, `${table}:${matchKey}`, reason, dedupeKey, payloadHash, payload, result, `person:${requestId}`,
        nextStateVersion, now, accountId, wardId, projectId, stateVersion),
    input.writeRow({ changeId, requestId, now }),
    db.prepare(`UPDATE projects SET state_version = ? WHERE ward_id = ? AND project_id = ? AND state_version = ? AND closed_at IS NULL`)
      .bind(nextStateVersion, wardId, projectId, stateVersion),
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

/** 配る資料の行を役員が画面で直す。行の鍵を変えても同じ行を保ち、変更履歴と古い案の印を残す。 */
async function saveMaterialRow(
  db: D1Database, wardId: string, projectId: string, rowId: string, accountId: string, raw: unknown, table: MaterialTable,
): Promise<boolean> {
  const cleaned = cleanRowData(table, raw);
  if (!cleaned.ok) return false;
  const loaded = await loadMaterialRow(db, wardId, projectId, rowId, table);
  if (!loaded) return false;
  if (stableStringify(loaded.before) === stableStringify(cleaned.data)) return true;
  const matchKey = rowMatchKey(table, cleaned.data);
  const duplicate = await db.prepare(`SELECT 1 AS found FROM project_rows
    WHERE ward_id = ? AND project_id = ? AND table_key = '${table}' AND scope = 'current' AND match_key = ? AND row_id <> ? AND removed_at IS NULL`)
    .bind(wardId, projectId, matchKey, rowId).first();
  if (duplicate) return false;
  const stateVersion = loaded.project.state_version;
  return commitMaterialRow(db, wardId, projectId, accountId, {
    table, data: cleaned.data, matchKey, reason: null, stateVersion, staleKinds: loaded.staleKinds,
    writeRow: ({ changeId, requestId, now }) => db.prepare(`UPDATE project_rows SET match_key = ?, data = ?, person_fields = ?, source_kind = 'person', source_ref = ?,
      source_locator = NULL, source_year = NULL, confidence = 'high', change_id = ?, updated_at = ?
      WHERE ward_id = ? AND project_id = ? AND row_id = ? AND table_key = '${table}' AND scope = 'current' AND removed_at IS NULL
        AND EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND state_version = ? AND closed_at IS NULL)`)
      .bind(matchKey, stableStringify(cleaned.data), stableStringify(Object.keys(cleaned.data).sort()), `person:${requestId}`, changeId, now,
        wardId, projectId, rowId, wardId, projectId, stateVersion),
  });
}

/** 役員が名簿に一人足す。同じ名前と役の人がいる時は足さない。変更履歴は人の入力として残る。 */
export async function addCommitteeRow(db: D1Database, wardId: string, projectId: string, accountId: string, raw: unknown): Promise<boolean> {
  const cleaned = cleanRowData("committee", raw);
  if (!cleaned.ok) return false;
  const [project, duplicate] = await Promise.all([
    db.prepare("SELECT closed_at FROM projects WHERE ward_id = ? AND project_id = ?").bind(wardId, projectId).first<{ closed_at: string | null }>(),
    db.prepare("SELECT 1 AS found FROM project_rows WHERE ward_id = ? AND project_id = ? AND table_key = 'committee' AND scope = 'current' AND match_key = ? AND removed_at IS NULL")
      .bind(wardId, projectId, rowMatchKey("committee", cleaned.data)).first(),
  ]);
  if (!project || project.closed_at || duplicate) return false;
  const result = await applyChange(db, wardId, projectId, {
    kind: "row", table: "committee", data: cleaned.data, source: { kind: "person", accountId }, confidence: "high", packVersion: materialPack("committee"),
  }, { actorAccountId: accountId });
  return result.status === "applied";
}

/** 役員が名簿から一人外す。行は消さず、外した人と変更履歴を残す。 */
export async function removeCommitteeRow(db: D1Database, wardId: string, projectId: string, rowId: string, accountId: string): Promise<boolean> {
  const loaded = await loadMaterialRow(db, wardId, projectId, rowId, "committee");
  if (!loaded) return false;
  const stateVersion = loaded.project.state_version;
  return commitMaterialRow(db, wardId, projectId, accountId, {
    table: "committee", data: loaded.before, matchKey: loaded.matchKey, reason: ROW_REMOVED, stateVersion, staleKinds: loaded.staleKinds,
    writeRow: ({ changeId, now }) => db.prepare(`UPDATE project_rows SET removed_at = ?, removed_by_account_id = ?, change_id = ?, updated_at = ?
      WHERE ward_id = ? AND project_id = ? AND row_id = ? AND table_key = 'committee' AND scope = 'current' AND removed_at IS NULL
        AND EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND state_version = ? AND closed_at IS NULL)`)
      .bind(now, accountId, changeId, now, wardId, projectId, rowId, wardId, projectId, stateVersion),
  });
}

export function saveDutyRow(db: D1Database, wardId: string, projectId: string, rowId: string, accountId: string, raw: unknown) {
  return saveMaterialRow(db, wardId, projectId, rowId, accountId, raw, "duties");
}

export function saveCommitteeRow(db: D1Database, wardId: string, projectId: string, rowId: string, accountId: string, raw: unknown) {
  return saveMaterialRow(db, wardId, projectId, rowId, accountId, raw, "committee");
}

export async function renameProject(db: D1Database, wardId: string, projectId: string, title: string): Promise<boolean> {
  const value = title.trim();
  if (!value || value.length > 100) return false;
  const results = await db.batch([
    // 古い配布記録や写しには題が無い。名前を変える前の題を一度だけ残す。
    db.prepare(`UPDATE document_versions SET project_title = (SELECT title FROM projects WHERE ward_id = ? AND project_id = ?)
      WHERE ward_id = ? AND project_id = ? AND published_at IS NOT NULL AND project_title IS NULL
        AND EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL)`)
      .bind(wardId, projectId, wardId, projectId, wardId, projectId),
    db.prepare("UPDATE projects SET title = ?, state_version = state_version + 1 WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL")
      .bind(value, wardId, projectId),
  ]);
  return (results[1]?.meta.changes ?? 0) > 0;
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
    const reference = await answerOriginalReference(db, wardId, projectId, questionId, accountId, value);
    if (reference !== null) return reference;
    const question = await db.prepare("SELECT kind, text, target, detail FROM project_questions WHERE ward_id = ? AND project_id = ? AND question_id = ? AND state IN ('open', 'later')")
      .bind(wardId, projectId, questionId).first<{ kind: string; text: string; target: string | null; detail: string | null }>();
    let applied = false;
    let draftKind: DocumentKind = "announcement";
    if (question?.kind === "decide" && question.target && isItemKey(question.target)) {
      const result = await applyChange(db, wardId, projectId, { kind: "item", itemKey: question.target, value,
        source: { kind: "person", accountId }, confidence: "high", packVersion: "person-answer@1", requestId: questionId });
      if (result.status === "rejected" || result.status === "dropped") return false;
      applied = true;
    }
    if (question?.kind === "conflict" && question.detail) {
      let detail: { itemKey?: string; documentKind?: DocumentKind; options?: string[]; table?: string; rowId?: string; field?: string; values?: Array<string | number>; candidateRowIds?: string[]; changeId?: string };
      try { detail = JSON.parse(question.detail) as typeof detail; } catch { return false; }
      if (detail.documentKind && DOCUMENT_KINDS.includes(detail.documentKind)) draftKind = detail.documentKind;
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
        // 日時の食い違いを人が選んだときは、行事の日と段取りもその日にそろえる。
        if (detail.itemKey === "date_time") {
          const state = await getProjectState(db, wardId, projectId);
          const day = state ? parseEventDay(value, state.project.year) : null;
          const end = state ? parseEventDay(value, state.project.year, "end") : null;
          if (day && end && !(await setEventDay(db, wardId, projectId, day, accountId, end))) return false;
        }
        await reconcileAnsweredFact(db, wardId, projectId, questionId, detail.itemKey, options, value, accountId);
        if (!detail.documentKind) {
          const decision = await applyChange(db, wardId, projectId, { kind: "row", table: "decisions",
            data: { what: `${ITEM_SCREEN_LABEL[detail.itemKey]}: ${value}`, decidedOn: nowIso().slice(0, 10) },
            source, confidence: "high", packVersion: "person-conflict-decision@1", requestId: questionId });
          if (decision.status === "rejected" || decision.status === "dropped") return false;
        }
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
    // 質問の答えは、対象の下書きにも入れる。配った内容は残し、新しい下書きとして保存する。
    if (applied && isItemKey(question?.target)) {
      const [current, draft] = await Promise.all([
        getProjectState(db, wardId, projectId), getEditableDocument(db, wardId, projectId, draftKind),
      ]);
      const itemKey = question.target;
      const content = current?.items.find((item) => item.key === itemKey)?.current?.content;
      if (current && draft && content !== undefined) {
        const before = JSON.parse(draft.body) as DocumentBody;
        const next = reconcileDocumentBody(before, { text: before.text,
          items: [...before.items.filter((item) => item.key !== itemKey), { key: itemKey, content }],
        });
        if (stableStringify(before) !== stableStringify(next) && !(await saveDocument(db, wardId, projectId, accountId, {
          kind: draftKind, title: draft.title, scope: draft.scope, body: JSON.stringify(next), basedOn: current.project.stateVersion,
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
export async function setEventDay(db: D1Database, wardId: string, projectId: string, day: string, accountId: string, endDay = day): Promise<boolean> {
  if (!isCalendarDay(day) || !isCalendarDay(endDay) || endDay < day) return false;
  const state = await getProjectState(db, wardId, projectId);
  if (!state || state.project.closedAt) return false;
  const oldDay = state.project.deadlines.event_day;
  if (oldDay === day && (state.project.deadlines.event_end ?? oldDay) === endDay) return true;
  await db.batch(eventDayStatements(db, wardId, projectId, state, day, accountId, nowIso(), false, endDay));
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
  if (input.start && input.end && input.start > input.end) return false;
  if (input.seatId && !(await db.prepare("SELECT 1 AS ok FROM seats WHERE ward_id = ? AND seat_id = ? AND removed_at IS NULL").bind(wardId, input.seatId).first())) return false;
  const r = await db.prepare(`UPDATE project_map_tasks SET
    offset_start_days = CASE WHEN period_start IS ? AND period_end IS ? THEN offset_start_days ELSE NULL END,
    offset_end_days = CASE WHEN period_start IS ? AND period_end IS ? THEN offset_end_days ELSE NULL END,
    name = ?, period_start = ?, period_end = ?, progress = ?, seat_id = ?,
    progress_source_kind = 'person', progress_source_ref = NULL, progress_source_locator = NULL, progress_confidence = 'high', progress_change_id = NULL
    WHERE ward_id = ? AND project_id = ? AND task_id = ? AND removed_at IS NULL`)
    .bind(input.start || null, input.end || null, input.start || null, input.end || null, name, input.start || null, input.end || null, input.progress, input.seatId, wardId, projectId, taskId).run();
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

export const DOCUMENT_TEXT_LIMIT = 20000;
export async function saveDocument(db: D1Database, wardId: string, projectId: string, accountId: string, input: { kind: DocumentKind; title: string; scope: Scope; body: string; basedOn: number }, bodyChecks?: ItemKey[]): Promise<boolean> {
  if (!["announcement", "recruitment", "duty_roster", "procedure", "notice", "report"].includes(input.kind)) return false;
  if (!["public", "space", "staff"].includes(input.scope) || input.title.trim().length < 1 || input.title.length > 100) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(input.body); } catch { return false; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed as { text?: unknown; items?: unknown };
  if (typeof record.text !== "string" || record.text.replace(/\r\n/g, "\n").length > DOCUMENT_TEXT_LIMIT || !Array.isArray(record.items)) return false;
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
  const body = reconcileDocumentBody(before, { text: record.text, items }, bodyChecks, input.kind === "notice");
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
    console.error("知らせた中身を今年の記録に残せませんでした");
  }
}

export async function getLatestDocumentBody(db: D1Database, wardId: string, documentId: string): Promise<string | null> {
  const row = await db.prepare(`SELECT body FROM document_versions WHERE ward_id = ? AND document_id = ? ORDER BY version_no DESC LIMIT 1`).bind(wardId, documentId).first<{ body: string }>();
  return row?.body ?? null;
}

/** 本文の見出しに続く中身を読む。見出しがなければ、記録にある別の中身が本文にある場合だけ拾う。 */
function draftTextValue(text: string, key: ItemKey, content: string, candidates: string[]): string | null {
  const aliases: Partial<Record<ItemKey, string[]>> = { date_time: ["日とき"], place: ["会場"], rain_plan: ["雨天時", "雨の場合"], public_contact: ["問い合わせ先", "お問い合わせ先"] };
  const labels = [...new Set([ITEM_LABEL[key], ITEM_SCREEN_LABEL[key], ...(aliases[key] ?? [])])]
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const heading = new RegExp(`^[ \\t　]*(?:#{1,6}[ \\t]+|■[ \\t　]*)?(?:\\*\\*)?(?:${labels})(?:\\*\\*)?[ \\t　]*(?:[:：][ \\t　]*([^\\r\\n]+)|\\r?\\n[ \\t　]*([^\\r\\n]+))$`, "m");
  const match = heading.exec(text);
  const written = (match?.[1] ?? match?.[2])?.trim();
  const normalize = (value: string) => value.normalize("NFKC").replace(/\s/g, "");
  if (written) return normalize(written).includes(normalize(content)) ? null : written;
  if (normalize(text).includes(normalize(content))) return null;
  return candidates.find((value) => value.length >= 2 && value !== content && text.includes(value)) ?? null;
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
  const title = typeof data.title === "string" && data.title.trim() ? data.title.trim().slice(0, 100) : DOCUMENT_KIND_LABEL[kind];
  const project = await db.prepare("SELECT kind, state_version, closed_at FROM projects WHERE ward_id = ? AND project_id = ?").bind(wardId, projectId).first<{ kind: ProjectKind; state_version: number; closed_at: string | null }>();
  if (!project || project.closed_at) return false;
  const pack = getDraftPack(kind, project.kind);
  const scope: Scope = data.scope === "public" || data.scope === "space" || data.scope === "staff" ? data.scope : pack.scope;
  const state = await getProjectState(db, wardId, projectId);
  const conflicts: { itemKey: ItemKey; bodyValue: string; itemValue: string }[] = [];
  for (const item of items) {
    if (!item.content.trim() || item.content === "（確認中）") continue;
    const recorded = state?.items.find((entry) => entry.key === item.key);
    const candidates = [recorded?.current?.content, ...(recorded?.references.map((value) => value.content) ?? [])]
      .filter((value): value is string => !!value);
    const bodyValue = draftTextValue(data.text, item.key, item.content, candidates);
    if (!bodyValue) continue;
    if (bodyValue.length > 2000) return false;
    conflicts.push({ itemKey: item.key, bodyValue, itemValue: item.content });
    // 本文と異なる項目をそのまま保存しない。もう一方は質問に残し、人が選ぶまで今年の記録は変えない。
    item.content = bodyValue;
    delete item.source;
  }
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
  const versionId = newId();
  const statements: D1PreparedStatement[] = [db.prepare(`INSERT INTO document_versions (version_id, ward_id, project_id, document_id, version_no, scope, body, title,
    based_on_state_version, origin, pack_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?)`)
    .bind(versionId, wardId, projectId, document.document_id, (latest?.n ?? 0) + 1, scope, JSON.stringify({ text: data.text, items }), title, basedOn, packVersion, nowIso())];
  for (const conflict of conflicts) {
    statements.push(db.prepare(`INSERT INTO project_questions
      (question_id, ward_id, project_id, kind, text, target, detail, state, source_kind, pack_version, dedupe_key, created_at)
      VALUES (?, ?, ?, 'conflict', ?, ?, ?, 'open', 'ai_proposal', ?, ?, ?)
      ON CONFLICT (ward_id, project_id, dedupe_key) DO NOTHING`)
      .bind(newId(), wardId, projectId, `「${ITEM_SCREEN_LABEL[conflict.itemKey]}」が下書きの本文と項目で違います。使う方を選んでください。`, conflict.itemKey,
        JSON.stringify({ itemKey: conflict.itemKey, documentKind: kind, options: [conflict.bodyValue, conflict.itemValue] }), packVersion,
        await hashOf({ versionId, packVersion, ...conflict }), nowIso()));
  }
  await db.batch(statements);
  return true;
}
