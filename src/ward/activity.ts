import { formatDateText, formatJstDate } from "../core/time";
import { addDays } from "../map/template";
import { getProjectState } from "../project/api";
import type { RowData } from "../project/model";
import { isPersonalAssignee, splitAssignees } from "../rota/assignees";

export interface ActivityTask { taskId: string; name: string; period: string; }
interface RecordedTask {
  task_id: string; name: string; period: string; progress: string;
  period_start: string | null; period_end: string | null;
  offset_start_days: number | null; offset_end_days: number | null;
}

// 担当の欄から人数を数える。姓名の間の空白では分けない。
function names(value: string): string[] {
  return value.split(/[、,，/／\n]+/).map((name) => name.trim()).filter((name) =>
    !!name && !/^(?:未定|未割当|調整中|なし|役員|実行委員|班長|\d+(?:人|名)?)$/.test(name));
}

function copies(raw: string): number | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const values = Array.isArray(record.targets) ? record.targets.map((target: unknown) =>
    typeof target === "object" && target !== null ? (target as { copies?: unknown }).copies : undefined) : Object.values(record);
  if (!values.length || !values.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0)) return null;
  const total = values.reduce<number>((sum, value) => sum + Number(value), 0);
  return Number.isSafeInteger(total) ? total : null;
}

function relativeDay(days: number): string {
  return days === 0 ? "当日" : days < 0 ? `${-days}日前` : `${days}日後`;
}

/** 同じ記録から、紹介の下書きと公開のページを作る。名前、備考、連絡先は返さない。 */
export async function activityFacts(db: D1Database, wardId: string, projectId: string, selected?: ActivityTask[]) {
  const state = await getProjectState(db, wardId, projectId);
  if (!state) return { tasks: [], facts: [] };
  const [recorded, publications, people, offers] = await Promise.all([
    db.prepare(`SELECT m.task_id, m.name, m.period, m.progress, t.period_start, t.period_end,
      t.offset_start_days, t.offset_end_days FROM project_close_map m
      JOIN project_map_tasks t ON t.ward_id = m.ward_id AND t.project_id = m.project_id AND t.task_id = m.task_id
      WHERE m.ward_id = ? AND m.project_id = ? AND t.removed_at IS NULL ORDER BY t.sort_order`)
      .bind(wardId, projectId).all<RecordedTask>(),
    db.prepare(`SELECT d.kind, r.published_at, r.distribution FROM publication_records r
      JOIN documents d ON d.ward_id = r.ward_id AND d.project_id = r.project_id AND d.document_id = r.document_id
      WHERE r.ward_id = ? AND r.project_id = ? AND d.scope = 'public' AND r.unpublished_at IS NULL
      ORDER BY r.published_at, r.publication_id`).bind(wardId, projectId)
      .all<{ kind: string; published_at: string; distribution: string }>(),
    db.prepare(`SELECT household AS name FROM ward_roster_entries WHERE ward_id = ?
      UNION SELECT name FROM accounts WHERE ward_id = ?
      UNION SELECT helper_name AS name FROM project_answers WHERE ward_id = ? AND project_id = ?
      UNION SELECT household AS name FROM project_answers WHERE ward_id = ? AND project_id = ?
      UNION SELECT name FROM project_help_offers WHERE ward_id = ? AND project_id = ?`)
      .bind(wardId, wardId, wardId, projectId, wardId, projectId, wardId, projectId).all<{ name: string }>(),
    db.prepare(`SELECT p.help_offer_count_on_close, (SELECT COUNT(*) FROM project_help_offers h
      WHERE h.ward_id = p.ward_id AND h.project_id = p.project_id) AS current_count
      FROM projects p WHERE p.ward_id = ? AND p.project_id = ?`).bind(wardId, projectId)
      .first<{ help_offer_count_on_close: number | null; current_count: number }>(),
  ]);
  const privateNames = new Set(people.results.flatMap((person) => [person.name.trim(), ...names(person.name)]).filter(Boolean));
  for (const table of Object.values(state.tables)) for (const row of table) {
    for (const key of ["name", "assignee", "contact", "counterpart"]) {
      const value = row.data[key];
      if (typeof value === "string") for (const name of [value.trim(), ...names(value)]) if (name) privateNames.add(name);
    }
  }
  // 仕事の名前や時期に個人の名前が添えられていても、そのまま公開へ持ち出さない。
  const publicText = (value: string) => !/@|https?:\/\/|(?:\d[- ()]*){10,}/i.test(value) &&
    ![...privateNames].some((name) => value.includes(name));
  const eventDay = state.project.deadlines.event_day;
  const tasks = (selected ?? recorded.results.filter((task) => task.progress === "done")
    .map((task) => ({ taskId: task.task_id, name: task.name, period: task.period })))
    .filter((task) => publicText(task.name)).map((task) => {
      const record = recorded.results.find((entry) => entry.task_id === task.taskId);
      const recordedPeriod = task.period || record?.period || "";
      let period = publicText(recordedPeriod) && !/^(?:時期の記録なし|時期未定|未定|不明|記録なし|なし)$/.test(recordedPeriod)
        ? formatDateText(recordedPeriod) : "";
      if (record) {
        const dates = [...new Set([record.period_start, record.period_end].filter((date): date is string => !!date))];
        const planned = dates.map(formatJstDate).join(" 〜 ");
        // 型から置いた日付は実施日と言わず、予定の時期として示す。
        if (eventDay && record.offset_start_days !== null && record.offset_end_days !== null &&
          record.period_start === addDays(eventDay, record.offset_start_days) && record.period_end === addDays(eventDay, record.offset_end_days) &&
          (!period || period === planned)) {
          const start = relativeDay(record.offset_start_days); const end = relativeDay(record.offset_end_days);
          period = `予定では当日の${start}${start === end ? "" : `〜${end}`}`;
        } else if (!period && planned) period = `予定の時期: ${planned}`;
      }
      return { ...task, period };
    });
  const facts: string[] = [];
  const duties = state.tables.duties.filter((row) => row.scope === "current" && row.source.kind !== "ai_proposal" && row.confidence !== "low");
  const groups = new Map<string, { task: string; slot: string; people: Set<string> }>();
  const attended = new Set<string>();
  for (const row of duties) {
    const data: RowData = row.data;
    const assigned = splitAssignees(String(data.assignee ?? ""));
    // 一部だけ名前が分かる欄も、その行の人数としては出さない。
    if (!assigned.length || !assigned.every(isPersonalAssignee)) continue;
    if (data.attendance === "present") assigned.forEach((name) => attended.add(name));
    const task = String(data.task ?? "").trim(); const slot = String(data.slot ?? "").trim();
    // 時間帯は時刻や午前・午後などだけを出す。自由記述に混ざった名前や事情は出さない。
    if (!task || !publicText(task) || !publicText(slot) || !/^(?:午前|午後|朝|昼|夕方|夜|当日|[0-9０-９:：時分半〜～~\-－ー、 ・\s])+$/u.test(slot) || !assigned.length) continue;
    const key = JSON.stringify([task, slot]);
    const group = groups.get(key) ?? { task, slot, people: new Set<string>() };
    assigned.forEach((name) => group.people.add(name)); groups.set(key, group);
  }
  for (const group of groups.values()) facts.push(`${group.task}は${group.slot}の${group.people.size}人（当番表の担当）`);
  if (attended.size) facts.push(`手伝った人は${attended.size}人（当番表で出席が記録された人）`);
  const offerCount = (offers?.help_offer_count_on_close ?? 0) + (offers?.current_count ?? 0);
  if (offerCount) facts.push(`一回だけの手伝いの申し込みは${offerCount}件`);
  for (const publication of publications.results) {
    const label = ({ announcement: "案内", recruitment: "手伝いの募集", notice: "連絡", report: "報告" } as Record<string, string>)[publication.kind];
    const date = formatJstDate(publication.published_at);
    if (!label || !date) continue;
    const count = copies(publication.distribution);
    facts.push(`${label}を知らせた日: ${date}${count === null ? "" : `。紙は${count}部（配るときの部数）`}`);
  }
  return { tasks, facts };
}
