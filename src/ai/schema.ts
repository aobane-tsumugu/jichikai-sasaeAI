// 読み取り（Reading）の型と、モデルに返させる JSON スキーマ。
// 読むは Workers から Messages API への一回の呼び出し。出力はこのスキーマに縛る（output_config.format）。
// Word、Excel、文字のファイル、一行の文は、モデルを通さずに同じ形の読み取りにする（src/intake/direct-reading.ts）。
//
// 束 3 の下書きや差分の規則が読む形なので、キーの名前を変える時は PM に言う。

/** 包みの版。どの版で読んだかを readings に残し、直した後に古い版で読んだ物を選んで読み直せるようにする。 */
export const READ_PACK_VERSION = {
  general: "read-general@5",
  answer_sheet: "read-answer-sheet@7",
  restore: "read-restore@5",
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
  "rules", // 規約、会則
  "meeting_papers", // 総会の資料、事業計画、決算
  "year_plan", // 年間の予定
  "officers", // 役員の一覧
  "photo", // 当日の写真など、文字の少ない物
  "other",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** 役員が知っておくことの基本の項目。src/know/store.ts の KNOW_BASE と同じ鍵。 */
export const KNOW_TOPICS = ["officers", "board", "meeting", "roster", "notices", "delivery", "inquiries", "answers", "dues", "accounts", "city", "handover", "events", "duties", "safety"] as const;
export type KnowTopic = (typeof KNOW_TOPICS)[number];
export const KNOW_TOPIC_GUIDE = "officers=役員の一覧と任期と決め方、board=役員会と班長会の開き方、meeting=総会の決まりと規約、roster=名簿と班と加入の手続き、notices=案内と回覧の決まり、delivery=配り方と部数、inquiries=住民の連絡先と要望の出し方、answers=出欠の集め方、dues=会費の額と集め方と募金、accounts=予算と決算と補助金、city=市の担当の窓口と毎年の依頼、handover=書類の場所と備品と引き継ぎ、events=毎年の行事と業者と保険、duties=ごみ集積所の当番と清掃の決まり、safety=防災の組織と訓練と集会所と防犯灯";

/** 一つの行事に限らない、区全体の決まりや情報。 */
export interface WardFact { original_id: string; topic: KnowTopic; text: string }
/** 年間の予定に書かれた一行。 */
export interface YearEntry { original_id: string; title: string; month: number | null; date_text: string }

export function cleanWardFacts(value: unknown, originalIds: string[]): WardFact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    if (typeof item.text !== "string" || !item.text.trim() || !KNOW_TOPICS.some((topic) => topic === item.topic)) return [];
    const original = typeof item.original_id === "string" && originalIds.includes(item.original_id) ? item.original_id : originalIds.length === 1 ? originalIds[0]! : "";
    return [{ original_id: original, topic: item.topic as KnowTopic, text: item.text.trim().slice(0, 500) }];
  });
}

export function cleanYearEntries(value: unknown, originalIds: string[]): YearEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    if (typeof item.title !== "string" || !item.title.trim() || item.title.trim().length > 100) return [];
    const month = typeof item.month === "number" && Number.isInteger(item.month) && item.month >= 1 && item.month <= 12 ? item.month : null;
    const original = typeof item.original_id === "string" && originalIds.includes(item.original_id) ? item.original_id : originalIds.length === 1 ? originalIds[0]! : "";
    return [{ original_id: original, title: item.title.trim(), month, date_text: typeof item.date_text === "string" ? item.date_text.slice(0, 200) : "" }];
  });
}

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

/** 資料に書かれた名前と、一年の予定のどの行か。資料の年や今年の決定は含めない。 */
export interface ProjectSuggestion {
  original_id: string;
  title: string;
  year_item?: string;
  /** 古い読み取りを読むためだけに残す。新しい読みでは書かせない。 */
  kind?: "event" | "general_meeting" | "city_request" | "board_meeting" | "duty" | "request";
  date_text?: string;
  place?: string;
}

/** 古いkindだけの読みも受け取る。新しい読みのyear_itemを落とさない。 */
export function cleanProjectSuggestions(value: unknown, originalIds: string[]): ProjectSuggestion[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const legacyKind = ["event", "general_meeting", "city_request", "board_meeting", "duty", "request"].includes(String(item.kind))
      ? item.kind as ProjectSuggestion["kind"] : undefined;
    if (typeof item.original_id !== "string" || !originalIds.includes(item.original_id) || seen.has(item.original_id)
      || typeof item.title !== "string" || !item.title.trim() || item.title.trim().length > 100
      || typeof item.year_item !== "string" && !legacyKind) return [];
    seen.add(item.original_id);
    return [{ original_id: item.original_id, title: item.title.trim(),
      ...(typeof item.year_item === "string" ? { year_item: item.year_item.trim() } : {}),
      ...(legacyKind ? { kind: legacyKind } : {}),
      date_text: typeof item.date_text === "string" ? item.date_text.slice(0, 2000) : "",
      place: typeof item.place === "string" ? item.place.slice(0, 2000) : "" }];
  });
}

export interface Reading {
  document_kind: DocumentKind;
  original_years: OriginalYear[];
  /** 一行の要約 */
  summary: string;
  project_suggestions?: ProjectSuggestion[];
  ward_facts?: WardFact[];
  year_entries?: YearEntry[];
  text_blocks: TextBlock[];
  fields: ReadField[];
  tables: ReadTable[];
  decisions: ReadDecision[];
  unreadable: ReadUnreadable[];
}

/** 回答票の読み取り。一枚に複数の票が写っている前提で、票ごとに一行。 */
export interface AnswerSheetRow {
  /** 総会の印。空欄、複数の印、判読不能はnull。行事の古い読み取りには無い。 */
  meeting_status?: "attend" | "proxy" | "absent" | null;
  /** 委任先。確認できる空欄は空文字、判読不能はnull。 */
  proxy_name?: string | null;
  household_name: string;
  /** 参加しないに印がある。古い読み取りには無い。 */
  not_attending?: boolean;
  /** 紙に印字された班名 */
  ward_group: string;
  /** 確認できる空欄は0、判読できない人数はnull。 */
  adults: number | null;
  children: number | null;
  /** 古い読み取りには欄が無い。現在は空欄0と判読不能nullを分ける。 */
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
  required: ["document_kind", "original_years", "summary", "project_suggestions", "ward_facts", "year_entries", "text_blocks", "fields", "tables", "decisions", "unreadable"],
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
        required: ["original_id", "title", "year_item", "date_text", "place"],
        properties: {
          original_id: str, title: str, year_item: str,
          date_text: str, place: str,
        },
      },
    },
    ward_facts: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["original_id", "topic", "text"],
        properties: { original_id: str, topic: { type: "string", enum: [...KNOW_TOPICS] }, text: str },
      },
    },
    year_entries: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["original_id", "title", "month", "date_text"],
        properties: { original_id: str, title: str, month: { anyOf: [{ type: "integer" }, { type: "null" }] }, date_text: str },
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
          "meeting_status",
          "proxy_name",
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
          meeting_status: { anyOf: [{ type: "string", enum: ["attend", "proxy", "absent"] }, { type: "null" }] },
          proxy_name: { anyOf: [str, { type: "null" }] },
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
