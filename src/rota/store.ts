import { projectFeatures, taskFeatures } from "../project/task-features";
import { getRoster, normalizeHousehold, type RosterEntry } from "../answers/api";
import { newId, nowIso } from "../core/ids";
import { getProjectState, getProjectSummary } from "../project/api";
import { rowMatchKey, type RowData } from "../project/model";
import { latestSpaceTables, readPublicationTables } from "../space/publication-tables";
import { formatJstDate } from "../core/time";
import { isPersonalAssignee, splitAssignees } from "./assignees";
import { rotaSchedule, weeklyRota } from "./schedule";

export interface Exemption extends RosterEntry {
  exemption_id: string;
  reason: string;
  starts_on: string;
  ends_on: string;
  recorded_at: string;
  withdrawn_at: string | null;
}
export const householdKey = (entry: RosterEntry) => JSON.stringify([normalizeHousehold(entry.district), normalizeHousehold(entry.household)]);
export const householdLabel = (entry: RosterEntry) => `${entry.district} ${entry.household}`;
const jstYear = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric" });
export function rotaDate(iso: string): string {
  const date = formatJstDate(iso);
  return date ? `${jstYear.format(new Date(iso))}${date}` : "";
}

export async function exemptions(db: D1Database, wardId: string): Promise<Exemption[]> {
  return (await db.prepare(`SELECT exemption_id, household, district, reason, starts_on, ends_on, recorded_at, withdrawn_at
    FROM rota_exemptions WHERE ward_id = ? ORDER BY recorded_at DESC, exemption_id`)
    .bind(wardId).all<Exemption>()).results;
}

function dateIsValid(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export async function addExemption(db: D1Database, wardId: string, accountId: string, input: RosterEntry & { reason: string; startsOn: string; endsOn: string }): Promise<boolean> {
  const reason = input.reason.trim();
  if (!reason || reason.length > 200 || !dateIsValid(input.startsOn) || !dateIsValid(input.endsOn) || input.endsOn < input.startsOn) return false;
  const roster = await getRoster(db, wardId);
  // 同名の世帯を推測して選ばない。班も同じものが複数あるときは個別の免除を当てられない。
  const matches = roster.filter((entry) => householdKey(entry) === householdKey(input));
  if (matches.length !== 1) return false;
  const result = await db.prepare(`INSERT INTO rota_exemptions
    (exemption_id, ward_id, household, district, reason, starts_on, ends_on, recorded_at, recorded_by_account_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(newId(), wardId, matches[0]!.household, matches[0]!.district, reason,
    input.startsOn, input.endsOn, nowIso(), accountId).run();
  return result.meta.changes === 1;
}

export interface ProposalEntry {
  sourceKey: string;
  rowId?: string;
  data: RowData;
  explanation: string;
}
export interface Comparison {
  weekday?: number;
  sourceTitle: string;
  sourceProjectId: string | null;
  year: number;
  hasOldRoster: boolean;
  hasPreviousTable?: boolean;
  added: string[];
  removed: string[];
  entries: ProposalEntry[];
  ruleRecords: string[];
}

export async function lastPreparation(db: D1Database, wardId: string, projectId: string) {
  return db.prepare(`SELECT comparison_json, roster_json, recorded_at FROM rota_preparations
    WHERE ward_id = ? AND project_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1`)
    .bind(wardId, projectId).first<{ comparison_json: string; roster_json: string; recorded_at: string }>();
}

/** 元の資料は読み直さず、去年の同じ当番の記録か、この仕事に届いた去年の表を使う。 */
export async function compareRota(db: D1Database, wardId: string, projectId: string, weekday?: number): Promise<{ comparison: Comparison; roster: RosterEntry[] } | null> {
  const state = await getProjectState(db, wardId, projectId);
  if (!state || !taskFeatures(state.mapTasks).has("assign")) return null;
  const project = state.project;
  const schedule = await rotaSchedule(db, wardId, projectId);
  const day = weekday ?? schedule?.weekday;
  if (day !== undefined) {
    if (!Number.isInteger(day) || day < 0 || day > 6) return null;
    const [roster, records, preparation] = await Promise.all([getRoster(db, wardId), exemptions(db, wardId), lastPreparation(db, wardId, projectId)]);
    const oldRoster = preparation ? JSON.parse(preparation.roster_json) as RosterEntry[] : null;
    if (!roster.length && !oldRoster?.length) return null;
    const currentKeys = new Set(roster.map(householdKey));
    const oldKeys = new Set(oldRoster?.map(householdKey));
    return { roster, comparison: { weekday: day, sourceTitle: "今の世帯の名簿", sourceProjectId: null, year: project.year,
      hasOldRoster: oldRoster !== null, hasPreviousTable: false,
      added: oldRoster ? roster.filter((entry) => !oldKeys.has(householdKey(entry))).map(householdLabel) : [],
      removed: oldRoster ? oldRoster.filter((entry) => !currentKeys.has(householdKey(entry))).map(householdLabel) : [],
      entries: weeklyRota(project.year, day, roster, records), ruleRecords: [] } };
  }
  const seed = await db.prepare(`SELECT seed_project_id FROM projects WHERE ward_id = ? AND project_id = ?`)
    .bind(wardId, projectId).first<{ seed_project_id: string | null }>();
  const candidates = await db.prepare(`SELECT project_id, title FROM projects
    WHERE ward_id = ? AND kind = 'duty' AND year = ? AND closed_at IS NOT NULL
      AND (project_id = ? OR title = ?) ORDER BY created_at DESC`)
    .bind(wardId, project.year - 1, seed?.seed_project_id ?? "", project.title).all<{ project_id: string; title: string }>();
  const previous = candidates.results.find((row) => row.project_id === seed?.seed_project_id)
    ?? (candidates.results.length === 1 ? candidates.results[0] : undefined);
  let rows: RowData[];
  let rules: RowData[];
  let oldRoster: RosterEntry[] | null = null;
  if (previous) {
    const previousState = await getProjectState(db, wardId, previous.project_id);
    if (!previousState) return null;
    const publication = await latestSpaceTables(db, wardId, previous.project_id);
    const publishedRows = publication ? readPublicationTables(publication.tables_snapshot) : null;
    rows = publishedRows ? publishedRows.filter((row) => row.kind === "duties").map((row) => row.data)
      : previousState.tables.duties.filter((row) => row.scope === "current").map((row) => row.data);
    rules = previousState.tables.decisions.filter((row) => row.scope === "current").map((row) => row.data);
    const preparation = await lastPreparation(db, wardId, previous.project_id);
    if (preparation) oldRoster = JSON.parse(preparation.roster_json) as RosterEntry[];
  } else {
    rows = state.tables.duties.filter((row) => row.scope === "reference" && row.refYear === project.year - 1).map((row) => row.data);
    rules = state.tables.decisions.filter((row) => row.scope === "reference" && row.refYear === project.year - 1).map((row) => row.data);
  }
  const [roster, records] = await Promise.all([getRoster(db, wardId), exemptions(db, wardId)]);
  const hasPreviousTable = rows.length > 0;
  if (!hasPreviousTable && !roster.length) return null;
  // 名簿で分かる世帯は、名前に含まれる字だけで班や団体とみなさない。
  const knownNames = new Set([...roster, ...(oldRoster ?? [])].map((entry) => normalizeHousehold(entry.household)));
  const isHouseholdAssignee = (name: string) => knownNames.has(normalizeHousehold(name)) || isPersonalAssignee(name);
  const oldAssignees = rows.flatMap((data) => splitAssignees(String(data.assignee ?? ""))).filter(isHouseholdAssignee);
  const oldNames = new Set(oldAssignees.map(normalizeHousehold));
  if (!hasPreviousTable) rows = roster.map((entry, index) => ({ slot: `${index + 1}番目`, task: entry.district, assignee: entry.household }));
  const oldKeys = new Set(oldRoster?.map(householdKey));
  const currentKeys = new Set(roster.map(householdKey));
  const comparison: Comparison = {
    sourceTitle: previous?.title ?? "この当番に届いた去年の表", sourceProjectId: previous?.project_id ?? null,
    year: hasPreviousTable ? project.year - 1 : project.year, hasOldRoster: oldRoster !== null, hasPreviousTable,
    added: hasPreviousTable ? roster.filter((entry) => oldRoster ? !oldKeys.has(householdKey(entry)) : !oldNames.has(normalizeHousehold(entry.household))).map(householdLabel) : [],
    removed: oldRoster ? oldRoster.filter((entry) => !currentKeys.has(householdKey(entry))).map(householdLabel)
      : [...new Set(oldAssignees.filter((name) => !roster.some((entry) => normalizeHousehold(entry.household) === normalizeHousehold(name))))],
    entries: [], ruleRecords: rules.map((data) => [data.decidedOn, data.what].filter(Boolean).join(" ")),
  };
  comparison.entries = rows.map((row, index) => {
    const slot = String(row.slot ?? "").replace(new RegExp(`\\b${project.year - 1}(?=[年/-])`, "g"), String(project.year));
    const dates = [...slot.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map((match) => match[0]).filter(dateIsValid).sort();
    const on = project.deadlines.event_day;
    const from = dates[0] ?? on ?? `${project.year}-01-01`, to = dates.at(-1) ?? on ?? `${project.year}-12-31`;
    const active = records.filter((record) => record.withdrawn_at === null && record.starts_on <= to && record.ends_on >= from);
    const explanations: string[] = [];
    const names = splitAssignees(String(row.assignee ?? ""));
    const kept = names.filter((name) => {
      if (hasPreviousTable && !isHouseholdAssignee(name)) return true;
      const matches = hasPreviousTable ? roster.filter((entry) => normalizeHousehold(entry.household) === normalizeHousehold(name)) : [roster[index]!];
      if (matches.length !== 1) {
        explanations.push(matches.length === 0 ? `去年の担当「${name}」は今の名簿にいないため、担当から外しました。`
          : `「${name}」は同じ名前があるため、担当から外しました。`);
        return false;
      }
      if (active.some((record) => householdKey(record) === householdKey(matches[0]!))) {
        explanations.push(dates.length || on ? `${householdLabel(matches[0]!)}は免除の期間に当たるため、担当から外しました。`
          : `${householdLabel(matches[0]!)}はこの年に免除の期間があります。当番の日がまだ分からないため、担当は空欄にしました。`);
        return false;
      }
      return true;
    });
    const assignee = kept.length === names.length ? String(row.assignee ?? "") : kept.join("、");
    const explanation = explanations.join(" ");
    // 出席や去年の備考は引き継がない。免除の説明も配布する行に書かない。
    const data: RowData = { slot, task: String(row.task ?? ""), assignee };
    return { sourceKey: rowMatchKey("duties", row), data, explanation };
  });
  return { comparison, roster };
}

/** 下書きを表の行に入れる。役員が直した行は保ち、配った内容には触れない。 */
export async function prepareRota(db: D1Database, wardId: string, projectId: string, accountId: string, weekday?: number): Promise<boolean> {
  const project = await getProjectSummary(db, wardId, projectId);
  if (!project || project.closedAt || !(await projectFeatures(db, wardId, projectId)).has("assign")) return false;
  const proposal = await compareRota(db, wardId, projectId, weekday);
  if (!proposal) return false;
  const previous = await lastPreparation(db, wardId, projectId);
  const previousEntries = previous ? (JSON.parse(previous.comparison_json) as Comparison).entries : [];
  const current = await db.prepare(`SELECT row_id, match_key, source_kind, source_locator, person_fields FROM project_rows
    WHERE ward_id = ? AND project_id = ? AND table_key = 'duties' AND scope = 'current' AND removed_at IS NULL`)
    .bind(wardId, projectId).all<{ row_id: string; match_key: string; source_kind: string; source_locator: string | null; person_fields: string }>();
  const now = nowIso();
  const preparationId = newId();
  const statements: D1PreparedStatement[] = [];
  if (proposal.comparison.weekday !== undefined) {
    statements.push(db.prepare(`INSERT INTO rota_schedules (ward_id, project_id, weekday)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND state_version = ? AND closed_at IS NULL)
      ON CONFLICT (ward_id, project_id) DO UPDATE SET weekday = excluded.weekday`)
      .bind(wardId, projectId, proposal.comparison.weekday, wardId, projectId, project.stateVersion));
  }
  for (const [index, entry] of proposal.comparison.entries.entries()) {
    const priorId = previousEntries.find((old) => old.sourceKey === entry.sourceKey)?.rowId;
    const matchKey = rowMatchKey("duties", entry.data);
    const existing = current.results.find((row) => row.row_id === priorId) ?? current.results.find((row) => row.match_key === matchKey);
    // 同じ保存時刻でも、去年の表の並びで画面と配布の表に出す。
    entry.rowId = existing?.row_id ?? `${preparationId}:${String(index).padStart(6, "0")}`;
    if (existing) {
      if (existing.source_kind !== "ai_proposal" || existing.source_locator !== "rota" || existing.person_fields !== "[]") {
        entry.explanation += " 今ある担当の行はそのまま残しています。";
        continue;
      }
      statements.push(db.prepare(`UPDATE project_rows SET data = ?, match_key = ?, updated_at = ?, source_ref = ?
        WHERE ward_id = ? AND project_id = ? AND row_id = ? AND source_kind = 'ai_proposal' AND person_fields = '[]'
          AND EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND state_version = ? AND closed_at IS NULL)`)
        .bind(JSON.stringify(entry.data), matchKey, now, preparationId, wardId, projectId, existing.row_id, wardId, projectId, project.stateVersion));
    } else {
      statements.push(db.prepare(`INSERT INTO project_rows
        (row_id, ward_id, project_id, table_key, scope, match_key, data, source_kind, source_ref, source_locator, source_year, confidence, created_at, updated_at)
        SELECT ?, ?, ?, 'duties', 'current', ?, ?, 'ai_proposal', ?, 'rota', ?, 'high', ?, ?
        WHERE EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND state_version = ? AND closed_at IS NULL)`)
        .bind(entry.rowId, wardId, projectId, matchKey, JSON.stringify(entry.data), preparationId, proposal.comparison.year,
          now, now, wardId, projectId, project.stateVersion));
    }
  }
  const proposedRowIds = new Set(proposal.comparison.entries.map((entry) => entry.rowId));
  for (const row of current.results) {
    if (proposedRowIds.has(row.row_id) || row.source_kind !== "ai_proposal" || row.source_locator !== "rota" || row.person_fields !== "[]") continue;
    // 名簿などから外れた未編集の行だけを下書きから外す。役員の入力と配った表は保つ。
    statements.push(db.prepare(`UPDATE project_rows SET removed_at = ?, updated_at = ?
      WHERE ward_id = ? AND project_id = ? AND row_id = ? AND source_kind = 'ai_proposal' AND source_locator = 'rota' AND person_fields = '[]'
        AND EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND state_version = ? AND closed_at IS NULL)`)
      .bind(now, now, wardId, projectId, row.row_id, wardId, projectId, project.stateVersion));
  }
  statements.push(db.prepare(`INSERT INTO rota_preparations
    (preparation_id, ward_id, project_id, roster_json, comparison_json, recorded_at, recorded_by_account_id)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND state_version = ? AND closed_at IS NULL)`)
    .bind(preparationId, wardId, projectId, JSON.stringify(proposal.roster), JSON.stringify(proposal.comparison), now, accountId, wardId, projectId, project.stateVersion));
  statements.push(db.prepare(`UPDATE documents SET stale_since_version = ? WHERE ward_id = ? AND project_id = ?
    AND kind IN ('duty_roster', 'procedure', 'report') AND stale_since_version IS NULL
    AND EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND state_version = ? AND closed_at IS NULL)`)
    .bind(project.stateVersion + 1, wardId, projectId, wardId, projectId, project.stateVersion));
  statements.push(db.prepare(`UPDATE projects SET state_version = state_version + 1
    WHERE ward_id = ? AND project_id = ? AND state_version = ? AND closed_at IS NULL`)
    .bind(wardId, projectId, project.stateVersion));
  const result = await db.batch(statements);
  return result.at(-1)?.meta.changes === 1;
}
