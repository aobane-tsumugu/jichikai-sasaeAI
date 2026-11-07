import { getRoster, normalizeHousehold, type RosterEntry } from "../answers/api";
import { latestSpaceTables, readPublicationTables } from "../space/publication-tables";
import type { RowData } from "../project/model";
import { exemptions, householdKey, rotaDate, type Exemption } from "./store";
import { splitAssignees } from "./assignees";
import { DUTY_TABLE_TASK_SQL } from "../project/task-features";

export interface HistoryEntry {
  who: string;
  when: string;
  what: string;
  detail: string;
  projectId?: string;
  closed?: boolean;
}
export interface HouseholdHistory extends RosterEntry {
  records: HistoryEntry[];
  exemptions: Exemption[];
}

/** 出席の記録と担当の記録を区別する。下書きだけを実施済みにはしない。 */
export async function householdHistory(db: D1Database, wardId: string): Promise<HouseholdHistory[]> {
  const [roster, exempt, projects, seats, changes] = await Promise.all([
    getRoster(db, wardId), exemptions(db, wardId),
    db.prepare(`SELECT p.project_id, p.title, p.year, p.closed_at, d.due_on FROM projects p
      LEFT JOIN project_deadlines d ON d.ward_id = p.ward_id AND d.project_id = p.project_id AND d.kind = 'event_day'
      WHERE p.ward_id = ? AND ${DUTY_TABLE_TASK_SQL} ORDER BY p.year DESC, p.created_at DESC`)
      .bind(wardId).all<{ project_id: string; title: string; year: number; closed_at: string | null; due_on: string | null }>(),
    db.prepare(`SELECT a.account_id, a.name, s.title, s.removed_at FROM accounts a
      JOIN seats s ON s.ward_id = a.ward_id AND s.seat_id = a.seat_id
      WHERE a.ward_id = ? AND a.removed_at IS NULL ORDER BY a.name`)
      .bind(wardId).all<{ account_id: string; name: string; title: string; removed_at: string | null }>(),
    db.prepare(`SELECT account_id, name, previous_title, next_title, recorded_at FROM rota_seat_changes
      WHERE ward_id = ? ORDER BY recorded_at, rowid`).bind(wardId)
      .all<{ account_id: string; name: string; previous_title: string | null; next_title: string | null; recorded_at: string }>(),
  ]);
  const groups = new Map<string, HouseholdHistory>();
  function group(entry: RosterEntry) {
    const key = householdKey(entry);
    let value = groups.get(key);
    if (!value) {
      value = { ...entry, records: [], exemptions: [] };
      groups.set(key, value);
    }
    return value;
  }
  for (const entry of roster) group(entry);
  for (const record of exempt) group(record).exemptions.push(record);
  const locate = (name: string, entries: RosterEntry[]) => {
    const matches = entries.filter((entry) => normalizeHousehold(entry.household) === normalizeHousehold(name));
    return matches.length === 1 ? matches[0]! : { household: name, district: "世帯を特定できない記録" };
  };
  for (const project of projects.results) {
    const [publication, recordedRows, preparation] = await Promise.all([
      latestSpaceTables(db, wardId, project.project_id),
      db.prepare(`SELECT data, source_kind FROM project_rows
        WHERE ward_id = ? AND project_id = ? AND table_key = 'duties' AND scope = 'current' AND removed_at IS NULL ORDER BY created_at, row_id`)
        .bind(wardId, project.project_id).all<{ data: string; source_kind: string }>(),
      db.prepare(`SELECT roster_json FROM rota_preparations WHERE ward_id = ? AND project_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1`)
        .bind(wardId, project.project_id).first<{ roster_json: string }>(),
    ]);
    const published = publication ? readPublicationTables(publication.tables_snapshot)?.filter((row) => row.kind === "duties").map((row) => row.data) : null;
    const humanRows = recordedRows.results.filter((row) => row.source_kind !== "ai_proposal").map((row) => JSON.parse(row.data) as RowData);
    // 配った担当と当日の出席記録が同じ所なら、後から入った記録を読む。
    const rows = published ? published.map((row) => humanRows.find((human) => human.slot === row.slot && human.task === row.task) ?? row) : humanRows;
    const names = preparation ? JSON.parse(preparation.roster_json) as RosterEntry[] : roster;
    for (const row of rows) {
      for (const name of splitAssignees(String(row.assignee ?? ""))) {
        group(locate(name, names)).records.push({ who: name, when: project.due_on ? rotaDate(project.due_on) : `${project.year}年`,
          what: [project.title, row.slot, row.task].filter(Boolean).join(" / "),
          detail: row.attendance === "present" ? "出席の記録あり" : row.attendance === "absent" ? "欠席の記録あり" : "担当の記録。実施したかの記録はありません。",
          projectId: project.project_id, closed: project.closed_at !== null });
      }
    }
    for (const row of humanRows.filter((row) => published && !published.some((entry) => entry.slot === row.slot && entry.task === row.task))) {
      for (const name of splitAssignees(String(row.assignee ?? ""))) {
        group(locate(name, names)).records.push({ who: name, when: project.due_on ? rotaDate(project.due_on) : `${project.year}年`, what: [project.title, row.slot, row.task].filter(Boolean).join(" / "),
          detail: row.attendance === "present" ? "出席の記録あり" : row.attendance === "absent" ? "欠席の記録あり" : "担当の記録。実施したかの記録はありません。", projectId: project.project_id, closed: project.closed_at !== null });
      }
    }
  }
  const starts = new Map<string, string>();
  for (const change of changes.results) {
    if (change.previous_title) group(locate(change.name, roster)).records.push({ who: change.name,
      when: `${starts.get(change.account_id) ?? "開始日の記録なし"}から${rotaDate(change.recorded_at)}まで`, what: change.previous_title, detail: "役員の交代の記録" });
    if (change.next_title) starts.set(change.account_id, rotaDate(change.recorded_at));
    else starts.delete(change.account_id);
  }
  for (const seat of seats.results) group(locate(seat.name, roster)).records.push({ who: seat.name,
    when: `${starts.get(seat.account_id) ?? "開始日の記録なし"}から${seat.removed_at ? rotaDate(seat.removed_at) : "現在"}まで`, what: seat.title, detail: "役員の担当の記録" });
  return [...groups.values()];
}
