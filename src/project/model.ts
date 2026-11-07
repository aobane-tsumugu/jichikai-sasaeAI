import { formatJstDate } from "../core/time";
// プロジェクトの状態の型と定数（束 3）。設計書 5.2 の「プロジェクトの状態の型」の写し。
// 画面に出す言葉（label）はここに置く。内部の言葉（派生、差分、版、冪等、札、セッション、包み、列、縁）は画面に出さない。

export const PROJECT_KINDS = ["event", "general_meeting", "city_request", "board_meeting", "duty", "request"] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const PROJECT_KIND_LABEL: Record<ProjectKind, string> = {
  event: "行事",
  general_meeting: "総会",
  city_request: "市の依頼",
  board_meeting: "役員会",
  duty: "当番",
  request: "要望",
};

export const DEADLINE_KINDS = ["event_day", "answer_due", "submit_due", "board_meeting_day"] as const;
export type DeadlineKind = (typeof DEADLINE_KINDS)[number];

export const DEADLINE_LABEL: Record<DeadlineKind, string> = {
  event_day: "当日",
  answer_due: "返事の締切",
  submit_due: "提出期限",
  board_meeting_day: "役員会の日",
};

export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const CONFIDENCE_LABEL: Record<Confidence, string> = { high: "高", medium: "中", low: "低" };

/** 出どころの種類。original 原本、person 人の入力、web_answer Web の回答、ai_proposal AI の案。 */
export const SOURCE_KINDS = ["original", "person", "web_answer", "ai_proposal"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_KIND_LABEL: Record<SourceKind, string> = {
  original: "届いたもの",
  person: "役員が入力",
  web_answer: "Webの返事",
  ai_proposal: "AIの下書き",
};

/**
 * 出どころ。必ず持つ（出どころの無い中身は存在しない）。
 *
 * - original: ref に原本の ID。locator に原本の箇所（ページ、行、表のセル。写真全体なら「全体」）。
 *   year は資料の中の日付や年度から読んだ年。読めなければ空（年不明）。qr は役員画面から印刷した紙（QR の付いた紙）から読んだ物。
 * - person: accountId に入力した役員のアカウント。
 * - web_answer: ref に答えの ID（束 5）。
 * - ai_proposal: year に参考にした年（当番の案だけは年不明も可）。ref に参考にした原本の ID（あれば）。
 */
export interface Source {
  kind: SourceKind;
  ref?: string;
  locator?: string;
  year?: number;
  qr?: boolean;
  accountId?: string;
}

// ---- 項目 ----

export const ITEM_KEYS = [
  "date_time",
  "place",
  "rain_plan",
  "content",
  "belongings",
  "helper_slots",
  "due",
  "public_contact",
] as const;
export type ItemKey = (typeof ITEM_KEYS)[number];

export const ITEM_LABEL: Record<ItemKey, string> = {
  date_time: "日時",
  place: "場所",
  rain_plan: "雨のとき",
  content: "中身",
  belongings: "持ち物",
  helper_slots: "手伝いの時間帯",
  due: "締切",
  public_contact: "公開用の連絡先",
};

/** 画面と紙に出す項目の名前。ITEM_LABEL は AI と本文の見出しの突き合わせに使うので変えない。 */
export const ITEM_SCREEN_LABEL: Record<ItemKey, string> = {
  ...ITEM_LABEL, date_time: "いつ", place: "どこで", content: "内容", due: "返事の締切", public_contact: "連絡先",
};

/** 画面で数を読む言葉。10 以上は「件」にする。 */
export const countWord = (count: number) => `${count}${count > 0 && count < 10 ? "つ" : "件"}`;

/** プロジェクトの種類ごとに使う項目。画面に空の項目を並べる時と、AI に空の項目を見せる時の範囲。 */
export const ITEMS_BY_KIND: Record<ProjectKind, readonly ItemKey[]> = {
  event: ITEM_KEYS,
  general_meeting: ["date_time", "place", "content", "due", "public_contact"],
  city_request: ["content", "due", "public_contact"],
  board_meeting: ["date_time", "place", "content"],
  duty: ["date_time", "place", "content", "helper_slots", "due"],
  request: ["content", "due", "public_contact"],
};

export function isItemKey(value: unknown): value is ItemKey {
  return typeof value === "string" && (ITEM_KEYS as readonly string[]).includes(value);
}

// ---- 表の行 ----

export const TABLE_KEYS = ["sponsors", "duties", "layout", "ledger", "decisions", "submissions", "committee"] as const;
export type TableKey = (typeof TABLE_KEYS)[number];

type FieldType =
  | { type: "text" }
  /** 円の整数（0 以上）。 */
  | { type: "amount" }
  | { type: "enum"; values: readonly string[]; labels: Record<string, string> };

interface TableDef {
  label: string;
  fields: Record<string, { label: string; def: FieldType }>;
  /** 同じ相手かを決める列（この順に鍵を作る）。全部が空でない行だけを受ける。 */
  keyFields: readonly string[];
  /** 画面と問いの文で、その行を呼ぶ列。 */
  nameField: string;
  /** 照合の鍵に入れず、空でもよい列は optionalKeyFields。 */
  optionalKeyFields?: readonly string[];
}

const TEXT: FieldType = { type: "text" };
const AMOUNT: FieldType = { type: "amount" };

/**
 * 表の定義。答えの表は束 5 のもので、ここには無い。
 * 列の名前は AI の出力の型にもなるので、直したら包みの版を上げる。
 */
export const TABLES: Record<TableKey, TableDef> = {
  committee: {
    label: "実行委員名簿",
    fields: {
      name: { label: "名前", def: TEXT },
      role: { label: "役", def: TEXT },
      contact: { label: "連絡先", def: TEXT },
    },
    keyFields: ["name"],
    optionalKeyFields: ["role"],
    nameField: "name",
  },
  sponsors: {
    label: "協賛先",
    fields: {
      name: { label: "名前", def: TEXT },
      lastYearAmount: { label: "去年の額", def: AMOUNT },
      ask: { label: "今年の打診", def: TEXT },
      reply: {
        label: "返事",
        def: { type: "enum", values: ["yes", "no", "pending"], labels: { yes: "可", no: "不可", pending: "未" } },
      },
      amount: { label: "額", def: AMOUNT },
      note: { label: "メモ", def: TEXT },
    },
    keyFields: ["name"],
    nameField: "name",
  },
  duties: {
    label: "当番",
    fields: {
      slot: { label: "時間帯", def: TEXT },
      task: { label: "持ち場", def: TEXT },
      assignee: { label: "担当", def: TEXT },
      attendance: {
        label: "出席",
        def: { type: "enum", values: ["present", "absent"], labels: { present: "出席", absent: "欠席" } },
      },
      note: { label: "備考", def: TEXT },
    },
    keyFields: ["slot"],
    optionalKeyFields: ["task"],
    nameField: "slot",
  },
  layout: {
    label: "配置",
    fields: {
      spot: { label: "出店や場所の名前", def: TEXT },
      position: { label: "置く位置", def: TEXT },
      note: { label: "メモ", def: TEXT },
    },
    keyFields: ["spot"],
    nameField: "spot",
  },
  ledger: {
    label: "運営メモ",
    fields: {
      what: { label: "何に", def: TEXT },
      counterpart: { label: "どこに", def: TEXT },
      direction: {
        label: "収入か支出",
        def: { type: "enum", values: ["income", "expense"], labels: { income: "収入", expense: "支出" } },
      },
      amount: { label: "額", def: AMOUNT },
      date: { label: "日付", def: TEXT },
      receiptOriginalId: { label: "領収書の元の資料", def: TEXT },
      note: { label: "メモ", def: TEXT },
      contact: { label: "連絡先と、頼んだ人", def: TEXT },
      requestedOn: { label: "いつ頼んだか", def: TEXT },
      quantity: { label: "頼んだ内容の量", def: TEXT },
      estimate: { label: "見積りの額", def: AMOUNT },
      payment: { label: "払い方", def: TEXT },
      thanks: { label: "お礼の仕方", def: TEXT },
    },
    keyFields: ["direction", "counterpart"],
    optionalKeyFields: ["date"],
    nameField: "counterpart",
  },
  decisions: {
    label: "決めたこと",
    fields: {
      what: { label: "何を", def: TEXT },
      decidedOn: { label: "いつ", def: TEXT },
    },
    keyFields: ["what"],
    nameField: "what",
  },
  submissions: {
    label: "出したもの",
    fields: {
      what: { label: "何を", def: TEXT },
      to: { label: "どこへ", def: TEXT },
      submittedOn: { label: "いつ", def: TEXT },
    },
    keyFields: ["what"],
    optionalKeyFields: ["to"],
    nameField: "what",
  },
};

export function isTableKey(value: unknown): value is TableKey {
  return typeof value === "string" && (TABLE_KEYS as readonly string[]).includes(value);
}

export type RowData = Record<string, string | number>;

/**
 * 列の型を検査し、決まった列だけの行にして返す。合わなければ画面に出せる理由を返す。
 * 空の文字は「無い」として落とす。
 */
export function cleanRowData(table: TableKey, raw: unknown): { ok: true; data: RowData } | { ok: false; reason: string } {
  const def = TABLES[table];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: `${def.label}の行の形が合いません` };
  }
  const data: RowData = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    // 保存先を指す内部の名前は、紙や画面の項目の一覧には出さない。
    const field = def.fields[name] ?? (table === "ledger" && ["memoKey", "memoGroup"].includes(name) ? { label: "記録", def: TEXT } : undefined);
    if (!field) return { ok: false, reason: `${def.label}に「${name}」の項目はありません` };
    if (value === null || value === undefined || value === "") continue;
    switch (field.def.type) {
      case "text":
        if (typeof value !== "string" && typeof value !== "number") return { ok: false, reason: `${def.label}の「${field.label}」は文字で入れてください` };
        if (String(value).trim() !== "") data[name] = String(value).trim();
        break;
      case "amount":
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
          return { ok: false, reason: `${def.label}の「${field.label}」は0以上の整数の円で入れてください` };
        }
        data[name] = value;
        break;
      case "enum":
        if (typeof value !== "string" || !field.def.values.includes(value)) {
          return { ok: false, reason: `${def.label}の「${field.label}」の値が合いません` };
        }
        data[name] = value;
        break;
    }
  }
  for (const key of def.keyFields) {
    // 手で書く運営メモは、何も書かなくても同じ記録に戻れる。
    if (table === "ledger" && data.memoKey) continue;
    if (data[key] === undefined) {
      return { ok: false, reason: `${def.label}の行には「${def.fields[key]?.label ?? key}」が要ります` };
    }
  }
  return { ok: true, data };
}

/** 画面に出す列の値（列挙は日本語に、額は円に）。 */
export function displayFieldValue(table: TableKey, name: string, value: string | number | undefined): string {
  if (value === undefined) return "";
  const field = TABLES[table].fields[name];
  if (field?.def.type === "enum") return field.def.labels[String(value)] ?? String(value);
  if (field?.def.type === "amount") return `${Number(value).toLocaleString("ja-JP")}円`;
  if (["date", "decidedOn", "submittedOn"].includes(name) && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) return formatJstDate(String(value));
  return String(value);
}

// ---- 文書 ----

export const DOCUMENT_KINDS = ["announcement", "recruitment", "duty_roster", "procedure", "notice", "report"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = {
  announcement: "案内",
  recruitment: "手伝いの募集",
  duty_roster: "当番表",
  procedure: "進め方",
  notice: "連絡",
  report: "報告",
};

export const SCOPES = ["public", "space", "staff"] as const;
export type Scope = (typeof SCOPES)[number];

export const SCOPE_LABEL: Record<Scope, string> = {
  public: "公開",
  space: "実行委員と班長",
  staff: "役員だけ",
};

/** 文書の初めの範囲の印。役員は付け替えられる。 */
export const DEFAULT_SCOPE: Record<DocumentKind, Scope> = {
  announcement: "public",
  recruitment: "public",
  duty_roster: "space",
  procedure: "space",
  notice: "public",
  report: "public",
};

/**
 * 文書が頼っている項目と表。ここが変わると、その文書に古い印が付く（出した物はそのまま残る）。
 * 公開の文書は協賛の額（sponsors、ledger）に頼らない。
 */
export const DOCUMENT_DEPENDENCIES: Record<DocumentKind, { items: readonly ItemKey[]; tables: readonly TableKey[] }> = {
  announcement: { items: ["date_time", "place", "rain_plan", "content", "belongings", "public_contact"], tables: [] },
  recruitment: { items: ["date_time", "place", "helper_slots", "due", "content", "public_contact"], tables: [] },
  duty_roster: { items: ["date_time", "place", "helper_slots", "rain_plan"], tables: ["duties", "layout", "committee"] },
  procedure: { items: ["date_time", "place", "content", "belongings", "rain_plan", "helper_slots"], tables: ["duties", "layout", "decisions", "committee"] },
  notice: { items: ["date_time", "place", "rain_plan", "content"], tables: [] },
  report: { items: ITEM_KEYS, tables: TABLE_KEYS },
};

// ---- 問い ----

export const QUESTION_KINDS = ["unreadable", "decide", "map_gap", "conflict", "discarded"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const QUESTION_KIND_LABEL: Record<QuestionKind, string> = {
  unreadable: "読めなかったところ",
  decide: "今年決めること",
  map_gap: "やることの空き",
  conflict: "食い違い",
  discarded: "取り込めなかった変更",
};

/** 問いの状態。答える、分からない、後で。答えなくても配るのを止めない。 */
export const QUESTION_STATES = ["open", "later", "answered", "unknown"] as const;
export type QuestionState = (typeof QUESTION_STATES)[number];

// ---- 地図の仕事 ----

export const MAP_PROGRESS = ["open", "started", "done"] as const;
export type MapProgress = (typeof MAP_PROGRESS)[number];

export const MAP_PROGRESS_LABEL: Record<MapProgress, string> = { open: "これから", started: "進行中", done: "済み" };

// ---- 照合 ----

/**
 * 照合用の鍵に直す。照合の時だけ使い、原文は書いたまま保存する。
 * NFKC に直し、空白を除き、小文字にし、会社の種類と敬称を端から外す。
 */
export function normalizeKey(text: string): string {
  const nfkc = text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  return nfkc.replace(/^(株式会社|有限会社|\(株\)|\(有\))+/, "").replace(/(株式会社|有限会社|\(株\)|\(有\)|様|御中|さん)+$/, "");
}

/** 行の照合の鍵（鍵の列を正規化してつなぐ）。 */
export function rowMatchKey(table: TableKey, data: RowData): string {
  // 写真から来た既存の行は、手で直しても同じ写真の照合先を保つ。
  if (table === "ledger" && typeof data.memoKey === "string" && data.memoKey.startsWith("legacy:")) return data.memoKey.slice(7);
  if (table === "ledger" && data.memoKey) return `memo:${data.memoKey}`;
  const def = TABLES[table];
  const names = [...def.keyFields, ...(def.optionalKeyFields ?? [])];
  return names.map((name) => normalizeKey(String(data[name] ?? ""))).join("|");
}

/** 行を画面と問いの文で呼ぶ名前。 */
export function rowDisplayName(table: TableKey, data: RowData): string {
  if (table === "ledger") return String(data.what || data.counterpart || "メモ");
  const def = TABLES[table];
  return String(data[def.nameField] ?? "");
}
