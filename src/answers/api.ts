import { newId, nowIso } from "../core/ids";
import { SETTING_KEYS } from "../settings/keys";
import { listHelpOffers } from "./help";

export interface RosterEntry {
  household: string;
  district: string;
}

export interface AnswerInput extends RosterEntry {
  projectId: string;
  peopleCount: number;
  helperName?: string;
  helperTimes?: string;
  source: "web" | "phone" | "sheet" | "line";
  accountId?: string | null;
  originalId?: string | null;
  sheetRowIndex?: number;
}

export interface AnswerRow extends AnswerInput {
  answerId: string;
  createdAt: string;
}

export interface HelperRequest {
  name: string;
  times: string;
  household: string;
  district: string;
  answerId: string;
}

/** 配布時に入力された班ごとの部数を、名簿にある班だけに絞る。 */
export function parseDistribution(raw: string, districts: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
    const split = line.lastIndexOf(" ");
    const name = line.slice(0, split).trim();
    const count = Number(line.slice(split + 1).trim());
    if (split > 0 && districts.includes(name) && Number.isInteger(count) && count >= 0) counts[name] = count;
  }
  return counts;
}

export function normalizeHousehold(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ja");
}

function normalizeHeader(value: string): string {
  return value.normalize("NFKC").replace(/[\s　_*・:：]/g, "").toLocaleLowerCase("ja");
}

const HEADER_ALIASES = {
  household: ["世帯", "世帯名", "世帯主", "氏名", "名前", "household", "name"],
  district: ["班", "班名", "組", "組名", "district", "group"],
} as const;

export type RosterColumns = { household: number; district: number };

export function chooseRosterColumns(header: string[]): RosterColumns | null {
  const keys = header.map(normalizeHeader);
  const find = (names: readonly string[]) => keys.findIndex((key) => names.some((name) => key === normalizeHeader(name)));
  const household = find(HEADER_ALIASES.household);
  const district = find(HEADER_ALIASES.district);
  return household >= 0 && district >= 0 ? { household, district } : null;
}

/** RFC 4180 の引用符と改行に対応する軽量 CSV 読み取り。 */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (quoted) throw new Error("CSV の引用符が閉じていません。");
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value.trim() !== ""));
}

export function rowsToRoster(rows: string[][], columns?: RosterColumns): RosterEntry[] {
  if (rows.length < 2) throw new Error("見出しと世帯の行が必要です。");
  const header = rows[0];
  if (!header) throw new Error("見出しと世帯の行が必要です。");
  const selected = columns ?? chooseRosterColumns(header);
  if (!selected || selected.household === selected.district || selected.household < 0 || selected.district < 0) {
    throw new Error("世帯名と班の項目を選んでください。");
  }
  const entries: RosterEntry[] = [];
  for (const row of rows.slice(1)) {
    const household = (row[selected.household] ?? "").trim();
    const district = (row[selected.district] ?? "").trim();
    if (!household || !district) continue;
    entries.push({ household, district });
  }
  if (entries.length === 0 || entries.length > 10000) throw new Error("名簿の行数を確認してください。");
  return entries;
}

export async function replaceRoster(db: D1Database, wardId: string, entries: RosterEntry[], columns: RosterColumns): Promise<void> {
  const now = nowIso();
  const setId = newId();
  const districts = [...new Set(entries.map((entry) => entry.district))].sort();
  // 同じ名字の世帯は普通にある。名簿は書かれたまま受け、保存の時だけ番号で区別する。
  const seen = new Map<string, number>();
  const nextHouseholdKey = (household: string): string => {
    const key = normalizeHousehold(household);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1 ? key : `${key}#${count}`;
  };
  // D1 は一文の値の数が 100 までなので、一行 7 値で 14 行ずつ送る。
  for (let start = 0; start < entries.length; start += 14) {
    const batch = entries.slice(start, start + 14);
    const values = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const statement = db.prepare(
      `INSERT INTO ward_roster_entries (roster_entry_id, ward_id, roster_set_id, household, household_key, district, created_at) VALUES ${values}`,
    );
    const bindings = batch.flatMap((entry) => [newId(), wardId, setId, entry.household, nextHouseholdKey(entry.household), entry.district, now]);
    await statement.bind(...bindings).run();
  }
  await db.batch([
    db.prepare(
      `INSERT INTO ward_roster_settings (ward_id, active_set_id, columns_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(ward_id) DO UPDATE SET active_set_id = excluded.active_set_id, columns_json = excluded.columns_json, updated_at = excluded.updated_at`,
    ).bind(wardId, setId, JSON.stringify(columns), now),
    db.prepare(
      `INSERT INTO ward_settings (ward_id, key, value, updated_at, updated_by_account_id) VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(ward_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by_account_id = NULL`,
    ).bind(wardId, SETTING_KEYS.squads, JSON.stringify(districts), now),
  ]);
  await db.prepare("DELETE FROM ward_roster_entries WHERE ward_id = ? AND roster_set_id <> ?").bind(wardId, setId).run();
}

export async function getRoster(db: D1Database, wardId: string): Promise<RosterEntry[]> {
  const result = await db
    .prepare("SELECT e.household, e.district FROM ward_roster_entries e JOIN ward_roster_settings s ON s.ward_id = e.ward_id AND s.active_set_id = e.roster_set_id WHERE e.ward_id = ? ORDER BY e.district, e.household")
    .bind(wardId)
    .all<RosterEntry>();
  return result.results;
}

export async function getSavedRosterColumns(db: D1Database, wardId: string): Promise<RosterColumns | null> {
  const row = await db.prepare("SELECT columns_json FROM ward_roster_settings WHERE ward_id = ?").bind(wardId).first<{ columns_json: string }>();
  if (!row) return null;
  try {
    const columns = JSON.parse(row.columns_json) as Partial<RosterColumns>;
    return Number.isInteger(columns.household) && Number.isInteger(columns.district)
      ? { household: columns.household as number, district: columns.district as number }
      : null;
  } catch {
    return null;
  }
}

export async function getDistricts(db: D1Database, wardId: string): Promise<string[]> {
  const result = await db.prepare("SELECT DISTINCT e.district FROM ward_roster_entries e JOIN ward_roster_settings s ON s.ward_id = e.ward_id AND s.active_set_id = e.roster_set_id WHERE e.ward_id = ? ORDER BY e.district").bind(wardId).all<{ district: string }>();
  return result.results.map((row) => row.district);
}

export async function getDistrictCopies(db: D1Database, wardId: string): Promise<Array<{ district: string; copies: number }>> {
  const result = await db
    .prepare("SELECT e.district, COUNT(*) AS copies FROM ward_roster_entries e JOIN ward_roster_settings s ON s.ward_id = e.ward_id AND s.active_set_id = e.roster_set_id WHERE e.ward_id = ? GROUP BY e.district ORDER BY e.district")
    .bind(wardId)
    .all<{ district: string; copies: number }>();
  return result.results;
}

export async function addAnswer(db: D1Database, wardId: string, input: AnswerInput): Promise<string> {
  if (input.source === "sheet" && input.originalId && input.sheetRowIndex !== undefined) {
    const existing = await db.prepare(
      "SELECT answer_id FROM project_answers WHERE ward_id = ? AND project_id = ? AND original_id = ? AND sheet_row_index = ?",
    ).bind(wardId, input.projectId, input.originalId, input.sheetRowIndex).first<{ answer_id: string }>();
    if (existing) {
      const result = await db.prepare(
        `UPDATE project_answers SET household = ?, district = ?, people_count = ?, helper_name = ?, helper_times = ?, created_by_account_id = ?
         WHERE ward_id = ? AND project_id = ? AND original_id = ? AND sheet_row_index = ?
           AND EXISTS (SELECT 1 FROM projects p WHERE p.ward_id = project_answers.ward_id
             AND p.project_id = project_answers.project_id AND p.closed_at IS NULL)`,
      ).bind(input.household.trim(), input.district.trim(), input.peopleCount, input.helperName?.trim() ?? "", input.helperTimes?.trim() ?? "",
        input.accountId ?? null, wardId, input.projectId, input.originalId, input.sheetRowIndex).run();
      if ((result.meta.changes ?? 0) === 0) throw new Error("このプロジェクトは回答を受け付けていません。");
      return existing.answer_id;
    }
  }
  const answerId = newId();
  await db
    .prepare(
      `INSERT INTO project_answers (answer_id, ward_id, project_id, household, district, people_count, helper_name, helper_times, source, original_id, sheet_row_index, created_at, created_by_account_id)
       SELECT ?, ?, p.project_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM projects p
       WHERE p.ward_id = ? AND p.project_id = ? AND p.closed_at IS NULL`,
    )
    .bind(
      answerId,
      wardId,
      input.household.trim(),
      input.district.trim(),
      input.peopleCount,
      input.helperName?.trim() ?? "",
      input.helperTimes?.trim() ?? "",
      input.source,
      input.originalId ?? null,
      input.sheetRowIndex ?? null,
      nowIso(),
      input.accountId ?? null,
      wardId,
      input.projectId,
    )
    .run();
  const exists = await db.prepare("SELECT answer_id FROM project_answers WHERE ward_id = ? AND answer_id = ?").bind(wardId, answerId).first();
  if (!exists) throw new Error("このプロジェクトは回答を受け付けていません。");
  return answerId;
}

export async function listAnswers(db: D1Database, wardId: string, projectId: string): Promise<AnswerRow[]> {
  const result = await db
    .prepare(
      `SELECT answer_id AS answerId, project_id AS projectId, household, district, people_count AS peopleCount,
        helper_name AS helperName, helper_times AS helperTimes, source, original_id AS originalId, sheet_row_index AS sheetRowIndex, created_at AS createdAt
       FROM project_answers WHERE ward_id = ? AND project_id = ? ORDER BY created_at, answer_id`,
    )
    .bind(wardId, projectId)
    .all<AnswerRow>();
  return result.results;
}

export async function getAnswer(db: D1Database, wardId: string, projectId: string, answerId: string): Promise<AnswerRow | null> {
  return db.prepare(`SELECT answer_id AS answerId, project_id AS projectId, household, district, people_count AS peopleCount,
      helper_name AS helperName, helper_times AS helperTimes, source, original_id AS originalId,
      sheet_row_index AS sheetRowIndex, created_at AS createdAt
    FROM project_answers WHERE ward_id = ? AND project_id = ? AND answer_id = ?`)
    .bind(wardId, projectId, answerId).first<AnswerRow>();
}

/** 受け取った時の情報は残し、役員が直した回答を同じ一件に保存する。 */
export async function updateAnswer(
  db: D1Database, wardId: string, projectId: string, answerId: string,
  input: Pick<AnswerInput, "household" | "district" | "peopleCount" | "helperName" | "helperTimes">,
): Promise<boolean> {
  const result = await db.prepare(`UPDATE project_answers
    SET household = ?, district = ?, people_count = ?, helper_name = ?, helper_times = ?
    WHERE ward_id = ? AND project_id = ? AND answer_id = ?
      AND EXISTS (SELECT 1 FROM projects p WHERE p.ward_id = project_answers.ward_id
        AND p.project_id = project_answers.project_id AND p.closed_at IS NULL)`)
    .bind(input.household.trim(), input.district.trim(), input.peopleCount, input.helperName?.trim() ?? "",
      input.helperTimes?.trim() ?? "", wardId, projectId, answerId).run();
  return result.meta.changes === 1;
}

export async function deleteAnswer(db: D1Database, wardId: string, projectId: string, answerId: string): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM project_answers WHERE ward_id = ? AND project_id = ? AND answer_id = ?
    AND EXISTS (SELECT 1 FROM projects p WHERE p.ward_id = project_answers.ward_id
      AND p.project_id = project_answers.project_id AND p.closed_at IS NULL)`)
    .bind(wardId, projectId, answerId).run();
  return result.meta.changes === 1;
}

/** 年が省かれた締切はプロジェクトの年を使う。日付が複数ある時や、読めない時は任せない。 */
export function answerDeadlineFromDraft(body: string, projectYear: number): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { items?: unknown }).items)) return null;
  const items: unknown[] = (parsed as { items: unknown[] }).items;
  const dueItems = items.filter((item): item is { key: string; content: string } =>
    typeof item === "object" && item !== null && (item as { key?: unknown }).key === "due" &&
    typeof (item as { content?: unknown }).content === "string");
  if (dueItems.length !== 1) return null;
  const dates = [...dueItems[0]!.content.normalize("NFKC").matchAll(
    /(?<!\d)(?:(\d{4})\s*(?:年|[-/])\s*)?(\d{1,2})\s*(?:月|[-/])\s*(\d{1,2})(?:\s*日)?(?!\d)/g,
  )];
  if (dates.length !== 1) return null;
  const date = dates[0]!;
  const dueOn = `${date[1] ?? projectYear}-${date[2]!.padStart(2, "0")}-${date[3]!.padStart(2, "0")}`;
  const timestamp = Date.parse(`${dueOn}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === dueOn ? dueOn : null;
}

export async function listUnansweredByDistrict(
  db: D1Database,
  wardId: string,
  projectId: string,
): Promise<Array<{ district: string; households: string[] }>> {
  const [roster, answers] = await Promise.all([getRoster(db, wardId), listAnswers(db, wardId, projectId)]);
  const keyOf = (entry: RosterEntry) => JSON.stringify([entry.district, normalizeHousehold(entry.household)]);
  const answered = new Set(answers.map(keyOf));
  const districts = new Map<string, string[]>();
  for (const entry of roster) {
    const members = districts.get(entry.district) ?? [];
    if (!answered.has(keyOf(entry))) members.push(entry.household);
    districts.set(entry.district, members);
  }
  return [...districts.keys()].sort().map((district) => ({ district, households: districts.get(district) ?? [] }));
}

export async function listHelperRequests(db: D1Database, wardId: string, projectId: string): Promise<HelperRequest[]> {
  const result = await db
    .prepare(
      `SELECT answer_id AS answerId, helper_name AS name, helper_times AS times, household, district
       FROM project_answers WHERE ward_id = ? AND project_id = ? AND helper_name <> '' ORDER BY district, helper_times, helper_name`,
    )
    .bind(wardId, projectId)
    .all<HelperRequest>();
  return result.results;
}

export async function getAnswerTotals(db: D1Database, wardId: string, projectId: string): Promise<{ people: number; helperRequests: number }> {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(people_count), 0) AS people,
       COALESCE(SUM(CASE WHEN helper_name <> '' THEN 1 ELSE 0 END), 0) AS helper_requests
     FROM project_answers WHERE ward_id = ? AND project_id = ?`,
  ).bind(wardId, projectId).first<{ people: number; helper_requests: number }>();
  return { people: row?.people ?? 0, helperRequests: row?.helper_requests ?? 0 };
}

/** 束 3 の当番表の下書きが受け取る、回答から集めた手伝い希望。 */
export async function getDutyDraftHelpers(db: D1Database, wardId: string, projectId: string): Promise<HelperRequest[]> {
  const [helpers, offers] = await Promise.all([listHelperRequests(db, wardId, projectId), listHelpOffers(db, wardId, projectId)]);
  return [...helpers, ...offers.map((offer) => ({ name: offer.name, times: offer.times, household: "", district: "", answerId: offer.offerId }))];
}

export async function setAnswerDeadline(db: D1Database, wardId: string, projectId: string, dueOn: string, accountId: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn) || !Number.isFinite(Date.parse(`${dueOn}T00:00:00Z`))) throw new Error("締切の日付を確認してください。");
  const result = await db
    .prepare(
      `INSERT INTO project_deadlines (ward_id, project_id, kind, due_on, updated_at, updated_by_account_id)
       SELECT ?, p.project_id, 'answer_due', ?, ?, ? FROM projects p WHERE p.ward_id = ? AND p.project_id = ?
       ON CONFLICT (ward_id, project_id, kind) DO UPDATE SET due_on = excluded.due_on, updated_at = excluded.updated_at, updated_by_account_id = excluded.updated_by_account_id`,
    )
    .bind(wardId, dueOn, nowIso(), accountId, wardId, projectId)
    .run();
  if ((result.meta.changes ?? 0) === 0) throw new Error("プロジェクトが見つかりません。");
}

export async function getAnswerDeadline(db: D1Database, wardId: string, projectId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT due_on FROM project_deadlines WHERE ward_id = ? AND project_id = ? AND kind = 'answer_due'")
    .bind(wardId, projectId)
    .first<{ due_on: string }>();
  return row?.due_on ?? null;
}
