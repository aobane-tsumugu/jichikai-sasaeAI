// プロジェクトを開く、一覧、状態を引く（読む側）。区の ID は必ず where に入れる。
import { newId, nowIso } from "../core/ids";
import { addDays, MAP_TEMPLATES, templatePeriod } from "../map/template";
import { isCalendarDay } from "../core/time";
import {
  DEADLINE_KINDS,
  ITEM_LABEL,
  ITEMS_BY_KIND,
  PROJECT_KINDS,
  TABLE_KEYS,
  type Confidence,
  type DeadlineKind,
  type DocumentKind,
  type ItemKey,
  type MapProgress,
  type QuestionKind,
  type QuestionState,
  type RowData,
  type Scope,
  type SourceKind,
  type TableKey,
} from "./model";
import type {
  CreateProjectInput,
  DocumentSummary,
  ItemState,
  MapTaskView,
  ProjectState,
  ProjectSummary,
  QuestionView,
  RowView,
  SourceView,
  ValueView,
} from "./types";

export class ProjectInputError extends Error {
  override name = "ProjectInputError";
}

interface ProjectRow {
  project_id: string;
  kind: string;
  title: string;
  year: number;
  closed_at: string | null;
  state_version: number;
}

function toSummary(row: ProjectRow, deadlines: Partial<Record<DeadlineKind, string>>): ProjectSummary {
  return {
    projectId: row.project_id,
    kind: row.kind as ProjectSummary["kind"],
    title: row.title,
    year: row.year,
    closedAt: row.closed_at,
    stateVersion: row.state_version,
    deadlines,
  };
}

function groupDeadlines(rows: { project_id: string; kind: string; due_on: string }[]) {
  const map = new Map<string, Partial<Record<DeadlineKind, string>>>();
  for (const r of rows) {
    const entry = map.get(r.project_id) ?? {};
    if ((DEADLINE_KINDS as readonly string[]).includes(r.kind)) entry[r.kind as DeadlineKind] = r.due_on;
    map.set(r.project_id, entry);
  }
  return map;
}

/** 行事の日と、済んでいない仕事の時期を同じ書き込みで置く。資料からは既存の日を保つ。 */
export function eventDayStatements(
  db: D1Database, wardId: string, projectId: string, state: Pick<ProjectState, "project" | "mapTasks">,
  day: string, accountId: string | null, now: string, onlyIfMissing = false, endDay = day,
): D1PreparedStatement[] {
  const oldDay = state.project.deadlines.event_day;
  const oldEnd = state.project.deadlines.event_end ?? oldDay;
  const shift = oldDay ? Math.round((Date.parse(day) - Date.parse(oldDay)) / 86400000) : 0;
  const endShift = oldEnd ? Math.round((Date.parse(endDay) - Date.parse(oldEnd)) / 86400000) : 0;
  const template = MAP_TEMPLATES[state.project.kind] ?? [];
  const statements = ([["event_day", day], ["event_end", endDay]] as const).map(([kind, date]) => db.prepare(`INSERT INTO project_deadlines (ward_id, project_id, kind, due_on, updated_at, updated_by_account_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (ward_id, project_id, kind) DO ${onlyIfMissing ? "NOTHING" : `UPDATE SET due_on = excluded.due_on,
      updated_at = excluded.updated_at, updated_by_account_id = excluded.updated_by_account_id`}`)
    .bind(wardId, projectId, kind, date, now, accountId));
  for (const task of state.mapTasks) {
    if (task.progress === "done") continue;
    // 型に無い仕事（資料に当番表がある時に足す「担当を決める」など）は、同じ鍵の仕事をほかの型から探して日数を使う。
    const offsets = template.find((entry) => entry.key === task.taskKey)
      ?? (task.taskKey ? Object.values(MAP_TEMPLATES).flat().find((entry) => entry.key === task.taskKey) : undefined);
    const period = offsets ? templatePeriod(offsets, day, endDay) : null;
    // 時期のある仕事は日の動いた分だけずらし、時期の無い仕事には型の目安を置く。
    const start = task.periodStart ? oldDay ? addDays(task.periodStart, offsets && offsets.start > 0 ? endShift : shift) : task.periodStart : period?.start ?? null;
    const end = task.periodEnd ? oldDay ? addDays(task.periodEnd, offsets && (offsets.end > 0 || (offsets.start === 0 && offsets.end === 0)) ? endShift : shift) : task.periodEnd : period?.end ?? null;
    statements.push(db.prepare(`UPDATE project_map_tasks SET period_start = ?, period_end = ?
      WHERE ward_id = ? AND project_id = ? AND task_id = ? AND progress <> 'done' AND removed_at IS NULL
        AND EXISTS (SELECT 1 FROM project_deadlines WHERE ward_id = ? AND project_id = ? AND kind = 'event_day' AND due_on = ?)
        AND EXISTS (SELECT 1 FROM project_deadlines WHERE ward_id = ? AND project_id = ? AND kind = 'event_end' AND due_on = ?)`)
      .bind(start, end, wardId, projectId, task.taskId, wardId, projectId, day, wardId, projectId, endDay));
  }
  return statements;
}

/**
 * プロジェクトを開く。種類（行事、総会、市の依頼…）と題と年を受け、種類ごとの一般の地図を置く。
 * 題は後で直せる。去年の地図を種にする時の日付の置き直しは、束 7 の来年の種で行う。
 */
export async function createProject(db: D1Database, wardId: string, input: CreateProjectInput & { eventEnd?: string }): Promise<ProjectSummary> {
  if (!(PROJECT_KINDS as readonly string[]).includes(input.kind)) throw new ProjectInputError("種類が合いません");
  const title = input.title.trim();
  if (title === "" || title.length > 100) throw new ProjectInputError("題は1文字から100文字にしてください");
  if (!Number.isInteger(input.year) || input.year < 1900 || input.year > 2200) throw new ProjectInputError("年が合いません");
  if (input.eventDay !== undefined && !isCalendarDay(input.eventDay)) throw new ProjectInputError("始まる日を入れ直してください");
  if (input.eventEnd !== undefined && (!input.eventDay || !isCalendarDay(input.eventEnd) || input.eventEnd < input.eventDay)) throw new ProjectInputError("終わる日は始まる日以降にしてください");
  if (input.seedProjectId) {
    const seed = await db
      .prepare("SELECT 1 AS ok FROM projects WHERE ward_id = ? AND project_id = ?")
      .bind(wardId, input.seedProjectId)
      .first();
    if (!seed) throw new ProjectInputError("もとにするものが見つかりません");
  }

  const projectId = newId();
  const now = nowIso();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO projects (project_id, ward_id, kind, title, year, seed_project_id, created_at, created_by_account_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(projectId, wardId, input.kind, title, input.year, input.seedProjectId ?? null, now, input.accountId ?? null),
  ];
  if (input.eventDay) {
    for (const [kind, date] of [["event_day", input.eventDay], ["event_end", input.eventEnd ?? input.eventDay]]) statements.push(
      db
        .prepare(
          "INSERT INTO project_deadlines (ward_id, project_id, kind, due_on, updated_at, updated_by_account_id) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(wardId, projectId, kind, date, now, input.accountId ?? null),
    );
  }
  (MAP_TEMPLATES[input.kind] ?? []).filter((task) => !input.taskKeys || input.taskKeys.includes(task.key)).forEach((task, index) => {
    const period = input.eventDay ? templatePeriod(task, input.eventDay, input.eventEnd) : null;
    statements.push(
      db
        .prepare(
          `INSERT INTO project_map_tasks
             (task_id, ward_id, project_id, task_key, name, period_start, period_end, offset_start_days, offset_end_days, sort_order, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          newId(),
          wardId,
          projectId,
          task.key,
          task.name,
          period?.start ?? null,
          period?.end ?? null,
          task.start,
          task.end,
          index,
          now,
        ),
    );
  });
  await db.batch(statements);

  const created = await getProjectSummary(db, wardId, projectId);
  if (!created) throw new Error("作れませんでした");
  return created;
}

export async function getProjectSummary(db: D1Database, wardId: string, projectId: string): Promise<ProjectSummary | null> {
  const [projects, deadlines] = await db.batch<ProjectRow & { project_id: string; kind: string; due_on: string }>([
    db
      .prepare("SELECT project_id, kind, title, year, closed_at, state_version FROM projects WHERE ward_id = ? AND project_id = ?")
      .bind(wardId, projectId),
    db
      .prepare("SELECT project_id, kind, due_on FROM project_deadlines WHERE ward_id = ? AND project_id = ?")
      .bind(wardId, projectId),
  ]);
  const row = projects?.results[0];
  if (!row) return null;
  const grouped = groupDeadlines((deadlines?.results ?? []) as { project_id: string; kind: string; due_on: string }[]);
  return toSummary(row, grouped.get(projectId) ?? {});
}

/** 開いているプロジェクトの一覧（年の新しい順）。束 2 の MCP の手「開いているプロジェクトを引く」が呼ぶ。 */
export async function listOpenProjects(db: D1Database, wardId: string): Promise<ProjectSummary[]> {
  return listProjects(db, wardId, { includeClosed: false });
}

export async function listProjects(
  db: D1Database,
  wardId: string,
  options: { includeClosed?: boolean } = {},
): Promise<ProjectSummary[]> {
  const where = options.includeClosed ? "" : "AND closed_at IS NULL";
  const [projects, deadlines] = await db.batch([
    db
      .prepare(
        `SELECT project_id, kind, title, year, closed_at, state_version FROM projects
         WHERE ward_id = ? AND is_ward_notices = 0 ${where} ORDER BY year DESC, created_at DESC`,
      )
      .bind(wardId),
    db
      .prepare(
        `SELECT d.project_id, d.kind, d.due_on FROM project_deadlines d
         JOIN projects p ON p.ward_id = d.ward_id AND p.project_id = d.project_id
         WHERE d.ward_id = ? AND p.is_ward_notices = 0 ${where.replace("closed_at", "p.closed_at")}`,
      )
      .bind(wardId),
  ]);
  const grouped = groupDeadlines((deadlines?.results ?? []) as { project_id: string; kind: string; due_on: string }[]);
  return ((projects?.results ?? []) as unknown as ProjectRow[]).map((row) => toSummary(row, grouped.get(row.project_id) ?? {}));
}

// ---- 状態 ----

/** メッセージの入口だけが使う。通常の準備の仕事や日付は置かず、年が変わっても閉じない。 */
export async function getOrCreateWardNotices(db: D1Database, wardId: string, year: number, accountId: string): Promise<ProjectSummary> {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new ProjectInputError("年が合いません");
  // 同時に作っても自治会・年の一つにそろう。既存の入れ物とその中身は更新しない。
  await db.prepare(`INSERT INTO projects (project_id, ward_id, kind, title, year, is_ward_notices, created_at, created_by_account_id)
    VALUES (?, ?, 'event', '自治会からの連絡', ?, 1, ?, ?)
    ON CONFLICT (ward_id, year) WHERE is_ward_notices = 1 DO NOTHING`)
    .bind(newId(), wardId, year, nowIso(), accountId).run();
  const row = await db.prepare(`SELECT project_id, kind, title, year, closed_at, state_version FROM projects
    WHERE ward_id = ? AND year = ? AND is_ward_notices = 1`).bind(wardId, year).first<ProjectRow>();
  if (!row) throw new Error("連絡事項を作れませんでした");
  return toSummary(row, {});
}

function sourceView(row: {
  source_kind: string | null;
  source_ref: string | null;
  source_locator: string | null;
  source_year: number | null;
}): SourceView {
  return {
    kind: (row.source_kind ?? "person") as SourceKind,
    ref: row.source_ref,
    locator: row.source_locator,
    year: row.source_year,
  };
}

interface ValueRow {
  value_id: string;
  item_key: string;
  scope: string;
  ref_year: number | null;
  content: string;
  source_kind: string;
  source_ref: string | null;
  source_locator: string | null;
  source_year: number | null;
  confidence: string;
  created_at: string;
}

export function toValueView(row: ValueRow): ValueView {
  return {
    valueId: row.value_id,
    content: row.content,
    scope: row.scope as ValueView["scope"],
    refYear: row.ref_year,
    source: sourceView(row),
    confidence: row.confidence as Confidence,
    createdAt: row.created_at,
  };
}

interface RowRow {
  row_id: string;
  table_key: string;
  scope: string;
  ref_year: number | null;
  match_key: string;
  data: string;
  person_fields: string;
  source_kind: string;
  source_ref: string | null;
  source_locator: string | null;
  source_year: number | null;
  confidence: string;
  updated_at: string;
}

export function toRowView(row: RowRow): RowView {
  return {
    rowId: row.row_id,
    table: row.table_key as TableKey,
    scope: row.scope as RowView["scope"],
    refYear: row.ref_year,
    matchKey: row.match_key,
    data: JSON.parse(row.data) as RowData,
    personFields: JSON.parse(row.person_fields) as string[],
    source: sourceView(row),
    confidence: row.confidence as Confidence,
    updatedAt: row.updated_at,
  };
}

/** 参考の中身は、新しい年が先、年不明は最後。 */
function byRefYearDesc(a: { refYear: number | null }, b: { refYear: number | null }): number {
  if (a.refYear === b.refYear) return 0;
  if (a.refYear === null) return 1;
  if (b.refYear === null) return -1;
  return b.refYear - a.refYear;
}

/**
 * プロジェクトの状態を引く。束 2 の MCP の手「プロジェクトの状態を引く」と、役員画面が使う。
 * 原本そのものは含まない（原本の一覧は束 2 が持つ）。要る行は切り詰めず丸ごと返す。
 * 区をまたいで引かない。区の ID の合わないプロジェクトは null。
 */
export async function getProjectState(db: D1Database, wardId: string, projectId: string): Promise<ProjectState | null> {
  const project = await getProjectSummary(db, wardId, projectId);
  if (!project) return null;

  const [values, rows, documents, questions, tasks] = await db.batch([
    db
      .prepare(
        `SELECT value_id, item_key, scope, ref_year, content, source_kind, source_ref, source_locator, source_year, confidence, created_at
         FROM project_item_values WHERE ward_id = ? AND project_id = ? AND superseded_at IS NULL ORDER BY created_at`,
      )
      .bind(wardId, projectId),
    db
      .prepare(
        `SELECT row_id, table_key, scope, ref_year, match_key, data, person_fields, source_kind, source_ref, source_locator, source_year, confidence, updated_at
         FROM project_rows WHERE ward_id = ? AND project_id = ? AND removed_at IS NULL ORDER BY created_at, row_id`,
      )
      .bind(wardId, projectId),
    db
      .prepare(
        `SELECT d.document_id, d.kind, d.title, d.scope, d.stale_since_version,
           (SELECT MAX(v.version_no) FROM document_versions v WHERE v.ward_id = d.ward_id AND v.document_id = d.document_id) AS latest,
           (SELECT MAX(v.version_no) FROM document_versions v
              WHERE v.ward_id = d.ward_id AND v.document_id = d.document_id AND v.published_at IS NOT NULL) AS published
         FROM documents d WHERE d.ward_id = ? AND d.project_id = ? ORDER BY d.created_at`,
      )
      .bind(wardId, projectId),
    db
      .prepare(
        `SELECT question_id, kind, text, target, detail, state, answer, source_kind, source_ref, source_locator, source_year, created_at
         FROM project_questions WHERE ward_id = ? AND project_id = ? AND state IN ('open', 'later') ORDER BY created_at, question_id`,
      )
      .bind(wardId, projectId),
    db
      .prepare(
        `SELECT task_id, task_key, name, period_start, period_end, offset_start_days, offset_end_days, sort_order, progress, progress_source_kind, progress_source_ref,
                progress_source_locator, progress_confidence, seat_id
         FROM project_map_tasks WHERE ward_id = ? AND project_id = ? AND removed_at IS NULL ORDER BY sort_order, created_at`,
      )
      .bind(wardId, projectId),
  ]);

  const valueRows = (values?.results ?? []) as unknown as ValueRow[];
  const items: ItemState[] = ITEMS_BY_KIND[project.kind].map((key: ItemKey) => {
    const mine = valueRows.filter((r) => r.item_key === key).map(toValueView);
    return {
      key,
      label: ITEM_LABEL[key],
      current: mine.find((v) => v.scope === "current") ?? null,
      references: mine.filter((v) => v.scope === "reference").sort(byRefYearDesc),
    };
  });

  const tables = Object.fromEntries(TABLE_KEYS.map((key) => [key, [] as RowView[]])) as Record<TableKey, RowView[]>;
  for (const r of (rows?.results ?? []) as unknown as RowRow[]) tables[r.table_key as TableKey].push(toRowView(r));

  const documentList: DocumentSummary[] = (
    (documents?.results ?? []) as unknown as {
      document_id: string;
      kind: string;
      title: string;
      scope: string;
      stale_since_version: number | null;
      latest: number | null;
      published: number | null;
    }[]
  ).map((d) => ({
    documentId: d.document_id,
    kind: d.kind as DocumentKind,
    title: d.title,
    scope: d.scope as Scope,
    stale: d.stale_since_version !== null,
    latestVersionNo: d.latest,
    publishedVersionNo: d.published,
  }));

  const questionList: QuestionView[] = (
    (questions?.results ?? []) as unknown as {
      question_id: string;
      kind: string;
      text: string;
      target: string | null;
      detail: string | null;
      state: string;
      answer: string | null;
      source_kind: string | null;
      source_ref: string | null;
      source_locator: string | null;
      source_year: number | null;
      created_at: string;
    }[]
  ).map((q) => {
    const detail = q.detail ? (JSON.parse(q.detail) as { options?: string[] }) : null;
    return {
      questionId: q.question_id,
      kind: q.kind as QuestionKind,
      text: q.text,
      target: q.target,
      options: detail?.options ?? null,
      state: q.state as QuestionState,
      answer: q.answer,
      source: q.source_kind ? sourceView(q) : null,
      createdAt: q.created_at,
    };
  });

  const taskList = toMapTaskViews((tasks?.results ?? []) as unknown as MapTaskRow[], project);

  return { project, items, tables, documents: documentList, questions: questionList, mapTasks: taskList };
}

/** やることの表の行を、画面で使う形にする。準備ごとの中身と、まとめて読む時の両方で使う。 */
type MapTaskRow = {
  task_id: string; task_key: string | null; name: string; period_start: string | null; period_end: string | null;
  offset_start_days: number | null; offset_end_days: number | null; sort_order: number; progress: string;
  progress_source_kind: string | null; progress_source_ref: string | null; progress_source_locator: string | null;
  progress_confidence: string | null; seat_id: string | null;
};
function toMapTaskViews(rows: readonly MapTaskRow[], project: ProjectSummary): MapTaskView[] {
  return (
    rows as {
      task_id: string;
      task_key: string | null;
      name: string;
      period_start: string | null;
      period_end: string | null;
      offset_start_days: number | null;
      offset_end_days: number | null;
      sort_order: number;
      progress: string;
      progress_source_kind: string | null;
      progress_source_ref: string | null;
      progress_source_locator: string | null;
      progress_confidence: string | null;
      seat_id: string | null;
    }[]
  ).map((t) => {
    const template = MAP_TEMPLATES[project.kind]?.find((entry) => entry.key === t.task_key);
    const day = project.deadlines.event_day;
    const expected = template && day ? templatePeriod(template, day, project.deadlines.event_end ?? day) : null;
    return {
      taskId: t.task_id,
      taskKey: t.task_key,
      name: t.name,
      periodStart: t.period_start,
      periodEnd: t.period_end,
      // 手で時期を変えた仕事は日で示す。進み具合だけの変更では目安を保つ。
      periodEstimated: !!template && t.offset_start_days === template.start && t.offset_end_days === template.end
        && (!t.period_start || t.period_start === expected?.start) && (!t.period_end || t.period_end === expected?.end),
      sortOrder: t.sort_order,
      progress: t.progress as MapProgress,
      progressSource: t.progress_source_kind
        ? sourceView({
            source_kind: t.progress_source_kind,
            source_ref: t.progress_source_ref,
            source_locator: t.progress_source_locator,
            source_year: null,
          })
        : null,
      progressConfidence: (t.progress_confidence as Confidence | null) ?? null,
      seatId: t.seat_id,
    };
  });
}

/**
 * 準備中の物のやることを、一回の問い合わせでまとめて読む。トップと一年の画面は、準備ごとの中身のうちやることしか使わない。
 * 準備ごとに中身を全部読むと、準備が多い自治会で一回の画面に数千の問い合わせが重なり、D1 が詰まって失敗する。
 */
export interface OpenProjectBrief extends Pick<ProjectState, "mapTasks"> {
  /** 去年など前の年の資料にある「いつ」。日が決まっていない準備の行に書く。 */
  dateReference: { content: string; refYear: number | null } | null;
}
export async function listOpenMapTasks(db: D1Database, wardId: string, projects: readonly ProjectSummary[]): Promise<OpenProjectBrief[]> {
  const rows = await db.prepare(`SELECT t.project_id, t.task_id, t.task_key, t.name, t.period_start, t.period_end, t.offset_start_days, t.offset_end_days,
      t.sort_order, t.progress, t.progress_source_kind, t.progress_source_ref, t.progress_source_locator, t.progress_confidence, t.seat_id
    FROM project_map_tasks t JOIN projects p ON p.ward_id = t.ward_id AND p.project_id = t.project_id
    WHERE t.ward_id = ? AND t.removed_at IS NULL AND p.closed_at IS NULL ORDER BY t.project_id, t.sort_order, t.created_at`)
    .bind(wardId).all<MapTaskRow & { project_id: string }>();
  const byProject = new Map<string, MapTaskRow[]>();
  for (const row of rows.results) byProject.set(row.project_id, [...(byProject.get(row.project_id) ?? []), row]);
  const dates = await db.prepare(`SELECT v.project_id, v.content, v.ref_year FROM project_item_values v
    JOIN projects p ON p.ward_id = v.ward_id AND p.project_id = v.project_id
    WHERE v.ward_id = ? AND v.item_key = 'date_time' AND v.scope = 'reference' AND v.superseded_at IS NULL AND p.closed_at IS NULL
    ORDER BY v.project_id, COALESCE(v.ref_year, -1) DESC, v.created_at`)
    .bind(wardId).all<{ project_id: string; content: string; ref_year: number | null }>();
  const dateOf = new Map<string, { content: string; refYear: number | null }>();
  for (const row of dates.results) if (!dateOf.has(row.project_id)) dateOf.set(row.project_id, { content: row.content, refYear: row.ref_year });
  return projects.map((project) => ({ mapTasks: toMapTaskViews(byProject.get(project.projectId) ?? [], project), dateReference: dateOf.get(project.projectId) ?? null }));
}
