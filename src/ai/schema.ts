// 読み取り（Reading）の型と、モデルに返させる JSON スキーマ。
// 読むは Workers から Messages API への一回の呼び出し。出力はこのスキーマに縛る（output_config.format）。
// Word、Excel、文字のファイル、一行の文は、モデルを通さずに同じ形の読み取りにする（src/intake/direct-reading.ts）。
//
// 束 3 の下書きや差分の規則が読む形なので、キーの名前を変える時は PM に言う。

/** 包みの版。どの版で読んだかを readings に残し、直した後に古い版で読んだ物を選んで読み直せるようにする。 */
export const READ_PACK_VERSION = {
  general: "read-general@3",
  answer_sheet: "read-answer-sheet@4",
  restore: "read-restore@3",
  /** モデルを通さない読み取り（Word、Excel、文字） */
  direct: "read-direct@2",
} as const;

export type Confidence = "high" | "medium" | "low";

/** 資料の種類の見立て。分からなければ other。 */
export const DOCUMENT_KINDS = [
  "announcement", // 案内、お知らせ、募集
  "roster", // 名簿
  "sponsors", // 協賛先の一覧
  "receipt", // 領収書、レシート
  "layout", // 配置図
  "rota", // 当番表
  "report", // 実施報告
  "notice", // 市などからの通知
  "memo", // 役員会のメモ、会計のメモ、電話のメモ
  "answer_sheet", // 回答票
  "photo", // 当日の写真など、文字の少ない物
  "other",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export interface TextBlock {
  original_id: string;
  /** 元の箇所。例「1 枚目 上」「3 ページ」「段落 2」 */
  locator: string;
  text: string;
}

export interface ReadField {
  /** 項目の名前。日時、場所、雨天時、行事の中身、持ち物、手伝いの時間帯、締切、公開用の連絡先、またはそれ以外の名前 */
  name: string;
  value: string;
  confidence: Confidence;
  original_id: string;
  locator: string;
  /** 紙面に印字されたプロジェクト・文書・配布回の符号。無い場合は空文字。 */
  paper_code?: string;
}

export interface ReadRow {
  cells: string[];
  locator: string;
  confidence: Confidence;
}

export interface ReadTable {
  /** 表の名前。協賛先、当番、配置、収支、実行委員、世帯、答え、またはそれ以外の名前 */
  name: string;
  original_id: string;
  locator: string;
  columns: string[];
  rows: ReadRow[];
}

export interface ReadDecision {
  text: string;
  confidence: Confidence;
  original_id: string;
  locator: string;
}

export interface ReadUnreadable {
  original_id: string;
  locator: string;
  note: string;
}

export interface OriginalYear {
  original_id: string;
  /** この原本に書かれた年。書かれていなければ null。他の原本の年を使わない。 */
  year: number | null;
}

/** 行事の見立て。資料の年や今年の決定は含めない。古い読み取りには無い。 */
export interface ProjectSuggestion {
  original_id: string;
  title: string;
  kind: "event" | "general_meeting" | "city_request" | "board_meeting" | "duty" | "request";
  date_text?: string;
  place?: string;
}

export interface Reading {
  document_kind: DocumentKind;
  original_years: OriginalYear[];
  /** 一行の要約 */
  summary: string;
  project_suggestions?: ProjectSuggestion[];
  text_blocks: TextBlock[];
  fields: ReadField[];
  tables: ReadTable[];
  decisions: ReadDecision[];
  unreadable: ReadUnreadable[];
}

/** 回答票の読み取り。一枚に複数の票が写っている前提で、票ごとに一行。 */
export interface AnswerSheetRow {
  household_name: string;
  /** 参加しないに印がある。古い読み取りには無い。 */
  not_attending?: boolean;
  /** 紙に印字された班名 */
  ward_group: string;
  adults: number | null;
  children: number | null;
  seniors?: number | null;
  helper_names: string[];
  /** 手伝いの時間帯（準備と設営、受付、模擬店、片付けなど。書かれたまま） */
  helper_slots: string[];
  note: string;
  confidence: Confidence;
  original_id: string;
  locator: string;
  /** 回答票の紙面に印字された符号。無い場合は空文字。 */
  paper_code?: string;
}

export interface AnswerSheetReading {
  summary: string;
  rows: AnswerSheetRow[];
  unreadable: ReadUnreadable[];
}

/** D1 の readings.body に入る形。回答票は rows を持つので別の型にする。 */
export type ReadingBody = Reading | AnswerSheetReading;

const confidence = { type: "string", enum: ["high", "medium", "low"] } as const;
const str = { type: "string" } as const;

const unreadableSchema = {
  type: "object",
  additionalProperties: false,
  required: ["original_id", "locator", "note"],
  properties: { original_id: str, locator: str, note: str },
} as const;

/** 一般の読み。モデルの出力の形（スキーマ）。 */
export const GENERAL_READING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["document_kind", "original_years", "summary", "project_suggestions", "text_blocks", "fields", "tables", "decisions", "unreadable"],
  properties: {
    document_kind: { type: "string", enum: [...DOCUMENT_KINDS] },
    original_years: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["original_id", "year"],
        properties: { original_id: str, year: { anyOf: [{ type: "integer" }, { type: "null" }] } },
      },
    },
    summary: str,
    project_suggestions: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["original_id", "title", "kind", "date_text", "place"],
        properties: {
          original_id: str, title: str,
          date_text: str, place: str,
          kind: { type: "string", enum: ["event", "general_meeting", "city_request", "board_meeting", "duty", "request"] },
        },
      },
    },
    text_blocks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["original_id", "locator", "text"],
        properties: { original_id: str, locator: str, text: str },
      },
    },
    fields: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "value", "confidence", "original_id", "locator", "paper_code"],
        properties: { name: str, value: str, confidence, original_id: str, locator: str, paper_code: str },
      },
    },
    tables: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "original_id", "locator", "columns", "rows"],
        properties: {
          name: str,
          original_id: str,
          locator: str,
          columns: { type: "array", items: str },
          rows: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["cells", "locator", "confidence"],
              properties: { cells: { type: "array", items: str }, locator: str, confidence },
            },
          },
        },
      },
    },
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "confidence", "original_id", "locator"],
        properties: { text: str, confidence, original_id: str, locator: str },
      },
    },
    unreadable: { type: "array", items: unreadableSchema },
  },
} as const;

export const ANSWER_SHEET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "rows", "unreadable"],
  properties: {
    summary: str,
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "household_name",
          "not_attending",
          "ward_group",
          "adults",
          "children",
          "seniors",
          "helper_names",
          "helper_slots",
          "note",
          "confidence",
          "original_id",
          "locator",
          "paper_code",
        ],
        properties: {
          household_name: str,
          not_attending: { type: "boolean" },
          ward_group: str,
          adults: { anyOf: [{ type: "integer" }, { type: "null" }] },
          children: { anyOf: [{ type: "integer" }, { type: "null" }] },
          seniors: { anyOf: [{ type: "integer" }, { type: "null" }] },
          helper_names: { type: "array", items: str },
          helper_slots: { type: "array", items: str },
          note: str,
          confidence,
          original_id: str,
          locator: str,
          paper_code: str,
        },
      },
    },
    unreadable: { type: "array", items: unreadableSchema },
  },
} as const;

/** 回答票かどうかを見分ける（readings.body は二つの形のどちらか）。 */
export function isAnswerSheetReading(body: ReadingBody): body is AnswerSheetReading {
  return "rows" in body && Array.isArray((body as AnswerSheetReading).rows);
}

/** 保存済みの古い読み取りも原本ごとの形にする。複数原本に付いた一つの年は引き継がない。 */
export function normalizeOriginalYears(body: ReadingBody, originalIds: string[]): ReadingBody {
  if (isAnswerSheetReading(body)) return body;
  const { document_year: legacyYear, ...reading } = body as Reading & { document_year?: number | null };
  return {
    ...reading,
    original_years: originalIds.map((original_id) => {
      const entry = reading.original_years?.find((value) => value.original_id === original_id);
      const year = entry ? entry.year : !reading.original_years && originalIds.length === 1 ? legacyYear : null;
      return { original_id, year: typeof year === "number" && Number.isInteger(year) ? year : null };
    }),
  };
}
