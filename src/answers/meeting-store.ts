import { newId, nowIso } from "../core/ids";
import type { AnswerInput, AnswerRow } from "./api";
import { isMeetingStatus } from "./meeting";
import { DELEGATION_TASK_SQL } from "../project/task-features";

export interface MeetingTotals { answered: number; attend: number; proxy: number; absent: number; }

/** 答えの画面と同じく、読み取れた出席・委任・欠席だけを一件ずつ数える。 */
export function countMeetingAnswers(answers: readonly Pick<AnswerRow, "meetingStatus">[]): MeetingTotals {
  const totals: MeetingTotals = { answered: 0, attend: 0, proxy: 0, absent: 0 };
  for (const answer of answers) {
    if (!isMeetingStatus(answer.meetingStatus)) continue;
    totals.answered++;
    totals[answer.meetingStatus]++;
  }
  return totals;
}

/** 総会も既存の答えの表へ入れる。Webの再送と同じ紙の読み直しで二度数えない。 */
export async function saveMeetingAnswer(db: D1Database, wardId: string, input: AnswerInput, options: { answerId?: string; submissionId?: string } = {}): Promise<string | null> {
  if (!isMeetingStatus(input.meetingStatus) || !input.household.trim() || input.household.trim().length > 120 || input.district.length > 80 ||
    typeof input.proxyName !== "string" || input.proxyName.length > 120) return null;
  const proxyName = input.meetingStatus === "proxy" ? input.proxyName.trim() : "";
  const sheet = input.source === "sheet" && input.originalId && input.sheetRowIndex !== undefined;
  const existing = sheet ? await db.prepare(`SELECT answer_id FROM project_answers
    WHERE ward_id = ? AND project_id = ? AND original_id = ? AND sheet_row_index = ?`)
    .bind(wardId, input.projectId, input.originalId, input.sheetRowIndex).first<{ answer_id: string }>() : null;
  const answerId = options.answerId ?? existing?.answer_id;
  if (answerId) {
    const result = await db.prepare(`UPDATE project_answers SET household = ?, district = ?, meeting_status = ?, proxy_name = ?,
      people_count = 0, children_count = NULL, adults_count = NULL, seniors_count = NULL
      WHERE ward_id = ? AND project_id = ? AND answer_id = ?
      AND EXISTS (SELECT 1 FROM projects p WHERE p.ward_id = project_answers.ward_id AND p.project_id = project_answers.project_id
        AND ${DELEGATION_TASK_SQL} AND p.closed_at IS NULL)`)
      .bind(input.household.trim(), input.district.trim(), input.meetingStatus, proxyName, wardId, input.projectId, answerId).run();
    return result.meta.changes === 1 ? answerId : null;
  }
  const id = newId();
  const submissionId = options.submissionId ?? "";
  const statements = [db.prepare(`INSERT INTO project_answers
    (answer_id, ward_id, project_id, household, district, people_count, meeting_status, proxy_name,
      source, original_id, sheet_row_index, created_at, created_by_account_id)
    SELECT ?, p.ward_id, p.project_id, ?, ?, 0, ?, ?, ?, ?, ?, ?, ? FROM projects p
    WHERE p.ward_id = ? AND p.project_id = ? AND ${DELEGATION_TASK_SQL} AND p.closed_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM project_answer_submissions WHERE ward_id = ? AND project_id = ? AND submission_id = ?)`)
    .bind(id, input.household.trim(), input.district.trim(), input.meetingStatus, proxyName, input.source,
      input.originalId ?? null, input.sheetRowIndex ?? null, nowIso(), input.accountId ?? null,
      wardId, input.projectId, wardId, input.projectId, submissionId)];
  if (submissionId) statements.push(db.prepare(`INSERT INTO project_answer_submissions (ward_id, project_id, submission_id, answer_id)
    SELECT ward_id, project_id, ?, answer_id FROM project_answers WHERE ward_id = ? AND project_id = ? AND answer_id = ?`)
    .bind(submissionId, wardId, input.projectId, id));
  await db.batch(statements);
  const saved = submissionId
    ? await db.prepare("SELECT answer_id FROM project_answer_submissions WHERE ward_id = ? AND project_id = ? AND submission_id = ?").bind(wardId, input.projectId, submissionId).first<{ answer_id: string }>()
    : await db.prepare("SELECT answer_id FROM project_answers WHERE ward_id = ? AND project_id = ? AND answer_id = ?").bind(wardId, input.projectId, id).first<{ answer_id: string }>();
  return saved?.answer_id ?? null;
}
