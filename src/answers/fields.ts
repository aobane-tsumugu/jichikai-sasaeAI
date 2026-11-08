import { newId, nowIso } from "../core/ids";
import { formatJstDate } from "../core/time";

/**
 * 返事で聞く欄（L-317）。名前、参加するかどうか、人数はいつも聞き、それ以外を準備ごとに役員が足し外しする。
 * 一つの定義から Web の返事、電話の返事を入れる画面、紙の回答票、答えの一覧に出す（前提 3。二重の原稿を作らない）。
 */
export type AnswerFieldKind = "days" | "district" | "text";

export interface AnswerField {
  fieldId: string;
  kind: AnswerFieldKind;
  label: string;
  options: string[];
  multiple: boolean;
}

export type FieldValues = Record<string, string | string[]>;

export const FIELD_KIND_LABEL: Record<AnswerFieldKind, string> = { days: "日を選ぶ", district: "班", text: "自由に書く" };
const DEFAULT_LABEL: Record<AnswerFieldKind, string> = { days: "参加できる日", district: "班", text: "ひとこと" };
const MAX_FIELDS = 8;
const MAX_OPTIONS = 14;
export const TEXT_ANSWER_LIMIT = 200;

interface FieldRow { field_id: string; kind: AnswerFieldKind; label: string; options: string; multiple: number; removed_at: string | null }

function parseOptions(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch { return []; }
}

/** 一行に一つで書いた選ぶ物を、重ならない一覧にする。 */
export function optionsFromText(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((line) => line.trim().slice(0, 40)).filter(Boolean))].slice(0, MAX_OPTIONS);
}

/** 準備の欄の設定。班の行が無い時は、班の名前がある自治会では班を聞く（今までどおり）。 */
export async function getAnswerFields(db: D1Database, wardId: string, projectId: string, squads: readonly string[]): Promise<{ fields: AnswerField[]; districtAsked: boolean; districtRemoved: boolean }> {
  const rows = (await db.prepare(`SELECT field_id, kind, label, options, multiple, removed_at FROM project_answer_fields
    WHERE ward_id = ? AND project_id = ? ORDER BY sort_order, created_at, field_id`).bind(wardId, projectId).all<FieldRow>()).results;
  const district = rows.find((row) => row.kind === "district");
  const districtRemoved = Boolean(district?.removed_at);
  // 班の名前が無い自治会では、選べるのが「分からない」一つになるので、班を聞かない（前からの決まり）。
  const districtAsked = squads.length > 0 && !districtRemoved;
  const fields = rows.filter((row) => !row.removed_at && row.kind !== "district").map((row) => ({
    fieldId: row.field_id, kind: row.kind, label: row.label, options: parseOptions(row.options), multiple: row.multiple === 1,
  }));
  return { fields, districtAsked, districtRemoved };
}

/** 行事の日から、日を選ぶ欄の候補を作る（何日かにわたる行事の日を一日ずつ）。一日だけの時は空にして役員が書く。 */
export function dayOptions(eventDay: string | null | undefined, eventEnd: string | null | undefined): string[] {
  if (!eventDay || !eventEnd || eventEnd <= eventDay) return [];
  const days: string[] = [];
  for (let at = Date.parse(`${eventDay}T00:00:00Z`); at <= Date.parse(`${eventEnd}T00:00:00Z`) && days.length < MAX_OPTIONS; at += 86400_000) {
    days.push(formatJstDate(new Date(at).toISOString().slice(0, 10)));
  }
  return days;
}

/** 欄を足す。班は外した行を戻す。足せた欄の番号を返す。 */
export async function addAnswerField(db: D1Database, wardId: string, projectId: string, kind: AnswerFieldKind, accountId: string, init: { label?: string; options?: string[]; multiple?: boolean } = {}): Promise<string | null> {
  const project = await db.prepare("SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL").bind(wardId, projectId).first();
  if (!project) return null;
  if (kind === "district") {
    const existing = await db.prepare("SELECT field_id FROM project_answer_fields WHERE ward_id = ? AND project_id = ? AND kind = 'district'").bind(wardId, projectId).first<{ field_id: string }>();
    if (existing) {
      await db.prepare("UPDATE project_answer_fields SET removed_at = NULL WHERE ward_id = ? AND field_id = ?").bind(wardId, existing.field_id).run();
      return existing.field_id;
    }
  } else {
    const count = await db.prepare("SELECT COUNT(*) AS n FROM project_answer_fields WHERE ward_id = ? AND project_id = ? AND removed_at IS NULL AND kind <> 'district'").bind(wardId, projectId).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_FIELDS) return null;
  }
  const fieldId = newId();
  const order = await db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM project_answer_fields WHERE ward_id = ? AND project_id = ?").bind(wardId, projectId).first<{ n: number }>();
  await db.prepare(`INSERT INTO project_answer_fields (ward_id, project_id, field_id, kind, label, options, multiple, sort_order, created_at, created_by_account_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(wardId, projectId, fieldId, kind, (init.label?.trim() || DEFAULT_LABEL[kind]).slice(0, 40),
    JSON.stringify(kind === "days" ? (init.options ?? []).slice(0, MAX_OPTIONS) : []), init.multiple === false ? 0 : 1, order?.n ?? 1, nowIso(), accountId).run();
  return fieldId;
}

/** 名前と選ぶ物を直す。 */
export async function updateAnswerField(db: D1Database, wardId: string, projectId: string, fieldId: string, input: { label: string; options: string[]; multiple: boolean }): Promise<boolean> {
  const label = input.label.trim().slice(0, 40);
  if (!label) return false;
  const result = await db.prepare(`UPDATE project_answer_fields SET label = ?, options = ?, multiple = ?
    WHERE ward_id = ? AND project_id = ? AND field_id = ? AND kind <> 'district' AND removed_at IS NULL
      AND EXISTS (SELECT 1 FROM projects p WHERE p.ward_id = project_answer_fields.ward_id AND p.project_id = project_answer_fields.project_id AND p.closed_at IS NULL)`)
    .bind(label, JSON.stringify(input.options.slice(0, MAX_OPTIONS)), input.multiple ? 1 : 0, wardId, projectId, fieldId).run();
  return (result.meta.changes ?? 0) === 1;
}

/** 欄を外す。今までの答えは消さない（戻した時にまた数える）。班は、外したことを行で残す。 */
export async function removeAnswerField(db: D1Database, wardId: string, projectId: string, fieldId: string, accountId: string): Promise<boolean> {
  const project = await db.prepare("SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL").bind(wardId, projectId).first();
  if (!project) return false;
  if (fieldId === "district") {
    const existing = await db.prepare("SELECT field_id FROM project_answer_fields WHERE ward_id = ? AND project_id = ? AND kind = 'district'").bind(wardId, projectId).first<{ field_id: string }>();
    if (existing) {
      await db.prepare("UPDATE project_answer_fields SET removed_at = ? WHERE ward_id = ? AND field_id = ?").bind(nowIso(), wardId, existing.field_id).run();
    } else {
      await db.prepare(`INSERT INTO project_answer_fields (ward_id, project_id, field_id, kind, label, sort_order, created_at, created_by_account_id, removed_at)
        VALUES (?, ?, ?, 'district', '班', 0, ?, ?, ?)`).bind(wardId, projectId, newId(), nowIso(), accountId, nowIso()).run();
    }
    return true;
  }
  const result = await db.prepare("UPDATE project_answer_fields SET removed_at = ? WHERE ward_id = ? AND project_id = ? AND field_id = ? AND removed_at IS NULL")
    .bind(nowIso(), wardId, projectId, fieldId).run();
  return (result.meta.changes ?? 0) === 1;
}

/** 送られた答えを、今の欄の定義に合わせて取り出す。選ぶ物に無い値と、長すぎる文は受けない。 */
/**
 * 返事を直す画面で、その返事で既に選ばれている日を、今の候補に無くても選べる物に足す。
 * 候補を直した後に、名前や人数だけを直して保存すると、前に選んだ日が黙って消えるため。住民の新しい返事には使わない。
 */
export function withAnsweredOptions(fields: readonly AnswerField[], values: FieldValues | undefined): AnswerField[] {
  return fields.map((field) => {
    if (field.kind !== "days") return field;
    const value = values?.[field.fieldId];
    const chosen = Array.isArray(value) ? value : value ? [value] : [];
    const extra = chosen.filter((option) => !field.options.includes(option));
    return extra.length ? { ...field, options: [...field.options, ...extra] } : field;
  });
}

export function readFieldValues(form: Record<string, unknown>, fields: readonly AnswerField[]): { values: FieldValues; error: string | null } {
  const values: FieldValues = {};
  for (const field of fields) {
    const raw = form[`field_${field.fieldId}`] ?? form[`field_${field.fieldId}[]`];
    const list = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
    if (field.kind === "days") {
      const chosen = [...new Set(list)].filter((entry) => field.options.includes(entry));
      if (chosen.length !== new Set(list).size) return { values, error: `「${field.label}」を選び直してください。` };
      if (!field.multiple && chosen.length > 1) return { values, error: `「${field.label}」は一つだけ選んでください。` };
      if (chosen.length) values[field.fieldId] = field.multiple ? chosen : chosen[0]!;
    } else if (field.kind === "text") {
      const text = list.join(" ");
      if (text.length > TEXT_ANSWER_LIMIT) return { values, error: `「${field.label}」は${TEXT_ANSWER_LIMIT}文字までにしてください。` };
      if (text) values[field.fieldId] = text;
    }
  }
  return { values, error: null };
}

export function parseFieldValues(raw: string | null | undefined): FieldValues {
  try {
    const value = JSON.parse(raw ?? "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, entry]): [string, string | string[]][] =>
      typeof entry === "string" ? [[key, entry]] : Array.isArray(entry) ? [[key, entry.filter((item): item is string => typeof item === "string")]] : []));
  } catch { return {}; }
}

/** 一つの答えを、画面に出す文にする。答えていない欄は空。 */
export function fieldValueText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join("、") : value ?? "";
}

/** 答えの一覧で欄ごとに数える。日を選ぶ欄は、日ごとの世帯と人数。自由に書く欄は、書いた世帯の数。答えていない返事は空のまま数える。 */
export function countFields(fields: readonly AnswerField[], answers: readonly { household: string; peopleCount: number; fieldValues?: FieldValues }[]): { field: AnswerField; lines: string[]; empty: number }[] {
  return fields.map((field) => {
    const answered = answers.filter((answer) => fieldValueText(answer.fieldValues?.[field.fieldId]).trim());
    const empty = answers.length - answered.length;
    if (field.kind === "days") {
      // 候補を直す前に届いた返事も、選ばれた日のまま数える。
      const options = [...new Set([...field.options, ...answered.flatMap((answer) => {
        const value = answer.fieldValues?.[field.fieldId];
        return Array.isArray(value) ? value : value ? [value] : [];
      })])];
      const lines = options.map((option) => {
        const chosen = answered.filter((answer) => {
          const value = answer.fieldValues?.[field.fieldId];
          return Array.isArray(value) ? value.includes(option) : value === option;
        });
        return `${option}は${chosen.length}世帯${chosen.length ? `（${chosen.reduce((sum, answer) => sum + answer.peopleCount, 0)}人）` : ""}です。`;
      });
      return { field, lines, empty };
    }
    return { field, lines: answered.length ? [`${answered.length}世帯が書きました。`] : ["まだだれも書いていません。"], empty };
  });
}

export interface FieldSuggestion {
  kinds: AnswerFieldKind[];
  /** 役員に見せる一文。どの資料の、どの欄や文から思い当たったかを書く。 */
  text: string;
}

const DAY_WORDS = /都合のよい日|都合の良い日|参加できる日|出られる日|日を選|希望日|希望の日/;

/**
 * この準備に届いた資料から、返事で聞く欄の候補を出す（L-317）。回答票に日や班の欄があった時と、案内に日を選べると書いてあった時。
 * 役員が押すまで足さない。AI に決めさせず、読み取りに書かれた欄と文だけを見る。今聞いている欄と、班の名前が無い自治会の班は出さない。
 */
/** 役員が「足さない」と押した準備か。押した時と人は、役員の操作として残す（AI の判断としては残さない）。 */
export async function suggestionsOff(db: D1Database, wardId: string, projectId: string): Promise<boolean> {
  const row = await db.prepare("SELECT answer_suggestions_off_at FROM projects WHERE ward_id = ? AND project_id = ?").bind(wardId, projectId).first<{ answer_suggestions_off_at: string | null }>();
  return Boolean(row?.answer_suggestions_off_at);
}

/** 候補を出さないようにする、または元に戻す。終わりにした準備は変えない。 */
export async function setSuggestionsOff(db: D1Database, wardId: string, projectId: string, accountId: string, off: boolean): Promise<boolean> {
  const result = await db.prepare("UPDATE projects SET answer_suggestions_off_at = ?, answer_suggestions_off_by = ? WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL")
    .bind(off ? nowIso() : null, off ? accountId : null, wardId, projectId).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function fieldSuggestions(db: D1Database, wardId: string, projectId: string, current: { fields: readonly AnswerField[]; districtAsked: boolean }, squads: readonly string[]): Promise<FieldSuggestion[]> {
  if (await suggestionsOff(db, wardId, projectId)) return [];
  const rows = (await db.prepare(`SELECT o.original_id, o.filename, r.body FROM jobs j
    JOIN originals o ON o.ward_id = j.ward_id AND o.job_id = j.job_id
    JOIN readings r ON r.ward_id = j.ward_id AND r.job_id = j.job_id
    WHERE j.ward_id = ? AND j.project_id = ? AND j.withdrawn_at IS NULL AND o.withdrawn_at IS NULL
    ORDER BY j.created_at, o.original_id LIMIT 60`).bind(wardId, projectId).all<{ original_id: string; filename: string; body: string }>()).results;
  const wantDays = !current.fields.some((field) => field.kind === "days");
  const wantDistrict = squads.length > 0 && !current.districtAsked;
  if (!wantDays && !wantDistrict) return [];
  const suggestions: FieldSuggestion[] = [];
  // 一つの資料に読み取りが二つある時（文字を取り出した物と、AI が読んだ物）も、どちらも見る。
  for (const row of rows) {
    let body: Record<string, unknown>;
    try { body = JSON.parse(row.body) as Record<string, unknown>; } catch { continue; }
    const name = row.filename || "届いた資料";
    if (Array.isArray(body.rows)) {
      // 書き込まれた回答票。班が書かれた行があれば、回答票に班の欄があった。
      const hasDistrict = body.rows.some((entry) => typeof (entry as { ward_group?: unknown }).ward_group === "string" && ((entry as { ward_group: string }).ward_group).trim());
      if (wantDistrict && hasDistrict) suggestions.push({ kinds: ["district"], text: `「${name}」の回答票には、班を聞く欄がありました。` });
      continue;
    }
    const fields = Array.isArray(body.fields) ? body.fields as { name?: unknown; value?: unknown }[] : [];
    const blocks = Array.isArray(body.text_blocks) ? body.text_blocks as { text?: unknown }[] : [];
    const tables = Array.isArray(body.tables) ? body.tables as { name?: unknown; columns?: unknown; rows?: { cells?: unknown }[] }[] : [];
    const labels = [...fields.map((field) => String(field.name ?? "")), ...tables.flatMap((table) => Array.isArray(table.columns) ? table.columns.map(String) : [])];
    const text = [String(body.summary ?? ""), ...fields.map((field) => `${String(field.name ?? "")} ${String(field.value ?? "")}`), ...blocks.map((block) => String(block.text ?? "")),
      ...tables.flatMap((table) => [String(table.name ?? ""), ...(Array.isArray(table.columns) ? table.columns.map(String) : []), ...(table.rows ?? []).flatMap((entry) => Array.isArray(entry.cells) ? entry.cells.map(String) : [])])].join("\n");
    if (body.document_kind === "answer_sheet" || /回答票/.test(text)) {
      const district = wantDistrict && (labels.some((label) => label.trim() === "班") || /(^|\n|\s)班(\s|$|（)/.test(text));
      const days = wantDays && (labels.some((label) => DAY_WORDS.test(label)) || DAY_WORDS.test(text));
      const kinds: AnswerFieldKind[] = [...(days ? ["days" as const] : []), ...(district ? ["district" as const] : [])];
      if (kinds.length) suggestions.push({ kinds, text: `「${name}」の回答票には、${kinds.map((kind) => kind === "days" ? "日" : "班").join("と")}を聞く欄がありました。` });
      continue;
    }
    // 引くのは、日を選べると書いた一続きの言葉だけにする（項目の名前や前後の文を引かない）。
    const sentence = text.split(/[\n。、\s　]/).map((line) => line.trim()).find((line) => DAY_WORDS.test(line));
    if (wantDays && sentence) suggestions.push({ kinds: ["days"], text: `「${name}」に「${sentence.length > 40 ? `${sentence.slice(0, 40)}…` : sentence}」とありました。` });
  }
  // 同じ型を何度も勧めない。日と班を一度に足せる回答票を先にし、あとは初めに見つかった資料の文だけを残す。
  const used = new Set<AnswerFieldKind>();
  return [...suggestions].sort((a, b) => b.kinds.length - a.kinds.length).flatMap((suggestion) => {
    const kinds = suggestion.kinds.filter((kind) => !used.has(kind));
    kinds.forEach((kind) => used.add(kind));
    return kinds.length === suggestion.kinds.length ? [suggestion] : [];
  });
}
