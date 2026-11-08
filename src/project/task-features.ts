// 機能は、外していないやることの仕事から決める。種類の列は互換の読み書きだけに残す。
import { ITEM_KEYS, type DocumentKind, type ItemKey, type ProjectKind } from "./model";
import { MAP_TEMPLATES, taskKeyOf, taskDraftKind } from "../map/template";

export type FeatureTask = { taskKey: string | null; name?: string };
export function taskFeatures(tasks: readonly FeatureTask[]) {
  const keys = new Set(tasks.map((task) => taskKeyOf(task.taskKey, task.name)));
  const has = (...values: string[]) => values.some((value) => keys.has(value));
  const meeting = has("agenda", "minutes", "delegation");
  // 総会は委任を集める仕事（answers）と議案または議事録を持つ。役員会は委任を集めない。
  const delegation = has("delegation") || meeting && has("answers");
  // 出欠を聞かないと役員が選んだ準備（projectTasks が NO_ANSWERS の印を足す）では、案内に返事の入口と回答票を付けない（L-319）。
  return { has, meeting, delegation, attendance: (has("answers", "delegation") || has("announcement") && !meeting) && !keys.has(NO_ANSWERS),
    // 名簿の順で回す当番は「担当を決める」（当番表を作る）がある時だけ。行事の「当番表と配置を決める」は手伝いの返事から AI が担当を入れる。
    rota: has("assign"), submit: has("submit"), request: has("submit") && has("content"),
    sponsors: has("sponsors"), committee: has("committee"), venue: has("venue") };
}
/** 出欠を聞かないと選んだ準備の印。やることの仕事ではなく、機能の判定にだけ使う。 */
export const NO_ANSWERS = "no_answers";

export async function projectTasks(db: D1Database, wardId: string, projectId: string): Promise<FeatureTask[]> {
  const [rows, project] = await Promise.all([
    db.prepare(`SELECT task_key, name FROM project_map_tasks
      WHERE ward_id = ? AND project_id = ? AND removed_at IS NULL ORDER BY sort_order, created_at`)
      .bind(wardId, projectId).all<{ task_key: string | null; name: string }>(),
    db.prepare("SELECT answers_off_at FROM projects WHERE ward_id = ? AND project_id = ?").bind(wardId, projectId).first<{ answers_off_at: string | null }>(),
  ]);
  return [...rows.results.map((row) => ({ taskKey: row.task_key, name: row.name })), ...(project?.answers_off_at ? [{ taskKey: NO_ANSWERS }] : [])];
}

/** 出欠を聞くかを選ぶ。聞かないと選んだ時と人は、役員の操作として残す。終わりにした準備は変えない。 */
export async function setAnswersOff(db: D1Database, wardId: string, projectId: string, accountId: string, off: boolean): Promise<boolean> {
  const result = await db.prepare("UPDATE projects SET answers_off_at = ?, answers_off_by = ? WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL")
    .bind(off ? new Date().toISOString() : null, off ? accountId : null, wardId, projectId).run();
  return (result.meta.changes ?? 0) === 1;
}
export async function projectFeatures(db: D1Database, wardId: string, projectId: string) {
  return taskFeatures(await projectTasks(db, wardId, projectId));
}
/** 既存の文書の指示と題を再利用するための対応。projects.kindは参照も更新もしない。 */
export function taskDocumentKind(tasks: readonly FeatureTask[], document: DocumentKind): ProjectKind {
  const f = taskFeatures(tasks);
  if (f.meeting) return f.delegation ? "general_meeting" : "board_meeting";
  if (f.submit && (["procedure", "report"].includes(document) || !f.attendance && !f.rota)) return f.request ? "request" : "city_request";
  if (f.has("assign", "duty_roster", "notify") && (document === "duty_roster" || !f.has("announcement"))) return "duty";
  return "event";
}
/** 使う項目も仕事で決める。元の資料の値は削除しない。 */
export function taskItemKeys(tasks: readonly FeatureTask[]): readonly ItemKey[] {
  const f = taskFeatures(tasks);
  return ITEM_KEYS.filter((key) => {
    if (key === "rain_plan" || key === "belongings") return f.attendance && !f.meeting;
    if (key === "helper_slots") return f.rota || f.has("answers");
    if (key === "date_time" || key === "place") return f.attendance || f.meeting || f.rota || f.venue;
    return true;
  });
}
export function taskCollectsAttendance(tasks: readonly FeatureTask[], document: string): boolean {
  return document === "announcement" && (!tasks.length || taskFeatures(tasks).attendance);
}

export function firstTaskDraft(tasks: readonly FeatureTask[]): DocumentKind {
  const task = tasks.find((entry) => {
    const key = taskKeyOf(entry.taskKey, entry.name);
    return Object.values(MAP_TEMPLATES).some((template) => template.some((task) => task.key === key && task.draftKind));
  });
  return taskDraftKind(task ? taskKeyOf(task.taskKey, task.name) : null);
}

/** 区内の一覧を一度に絞る。固定のSQLにし、区をまたぐ検査でも中身を読めるようにする。 */
export const MEETING_TASK_SQL = `EXISTS (SELECT 1 FROM project_map_tasks feature_task
  WHERE feature_task.ward_id = p.ward_id AND feature_task.project_id = p.project_id AND feature_task.removed_at IS NULL
    AND (feature_task.task_key IN ('agenda', 'minutes', 'delegation') OR (feature_task.task_key IS NULL
      AND feature_task.name IN ('議案を決める', '議題を集める', '議事録をまとめる', '決めたことをまとめる', '委任と出欠を集める'))))`;
export const DELEGATION_TASK_SQL = `EXISTS (SELECT 1 FROM project_map_tasks feature_task
  WHERE feature_task.ward_id = p.ward_id AND feature_task.project_id = p.project_id AND feature_task.removed_at IS NULL
    AND (feature_task.task_key = 'delegation' OR (feature_task.task_key IS NULL AND feature_task.name = '委任と出欠を集める')
      OR (${MEETING_TASK_SQL} AND (feature_task.task_key = 'answers' OR (feature_task.task_key IS NULL
        AND feature_task.name IN ('参加と手伝いの返事を集める', '出欠を集める'))))))`;
export const ROTA_TASK_SQL = `EXISTS (SELECT 1 FROM project_map_tasks feature_task
  WHERE feature_task.ward_id = p.ward_id AND feature_task.project_id = p.project_id AND feature_task.removed_at IS NULL
    AND (feature_task.task_key = 'assign' OR (feature_task.task_key IS NULL
      AND feature_task.name IN ('担当を決める', '当番表を作る'))))`;
/** 世帯ごとの当番・役の履歴に拾う準備。名簿の順で回す当番と、行事の手伝いの担当の両方。 */
export const DUTY_TABLE_TASK_SQL = `EXISTS (SELECT 1 FROM project_map_tasks feature_task
  WHERE feature_task.ward_id = p.ward_id AND feature_task.project_id = p.project_id AND feature_task.removed_at IS NULL
    AND (feature_task.task_key IN ('assign', 'duty_roster') OR (feature_task.task_key IS NULL
      AND feature_task.name IN ('担当を決める', '当番表を作る', '当番表と配置を決める'))))`;
export const REPORT_TASK_SQL = `EXISTS (SELECT 1 FROM project_map_tasks feature_task
  WHERE feature_task.ward_id = p.ward_id AND feature_task.project_id = p.project_id AND feature_task.removed_at IS NULL
    AND (feature_task.task_key = 'report' OR (feature_task.task_key IS NULL AND feature_task.name = '報告をまとめる')))`;
export const SUBMIT_TASK_SQL = `EXISTS (SELECT 1 FROM project_map_tasks feature_task
  WHERE feature_task.ward_id = p.ward_id AND feature_task.project_id = p.project_id AND feature_task.removed_at IS NULL
    AND (feature_task.task_key = 'submit' OR (feature_task.task_key IS NULL AND feature_task.name IN ('提出する', '出す'))))`;

export function distributedTaskKeys(tasks: readonly FeatureTask[], document: DocumentKind): string[] {
  return tasks.map((task) => taskKeyOf(task.taskKey, task.name)).filter((key): key is string =>
    key !== null && Object.values(MAP_TEMPLATES).some((template) => template.some((task) => task.key === key && task.draftKind === document)));
}
