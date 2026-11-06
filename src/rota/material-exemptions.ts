import { getRoster, normalizeHousehold, type RosterEntry } from "../answers/api";
import { nowIso } from "../core/ids";
import type { NewQuestion } from "../project/apply";
import type { Source } from "../project/model";
import { householdKey, prepareRota } from "./store";

export const EXEMPTION_TARGET = "rota_exemption:";
export const EXEMPTION_YES = "今年の当番から外す";
export const EXEMPTION_NO = "外さない";
export const EXEMPTION_REASON_MAX = 200;

export interface MaterialExemption extends RosterEntry {
  reason: string;
  year: number;
}

/** 免除の文は共用の「決めたこと」に入れず、役員の質問だけに置く。 */
export async function materialExemptionQuestions(
  db: D1Database, wardId: string, projectId: string, year: number, reason: string, source: Source,
): Promise<NewQuestion[]> {
  const roster = await getRoster(db, wardId);
  const key = (value: string) => normalizeHousehold(value).replace(/\s+/g, "");
  const text = key(reason);
  let matches = roster.filter((entry) => text.includes(key(entry.household)));
  // 別の班に同名の人がいるときは、資料に班も書かれている場合だけ当てる。
  if (matches.length > 1) matches = matches.filter((entry) => entry.district && text.includes(key(entry.district)));
  if (matches.length !== 1) return [];
  const entry = matches[0]!;
  if (roster.filter((other) => householdKey(other) === householdKey(entry)).length !== 1) return [];
  const target = `${EXEMPTION_TARGET}${householdKey(entry)}`;
  const existing = await db.prepare(`SELECT question_id FROM project_questions
    WHERE ward_id = ? AND project_id = ? AND target = ? AND state IN ('open', 'later') LIMIT 1`)
    .bind(wardId, projectId, target).first();
  if (existing) return [];
  return [{
    kind: "decide", text: `${entry.household}さんを今年の当番から外しますか`, target,
    detail: { rotaExemption: { ...entry, reason, year }, options: [EXEMPTION_YES, EXEMPTION_NO] },
    suffix: target, source,
  }];
}

/** 役員画面だけが読む、質問に付いた資料の文。 */
export function readMaterialExemption(detail: string | null): MaterialExemption | null {
  try {
    const value = (JSON.parse(detail ?? "null") as { rotaExemption?: Partial<MaterialExemption> } | null)?.rotaExemption;
    return value && typeof value.household === "string" && typeof value.district === "string" &&
      typeof value.reason === "string" && typeof value.year === "number" && Number.isInteger(value.year)
      ? { household: value.household, district: value.district, reason: value.reason, year: value.year } : null;
  } catch { return null; }
}

/** 答えと免除の記録を一緒に保存する。未回答の質問だけが記録を作れる。 */
export async function answerMaterialExemption(
  db: D1Database, wardId: string, projectId: string, questionId: string, accountId: string,
  action: string, reason: string,
): Promise<"saved" | "failed" | "draft_failed"> {
  if (![EXEMPTION_YES, EXEMPTION_NO, "unknown", "later"].includes(action)) return "failed";
  const row = await db.prepare(`SELECT q.detail, p.year, p.kind FROM project_questions q
    JOIN projects p ON p.ward_id = q.ward_id AND p.project_id = q.project_id
    WHERE q.ward_id = ? AND q.project_id = ? AND q.question_id = ? AND q.target LIKE 'rota_exemption:%'
      AND q.state IN ('open', 'later') AND p.closed_at IS NULL`)
    .bind(wardId, projectId, questionId).first<{ detail: string | null; year: number; kind: string }>();
  const proposal = readMaterialExemption(row?.detail ?? null);
  if (!row || !proposal || proposal.year !== row.year) return "failed";
  const yes = action === EXEMPTION_YES;
  const editedReason = reason.trim();
  if (yes) {
    if (!editedReason || editedReason.length > EXEMPTION_REASON_MAX) return "failed";
    const roster = await getRoster(db, wardId);
    if (roster.filter((entry) => householdKey(entry) === householdKey(proposal)).length !== 1) return "failed";
  }
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  if (yes) statements.push(db.prepare(`INSERT INTO rota_exemptions
    (exemption_id, ward_id, household, district, reason, starts_on, ends_on, recorded_at, recorded_by_account_id)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
      SELECT 1 FROM project_questions q JOIN projects p ON p.ward_id = q.ward_id AND p.project_id = q.project_id
      WHERE q.ward_id = ? AND q.project_id = ? AND q.question_id = ? AND q.state IN ('open', 'later') AND p.closed_at IS NULL)`)
    .bind(questionId, wardId, proposal.household, proposal.district, editedReason,
      `${row.year}-01-01`, `${row.year}-12-31`, now, accountId, wardId, projectId, questionId));
  statements.push(db.prepare(`UPDATE project_questions SET state = ?, answer = ?, answered_at = ?, answered_by_account_id = ?
    WHERE ward_id = ? AND project_id = ? AND question_id = ? AND state IN ('open', 'later')
      AND EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL)`)
    .bind(action === "later" || action === "unknown" ? action : "answered",
      yes || action === EXEMPTION_NO ? action : null, now, accountId, wardId, projectId, questionId, wardId, projectId));
  const saved = await db.batch(statements);
  if (saved.at(-1)?.meta.changes !== 1) return "failed";
  if (yes && row.kind === "duty") {
    try {
      if (!(await prepareRota(db, wardId, projectId, accountId))) return "draft_failed";
    } catch { return "draft_failed"; }
  }
  return "saved";
}
