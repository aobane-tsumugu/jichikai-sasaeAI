import { newId, nowIso } from "../core/ids";
import { readDraftMaterials } from "../draft/materials";
import { getProjectState } from "../project/api";
import { normalizeKey, rowMatchKey } from "../project/model";
import type { ProjectSummary } from "../project/types";

/** AIが拾った内容は下書きのまま見せる。本文から決定を切り出す推測はしない。 */
export async function meetingDecisionDraft(db: D1Database, wardId: string, project: ProjectSummary) {
  const state = await getProjectState(db, wardId, project.projectId);
  const rows = state?.tables.decisions.filter((row) => row.scope === "current") ?? [];
  const texts = new Map<string, string>();
  let proposal = false;
  for (const row of rows) {
    const text = String(row.data.what ?? "").trim();
    if (text) texts.set(normalizeKey(text), text);
    proposal ||= row.source.kind === "ai_proposal";
  }
  for (const reading of await readDraftMaterials(db, wardId, project.projectId)) {
    for (const decision of reading.decisions) {
      const year = reading.original_years.find((entry) => entry.original_id === decision.original_id)?.year;
      // 年不明や過去の決定を、今年決めたことに移さない。
      if (year !== project.year) continue;
      const text = decision.text.trim();
      if (text && !texts.has(normalizeKey(text))) {
        texts.set(normalizeKey(text), text);
        proposal = true;
      }
    }
  }
  return { text: [...texts.values()].join("\n"), proposal };
}

/** 閉じる画面に書かれた決定だけを、人が残した記録にする。閉じる更新と同じbatchへ入れる。 */
export async function meetingDecisionStatements(db: D1Database, wardId: string, project: ProjectSummary, accountId: string,
  text: string, versionId: string): Promise<D1PreparedStatement[]> {
  const state = await getProjectState(db, wardId, project.projectId);
  if (!state || state.project.closedAt) return [];
  const existing = state.tables.decisions.filter((row) => row.scope === "current");
  const submitted = new Map(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => [normalizeKey(line), line]));
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  for (const row of existing) {
    if (submitted.has(normalizeKey(String(row.data.what ?? "")))) continue;
    statements.push(db.prepare(`UPDATE project_rows SET removed_at = ?, removed_by_account_id = ?
      WHERE ward_id = ? AND project_id = ? AND row_id = ? AND removed_at IS NULL
        AND EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL)`)
      .bind(now, accountId, wardId, project.projectId, row.rowId, wardId, project.projectId));
  }
  for (const [key, what] of submitted) {
    const previous = existing.find((row) => normalizeKey(String(row.data.what ?? "")) === key);
    if (previous && previous.source.kind !== "ai_proposal" && previous.data.what === what) continue;
    const on = previous?.data.decidedOn ?? project.deadlines.board_meeting_day ?? project.deadlines.event_day;
    const data = { what, ...(on ? { decidedOn: on } : {}) };
    if (previous) {
      statements.push(db.prepare(`UPDATE project_rows SET data = ?, person_fields = ?, source_kind = 'person', source_ref = ?,
        source_locator = ?, source_year = ?, confidence = 'high', updated_at = ?
        WHERE ward_id = ? AND project_id = ? AND row_id = ? AND removed_at IS NULL
          AND EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL)`)
        .bind(JSON.stringify(data), JSON.stringify(Object.keys(data)), accountId, `議事録:${versionId}`, project.year, now,
          wardId, project.projectId, previous.rowId, wardId, project.projectId));
    } else {
      statements.push(db.prepare(`INSERT INTO project_rows
        (row_id, ward_id, project_id, table_key, scope, match_key, data, person_fields, source_kind, source_ref, source_locator,
          source_year, confidence, created_at, updated_at, created_by_account_id)
        SELECT ?, ?, ?, 'decisions', 'current', ?, ?, ?, 'person', ?, ?, ?, 'high', ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL)`)
        .bind(newId(), wardId, project.projectId, rowMatchKey("decisions", data), JSON.stringify(data), JSON.stringify(Object.keys(data)),
          accountId, `議事録:${versionId}`, project.year, now, now, accountId, wardId, project.projectId));
    }
  }
  if (statements.length) {
    statements.push(db.prepare("UPDATE projects SET state_version = state_version + 1 WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL")
      .bind(wardId, project.projectId));
    statements.push(db.prepare(`UPDATE documents SET stale_since_version = COALESCE(stale_since_version,
      (SELECT state_version FROM projects WHERE ward_id = ? AND project_id = ?))
      WHERE ward_id = ? AND project_id = ? AND kind = 'procedure'
        AND EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL)`)
      .bind(wardId, project.projectId, wardId, project.projectId, wardId, project.projectId));
  }
  return statements;
}
