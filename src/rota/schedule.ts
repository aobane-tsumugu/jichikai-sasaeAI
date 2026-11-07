import type { RosterEntry } from "../answers/api";
import { householdKey, type Exemption, type ProposalEntry } from "./store";

export const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

export async function rotaSchedule(db: D1Database, wardId: string, projectId: string) {
  return db.prepare("SELECT weekday FROM rota_schedules WHERE ward_id = ? AND project_id = ?")
    .bind(wardId, projectId).first<{ weekday: number }>();
}

/** 年の最初から最後まで、選んだ曜日の日を名簿順で一軒ずつ割り当てる。 */
export function weeklyRota(year: number, weekday: number, roster: readonly RosterEntry[], records: readonly Exemption[]): ProposalEntry[] {
  const first = new Date(Date.UTC(year, 0, 1));
  first.setUTCDate(1 + (weekday - first.getUTCDay() + 7) % 7);
  const entries: ProposalEntry[] = [];
  let cursor = 0;
  for (const date = first; date.getUTCFullYear() === year; date.setUTCDate(date.getUTCDate() + 7)) {
    const slot = date.toISOString().slice(0, 10);
    let chosen: RosterEntry | undefined;
    for (let checked = 0; checked < roster.length; checked++) {
      const candidate = roster[(cursor + checked) % roster.length]!;
      if (records.some((record) => record.withdrawn_at === null && record.starts_on <= slot && record.ends_on >= slot && householdKey(record) === householdKey(candidate))) continue;
      chosen = candidate;
      cursor = (cursor + checked + 1) % roster.length;
      break;
    }
    const data = { slot, task: chosen?.district ?? "", assignee: chosen?.household ?? "" };
    entries.push({ sourceKey: `weekly:${slot}`, data, explanation: chosen ? "" : "この日は担当できる世帯がありません。名簿と免除の期間を確かめてください。" });
  }
  return entries;
}
